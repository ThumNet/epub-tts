import { describe, expect, it } from "vitest";
import { chapterSelectState, createUiState, filledChapterSelectState, firstChapterIndex, resolveSelectedChapter } from "../../src/ui/state";

const chapters = [
  { index: 2, label: "Two" },
  { index: 5, label: "Five" },
];

describe("resolveSelectedChapter", () => {
  it("keeps an index that is an option", () => {
    expect(resolveSelectedChapter(chapters, 5)).toBe(5);
  });
  it("returns 0 for an index that is not an option", () => {
    expect(resolveSelectedChapter(chapters, 3)).toBe(0);
  });
  it("returns 0 for an empty list", () => {
    expect(resolveSelectedChapter([], 4)).toBe(0);
  });
});

describe("firstChapterIndex", () => {
  it("returns the first option index", () => {
    expect(firstChapterIndex(chapters)).toBe(2);
  });
  it("returns 0 for an empty list", () => {
    expect(firstChapterIndex([])).toBe(0);
  });
});

describe("chapterSelectState", () => {
  it("keeps the raw value for an index that is an option", () => {
    expect(chapterSelectState(chapters, 5)).toEqual({ value: "5", selected: 5 });
  });
  it("keeps the raw value for an out-of-range index while selected is 0", () => {
    expect(chapterSelectState(chapters, 99)).toEqual({ value: "99", selected: 0 });
  });
  it("keeps the raw value for an empty list", () => {
    expect(chapterSelectState([], 4)).toEqual({ value: "4", selected: 0 });
  });
});

describe("filledChapterSelectState", () => {
  it("selects the first option", () => {
    expect(filledChapterSelectState(chapters)).toEqual({ value: "2", selected: 2 });
  });
  it("has an empty value and 0 for an empty list", () => {
    expect(filledChapterSelectState([])).toEqual({ value: "", selected: 0 });
  });
});

describe("createUiState", () => {
  it("starts with no chapters and a disabled select", () => {
    const state = createUiState();
    expect(state.chapters).toEqual([]);
    expect(state.chaptersEnabled).toBe(false);
    expect(state.chapterValue).toBe("");
  });
});
