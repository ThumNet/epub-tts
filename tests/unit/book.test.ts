import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenBook } from "../../src/epub";

const paragraphsByChapter = vi.hoisted(() => new Map<number, string[] | Error>());
const hooks = vi.hoisted(() => ({
  afterRead: undefined as undefined | (() => void),
}));

vi.mock("../../src/epub", () => ({
  chapterParagraphs: (_open: unknown, index: number): Promise<string[]> => {
    const value = paragraphsByChapter.get(index) ?? [];
    hooks.afterRead?.();
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  },
  splitSentences: (paragraphs: string[]) => paragraphs.map((text) => ({ text, paragraphEnd: true })),
}));
vi.mock("../../src/log", () => ({ log: vi.fn(), logText: () => "" }));

import { log } from "../../src/log";
import { createBook } from "../../src/engine/book";

function fakeBook(id: string, chapterCount: number): OpenBook {
  return {
    // The engine never touches the epub.js object itself: chapterParagraphs is mocked.
    book: {} as unknown as OpenBook["book"],
    id,
    title: id,
    language: "en",
    chapters: Array.from({ length: chapterCount }, (_, index) => ({ index, label: `Chapter ${index + 1}`, title: `Chapter ${index + 1}` })),
  };
}

beforeEach(() => {
  paragraphsByChapter.clear();
  hooks.afterRead = undefined;
  vi.mocked(log).mockClear();
});

describe("book state", () => {
  it("open sets the book and a fresh unknown has-text array, clear resets both", () => {
    const store = createBook({ hooks: { notifyChange: vi.fn() } });
    expect(store.opened).toBeUndefined();
    expect(store.hasText).toEqual([]);
    const first = fakeBook("a", 3);
    store.open(first);
    expect(store.opened).toBe(first);
    expect(store.hasText).toHaveLength(3);
    expect(store.hasText.every((value) => value === undefined)).toBe(true);
    const before = store.hasText;
    store.open(fakeBook("b", 2));
    expect(store.hasText).not.toBe(before);
    expect(store.hasText).toHaveLength(2);
    store.clear();
    expect(store.opened).toBeUndefined();
    expect(store.hasText).toEqual([]);
  });
});

describe("chapterSentences", () => {
  it("records has-text and notifies for the opened book", async () => {
    const notifyChange = vi.fn();
    const store = createBook({ hooks: { notifyChange } });
    const book = fakeBook("a", 2);
    store.open(book);
    paragraphsByChapter.set(0, ["One."]);
    const sentences = await store.chapterSentences(book, 0);
    expect(sentences).toHaveLength(1);
    await store.chapterSentences(book, 1);
    expect(store.hasText).toEqual([true, false]);
    expect(notifyChange).toHaveBeenCalledTimes(2);
  });

  it("records nothing and does not notify for another book", async () => {
    const notifyChange = vi.fn();
    const store = createBook({ hooks: { notifyChange } });
    store.open(fakeBook("a", 1));
    paragraphsByChapter.set(0, ["One."]);
    const sentences = await store.chapterSentences(fakeBook("other", 1), 0);
    expect(sentences).toHaveLength(1);
    expect(store.hasText).toEqual([undefined]);
    expect(notifyChange).not.toHaveBeenCalled();
  });
});

describe("findTextChapter", () => {
  it("skips empty chapters, logs them, and returns the next with text", async () => {
    const store = createBook({ hooks: { notifyChange: vi.fn() } });
    const book = fakeBook("a", 4);
    store.open(book);
    paragraphsByChapter.set(3, ["Text."]);
    const found = await store.findTextChapter(book, 0, 1);
    expect(found?.chapterIndex).toBe(3);
    expect(log).toHaveBeenCalledWith("skipped chapter 2: no text");
    expect(log).toHaveBeenCalledWith("skipped chapter 3: no text");
  });

  it("does not re-read chapters known to be empty but still logs them", async () => {
    const store = createBook({ hooks: { notifyChange: vi.fn() } });
    const book = fakeBook("a", 3);
    store.open(book);
    await store.chapterSentences(book, 1);
    const spy = vi.fn();
    hooks.afterRead = spy;
    paragraphsByChapter.set(2, ["Text."]);
    const found = await store.findTextChapter(book, 0, 1);
    expect(found?.chapterIndex).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("skipped chapter 2: no text");
  });

  it("searches backwards and returns undefined at the end", async () => {
    const store = createBook({ hooks: { notifyChange: vi.fn() } });
    const book = fakeBook("a", 3);
    store.open(book);
    expect(await store.findTextChapter(book, 2, -1)).toBeUndefined();
    expect(log).toHaveBeenCalledWith("skipped chapter 2: no text");
    expect(log).toHaveBeenCalledWith("skipped chapter 1: no text");
  });

  it("stops when the book is no longer opened", async () => {
    const store = createBook({ hooks: { notifyChange: vi.fn() } });
    const book = fakeBook("a", 5);
    store.open(book);
    hooks.afterRead = () => store.clear();
    const found = await store.findTextChapter(book, 0, 1);
    expect(found).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("skipped chapter 2: no text");
  });
});

describe("scanChapters", () => {
  it("skips known chapters, logs failures, logs the summary and notifies", async () => {
    const notifyChange = vi.fn();
    const store = createBook({ hooks: { notifyChange } });
    const book = fakeBook("a", 4);
    store.open(book);
    paragraphsByChapter.set(0, ["Text."]);
    paragraphsByChapter.set(2, new RangeError("boom"));
    await store.chapterSentences(book, 0);
    notifyChange.mockClear();
    await store.scanChapters(book);
    expect(log).toHaveBeenCalledWith("chapter scan: chapter 3 could not be read: RangeError: boom");
    expect(log).toHaveBeenCalledWith("chapter scan done: 2 of 4 spine items have no text");
    expect(store.hasText).toEqual([true, false, undefined, false]);
    // chapters 2 and 4 notify once each, then the final notify
    expect(notifyChange).toHaveBeenCalledTimes(3);
  });

  it("stops without a summary when the book changes", async () => {
    const notifyChange = vi.fn();
    const store = createBook({ hooks: { notifyChange } });
    const book = fakeBook("a", 4);
    store.open(book);
    hooks.afterRead = () => store.open(fakeBook("b", 4));
    await store.scanChapters(book);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("chapter scan done"));
  });
});
