import { describe, expect, it, vi } from "vitest";
import type { OpenBook } from "../../src/epub";
import type { BookStore } from "../../src/engine/book";
import type { EngineHooks } from "../../src/engine/hooks";
import type { MediaSessionController } from "../../src/engine/media-session";
import type { WorkerClient } from "../../src/engine/worker-client";

vi.mock("../../src/log", () => ({ log: vi.fn(), logText: () => "" }));
vi.mock("../../src/store", () => ({ savePosition: vi.fn(), setGenerationMarker: vi.fn() }));
vi.mock("../../src/e2e-worker", () => ({ createMockWorker: vi.fn() }));

import { createPlayback } from "../../src/engine/playback";

function setup(selected = 4) {
  const hooks = {
    notifyChange: vi.fn(),
    setStatus: vi.fn(),
    showChapter: vi.fn(),
    renderChapter: vi.fn(),
    highlight: vi.fn(),
    clearText: vi.fn(),
    getSelectedChapter: vi.fn(() => selected),
    setBookInfo: vi.fn(),
    appendBookInfo: vi.fn(),
    fillChapters: vi.fn(),
    clearChapters: vi.fn(),
    refreshSaved: vi.fn(),
  } satisfies EngineHooks;
  const workerClient = { ensure: vi.fn(), clip: vi.fn(), cancel: vi.fn(() => false) } satisfies WorkerClient;
  const bookStore: BookStore = {
    opened: undefined,
    hasText: [],
    open: vi.fn(),
    clear: vi.fn(),
    chapterSentences: vi.fn(),
    findTextChapter: vi.fn(),
    scanChapters: vi.fn(),
  };
  const mediaSession: MediaSessionController = {
    setup: vi.fn(),
    updatePositionState: vi.fn(),
    resetPositionState: vi.fn(),
    setMetadata: vi.fn(),
    setPlaybackState: vi.fn(),
  };
  const audio = { pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn() };
  const playback = createPlayback({
    // The factory only calls the members faked above on an idle engine.
    audio: audio as unknown as HTMLAudioElement,
    hooks,
    workerClient,
    settings: { applyPlaybackRate: vi.fn() },
    getVoiceId: () => "voice",
    isVoicesBusy: () => false,
    isLibraryBusy: () => false,
    bookStore,
    mediaSession,
    segmentTargetS: 60,
  });
  return { playback, hooks, workerClient, audio, bookStore };
}

const SENTENCES = [
  { text: "One.", paragraphEnd: false },
  { text: "Two.", paragraphEnd: true },
];

function openBook(bookStore: BookStore): OpenBook {
  const book = { id: "b", chapters: [{ index: 0, label: "A" }, { index: 1, label: "B" }] } as unknown as OpenBook;
  Object.assign(bookStore, { opened: book });
  return book;
}

describe("previewChapter", () => {
  it("renders the sentences of the chapter without audio or highlight", async () => {
    const { playback, hooks, audio, bookStore } = setup();
    const book = openBook(bookStore);
    vi.mocked(bookStore.chapterSentences).mockResolvedValue(SENTENCES);
    await playback.previewChapter(1);
    expect(bookStore.chapterSentences).toHaveBeenCalledWith(book, 1);
    expect(hooks.renderChapter).toHaveBeenCalledWith(SENTENCES);
    expect(hooks.highlight).not.toHaveBeenCalled();
    expect(audio.pause).not.toHaveBeenCalled();
  });

  it("without an index shows the first chapter with text and selects it", async () => {
    const { playback, hooks, bookStore } = setup();
    openBook(bookStore);
    vi.mocked(bookStore.findTextChapter).mockResolvedValue({ chapterIndex: 1, sentences: SENTENCES });
    await playback.previewChapter();
    expect(bookStore.findTextChapter).toHaveBeenCalledWith(bookStore.opened, -1, 1);
    expect(hooks.showChapter).toHaveBeenCalledWith(1);
    expect(hooks.renderChapter).toHaveBeenCalledWith(SENTENCES);
  });

  it("clears the text for a chapter without sentences", async () => {
    const { playback, hooks, bookStore } = setup();
    openBook(bookStore);
    vi.mocked(bookStore.chapterSentences).mockResolvedValue([]);
    await playback.previewChapter(0);
    expect(hooks.clearText).toHaveBeenCalledTimes(1);
    expect(hooks.renderChapter).not.toHaveBeenCalled();
  });

  it("does nothing without an open book", async () => {
    const { playback, hooks, bookStore } = setup();
    await playback.previewChapter(0);
    expect(bookStore.chapterSentences).not.toHaveBeenCalled();
    expect(hooks.renderChapter).not.toHaveBeenCalled();
  });

  it("drops the result of an older call", async () => {
    const { playback, hooks, bookStore } = setup();
    openBook(bookStore);
    let resolveFirst: (value: typeof SENTENCES) => void = () => undefined;
    const first = new Promise<typeof SENTENCES>((resolve) => {
      resolveFirst = resolve;
    });
    const second = [{ text: "Later.", paragraphEnd: true }];
    vi.mocked(bookStore.chapterSentences).mockReturnValueOnce(first).mockResolvedValueOnce(second);
    const older = playback.previewChapter(0);
    await playback.previewChapter(1);
    resolveFirst(SENTENCES);
    await older;
    expect(hooks.renderChapter).toHaveBeenCalledTimes(1);
    expect(hooks.renderChapter).toHaveBeenCalledWith(second);
  });

  it("keeps the text while a generation runs, and drops a preview that a generation overtook", async () => {
    vi.stubGlobal("navigator", {});
    try {
      const { playback, hooks, workerClient, bookStore } = setup();
      openBook(bookStore);
      let resolveText: (value: typeof SENTENCES) => void = () => undefined;
      vi.mocked(bookStore.chapterSentences).mockReturnValueOnce(
        new Promise<typeof SENTENCES>((resolve) => {
          resolveText = resolve;
        }),
      );
      const pending = playback.previewChapter(1);
      // The generation waits for the worker forever, so it stays "generating".
      vi.mocked(workerClient.ensure).mockReturnValue(new Promise(() => undefined));
      void playback.generateChapter(0);
      expect(playback.view().generating).toBe(true);
      resolveText(SENTENCES);
      await pending;
      await playback.previewChapter(1);
      expect(hooks.renderChapter).not.toHaveBeenCalled();
      expect(bookStore.chapterSentences).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a tap on a sentence of the previewed chapter starts generation there", async () => {
    vi.stubGlobal("navigator", {});
    try {
      const { playback, workerClient, bookStore } = setup();
      openBook(bookStore);
      vi.mocked(bookStore.chapterSentences).mockResolvedValue(SENTENCES);
      vi.mocked(workerClient.ensure).mockReturnValue(new Promise(() => undefined));
      await playback.previewChapter(1);
      playback.clickSentence(1);
      expect(playback.view().generating).toBe(true);
      expect(playback.view().navigationBase).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a tap does nothing when no chapter is previewed", () => {
    const { playback, bookStore } = setup();
    openBook(bookStore);
    playback.clickSentence(0);
    expect(playback.view().generating).toBe(false);
  });
});

describe("createPlayback on an idle engine", () => {
  it("registers no listeners at creation", () => {
    const { audio } = setup();
    expect(audio.addEventListener).not.toHaveBeenCalled();
  });

  it("view falls back to the selected chapter and reports no neighbours without a book", () => {
    const { playback } = setup(4);
    expect(playback.view()).toEqual({
      generating: false,
      navigating: false,
      wantPlaying: false,
      navigationBase: 4,
      hasPrev: false,
      hasNext: false,
    });
    expect(playback.hasLoaded()).toBe(false);
  });

  it("view.wantPlaying follows the play event and pauseFromMediaSession", () => {
    const { playback, audio } = setup();
    playback.registerPlayPauseListeners();
    const play = audio.addEventListener.mock.calls.find(([name]) => name === "play")?.[1] as () => void;
    expect(playback.view().wantPlaying).toBe(false);
    play();
    expect(playback.view().wantPlaying).toBe(true);
    playback.pauseFromMediaSession();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(playback.view().wantPlaying).toBe(false);
  });

  it("pauseFromMediaSession notifies, because pausing already-paused audio fires no pause event", () => {
    const { playback, hooks, audio } = setup();
    playback.pauseFromMediaSession();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(hooks.notifyChange).toHaveBeenCalledTimes(1);
    expect(playback.view().wantPlaying).toBe(false);
  });

  it("playFromMediaSession sets wantPlaying and notifies", () => {
    vi.useFakeTimers();
    try {
      const { playback, hooks, audio } = setup();
      Object.assign(audio, { play: vi.fn(() => Promise.resolve()), currentTime: 0 });
      playback.playFromMediaSession();
      expect(hooks.notifyChange).toHaveBeenCalledTimes(1);
      expect(playback.view().wantPlaying).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unloadChapter with nothing loaded does nothing", () => {
    const { playback, hooks, audio } = setup();
    playback.unloadChapter();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(hooks.clearText).not.toHaveBeenCalled();
  });

  it("cancelGeneration posts one worker cancel per call", () => {
    const { playback, workerClient } = setup();
    playback.cancelGeneration();
    expect(workerClient.cancel).toHaveBeenCalledTimes(1);
  });

  it("generateChapter without an open book resolves and starts nothing", async () => {
    const { playback, hooks } = setup();
    await playback.generateChapter(0);
    expect(hooks.notifyChange).not.toHaveBeenCalled();
  });
});
