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
import type { Clip, Timing } from "./wav";

const SENTENCE_GAP_MS = 250;
const PARAGRAPH_GAP_MS = 600;
const SAVE_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 10000;
const SEEK_STEP_S = 15;
/** Target audio length of one segment. A segment closes once clips and gaps reach this. */
const SEGMENT_TARGET_S = 60;
/** The generator stays at most this many ready segments ahead of the playing one. */
const SEGMENTS_AHEAD = 2;
/** Already-played segments kept in memory behind the playing one. Older ones lose their audio. */
const SEGMENTS_BEHIND = 3;

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing element #${id}`);
  return element;
}

const fileInput = byId("file", HTMLInputElement);
const bookInfo = byId("book", HTMLDivElement);
const chapterSelect = byId("chapter", HTMLSelectElement);
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

/** A contiguous sentence range, joined into one wav. Timings are relative to the segment start. */
interface Segment {
  /** Chapter-level index of the first sentence in this segment. */
  startSentence: number;
  count: number;
  /** Small metadata, always kept. */
  timings: Timing[];
  duration: number;
  /** The wav. Undefined once dropped from memory. The current segment is never dropped. */
  blob: Blob | undefined;
}

interface LoadedChapter {
  chapterIndex: number;
  /** All sentences of the chapter. Sentence indexes everywhere else are indexes into this array. */
  sentences: Sentence[];
  /** Segments generated so far, in order. The generator appends to this array. */
  segments: Segment[];
  /** Index into `segments` of the segment loaded in the audio element. */
  current: number;
  /** Object URL of the current segment. */
  url: string;
}

let openedBook: OpenBook | undefined;
let loaded: LoadedChapter | undefined;
let currentSentence = -1;
let generating = false;
let cancelRequested = false;
// True while the current segment has ended and the next one is not generated yet.
let buffering = false;
// True while the user wants sound: set by play, cleared by a user or media-session pause.
let wantPlaying = false;
// Resolves the generator's "wait for room" pause. Set only while the generator waits.
let wakeGeneration: (() => void) | undefined;

function currentSegment(): Segment | undefined {
  return loaded?.segments[loaded.current];
}
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
    charLimit: 0,
    sentenceIndex: currentSentence >= 0 ? currentSentence : (currentSegment()?.startSentence ?? 0),
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
  const segment = currentSegment();
  if (!loaded || !segment?.blob) return;
  // A newer episode takes over. An older recovery aborts at its next stillValid() check.
  recoveryOwner = token;
  const chapterAtStart = loaded;
  const newUrl = URL.createObjectURL(segment.blob);
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
  wantPlaying = true;
  if (buffering) {
    // The segment ended and the next one is not ready. play() would replay the ended segment.
    log("play pressed while buffering: playback starts when the next segment is ready");
    return;
  }
  // Fire play(), start the watchdog at once, and log the promise result whenever it settles.
  const startedAt = Date.now();
  const promise = audio.play();
  watchForStuckPlayback("media session play", true);
  promise.then(
    () => log(`audio.play() resolved after ${Date.now() - startedAt} ms`),
    (error: unknown) => log(`audio.play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}`),
  );
}

/** Call right before changing audio.src. The pause event it queues must not count as a user pause. */
function ignoreSourceChangePause(): void {
  recoveryCausedPause = true;
  setTimeout(() => (recoveryCausedPause = false), PAUSE_IGNORE_MS);
}

audio.addEventListener("play", () => {
  wantPlaying = true;
});

audio.addEventListener("pause", () => {
  if (recoveryCausedPause) return;
  // The pause at the natural end of a segment is not a user pause.
  if (!audio.ended) wantPlaying = false;
  watchToken += 1;
});

// ---------------------------------------------------------------- media session

/**
 * Seek by absolute time in the current segment. Crossing the start or end moves into the
 * neighbouring segment, which regenerates on demand if it was dropped.
 */
function seekWithinSegment(seconds: number): void {
  const active = loaded;
  const segment = currentSegment();
  if (active && segment) {
    const duration = Number.isFinite(audio.duration) ? audio.duration : segment.duration;
    if (seconds < 0 && active.current > 0) {
      const previous = active.segments[active.current - 1];
      if (previous) {
        const offset = Math.max(previous.duration + seconds, 0);
        log(`seek crosses into segment ${active.current} at ${offset.toFixed(1)} s`);
        loadSegment(active.current - 1, offset, !audio.paused, "seek");
        return;
      }
    }
    if (seconds > duration && active.segments[active.current + 1]) {
      const offset = seconds - duration;
      log(`seek crosses into segment ${active.current + 2} at ${offset.toFixed(1)} s`);
      loadSegment(active.current + 1, offset, !audio.paused, "seek");
      return;
    }
  }
  const upper = Number.isFinite(audio.duration) ? audio.duration : seconds;
  const target = Math.min(Math.max(seconds, 0), upper);
  log(`seek within segment to ${target.toFixed(1)} s (requested ${seconds.toFixed(1)} s)`);
  audio.currentTime = target;
}

function setupMediaSession(): void {
  const session = navigator.mediaSession;
  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ["play", () => playFromMediaSession()],
    ["pause", () => {
      wantPlaying = false;
      watchToken += 1;
      audio.pause();
    }],
    [
      "seekto",
      (details) => {
        if (details.seekTime !== undefined) seekWithinSegment(details.seekTime);
      },
    ],
    ["seekbackward", (d) => seekWithinSegment(audio.currentTime - (d.seekOffset ?? SEEK_STEP_S))],
    ["seekforward", (d) => seekWithinSegment(audio.currentTime + (d.seekOffset ?? SEEK_STEP_S))],
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

function sentenceIn(segment: Segment, seconds: number): number {
  const timings = segment.timings;
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
  return segment.startSentence + found;
}

function sentenceAt(seconds: number): number {
  const segment = currentSegment();
  return segment ? sentenceIn(segment, seconds) : -1;
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
  if (!Number.isInteger(index)) return;
  const segmentIndex = loaded.segments.findIndex(
    (s) => index >= s.startSentence && index < s.startSentence + s.count,
  );
  const segment = loaded.segments[segmentIndex];
  if (!segment) {
    log(`seek ignored: sentence ${index + 1} is not generated yet`);
    return;
  }
  const offset = segment.timings[index - segment.startSentence]?.start ?? 0;
  if (segmentIndex === loaded.current) {
    audio.currentTime = offset;
    return;
  }
  log(`seek to sentence ${index + 1} in segment ${segmentIndex + 1}`);
  loadSegment(segmentIndex, offset, !audio.paused, "seek");
});

// ---------------------------------------------------------------- segment switching

// Bumped by every segment load request. A slow regeneration that finds a newer value gives up.
let loadToken = 0;

/**
 * Put a segment that has its blob into the audio element at `offset` seconds, optionally playing.
 * Everything runs synchronously, so a swap in the `ended` handler stays in the same task.
 */
function switchSegment(segmentIndex: number, offset: number, play: boolean, reason: string): void {
  const active = loaded;
  const segment = active?.segments[segmentIndex];
  if (!active || !segment?.blob) return;
  loadToken += 1;
  const oldUrl = active.url;
  const url = URL.createObjectURL(segment.blob);
  active.current = segmentIndex;
  active.url = url;
  buffering = false;
  ignoreSourceChangePause();
  audio.src = url;
  if (offset > 0) audio.currentTime = offset;
  lastPositionState = 0;
  if (play) {
    const startedAt = Date.now();
    const promise = audio.play();
    watchForStuckPlayback(`segment ${reason}`, true);
    promise.then(
      () => log(`segment ${segmentIndex + 1} play() resolved after ${Date.now() - startedAt} ms`),
      (error: unknown) =>
        log(`segment ${segmentIndex + 1} play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}`),
    );
  }
  URL.revokeObjectURL(oldUrl);
  highlight(sentenceIn(segment, offset));
  dropFarSegments();
  wakeGeneration?.();
}

/** Drop the audio of segments outside [current - SEGMENTS_BEHIND, current + SEGMENTS_AHEAD]. Keeps metadata. */
function dropFarSegments(): void {
  if (!loaded) return;
  const { segments, current } = loaded;
  segments.forEach((segment, index) => {
    if (!segment.blob || index === current) return;
    if (index < current - SEGMENTS_BEHIND || index > current + SEGMENTS_AHEAD) {
      segment.blob = undefined;
      log(`segment ${index + 1} dropped`);
    }
  });
}

/** Switch to a segment. If its audio was dropped, regenerate it first. */
function loadSegment(segmentIndex: number, offset: number, play: boolean, reason: string): void {
  const active = loaded;
  const segment = active?.segments[segmentIndex];
  if (!active || !segment) return;
  if (segment.blob) {
    switchSegment(segmentIndex, offset, play, reason);
    return;
  }
  if (audio.ended) buffering = true;
  const token = ++loadToken;
  const epoch = cancelEpoch;
  void regenerateSegment(active, segmentIndex, token, epoch).then((ok) => {
    const current = loaded === active && token === loadToken && epoch === cancelEpoch;
    if (ok && current) {
      // The switch makes this segment current, then drops segments outside the new window.
      switchSegment(segmentIndex, offset, play && wantPlaying, reason);
      return;
    }
    // Failed, cancelled or superseded: free any blob that was written and unstick buffering.
    if (loaded === active) dropFarSegments();
    if (current && buffering) {
      buffering = false;
      log(`segment ${segmentIndex + 1} not loaded. Playback stays stopped.`);
    }
  });
}

audio.addEventListener("ended", () => {
  if (!loaded) return;
  const nextIndex = loaded.current + 1;
  const next = loaded.segments[nextIndex];
  if (next?.blob) {
    log(`swap to segment ${nextIndex + 1}`);
    switchSegment(nextIndex, 0, true, "swap");
  } else if (next) {
    log(`swap to segment ${nextIndex + 1}: audio was dropped, regenerating`);
    loadSegment(nextIndex, 0, true, "swap");
  } else if (generating) {
    buffering = true;
    log(`buffering: segment ${nextIndex + 1} is not ready yet`);
    statsElement.textContent = `Buffering: waiting for segment ${nextIndex + 1}...`;
  } else {
    log("last segment ended");
  }
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

interface GeneratedClip {
  clip: Clip;
  genMs: number;
}

// The worker handles one request at a time and reports through one global handler.
// Every clip request waits for the previous one. Forward generation and regeneration
// interleave per sentence this way and never overlap in the worker.
let workerQueue: Promise<unknown> = Promise.resolve();

/** Generate one sentence. One sentence per worker request lets the page pause between sentences. */
function generateClip(text: string): Promise<GeneratedClip> {
  const run = workerQueue.then(() => requestClip(text));
  workerQueue = run.catch(() => undefined);
  return run;
}

function requestClip(text: string): Promise<GeneratedClip> {
  return new Promise((resolve, reject) => {
    let result: GeneratedClip | undefined;
    onWorkerEvent = (event) => {
      if (event.type === "clip") {
        result = { clip: { sampleRate: event.sampleRate, pcm: event.pcm }, genMs: event.genMs };
      } else if (event.type === "done") {
        if (result) resolve(result);
        else reject(new Error("Worker finished without a clip."));
      } else if (event.type === "cancelled") {
        reject(new Error("Generation cancelled."));
      } else if (event.type === "error") {
        reject(new Error(event.message));
      }
    };
    post({ type: "generate", sentences: [text] });
  });
}

const regenerations = new WeakMap<Segment, Promise<boolean>>();

// Bumped by the Cancel button. A regeneration started before the bump stops queueing sentences.
let cancelEpoch = 0;

/**
 * Rebuild the wav of a dropped segment. Resolves false when it failed, was superseded by a newer
 * load (`token` no longer equals `loadToken`), was cancelled, or the chapter changed.
 * A false result leaves the segment dropped.
 */
function regenerateSegment(
  active: LoadedChapter,
  segmentIndex: number,
  token: number,
  epoch: number,
): Promise<boolean> {
  const segment = active.segments[segmentIndex];
  if (!segment) return Promise.resolve(false);
  const running = regenerations.get(segment);
  if (running) {
    // The running one may abort because it was superseded. Retry after it settles if still dropped,
    // with this request's own token and epoch. A Cancel in between ends the wait.
    return running.then((ok) => {
      if (segment.blob) return true;
      if (ok || epoch !== cancelEpoch) return false;
      return regenerateSegment(active, segmentIndex, token, epoch);
    });
  }
  const obsolete = (): boolean => loaded !== active || token !== loadToken || epoch !== cancelEpoch;
  const task = (async (): Promise<boolean> => {
    log(`segment ${segmentIndex + 1} regenerating`);
    statsElement.textContent = `Regenerating segment ${segmentIndex + 1}...`;
    const startedAt = performance.now();
    try {
      await ensureWorker();
      const clips: Clip[] = [];
      const gaps: number[] = [];
      for (let i = segment.startSentence; i < segment.startSentence + segment.count; i += 1) {
        if (obsolete()) {
          log(`segment ${segmentIndex + 1} regeneration abandoned (superseded or cancelled)`);
          return false;
        }
        const sentence = active.sentences[i];
        if (!sentence) throw new Error(`Sentence ${i + 1} is missing.`);
        const { clip } = await generateClip(sentence.text);
        clips.push(clip);
        gaps.push(sentence.paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS);
      }
      if (obsolete()) {
        log(`segment ${segmentIndex + 1} regeneration abandoned (superseded or cancelled)`);
        return false;
      }
      const joined = joinClips(clips, gaps);
      segment.blob = joined.blob;
      segment.timings = joined.timings;
      segment.duration = joined.duration;
      log(`segment ${segmentIndex + 1} regenerated in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
      statsElement.textContent = `Segment ${segmentIndex + 1} regenerated.`;
      return true;
    } catch (error) {
      log(`segment ${segmentIndex + 1} regeneration failed: ${errorName(error)}`);
      statsElement.textContent = `Regeneration failed: ${errorName(error)}`;
      return false;
    } finally {
      regenerations.delete(segment);
    }
  })();
  regenerations.set(segment, task);
  return task;
}

function throwIfCancelled(): void {
  if (cancelRequested) throw new Error("Generation cancelled.");
}

/** Wait until fewer than SEGMENTS_AHEAD ready segments are queued after the playing one. */
async function waitForRoom(segments: Segment[]): Promise<void> {
  const ahead = (): number => (loaded?.segments === segments ? segments.length - 1 - loaded.current : 0);
  if (ahead() >= SEGMENTS_AHEAD) log(`generation paused: ${ahead()} segments ahead of playback`);
  while (!cancelRequested && ahead() >= SEGMENTS_AHEAD) {
    await new Promise<void>((resolve) => {
      wakeGeneration = resolve;
    });
    wakeGeneration = undefined;
  }
  throwIfCancelled();
}

function onSegmentReady(segments: Segment[], chapterIndex: number, sentences: Sentence[]): void {
  const index = segments.length - 1;
  const segment = segments[index];
  if (!segment?.blob || !openedBook) return;
  if (index === 0) {
    if (loaded) URL.revokeObjectURL(loaded.url);
    const url = URL.createObjectURL(segment.blob);
    loaded = { chapterIndex, sentences, segments, current: 0, url };
    currentSentence = -1;
    buffering = false;
    ignoreSourceChangePause();
    audio.src = url;
    renderText(sentences);
    setMetadata(openedBook.chapters[chapterIndex]?.label ?? `Chapter ${chapterIndex + 1}`);
    highlight(segment.startSentence);
    log("segment 1 started");
    const startedAt = Date.now();
    const promise = audio.play();
    watchForStuckPlayback("segment 1 start", true);
    promise.then(
      () => log(`segment 1 play() resolved after ${Date.now() - startedAt} ms`),
      (error: unknown) =>
        log(`segment 1 play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}. Press play.`),
    );
  } else if (buffering && loaded?.segments === segments && loaded.current === index - 1) {
    log(`swap to segment ${index + 1} (was buffering${wantPlaying ? "" : ", paused by user: loaded without playing"})`);
    switchSegment(index, 0, wantPlaying, "buffer end");
  }
  // After a backward seek the new tail may lie outside the window. The segment stays counted
  // (waitForRoom uses the array length) and regenerates on demand when playback reaches it.
  if (loaded?.segments === segments) dropFarSegments();
}

async function generateSegments(
  sentences: Sentence[],
  startSentence: number,
  chapterIndex: number,
): Promise<void> {
  const segments: Segment[] = [];
  let next = startSentence;
  let totalGenMs = 0;
  let totalAudioS = 0;
  while (next < sentences.length) {
    await waitForRoom(segments);
    const segmentStart = next;
    const startedAt = performance.now();
    const clips: Clip[] = [];
    const gaps: number[] = [];
    let seconds = 0;
    while (next < sentences.length && seconds < SEGMENT_TARGET_S) {
      const sentence = sentences[next];
      if (!sentence) break;
      const { clip, genMs } = await generateClip(sentence.text);
      throwIfCancelled();
      const gapMs = sentence.paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS;
      clips.push(clip);
      gaps.push(gapMs);
      seconds += clip.pcm.length / clip.sampleRate + gapMs / 1000;
      totalGenMs += genMs;
      next += 1;
      statsElement.textContent =
        `Segment ${segments.length + 1}: sentence ${next}/${sentences.length}. ` +
        `Generated ${(totalGenMs / 1000).toFixed(1)} s for ${(totalAudioS + seconds).toFixed(1)} s of audio.`;
      setGenerationMarker({ chapterIndex, done: next, total: sentences.length, at: Date.now() });
    }
    const chapter = joinClips(clips, gaps);
    totalAudioS += chapter.duration;
    segments.push({
      startSentence: segmentStart,
      count: clips.length,
      timings: chapter.timings,
      duration: chapter.duration,
      blob: chapter.blob,
    });
    log(
      `segment ${segments.length} ready (${chapter.duration.toFixed(1)} s audio, ` +
        `generated in ${((performance.now() - startedAt) / 1000).toFixed(1)} s, ` +
        `sentences ${segmentStart + 1}-${next}, ${(chapter.blob.size / 1048576).toFixed(1)} MB)`,
    );
    onSegmentReady(segments, chapterIndex, sentences);
  }
  const summary =
    `Generation done. ${segments.length} segments, audio ${totalAudioS.toFixed(1)} s, ` +
    `generation ${(totalGenMs / 1000).toFixed(1)} s, RTF ${(totalGenMs / 1000 / Math.max(totalAudioS, 1)).toFixed(2)}.`;
  statsElement.textContent = summary;
  log(summary);
}

async function generateChapter(chapterIndex: number, startSentence = 0): Promise<void> {
  if (!openedBook || generating) return;
  generating = true;
  cancelRequested = false;
  generateButton.disabled = true;
  resumeButton.disabled = true;
  cancelButton.disabled = false;
  audio.pause();
  try {
    await acquireWakeLock();
    await ensureWorker();
    const paragraphs = await chapterParagraphs(openedBook, chapterIndex);
    const sentences = splitSentences(paragraphs, openedBook.language);
    if (sentences.length === 0) {
      statsElement.textContent = "This chapter has no text. Pick another chapter.";
      return;
    }
    const start = startSentence < sentences.length ? Math.max(startSentence, 0) : 0;
    const chars = sentences.reduce((sum, s) => sum + s.text.length, 0);
    log(
      `generating chapter ${chapterIndex + 1}: ${sentences.length} sentences, ${chars} characters, ` +
        `starting at sentence ${start + 1}`,
    );
    setGenerationMarker({ chapterIndex, done: start, total: sentences.length, at: Date.now() });
    await generateSegments(sentences, start, chapterIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statsElement.textContent = `Stopped: ${message}`;
    log(`generation stopped: ${message}`);
  } finally {
    setGenerationMarker(undefined);
    await releaseWakeLock();
    generating = false;
    wakeGeneration = undefined;
    if (buffering) {
      buffering = false;
      log("generation ended while buffering. Playback stays stopped.");
    }
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
  void generateChapter(Number(chapterSelect.value));
});

cancelButton.addEventListener("click", () => {
  cancelRequested = true;
  cancelEpoch += 1;
  post({ type: "cancel" });
  wakeGeneration?.();
  log("cancel requested");
});

resumeButton.addEventListener("click", () => {
  const saved = loadPosition();
  if (!saved || openedBook?.id !== saved.bookId) return;
  chapterSelect.value = String(saved.chapterIndex);
  log(`resuming at sentence ${saved.sentenceIndex + 1}: generating from that sentence`);
  void generateChapter(saved.chapterIndex, saved.sentenceIndex);
});

copyLogButton.addEventListener("click", () => {
  navigator.clipboard
    .writeText(logText())
    .then(() => log("log copied"))
    .catch((error: unknown) => log(`copy failed: ${String(error)}`));
});

log("ready");
