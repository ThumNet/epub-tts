import type { Sentence } from "./epub";
import { log, logText } from "./log";
import { loadPosition } from "./store";
import { DEFAULT_VOICE_ID, VOICES, findVoice } from "./voices";
import { createWorkerClient } from "./engine/worker-client";
import { createDiagnostics } from "./engine/diagnostics";
import { createSettings } from "./engine/settings";
import { createBook } from "./engine/book";
import { createVoicesStore } from "./engine/voices-store";
import { createLibrary } from "./engine/library";
import { createMediaSession } from "./engine/media-session";
import { createPlayback } from "./engine/playback";
import {
  SAVE_INTERVAL_MS,
  SEGMENT_TARGET_S as DEFAULT_SEGMENT_TARGET_S,
  segmentTargetSeconds,
} from "./engine/config";
import { clampSpeed, describePosition } from "./engine/pure";
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

// The open book and its per-chapter has-text flags. Chapter text reading lives here too.
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
// Playback speed and voice id. The speed is reapplied after every audio.src change.
const settings = createSettings({ audio });
// Voice download, removal and storage status. `generating` is read through a getter.
const voices = createVoicesStore({
  hooks,
  getVoiceId: () => selectedVoiceId(),
  isGenerating: () => playback.view().generating,
  persistSettings: () => settings.persist(),
});
// Pick, remember, restore and forget a book. Owns the book token, remembered and busy flags.
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

// Created eagerly here, at the same point in the boot order as the old `let worker = createWorker()`.
const workerClient = createWorkerClient({
  setStatus: (text) => hooks.setStatus(text),
  onReady: () => {
    void voices.refresh();
  },
});

// The playback core: segments, generation pipeline, watchdog, navigation. It registers no listeners
// at creation. The register* calls below sit at the positions of the old listener registrations.
const playback = createPlayback({
  audio,
  hooks,
  workerClient,
  settings,
  getVoiceId: () => selectedVoiceId(),
  isVoicesBusy: () => voices.busy,
  isLibraryBusy: () => library.busy,
  bookStore,
  mediaSession,
  segmentTargetS: SEGMENT_TARGET_S,
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

setInterval(() => {
  if (!audio.paused) playback.persistPosition("interval");
}, SAVE_INTERVAL_MS);

diagnostics.startHeartbeat();

refreshSavedUi();

// ---------------------------------------------------------------- page lifecycle logging

document.addEventListener("visibilitychange", () => {
  log(
    `visibilitychange: ${document.visibilityState} (audio ${audio.paused ? "paused" : "playing"} at ${audio.currentTime.toFixed(1)} s, ` +
      `readyState=${audio.readyState} networkState=${audio.networkState})`,
  );
  if (document.visibilityState === "hidden") playback.persistPosition("hidden");
  else if (document.visibilityState === "visible" && !audio.paused) playback.watchForStuckPlayback("visible", false);
});
window.addEventListener("pagehide", (event) => {
  log(`pagehide persisted=${event.persisted}`);
  playback.persistPosition("pagehide");
});
window.addEventListener("pageshow", (event) => log(`pageshow persisted=${event.persisted}`));
document.addEventListener("freeze", () => log("freeze"));
document.addEventListener("resume", () => log("resume (page lifecycle)"));

diagnostics.logAudioEvents();

// ---------------------------------------------------------------- audio session

diagnostics.setupAudioSession();

// ---------------------------------------------------------------- stuck playback recovery

playback.registerPlayPauseListeners();

// ---------------------------------------------------------------- media session

mediaSession.setup();

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

playback.registerTimeUpdateListener();

textElement.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !playback.hasLoaded()) return;
  const index = Number(target.dataset["index"]);
  if (!Number.isInteger(index)) return;
  playback.clickSentence(index);
});

// ---------------------------------------------------------------- segment switching

playback.registerEndedListener();

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
  playback.applyPlaybackRate();
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
  mediaSession.resetPositionState();
  mediaSession.updatePositionState();
});

// (voice state variables are declared with the other state at the top)

function updateControls(): void {
  const view = playback.view();
  const locked = view.generating || voices.busy || library.busy;
  generateButton.disabled = locked || !bookStore.opened;
  cancelButton.disabled = !view.generating;
  const saved = loadPosition();
  resumeButton.disabled = locked || !saved || bookStore.opened?.id !== saved.bookId;
  voiceSelect.disabled = locked;
  forgetButton.hidden = !library.remembered;
  forgetButton.disabled = locked || library.busy || view.navigating || !audio.paused;
  fileInput.disabled = library.busy;
  prevChapterButton.disabled = voices.busy || library.busy || view.navigating || !view.hasPrev;
  nextChapterButton.disabled = voices.busy || library.busy || view.navigating || !view.hasNext;
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
  playback.applyPlaybackRate();
  showSpeed();
  settings.persist();
  log(`settings: voice=${voiceId} speed=${settings.speed.toFixed(2)}x`);
  hooks.notifyChange();
  void voices.refresh();
}
initSettings();

// ---------------------------------------------------------------- UI wiring

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
  const view = playback.view();
  if (view.generating || view.navigating) void playback.selectChapter(hooks.getSelectedChapter());
  else hooks.notifyChange();
});
prevChapterButton.addEventListener("click", () => void playback.navigateChapter(-1, "button"));
nextChapterButton.addEventListener("click", () => void playback.navigateChapter(1, "button"));

generateButton.addEventListener("click", () => {
  if (voices.busy) return;
  void playback.generateChapter(hooks.getSelectedChapter());
});

cancelButton.addEventListener("click", () => playback.cancelGeneration());

resumeButton.addEventListener("click", () => {
  const saved = loadPosition();
  if (!saved || bookStore.opened?.id !== saved.bookId || voices.busy) return;
  hooks.showChapter(saved.chapterIndex);
  log(`resuming at sentence ${saved.sentenceIndex + 1} with voice ${selectedVoiceId()}: generating from that sentence`);
  void playback.generateChapter(saved.chapterIndex, saved.sentenceIndex);
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
