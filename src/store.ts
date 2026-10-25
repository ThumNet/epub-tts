const POSITION_KEY = "epub-tts:position";
const GENERATION_KEY = "epub-tts:generation";

export interface SavedPosition {
  /** File name and size identify the book. */
  bookId: string;
  bookTitle: string;
  chapterIndex: number;
  charLimit: number;
  sentenceIndex: number;
  seconds: number;
  savedAt: number;
}

export interface GenerationMarker {
  chapterIndex: number;
  done: number;
  total: number;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function savePosition(position: SavedPosition): void {
  localStorage.setItem(POSITION_KEY, JSON.stringify(position));
}

export function loadPosition(): SavedPosition | undefined {
  const raw = localStorage.getItem(POSITION_KEY);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    const { bookId, bookTitle, chapterIndex, charLimit, sentenceIndex, seconds, savedAt } = value;
    if (
      typeof bookId === "string" &&
      typeof bookTitle === "string" &&
      typeof chapterIndex === "number" &&
      typeof charLimit === "number" &&
      typeof sentenceIndex === "number" &&
      typeof seconds === "number" &&
      typeof savedAt === "number"
    ) {
      return { bookId, bookTitle, chapterIndex, charLimit, sentenceIndex, seconds, savedAt };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Written while generating. A leftover marker at start-up means the tab died during generation. */
export function setGenerationMarker(marker: GenerationMarker | undefined): void {
  if (marker) localStorage.setItem(GENERATION_KEY, JSON.stringify(marker));
  else localStorage.removeItem(GENERATION_KEY);
}

export function loadGenerationMarker(): GenerationMarker | undefined {
  const raw = localStorage.getItem(GENERATION_KEY);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    const { chapterIndex, done, total, at } = value;
    if (
      typeof chapterIndex === "number" &&
      typeof done === "number" &&
      typeof total === "number" &&
      typeof at === "number"
    ) {
      return { chapterIndex, done, total, at };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
