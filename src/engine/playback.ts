import type { OpenBook, Sentence } from "../epub";
import { log } from "../log";
import { savePosition, setGenerationMarker } from "../store";
import { joinClips } from "../wav";
import type { Clip, Timing } from "../wav";
import type { BookStore, TextChapter } from "./book";
import {
  MAX_RECOVERY_ATTEMPTS,
  METADATA_TIMEOUT_MS,
  PARAGRAPH_GAP_MS,
  PAUSE_IGNORE_MS,
  SEGMENTS_AHEAD,
  SEGMENTS_BEHIND,
  SENTENCE_GAP_MS,
  SNAPSHOT_MS,
  STUCK_CHECK_MS,
} from "./config";
import type { EngineHooks } from "./hooks";
import type { MediaSessionController } from "./media-session";
import {
  chapterTitle,
  describeProgress,
  errorName,
  farSegments,
  hasTextChapter as hasTextChapterIn,
  playingChapterIndex as playingChapterIndexOf,
  segmentForSentence,
  segmentsAhead as segmentsAheadOf,
  sentenceIn,
} from "./pure";
import type { Settings } from "./settings";
import { VoiceChangedError } from "./worker-client";
import type { WorkerClient } from "./worker-client";

/** A contiguous sentence range, joined into one wav. Timings are relative to the segment start. */
export interface Segment {
  /** Chapter-level index of the first sentence in this segment. */
  startSentence: number;
  count: number;
  /** Small metadata, always kept. */
  timings: Timing[];
  duration: number;
  /** The wav. Undefined once dropped from memory. The current segment is never dropped. */
  blob: Blob | undefined;
}

export interface LoadedChapter {
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
export interface ChapterRun {
  chapterIndex: number;
  voiceId: string;
  sentences: Sentence[];
  segments: Segment[];
}

export interface PlaybackDeps {
  audio: HTMLAudioElement;
  hooks: EngineHooks;
  workerClient: WorkerClient;
  settings: Pick<Settings, "applyPlaybackRate">;
  /** Live: the voice id at the moment of the call. */
  getVoiceId(): string;
  /** Live: true while a voice download or removal runs. */
  isVoicesBusy(): boolean;
  /** Live: true while a book request (forget) runs. */
  isLibraryBusy(): boolean;
  bookStore: BookStore;
  mediaSession: MediaSessionController;
  /** Target audio length of one segment, in seconds. */
  segmentTargetS: number;
}

/** Live values of the flags the controls read. A plain object created at call time. */
export interface PlaybackView {
  generating: boolean;
  /** True while a chapter change or a jump (also a changed-voice restart) cancels and restarts the generation. */
  navigating: boolean;
  /** The user's intent to hear audio. It stays true across the pause between two segments. */
  wantPlaying: boolean;
  navigationBase: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** Voice ids that the loaded chapter, the running generation or a running regeneration uses. Empty when idle. */
  voicesInUse: readonly string[];
}

export interface Playback {
  generateChapter(chapterIndex: number, startSentence?: number, preparsed?: Sentence[]): Promise<void>;
  cancelGeneration(): void;
  /** Live: reads the current promise at the moment of the call. */
  activeGeneration(): Promise<void>;
  unloadChapter(): void;
  navigateChapter(step: 1 | -1, source: string): Promise<void>;
  selectChapter(index: number): Promise<void>;
  /** The voice select changed (the settings already hold the new id). See the implementation for what restarts. */
  applyVoiceChange(): void;
  /**
   * Show the text of a chapter without audio. `index` omitted means the first chapter with text, which is then
   * selected. Does nothing while a generation runs or a chapter is loaded. A late result for an older call is dropped.
   */
  previewChapter(index?: number): Promise<void>;
  /** The click logic for a sentence index that the shell parsed from the DOM event. */
  clickSentence(index: number): void;
  /** Live: true while a chapter is loaded in the audio element. */
  hasLoaded(): boolean;
  persistPosition(reason: string): void;
  watchForStuckPlayback(reason: string, newEpisode: boolean): void;
  playFromMediaSession(): void;
  pauseFromMediaSession(): void;
  seekWithinSegment(seconds: number): void;
  applyPlaybackRate(): void;
  view(): PlaybackView;
  /** Registers the audio `play` and `pause` listeners that keep wantPlaying and the watchdog state. */
  registerPlayPauseListeners(): void;
  /** Registers the audio `timeupdate` listener. */
  registerTimeUpdateListener(): void;
  /** Registers the audio `ended` listener. */
  registerEndedListener(): void;
}

export function createPlayback(deps: PlaybackDeps): Playback {
  const { audio, hooks, workerClient, settings, getVoiceId, isVoicesBusy, isLibraryBusy, bookStore, mediaSession } = deps;
  const SEGMENT_TARGET_S = deps.segmentTargetS;

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
  const VOICE_BUSY_STATUS = "Wait for the voice download to finish.";

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

  // ---------------------------------------------------------------- saved position

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
      mediaSession.setPlaybackState("playing");
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

  /**
   * The voice changed while paused: the loaded audio and the running generation still use the old voice.
   * Restart at `index` with the new voice. Returns true when it handled the request. While a voice download or
   * removal runs it only says so and changes nothing: the worker must not read the voice files that the download writes.
   */
  function restartForChangedVoice(index: number, action: string, where: string): boolean {
    if (!loaded || loaded.voiceId === getVoiceId() || navigating) return false;
    if (isVoicesBusy()) {
      log(`${action} ignored: a voice download or removal is running`);
      hooks.setStatus(VOICE_BUSY_STATUS);
      return true;
    }
    log(`${action} with a changed voice: restarting at ${where} with ${getVoiceId()}`);
    wantPlaying = true;
    void jumpToSentence(index);
    return true;
  }

  function playFromMediaSession(): void {
    if (restartForChangedVoice(Math.max(currentSentence, 0), "resume", "the current sentence")) return;
    wantPlaying = true;
    // While buffering, audio is already paused, so no `play` event follows. Redraw for the new intent.
    hooks.notifyChange();
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

  function registerPlayPauseListeners(): void {
    audio.addEventListener("play", () => {
      wantPlaying = true;
    });

    audio.addEventListener("pause", () => {
      if (recoveryCausedPause) return;
      // The pause at the natural end of a segment is not a user pause.
      if (!audio.ended) wantPlaying = false;
      watchToken += 1;
    });
  }

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

  function pauseFromMediaSession(): void {
    wantPlaying = false;
    watchToken += 1;
    audio.pause();
    // Pausing audio that is already paused (buffering between segments) fires no `pause` event.
    hooks.notifyChange();
  }

  // ---------------------------------------------------------------- highlight

  function sentenceAt(seconds: number): number {
    const segment = currentSegment();
    return segment ? sentenceIn(segment, seconds) : -1;
  }

  function highlight(index: number): void {
    if (index === currentSentence) return;
    currentSentence = index;
    hooks.highlight(index);
  }

  function registerTimeUpdateListener(): void {
    audio.addEventListener("timeupdate", () => {
      highlight(sentenceAt(audio.currentTime));
      mediaSession.updatePositionState();
    });
  }

  /**
   * "Play from here" for a sentence index the shell parsed from the DOM. It always starts playback, also from paused,
   * for a sentence in the current segment, in another generated segment, or in no segment yet.
   */
  function clickSentence(index: number): void {
    if (!loaded) {
      startFromPreview(index);
      return;
    }
    if (restartForChangedVoice(index, "play from here", `sentence ${index + 1}`)) return;
    const segmentIndex = segmentForSentence(loaded.segments, index);
    const segment = loaded.segments[segmentIndex];
    if (!segment) {
      void jumpToSentence(index);
      return;
    }
    const offset = segment.timings[index - segment.startSentence]?.start ?? 0;
    wantPlaying = true;
    if (segmentIndex === loaded.current) {
      audio.currentTime = offset;
      if (audio.paused) {
        buffering = false;
        const startedAt = Date.now();
        const promise = audio.play();
        watchForStuckPlayback("play from here", true);
        promise.then(
          () => log(`audio.play() resolved after ${Date.now() - startedAt} ms (play from here)`),
          (error: unknown) => log(`audio.play() rejected after ${Date.now() - startedAt} ms: ${errorName(error)}`),
        );
        hooks.notifyChange();
      }
      return;
    }
    log(`seek to sentence ${index + 1} in segment ${segmentIndex + 1}`);
    loadSegment(segmentIndex, offset, true, "seek");
  }

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
    mediaSession.resetPositionState();
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
    mediaSession.resetPositionState();
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
    mediaSession.setMetadata(chapterTitle(bookStore.opened.chapters[run.chapterIndex]));
    highlight(first.startSentence);
    persistPosition("chapter swap");
    dropFarSegments();
    wakeGeneration?.();
    hooks.notifyChange();
    log(`swap to chapter ${run.chapterIndex + 1} (${reason})`);
  }

  function registerEndedListener(): void {
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
        hooks.setStatus(pendingChapter ? "Preparing the next chapter..." : "Preparing the next part...");
      } else {
        log("last segment ended");
      }
    });
  }

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

  const regenerations = new WeakMap<Segment, Promise<boolean>>();
  // Voices of the regenerations in flight, with a count. A regeneration may still read a voice that no chapter or
  // generation uses any more, so `view().voicesInUse` includes these.
  const regeneratingVoices = new Map<string, number>();

  function markRegenerating(voiceId: string, change: 1 | -1): void {
    const count = (regeneratingVoices.get(voiceId) ?? 0) + change;
    if (count > 0) regeneratingVoices.set(voiceId, count);
    else regeneratingVoices.delete(voiceId);
    hooks.notifyChange();
  }

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
      hooks.setStatus("Preparing the audio again...");
      const startedAt = performance.now();
      markRegenerating(active.voiceId, 1);
      try {
        await workerClient.ensure(active.voiceId);
        const clips: Clip[] = [];
        const gaps: number[] = [];
        for (let i = segment.startSentence; i < segment.startSentence + segment.count; i += 1) {
          if (obsolete()) {
            log(`segment ${segmentIndex + 1} regeneration abandoned (superseded or cancelled)`);
            return false;
          }
          const sentence = active.sentences[i];
          if (!sentence) throw new Error(`Sentence ${i + 1} is missing.`);
          const { clip } = await workerClient.clip(sentence.text, active.voiceId);
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
        hooks.setStatus("Audio is ready again.");
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
        markRegenerating(active.voiceId, -1);
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
      mediaSession.setMetadata(chapterTitle(bookStore.opened.chapters[chapterIndex]));
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
        const { clip, genMs } = await workerClient.clip(sentence.text, generationVoiceId);
        throwIfCancelled();
        const gapMs = sentence.paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS;
        clips.push(clip);
        gaps.push(gapMs);
        seconds += clip.pcm.length / clip.sampleRate + gapMs / 1000;
        totalGenMs += genMs;
        next += 1;
        hooks.setStatus(describeProgress(next, sentences.length, loaded?.segments === segments));
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
    hooks.setStatus("Audio for this chapter is ready.");
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
    generationVoiceId = getVoiceId();
    // A preview in flight must not draw over this generation.
    previewToken += 1;
    previewed = undefined;
    hooks.notifyChange();
    audio.pause();
    try {
      await acquireWakeLock();
      await workerClient.ensure(generationVoiceId);
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
      hooks.refreshSaved();
    }
  }

  function generateChapter(chapterIndex: number, startSentence = 0, preparsed?: Sentence[]): Promise<void> {
    if (!bookStore.opened || generating || isLibraryBusy()) return Promise.resolve();
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
    if (!book || isVoicesBusy() || navigating) {
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
      }
      // Show the new text now, before the cancelled generation settles (a cancel only takes effect after the current
      // sentence). The old audio would stop anyway, and its text and highlight would not match the next audio. After a
      // cancel the old run can no longer load a segment, so unloading here is safe.
      hooks.showChapter(target.chapterIndex);
      if (loaded) unloadChapter();
      hooks.renderChapter(target.sentences);
      await activeGeneration;
      if (generating || book !== bookStore.opened) {
        showPlayingChapter();
        return;
      }
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
    if (!book || !chapter || isVoicesBusy() || navigating) {
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

  /**
   * The voice select changed. A chapter that plays with another voice restarts at the current sentence with the new
   * one (the same restart as a jump). When paused or idle nothing restarts: the next generation reads the new voice.
   */
  function applyVoiceChange(): void {
    if (!loaded || !wantPlaying || loaded.voiceId === getVoiceId()) return;
    log(`voice changed while playing: restarting at the current sentence with ${getVoiceId()}`);
    void jumpToSentence(Math.max(currentSentence, 0));
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

  // Bumped by every preview request and every generation start. A preview that finds a newer value drops its result.
  let previewToken = 0;
  // The chapter whose text the preview drew. Cleared when a generation starts.
  let previewed: { book: OpenBook; chapterIndex: number; sentences: Sentence[] } | undefined;

  /** True when nothing generates and no chapter is loaded. Only then may a preview draw. */
  function isIdle(): boolean {
    return !generating && !loaded;
  }

  async function previewChapter(index?: number): Promise<void> {
    const book = bookStore.opened;
    const token = ++previewToken;
    previewed = undefined;
    if (!book || !isIdle()) return;
    const stale = (): boolean => token !== previewToken || book !== bookStore.opened || !isIdle();
    try {
      let target: TextChapter | undefined;
      if (index === undefined) {
        target = await bookStore.findTextChapter(book, -1, 1);
      } else {
        target = { chapterIndex: index, sentences: await bookStore.chapterSentences(book, index) };
      }
      if (stale()) return;
      if (!target || target.sentences.length === 0) {
        hooks.clearText();
        return;
      }
      if (index === undefined) {
        hooks.showChapter(target.chapterIndex);
        hooks.notifyChange();
      }
      hooks.renderChapter(target.sentences);
      previewed = { book, chapterIndex: target.chapterIndex, sentences: target.sentences };
      log(`preview: chapter ${target.chapterIndex + 1}, ${target.sentences.length} sentences`);
    } catch (error) {
      log(`preview failed: ${errorName(error)}`);
    }
  }

  /** A tap on a sentence of the previewed chapter. Starts generation at that sentence. */
  function startFromPreview(sentenceIndex: number): void {
    const shown = previewed;
    if (!shown || shown.book !== bookStore.opened || !isIdle() || navigating || isVoicesBusy()) return;
    if (sentenceIndex < 0 || sentenceIndex >= shown.sentences.length) return;
    log(`preview: starting at sentence ${sentenceIndex + 1}`);
    void generateChapter(shown.chapterIndex, sentenceIndex, shown.sentences);
  }

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

  return {
    generateChapter,
    cancelGeneration,
    activeGeneration: () => activeGeneration,
    unloadChapter,
    navigateChapter,
    selectChapter,
    applyVoiceChange,
    previewChapter,
    clickSentence,
    hasLoaded: () => loaded !== undefined,
    persistPosition,
    watchForStuckPlayback,
    playFromMediaSession,
    pauseFromMediaSession,
    seekWithinSegment,
    applyPlaybackRate,
    view: (): PlaybackView => {
      const base = navigationBase();
      return {
        generating,
        navigating,
        wantPlaying,
        navigationBase: base,
        hasPrev: hasTextChapter(base, -1),
        hasNext: hasTextChapter(base, 1),
        voicesInUse: [
          ...new Set([
            ...(loaded ? [loaded.voiceId] : []),
            ...(generating ? [generationVoiceId] : []),
            ...regeneratingVoices.keys(),
          ]),
        ],
      };
    },
    registerPlayPauseListeners,
    registerTimeUpdateListener,
    registerEndedListener,
  };
}
