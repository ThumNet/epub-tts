import { chapterParagraphs, splitSentences } from "../epub";
import type { OpenBook, Sentence } from "../epub";
import { log } from "../log";
import type { EngineHooks } from "./hooks";
import { errorName } from "./pure";

export interface TextChapter {
  chapterIndex: number;
  sentences: Sentence[];
}

export interface BookStore {
  /** The open book. Live: read it again after every await. */
  readonly opened: OpenBook | undefined;
  /** Per chapter: true when it has text, false when empty, undefined when not checked yet. The current array, not a copy. */
  readonly hasText: Array<boolean | undefined>;
  open(book: OpenBook): void;
  clear(): void;
  chapterSentences(book: OpenBook, index: number): Promise<Sentence[]>;
  findTextChapter(book: OpenBook, from: number, step: 1 | -1): Promise<TextChapter | undefined>;
  scanChapters(book: OpenBook): Promise<void>;
}

export function createBook(deps: { hooks: Pick<EngineHooks, "notifyChange"> }): BookStore {
  const { hooks } = deps;
  let opened: OpenBook | undefined;
  // Per chapter: true when it has text, false when empty, undefined when not checked yet.
  let chapterHasText: Array<boolean | undefined> = [];

  /** Read and split a chapter. Records whether it has text. */
  async function chapterSentences(book: OpenBook, index: number): Promise<Sentence[]> {
    const sentences = splitSentences(await chapterParagraphs(book, index), book.language);
    if (book === opened) {
      chapterHasText[index] = sentences.length > 0;
      hooks.notifyChange();
    }
    return sentences;
  }

  /** The nearest chapter after (`step` 1) or before (`step` -1) `from` that has text. Logs skipped chapters. */
  async function findTextChapter(book: OpenBook, from: number, step: 1 | -1): Promise<TextChapter | undefined> {
    for (let index = from + step; index >= 0 && index < book.chapters.length; index += step) {
      if (book !== opened) return undefined;
      if (chapterHasText[index] !== false) {
        const sentences = await chapterSentences(book, index);
        if (sentences.length > 0) return { chapterIndex: index, sentences };
      }
      log(`skipped chapter ${index + 1}: no text`);
    }
    return undefined;
  }

  /** Check every chapter for text in the background, so Previous and Next know where the book starts and ends. */
  async function scanChapters(book: OpenBook): Promise<void> {
    for (let index = 0; index < book.chapters.length; index += 1) {
      if (book !== opened) return;
      if (chapterHasText[index] !== undefined) continue;
      try {
        await chapterSentences(book, index);
      } catch (error) {
        log(`chapter scan: chapter ${index + 1} could not be read: ${errorName(error)}`);
      }
    }
    const empty = chapterHasText.filter((value) => value === false).length;
    log(`chapter scan done: ${empty} of ${book.chapters.length} spine items have no text`);
    hooks.notifyChange();
  }

  return {
    get opened() {
      return opened;
    },
    get hasText() {
      return chapterHasText;
    },
    open(book) {
      opened = book;
      chapterHasText = new Array<boolean | undefined>(book.chapters.length).fill(undefined);
    },
    clear() {
      opened = undefined;
      chapterHasText = [];
    },
    chapterSentences,
    findTextChapter,
    scanChapters,
  };
}
