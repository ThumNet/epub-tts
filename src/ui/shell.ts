import type { ChapterInfo, Sentence } from "../epub";
import { log, logText } from "../log";
import { loadPosition } from "../store";
import { DEFAULT_VOICE_ID, VOICES } from "../voices";
import { SAVE_INTERVAL_MS } from "../engine/config";
import { stepSpeed } from "../engine/pure";
import { chapterSelectState, createUiState, filledChapterSelectState } from "./state";
import { chapterNameText, deriveView, statusText, type ControlsView, type Snapshot } from "./view";
import { initSheets, type Sheets } from "./sheets";
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
  const primaryButton = byId("primary", HTMLButtonElement);
  const primaryLabel = byId("primary-label", HTMLSpanElement);
  const listenStartButton = byId("listen-start", HTMLButtonElement);
  const copyLogButton = byId("copy-log", HTMLButtonElement);
  const copyStatus = byId("copy-status", HTMLSpanElement);
  const versionElement = byId("app-version", HTMLElement);
  const VERSION_LABEL = `epub-tts v${__APP_VERSION__} (${__BUILD_ID__})`;
  versionElement.textContent = VERSION_LABEL;
  const statsElement = byId("stats", HTMLDivElement);
  const savedElement = byId("saved", HTMLDivElement);
  const textElement = byId("text", HTMLDivElement);
  const titleElement = byId("title", HTMLDivElement);
  const chapterNameElement = byId("chapter-name", HTMLDivElement);
  const audio = byId("audio", HTMLAudioElement);

  const ui = createUiState();

  let boundEngine: ShellEngine | undefined;
  function engine(): ShellEngine {
    if (!boundEngine) throw new Error("Shell used before bind()");
    return boundEngine;
  }

  let renderedChapters: ReadonlyArray<ChapterInfo> | undefined;
  // All state-driven DOM writes live in the draw sections below. Each hook calls only the sections it drew before,
  // because a wider draw would show engine state at moments when the old code left the element alone.

  function drawTexts(): void {
    statsElement.textContent = statusText(ui.status);
    bookInfo.textContent = ui.bookInfo;
    copyStatus.textContent = ui.copyStatus;
  }

  /** Options first, then the value. Rebuild the options only when the array changes, to keep focus and an open picker. */
  function drawChapters(): void {
    if (renderedChapters !== ui.chapters) {
      chapterSelect.replaceChildren(...ui.chapters.map((c) => new Option(c.label, String(c.index))));
      renderedChapters = ui.chapters;
    }
    chapterSelect.disabled = !ui.chaptersEnabled;
    chapterSelect.value = ui.chapterValue;
    chapterNameElement.textContent = chapterNameText(ui.chapters, ui.selectedChapter);
  }

  /** The saved text includes the age of the save, so only `refreshSavedUi` and a 30 s timer draw it. */
  function renderSaved(): void {
    savedElement.textContent = deriveView(snapshot()).savedText;
  }

  function drawSettings(view: ControlsView): void {
    voiceSelect.value = view.voiceValue;
    speedLabel.textContent = view.speedLabel;
    speedDownButton.disabled = view.speedDownDisabled;
    speedUpButton.disabled = view.speedUpDisabled;
  }

  function drawControls(view: ControlsView): void {
    primaryButton.dataset["state"] = view.primary.state;
    primaryButton.disabled = view.primary.disabled;
    primaryLabel.textContent = view.primary.label;
    listenStartButton.hidden = view.secondaryHidden;
    listenStartButton.disabled = view.secondaryDisabled;
    savedElement.hidden = view.savedHidden;
    voiceSelect.disabled = view.voiceSelectDisabled;
    forgetButton.hidden = view.forgetHidden;
    forgetButton.disabled = view.forgetDisabled;
    fileInput.disabled = view.fileInputDisabled;
    prevChapterButton.disabled = view.prevDisabled;
    nextChapterButton.disabled = view.nextDisabled;
    voiceDownloadButton.disabled = view.voiceDownloadDisabled;
    voiceRemoveButton.disabled = view.voiceRemoveDisabled;
    voiceStatus.textContent = view.voiceStatusText;
    titleElement.textContent = view.titleText;
    document.body.dataset["book"] = view.welcomeVisible ? "none" : "open";
    // Closing is a reaction to state. Render never opens a sheet. A Book sheet reopened during a pending Forget must not stay over the welcome.
    if (view.welcomeVisible) sheets?.close("sheet-book");
  }

  /** What `notifyChange` draws: the controls, then the settings view. Before `bind` there is no engine to read. */
  function render(): void {
    if (!boundEngine) return;
    const view = deriveView(snapshot());
    drawControls(view);
    drawSettings(view);
  }

  // Engine-side DOM access goes through these synchronous hooks. Function declarations below are hoisted.
  const hooks: EngineHooks = {
    notifyChange: () => render(),
    setStatus: (text) => {
      ui.status = text;
      drawTexts();
    },
    showChapter: (index) => {
      const next = chapterSelectState(ui.chapters, index);
      ui.chapterValue = next.value;
      ui.selectedChapter = next.selected;
      drawChapters();
    },
    renderChapter: (sentences) => renderText(sentences),
    highlight: (index) => {
      textElement.querySelector(".current")?.classList.remove("current");
      const span = textElement.querySelector(`span[data-index="${index}"]`);
      if (span) {
        span.classList.add("current");
        span.scrollIntoView({ block: "center" });
      }
    },
    clearText: () => {
      textElement.replaceChildren();
    },
    getSelectedChapter: () => ui.selectedChapter,
    setBookInfo: (text) => {
      ui.bookInfo = text;
      drawTexts();
    },
    appendBookInfo: (text) => {
      ui.bookInfo += text;
      drawTexts();
    },
    fillChapters: (chapters) => {
      ui.chapters = chapters;
      ui.chaptersEnabled = true;
      const next = filledChapterSelectState(chapters);
      ui.chapterValue = next.value;
      ui.selectedChapter = next.selected;
      drawChapters();
    },
    clearChapters: () => {
      ui.chapters = [];
      ui.chaptersEnabled = false;
      ui.chapterValue = "";
      ui.selectedChapter = 0;
      drawChapters();
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

  /** Reads the live engine and browser values at call time. Nothing is cached. */
  function snapshot(): Snapshot {
    const { playback, voices, library, bookStore, settings } = engine();
    const opened = bookStore.opened;
    return {
      playback: playback.view(),
      voices: { busy: voices.busy, stored: voices.stored, message: voices.message, error: voices.error },
      library: { busy: library.busy, remembered: library.remembered },
      book: opened ? { id: opened.id, title: opened.title } : undefined,
      settings: { voiceId: settings.voiceId, speed: settings.speed },
      saved: loadPosition(),
      loaded: playback.hasLoaded(),
      paused: audio.paused,
      now: Date.now(),
    };
  }

  // ---------------------------------------------------------------- saved position

  function refreshSavedUi(): void {
    renderSaved();
    render();
  }

  function startPersistTimer(): void {
    const { playback } = engine();
    setInterval(() => {
      if (!audio.paused) playback.persistPosition("interval");
    }, SAVE_INTERVAL_MS);
    setInterval(() => {
      if (!savedElement.hidden) renderSaved();
    }, 30_000);
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
      if (!(target instanceof HTMLElement)) return;
      const index = Number(target.dataset["index"]);
      if (!Number.isInteger(index)) return;
      playback.clickSentence(index);
    });
  }

  // ---------------------------------------------------------------- voice and speed settings

  function selectedVoiceId(): string {
    return engine().settings.voiceId;
  }

  function setSpeed(value: number, reason: string): void {
    const { settings, playback } = engine();
    settings.setSpeed(value);
    playback.applyPlaybackRate();
    drawSettings(deriveView(snapshot()));
    settings.persist();
    log(`speed set to ${settings.speed.toFixed(2)}x (${reason}), playbackRate=${audio.playbackRate}`);
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
    playback.applyPlaybackRate();
    drawSettings(deriveView(snapshot()));
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
  let sheets: Sheets | undefined;
  function showCopyStatus(message: string): void {
    ui.copyStatus = message;
    drawTexts();
    window.clearTimeout(copyStatusTimer);
    copyStatusTimer = window.setTimeout(() => {
      ui.copyStatus = "";
      drawTexts();
    }, 2000);
  }

  function registerControlListeners(): void {
    const { library, playback, voices, bookStore } = engine();
    sheets = initSheets();
    const sheetControl = sheets;
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      // Clear the input so picking the same file again fires a new change event. The File object stays valid.
      fileInput.value = "";
      if (file) sheetControl.close("sheet-book");
      library.pick(file);
    });

    audio.addEventListener("play", () => hooks.notifyChange());
    audio.addEventListener("pause", () => hooks.notifyChange());

    forgetButton.addEventListener("click", () => {
      sheetControl.close("sheet-book");
      library.forget();
    });

    chapterSelect.addEventListener("change", () => {
      // The user pick is now state, so the next render writes back the same value.
      ui.chapterValue = chapterSelect.value;
      ui.selectedChapter = Number(chapterSelect.value);
      drawChapters();
      // While generating, a picked chapter behaves like Previous/Next. While idle it shows the chapter text without audio.
      const view = playback.view();
      if (view.generating || view.navigating) void playback.selectChapter(hooks.getSelectedChapter());
      else {
        hooks.notifyChange();
        void playback.previewChapter(hooks.getSelectedChapter());
      }
    });
    prevChapterButton.addEventListener("click", () => void playback.navigateChapter(-1, "button"));
    nextChapterButton.addEventListener("click", () => void playback.navigateChapter(1, "button"));

    function generateFromStart(): void {
      if (voices.busy) return;
      void playback.generateChapter(hooks.getSelectedChapter());
    }

    function resumeSaved(): void {
      const saved = loadPosition();
      if (!saved || bookStore.opened?.id !== saved.bookId || voices.busy) return;
      hooks.showChapter(saved.chapterIndex);
      log(`resuming at sentence ${saved.sentenceIndex + 1} with voice ${selectedVoiceId()}: generating from that sentence`);
      void playback.generateChapter(saved.chapterIndex, saved.sentenceIndex);
    }

    primaryButton.addEventListener("click", () => {
      switch (deriveView(snapshot()).primary.state) {
        case "stop":
          playback.cancelGeneration();
          break;
        case "pause":
          playback.pauseFromMediaSession();
          break;
        case "play":
          playback.playFromMediaSession();
          break;
        case "resume":
          resumeSaved();
          break;
        case "listen":
          generateFromStart();
          break;
        case "open":
          fileInput.click();
          break;
      }
    });

    listenStartButton.addEventListener("click", generateFromStart);

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
