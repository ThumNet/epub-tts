import { SPEED_MAX, SPEED_MIN } from "./config";

/** The part of a segment that `sentenceIn` reads. */
export interface TimedSegment {
  /** Chapter-level index of the first sentence in the segment. */
  startSentence: number;
  timings: ReadonlyArray<{ start: number }>;
}

/** The part of a segment that `segmentForSentence` reads. */
export interface SentenceRange {
  startSentence: number;
  count: number;
}

/** Chapter-level sentence index playing at `seconds` in the segment. Binary search over the timings. */
export function sentenceIn(segment: TimedSegment, seconds: number): number {
  const timings = segment.timings;
  let low = 0;
  let high = timings.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const timing = timings[mid];
    if (timing && timing.start <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return segment.startSentence + found;
}

/** Index of the segment that holds the sentence, or -1 when no generated segment holds it. */
export function segmentForSentence(segments: ReadonlyArray<SentenceRange>, index: number): number {
  return segments.findIndex((s) => index >= s.startSentence && index < s.startSentence + s.count);
}

/**
 * Ready segments ahead of the playing one.
 * `loadedLength` is undefined when no chapter is loaded. Then the result is 0.
 * Without `pendingLength`, the result counts the rest of the loaded chapter.
 * With `pendingLength`, it adds all pending segments to that.
 */
export function segmentsAhead(loadedLength: number | undefined, current: number, pendingLength?: number): number {
  if (loadedLength === undefined) return 0;
  const rest = loadedLength - 1 - current;
  return pendingLength === undefined ? rest : rest + pendingLength;
}

/**
 * Indices outside [current - behind, current + ahead], in ascending order.
 * The current segment is never in the result.
 */
export function farSegments(count: number, current: number, behind: number, ahead: number): number[] {
  const far: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index === current) continue;
    if (index < current - behind || index > current + ahead) far.push(index);
  }
  return far;
}

export interface PlayingChapterFlags {
  generating: boolean;
  awaitingFirstSegment: boolean;
  generatingChapterIndex: number | undefined;
  /** Chapter index of the loaded chapter, undefined when none is loaded. */
  loadedChapterIndex: number | undefined;
}

/**
 * The chapter that is playing or starting. Before the first segment of a running generation loads,
 * that is the chapter being generated. Otherwise it is the loaded chapter. Undefined when neither exists.
 */
export function playingChapterIndex(flags: PlayingChapterFlags): number | undefined {
  if (flags.generating && flags.awaitingFirstSegment && flags.generatingChapterIndex !== undefined) {
    return flags.generatingChapterIndex;
  }
  return flags.loadedChapterIndex ?? (flags.generating ? flags.generatingChapterIndex : undefined);
}

/**
 * True when a chapter before (`step` -1) or after (`step` 1) `from` may have text. A chapter that is
 * not scanned yet counts as maybe. Once the scan has checked it, only chapters with text count.
 * `chapterCount` is the number of chapters in the book. It can be larger than `flags.length`.
 */
export function hasTextChapter(
  flags: ReadonlyArray<boolean | undefined>,
  chapterCount: number,
  from: number,
  step: 1 | -1,
): boolean {
  if (!Number.isInteger(from)) return false;
  for (let index = from + step; index >= 0 && index < chapterCount; index += step) {
    if (flags[index] !== false) return true;
  }
  return false;
}

export function clampSpeed(value: number): number {
  return Math.min(Math.max(value, SPEED_MIN), SPEED_MAX);
}

/** Clamp to the speed range, then round to two decimals. */
export function roundSpeed(value: number): number {
  return Math.round(clampSpeed(value) * 100) / 100;
}

export const SPEED_STEP = 0.05;

/** One button press: move by SPEED_STEP from the current value, then clamp and round (rounding removes float drift). An off-grid start stays off-grid. */
export function stepSpeed(current: number, direction: 1 | -1): number {
  return roundSpeed(current + direction * SPEED_STEP);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Plain progress text for the status line. `done` is the 1-based number of the sentence just generated. */
export function describeProgress(done: number, total: number, playing: boolean): string {
  return playing ? `Sentence ${done} of ${total}` : `Preparing audio, sentence ${done} of ${total}`;
}

/** The title for the lock screen. Never a list number. */
export function chapterTitle(chapter: { title: string } | undefined): string {
  const title = chapter?.title.trim() ?? "";
  return title === "" ? "(no title)" : title;
}
