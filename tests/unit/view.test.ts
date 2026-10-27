import { describe, expect, it } from "vitest";
import { chapterNameText, deriveView, relativeTimeText, statusText, type Snapshot } from "../../src/ui/view";

const NOW = 100_000;

type Playback = Snapshot["playback"];
const pb = (overrides: Partial<Playback> = {}): Playback => ({
  generating: false,
  navigating: false,
  wantPlaying: false,
  navigationBase: 0,
  hasPrev: true,
  hasNext: true,
  voicesInUse: [],
  ...overrides,
});

const KRISTIN = "en_US-kristin-medium";
type Voices = Snapshot["voices"];
const vs = (overrides: Partial<Voices> = {}): Voices => ({
  busy: false,
  stored: true,
  storedIds: [KRISTIN],
  message: "",
  error: "",
  ...overrides,
});

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    playback: pb(),
    voices: vs(),
    library: { busy: false, remembered: true },
    book: { id: "a.epub:10", title: "Book A" },
    settings: { voiceId: "en_US-kristin-medium", speed: 1 },
    saved: undefined,
    loaded: false,
    paused: true,
    now: NOW,
    ...overrides,
  };
}

const savedFor = (bookId: string): NonNullable<Snapshot["saved"]> => ({
  bookId,
  bookTitle: "Book A",
  chapterIndex: 1,
  charLimit: 0,
  sentenceIndex: 4,
  seconds: 75,
  savedAt: NOW - 3000,
});

describe("deriveView: primary state and rule order", () => {
  const same = savedFor("a.epub:10");
  it.each([
    ["open without a book", snap({ book: undefined }), "open", "Open an EPUB"],
    ["listen with a book and no save", snap(), "listen", "Listen"],
    ["listen when the save is for another book", snap({ saved: savedFor("b.epub:20") }), "listen", "Listen"],
    ["resume when the save is for this book", snap({ saved: same }), "resume", "Resume"],
    ["stop while generating with nothing loaded", snap({ playback: pb({ generating: true }) }), "stop", "Stop"],
    ["pause when loaded and wantPlaying", snap({ loaded: true, playback: pb({ wantPlaying: true }) }), "pause", "Pause"],
    ["play when loaded and not wantPlaying", snap({ loaded: true }), "play", "Play"],
  ] as const)("%s", (_name, snapshot, state, label) => {
    const { primary } = deriveView(snapshot);
    expect(primary.state).toBe(state);
    expect(primary.label).toBe(label);
  });

  it("open wins over everything else", () => {
    const view = deriveView(snap({ book: undefined, loaded: true, saved: same, playback: pb({ generating: true, wantPlaying: true }) }));
    expect(view.primary.state).toBe("open");
  });
  it("stop wins over a matching save", () => {
    expect(deriveView(snap({ saved: same, playback: pb({ generating: true }) })).primary.state).toBe("stop");
  });
  it("loaded wins over a matching save", () => {
    expect(deriveView(snap({ saved: same, loaded: true })).primary.state).toBe("play");
    expect(deriveView(snap({ saved: same, loaded: true, playback: pb({ wantPlaying: true }) })).primary.state).toBe("pause");
  });
  it("a loaded chapter with generation running shows pause or play, so Stop is unreachable", () => {
    const generating = pb({ generating: true });
    expect(deriveView(snap({ loaded: true, playback: generating })).primary.state).toBe("play");
    expect(deriveView(snap({ loaded: true, playback: { ...generating, wantPlaying: true } })).primary.state).toBe("pause");
  });
  it("uses wantPlaying, not audio.paused, so a segment gap does not flip pause to play", () => {
    const view = deriveView(snap({ loaded: true, paused: true, playback: pb({ wantPlaying: true }) }));
    expect(view.primary.state).toBe("pause");
  });

  it("disables listen and resume when locked, never stop, pause or play", () => {
    const voicesBusy = vs({ busy: true, message: "x" });
    expect(deriveView(snap({ voices: voicesBusy })).primary.disabled).toBe(true);
    expect(deriveView(snap({ voices: voicesBusy, saved: same })).primary.disabled).toBe(true);
    expect(deriveView(snap({ library: { busy: true, remembered: true } })).primary.disabled).toBe(true);
    expect(deriveView(snap({ voices: voicesBusy, playback: pb({ generating: true }) })).primary.disabled).toBe(false);
    expect(deriveView(snap({ voices: voicesBusy, loaded: true, playback: pb({ voicesInUse: [KRISTIN] }) })).primary.disabled).toBe(false);
    expect(deriveView(snap({ library: { busy: true, remembered: true }, loaded: true, playback: pb({ wantPlaying: true }) })).primary.disabled).toBe(false);
  });
  it("enables listen and resume when idle", () => {
    expect(deriveView(snap()).primary.disabled).toBe(false);
    expect(deriveView(snap({ saved: same })).primary.disabled).toBe(false);
  });
  it("disables open only while the library is busy", () => {
    expect(deriveView(snap({ book: undefined })).primary.disabled).toBe(false);
    expect(deriveView(snap({ book: undefined, library: { busy: true, remembered: false } })).primary.disabled).toBe(true);
  });

  it("shows the secondary button and the saved sub-line only in resume", () => {
    const resume = deriveView(snap({ saved: same }));
    expect(resume.secondaryHidden).toBe(false);
    expect(resume.savedHidden).toBe(false);
    for (const snapshot of [snap(), snap({ book: undefined }), snap({ loaded: true }), snap({ saved: same, loaded: true }), snap({ playback: pb({ generating: true }) })]) {
      const view = deriveView(snapshot);
      expect(view.secondaryHidden).toBe(true);
      expect(view.savedHidden).toBe(true);
    }
  });
  it("disables the secondary button like Listen: locked or no book", () => {
    expect(deriveView(snap({ saved: same })).secondaryDisabled).toBe(false);
    expect(deriveView(snap({ saved: same, voices: vs({ busy: true }) })).secondaryDisabled).toBe(true);
    expect(deriveView(snap({ saved: same, library: { busy: true, remembered: true } })).secondaryDisabled).toBe(true);
    expect(deriveView(snap({ book: undefined })).secondaryDisabled).toBe(true);
  });
});

describe("deriveView: locks", () => {
  it("is unlocked when idle", () => {
    const view = deriveView(snap({ saved: savedFor("a.epub:10") }));
    expect(view.voiceSelectDisabled).toBe(false);
    expect(view.forgetDisabled).toBe(false);
  });

  it.each([
    ["voices.busy", snap({ voices: vs({ busy: true, message: "x" }), saved: savedFor("a.epub:10") })],
    ["library.busy", snap({ library: { busy: true, remembered: true }, saved: savedFor("a.epub:10") })],
  ])("locks voice select, voice action and Forget when %s", (_name, snapshot) => {
    const view = deriveView(snapshot);
    expect(view.voiceSelectDisabled).toBe(true);
    expect(view.voiceAction.disabled).toBe(true);
    expect(view.forgetDisabled).toBe(true);
  });

  it("keeps the voice select, Forget and the voice action enabled while generating", () => {
    const view = deriveView(snap({ playback: pb({ generating: true }), loaded: true, saved: savedFor("a.epub:10") }));
    expect(view.voiceSelectDisabled).toBe(false);
    expect(view.forgetDisabled).toBe(false);
    expect(view.voiceAction.disabled).toBe(false);
  });

  it("disables the file input only while the library is busy", () => {
    expect(deriveView(snap({ library: { busy: true, remembered: false } })).fileInputDisabled).toBe(true);
    expect(deriveView(snap({ voices: vs({ busy: true }) })).fileInputDisabled).toBe(false);
  });
});

describe("deriveView: forget", () => {
  it("is hidden when nothing is remembered", () => {
    expect(deriveView(snap({ library: { busy: false, remembered: false } })).forgetHidden).toBe(true);
    expect(deriveView(snap()).forgetHidden).toBe(false);
  });
  it("stays enabled while audio plays and while paused with generation running", () => {
    expect(deriveView(snap({ paused: false, loaded: true, playback: pb({ generating: true, wantPlaying: true }) })).forgetDisabled).toBe(false);
    expect(deriveView(snap({ paused: true, loaded: true, playback: pb({ generating: true }) })).forgetDisabled).toBe(false);
  });
  it("is disabled while navigating", () => {
    const navigating = pb({ navigating: true });
    expect(deriveView(snap({ playback: navigating })).forgetDisabled).toBe(true);
  });
});

describe("deriveView: busy", () => {
  it("is false when idle and true for generating, navigating, voices busy or library busy", () => {
    expect(deriveView(snap()).busy).toBe(false);
    expect(deriveView(snap({ playback: pb({ generating: true }) })).busy).toBe(true);
    expect(deriveView(snap({ playback: pb({ navigating: true }) })).busy).toBe(true);
    expect(deriveView(snap({ voices: vs({ busy: true }) })).busy).toBe(true);
    expect(deriveView(snap({ library: { busy: true, remembered: true } })).busy).toBe(true);
  });
});

describe("deriveView: previous and next", () => {
  it("follow hasPrev and hasNext", () => {
    const edge = pb({ hasPrev: false });
    const view = deriveView(snap({ playback: edge }));
    expect(view.prevDisabled).toBe(true);
    expect(view.nextDisabled).toBe(false);
  });
  it("disable Next at the end of the book and leave Previous enabled", () => {
    const end = pb({ hasNext: false });
    const view = deriveView(snap({ playback: end }));
    expect(view.nextDisabled).toBe(true);
    expect(view.prevDisabled).toBe(false);
  });
  it("enable both when hasPrev and hasNext are true and nothing locks them", () => {
    const view = deriveView(snap());
    expect(view.prevDisabled).toBe(false);
    expect(view.nextDisabled).toBe(false);
  });
  it("disable both with a single chapter (hasPrev and hasNext false)", () => {
    const only = pb({ hasPrev: false, hasNext: false });
    const view = deriveView(snap({ playback: only }));
    expect(view.prevDisabled).toBe(true);
    expect(view.nextDisabled).toBe(true);
  });
  it("are disabled while navigating, voices are busy or the library is busy", () => {
    const navigating = pb({ navigating: true });
    expect(deriveView(snap({ playback: navigating })).prevDisabled).toBe(true);
    expect(deriveView(snap({ playback: navigating })).nextDisabled).toBe(true);
    const voicesBusy = snap({ voices: vs({ busy: true }) });
    expect(deriveView(voicesBusy).prevDisabled).toBe(true);
    expect(deriveView(voicesBusy).nextDisabled).toBe(true);
    const libraryBusy = snap({ library: { busy: true, remembered: true } });
    expect(deriveView(libraryBusy).prevDisabled).toBe(true);
    expect(deriveView(libraryBusy).nextDisabled).toBe(true);
  });
  it("stay enabled while generating (they only wait on navigation and busy flags)", () => {
    const generating = pb({ generating: true });
    const view = deriveView(snap({ playback: generating }));
    expect(view.prevDisabled).toBe(false);
    expect(view.nextDisabled).toBe(false);
  });
});

describe("deriveView: voice action and status", () => {
  const other = "en_US-john-medium";
  it("is Download, enabled, when the voice is not stored", () => {
    const view = deriveView(snap({ voices: vs({ stored: false, storedIds: [] }) }));
    expect(view.voiceAction).toEqual({ kind: "download", label: "Download voice", disabled: false });
  });
  it("is Remove, enabled, when the voice is stored", () => {
    expect(deriveView(snap()).voiceAction).toEqual({ kind: "remove", label: "Remove voice", disabled: false });
  });
  it("is a disabled Download when the status is unknown", () => {
    const view = deriveView(snap({ voices: vs({ stored: undefined, storedIds: undefined }) }));
    expect(view.voiceAction).toEqual({ kind: "download", label: "Download voice", disabled: true });
  });

  it("allows Download while generating, playing and paused", () => {
    const voices = vs({ stored: false, storedIds: [] });
    const generating = deriveView(snap({ voices, playback: pb({ generating: true, voicesInUse: [other] }) }));
    expect(generating.voiceAction.disabled).toBe(false);
    const playing = deriveView(snap({ voices, loaded: true, playback: pb({ wantPlaying: true, voicesInUse: [other] }) }));
    expect(playing.voiceAction.disabled).toBe(false);
    const paused = deriveView(snap({ voices, loaded: true, playback: pb({ voicesInUse: [other] }) }));
    expect(paused.voiceAction.disabled).toBe(false);
  });
  it("allows Remove of a voice that is not in use while generating, playing and paused", () => {
    const voices = vs({ storedIds: [KRISTIN, other] });
    for (const wantPlaying of [true, false]) {
      const view = deriveView(snap({ voices, loaded: true, playback: pb({ generating: true, wantPlaying, voicesInUse: [other] }) }));
      expect(view.voiceAction).toEqual({ kind: "remove", label: "Remove voice", disabled: false });
    }
  });
  it("disables Remove for the voice that the loaded chapter or the generation uses", () => {
    const loaded = deriveView(snap({ loaded: true, playback: pb({ voicesInUse: [KRISTIN] }) }));
    expect(loaded.voiceAction).toEqual({ kind: "remove", label: "Remove voice", disabled: true });
    const generating = deriveView(snap({ playback: pb({ generating: true, voicesInUse: [KRISTIN] }) }));
    expect(generating.voiceAction.disabled).toBe(true);
  });
  it("disables Download for the voice that the loaded chapter or the generation uses, but not for another voice", () => {
    const voices = vs({ stored: false, storedIds: [] });
    const inUse = pb({ generating: true, voicesInUse: [KRISTIN] });
    expect(deriveView(snap({ voices, playback: inUse })).voiceAction).toEqual({
      kind: "download",
      label: "Download voice",
      disabled: true,
    });
    expect(deriveView(snap({ voices, loaded: true, playback: pb({ voicesInUse: [KRISTIN] }) })).voiceAction.disabled).toBe(true);
    const another = deriveView(snap({ voices, settings: { voiceId: other, speed: 1 }, playback: inUse }));
    expect(another.voiceAction.disabled).toBe(false);
  });
  it("disables Download and Remove while a chapter change or a voice restart is in flight", () => {
    const download = vs({ stored: false, storedIds: [] });
    expect(deriveView(snap({ voices: download, playback: pb({ navigating: true }) })).voiceAction.disabled).toBe(true);
    expect(deriveView(snap({ voices: download })).voiceAction.disabled).toBe(false);
    expect(deriveView(snap({ playback: pb({ navigating: true }) })).voiceAction).toEqual({
      kind: "remove",
      label: "Remove voice",
      disabled: true,
    });
    expect(deriveView(snap()).voiceAction.disabled).toBe(false);
  });
  it("disables Play while a voice action runs and the selected voice is not the loaded one", () => {
    const loadedWith = (voicesInUse: string[], busy: boolean) =>
      deriveView(snap({ loaded: true, voices: vs({ busy, message: "Downloading 3%" }), playback: pb({ voicesInUse }) })).primary;
    expect(loadedWith([other], true)).toMatchObject({ state: "play", disabled: true });
    expect(loadedWith([KRISTIN], true).disabled).toBe(false);
    expect(loadedWith([other], false).disabled).toBe(false);
  });
  it("disables the action while a voice action or a library action runs", () => {
    expect(deriveView(snap({ voices: vs({ busy: true }) })).voiceAction.disabled).toBe(true);
    expect(deriveView(snap({ library: { busy: true, remembered: true } })).voiceAction.disabled).toBe(true);
  });

  it.each([
    ["busy shows the message", vs({ busy: true, stored: false, message: "Downloading 40%", error: "boom" }), "Downloading 40%"],
    ["error shows the error", vs({ error: "boom", message: "m" }), "boom"],
    ["unknown", vs({ stored: undefined, storedIds: undefined }), "Status unknown"],
    ["stored is empty", vs(), ""],
    ["not stored is empty", vs({ stored: false, storedIds: [] }), ""],
  ])("status text: %s", (_name, voices, expected) => {
    expect(deriveView(snap({ voices })).voiceStatusText).toBe(expected);
  });

  describe("options", () => {
    const textOf = (view: ReturnType<typeof deriveView>, id: string): string | undefined =>
      view.voiceOptions.find((option) => option.id === id)?.text;
    it("show only the label for stored voices and add the size hint to the others", () => {
      const view = deriveView(snap({ voices: vs({ storedIds: [KRISTIN] }) }));
      expect(view.voiceOptions).toHaveLength(5);
      expect(textOf(view, KRISTIN)).toBe("Kristin (US, female)");
      expect(textOf(view, other)).toBe("John (US, male) - 61 MB, not downloaded");
    });
    it("change when the stored list changes", () => {
      expect(textOf(deriveView(snap({ voices: vs({ storedIds: [KRISTIN, other] }) })), other)).toBe("John (US, male)");
      expect(textOf(deriveView(snap({ voices: vs({ storedIds: [KRISTIN] }) })), other)).toContain("not downloaded");
    });
    it("show plain labels when the storage is unknown", () => {
      const view = deriveView(snap({ voices: vs({ stored: undefined, storedIds: undefined }) }));
      expect(view.voiceOptions.every((option) => !option.text.includes("not downloaded"))).toBe(true);
    });
  });
});

describe("relativeTimeText", () => {
  const at = (ms: number): string => relativeTimeText(NOW - ms, NOW);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  it("says just now under one minute, including a save from the future", () => {
    expect(at(0)).toBe("just now");
    expect(at(59_999)).toBe("just now");
    expect(at(-5000)).toBe("just now");
  });
  it("counts whole minutes from one to 59", () => {
    expect(at(MIN)).toBe("1 min ago");
    expect(at(2 * MIN + 59_000)).toBe("2 min ago");
    expect(at(HOUR - 1)).toBe("59 min ago");
  });
  it("counts whole hours from one to 23", () => {
    expect(at(HOUR)).toBe("1 h ago");
    expect(at(5 * HOUR + 30 * MIN)).toBe("5 h ago");
    expect(at(24 * HOUR - 1)).toBe("23 h ago");
  });
  it("counts days with singular and plural", () => {
    expect(at(24 * HOUR)).toBe("1 day ago");
    expect(at(47 * HOUR)).toBe("1 day ago");
    expect(at(48 * HOUR)).toBe("2 days ago");
    expect(at(400 * 24 * HOUR)).toBe("400 days ago");
  });
});

describe("statusText", () => {
  it("hides the idle status and keeps every other message", () => {
    expect(statusText("Idle.")).toBe("");
    expect(statusText("Generating...")).toBe("Generating...");
    expect(statusText("")).toBe("");
  });
});

describe("deriveView: saved text", () => {
  it("is empty when nothing is saved", () => {
    expect(deriveView(snap()).savedText).toBe("");
  });
  it("shows only the age of the save", () => {
    expect(deriveView(snap({ saved: savedFor("a.epub:10") })).savedText).toBe("Saved just now");
    expect(deriveView(snap({ saved: { ...savedFor("a.epub:10"), savedAt: NOW - 120_000 } })).savedText).toBe(
      "Saved 2 min ago",
    );
  });
});

describe("deriveView: speed", () => {
  it("formats the label with two decimals", () => {
    expect(deriveView(snap({ settings: { voiceId: "x", speed: 1.35 } })).speedLabel).toBe("1.35x");
    expect(deriveView(snap({ settings: { voiceId: "x", speed: 2 } })).speedLabel).toBe("2.00x");
  });
  it("disables down at 0.75", () => {
    const view = deriveView(snap({ settings: { voiceId: "x", speed: 0.75 } }));
    expect(view.speedDownDisabled).toBe(true);
    expect(view.speedUpDisabled).toBe(false);
  });
  it("disables up at 2", () => {
    const view = deriveView(snap({ settings: { voiceId: "x", speed: 2 } }));
    expect(view.speedDownDisabled).toBe(false);
    expect(view.speedUpDisabled).toBe(true);
  });
  it("enables both between the limits", () => {
    const view = deriveView(snap({ settings: { voiceId: "x", speed: 1.35 } }));
    expect(view.speedDownDisabled).toBe(false);
    expect(view.speedUpDisabled).toBe(false);
  });
});

describe("deriveView: voice value", () => {
  it("is the voice id from settings", () => {
    expect(deriveView(snap({ settings: { voiceId: "en_US-ryan-high", speed: 1 } })).voiceValue).toBe("en_US-ryan-high");
  });
});

describe("deriveView: header and welcome", () => {
  it("shows the book title and hides the welcome when a book is open", () => {
    const view = deriveView(snap());
    expect(view.titleText).toBe("Book A");
    expect(view.welcomeVisible).toBe(false);
  });
  it("shows the welcome and no title without a book", () => {
    const view = deriveView(snap({ book: undefined }));
    expect(view.titleText).toBe("");
    expect(view.welcomeVisible).toBe(true);
  });
});

describe("chapterNameText", () => {
  const chapters = [
    { index: 0, label: "1. Cover", title: "Cover" },
    { index: 2, label: "3. Chapter Two", title: "Chapter Two" },
    { index: 3, label: "4. (no title)", title: "(no title)" },
    { index: 4, label: "5. 1. Intro", title: "1. Intro" },
  ];
  it("finds the title by chapter index, not by position", () => {
    expect(chapterNameText(chapters, 2)).toBe("Chapter Two");
  });
  it("shows the title without the list number and keeps the no-title fallback", () => {
    expect(chapterNameText(chapters, 3)).toBe("(no title)");
    expect(chapterNameText(chapters, 4)).toBe("1. Intro");
  });
  it("is empty for an unknown index or no chapters", () => {
    expect(chapterNameText(chapters, 1)).toBe("");
    expect(chapterNameText([], 0)).toBe("");
  });
});
