import { openBook } from "../epub";
import type { OpenBook } from "../epub";
import { forgetBook, loadBook, saveBook, storedBookToFile } from "../book-store";
import { loadPosition } from "../store";
import { log } from "../log";
import type { BookStore } from "./book";
import type { EngineHooks } from "./hooks";
import { errorName } from "./pure";

export interface LibraryDeps {
  hooks: Pick<
    EngineHooks,
    "notifyChange" | "showChapter" | "clearText" | "setBookInfo" | "appendBookInfo" | "fillChapters" | "clearChapters" | "refreshSaved"
  >;
  bookStore: BookStore;
  isGenerating(): boolean;
  cancelGeneration(): void;
  /** Live: reads the current promise at the moment of the call. */
  activeGeneration(): Promise<void>;
  unloadChapter(): void;
  isNavigating(): boolean;
  isPaused(): boolean;
  voicesBusy(): boolean;
}

export interface Library {
  /** True while a book is stored on this device. Live. */
  readonly remembered: boolean;
  /** True while a forget request deletes the stored book. Live. */
  readonly busy: boolean;
  pick(file: File | undefined): void;
  restore(): Promise<void>;
  forget(): void;
}

export function createLibrary(deps: LibraryDeps): Library {
  const { hooks, bookStore, isGenerating, cancelGeneration, activeGeneration, unloadChapter, isNavigating, isPaused, voicesBusy } =
    deps;
  // Token of the newest book request (picked file, automatic restore or forget). A result with an older token is dropped.
  let bookToken = 0;
  // True while a book is stored on this device.
  let bookRemembered = false;
  // True while a forget request deletes the stored book. Locks the book controls.
  let bookBusy = false;

  function formatSize(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showBookInfo(opened: OpenBook, note: string): void {
    const parts = [note, `language: ${opened.language}`, `${opened.chapters.length} spine items`].filter(
      (part) => part !== "",
    );
    hooks.setBookInfo(`${opened.title} (${parts.join(", ")})`);
  }

  /**
   * Make `opened` the current book and set up the UI. Returns false when a newer book request
   * replaced this one while it waited, so the caller must drop its result.
   */
  async function showBook(opened: OpenBook, token: number, note: string): Promise<boolean> {
    // A running generation and the loaded chapter belong to the previous book.
    if (isGenerating()) {
      log("new book opened: cancelling the running generation");
      cancelGeneration();
      await activeGeneration();
      if (token !== bookToken) return false;
    }
    unloadChapter();
    bookStore.open(opened);
    showBookInfo(opened, note);
    hooks.fillChapters(opened.chapters);
    log(`opened "${opened.title}" with ${opened.chapters.length} spine items`);
    // Preselect the saved chapter when this is the saved book. Nothing starts by itself.
    const savedPosition = loadPosition();
    if (savedPosition?.bookId === opened.id && opened.chapters[savedPosition.chapterIndex]) {
      hooks.showChapter(savedPosition.chapterIndex);
      log(`restored saved chapter ${savedPosition.chapterIndex + 1}`);
    }
    hooks.refreshSaved();
    void bookStore.scanChapters(opened);
    return true;
  }

  function pick(file: File | undefined): void {
    if (!file) return;
    if (bookBusy) return;
    const token = ++bookToken;
    hooks.setBookInfo("Reading EPUB...");
    openBook(file)
      .then(async (opened) => {
        if (token !== bookToken) return;
        if (!(await showBook(opened, token, ""))) return;
        // The book works now. Remember it without blocking the UI.
        const result = await saveBook(file, opened.title);
        if (token !== bookToken) return;
        if (result.ok) {
          bookRemembered = true;
          showBookInfo(opened, `remembered ${formatSize(result.size)}`);
        } else {
          showBookInfo(opened, "");
          hooks.appendBookInfo(`. Could not remember this book on this device: ${result.reason}`);
        }
        hooks.notifyChange();
      })
      .catch((error: unknown) => {
        if (token !== bookToken) return;
        hooks.setBookInfo(`Could not open the EPUB: ${String(error)}`);
        log(`epub error: ${String(error)}`);
      });
  }

  /** Reopen the remembered book at startup. Never throws. A picked file or a forget request wins. */
  async function restore(): Promise<void> {
    const token = ++bookToken;
    try {
      const stored = await loadBook();
      if (!stored) return;
      if (token !== bookToken) return;
      log(`restore start: "${stored.name}" (${stored.size} bytes)`);
      hooks.setBookInfo("Restoring the remembered book...");
      try {
        const opened = await openBook(storedBookToFile(stored));
        if (token !== bookToken) {
          log("restore dropped: a newer book request won");
          return;
        }
        bookRemembered = true;
        if (!(await showBook(opened, token, `restored from this device, ${formatSize(stored.size)}`))) {
          log("restore dropped: a newer book request won");
          return;
        }
        log(`restore ok: "${opened.title}"`);
      } catch (error) {
        log(`restore failed: ${errorName(error)}`);
        if (token !== bookToken) return;
        const forgotten = await forgetBook();
        if (token !== bookToken) return;
        bookRemembered = false;
        hooks.setBookInfo(
          forgotten
            ? "Could not reopen the remembered book. It was forgotten. Pick an EPUB again."
            : "Could not reopen the remembered book, and it could not be deleted. Pick an EPUB again.",
        );
        log(forgotten ? "restore failed: stored book forgotten" : "restore failed: stored book could not be deleted");
      }
    } catch (error) {
      log(`restore failed: ${errorName(error)}`);
    } finally {
      hooks.notifyChange();
    }
  }

  function forget(): void {
    if (!bookRemembered || bookBusy || isGenerating() || voicesBusy() || isNavigating() || !isPaused()) return;
    const token = ++bookToken;
    bookBusy = true;
    hooks.notifyChange();
    void (async () => {
      try {
        const ok = await forgetBook();
        if (token !== bookToken) return;
        if (!ok) {
          hooks.setBookInfo("Could not forget the book on this device.");
          return;
        }
        bookRemembered = false;
        // Defensive: the controls are locked during the delete, so nothing should be generating.
        if (isGenerating()) {
          log("book forgotten while generating: the loaded book stays until the generation ends");
          return;
        }
        unloadChapter();
        bookStore.clear();
        hooks.clearChapters();
        hooks.setBookInfo("");
        hooks.clearText();
        log("book forgotten: the saved position and settings stay");
        hooks.refreshSaved();
      } finally {
        bookBusy = false;
        hooks.notifyChange();
      }
    })();
  }

  return {
    get remembered() {
      return bookRemembered;
    },
    get busy() {
      return bookBusy;
    },
    pick,
    restore,
    forget,
  };
}
