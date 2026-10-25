import type { OpenBook, Sentence } from "./epub";
import { log, logText } from "./log";
import {
  loadPosition,
  savePosition,
  setGenerationMarker,
} from "./store";
import { DEFAULT_VOICE_ID, VOICES, findVoice } from "./voices";
import { joinClips } from "./wav";
import { createWorkerClient, VoiceChangedError } from "./engine/worker-client";
import type { GeneratedClip } from "./engine/worker-client";
import { createDiagnostics } from "./engine/diagnostics";
import { createSettings } from "./engine/settings";
import { createBook } from "./engine/book";
import type { TextChapter } from "./engine/book";
import { createVoicesStore } from "./engine/voices-store";
import { createLibrary } from "./engine/library";
import {
  MAX_RECOVERY_ATTEMPTS,
  METADATA_TIMEOUT_MS,
  PARAGRAPH_GAP_MS,
  PAUSE_IGNORE_MS,
  SAVE_INTERVAL_MS,
  SEEK_STEP_S,
  SEGMENT_TARGET_S as DEFAULT_SEGMENT_TARGET_S,
  SEGMENTS_AHEAD,
  SEGMENTS_BEHIND,
  SENTENCE_GAP_MS,
  SNAPSHOT_MS,
  STUCK_CHECK_MS,
  segmentTargetSeconds,
} from "./engine/config";
import {
  clampSpeed,
  describePosition,
  errorName,  farSegments,
  hasTextChapter as hasTextChapterIn,
  playingChapterIndex as playingChapterIndexOf,
  segmentForSentence,
  segmentsAhead as segmentsAheadOf,
  sentenceIn,
} from "./engine/pure";
import type { Clip, Timing } from "./wav";
import type { EngineHooks } from "./engine/hooks";

/** Target audio length of one segment. A segment closes once clips and gaps reach this. */
// The e2e check stays here so the build-time define removes the override code from production bundles.
const SEGMENT_TARGET_S = import.meta.env.VITE_E2E
  ? segmentTargetSeconds(location.search, true)
  : DEFAULT_SEGMENT_TARGET_S;

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing element #${id}`);
  return element;
}

const fileInput = byId("file", HTMLInputElement);
const bookInfo = byId("book", HTMLDivElement);
const forgetButton = byId("forget-book", HTMLButtonElement);
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

// Engine-side DOM access goes through these synchronous hooks. Function declarations below are hoisted.
const hooks: EngineHooks = {
  notifyChange: () => updateControls(),
  setStatus: (text) => {
    statsElement.textContent = text;
  },
  showChapter: (index) => {
    chapterSelect.value = String(index);
  },
  renderChapter: (sentences) => renderText(sentences),
  highlight: (index) => {
    textElement.querySelector(".current")?.classList.remove("current");
    const span = textElement.querySelector(`span[data-index="${index}"]`);
    if (span) {
      span.classList.add("current");
      span.scrollIntoView({ block: "nearest" });
    }
  },
  clearText: () => {
    textElement.replaceChildren();
  },
  getSelectedChapter: () => Number(chapterSelect.value),
  setBookInfo: (text) => {
    bookInfo.textContent = text;
  },
  appendBookInfo: (text) => {
    bookInfo.textContent += text;
  },
  fillChapters: (chapters) => {
    chapterSelect.replaceChildren(...chapters.map((c) => new Option(c.label, String(c.index))));
    chapterSelect.disabled = false;
  },
  clearChapters: () => {
    chapterSelect.replaceChildren();
    chapterSelect.disabled = true;
  },
  refreshSaved: () => refreshSavedUi(),
};

const diagnostics = createDiagnostics({ audio, getVisibility: () => document.visibilityState });

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

diagnostics.reportStaleMarker();

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

// The open book and its per-chapter has-text flags. Chapter text reading lives here too.
const bookStore = createBook({ hooks });
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
let currentSentence = -1;
let generating = false;
let cancelRequested = false;
// The voice of the generation in progress. Set when generating starts.
let generationVoiceId = "";
// True while the current segment has ended and the next one is not generated yet.
let buffering = false;
// True while the user wants sound: set by play, cleared by a user or media-session pause.
let wantPlaying = false;
// Playback speed and voice id. The speed is reapplied after every audio.src change.
const settings = createSettings({ audio });
// Voice download, removal and storage status. `generating` is read through a getter.
const voices = createVoicesStore({
  hooks,
  getVoiceId: () => selectedVoiceId(),
  isGenerating: () => generating,
  persistSettings: () => settings.persist(),
});
// Pick, remember, restore and forget a book. Owns the book token, remembered and busy flags.
const library = createLibrary({
  hooks,
  bookStore,
  isGenerating: () => generating,
  cancelGeneration: () => cancelGeneration(),
  activeGeneration: () => activeGeneration,
  unloadChapter: () => unloadChapter(),
  isNavigating: () => navigating,
  isPaused: () => audio.paused,
  voicesBusy: () => voices.busy,
});

/** Assigning audio.src resets playbackRate to defaultPlaybackRate, so set both. */
function applyPlaybackRate(): void {
  settings.applyPlaybackRate();
}
// Resolves the generator's "wait for room" pause. Set only while the generator waits.
let wakeGeneration: (() => void) | undefined;

function currentSegment(): Segment | undefined {
  return loaded?.segments[loaded.current];
}
let wakeLock: WakeLockSentinel | undefined;

// Created eagerly here, at the same point in the boot order as the old `let worker = createWorker()`.
const workerClient = createWorkerClient({
  setStatus: (text) => hooks.setStatus(text),
  onReady: () => {
    void voices.refresh();
  },
});

// ---------------------------------------------------------------- saved position

function refreshSavedUi(): void {
  const saved = loadPosition();
  if (!saved) {
    savedElement.textContent = "No saved position.";
  } else {
    const matches = bookStore.opened?.id === saved.bookId;
    savedElement.textContent = `${describePosition(saved, Date.now())} ${
      matches ? "Press Resume saved position." : "Pick the same EPUB file to resume."
    }`;
  }
  hooks.notifyChange();
}

function persistPosition(reason: string): void {
  if (!bookStore.opened || !loaded) return;
  savePosition({
    bookId: bookStore.opened.id,
    bookTitle: bookStore.opened.title,
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

diagnostics.startHeartbeat();

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

diagnostics.logAudioEvents();

// ---------------------------------------------------------------- audio session

diagnostics.setupAudioSession();

// ---------------------------------------------------------------- stuck playback recovery

// Token of the recovery in flight, or 0. Only that recovery may clear it.
let recoveryOwner = 0;
let recoveryCausedPause = false;
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
    artist: bookStore.opened?.title ?? "EPUB TTS",
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

function sentenceAt(seconds: number): number {
  const segment = currentSegment();
  return segment ? sentenceIn(segment, seconds) : -1;
}

function highlight(index: number): void {
  if (index === currentSentence) return;
  currentSentence = index;
  hooks.highlight(index);
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
  const segmentIndex = segmentForSentence(loaded.segments, index);
  const segment = loaded.segments[segmentIndex];
  if (!segment) {
    void jumpToSentence(index);
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
  for (const index of farSegments(segments.length, current, SEGMENTS_BEHIND, SEGMENTS_AHEAD)) {
    const segment = segments[index];
    if (!segment?.blob) continue;
    segment.blob = undefined;
    log(`segment ${index + 1} dropped`);
  }
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
  if (!run || !first?.blob || !bookStore.opened) return;
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
  hooks.showChapter(run.chapterIndex);
  hooks.renderChapter(run.sentences);
  setMetadata(bookStore.opened.chapters[run.chapterIndex]?.label ?? `Chapter ${run.chapterIndex + 1}`);
  highlight(first.startSentence);
  persistPosition("chapter swap");
  dropFarSegments();
  wakeGeneration?.();
  hooks.notifyChange();
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
    hooks.setStatus(`Buffering: waiting for ${waitingFor}...`);
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

// Thin wrappers over the worker client. The call sites stay unchanged.
function ensureWorker(voiceId: string): Promise<void> {
  return workerClient.ensure(voiceId);
}

function generateClip(text: string, voiceId: string): Promise<GeneratedClip> {
  return workerClient.clip(text, voiceId);
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
    hooks.setStatus(`Regenerating segment ${segmentIndex + 1}...`);
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
      hooks.setStatus(`Segment ${segmentIndex + 1} regenerated.`);
      return true;
    } catch (error) {
      if (error instanceof VoiceChangedError) {
        log(`segment ${segmentIndex + 1} regeneration abandoned: ${error.message}`);
        return false;
      }
      log(`segment ${segmentIndex + 1} regeneration failed: ${errorName(error)}`);
      hooks.setStatus(`Regeneration failed: ${errorName(error)}`);
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
  if (loaded?.segments === segments) return segmentsAheadOf(segments.length, loaded.current);
  if (loaded && pendingChapter?.segments === segments) {
    return segmentsAheadOf(loaded.segments.length, loaded.current, segments.length);
  }
  return segmentsAheadOf(undefined, 0);
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
  if (!segment?.blob || !bookStore.opened || cancelRequested) return;
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
    hooks.showChapter(chapterIndex);
    hooks.renderChapter(sentences);
    setMetadata(bookStore.opened.chapters[chapterIndex]?.label ?? `Chapter ${chapterIndex + 1}`);
    highlight(segment.startSentence);
    hooks.notifyChange();
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
      hooks.setStatus(
        `Chapter ${chapterIndex + 1}, segment ${segments.length + 1}: sentence ${next}/${sentences.length}. ` +
        `Generated ${(totalGenMs / 1000).toFixed(1)} s for ${(totalAudioS + seconds).toFixed(1)} s of audio.`,
      );
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
  hooks.setStatus(summary);
  log(summary);
}

async function runGeneration(chapterIndex: number, startSentence: number, preparsed: Sentence[] | undefined): Promise<void> {
  const book = bookStore.opened;
  if (!book) return;
  generating = true;
  cancelRequested = false;
  pendingChapter = undefined;
  generatingChapterIndex = chapterIndex;
  awaitingFirstSegment = true;
  generationVoiceId = selectedVoiceId();
  hooks.notifyChange();
  audio.pause();
  try {
    await acquireWakeLock();
    await ensureWorker(generationVoiceId);
    const sentences = preparsed ?? (await bookStore.chapterSentences(book, chapterIndex));
    if (sentences.length === 0) {
      hooks.setStatus("This chapter has no text. Pick another chapter.");
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
      const next = await bookStore.findTextChapter(book, run.chapterIndex, 1);
      throwIfCancelled();
      if (!next || book !== bookStore.opened) {
        log("end of book");
        hooks.setStatus("End of book. Generation done.");
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
    hooks.setStatus(`Stopped: ${message}`);
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
  if (!bookStore.opened || generating || library.busy) return Promise.resolve();
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
  workerClient.cancel();
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
  const book = bookStore.opened;
  if (!book || voices.busy || navigating) {
    log(`chapter change ignored (${source}): ${book ? "busy" : "no book open"}`);
    showPlayingChapter();
    return;
  }
  navigating = true;
  hooks.notifyChange();
  try {
    const target = await find(book);
    if (book !== bookStore.opened) return;
    if (!target) {
      hooks.setStatus(noTarget);
      log(noTarget);
      showPlayingChapter();
      return;
    }
    if (generating) {
      log(`chapter change (${source}): cancelling the running generation`);
      cancelGeneration();
      await activeGeneration;
    }
    if (generating || book !== bookStore.opened) {
      showPlayingChapter();
      return;
    }
    hooks.showChapter(target.chapterIndex);
    void generateChapter(target.chapterIndex, 0, target.sentences);
  } catch (error) {
    hooks.setStatus(`Could not change the chapter: ${errorName(error)}`);
    log(`chapter change failed (${source}): ${errorName(error)}`);
    showPlayingChapter();
  } finally {
    navigating = false;
    hooks.notifyChange();
  }
}

/**
 * Jump to a sentence of the loaded chapter that is in no generated segment. The running generation
 * is cancelled, then the same chapter restarts at that sentence. The `navigating` flag prevents
 * overlap, so a click during a jump is ignored. Errors are caught here.
 */
async function jumpToSentence(sentenceIndex: number): Promise<void> {
  const book = bookStore.opened;
  const chapter = loaded;
  if (!book || !chapter || voices.busy || navigating) {
    log(`jump ignored: sentence ${sentenceIndex + 1} (${book && chapter ? "busy" : "nothing loaded"})`);
    return;
  }
  if (sentenceIndex < 0 || sentenceIndex >= chapter.sentences.length) return;
  navigating = true;
  hooks.notifyChange();
  try {
    log(`jump: restarting generation at sentence ${sentenceIndex + 1}`);
    hooks.setStatus(`Jumping to sentence ${sentenceIndex + 1}...`);
    if (generating) {
      cancelGeneration();
      await activeGeneration;
    }
    if (generating || book !== bookStore.opened) return;
    wantPlaying = true;
    hooks.showChapter(chapter.chapterIndex);
    void generateChapter(chapter.chapterIndex, sentenceIndex, chapter.sentences);
  } catch (error) {
    hooks.setStatus(`Could not jump to the sentence: ${errorName(error)}`);
    log(`jump failed: ${errorName(error)}`);
  } finally {
    navigating = false;
    hooks.notifyChange();
  }
}

/** Previous or next chapter with text, relative to the playing chapter. Used by buttons and lock-screen actions. */
async function navigateChapter(step: 1 | -1, source: string): Promise<void> {
  const label = step > 0 ? "next" : "previous";
  const base = navigationBase();
  log(`${label} chapter requested (${source}) from chapter ${base + 1}`);
  if (!Number.isInteger(base)) return;
  await runNavigation(source, `There is no ${label} chapter with text.`, (book) => bookStore.findTextChapter(book, base, step));
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
    const sentences = await bookStore.chapterSentences(book, index);
    return sentences.length > 0 ? { chapterIndex: index, sentences } : undefined;
  });
}

// ---------------------------------------------------------------- voice and speed settings

function selectedVoiceId(): string {
  return settings.voiceId;
}

function showSpeed(): void {
  speedInput.value = String(settings.speed);
  speedLabel.textContent = `${settings.speed.toFixed(2)}x`;
}

function setSpeed(value: number, reason: string): void {
  settings.setSpeed(value);
  applyPlaybackRate();
  showSpeed();
  settings.persist();
  log(`speed set to ${settings.speed.toFixed(2)}x (${reason}), playbackRate=${audio.playbackRate}`);
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
  return playingChapterIndexOf({
    generating,
    awaitingFirstSegment,
    generatingChapterIndex,
    loadedChapterIndex: loaded?.chapterIndex,
  });
}

/** The chapter Previous/Next move from: the playing chapter, else the select value. */
function navigationBase(): number {
  return playingChapterIndex() ?? hooks.getSelectedChapter();
}

/** Show the playing chapter in the select. Call after every swap, fresh start and navigation. */
function showPlayingChapter(): void {
  const index = playingChapterIndex();
  if (index !== undefined) hooks.showChapter(index);
}

/**
 * True when a chapter before (`step` -1) or after (`step` 1) `from` may have text. A chapter that is
 * not scanned yet counts as maybe. Once the scan has checked it, only chapters with text count.
 */
function hasTextChapter(from: number, step: 1 | -1): boolean {
  const book = bookStore.opened;
  if (!book) return false;
  return hasTextChapterIn(bookStore.hasText, book.chapters.length, from, step);
}

function updateControls(): void {
  const locked = generating || voices.busy || library.busy;
  generateButton.disabled = locked || !bookStore.opened;
  cancelButton.disabled = !generating;
  const saved = loadPosition();
  resumeButton.disabled = locked || !saved || bookStore.opened?.id !== saved.bookId;
  voiceSelect.disabled = locked;
  forgetButton.hidden = !library.remembered;
  forgetButton.disabled = locked || library.busy || navigating || !audio.paused;
  fileInput.disabled = library.busy;
  const base = navigationBase();
  prevChapterButton.disabled = voices.busy || library.busy || navigating || !hasTextChapter(base, -1);
  nextChapterButton.disabled = voices.busy || library.busy || navigating || !hasTextChapter(base, 1);
  voiceDownloadButton.disabled = locked || voices.stored !== false;
  voiceRemoveButton.disabled = locked || voices.stored !== true;
  if (voices.busy) {
    voiceStatus.textContent = voices.message;
  } else if (voices.error) {
    voiceStatus.textContent = voices.error;
  } else if (voices.stored === undefined) {
    voiceStatus.textContent = "Status unknown";
  } else if (voices.stored) {
    voiceStatus.textContent = "Downloaded";
  } else {
    const size = findVoice(selectedVoiceId())?.sizeMb ?? 61;
    voiceStatus.textContent = `Not downloaded (about ${Math.round(size)} MB)`;
  }
}

voiceSelect.addEventListener("change", () => {
  settings.setVoiceId(voiceSelect.value);
  voices.select();
});

voiceDownloadButton.addEventListener("click", () => voices.startDownload());

voiceRemoveButton.addEventListener("click", () => voices.startRemove());

function initSettings(): void {
  voiceSelect.replaceChildren(...VOICES.map((voice) => new Option(voice.label, voice.id)));
  const { voiceId, rejectedVoice } = settings.load();
  if (rejectedVoice !== undefined) {
    log(`saved voice ${rejectedVoice} is not in the voice list. Using ${DEFAULT_VOICE_ID}.`);
  }
  voiceSelect.value = voiceId;
  applyPlaybackRate();
  showSpeed();
  settings.persist();
  log(`settings: voice=${voiceId} speed=${settings.speed.toFixed(2)}x`);
  hooks.notifyChange();
  void voices.refresh();
}
initSettings();

// ---------------------------------------------------------------- UI wiring

/** Stop playback and drop the loaded chapter. Call only when nothing is generating. */
function unloadChapter(): void {
  if (!loaded) return;
  audio.pause();
  ignoreSourceChangePause();
  audio.removeAttribute("src");
  audio.load();
  URL.revokeObjectURL(loaded.url);
  loaded = undefined;
  hooks.clearText();
  currentSentence = -1;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  // Clear the input so picking the same file again fires a new change event. The File object stays valid.
  fileInput.value = "";
  library.pick(file);
});

audio.addEventListener("play", () => hooks.notifyChange());
audio.addEventListener("pause", () => hooks.notifyChange());

forgetButton.addEventListener("click", () => {
  library.forget();
});

chapterSelect.addEventListener("change", () => {
  // While generating, a picked chapter behaves like Previous/Next. While idle it only updates the controls.
  if (generating || navigating) void selectChapter(hooks.getSelectedChapter());
  else hooks.notifyChange();
});
prevChapterButton.addEventListener("click", () => void navigateChapter(-1, "button"));
nextChapterButton.addEventListener("click", () => void navigateChapter(1, "button"));

generateButton.addEventListener("click", () => {
  if (voices.busy) return;
  void generateChapter(hooks.getSelectedChapter());
});

cancelButton.addEventListener("click", () => cancelGeneration());

resumeButton.addEventListener("click", () => {
  const saved = loadPosition();
  if (!saved || bookStore.opened?.id !== saved.bookId || voices.busy) return;
  hooks.showChapter(saved.chapterIndex);
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

void library.restore();

log("ready");
