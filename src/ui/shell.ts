import type { Sentence } from "../epub";
import { log, logText } from "../log";
import { loadPosition } from "../store";
import { DEFAULT_VOICE_ID, VOICES, findVoice } from "../voices";
import { SAVE_INTERVAL_MS, SPEED_MAX, SPEED_MIN } from "../engine/config";
import { describePosition, stepSpeed } from "../engine/pure";
import type { EngineHooks } from "../engine/hooks";
import type { BookStore } from "../engine/book";
import type { Library } from "../engine/library";
import type { MediaSessionController } from "../engine/media-session";
import type { Playback } from "../engine/playback";
import type { Settings } from "../engine/settings";
import type { VoicesStore } from "../engine/voices-store";

/** The engine modules the shell reads. They are created after the shell, so `bind` supplies them. */
export interface ShellEngine {
  bookStore: BookStore;
  mediaSession: MediaSessionController;
  settings: Settings;
  voices: VoicesStore;
  library: Library;
  playback: Playback;
}

/**
 * The UI shell. `createShell` collects the DOM elements and builds the hooks. The phase methods hold the
 * DOM code of the old boot sequence. `main.ts` calls them in the original order.
 */
export interface Shell {
  audio: HTMLAudioElement;
  hooks: EngineHooks;
  bind(engine: ShellEngine): void;
  /** Isolation worker, environment log lines. */
  logEnvironment(): void;
  /** Persist interval. */
  startPersistTimer(): void;
  refreshSavedUi(): void;
  registerLifecycleListeners(): void;
  registerTextClickListener(): void;
  /** Speed, audio `ratechange` and voice listeners. */
  registerSettingsListeners(): void;
  initSettings(): void;
  /** File, audio play/pause, forget, chapter, generate, cancel, resume and copy-log listeners. */
  registerControlListeners(): void;
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing element #${id}`);
  return element;
}

export function createShell(): Shell {
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
  const speedDownButton = byId("speed-down", HTMLButtonElement);
  const speedUpButton = byId("speed-up", HTMLButtonElement);
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

  let boundEngine: ShellEngine | undefined;
  function engine(): ShellEngine {
    if (!boundEngine) throw new Error("Shell used before bind()");
    return boundEngine;
  }

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

  function logEnvironment(): void {
    injectIsolationWorker();

    log(`user agent: ${navigator.userAgent}`);
    log(
      `ios=${isIos} crossOriginIsolated=${window.crossOriginIsolated} cores=${navigator.hardwareConcurrency} ` +
        `standalone=${window.matchMedia("(display-mode: standalone)").matches}`,
    );
  }

  // ---------------------------------------------------------------- saved position

  function refreshSavedUi(): void {
    const { bookStore } = engine();
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

  function startPersistTimer(): void {
    const { playback } = engine();
    setInterval(() => {
      if (!audio.paused) playback.persistPosition("interval");
    }, SAVE_INTERVAL_MS);
  }

  // ---------------------------------------------------------------- page lifecycle logging

  function registerLifecycleListeners(): void {
    const { playback } = engine();
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

  function registerTextClickListener(): void {
    const { playback } = engine();
    textElement.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !playback.hasLoaded()) return;
      const index = Number(target.dataset["index"]);
      if (!Number.isInteger(index)) return;
      playback.clickSentence(index);
    });
  }

  // ---------------------------------------------------------------- voice and speed settings

  function selectedVoiceId(): string {
    return engine().settings.voiceId;
  }

  function showSpeed(): void {
    const { settings } = engine();
    speedLabel.textContent = `${settings.speed.toFixed(2)}x`;
    speedDownButton.disabled = settings.speed <= SPEED_MIN;
    speedUpButton.disabled = settings.speed >= SPEED_MAX;
  }

  function setSpeed(value: number, reason: string): void {
    const { settings, playback } = engine();
    settings.setSpeed(value);
    playback.applyPlaybackRate();
    showSpeed();
    settings.persist();
    log(`speed set to ${settings.speed.toFixed(2)}x (${reason}), playbackRate=${audio.playbackRate}`);
  }

  function updateControls(): void {
    const { playback, voices, library, bookStore } = engine();
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

  function registerSettingsListeners(): void {
    const { settings, mediaSession, voices } = engine();
    speedDownButton.addEventListener("click", () => setSpeed(stepSpeed(settings.speed, -1), "slower"));
    speedUpButton.addEventListener("click", () => setSpeed(stepSpeed(settings.speed, 1), "faster"));
    speedResetButton.addEventListener("click", () => setSpeed(1, "reset"));
    audio.addEventListener("ratechange", () => {
      mediaSession.resetPositionState();
      mediaSession.updatePositionState();
    });

    voiceSelect.addEventListener("change", () => {
      settings.setVoiceId(voiceSelect.value);
      voices.select();
    });

    voiceDownloadButton.addEventListener("click", () => voices.startDownload());

    voiceRemoveButton.addEventListener("click", () => voices.startRemove());
  }

  function initSettings(): void {
    const { settings, playback, voices } = engine();
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

  // ---------------------------------------------------------------- UI wiring

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

  function registerControlListeners(): void {
    const { library, playback, voices, bookStore } = engine();
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
  }

  return {
    audio,
    hooks,
    bind: (bound) => {
      boundEngine = bound;
    },
    logEnvironment,
    startPersistTimer,
    refreshSavedUi,
    registerLifecycleListeners,
    registerTextClickListener,
    registerSettingsListeners,
    initSettings,
    registerControlListeners,
  };
}
