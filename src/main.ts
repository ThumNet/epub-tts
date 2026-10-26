import { log } from "./log";
import { createWorkerClient } from "./engine/worker-client";
import { createDiagnostics } from "./engine/diagnostics";
import { createSettings } from "./engine/settings";
import { createBook } from "./engine/book";
import { createVoicesStore } from "./engine/voices-store";
import { createLibrary } from "./engine/library";
import { createMediaSession } from "./engine/media-session";
import { createPlayback } from "./engine/playback";
import { SEGMENT_TARGET_S as DEFAULT_SEGMENT_TARGET_S, segmentTargetSeconds } from "./engine/config";
import { createShell } from "./ui/shell";

/** Target audio length of one segment. A segment closes once clips and gaps reach this. */
// The e2e check stays here so the build-time define removes the override code from production bundles.
const SEGMENT_TARGET_S = import.meta.env.VITE_E2E
  ? segmentTargetSeconds(location.search, true)
  : DEFAULT_SEGMENT_TARGET_S;

// Boot order. Each step sits where the old single-file script ran it. Do not reorder.

// 1. DOM refs and hooks, diagnostics, isolation worker, log lines, stale marker.
const shell = createShell();
const { audio, hooks } = shell;
const diagnostics = createDiagnostics({ audio, getVisibility: () => document.visibilityState });
shell.logEnvironment();
diagnostics.reportStaleMarker();

// 2. Engine modules. Created before any listener. The shell reads them through `bind`.
const bookStore = createBook({ hooks });
const mediaSession = createMediaSession({
  audio,
  getBookTitle: () => bookStore.opened?.title,
  actions: {
    play: () => playback.playFromMediaSession(),
    pause: () => playback.pauseFromMediaSession(),
    seek: (seconds) => playback.seekWithinSegment(seconds),
    navigate: (step) => void playback.navigateChapter(step, "media session"),
  },
});
const settings = createSettings({ audio });
const voices = createVoicesStore({
  hooks,
  getVoiceId: () => settings.voiceId,
  isGenerating: () => playback.view().generating,
  persistSettings: () => settings.persist(),
});
const library = createLibrary({
  hooks,
  bookStore,
  isGenerating: () => playback.view().generating,
  cancelGeneration: () => playback.cancelGeneration(),
  activeGeneration: () => playback.activeGeneration(),
  unloadChapter: () => playback.unloadChapter(),
  isNavigating: () => playback.view().navigating,
  isPaused: () => audio.paused,
  voicesBusy: () => voices.busy,
});
const workerClient = createWorkerClient({
  setStatus: (text) => hooks.setStatus(text),
  onReady: () => {
    void voices.refresh();
  },
});
const playback = createPlayback({
  audio,
  hooks,
  workerClient,
  settings,
  getVoiceId: () => settings.voiceId,
  isVoicesBusy: () => voices.busy,
  isLibraryBusy: () => library.busy,
  bookStore,
  mediaSession,
  segmentTargetS: SEGMENT_TARGET_S,
});
shell.bind({ bookStore, mediaSession, settings, voices, library, playback });

// 3. Saved position, timers, listeners, settings.
shell.startPersistTimer();
diagnostics.startHeartbeat();
shell.refreshSavedUi();
shell.registerLifecycleListeners();
diagnostics.logAudioEvents();
diagnostics.setupAudioSession();
playback.registerPlayPauseListeners();
mediaSession.setup();
playback.registerTimeUpdateListener();
shell.registerTextClickListener();
playback.registerEndedListener();
shell.registerSettingsListeners();
shell.initSettings();
shell.registerControlListeners();

// 4. Restore the remembered book.
void library.restore();

log("ready");
