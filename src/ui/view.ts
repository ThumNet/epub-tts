// Pure view derivation. No DOM access here, so the unit tests run in Node.
import { SPEED_MAX, SPEED_MIN } from "../engine/config";
import { describePosition } from "../engine/pure";
import type { ChapterInfo } from "../epub";
import type { PlaybackView } from "../engine/playback";
import type { SavedPosition } from "../store";
import { findVoice } from "../voices";

/** Plain values read from the engine and the browser at one moment. */
export interface Snapshot {
  playback: PlaybackView;
  voices: { busy: boolean; stored: boolean | undefined; message: string; error: string };
  library: { busy: boolean; remembered: boolean };
  book: { id: string; title: string } | undefined;
  settings: { voiceId: string; speed: number };
  saved: SavedPosition | undefined;
  /** `audio.paused` */
  paused: boolean;
  /** `Date.now()`, passed in so the derivation stays pure. */
  now: number;
}

export interface ControlsView {
  generateDisabled: boolean;
  cancelDisabled: boolean;
  resumeDisabled: boolean;
  voiceSelectDisabled: boolean;
  forgetHidden: boolean;
  forgetDisabled: boolean;
  fileInputDisabled: boolean;
  prevDisabled: boolean;
  nextDisabled: boolean;
  voiceDownloadDisabled: boolean;
  voiceRemoveDisabled: boolean;
  voiceStatusText: string;
  savedText: string;
  voiceValue: string;
  speedLabel: string;
  speedDownDisabled: boolean;
  speedUpDisabled: boolean;
  titleText: string;
  welcomeVisible: boolean;
}

/** The label of the chapter with this index, or an empty string when there is none. */
export function chapterNameText(chapters: ReadonlyArray<ChapterInfo>, index: number): string {
  return chapters.find((c) => c.index === index)?.label ?? "";
}

function voiceStatusText(voices: Snapshot["voices"], voiceId: string): string {
  if (voices.busy) return voices.message;
  if (voices.error) return voices.error;
  if (voices.stored === undefined) return "Status unknown";
  if (voices.stored) return "Downloaded";
  const size = findVoice(voiceId)?.sizeMb ?? 61;
  return `Not downloaded (about ${Math.round(size)} MB)`;
}

function savedText(saved: SavedPosition | undefined, book: Snapshot["book"], now: number): string {
  if (!saved) return "No saved position.";
  const matches = book?.id === saved.bookId;
  return `${describePosition(saved, now)} ${matches ? "Press Resume saved position." : "Pick the same EPUB file to resume."}`;
}

export function deriveView(snapshot: Snapshot): ControlsView {
  const { playback, voices, library, book, settings, saved, paused, now } = snapshot;
  const locked = playback.generating || voices.busy || library.busy;
  return {
    generateDisabled: locked || !book,
    cancelDisabled: !playback.generating,
    resumeDisabled: locked || !saved || book?.id !== saved.bookId,
    voiceSelectDisabled: locked,
    forgetHidden: !library.remembered,
    forgetDisabled: locked || library.busy || playback.navigating || !paused,
    fileInputDisabled: library.busy,
    prevDisabled: voices.busy || library.busy || playback.navigating || !playback.hasPrev,
    nextDisabled: voices.busy || library.busy || playback.navigating || !playback.hasNext,
    voiceDownloadDisabled: locked || voices.stored !== false,
    voiceRemoveDisabled: locked || voices.stored !== true,
    voiceStatusText: voiceStatusText(voices, settings.voiceId),
    savedText: savedText(saved, book, now),
    voiceValue: settings.voiceId,
    speedLabel: `${settings.speed.toFixed(2)}x`,
    speedDownDisabled: settings.speed <= SPEED_MIN,
    speedUpDisabled: settings.speed >= SPEED_MAX,
    titleText: book?.title ?? "",
    welcomeVisible: !book,
  };
}
