// Pure view derivation. No DOM access here, so the unit tests run in Node.
import { SPEED_MAX, SPEED_MIN } from "../engine/config";
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
  /** `playback.hasLoaded()` */
  loaded: boolean;
  /** `audio.paused` */
  paused: boolean;
  /** `Date.now()`, passed in so the derivation stays pure. */
  now: number;
}

export type PrimaryState = "open" | "stop" | "pause" | "play" | "resume" | "listen";

export interface PrimaryView {
  state: PrimaryState;
  label: string;
  disabled: boolean;
}

const PRIMARY_LABELS: Record<PrimaryState, string> = {
  open: "Open an EPUB",
  stop: "Stop",
  pause: "Pause",
  play: "Play",
  resume: "Resume",
  listen: "Listen",
};

export interface ControlsView {
  primary: PrimaryView;
  /** "Listen from chapter start" is visible only in the resume state. */
  secondaryHidden: boolean;
  secondaryDisabled: boolean;
  /** The saved-position sub-line under the primary button shows only in the resume state. */
  savedHidden: boolean;
  voiceSelectDisabled: boolean;
  forgetHidden: boolean;
  forgetDisabled: boolean;
  fileInputDisabled: boolean;
  prevDisabled: boolean;
  nextDisabled: boolean;
  /** One button next to the voice select: Download when the voice is not stored, Remove when it is. */
  voiceAction: { kind: "download" | "remove"; label: string; disabled: boolean };
  voiceStatusText: string;
  /** True whenever the app generates, loads a voice or book, or switches chapter. Drives the activity bar. */
  busy: boolean;
  savedText: string;
  voiceValue: string;
  speedLabel: string;
  speedDownDisabled: boolean;
  speedUpDisabled: boolean;
  titleText: string;
  welcomeVisible: boolean;
}

/** The title of the chapter with this index, without the list number. Empty when there is none. */
export function chapterNameText(chapters: ReadonlyArray<ChapterInfo>, index: number): string {
  return chapters.find((c) => c.index === index)?.title ?? "";
}

function voiceStatusText(voices: Snapshot["voices"], voiceId: string): string {
  if (voices.busy) return voices.message;
  if (voices.error) return voices.error;
  if (voices.stored === undefined) return "Status unknown";
  if (voices.stored) return "Downloaded";
  const size = findVoice(voiceId)?.sizeMb ?? 61;
  return `Not downloaded (about ${Math.round(size)} MB)`;
}

/** "just now" under one minute, then "N min ago", "N h ago" and "N day(s) ago". Whole units, rounded down. */
export function relativeTimeText(savedAt: number, now: number): string {
  const minutes = Math.floor((now - savedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The header already names the chapter, so the sub-line gives only the age. Empty when there is no save. */
function savedText(saved: SavedPosition | undefined, now: number): string {
  if (!saved) return "";
  return `Saved ${relativeTimeText(saved.savedAt, now)}`;
}

/** The engine starts with "Idle." as its status. The UI shows nothing for it. */
export function statusText(status: string): string {
  return status === "Idle." ? "" : status;
}

/** First match wins: open, stop, pause, play, resume, listen. `wantPlaying` (not `paused`) avoids a flicker between segments. */
function primaryState(snapshot: Snapshot): PrimaryState {
  const { playback, book, saved, loaded } = snapshot;
  if (!book) return "open";
  if (playback.generating && !loaded) return "stop";
  if (loaded) return playback.wantPlaying ? "pause" : "play";
  if (saved && saved.bookId === book.id) return "resume";
  return "listen";
}

export function deriveView(snapshot: Snapshot): ControlsView {
  const { playback, voices, library, book, settings, saved, now } = snapshot;
  const locked = playback.generating || voices.busy || library.busy;
  const generateDisabled = locked || !book;
  const state = primaryState(snapshot);
  const disabled = state === "open" ? library.busy : state === "resume" || state === "listen" ? locked || !book : false;
  return {
    primary: { state, label: PRIMARY_LABELS[state], disabled },
    secondaryHidden: state !== "resume",
    secondaryDisabled: generateDisabled,
    savedHidden: state !== "resume",
    voiceSelectDisabled: voices.busy || library.busy,
    forgetHidden: !library.remembered,
    // Forget cancels a running generation first, so playing and paused do not block it.
    forgetDisabled: voices.busy || library.busy || playback.navigating,
    fileInputDisabled: library.busy,
    prevDisabled: voices.busy || library.busy || playback.navigating || !playback.hasPrev,
    nextDisabled: voices.busy || library.busy || playback.navigating || !playback.hasNext,
    voiceAction: voices.stored
      ? { kind: "remove", label: "Remove voice", disabled: locked }
      : { kind: "download", label: "Download voice", disabled: locked || voices.stored === undefined },
    voiceStatusText: voiceStatusText(voices, settings.voiceId),
    busy: locked || playback.navigating,
    savedText: savedText(saved, now),
    voiceValue: settings.voiceId,
    speedLabel: `${settings.speed.toFixed(2)}x`,
    speedDownDisabled: settings.speed <= SPEED_MIN,
    speedUpDisabled: settings.speed >= SPEED_MAX,
    titleText: book?.title ?? "",
    welcomeVisible: !book,
  };
}
