import { chapterParagraphs, openBook, splitSentences } from "./epub";
import type { OpenBook, Sentence } from "./epub";
import { log, logText } from "./log";
import type { WorkerEvent, WorkerRequest } from "./protocol";
import {
  loadGenerationMarker,
  loadPosition,
  savePosition,
  setGenerationMarker,
} from "./store";
import type { SavedPosition } from "./store";
import { joinClips } from "./wav";
import type { Chapter, Clip } from "./wav";

const SENTENCE_GAP_MS = 250;
const PARAGRAPH_GAP_MS = 600;
const SAVE_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 10000;
const SEEK_STEP_S = 15;

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing element #${id}`);
  return element;
}

const fileInput = byId("file", HTMLInputElement);
const bookInfo = byId("book", HTMLDivElement);
const chapterSelect = byId("chapter", HTMLSelectElement);
const limitInput = byId("limit", HTMLInputElement);
const voiceInput = byId("voice", HTMLInputElement);
const generateButton = byId("generate", HTMLButtonElement);
const cancelButton = byId("cancel", HTMLButtonElement);
const resumeButton = byId("resume", HTMLButtonElement);
const copyLogButton = byId("copy-log", HTMLButtonElement);
const statsElement = byId("stats", HTMLDivElement);
const savedElement = byId("saved", HTMLDivElement);
const textElement = byId("text", HTMLDivElement);
const audio = byId("audio", HTMLAudioElement);

// ---------------------------------------------------------------- environment

const isIos =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function injectIsolationWorker(): void {
  // Pages cannot set COOP/COEP headers. coi-serviceworker adds them. Skip it on iOS (one thread there).
  if (isIos || window.crossOriginIsolated || !("serviceWorker" in navigator)) return;
  const script = document.createElement("script");
  script.src = `${import.meta.env.BASE_URL}coi-serviceworker.js`;
  document.head.append(script);
}
injectIsolationWorker();

log(`user agent: ${navigator.userAgent}`);
log(
  `ios=${isIos} crossOriginIsolated=${window.crossOriginIsolated} cores=${navigator.hardwareConcurrency} ` +
    `standalone=${window.matchMedia("(display-mode: standalone)").matches}`,
);

const staleMarker = loadGenerationMarker();
if (staleMarker) {
  log(
    `PREVIOUS SESSION ENDED WHILE GENERATING: chapter index ${staleMarker.chapterIndex}, ` +
      `${staleMarker.done}/${staleMarker.total} sentences, last update ${new Date(staleMarker.at).toLocaleTimeString()}. ` +
      "The tab was probably killed or reloaded.",
  );
  setGenerationMarker(undefined);
}

// ---------------------------------------------------------------- state

interface LoadedChapter {
  chapterIndex: number;
  charLimit: number;
  sentences: Sentence[];
  chapter: Chapter;
  url: string;
}

let openedBook: OpenBook | undefined;
let loaded: LoadedChapter | undefined;
let currentSentence = -1;
let generating = false;
let wakeLock: WakeLockSentinel | undefined;

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let workerReady = false;
let onWorkerEvent: (event: WorkerEvent) => void = () => {};

function post(request: WorkerRequest): void {
  worker.postMessage(request);
}

worker.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
  const data = event.data;
  if (data.type === "log") log(data.text);
  onWorkerEvent(data);
});
worker.addEventListener("error", (event) => {
  log(`worker error: ${event.message}`);
});

// ---------------------------------------------------------------- saved position

function describePosition(p: SavedPosition): string {
  const minutes = Math.floor(p.seconds / 60);
  const seconds = Math.floor(p.seconds % 60).toString().padStart(2, "0");
  const ago = Math.round((Date.now() - p.savedAt) / 1000);
  return `Saved: "${p.bookTitle}", chapter ${p.chapterIndex + 1}, sentence ${p.sentenceIndex + 1}, ${minutes}:${seconds} (${ago} s ago).`;
}

function refreshSavedUi(): void {
  const saved = loadPosition();
  if (!saved) {
    savedElement.textContent = "No saved position.";
    resumeButton.disabled = true;
    return;
  }
  const matches = openedBook?.id === saved.bookId;
  savedElement.textContent = `${describePosition(saved)} ${
    matches ? "Press Resume saved position." : "Pick the same EPUB file to resume."
  }`;
  resumeButton.disabled = !matches || generating;
}

function persistPosition(reason: string): void {
  if (!openedBook || !loaded) return;
  savePosition({
    bookId: openedBook.id,
    bookTitle: openedBook.title,
    chapterIndex: loaded.chapterIndex,
    charLimit: loaded.charLimit,
    sentenceIndex: Math.max(currentSentence, 0),
    seconds: audio.currentTime,
    savedAt: Date.now(),
  });
  if (reason !== "interval") log(`position saved (${reason}) at ${audio.currentTime.toFixed(1)} s`);
}

setInterval(() => {
  if (!audio.paused) persistPosition("interval");
}, SAVE_INTERVAL_MS);

setInterval(() => {
  if (!audio.paused) {
    log(
      `heartbeat: visibility=${document.visibilityState} t=${audio.currentTime.toFixed(1)} s ` +
        `readyState=${audio.readyState} networkState=${audio.networkState}`,
    );
  }
}, HEARTBEAT_MS);

refreshSavedUi();

// ---------------------------------------------------------------- page lifecycle logging

document.addEventListener("visibilitychange", () => {
  log(
    `visibilitychange: ${document.visibilityState} (audio ${audio.paused ? "paused" : "playing"} at ${audio.currentTime.toFixed(1)} s, ` +
      `readyState=${audio.readyState} networkState=${audio.networkState})`,
  );
  if (document.visibilityState === "hidden") persistPosition("hidden");
  else if (document.visibilityState === "visible" && !audio.paused) watchForStuckPlayback("visible", false);
});
window.addEventListener("pagehide", (event) => {
  log(`pagehide persisted=${event.persisted}`);
  persistPosition("pagehide");
});
window.addEventListener("pageshow", (event) => log(`pageshow persisted=${event.persisted}`));
document.addEventListener("freeze", () => log("freeze"));
document.addEventListener("resume", () => log("resume (page lifecycle)"));

const AUDIO_EVENTS = [
  "play",
  "playing",
  "pause",
  "ended",
  "waiting",
  "stalled",
  "suspend",
  "emptied",
  "loadedmetadata",
  "error",
  "seeked",
];
for (const name of AUDIO_EVENTS) {
  audio.addEventListener(name, () => {
    const detail = name === "error" ? ` code=${audio.error?.code ?? "?"}` : "";
    log(`audio ${name} at ${audio.currentTime.toFixed(1)} s${detail}`);
  });
}

// ---------------------------------------------------------------- audio session

interface AudioSessionLike {
  type: string;
}

function isAudioSession(value: unknown): value is AudioSessionLike {
  return typeof value === "object" && value !== null && "type" in value;
}

function findAudioSession(): AudioSessionLike | undefined {
  if (!("audioSession" in navigator)) return undefined;
  const candidate: unknown = navigator.audioSession;
  return isAudioSession(candidate) ? candidate : undefined;
}

const audioSession = findAudioSession();
if (audioSession) {
  try {
    audioSession.type = "playback";
    log(`audioSession.type set to "${audioSession.type}"`);
  } catch (error) {
    log(`audioSession.type could not be set: ${String(error)}`);
  }
} else {
  log("audioSession: not supported");
}

// ---------------------------------------------------------------- stuck playback recovery

const STUCK_CHECK_MS = 1500;
const SNAPSHOT_MS = 500;
const MAX_RECOVERY_ATTEMPTS = 2;

const METADATA_TIMEOUT_MS = 5000;

// Token of the recovery in flight, or 0. Only that recovery may clear it.
let recoveryOwner = 0;
let recoveryCausedPause = false;
const PAUSE_IGNORE_MS = 100;
// Bumped by every new watch, user pause or source change. A recovery aborts when it changes.
let watchToken = 0;
// Recovery attempts used in the current resume episode. Reset only by a real play action or confirmed progress.
let attemptsUsed = 0;

function snapshot(label: string): string {
  return (
    `${label}: paused=${audio.paused} t=${audio.currentTime.toFixed(2)} s ` +
    `readyState=${audio.readyState} networkState=${audio.networkState}`
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function waitForMetadata(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`media error code=${audio.error?.code ?? "?"} while waiting for metadata`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`metadata timeout after ${METADATA_TIMEOUT_MS} ms`));
    }, METADATA_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("error", onError);
  });
}

async function recoverPlayback(attempt: number, token: number): Promise<void> {
  if (!loaded) return;
  // A newer episode takes over. An older recovery aborts at its next stillValid() check.
  recoveryOwner = token;
  const chapterAtStart = loaded;
  const newUrl = URL.createObjectURL(loaded.chapter.blob);
  const stillValid = (): boolean =>
    token === watchToken && loaded === chapterAtStart && loaded.url === newUrl;
  try {
    const resumeAt = audio.currentTime;
    log(`recovery ${attempt}/${MAX_RECOVERY_ATTEMPTS}: reloading audio, saved t=${resumeAt.toFixed(2)} s`);
    const oldUrl = loaded.url;
    loaded.url = newUrl;
    // The src change and load() may emit a pause event. Ignore only that one.
    recoveryCausedPause = true;
    setTimeout(() => (recoveryCausedPause = false), PAUSE_IGNORE_MS);
    audio.src = newUrl;
    URL.revokeObjectURL(oldUrl);
    audio.load();
    log("recovery: load() called, waiting for metadata");
    await waitForMetadata();
    if (!stillValid()) {
      log("recovery: aborted after metadata (pause, newer resume, or source changed)");
      return;
    }
    audio.currentTime = resumeAt;
    log(`recovery: metadata loaded, currentTime restored to ${resumeAt.toFixed(2)} s`);
    const startedAt = Date.now();
    const played = audio.play();
    played.then(
      () => log(`recovery: play() resolved after ${Date.now() - startedAt} ms`),
      (error: unknown) =>
        log(`recovery: play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}`),
    );
    navigator.mediaSession.playbackState = "playing";
    setTimeout(() => {
      if (stillValid()) log(snapshot("recovery: state 500 ms after play"));
      else log("recovery: 500 ms snapshot skipped, superseded or source changed");
    }, SNAPSHOT_MS);
    // Release ownership now and keep watching, so a pending play() is still detected.
    if (recoveryOwner === token) recoveryOwner = 0;
    watchForStuckPlayback("recovery", false);
  } catch (error) {
    log(`recovery: failed: ${errorName(error)}`);
  } finally {
    if (recoveryOwner === token) recoveryOwner = 0;
  }
}

/**
 * Starts the stuck-playback watchdog. Call right after play() is fired, without awaiting it.
 * `newEpisode` is true only for a real play action. It always supersedes any in-flight recovery
 * and resets the attempt budget.
 */
function watchForStuckPlayback(reason: string, newEpisode: boolean): void {
  if (!newEpisode && recoveryOwner !== 0) {
    log(`stuck watch (${reason}): recovery already running, skipped`);
    return;
  }
  if (newEpisode) attemptsUsed = 0;
  const token = ++watchToken;
  const startTime = audio.currentTime;
  log(`stuck watch (${reason}): start t=${startTime.toFixed(2)} s attemptsUsed=${attemptsUsed}`);
  setTimeout(() => {
    if (token === watchToken) log(snapshot(`post-play snapshot (${reason})`));
  }, SNAPSHOT_MS);
  setTimeout(() => {
    if (token !== watchToken) return;
    if (audio.paused) {
      log(`stuck watch (${reason}): audio is paused, nothing to recover`);
      return;
    }
    if (audio.currentTime > startTime) {
      log(`stuck watch (${reason}): ok, t advanced to ${audio.currentTime.toFixed(2)} s`);
      attemptsUsed = 0;
      return;
    }
    log(`stuck watch (${reason}): currentTime did not advance. ${snapshot("state")}`);
    if (attemptsUsed >= MAX_RECOVERY_ATTEMPTS) {
      log("stuck watch: giving up, recovery attempts used up for this resume");
      return;
    }
    attemptsUsed += 1;
    void recoverPlayback(attemptsUsed, token);
  }, STUCK_CHECK_MS);
}

function playFromMediaSession(): void {
  // Fire play(), start the watchdog at once, and log the promise result whenever it settles.
  const startedAt = Date.now();
  const promise = audio.play();
  watchForStuckPlayback("media session play", true);
  promise.then(
    () => log(`audio.play() resolved after ${Date.now() - startedAt} ms`),
    (error: unknown) => log(`audio.play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}`),
  );
}

audio.addEventListener("pause", () => {
  if (recoveryCausedPause) return;
  watchToken += 1;
});

// ---------------------------------------------------------------- media session

function setupMediaSession(): void {
  const session = navigator.mediaSession;
  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ["play", () => playFromMediaSession()],
    ["pause", () => {
      watchToken += 1;
      audio.pause();
    }],
    [
      "seekto",
      (details) => {
        if (details.seekTime !== undefined) audio.currentTime = details.seekTime;
      },
    ],
    ["seekbackward", (d) => void (audio.currentTime -= d.seekOffset ?? SEEK_STEP_S)],
    ["seekforward", (d) => void (audio.currentTime += d.seekOffset ?? SEEK_STEP_S)],
  ];
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, (details) => {
        log(`media session action: ${action}`);
        handler(details);
      });
    } catch {
      log(`media session action not supported: ${action}`);
    }
  }
  audio.addEventListener("play", () => (session.playbackState = "playing"));
  audio.addEventListener("pause", () => (session.playbackState = "paused"));
}
setupMediaSession();

let lastPositionState = 0;
function updatePositionState(): void {
  const now = Date.now();
  if (now - lastPositionState < 1000 || !Number.isFinite(audio.duration)) return;
  lastPositionState = now;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {
    // Some browsers reject odd values. Ignore.
  }
}

function setMetadata(title: string): void {
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: openedBook?.title ?? "EPUB TTS",
    album: "EPUB TTS prototype",
    artwork: [{ src: `${import.meta.env.BASE_URL}icon.svg`, sizes: "512x512", type: "image/svg+xml" }],
  });
}

// ---------------------------------------------------------------- highlight

function renderText(sentences: Sentence[]): void {
  textElement.replaceChildren();
  let paragraph = document.createElement("p");
  textElement.append(paragraph);
  sentences.forEach((sentence, index) => {
    const span = document.createElement("span");
    span.dataset["index"] = String(index);
    span.textContent = `${sentence.text} `;
    paragraph.append(span);
    if (sentence.paragraphEnd) {
      paragraph = document.createElement("p");
      textElement.append(paragraph);
    }
  });
}

function sentenceAt(seconds: number): number {
  if (!loaded) return -1;
  const timings = loaded.chapter.timings;
  let low = 0;
  let high = timings.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const timing = timings[mid];
    if (timing && timing.start <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function highlight(index: number): void {
  if (index === currentSentence) return;
  textElement.querySelector(".current")?.classList.remove("current");
  currentSentence = index;
  const span = textElement.querySelector(`span[data-index="${index}"]`);
  if (span) {
    span.classList.add("current");
    span.scrollIntoView({ block: "nearest" });
  }
}

audio.addEventListener("timeupdate", () => {
  highlight(sentenceAt(audio.currentTime));
  updatePositionState();
});

textElement.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !loaded) return;
  const index = Number(target.dataset["index"]);
  const timing = loaded.chapter.timings[index];
  if (timing) audio.currentTime = timing.start;
});

// ---------------------------------------------------------------- generation

async function acquireWakeLock(): Promise<void> {
  if (!("wakeLock" in navigator)) {
    log("wake lock: not supported. Keep the screen on while generating.");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => log("wake lock released"));
    log("wake lock acquired");
  } catch (error) {
    log(`wake lock failed: ${String(error)}`);
  }
}

async function releaseWakeLock(): Promise<void> {
  await wakeLock?.release();
  wakeLock = undefined;
}

function waitForEvent(type: WorkerEvent["type"]): Promise<WorkerEvent> {
  return new Promise((resolve, reject) => {
    onWorkerEvent = (event) => {
      if (event.type === type) resolve(event);
      else if (event.type === "error") reject(new Error(event.message));
      else if (event.type === "model-progress") {
        const percent = Math.round((event.loaded * 100) / event.total);
        statsElement.textContent = `Downloading voice model: ${percent}%`;
      }
    };
  });
}

async function ensureWorker(): Promise<void> {
  if (workerReady) return;
  statsElement.textContent = "Loading voice model and WASM...";
  const ready = waitForEvent("ready");
  post({
    type: "init",
    voiceId: voiceInput.value.trim(),
    baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href,
  });
  const event = await ready;
  workerReady = true;
  if (event.type === "ready") log(`model ready in ${(event.initMs / 1000).toFixed(1)} s`);
}

function runGeneration(sentences: Sentence[], chapterIndex: number): Promise<{ clips: Clip[]; totalMs: number }> {
  return new Promise((resolve, reject) => {
    const clips: Clip[] = [];
    let speechSeconds = 0;
    let genMs = 0;
    onWorkerEvent = (event) => {
      if (event.type === "clip") {
        clips[event.index] = { sampleRate: event.sampleRate, pcm: event.pcm };
        speechSeconds += event.pcm.length / event.sampleRate;
        genMs += event.genMs;
        const rtf = speechSeconds > 0 ? genMs / 1000 / speechSeconds : 0;
        statsElement.textContent =
          `Sentence ${event.index + 1}/${sentences.length}. Generated ${(genMs / 1000).toFixed(1)} s, ` +
          `audio ${speechSeconds.toFixed(1)} s, RTF ${rtf.toFixed(2)}.`;
        setGenerationMarker({ chapterIndex, done: event.index + 1, total: sentences.length, at: Date.now() });
      } else if (event.type === "done") {
        resolve({ clips, totalMs: event.totalMs });
      } else if (event.type === "cancelled") {
        reject(new Error("Generation cancelled."));
      } else if (event.type === "error") {
        reject(new Error(event.message));
      }
    };
    post({ type: "generate", sentences: sentences.map((s) => s.text) });
  });
}

async function generateChapter(chapterIndex: number, charLimit: number): Promise<boolean> {
  if (!openedBook || generating) return false;
  generating = true;
  generateButton.disabled = true;
  resumeButton.disabled = true;
  cancelButton.disabled = false;
  audio.pause();
  try {
    await acquireWakeLock();
    await ensureWorker();
    const paragraphs = await chapterParagraphs(openedBook, chapterIndex);
    const sentences = splitSentences(paragraphs, openedBook.language, charLimit);
    if (sentences.length === 0) {
      statsElement.textContent = "This chapter has no text. Pick another chapter.";
      return false;
    }
    const chars = sentences.reduce((sum, s) => sum + s.text.length, 0);
    log(`generating chapter ${chapterIndex + 1}: ${sentences.length} sentences, ${chars} characters`);
    setGenerationMarker({ chapterIndex, done: 0, total: sentences.length, at: Date.now() });

    const { clips, totalMs } = await runGeneration(sentences, chapterIndex);
    const gaps = sentences.map((s) => (s.paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS));
    const chapter = joinClips(clips, gaps);
    const speechSeconds = clips.reduce((sum, c) => sum + c.pcm.length / c.sampleRate, 0);
    const rtf = totalMs / 1000 / speechSeconds;
    const summary =
      `Done. Generation ${(totalMs / 1000).toFixed(1)} s, audio ${chapter.duration.toFixed(1)} s ` +
      `(speech ${speechSeconds.toFixed(1)} s), RTF ${rtf.toFixed(2)}, file ${(chapter.blob.size / 1048576).toFixed(1)} MB.`;
    statsElement.textContent = summary;
    log(summary);

    if (loaded) URL.revokeObjectURL(loaded.url);
    loaded = { chapterIndex, charLimit, sentences, chapter, url: URL.createObjectURL(chapter.blob) };
    currentSentence = -1;
    audio.src = loaded.url;
    renderText(sentences);
    setMetadata(openedBook.chapters[chapterIndex]?.label ?? `Chapter ${chapterIndex + 1}`);
    highlight(0);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statsElement.textContent = `Stopped: ${message}`;
    log(`generation stopped: ${message}`);
    return false;
  } finally {
    setGenerationMarker(undefined);
    await releaseWakeLock();
    generating = false;
    generateButton.disabled = !openedBook;
    cancelButton.disabled = true;
    refreshSavedUi();
  }
}

// ---------------------------------------------------------------- UI wiring

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  bookInfo.textContent = "Reading EPUB...";
  openBook(file)
    .then((opened) => {
      openedBook = opened;
      bookInfo.textContent = `${opened.title} (language: ${opened.language}, ${opened.chapters.length} spine items)`;
      chapterSelect.replaceChildren(
        ...opened.chapters.map((c) => new Option(c.label, String(c.index))),
      );
      chapterSelect.disabled = false;
      generateButton.disabled = false;
      log(`opened "${opened.title}" with ${opened.chapters.length} spine items`);
      refreshSavedUi();
    })
    .catch((error: unknown) => {
      bookInfo.textContent = `Could not open the EPUB: ${String(error)}`;
      log(`epub error: ${String(error)}`);
    });
});

generateButton.addEventListener("click", () => {
  void generateChapter(Number(chapterSelect.value), Number(limitInput.value));
});

cancelButton.addEventListener("click", () => {
  post({ type: "cancel" });
  log("cancel requested");
});

resumeButton.addEventListener("click", () => {
  const saved = loadPosition();
  if (!saved || openedBook?.id !== saved.bookId) return;
  chapterSelect.value = String(saved.chapterIndex);
  limitInput.value = String(saved.charLimit);
  generateChapter(saved.chapterIndex, saved.charLimit)
    .then((ok) => {
      const timing = loaded?.chapter.timings[saved.sentenceIndex];
      if (ok && timing) {
        audio.currentTime = timing.start;
        log(`resumed at sentence ${saved.sentenceIndex + 1} (${timing.start.toFixed(1)} s). Press play.`);
      }
    })
    .catch((error: unknown) => log(`resume failed: ${String(error)}`));
});

copyLogButton.addEventListener("click", () => {
  navigator.clipboard
    .writeText(logText())
    .then(() => log("log copied"))
    .catch((error: unknown) => log(`copy failed: ${String(error)}`));
});

log("ready");
