import { describe, expect, it, vi } from "vitest";
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
  return { playback, hooks, workerClient, audio };
}

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
