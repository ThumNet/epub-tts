import { chapterParagraphs, openBook, splitSentences } from "./epub";
import type { OpenBook, Sentence } from "./epub";
import { log, logText } from "./log";
import type { WorkerEvent, WorkerRequest } from "./protocol";
import {
  loadGenerationMarker,
  loadPosition,
  loadSettings,
  savePosition,
  saveSettings,
  setGenerationMarker,
} from "./store";
import type { SavedPosition } from "./store";
import { DEFAULT_VOICE_ID, VOICES, findVoice, removeVoiceFiles } from "./voices";
import { download, remove, stored } from "@mintplex-labs/piper-tts-web";
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
const prevChapterButton = byId("chapter-prev", HTMLButtonElement);
const nextChapterButton = byId("chapter-next", HTMLButtonElement);
const voiceSelect = byId("voice", HTMLSelectElement);
const voiceStatus = byId("voice-status", HTMLSpanElement);
const voiceDownloadButton = byId("voice-download", HTMLButtonElement);
const voiceRemoveButton = byId("voice-remove", HTMLButtonElement);
const speedInput = byId("speed", HTMLInputElement);
const speedLabel = byId("speed-label", HTMLSpanElement);
const speedResetButton = byId("speed-reset", HTMLButtonElement);
const generateButton = byId("generate", HTMLButtonElement);
const cancelButton = byId("cancel", HTMLButtonElement);
const resumeButton = byId("resume", HTMLButtonElement);
const copyLogButton = byId("copy-log", HTMLButtonElement);
const copyStatus = byId("copy-status", HTMLSpanElement);
const versionElement = byId("app-version", HTMLElement);
const VERSION_LABEL = `epub-tts v${__APP_VERSION__} (${__BUILD_ID__})`;
versionElement.textContent = VERSION_LABEL;
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
  /** The voice that generated this chapter. Dropped segments regenerate with the same voice. */
  voiceId: string;
  /** All sentences of the chapter. Sentence indexes everywhere else are indexes into this array. */
  sentences: Sentence[];
  /** Segments generated so far, in order. The generator appends to this array. */
  segments: Segment[];
  /** Index into `segments` of the segment loaded in the audio element. */
  current: number;
  /** Object URL of the current segment. */
  url: string;
}

/**
 * A chapter the generator is working on. `segments` is shared with `LoadedChapter` once the chapter
 * is loaded into the audio element, so the generator keeps appending to the same array after the swap.
 */
interface ChapterRun {
  chapterIndex: number;
  voiceId: string;
  sentences: Sentence[];
  segments: Segment[];
}

let openedBook: OpenBook | undefined;
let loaded: LoadedChapter | undefined;
// The next chapter, generated in the background while the loaded chapter plays. Not in the audio element yet.
let pendingChapter: ChapterRun | undefined;
// The chapter the running generation started with (not the prefetched one). Undefined when idle.
let generatingChapterIndex: number | undefined;
// True from the start of a generation until its first segment is loaded into the audio element.
let awaitingFirstSegment = false;
// Settles when the running generateChapter call ends. Previous/Next awaits it after a cancel.
let activeGeneration: Promise<void> = Promise.resolve();
// True while a Previous/Next request is being resolved. Blocks overlapping requests.
let navigating = false;
// Per chapter: true when it has text, false when empty, undefined when not checked yet.
let chapterHasText: Array<boolean | undefined> = [];
let currentSentence = -1;
let generating = false;
let cancelRequested = false;
// The voice of the generation in progress. Set when generating starts.
let generationVoiceId = "";
// True while the current segment has ended and the next one is not generated yet.
let buffering = false;
// True while the user wants sound: set by play, cleared by a user or media-session pause.
let wantPlaying = false;
// Playback speed. Reapplied after every audio.src change.
let speed = 1;
const SPEED_MIN = 0.75;
const SPEED_MAX = 2;
// True while a voice download or removal runs.
let voiceBusy = false;
// Whether the selected voice is in the browser storage. Undefined when unknown.
let voiceStored: boolean | undefined;
let voiceMessage = "";
// Text of the last failed voice action. Cleared when a new voice action starts or the voice changes.
let voiceError = "";
let voiceStatusToken = 0;

/** Assigning audio.src resets playbackRate to defaultPlaybackRate, so set both. */
function applyPlaybackRate(): void {
  audio.defaultPlaybackRate = speed;
  audio.playbackRate = speed;
  audio.preservesPitch = true;
}
// Resolves the generator's "wait for room" pause. Set only while the generator waits.
let wakeGeneration: (() => void) | undefined;

function currentSegment(): Segment | undefined {
  return loaded?.segments[loaded.current];
}
let wakeLock: WakeLockSentinel | undefined;

function createWorker(): Worker {
  const created = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
    if (created !== worker) return;
    const data = event.data;
    if (data.type === "log") log(data.text);
    onWorkerEvent(data);
  });
  created.addEventListener("error", (event) => {
    if (created !== worker) return;
    log(`worker error: ${event.message}`);
    failWorker(new Error(`Worker error: ${event.message || "unknown"}`));
  });
  created.addEventListener("messageerror", () => {
    if (created !== worker) return;
    log("worker messageerror");
    failWorker(new Error("Worker message could not be read."));
  });
  return created;
}

let worker = createWorker();
let workerReady = false;
// The voice the worker session holds. Undefined until the first init succeeds.
let workerVoiceId: string | undefined;
// True once the worker received an init request. A used worker is replaced, never re-initialised.
let workerUsed = false;
let onWorkerEvent: (event: WorkerEvent) => void = () => {};
// Rejects the worker wait in flight (init or clip). Set only while a wait is pending.
let rejectPending: ((error: Error) => void) | undefined;
// True while an init request waits for "ready".
let initPending = false;
/** Longest wait for a voice init. A model download on a slow phone can take long. */
const INIT_TIMEOUT_MS = 120_000;

/**
 * Throw the worker away and create a fresh one. The old worker is terminated, and its late
 * messages are ignored because the listeners compare against the current `worker`.
 */
function resetWorker(): void {
  worker.terminate();
  worker = createWorker();
  workerReady = false;
  workerVoiceId = undefined;
  workerUsed = false;
}

/** A worker crash or unreadable message. Resets the worker and settles the pending wait. */
function failWorker(error: Error): void {
  resetWorker();
  rejectPending?.(error);
}

function post(request: WorkerRequest): void {
  worker.postMessage(request);
}

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
  } else {
    const matches = openedBook?.id === saved.bookId;
    savedElement.textContent = `${describePosition(saved)} ${
      matches ? "Press Resume saved position." : "Pick the same EPUB file to resume."
    }`;
  }
  updateControls();
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
    applyPlaybackRate();
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
    ["previoustrack", () => void navigateChapter(-1, "media session")],
    ["nexttrack", () => void navigateChapter(1, "media session")],
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
    album: "epub-tts",
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
  applyPlaybackRate();
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

/**
 * Move from the loaded chapter to the pending one on the same audio element. Runs synchronously,
 * so a swap in the `ended` handler stays in the same task. The old chapter loses its audio.
 */
function switchToPendingChapter(play: boolean, reason: string): void {
  const run = pendingChapter;
  const first = run?.segments[0];
  if (!run || !first?.blob || !openedBook) return;
  const old = loaded;
  loadToken += 1;
  pendingChapter = undefined;
  const url = URL.createObjectURL(first.blob);
  loaded = {
    chapterIndex: run.chapterIndex,
    voiceId: run.voiceId,
    sentences: run.sentences,
    segments: run.segments,
    current: 0,
    url,
  };
  currentSentence = -1;
  buffering = false;
  ignoreSourceChangePause();
  audio.src = url;
  applyPlaybackRate();
  lastPositionState = 0;
  if (play) {
    const startedAt = Date.now();
    const promise = audio.play();
    watchForStuckPlayback(`chapter ${reason}`, true);
    promise.then(
      () => log(`chapter ${run.chapterIndex + 1} play() resolved after ${Date.now() - startedAt} ms`),
      (error: unknown) =>
        log(`chapter ${run.chapterIndex + 1} play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}`),
    );
  }
  if (old) {
    URL.revokeObjectURL(old.url);
    // Release the old chapter's audio. Its late regenerations see `loaded !== active` and stop.
    for (const segment of old.segments) segment.blob = undefined;
  }
  chapterSelect.value = String(run.chapterIndex);
  renderText(run.sentences);
  setMetadata(openedBook.chapters[run.chapterIndex]?.label ?? `Chapter ${run.chapterIndex + 1}`);
  highlight(first.startSentence);
  persistPosition("chapter swap");
  dropFarSegments();
  wakeGeneration?.();
  updateControls();
  log(`swap to chapter ${run.chapterIndex + 1} (${reason})`);
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
  } else if (pendingChapter?.segments[0]?.blob) {
    switchToPendingChapter(true, "swap");
  } else if (generating) {
    buffering = true;
    const waitingFor = pendingChapter ? `the first segment of chapter ${pendingChapter.chapterIndex + 1}` : `segment ${nextIndex + 1}`;
    log(`buffering: ${waitingFor} is not ready yet`);
    statsElement.textContent = `Buffering: waiting for ${waitingFor}...`;
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

function waitForEvent(type: WorkerEvent["type"], timeoutMs?: number): Promise<WorkerEvent> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const finish = (): void => {
      window.clearTimeout(timer);
      onWorkerEvent = () => {};
      rejectPending = undefined;
    };
    rejectPending = (error) => {
      finish();
      reject(error);
    };
    if (timeoutMs !== undefined) {
      timer = window.setTimeout(() => {
        log(`worker wait for "${type}" timed out after ${timeoutMs / 1000} s`);
        rejectPending?.(new Error(`Timed out after ${timeoutMs / 1000} s while loading the voice.`));
      }, timeoutMs);
    }
    onWorkerEvent = (event) => {
      if (event.type === type) {
        finish();
        resolve(event);
      } else if (event.type === "error") {
        finish();
        reject(new Error(event.message));
      } else if (event.type === "model-progress") {
        const percent = Math.round((event.loaded * 100) / event.total);
        statsElement.textContent = `Downloading voice model: ${percent}%`;
      }
    };
  });
}

/**
 * Make the worker hold a session for `voiceId`. The library keeps one global session per worker and
 * ignores a new voice id, so a voice change replaces the whole worker. Terminating the old worker
 * releases its model and WASM memory. Runs inside the worker queue, so no clip request is in flight.
 */
function ensureWorker(voiceId: string): Promise<void> {
  const run = workerQueue.then(() => initWorker(voiceId));
  workerQueue = run.catch(() => undefined);
  return run;
}

async function initWorker(voiceId: string): Promise<void> {
  if (workerReady && workerVoiceId === voiceId) return;
  if (workerUsed) {
    log(`replacing worker session (${workerVoiceId ?? "failed init"} -> ${voiceId})`);
    resetWorker();
  }
  workerUsed = true;
  workerReady = false;
  workerVoiceId = undefined;
  statsElement.textContent = "Loading voice model and WASM...";
  const ready = waitForEvent("ready", INIT_TIMEOUT_MS);
  initPending = true;
  post({
    type: "init",
    voiceId,
    baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href,
  });
  let event: WorkerEvent;
  try {
    event = await ready;
  } catch (error) {
    // Init failed, timed out or was cancelled. Drop the worker unless it was already reset.
    if (workerUsed) resetWorker();
    throw error;
  } finally {
    initPending = false;
  }
  workerReady = true;
  workerVoiceId = voiceId;
  if (event.type === "ready") log(`model ${voiceId} ready in ${(event.initMs / 1000).toFixed(1)} s`);
  refreshVoiceStatus();
}

interface GeneratedClip {
  clip: Clip;
  genMs: number;
}

// The worker handles one request at a time and reports through one global handler.
// Every clip request waits for the previous one. Forward generation and regeneration
// interleave per sentence this way and never overlap in the worker.
let workerQueue: Promise<unknown> = Promise.resolve();

/** Thrown when the worker holds another voice than the request expects. */
class VoiceChangedError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Worker voice changed (expected ${expected}, worker has ${actual ?? "none"}).`);
    this.name = "VoiceChangedError";
  }
}

/**
 * Generate one sentence. One sentence per worker request lets the page pause between sentences.
 * The request carries the voice it expects. It fails without sending anything when the worker
 * holds another voice, so a clip is never made with the wrong voice.
 */
function generateClip(text: string, voiceId: string): Promise<GeneratedClip> {
  const run = workerQueue.then(() => {
    if (!workerReady || workerVoiceId !== voiceId) throw new VoiceChangedError(voiceId, workerVoiceId);
    return requestClip(text);
  });
  workerQueue = run.catch(() => undefined);
  return run;
}

function requestClip(text: string): Promise<GeneratedClip> {
  return new Promise((resolve, reject) => {
    let result: GeneratedClip | undefined;
    const finish = (): void => {
      onWorkerEvent = () => {};
      rejectPending = undefined;
    };
    rejectPending = (error) => {
      finish();
      reject(error);
    };
    onWorkerEvent = (event) => {
      if (event.type === "clip") {
        result = { clip: { sampleRate: event.sampleRate, pcm: event.pcm }, genMs: event.genMs };
      } else if (event.type === "done") {
        finish();
        if (result) resolve(result);
        else reject(new Error("Worker finished without a clip."));
      } else if (event.type === "cancelled") {
        finish();
        reject(new Error("Generation cancelled."));
      } else if (event.type === "error") {
        finish();
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
  const obsolete = (): boolean =>
    loaded !== active ||
    token !== loadToken ||
    epoch !== cancelEpoch ||
    (generating && active.voiceId !== generationVoiceId);
  if (generating && active.voiceId !== generationVoiceId) {
    // The generator is about to switch the worker to another voice. Do not switch it back.
    log(`segment ${segmentIndex + 1} regeneration skipped: a generation with another voice is starting`);
    return Promise.resolve(false);
  }
  const task = (async (): Promise<boolean> => {
    log(`segment ${segmentIndex + 1} regenerating`);
    statsElement.textContent = `Regenerating segment ${segmentIndex + 1}...`;
    const startedAt = performance.now();
    try {
      await ensureWorker(active.voiceId);
      const clips: Clip[] = [];
      const gaps: number[] = [];
      for (let i = segment.startSentence; i < segment.startSentence + segment.count; i += 1) {
        if (obsolete()) {
          log(`segment ${segmentIndex + 1} regeneration abandoned (superseded or cancelled)`);
          return false;
        }
        const sentence = active.sentences[i];
        if (!sentence) throw new Error(`Sentence ${i + 1} is missing.`);
        const { clip } = await generateClip(sentence.text, active.voiceId);
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
      if (error instanceof VoiceChangedError) {
        log(`segment ${segmentIndex + 1} regeneration abandoned: ${error.message}`);
        return false;
      }
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

/**
 * Ready segments ahead of the playing one. For the pending chapter this counts the rest of the
 * loaded chapter plus all pending segments, so both share the SEGMENTS_AHEAD budget.
 */
function segmentsAhead(segments: Segment[]): number {
  if (loaded?.segments === segments) return segments.length - 1 - loaded.current;
  if (loaded && pendingChapter?.segments === segments) {
    return loaded.segments.length - 1 - loaded.current + segments.length;
  }
  return 0;
}

/** Wait until fewer than SEGMENTS_AHEAD ready segments are queued after the playing one. */
async function waitForRoom(segments: Segment[]): Promise<void> {
  const ahead = (): number => segmentsAhead(segments);
  if (ahead() >= SEGMENTS_AHEAD) log(`generation paused: ${ahead()} segments ahead of playback`);
  while (!cancelRequested && ahead() >= SEGMENTS_AHEAD) {
    await new Promise<void>((resolve) => {
      wakeGeneration = resolve;
    });
    wakeGeneration = undefined;
  }
  throwIfCancelled();
}

/** Wait until the chapter run is in the audio element. The generator never prefetches two chapters ahead. */
async function waitUntilLoaded(run: ChapterRun): Promise<void> {
  while (!cancelRequested && loaded?.segments !== run.segments) {
    await new Promise<void>((resolve) => {
      wakeGeneration = resolve;
    });
    wakeGeneration = undefined;
  }
  throwIfCancelled();
}

function onSegmentReady(run: ChapterRun): void {
  const { segments, chapterIndex, sentences } = run;
  const index = segments.length - 1;
  const segment = segments[index];
  if (!segment?.blob || !openedBook || cancelRequested) return;
  if (index === 0 && run === pendingChapter) {
    log(`chapter ${chapterIndex + 1}: first segment ready (prefetched)`);
    if (buffering && loaded && loaded.current === loaded.segments.length - 1) {
      log(`chapter ${chapterIndex + 1} was awaited${wantPlaying ? "" : ", paused by user: loaded without playing"}`);
      switchToPendingChapter(wantPlaying, "buffer end");
    }
  } else if (index === 0) {
    if (loaded) {
      URL.revokeObjectURL(loaded.url);
      for (const old of loaded.segments) old.blob = undefined;
    }
    const url = URL.createObjectURL(segment.blob);
    loaded = { chapterIndex, voiceId: run.voiceId, sentences, segments, current: 0, url };
    awaitingFirstSegment = false;
    currentSentence = -1;
    buffering = false;
    ignoreSourceChangePause();
    audio.src = url;
    applyPlaybackRate();
    chapterSelect.value = String(chapterIndex);
    renderText(sentences);
    setMetadata(openedBook.chapters[chapterIndex]?.label ?? `Chapter ${chapterIndex + 1}`);
    highlight(segment.startSentence);
    updateControls();
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

/** Generate the segments of one chapter run, appending to `run.segments`. */
async function generateSegments(run: ChapterRun, startSentence: number): Promise<void> {
  const { segments, sentences, chapterIndex } = run;
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
      const { clip, genMs } = await generateClip(sentence.text, generationVoiceId);
      throwIfCancelled();
      const gapMs = sentence.paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS;
      clips.push(clip);
      gaps.push(gapMs);
      seconds += clip.pcm.length / clip.sampleRate + gapMs / 1000;
      totalGenMs += genMs;
      next += 1;
      statsElement.textContent =
        `Chapter ${chapterIndex + 1}, segment ${segments.length + 1}: sentence ${next}/${sentences.length}. ` +
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
    onSegmentReady(run);
  }
  const summary =
    `Chapter ${chapterIndex + 1} generation done. ${segments.length} segments, audio ${totalAudioS.toFixed(1)} s, ` +
    `generation ${(totalGenMs / 1000).toFixed(1)} s, RTF ${(totalGenMs / 1000 / Math.max(totalAudioS, 1)).toFixed(2)}.`;
  statsElement.textContent = summary;
  log(summary);
}

/** Read and split a chapter. Records whether it has text. */
async function chapterSentences(book: OpenBook, index: number): Promise<Sentence[]> {
  const sentences = splitSentences(await chapterParagraphs(book, index), book.language);
  if (book === openedBook) {
    chapterHasText[index] = sentences.length > 0;
    updateControls();
  }
  return sentences;
}

interface TextChapter {
  chapterIndex: number;
  sentences: Sentence[];
}

/** The nearest chapter after (`step` 1) or before (`step` -1) `from` that has text. Logs skipped chapters. */
async function findTextChapter(book: OpenBook, from: number, step: 1 | -1): Promise<TextChapter | undefined> {
  for (let index = from + step; index >= 0 && index < book.chapters.length; index += step) {
    if (book !== openedBook) return undefined;
    if (chapterHasText[index] !== false) {
      const sentences = await chapterSentences(book, index);
      if (sentences.length > 0) return { chapterIndex: index, sentences };
    }
    log(`skipped chapter ${index + 1}: no text`);
  }
  return undefined;
}

async function runGeneration(chapterIndex: number, startSentence: number, preparsed: Sentence[] | undefined): Promise<void> {
  const book = openedBook;
  if (!book) return;
  generating = true;
  cancelRequested = false;
  pendingChapter = undefined;
  generatingChapterIndex = chapterIndex;
  awaitingFirstSegment = true;
  generationVoiceId = selectedVoiceId();
  updateControls();
  audio.pause();
  try {
    await acquireWakeLock();
    await ensureWorker(generationVoiceId);
    const sentences = preparsed ?? (await chapterSentences(book, chapterIndex));
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
    let run: ChapterRun = { chapterIndex, voiceId: generationVoiceId, sentences, segments: [] };
    await generateSegments(run, start);
    // Continue into the following chapters, one chapter ahead of playback at most.
    for (;;) {
      await waitUntilLoaded(run);
      const next = await findTextChapter(book, run.chapterIndex, 1);
      throwIfCancelled();
      if (!next || book !== openedBook) {
        log("end of book");
        statsElement.textContent = "End of book. Generation done.";
        break;
      }
      const nextRun: ChapterRun = {
        chapterIndex: next.chapterIndex,
        voiceId: generationVoiceId,
        sentences: next.sentences,
        segments: [],
      };
      pendingChapter = nextRun;
      log(`prefetch: generating chapter ${next.chapterIndex + 1} in the background (${next.sentences.length} sentences)`);
      setGenerationMarker({ chapterIndex: next.chapterIndex, done: 0, total: next.sentences.length, at: Date.now() });
      await generateSegments(nextRun, 0);
      run = nextRun;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statsElement.textContent = `Stopped: ${message}`;
    log(`generation stopped: ${message}`);
  } finally {
    setGenerationMarker(undefined);
    await releaseWakeLock();
    generating = false;
    generatingChapterIndex = undefined;
    awaitingFirstSegment = false;
    wakeGeneration = undefined;
    if (pendingChapter) {
      log(`prefetched chapter ${pendingChapter.chapterIndex + 1} discarded`);
      pendingChapter = undefined;
    }
    if (buffering) {
      buffering = false;
      log("generation ended while buffering. Playback stays stopped.");
    }
    refreshSavedUi();
  }
}

function generateChapter(chapterIndex: number, startSentence = 0, preparsed?: Sentence[]): Promise<void> {
  if (!openedBook || generating) return Promise.resolve();
  activeGeneration = runGeneration(chapterIndex, startSentence, preparsed);
  return activeGeneration;
}

function cancelGeneration(): void {
  cancelRequested = true;
  cancelEpoch += 1;
  // Invalidate the prefetched chapter now. Neither `ended` nor onSegmentReady may swap into it after Cancel.
  if (pendingChapter) {
    log(`prefetched chapter ${pendingChapter.chapterIndex + 1} discarded (cancel)`);
    pendingChapter = undefined;
  }
  if (initPending) {
    // No generate request is running. Terminate the worker so the init wait settles.
    log("cancel during voice init: terminating the worker");
    failWorker(new Error("Generation cancelled."));
  } else {
    post({ type: "cancel" });
  }
  wakeGeneration?.();
  log("cancel requested");
}

/**
 * Start a chapter the user picked by Previous, Next or the chapter select. `find` resolves the target
 * chapter. A running generation is cancelled first, then the target starts from its beginning.
 * Errors are caught here, so fire-and-forget callers never produce an unhandled rejection.
 */
async function runNavigation(
  source: string,
  noTarget: string,
  find: (book: OpenBook) => Promise<TextChapter | undefined>,
): Promise<void> {
  const book = openedBook;
  if (!book || voiceBusy || navigating) {
    log(`chapter change ignored (${source}): ${book ? "busy" : "no book open"}`);
    showPlayingChapter();
    return;
  }
  navigating = true;
  updateControls();
  try {
    const target = await find(book);
    if (book !== openedBook) return;
    if (!target) {
      statsElement.textContent = noTarget;
      log(noTarget);
      showPlayingChapter();
      return;
    }
    if (generating) {
      log(`chapter change (${source}): cancelling the running generation`);
      cancelGeneration();
      await activeGeneration;
    }
    if (generating || book !== openedBook) {
      showPlayingChapter();
      return;
    }
    chapterSelect.value = String(target.chapterIndex);
    void generateChapter(target.chapterIndex, 0, target.sentences);
  } catch (error) {
    statsElement.textContent = `Could not change the chapter: ${errorName(error)}`;
    log(`chapter change failed (${source}): ${errorName(error)}`);
    showPlayingChapter();
  } finally {
    navigating = false;
    updateControls();
  }
}

/** Previous or next chapter with text, relative to the playing chapter. Used by buttons and lock-screen actions. */
async function navigateChapter(step: 1 | -1, source: string): Promise<void> {
  const label = step > 0 ? "next" : "previous";
  const base = navigationBase();
  log(`${label} chapter requested (${source}) from chapter ${base + 1}`);
  if (!Number.isInteger(base)) return;
  await runNavigation(source, `There is no ${label} chapter with text.`, (book) => findTextChapter(book, base, step));
}

/** The user picked a chapter in the select. While generating, this behaves like Previous/Next. */
async function selectChapter(index: number): Promise<void> {
  if (!Number.isInteger(index)) return;
  if (playingChapterIndex() === index) {
    showPlayingChapter();
    return;
  }
  log(`chapter ${index + 1} picked in the list while generating`);
  await runNavigation("select", "That chapter has no text.", async (book) => {
    const sentences = await chapterSentences(book, index);
    return sentences.length > 0 ? { chapterIndex: index, sentences } : undefined;
  });
}

// ---------------------------------------------------------------- voice and speed settings

function selectedVoiceId(): string {
  return findVoice(voiceSelect.value)?.id ?? DEFAULT_VOICE_ID;
}

function persistSettings(): void {
  saveSettings({ voiceId: selectedVoiceId(), speed });
}

function clampSpeed(value: number): number {
  return Math.min(Math.max(value, SPEED_MIN), SPEED_MAX);
}

function showSpeed(): void {
  speedInput.value = String(speed);
  speedLabel.textContent = `${speed.toFixed(2)}x`;
}

function setSpeed(value: number, reason: string): void {
  speed = Math.round(clampSpeed(value) * 100) / 100;
  applyPlaybackRate();
  showSpeed();
  persistSettings();
  log(`speed set to ${speed.toFixed(2)}x (${reason}), playbackRate=${audio.playbackRate}`);
}

speedInput.addEventListener("input", () => {
  const value = Number(speedInput.value);
  if (Number.isFinite(value)) speedLabel.textContent = `${clampSpeed(value).toFixed(2)}x`;
});
speedInput.addEventListener("change", () => {
  const value = Number(speedInput.value);
  if (Number.isFinite(value)) setSpeed(value, "slider");
});
speedResetButton.addEventListener("click", () => setSpeed(1, "reset"));
audio.addEventListener("ratechange", () => {
  lastPositionState = 0;
  updatePositionState();
});

// (voice state variables are declared with the other state at the top)

/**
 * The chapter that is playing or starting. Before the first segment of a running generation loads,
 * that is the chapter being generated. Otherwise it is the loaded chapter. Undefined when neither exists.
 */
function playingChapterIndex(): number | undefined {
  if (generating && awaitingFirstSegment && generatingChapterIndex !== undefined) return generatingChapterIndex;
  return loaded?.chapterIndex ?? (generating ? generatingChapterIndex : undefined);
}

/** The chapter Previous/Next move from: the playing chapter, else the select value. */
function navigationBase(): number {
  return playingChapterIndex() ?? Number(chapterSelect.value);
}

/** Show the playing chapter in the select. Call after every swap, fresh start and navigation. */
function showPlayingChapter(): void {
  const index = playingChapterIndex();
  if (index !== undefined) chapterSelect.value = String(index);
}

/**
 * True when a chapter before (`step` -1) or after (`step` 1) `from` may have text. A chapter that is
 * not scanned yet counts as maybe. Once the scan has checked it, only chapters with text count.
 */
function hasTextChapter(from: number, step: 1 | -1): boolean {
  const book = openedBook;
  if (!book || !Number.isInteger(from)) return false;
  for (let index = from + step; index >= 0 && index < book.chapters.length; index += step) {
    if (chapterHasText[index] !== false) return true;
  }
  return false;
}

function updateControls(): void {
  const locked = generating || voiceBusy;
  generateButton.disabled = locked || !openedBook;
  cancelButton.disabled = !generating;
  const saved = loadPosition();
  resumeButton.disabled = locked || !saved || openedBook?.id !== saved.bookId;
  voiceSelect.disabled = locked;
  const base = navigationBase();
  prevChapterButton.disabled = voiceBusy || navigating || !hasTextChapter(base, -1);
  nextChapterButton.disabled = voiceBusy || navigating || !hasTextChapter(base, 1);
  voiceDownloadButton.disabled = locked || voiceStored !== false;
  voiceRemoveButton.disabled = locked || voiceStored !== true;
  if (voiceBusy) {
    voiceStatus.textContent = voiceMessage;
  } else if (voiceError) {
    voiceStatus.textContent = voiceError;
  } else if (voiceStored === undefined) {
    voiceStatus.textContent = "Status unknown";
  } else if (voiceStored) {
    voiceStatus.textContent = "Downloaded";
  } else {
    const size = findVoice(selectedVoiceId())?.sizeMb ?? 61;
    voiceStatus.textContent = `Not downloaded (about ${Math.round(size)} MB)`;
  }
}

async function readStoredVoices(): Promise<string[] | undefined> {
  try {
    return await stored();
  } catch (error) {
    log(`voice storage unavailable: ${errorName(error)}`);
    return undefined;
  }
}

async function refreshVoiceStatus(): Promise<void> {
  const token = ++voiceStatusToken;
  const id = selectedVoiceId();
  const list = await readStoredVoices();
  if (token !== voiceStatusToken) return;
  voiceStored = list ? list.includes(id) : undefined;
  updateControls();
}

/** The library does not wait for its file write, so poll a few times after a download. */
async function waitUntilStored(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const list = await readStoredVoices();
    if (!list) return false;
    if (list.includes(id)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

voiceSelect.addEventListener("change", () => {
  const id = selectedVoiceId();
  persistSettings();
  log(`voice selected: ${id}. The worker switches before the next generation.`);
  voiceStored = undefined;
  voiceError = "";
  void refreshVoiceStatus();
});

voiceDownloadButton.addEventListener("click", () => {
  if (generating || voiceBusy) return;
  const id = selectedVoiceId();
  voiceBusy = true;
  voiceError = "";
  voiceMessage = "Downloading 0%";
  updateControls();
  log(`voice download started: ${id}`);
  void (async () => {
    try {
      await download(id, (progress) => {
        if (progress.total <= 0) return;
        voiceMessage = `Downloading ${Math.round((progress.loaded * 100) / progress.total)}%`;
        updateControls();
      });
      const ok = await waitUntilStored(id);
      log(ok ? `voice download finished: ${id}` : `voice download finished but ${id} was not found in storage`);
    } catch (error) {
      log(`voice download failed: ${errorName(error)}`);
    } finally {
      voiceBusy = false;
      updateControls();
      await refreshVoiceStatus();
    }
  })();
});

voiceRemoveButton.addEventListener("click", () => {
  if (generating || voiceBusy) return;
  const id = selectedVoiceId();
  voiceBusy = true;
  voiceError = "";
  voiceMessage = "Removing...";
  updateControls();
  log(`voice remove started: ${id}`);
  void (async () => {
    try {
      await remove(id);
      // The library swallows errors and needs FileSystemHandle.remove() (not in Safari). Check, then delete directly.
      if ((await readStoredVoices())?.includes(id)) {
        log(`library remove left ${id} in storage: deleting the files directly`);
        await removeVoiceFiles(id);
      }
      const left = await readStoredVoices();
      if (left?.includes(id)) throw new Error("the files are still in storage after deletion");
      log(`voice removed: ${id}`);
    } catch (error) {
      voiceError = `Could not remove the voice: ${errorName(error)}`;
      log(`voice remove failed: ${errorName(error)}`);
    } finally {
      voiceBusy = false;
      updateControls();
      await refreshVoiceStatus();
    }
  })();
});

function initSettings(): void {
  voiceSelect.replaceChildren(...VOICES.map((voice) => new Option(voice.label, voice.id)));
  const saved = loadSettings();
  let voiceId = DEFAULT_VOICE_ID;
  if (saved) {
    if (findVoice(saved.voiceId)) {
      voiceId = saved.voiceId;
    } else {
      log(`saved voice ${saved.voiceId} is not in the voice list. Using ${DEFAULT_VOICE_ID}.`);
    }
    speed = Math.round(clampSpeed(saved.speed) * 100) / 100;
  }
  voiceSelect.value = voiceId;
  applyPlaybackRate();
  showSpeed();
  persistSettings();
  log(`settings: voice=${voiceId} speed=${speed.toFixed(2)}x`);
  updateControls();
  void refreshVoiceStatus();
}
initSettings();

// ---------------------------------------------------------------- UI wiring

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  bookInfo.textContent = "Reading EPUB...";
  openBook(file)
    .then(async (opened) => {
      // A running generation and the loaded chapter belong to the previous book.
      if (generating) {
        log("new book opened: cancelling the running generation");
        cancelGeneration();
        await activeGeneration;
      }
      if (loaded) {
        audio.pause();
        ignoreSourceChangePause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(loaded.url);
        loaded = undefined;
        textElement.replaceChildren();
        currentSentence = -1;
      }
      openedBook = opened;
      bookInfo.textContent = `${opened.title} (language: ${opened.language}, ${opened.chapters.length} spine items)`;
      chapterSelect.replaceChildren(
        ...opened.chapters.map((c) => new Option(c.label, String(c.index))),
      );
      chapterSelect.disabled = false;
      chapterHasText = new Array<boolean | undefined>(opened.chapters.length).fill(undefined);
      log(`opened "${opened.title}" with ${opened.chapters.length} spine items`);
      // GROUP C: preselect the saved chapter when this is the saved book. Nothing starts by itself.
      const savedPosition = loadPosition();
      if (savedPosition?.bookId === opened.id && opened.chapters[savedPosition.chapterIndex]) {
        chapterSelect.value = String(savedPosition.chapterIndex);
        log(`restored saved chapter ${savedPosition.chapterIndex + 1}`);
      }
      refreshSavedUi();
      void scanChapters(opened);
    })
    .catch((error: unknown) => {
      bookInfo.textContent = `Could not open the EPUB: ${String(error)}`;
      log(`epub error: ${String(error)}`);
    });
});

/** Check every chapter for text in the background, so Previous and Next know where the book starts and ends. */
async function scanChapters(book: OpenBook): Promise<void> {
  for (let index = 0; index < book.chapters.length; index += 1) {
    if (book !== openedBook) return;
    if (chapterHasText[index] !== undefined) continue;
    try {
      await chapterSentences(book, index);
    } catch (error) {
      log(`chapter scan: chapter ${index + 1} could not be read: ${errorName(error)}`);
    }
  }
  const empty = chapterHasText.filter((value) => value === false).length;
  log(`chapter scan done: ${empty} of ${book.chapters.length} spine items have no text`);
  updateControls();
}

chapterSelect.addEventListener("change", () => {
  // While generating, a picked chapter behaves like Previous/Next. While idle it only updates the controls.
  if (generating || navigating) void selectChapter(Number(chapterSelect.value));
  else updateControls();
});
prevChapterButton.addEventListener("click", () => void navigateChapter(-1, "button"));
nextChapterButton.addEventListener("click", () => void navigateChapter(1, "button"));

generateButton.addEventListener("click", () => {
  if (voiceBusy) return;
  void generateChapter(Number(chapterSelect.value));
});

cancelButton.addEventListener("click", () => cancelGeneration());

resumeButton.addEventListener("click", () => {
  const saved = loadPosition();
  if (!saved || openedBook?.id !== saved.bookId || voiceBusy) return;
  chapterSelect.value = String(saved.chapterIndex);
  log(`resuming at sentence ${saved.sentenceIndex + 1} with voice ${selectedVoiceId()}: generating from that sentence`);
  void generateChapter(saved.chapterIndex, saved.sentenceIndex);
});

function diagnosticsText(): string {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return [
    VERSION_LABEL,
    `user agent: ${navigator.userAgent}`,
    `visibility=${document.visibilityState} standalone=${standalone}`,
    "",
    logText(),
  ].join("\n");
}

/** Fallback for browsers without the async clipboard API. */
function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

let copyStatusTimer: number | undefined;
function showCopyStatus(message: string): void {
  copyStatus.textContent = message;
  window.clearTimeout(copyStatusTimer);
  copyStatusTimer = window.setTimeout(() => {
    copyStatus.textContent = "";
  }, 2000);
}

copyLogButton.addEventListener("click", () => {
  const text = diagnosticsText();
  const fallback = (reason: string): void => {
    if (copyWithSelection(text)) {
      log("log copied (fallback)");
      showCopyStatus("Copied");
    } else {
      log(`copy failed: ${reason}`);
      showCopyStatus("Copy failed");
    }
  };
  if (!navigator.clipboard) {
    fallback("clipboard API missing");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      log("log copied");
      showCopyStatus("Copied");
    },
    (error: unknown) => fallback(String(error)),
  );
});

log("ready");
