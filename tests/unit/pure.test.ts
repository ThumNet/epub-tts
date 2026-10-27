import { describe, expect, it } from "vitest";
import {
  clampSpeed,
  chapterTitle,
  describeProgress,
  farSegments,
  hasTextChapter,
  playingChapterIndex,
  roundSpeed,
  segmentForSentence,
  segmentsAhead,
  sentenceIn,
  stepSpeed,
} from "../../src/engine/pure";

describe("describeProgress", () => {
  it("says preparing while nothing plays", () => {
    expect(describeProgress(52, 341, false)).toBe("Preparing audio, sentence 52 of 341");
  });

  it("is plain once a segment is loaded", () => {
    expect(describeProgress(52, 341, true)).toBe("Sentence 52 of 341");
  });
});

describe("sentenceIn", () => {
  const segment = {
    startSentence: 10,
    timings: [{ start: 0 }, { start: 2 }, { start: 5 }, { start: 9 }],
  };

  it("returns the start sentence before the first timing", () => {
    expect(sentenceIn(segment, -1)).toBe(10);
    expect(sentenceIn({ startSentence: 4, timings: [{ start: 3 }] }, 1)).toBe(4);
  });

  it("returns the start sentence at time 0", () => {
    expect(sentenceIn(segment, 0)).toBe(10);
  });

  it("switches sentence exactly on a boundary", () => {
    expect(sentenceIn(segment, 1.999)).toBe(10);
    expect(sentenceIn(segment, 2)).toBe(11);
    expect(sentenceIn(segment, 4.99)).toBe(11);
    expect(sentenceIn(segment, 5)).toBe(12);
  });

  it("returns the last sentence past the last timing", () => {
    expect(sentenceIn(segment, 9)).toBe(13);
    expect(sentenceIn(segment, 1000)).toBe(13);
  });

  it("returns the start sentence when there are no timings", () => {
    expect(sentenceIn({ startSentence: 7, timings: [] }, 5)).toBe(7);
  });
});

describe("segmentForSentence", () => {
  const segments = [
    { startSentence: 0, count: 3 },
    { startSentence: 3, count: 4 },
    { startSentence: 7, count: 2 },
  ];

  it("finds a sentence in the first segment", () => {
    expect(segmentForSentence(segments, 0)).toBe(0);
    expect(segmentForSentence(segments, 2)).toBe(0);
  });

  it("finds a sentence in a middle segment, including the edges", () => {
    expect(segmentForSentence(segments, 3)).toBe(1);
    expect(segmentForSentence(segments, 6)).toBe(1);
    expect(segmentForSentence(segments, 7)).toBe(2);
  });

  it("returns -1 for a sentence that is not generated", () => {
    expect(segmentForSentence(segments, 9)).toBe(-1);
    expect(segmentForSentence(segments, -1)).toBe(-1);
    expect(segmentForSentence([], 0)).toBe(-1);
  });
});

describe("segmentsAhead", () => {
  it("counts the rest of the loaded chapter", () => {
    expect(segmentsAhead(5, 1)).toBe(3);
    expect(segmentsAhead(5, 4)).toBe(0);
    expect(segmentsAhead(1, 0)).toBe(0);
  });

  it("adds the pending segments", () => {
    expect(segmentsAhead(5, 1, 2)).toBe(5);
    expect(segmentsAhead(5, 4, 0)).toBe(0);
  });

  it("returns 0 when nothing is loaded", () => {
    expect(segmentsAhead(undefined, 0)).toBe(0);
    expect(segmentsAhead(undefined, 0, 3)).toBe(0);
  });
});

describe("farSegments", () => {
  it("keeps the window [current - behind, current + ahead]", () => {
    expect(farSegments(10, 5, 3, 2)).toEqual([0, 1, 8, 9]);
    expect(farSegments(10, 4, 3, 2)).toEqual([0, 7, 8, 9]);
  });

  it("includes the index just outside each edge", () => {
    expect(farSegments(20, 10, 3, 2)).toEqual([0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("never drops the current segment", () => {
    expect(farSegments(10, 5, 0, 0)).not.toContain(5);
    expect(farSegments(10, 5, 0, 0)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
  });

  it("returns nothing when every segment is in the window", () => {
    expect(farSegments(4, 1, 3, 2)).toEqual([]);
    expect(farSegments(0, 0, 3, 2)).toEqual([]);
  });
});

describe("playingChapterIndex", () => {
  it("uses the generating chapter while awaiting the first segment", () => {
    expect(
      playingChapterIndex({
        generating: true,
        awaitingFirstSegment: true,
        generatingChapterIndex: 4,
        loadedChapterIndex: 2,
      }),
    ).toBe(4);
  });

  it("uses the loaded chapter once a segment is loaded", () => {
    expect(
      playingChapterIndex({
        generating: true,
        awaitingFirstSegment: false,
        generatingChapterIndex: 4,
        loadedChapterIndex: 2,
      }),
    ).toBe(2);
  });

  it("uses the generating chapter when generating without a loaded chapter", () => {
    expect(
      playingChapterIndex({
        generating: true,
        awaitingFirstSegment: false,
        generatingChapterIndex: 4,
        loadedChapterIndex: undefined,
      }),
    ).toBe(4);
  });

  it("returns undefined when idle and nothing is loaded", () => {
    expect(
      playingChapterIndex({
        generating: false,
        awaitingFirstSegment: false,
        generatingChapterIndex: 4,
        loadedChapterIndex: undefined,
      }),
    ).toBeUndefined();
  });

  it("uses the loaded chapter when idle", () => {
    expect(
      playingChapterIndex({
        generating: false,
        awaitingFirstSegment: false,
        generatingChapterIndex: undefined,
        loadedChapterIndex: 3,
      }),
    ).toBe(3);
  });

  it("ignores awaitingFirstSegment when not generating", () => {
    expect(
      playingChapterIndex({
        generating: false,
        awaitingFirstSegment: true,
        generatingChapterIndex: 4,
        loadedChapterIndex: 1,
      }),
    ).toBe(1);
  });
});

describe("hasTextChapter", () => {
  it("counts an unchecked chapter as maybe", () => {
    expect(hasTextChapter([undefined, undefined, undefined], 3, 1, 1)).toBe(true);
    expect(hasTextChapter([], 3, 0, 1)).toBe(true);
    expect(hasTextChapter([false, undefined], 2, 1, -1)).toBe(false);
  });

  it("skips checked empty chapters and finds the first one with text", () => {
    expect(hasTextChapter([true, false, false, true], 4, 0, 1)).toBe(true);
    expect(hasTextChapter([true, false, false, false], 4, 0, 1)).toBe(false);
    expect(hasTextChapter([true, false, true], 3, 2, -1)).toBe(true);
  });

  it("returns false when every chapter in that direction is empty", () => {
    expect(hasTextChapter([false, false, false], 3, 1, 1)).toBe(false);
    expect(hasTextChapter([false, false, false], 3, 1, -1)).toBe(false);
  });

  it("returns false at the ends of the book", () => {
    expect(hasTextChapter([true, true], 2, 1, 1)).toBe(false);
    expect(hasTextChapter([true, true], 2, 0, -1)).toBe(false);
  });

  it("returns false for a non-integer or NaN start", () => {
    expect(hasTextChapter([true, true, true], 3, 0.5, 1)).toBe(false);
    expect(hasTextChapter([true, true, true], 3, Number.NaN, 1)).toBe(false);
  });

  it("scans up to the chapter count, not the flag length", () => {
    expect(hasTextChapter([true], 3, 0, 1)).toBe(true);
    expect(hasTextChapter([true], 1, 0, 1)).toBe(false);
  });
});

describe("clampSpeed and roundSpeed", () => {
  it("clamps below the minimum and above the maximum", () => {
    expect(clampSpeed(0.1)).toBe(0.75);
    expect(clampSpeed(5)).toBe(2);
  });

  it("keeps values inside the range, edges included", () => {
    expect(clampSpeed(0.75)).toBe(0.75);
    expect(clampSpeed(1.234)).toBe(1.234);
    expect(clampSpeed(2)).toBe(2);
  });

  it("rounds to two decimals after clamping", () => {
    expect(roundSpeed(1.234)).toBe(1.23);
    expect(roundSpeed(1.236)).toBe(1.24);
    expect(roundSpeed(0.1)).toBe(0.75);
    expect(roundSpeed(9)).toBe(2);
  });
});

describe("stepSpeed", () => {
  it("moves by 0.05 in both directions", () => {
    expect(stepSpeed(1, 1)).toBe(1.05);
    expect(stepSpeed(1, -1)).toBe(0.95);
  });

  it("clamps at both limits", () => {
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.75, -1)).toBe(0.75);
    expect(stepSpeed(1.98, 1)).toBe(2);
    expect(stepSpeed(0.78, -1)).toBe(0.75);
  });

  it("steps from an off-grid saved speed without snapping", () => {
    expect(stepSpeed(1.37, 1)).toBe(1.42);
    expect(stepSpeed(1.37, -1)).toBe(1.32);
  });

  it("does not drift over repeated presses", () => {
    let speed = 1;
    for (let press = 0; press < 20; press += 1) speed = stepSpeed(speed, 1);
    expect(speed).toBe(2);
    for (let press = 0; press < 25; press += 1) speed = stepSpeed(speed, -1);
    expect(speed).toBe(0.75);
  });
});

describe("chapterTitle", () => {
  it("returns the title without a list number", () => {
    expect(chapterTitle({ title: "CHAPTER ONE" })).toBe("CHAPTER ONE");
  });

  it("falls back to (no title) for a missing chapter or a blank title", () => {
    expect(chapterTitle(undefined)).toBe("(no title)");
    expect(chapterTitle({ title: "  " })).toBe("(no title)");
  });
});
