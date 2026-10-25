import ePub from "epubjs";
import type { Book, NavItem } from "epubjs";

export interface ChapterInfo {
  index: number;
  label: string;
}

export interface OpenBook {
  book: Book;
  id: string;
  title: string;
  language: string;
  chapters: ChapterInfo[];
}

export interface Sentence {
  text: string;
  /** True when the sentence ends a paragraph. */
  paragraphEnd: boolean;
}

const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption";

function flattenToc(items: NavItem[], out: NavItem[] = []): NavItem[] {
  for (const item of items) {
    out.push(item);
    if (item.subitems) flattenToc(item.subitems, out);
  }
  return out;
}

function stripHash(href: string): string {
  const hash = href.indexOf("#");
  return hash === -1 ? href : href.slice(0, hash);
}

export async function openBook(file: File): Promise<OpenBook> {
  const data = await file.arrayBuffer();
  const book = ePub(data);
  await book.ready;
  const metadata = await book.loaded.metadata;
  const toc = flattenToc(book.navigation?.toc ?? []);
  const count = book.packaging.spine.length;

  const chapters: ChapterInfo[] = [];
  for (let index = 0; index < count; index += 1) {
    const href = book.spine.get(index).href;
    const entry = toc.find((item) => {
      const target = stripHash(item.href);
      return target !== "" && (href === target || href.endsWith(`/${target}`) || target.endsWith(`/${href}`));
    });
    const label = entry ? entry.label.trim() : "(no title)";
    chapters.push({ index, label: `${index + 1}. ${label}` });
  }

  return {
    book,
    id: `${file.name}:${file.size}`,
    title: metadata.title || file.name,
    language: metadata.language || "en",
    chapters,
  };
}

// One chain for all section reads. epub.js keeps the document on the shared section object and
// clears it on unload, so two overlapping reads of the same section can break each other.
let readChain: Promise<unknown> = Promise.resolve();

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = readChain.then(task);
  readChain = run.catch(() => undefined);
  return run;
}

/** Return the text of each block element in one spine item. Reads run one at a time. */
export function chapterParagraphs(open: OpenBook, index: number): Promise<string[]> {
  return serialised(() => readParagraphs(open, index));
}

async function readParagraphs(open: OpenBook, index: number): Promise<string[]> {
  const section = open.book.spine.get(index);
  try {
    await Promise.resolve(section.load(open.book.load.bind(open.book)));
    const root = section.document.querySelector("body") ?? section.document.documentElement;
    const blocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter(
      (element) => element.querySelector(BLOCK_SELECTOR) === null,
    );
    const texts = blocks.length > 0 ? blocks.map((b) => b.textContent ?? "") : [root.textContent ?? ""];
    return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => /[\p{L}\p{N}]/u.test(t));
  } finally {
    section.unload();
  }
}

/** Split paragraphs into sentences with Intl.Segmenter. */
export function splitSentences(paragraphs: string[], language: string): Sentence[] {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  } catch {
    segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }
  const out: Sentence[] = [];
  for (const paragraph of paragraphs) {
    const start = out.length;
    for (const part of segmenter.segment(paragraph)) {
      const text = part.segment.trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      out.push({ text, paragraphEnd: false });
    }
    const last = out[out.length - 1];
    if (last && out.length > start) last.paragraphEnd = true;
  }
  return out;
}
