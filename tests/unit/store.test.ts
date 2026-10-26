import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPosition, loadSettings } from "../../src/store";

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

const POSITION_KEY = "epub-tts:position";
const SETTINGS_KEY = "epub-tts:settings";

describe("loadPosition", () => {
  const valid = {
    bookId: "a.epub:10",
    bookTitle: "A",
    chapterIndex: 1,
    charLimit: 0,
    sentenceIndex: 2,
    seconds: 3.5,
    savedAt: 99,
  };

  it("returns undefined when the key is missing", () => {
    expect(loadPosition()).toBeUndefined();
  });

  it("returns undefined for corrupt JSON", () => {
    store.set(POSITION_KEY, "{not json");
    expect(loadPosition()).toBeUndefined();
  });

  it("returns undefined for JSON that is not an object", () => {
    store.set(POSITION_KEY, "42");
    expect(loadPosition()).toBeUndefined();
    store.set(POSITION_KEY, "null");
    expect(loadPosition()).toBeUndefined();
  });

  it("returns undefined for wrong field types", () => {
    store.set(POSITION_KEY, JSON.stringify({ ...valid, seconds: "3" }));
    expect(loadPosition()).toBeUndefined();
    store.set(POSITION_KEY, JSON.stringify({ ...valid, bookId: 5 }));
    expect(loadPosition()).toBeUndefined();
  });

  it("returns undefined when a field is missing", () => {
    const { savedAt: _savedAt, ...rest } = valid;
    store.set(POSITION_KEY, JSON.stringify(rest));
    expect(loadPosition()).toBeUndefined();
  });

  it("returns the position and drops extra fields", () => {
    store.set(POSITION_KEY, JSON.stringify({ ...valid, extra: true }));
    expect(loadPosition()).toEqual(valid);
  });
});

describe("loadSettings", () => {
  it("returns undefined when the key is missing", () => {
    expect(loadSettings()).toBeUndefined();
  });

  it("returns undefined for corrupt JSON", () => {
    store.set(SETTINGS_KEY, "oops");
    expect(loadSettings()).toBeUndefined();
  });

  it("returns undefined for wrong types", () => {
    store.set(SETTINGS_KEY, JSON.stringify({ voiceId: 1, speed: 1 }));
    expect(loadSettings()).toBeUndefined();
    store.set(SETTINGS_KEY, JSON.stringify({ voiceId: "v", speed: "1" }));
    expect(loadSettings()).toBeUndefined();
    store.set(SETTINGS_KEY, "[]");
    expect(loadSettings()).toBeUndefined();
  });

  it("returns undefined for a speed that is not finite", () => {
    store.set(SETTINGS_KEY, '{"voiceId":"v","speed":1e999}');
    expect(loadSettings()).toBeUndefined();
  });

  it("returns valid settings and does not check the voice", () => {
    store.set(SETTINGS_KEY, JSON.stringify({ voiceId: "unknown-voice", speed: 1.5, extra: 1 }));
    expect(loadSettings()).toEqual({ voiceId: "unknown-voice", speed: 1.5 });
  });
});
