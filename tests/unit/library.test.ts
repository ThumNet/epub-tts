import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenBook } from "../../src/epub";
import type { SaveResult, StoredBook } from "../../src/book-store";
import type { BookStore } from "../../src/engine/book";

const mocks = vi.hoisted(() => ({
  openBook: vi.fn(),
  saveBook: vi.fn(),
  loadBook: vi.fn(),
  forgetBook: vi.fn(),
  storedBookToFile: vi.fn(),
  loadPosition: vi.fn(),
}));

vi.mock("../../src/epub", () => ({ openBook: mocks.openBook }));
vi.mock("../../src/book-store", () => ({
  saveBook: mocks.saveBook,
  loadBook: mocks.loadBook,
  forgetBook: mocks.forgetBook,
  storedBookToFile: mocks.storedBookToFile,
}));
vi.mock("../../src/store", () => ({ loadPosition: mocks.loadPosition }));
vi.mock("../../src/log", () => ({ log: vi.fn(), logText: () => "" }));

import { log } from "../../src/log";
import { createLibrary } from "../../src/engine/library";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function fakeBook(id = "b1", chapterCount = 3): OpenBook {
  return {
    book: {} as unknown as OpenBook["book"],
    id,
    title: "My Book",
    language: "en",
    chapters: Array.from({ length: chapterCount }, (_, index) => ({ index, label: `${index + 1}. C`, title: "C" })),
  };
}

const INFO = "My Book (language: en, 3 spine items)";

function setup(overrides: { generating?: boolean; navigating?: boolean; voicesBusy?: boolean } = {}) {
  const events: string[] = [];
  const state = {
    generating: overrides.generating ?? false,
    navigating: overrides.navigating ?? false,
    voicesBusy: overrides.voicesBusy ?? false,
    activeGeneration: Promise.resolve(),
  };
  const hooks = {
    notifyChange: vi.fn(() => events.push("notify")),
    showChapter: vi.fn((index: number) => events.push(`showChapter ${index}`)),
    clearText: vi.fn(() => events.push("clearText")),
    setBookInfo: vi.fn((text: string) => events.push(`info ${text}`)),
    appendBookInfo: vi.fn((text: string) => events.push(`append ${text}`)),
    fillChapters: vi.fn(() => events.push("fillChapters")),
    clearChapters: vi.fn(() => events.push("clearChapters")),
    refreshSaved: vi.fn(() => events.push("refreshSaved")),
  };
  const bookStore = {
    opened: undefined,
    hasText: [],
    open: vi.fn(() => events.push("open")),
    clear: vi.fn(() => events.push("clear")),
    chapterSentences: vi.fn(),
    findTextChapter: vi.fn(),
    scanChapters: vi.fn(() => {
      events.push("scan");
      return Promise.resolve();
    }),
  } satisfies BookStore;
  const cancelGeneration = vi.fn(() => events.push("cancelGeneration"));
  const unloadChapter = vi.fn(() => events.push("unloadChapter"));
  const previewChapter = vi.fn((_index?: number) => Promise.resolve());
  const library = createLibrary({
    hooks,
    bookStore,
    isGenerating: () => state.generating,
    cancelGeneration,
    activeGeneration: () => state.activeGeneration,
    unloadChapter,
    isNavigating: () => state.navigating,
    voicesBusy: () => state.voicesBusy,
    previewChapter,
  });
  return { events, state, hooks, bookStore, cancelGeneration, unloadChapter, previewChapter, library };
}

function file(): File {
  return {} as unknown as File;
}

function stored(): StoredBook {
  return { name: "x.epub", size: 2 * 1024 * 1024 } as unknown as StoredBook;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.mocked(log).mockClear();
  mocks.loadPosition.mockReturnValue(undefined);
});

describe("pick", () => {
  it("does nothing without a file", () => {
    const t = setup();
    t.library.pick(undefined);
    expect(mocks.openBook).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it("does nothing while busy", async () => {
    const t = setup();
    mocks.forgetBook.mockReturnValue(new Promise(() => undefined));
    // make remembered via restore
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockResolvedValue(fakeBook());
    await t.library.restore();
    t.library.forget();
    expect(t.library.busy).toBe(true);
    mocks.openBook.mockClear();
    t.library.pick(file());
    expect(mocks.openBook).not.toHaveBeenCalled();
  });

  it("opens, shows and remembers the book", async () => {
    const t = setup();
    mocks.openBook.mockResolvedValue(fakeBook());
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1.5 * 1024 * 1024 } satisfies SaveResult);
    t.library.pick(file());
    expect(t.events).toEqual(["info Reading EPUB..."]);
    await flush();
    expect(t.events).toEqual([
      "info Reading EPUB...",
      "unloadChapter",
      "open",
      `info ${INFO}`,
      "fillChapters",
      "refreshSaved",
      "scan",
      `info My Book (remembered 1.5 MB, language: en, 3 spine items)`,
      "notify",
    ]);
    expect(t.hooks.fillChapters).toHaveBeenCalledWith(fakeBook().chapters);
    expect(log).toHaveBeenCalledWith('opened "My Book" with 3 spine items');
    expect(t.library.remembered).toBe(true);
  });

  it("preselects the saved chapter when the saved book matches", async () => {
    const t = setup();
    mocks.loadPosition.mockReturnValue({ bookId: "b1", chapterIndex: 2, sentenceIndex: 0 });
    mocks.openBook.mockResolvedValue(fakeBook("b1"));
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1024 * 1024 });
    t.library.pick(file());
    await flush();
    expect(t.hooks.showChapter).toHaveBeenCalledWith(2);
    expect(log).toHaveBeenCalledWith("restored saved chapter 3");
    expect(t.events.indexOf("showChapter 2")).toBeGreaterThan(t.events.indexOf("fillChapters"));
    expect(t.events.indexOf("showChapter 2")).toBeLessThan(t.events.indexOf("refreshSaved"));
  });

  it("does not preselect for another book or a missing chapter", async () => {
    const t = setup();
    mocks.loadPosition.mockReturnValue({ bookId: "other", chapterIndex: 0, sentenceIndex: 0 });
    mocks.openBook.mockResolvedValue(fakeBook("b1"));
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1 });
    t.library.pick(file());
    await flush();
    expect(t.hooks.showChapter).not.toHaveBeenCalled();
  });

  it("previews the saved chapter, or the first text chapter when no chapter is saved", async () => {
    const saved = setup();
    mocks.loadPosition.mockReturnValue({ bookId: "b1", chapterIndex: 2, sentenceIndex: 0 });
    mocks.openBook.mockResolvedValue(fakeBook("b1"));
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1 });
    saved.library.pick(file());
    await flush();
    expect(saved.previewChapter).toHaveBeenCalledWith(2);

    const fresh = setup();
    mocks.loadPosition.mockReturnValue(undefined);
    fresh.library.pick(file());
    await flush();
    expect(fresh.previewChapter).toHaveBeenCalledWith(undefined);
  });

  it("cancels a running generation, awaits it, then continues", async () => {
    const t = setup({ generating: true });
    const gen = deferred<void>();
    t.state.activeGeneration = gen.promise;
    mocks.openBook.mockResolvedValue(fakeBook());
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1 });
    t.library.pick(file());
    await flush();
    expect(t.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("new book opened: cancelling the running generation");
    expect(t.unloadChapter).not.toHaveBeenCalled();
    gen.resolve();
    await flush();
    expect(t.unloadChapter).toHaveBeenCalledTimes(1);
    expect(t.bookStore.open).toHaveBeenCalledTimes(1);
  });

  it("keeps the info and appends a note when remembering fails", async () => {
    const t = setup();
    mocks.openBook.mockResolvedValue(fakeBook());
    mocks.saveBook.mockResolvedValue({ ok: false, reason: "quota" } satisfies SaveResult);
    t.library.pick(file());
    await flush();
    expect(t.events.slice(-3)).toEqual([
      `info ${INFO}`,
      "append . Could not remember this book on this device: quota",
      "notify",
    ]);
    expect(t.library.remembered).toBe(false);
  });

  it("drops the result of an older pick at the open await", async () => {
    const t = setup();
    const first = deferred<OpenBook>();
    mocks.openBook.mockReturnValueOnce(first.promise);
    mocks.openBook.mockResolvedValueOnce(fakeBook("second"));
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1 });
    t.library.pick(file());
    t.library.pick(file());
    first.resolve(fakeBook("first"));
    await flush();
    expect(t.bookStore.open).toHaveBeenCalledTimes(1);
    expect(t.bookStore.open).toHaveBeenCalledWith(expect.objectContaining({ id: "second" }));
  });

  it("drops the older pick after the generation wait", async () => {
    const t = setup({ generating: true });
    const gen = deferred<void>();
    t.state.activeGeneration = gen.promise;
    mocks.openBook.mockResolvedValue(fakeBook());
    mocks.saveBook.mockResolvedValue({ ok: true, size: 1 });
    t.library.pick(file());
    await flush();
    mocks.openBook.mockReturnValue(new Promise(() => undefined));
    t.library.pick(file());
    gen.resolve();
    await flush();
    expect(t.bookStore.open).not.toHaveBeenCalled();
    expect(mocks.saveBook).not.toHaveBeenCalled();
  });

  it("drops the older pick at the save await", async () => {
    const t = setup();
    const save = deferred<SaveResult>();
    mocks.openBook.mockResolvedValueOnce(fakeBook());
    mocks.saveBook.mockReturnValue(save.promise);
    t.library.pick(file());
    await flush();
    mocks.openBook.mockReturnValueOnce(new Promise(() => undefined));
    t.library.pick(file());
    save.resolve({ ok: true, size: 1 });
    await flush();
    expect(t.library.remembered).toBe(false);
    expect(t.hooks.notifyChange).not.toHaveBeenCalled();
  });

  it("reports an open failure", async () => {
    const t = setup();
    mocks.openBook.mockRejectedValue(new Error("bad zip"));
    t.library.pick(file());
    await flush();
    expect(t.hooks.setBookInfo).toHaveBeenLastCalledWith("Could not open the EPUB: Error: bad zip");
    expect(log).toHaveBeenCalledWith("epub error: Error: bad zip");
  });

  it("stays silent about an open failure of an older pick", async () => {
    const t = setup();
    const first = deferred<OpenBook>();
    mocks.openBook.mockReturnValueOnce(first.promise);
    mocks.openBook.mockReturnValueOnce(new Promise(() => undefined));
    t.library.pick(file());
    t.library.pick(file());
    first.reject(new Error("late"));
    await flush();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("epub error"));
  });
});

describe("restore", () => {
  it("does nothing visible when nothing is stored", async () => {
    const t = setup();
    mocks.loadBook.mockResolvedValue(undefined);
    await t.library.restore();
    expect(t.events).toEqual(["notify"]);
    expect(mocks.openBook).not.toHaveBeenCalled();
  });

  it("reopens the stored book", async () => {
    const t = setup();
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockResolvedValue(fakeBook());
    await t.library.restore();
    expect(log).toHaveBeenCalledWith('restore start: "x.epub" (2097152 bytes)');
    expect(t.events[0]).toBe("info Restoring the remembered book...");
    expect(t.hooks.setBookInfo).toHaveBeenCalledWith(
      "My Book (restored from this device, 2.0 MB, language: en, 3 spine items)",
    );
    expect(log).toHaveBeenCalledWith('restore ok: "My Book"');
    expect(t.library.remembered).toBe(true);
    expect(t.events.at(-1)).toBe("notify");
  });

  it("is dropped by a newer pick after loadBook", async () => {
    const t = setup();
    const load = deferred<StoredBook | undefined>();
    mocks.loadBook.mockReturnValue(load.promise);
    const restoring = t.library.restore();
    mocks.openBook.mockReturnValue(new Promise(() => undefined));
    t.library.pick(file());
    load.resolve(stored());
    await restoring;
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("restore start"));
  });

  it("is dropped by a newer pick after openBook", async () => {
    const t = setup();
    const open = deferred<OpenBook>();
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockReturnValueOnce(open.promise);
    const restoring = t.library.restore();
    await flush();
    mocks.openBook.mockReturnValueOnce(new Promise(() => undefined));
    t.library.pick(file());
    open.resolve(fakeBook());
    await restoring;
    expect(log).toHaveBeenCalledWith("restore dropped: a newer book request won");
    expect(t.library.remembered).toBe(false);
    expect(t.bookStore.open).not.toHaveBeenCalled();
  });

  it("is dropped by a newer pick during the generation wait in showBook", async () => {
    const t = setup({ generating: true });
    const gen = deferred<void>();
    t.state.activeGeneration = gen.promise;
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockResolvedValueOnce(fakeBook());
    const restoring = t.library.restore();
    await flush();
    mocks.openBook.mockReturnValueOnce(new Promise(() => undefined));
    t.library.pick(file());
    gen.resolve();
    await restoring;
    expect(log).toHaveBeenCalledWith("restore dropped: a newer book request won");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("restore ok"));
  });

  it("forgets an unreadable book and says so", async () => {
    const t = setup();
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockRejectedValue(new RangeError("corrupt"));
    mocks.forgetBook.mockResolvedValue(true);
    await t.library.restore();
    expect(log).toHaveBeenCalledWith("restore failed: RangeError: corrupt");
    expect(t.hooks.setBookInfo).toHaveBeenLastCalledWith(
      "Could not reopen the remembered book. It was forgotten. Pick an EPUB again.",
    );
    expect(log).toHaveBeenCalledWith("restore failed: stored book forgotten");
    expect(t.library.remembered).toBe(false);
  });

  it("says so when the unreadable book cannot be deleted", async () => {
    const t = setup();
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockRejectedValue(new Error("x"));
    mocks.forgetBook.mockResolvedValue(false);
    await t.library.restore();
    expect(t.hooks.setBookInfo).toHaveBeenLastCalledWith(
      "Could not reopen the remembered book, and it could not be deleted. Pick an EPUB again.",
    );
    expect(log).toHaveBeenCalledWith("restore failed: stored book could not be deleted");
  });

  it("does not forget when a newer request won before the failure", async () => {
    const t = setup();
    const open = deferred<OpenBook>();
    mocks.loadBook.mockResolvedValue(stored());
    mocks.openBook.mockReturnValueOnce(open.promise);
    const restoring = t.library.restore();
    await flush();
    mocks.openBook.mockReturnValueOnce(new Promise(() => undefined));
    t.library.pick(file());
    open.reject(new Error("x"));
    await restoring;
    expect(mocks.forgetBook).not.toHaveBeenCalled();
  });

  it("logs a loadBook failure and still notifies", async () => {
    const t = setup();
    mocks.loadBook.mockRejectedValue(new Error("idb"));
    await t.library.restore();
    expect(log).toHaveBeenCalledWith("restore failed: Error: idb");
    expect(t.hooks.notifyChange).toHaveBeenCalledTimes(1);
  });
});

async function rememberedLibrary(overrides: Parameters<typeof setup>[0] = {}) {
  const t = setup(overrides);
  mocks.loadBook.mockResolvedValue(stored());
  mocks.openBook.mockResolvedValue(fakeBook());
  await t.library.restore();
  t.events.length = 0;
  vi.mocked(log).mockClear();
  t.hooks.notifyChange.mockClear();
  return t;
}

describe("forget", () => {
  it("is blocked when nothing is remembered", () => {
    const t = setup();
    t.library.forget();
    expect(mocks.forgetBook).not.toHaveBeenCalled();
    expect(t.library.busy).toBe(false);
  });

  it.each([
    ["navigating", { navigating: true }],
    ["voices busy", { voicesBusy: true }],
  ])("is blocked while %s", async (_name, overrides) => {
    const t = await rememberedLibrary(overrides);
    t.library.forget();
    expect(mocks.forgetBook).not.toHaveBeenCalled();
    expect(t.library.busy).toBe(false);
  });

  it("cancels a running generation first, so Forget works while playing or paused", async () => {
    const t = await rememberedLibrary();
    t.state.generating = true;
    t.cancelGeneration.mockImplementation(() => {
      t.state.generating = false;
      return t.events.push("cancelGeneration");
    });
    mocks.forgetBook.mockResolvedValue(true);
    t.library.forget();
    expect(t.library.busy).toBe(true);
    await flush();
    expect(t.events.slice(0, 3)).toEqual(["notify", "cancelGeneration", "unloadChapter"]);
    expect(mocks.forgetBook).toHaveBeenCalledTimes(1);
    expect(t.library.remembered).toBe(false);
    expect(t.library.busy).toBe(false);
  });

  it("is blocked while a forget runs", async () => {
    const t = await rememberedLibrary();
    mocks.forgetBook.mockReturnValue(new Promise(() => undefined));
    t.library.forget();
    t.library.forget();
    expect(mocks.forgetBook).toHaveBeenCalledTimes(1);
  });

  it("clears the book and the UI", async () => {
    const t = await rememberedLibrary();
    mocks.forgetBook.mockResolvedValue(true);
    t.library.forget();
    expect(t.library.busy).toBe(true);
    expect(t.events).toEqual(["notify"]);
    await flush();
    expect(t.events).toEqual([
      "notify",
      "unloadChapter",
      "clear",
      "clearChapters",
      "info ",
      "clearText",
      "refreshSaved",
      "notify",
    ]);
    expect(log).toHaveBeenCalledWith("book forgotten: the saved position and settings stay");
    expect(t.library.busy).toBe(false);
    expect(t.library.remembered).toBe(false);
  });

  it("reports a failed delete and keeps remembering", async () => {
    const t = await rememberedLibrary();
    mocks.forgetBook.mockResolvedValue(false);
    t.library.forget();
    await flush();
    expect(t.events).toEqual(["notify", "info Could not forget the book on this device.", "notify"]);
    expect(t.library.remembered).toBe(true);
    expect(t.library.busy).toBe(false);
  });

  it("keeps the loaded book when a generation started meanwhile", async () => {
    const t = await rememberedLibrary();
    const del = deferred<boolean>();
    mocks.forgetBook.mockReturnValue(del.promise);
    t.library.forget();
    t.state.generating = true;
    del.resolve(true);
    await flush();
    expect(log).toHaveBeenCalledWith("book forgotten while generating: the loaded book stays until the generation ends");
    expect(t.bookStore.clear).not.toHaveBeenCalled();
    expect(t.library.remembered).toBe(false);
    expect(t.library.busy).toBe(false);
  });

  it("drops the result when a newer request took over, and still unlocks", async () => {
    const t = await rememberedLibrary();
    const del = deferred<boolean>();
    mocks.forgetBook.mockReturnValue(del.promise);
    t.library.forget();
    mocks.openBook.mockReturnValue(new Promise(() => undefined));
    // busy blocks pick, so simulate the newer request through restore
    mocks.loadBook.mockReturnValue(new Promise(() => undefined));
    void t.library.restore();
    del.resolve(true);
    await flush();
    expect(t.bookStore.clear).not.toHaveBeenCalled();
    expect(t.library.remembered).toBe(true);
    expect(t.library.busy).toBe(false);
    expect(t.hooks.notifyChange).toHaveBeenCalledTimes(2);
  });
});
