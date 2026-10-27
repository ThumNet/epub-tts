import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const library = vi.hoisted(() => ({
  stored: vi.fn<() => Promise<string[]>>(),
  download: vi.fn<(id: string, onProgress: (p: { loaded: number; total: number }) => void) => Promise<void>>(),
  remove: vi.fn<(id: string) => Promise<void>>(),
  removeVoiceFiles: vi.fn<(id: string) => Promise<void>>(),
  log: vi.fn<(message: string) => void>(),
}));

vi.mock("@mintplex-labs/piper-tts-web", () => ({
  stored: library.stored,
  download: library.download,
  remove: library.remove,
}));
vi.mock("../../src/voices", () => ({ removeVoiceFiles: library.removeVoiceFiles }));
vi.mock("../../src/log", () => ({ log: library.log }));

import { createVoicesStore } from "../../src/engine/voices-store";

const ID = "voice-a";

function setup(inUse = false) {
  const notifyChange = vi.fn<() => void>();
  const persistSettings = vi.fn<() => void>();
  const state = { inUse, libraryBusy: false, transitioning: false };
  const store = createVoicesStore({
    hooks: { notifyChange },
    getVoiceId: () => ID,
    isVoiceInUse: (id) => state.inUse && id === ID,
    isLibraryBusy: () => state.libraryBusy,
    isTransitioning: () => state.transitioning,
    persistSettings,
  });
  return { store, notifyChange, persistSettings, state };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function logged(): string[] {
  return library.log.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.useFakeTimers();
  library.stored.mockReset();
  library.download.mockReset();
  library.remove.mockReset();
  library.removeVoiceFiles.mockReset();
  library.log.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refresh", () => {
  it("starts unknown, then sets stored true when the voice is listed", async () => {
    library.stored.mockResolvedValue([ID]);
    const { store, notifyChange } = setup();
    expect(store.stored).toBeUndefined();
    await store.refresh();
    expect(store.stored).toBe(true);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });

  it("sets stored false when the voice is not listed", async () => {
    library.stored.mockResolvedValue(["other"]);
    const { store } = setup();
    await store.refresh();
    expect(store.stored).toBe(false);
  });

  it("sets stored undefined and logs when the storage is unavailable", async () => {
    library.stored.mockRejectedValue(new Error("boom"));
    const { store, notifyChange } = setup();
    await store.refresh();
    expect(store.stored).toBeUndefined();
    expect(logged()).toEqual(["voice storage unavailable: Error: boom"]);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });

  it("ignores the result of a stale refresh", async () => {
    let resolveFirst: (list: string[]) => void = () => undefined;
    library.stored.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    library.stored.mockResolvedValueOnce(["other"]);
    const { store, notifyChange } = setup();
    const first = store.refresh();
    await store.refresh();
    expect(store.stored).toBe(false);
    resolveFirst([ID]);
    await first;
    expect(store.stored).toBe(false);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });
});

describe("select", () => {
  it("persists, logs and refreshes, and keeps the known stored list", async () => {
    library.stored.mockResolvedValue([ID, "voice-b"]);
    const { store, persistSettings, notifyChange } = setup();
    await store.refresh();
    expect(store.stored).toBe(true);
    expect(store.storedIds).toEqual([ID, "voice-b"]);
    notifyChange.mockClear();
    store.select();
    expect(persistSettings).toHaveBeenCalledTimes(1);
    expect(logged()).toContain(`voice selected: ${ID}. The worker switches before the next generation.`);
    expect(store.stored).toBe(true);
    expect(store.error).toBe("");
    expect(notifyChange).toHaveBeenCalledTimes(1);
    await flush();
    expect(store.stored).toBe(true);
    expect(notifyChange).toHaveBeenCalledTimes(2);
  });
});

describe("startDownload", () => {
  /** The storage status is known (not stored), as in the UI whenever the Download button shows. */
  async function readySetup(inUse = false) {
    library.stored.mockResolvedValue([]);
    const t = setup(inUse);
    await t.store.refresh();
    t.notifyChange.mockClear();
    return t;
  }

  it("sets busy, reports progress, then clears busy and refreshes", async () => {
    let progress: (p: { loaded: number; total: number }) => void = () => undefined;
    let finish: () => void = () => undefined;
    library.download.mockImplementation((_id, onProgress) => {
      progress = onProgress;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { store, notifyChange } = await readySetup();
    library.stored.mockResolvedValue([ID]);
    store.startDownload();
    expect(store.busy).toBe(true);
    expect(store.message).toBe("Downloading 0%");
    expect(store.error).toBe("");
    expect(notifyChange).toHaveBeenCalledTimes(1);
    expect(logged()).toEqual([`voice download started: ${ID}`]);
    expect(library.download.mock.calls[0]?.[0]).toBe(ID);

    progress({ loaded: 0, total: 0 });
    expect(notifyChange).toHaveBeenCalledTimes(1);
    progress({ loaded: 1, total: 3 });
    expect(store.message).toBe("Downloading 33%");
    expect(notifyChange).toHaveBeenCalledTimes(2);

    finish();
    await flush();
    expect(logged()).toContain(`voice download finished: ${ID}`);
    expect(store.busy).toBe(false);
    expect(store.stored).toBe(true);
  });

  it("logs when the voice is never found in storage", async () => {
    library.download.mockResolvedValue(undefined);
    const { store } = await readySetup();
    store.startDownload();
    await vi.advanceTimersByTimeAsync(10 * 500);
    expect(logged()).toContain(`voice download finished but ${ID} was not found in storage`);
    expect(store.busy).toBe(false);
    expect(store.stored).toBe(false);
  });

  it("logs a failure and still clears busy", async () => {
    library.download.mockRejectedValue(new Error("offline"));
    const { store } = await readySetup();
    store.startDownload();
    await flush();
    expect(logged()).toContain("voice download failed: Error: offline");
    expect(store.busy).toBe(false);
  });

  it("does nothing while the voice is in use, and downloads once it is not", async () => {
    library.download.mockResolvedValue(undefined);
    const { store, notifyChange, state } = await readySetup(true);
    store.startDownload();
    expect(store.busy).toBe(false);
    expect(library.download).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
    state.inUse = false;
    store.startDownload();
    expect(store.busy).toBe(true);
    expect(library.download).toHaveBeenCalledTimes(1);
    await flush();
  });

  it.each([
    ["the library is busy", (state: { libraryBusy: boolean; transitioning: boolean }) => (state.libraryBusy = true)],
    ["a chapter change or voice restart is in flight", (state: { libraryBusy: boolean; transitioning: boolean }) => (state.transitioning = true)],
  ])("does nothing while %s, and downloads once it ends", async (_name, block) => {
    library.download.mockResolvedValue(undefined);
    const { store, notifyChange, state } = await readySetup();
    block(state);
    store.startDownload();
    expect(store.busy).toBe(false);
    expect(library.download).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
    state.libraryBusy = false;
    state.transitioning = false;
    store.startDownload();
    expect(library.download).toHaveBeenCalledTimes(1);
    await flush();
  });

  it("does nothing while the storage status is unknown", async () => {
    library.download.mockResolvedValue(undefined);
    library.stored.mockRejectedValue(new Error("no storage"));
    const { store, notifyChange } = setup();
    await store.refresh();
    notifyChange.mockClear();
    expect(store.stored).toBeUndefined();
    store.startDownload();
    expect(store.busy).toBe(false);
    expect(library.download).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("does nothing while busy", async () => {
    library.download.mockReturnValue(new Promise<void>(() => undefined));
    const idle = await readySetup();
    idle.store.startDownload();
    idle.store.startDownload();
    idle.store.startRemove();
    expect(library.download).toHaveBeenCalledTimes(1);
    expect(library.remove).not.toHaveBeenCalled();
    expect(idle.notifyChange).toHaveBeenCalledTimes(1);
    await flush();
  });
});

describe("startRemove", () => {
  /** The storage status is known (stored), as in the UI whenever the Remove button shows. */
  async function readySetup(inUse = false) {
    library.stored.mockResolvedValue([ID]);
    const t = setup(inUse);
    await t.store.refresh();
    t.notifyChange.mockClear();
    return t;
  }

  it("removes through the library and finishes", async () => {
    library.remove.mockResolvedValue(undefined);
    const { store, notifyChange } = await readySetup();
    library.stored.mockResolvedValue([]);
    store.startRemove();
    expect(store.busy).toBe(true);
    expect(store.message).toBe("Removing...");
    expect(notifyChange).toHaveBeenCalledTimes(1);
    expect(logged()).toEqual([`voice remove started: ${ID}`]);
    await flush();
    expect(library.removeVoiceFiles).not.toHaveBeenCalled();
    expect(logged()).toContain(`voice removed: ${ID}`);
    expect(store.busy).toBe(false);
    expect(store.stored).toBe(false);
    expect(store.error).toBe("");
  });

  it("deletes the files directly when the library leaves the voice in storage", async () => {
    library.remove.mockResolvedValue(undefined);
    library.removeVoiceFiles.mockResolvedValue(undefined);
    const { store } = await readySetup();
    library.stored.mockResolvedValueOnce([ID]).mockResolvedValue([]);
    store.startRemove();
    await flush();
    expect(logged()).toContain(`library remove left ${ID} in storage: deleting the files directly`);
    expect(library.removeVoiceFiles).toHaveBeenCalledWith(ID);
    expect(logged()).toContain(`voice removed: ${ID}`);
    expect(store.error).toBe("");
  });

  it("sets the error when the voice is still stored after deletion", async () => {
    library.remove.mockResolvedValue(undefined);
    library.removeVoiceFiles.mockResolvedValue(undefined);
    const { store } = await readySetup();
    store.startRemove();
    await flush();
    const message = "Could not remove the voice: Error: the files are still in storage after deletion";
    expect(store.error).toBe(message);
    expect(logged()).toContain("voice remove failed: Error: the files are still in storage after deletion");
    expect(store.busy).toBe(false);
    expect(store.stored).toBe(true);
  });

  it("does nothing while the voice is in use", async () => {
    const { store, notifyChange } = await readySetup(true);
    store.startRemove();
    expect(store.busy).toBe(false);
    expect(library.remove).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it.each([
    ["the library is busy", (state: { libraryBusy: boolean; transitioning: boolean }) => (state.libraryBusy = true)],
    ["a chapter change or voice restart is in flight", (state: { libraryBusy: boolean; transitioning: boolean }) => (state.transitioning = true)],
  ])("does nothing while %s, and removes once it ends", async (_name, block) => {
    library.remove.mockResolvedValue(undefined);
    const { store, notifyChange, state } = await readySetup();
    block(state);
    store.startRemove();
    expect(store.busy).toBe(false);
    expect(library.remove).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
    state.libraryBusy = false;
    state.transitioning = false;
    library.stored.mockResolvedValue([]);
    store.startRemove();
    expect(library.remove).toHaveBeenCalledTimes(1);
    await flush();
  });

  it("does nothing while the storage status is unknown", async () => {
    library.stored.mockRejectedValue(new Error("no storage"));
    const { store, notifyChange } = setup();
    await store.refresh();
    notifyChange.mockClear();
    store.startRemove();
    expect(store.busy).toBe(false);
    expect(library.remove).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
  });
});
