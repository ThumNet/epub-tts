import { describe, expect, it } from "vitest";
import { chapterInfo, splitSentences } from "../../src/epub";

describe("chapterInfo", () => {
  it("keeps the trimmed title and numbers only the picker label", () => {
    expect(chapterInfo(9, "  CHAPTER ONE ")).toEqual({ index: 9, label: "10. CHAPTER ONE", title: "CHAPTER ONE" });
  });

  it("falls back to (no title) for a missing or empty title", () => {
    expect(chapterInfo(0, undefined)).toEqual({ index: 0, label: "1. (no title)", title: "(no title)" });
    expect(chapterInfo(1, "   ")).toEqual({ index: 1, label: "2. (no title)", title: "(no title)" });
  });
});

describe("splitSentences", () => {
  it("splits a paragraph into sentences and marks the paragraph end", () => {
    expect(splitSentences(["One. Two! Three?"], "en")).toEqual([
      { text: "One.", paragraphEnd: false },
      { text: "Two!", paragraphEnd: false },
      { text: "Three?", paragraphEnd: true },
    ]);
  });

  it("marks the last sentence of every paragraph", () => {
    const out = splitSentences(["A b.", "C d. E f."], "en");
    expect(out.map((s) => s.paragraphEnd)).toEqual([true, false, true]);
  });

  it("drops paragraphs without a letter or digit, and keeps trailing punctuation with the sentence", () => {
    expect(splitSentences(["Hello. ... ", "***"], "en")).toEqual([{ text: "Hello. ...", paragraphEnd: true }]);
    expect(splitSentences(["***", "---"], "en")).toEqual([]);
  });

  it("falls back to English for an invalid language tag", () => {
    expect(splitSentences(["Hi there."], "not a tag!")).toEqual([{ text: "Hi there.", paragraphEnd: true }]);
  });

  it("returns an empty array for no paragraphs", () => {
    expect(splitSentences([], "en")).toEqual([]);
  });
});
