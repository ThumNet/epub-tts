import { describe, expect, it } from "vitest";
import { joinClips } from "../../src/wav";

describe("joinClips", () => {
  const rate = 1000;
  const clips = [
    { sampleRate: rate, pcm: new Int16Array(500).fill(1) },
    { sampleRate: rate, pcm: new Int16Array(250).fill(2) },
    { sampleRate: rate, pcm: new Int16Array(100).fill(3) },
  ];

  it("places timings after the gaps and sums the duration", () => {
    const chapter = joinClips(clips, [200, 100, 50]);
    expect(chapter.timings).toEqual([
      { start: 0, end: 0.5 },
      { start: 0.7, end: 0.95 },
      { start: 1.05, end: 1.15 },
    ]);
    expect(chapter.duration).toBeCloseTo(1.2, 10);
  });

  it("writes a 44-byte header plus the PCM bytes", () => {
    const chapter = joinClips(clips, [200, 100, 50]);
    const totalSamples = 850 + 200 + 100 + 50;
    expect(chapter.blob.size).toBe(44 + totalSamples * 2);
  });

  it("treats a missing gap as zero", () => {
    const chapter = joinClips(clips, []);
    expect(chapter.duration).toBeCloseTo(0.85, 10);
    expect(chapter.blob.size).toBe(44 + 850 * 2);
  });

  it("throws without clips", () => {
    expect(() => joinClips([], [])).toThrow("No clips to join.");
  });
});
