import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEEK_STEP_S } from "../../src/engine/config";
import { createMediaSession } from "../../src/engine/media-session";
import { log } from "../../src/log";

vi.mock("../../src/log", () => ({ log: vi.fn() }));

type Handler = (details: { seekTime?: number; seekOffset?: number }) => void;

interface FakeSession {
  handlers: Array<[string, Handler]>;
  throwFor: Set<string>;
  setActionHandler(action: string, handler: Handler): void;
  setPositionState: ReturnType<typeof vi.fn>;
  metadata: unknown;
  playbackState: string;
}

class FakeMetadata {
  constructor(public readonly init: unknown) {}
}

function fakeAudio() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    currentTime: 10,
    duration: 100,
    playbackRate: 1.5,
    addEventListener(type: string, fn: () => void): void {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatch(type: string): void {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

let session: FakeSession;

function make(title: string | undefined = "Book") {
  const audio = fakeAudio();
  const actions = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), navigate: vi.fn() };
  let bookTitle: string | undefined = title;
  const controller = createMediaSession({
    // The fake implements only the members the factory uses.
    audio: audio as unknown as HTMLAudioElement,
    getBookTitle: () => bookTitle,
    actions,
  });
  return {
    audio,
    actions,
    controller,
    setTitle: (t: string | undefined): void => {
      bookTitle = t;
    },
  };
}

function handler(name: string): Handler {
  const found = session.handlers.find(([n]) => n === name);
  if (!found) throw new Error(`no handler ${name}`);
  return found[1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.mocked(log).mockClear();
  session = {
    handlers: [],
    throwFor: new Set(),
    setActionHandler(action, fn) {
      if (this.throwFor.has(action)) throw new Error("unsupported");
      this.handlers.push([action, fn]);
    },
    setPositionState: vi.fn(),
    metadata: null,
    playbackState: "none",
  };
  vi.stubGlobal("navigator", { mediaSession: session });
  vi.stubGlobal("MediaMetadata", FakeMetadata);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("setup", () => {
  it("registers the 7 actions in order without registering anything in the factory", () => {
    const { controller } = make();
    expect(session.handlers).toEqual([]);
    controller.setup();
    expect(session.handlers.map(([n]) => n)).toEqual([
      "play",
      "pause",
      "seekto",
      "seekbackward",
      "seekforward",
      "previoustrack",
      "nexttrack",
    ]);
  });

  it("logs then calls play and pause", () => {
    const { controller, actions } = make();
    controller.setup();
    handler("play")({});
    expect(vi.mocked(log).mock.calls).toEqual([["media session action: play"]]);
    expect(actions.play).toHaveBeenCalledTimes(1);
    handler("pause")({});
    expect(vi.mocked(log).mock.calls[1]).toEqual(["media session action: pause"]);
    expect(actions.pause).toHaveBeenCalledTimes(1);
  });

  it("seekto seeks only when seekTime is given", () => {
    const { controller, actions } = make();
    controller.setup();
    handler("seekto")({ seekTime: 42 });
    expect(actions.seek).toHaveBeenCalledWith(42);
    handler("seekto")({});
    expect(actions.seek).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log).mock.calls).toEqual([["media session action: seekto"], ["media session action: seekto"]]);
  });

  it("seekbackward and seekforward use seekOffset or the default step", () => {
    const { controller, actions, audio } = make();
    controller.setup();
    audio.currentTime = 50;
    handler("seekbackward")({ seekOffset: 5 });
    handler("seekbackward")({});
    handler("seekforward")({ seekOffset: 5 });
    handler("seekforward")({});
    expect(actions.seek.mock.calls).toEqual([[45], [50 - SEEK_STEP_S], [55], [50 + SEEK_STEP_S]]);
  });

  it("previoustrack and nexttrack navigate", () => {
    const { controller, actions } = make();
    controller.setup();
    handler("previoustrack")({});
    handler("nexttrack")({});
    expect(actions.navigate.mock.calls).toEqual([[-1], [1]]);
    expect(vi.mocked(log).mock.calls).toEqual([
      ["media session action: previoustrack"],
      ["media session action: nexttrack"],
    ]);
  });

  it("logs unsupported actions and continues", () => {
    session.throwFor.add("seekto");
    const { controller } = make();
    controller.setup();
    expect(vi.mocked(log).mock.calls).toEqual([["media session action not supported: seekto"]]);
    expect(session.handlers.map(([n]) => n)).toEqual([
      "play",
      "pause",
      "seekbackward",
      "seekforward",
      "previoustrack",
      "nexttrack",
    ]);
  });

  it("mirrors audio play and pause into playbackState", () => {
    const { controller, audio } = make();
    controller.setup();
    audio.dispatch("play");
    expect(session.playbackState).toBe("playing");
    audio.dispatch("pause");
    expect(session.playbackState).toBe("paused");
  });
});

describe("updatePositionState", () => {
  it("sets the position and throttles to once per second", () => {
    const { controller } = make();
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 100, playbackRate: 1.5, position: 10 });
    vi.advanceTimersByTime(999);
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledTimes(2);
  });

  it("clamps the position to the duration", () => {
    const { controller, audio } = make();
    audio.currentTime = 150;
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 100, playbackRate: 1.5, position: 100 });
  });

  it("skips a non-finite duration and does not start the throttle", () => {
    const { controller, audio } = make();
    audio.duration = Number.NaN;
    controller.updatePositionState();
    audio.duration = Number.POSITIVE_INFINITY;
    controller.updatePositionState();
    expect(session.setPositionState).not.toHaveBeenCalled();
    audio.duration = 100;
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledTimes(1);
  });

  it("swallows setPositionState errors", () => {
    session.setPositionState.mockImplementation(() => {
      throw new Error("bad");
    });
    const { controller } = make();
    expect(() => controller.updatePositionState()).not.toThrow();
  });

  it("resetPositionState allows an immediate update", () => {
    const { controller } = make();
    controller.updatePositionState();
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledTimes(1);
    controller.resetPositionState();
    controller.updatePositionState();
    expect(session.setPositionState).toHaveBeenCalledTimes(2);
  });
});

describe("setMetadata and setPlaybackState", () => {
  it("builds the exact metadata fields", () => {
    const { controller } = make("My Book");
    controller.setMetadata("Chapter 1");
    expect(session.metadata).toBeInstanceOf(FakeMetadata);
    expect(session.metadata).toEqual(
      new FakeMetadata({
        title: "Chapter 1",
        artist: "My Book",
        album: "epub-tts",
        artwork: [{ src: `${import.meta.env.BASE_URL}icon.svg`, sizes: "512x512", type: "image/svg+xml" }],
      }),
    );
  });

  it("falls back to EPUB TTS, evaluated at call time", () => {
    const { controller, setTitle } = make("First");
    setTitle(undefined);
    controller.setMetadata("T");
    expect(session.metadata).toMatchObject({ init: { artist: "EPUB TTS" } });
    setTitle("Later");
    controller.setMetadata("T");
    expect(session.metadata).toMatchObject({ init: { artist: "Later" } });
  });

  it("setPlaybackState writes the state", () => {
    const { controller } = make();
    controller.setPlaybackState("playing");
    expect(session.playbackState).toBe("playing");
    controller.setPlaybackState("paused");
    expect(session.playbackState).toBe("paused");
  });
});
