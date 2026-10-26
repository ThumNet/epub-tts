import { describe, expect, it } from "vitest";
import { SEGMENT_TARGET_S, segmentTargetSeconds } from "../../src/engine/config";

describe("segmentTargetSeconds", () => {
  it("defaults to 60", () => {
    expect(SEGMENT_TARGET_S).toBe(60);
    expect(segmentTargetSeconds("", false)).toBe(60);
    expect(segmentTargetSeconds("", true)).toBe(60);
    expect(segmentTargetSeconds("?other=1", true)).toBe(60);
  });

  it("ignores the override when e2e is false", () => {
    expect(segmentTargetSeconds("?segmentSeconds=5", false)).toBe(60);
  });

  it("accepts a valid override when e2e is true", () => {
    expect(segmentTargetSeconds("?segmentSeconds=5", true)).toBe(5);
    expect(segmentTargetSeconds("?a=1&segmentSeconds=2.5", true)).toBe(2.5);
    expect(segmentTargetSeconds("segmentSeconds=7", true)).toBe(7);
  });

  it("falls back to 60 for 0, NaN, negative, infinite and empty values", () => {
    expect(segmentTargetSeconds("?segmentSeconds=0", true)).toBe(60);
    expect(segmentTargetSeconds("?segmentSeconds=abc", true)).toBe(60);
    expect(segmentTargetSeconds("?segmentSeconds=NaN", true)).toBe(60);
    expect(segmentTargetSeconds("?segmentSeconds=-5", true)).toBe(60);
    expect(segmentTargetSeconds("?segmentSeconds=Infinity", true)).toBe(60);
    expect(segmentTargetSeconds("?segmentSeconds=", true)).toBe(60);
  });
});
