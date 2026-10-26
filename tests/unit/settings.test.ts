import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettings } from "../../src/engine/settings";
import { DEFAULT_VOICE_ID, VOICES } from "../../src/voices";

const store = new Map<string, string>();
const stub = {
  getItem: (key: string): string | null => store.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    store.set(key, value);
  },
  removeItem: (key: string): void => {
    store.delete(key);
  },
};

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true, writable: true });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const SETTINGS_KEY = "epub-tts:settings";

function make() {
  const audio = { defaultPlaybackRate: 1, playbackRate: 1, preservesPitch: false };
  return { audio, settings: createSettings({ audio }) };
}

describe("createSettings", () => {
  it("starts at speed 1 with the default voice", () => {
    const { settings } = make();
    expect(settings.speed).toBe(1);
    expect(settings.voiceId).toBe(DEFAULT_VOICE_ID);
  });

  it("rounds and clamps the speed", () => {
    const { settings } = make();
    settings.setSpeed(1.234);
    expect(settings.speed).toBe(1.23);
    settings.setSpeed(100);
    expect(settings.speed).toBeLessThanOrEqual(3);
    expect(settings.speed).toBeGreaterThan(1);
    settings.setSpeed(-5);
    expect(settings.speed).toBeGreaterThan(0);
    expect(settings.speed).toBeLessThan(1);
  });

  it("applies the speed to the audio element", () => {
    const { audio, settings } = make();
    settings.setSpeed(1.5);
    expect(audio.playbackRate).toBe(1);
    settings.applyPlaybackRate();
    expect(audio.defaultPlaybackRate).toBe(1.5);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.preservesPitch).toBe(true);
  });

  it("falls back to the default voice for an unknown id", () => {
    const { settings } = make();
    const other = VOICES.find((voice) => voice.id !== DEFAULT_VOICE_ID);
    if (!other) throw new Error("need a second voice");
    settings.setVoiceId(other.id);
    expect(settings.voiceId).toBe(other.id);
    settings.setVoiceId("");
    expect(settings.voiceId).toBe(DEFAULT_VOICE_ID);
  });

  it("persists the voice and speed", () => {
    const { settings } = make();
    settings.setSpeed(1.5);
    settings.persist();
    expect(JSON.parse(store.get(SETTINGS_KEY) ?? "null")).toEqual({ voiceId: DEFAULT_VOICE_ID, speed: 1.5 });
  });

  it("loads nothing saved as the defaults and writes nothing", () => {
    const { settings } = make();
    expect(settings.load()).toEqual({ voiceId: DEFAULT_VOICE_ID, speed: 1 });
    expect(store.size).toBe(0);
  });

  it("accepts a saved voice from the list and rounds the speed", () => {
    const other = VOICES.find((voice) => voice.id !== DEFAULT_VOICE_ID);
    if (!other) throw new Error("need a second voice");
    store.set(SETTINGS_KEY, JSON.stringify({ voiceId: other.id, speed: 1.234 }));
    const { settings } = make();
    expect(settings.load()).toEqual({ voiceId: other.id, speed: 1.23 });
    expect(settings.voiceId).toBe(other.id);
    expect(settings.speed).toBe(1.23);
  });

  it("rejects an unknown saved voice and keeps the saved speed", () => {
    store.set(SETTINGS_KEY, JSON.stringify({ voiceId: "gone", speed: 1.5 }));
    const { settings } = make();
    expect(settings.load()).toEqual({ voiceId: DEFAULT_VOICE_ID, speed: 1.5, rejectedVoice: "gone" });
    expect(settings.voiceId).toBe(DEFAULT_VOICE_ID);
  });
});
