import type { ChapterInfo } from "../epub";

/** Text the shell shows. DOM-free. Initial values match the initial text in `index.html`. */
export interface UiState {
  status: string;
  bookInfo: string;
  copyStatus: string;
  selectedChapter: number;
  /** The raw value written to the select. It can match no option (a stale index), so it is not `selectedChapter`. */
  chapterValue: string;
  /** Replaced, never mutated: the shell rebuilds the options only when this array changes. */
  chapters: ReadonlyArray<ChapterInfo>;
  /** Set true by `fillChapters`, false by `clearChapters`. An empty fill still enables the select, so it cannot be derived from `chapters`. */
  chaptersEnabled: boolean;
}

const NO_CHAPTERS: ReadonlyArray<ChapterInfo> = [];

export function createUiState(): UiState {
  return {
    status: "Idle.",
    bookInfo: "",
    copyStatus: "",
    selectedChapter: 0,
    chapterValue: "",
    chapters: NO_CHAPTERS,
    chaptersEnabled: false,
  };
}

/** A select without the matching option reads as empty, which was `Number("")` = 0. */
export function resolveSelectedChapter(chapters: ReadonlyArray<ChapterInfo>, index: number): number {
  return chapters.some((c) => c.index === index) ? index : 0;
}

/** After the options are replaced, the browser selects the first option. */
export function firstChapterIndex(chapters: ReadonlyArray<ChapterInfo>): number {
  return chapters[0]?.index ?? 0;
}

/** `value` is what the select gets written. It stays raw: an unknown value leaves the select with no selection. */
export interface ChapterSelectState {
  value: string;
  selected: number;
}

export function chapterSelectState(chapters: ReadonlyArray<ChapterInfo>, index: number): ChapterSelectState {
  return { value: String(index), selected: resolveSelectedChapter(chapters, index) };
}

/** The state after the options are replaced: the browser selects the first option, or none when empty. */
export function filledChapterSelectState(chapters: ReadonlyArray<ChapterInfo>): ChapterSelectState {
  const first = chapters[0];
  return { value: first ? String(first.index) : "", selected: firstChapterIndex(chapters) };
}
