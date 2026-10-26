import { describe, expect, it } from "vitest";
import { deriveView, type Snapshot } from "../../src/ui/view";

const NOW = 100_000;

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    playback: { generating: false, navigating: false, navigationBase: 0, hasPrev: true, hasNext: true },
    voices: { busy: false, stored: true, message: "", error: "" },
    library: { busy: false, remembered: true },
    book: { id: "a.epub:10", title: "Book A" },
    settings: { voiceId: "en_US-kristin-medium", speed: 1 },
    saved: undefined,
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

describe("deriveView: locks", () => {
  it("is unlocked when idle", () => {
    const view = deriveView(snap({ saved: savedFor("a.epub:10") }));
    expect(view.generateDisabled).toBe(false);
    expect(view.resumeDisabled).toBe(false);
    expect(view.voiceSelectDisabled).toBe(false);
    expect(view.forgetDisabled).toBe(false);
    expect(view.cancelDisabled).toBe(true);
  });

  it.each([
    ["generating", snap({ playback: { generating: true, navigating: false, navigationBase: 0, hasPrev: true, hasNext: true }, saved: savedFor("a.epub:10") })],
    ["voices.busy", snap({ voices: { busy: true, stored: true, message: "x", error: "" }, saved: savedFor("a.epub:10") })],
    ["library.busy", snap({ library: { busy: true, remembered: true }, saved: savedFor("a.epub:10") })],
  ])("locks generate, resume, voice select and voice buttons when %s", (_name, snapshot) => {
    const view = deriveView(snapshot);
    expect(view.generateDisabled).toBe(true);
    expect(view.resumeDisabled).toBe(true);
    expect(view.voiceSelectDisabled).toBe(true);
    expect(view.voiceDownloadDisabled).toBe(true);
    expect(view.voiceRemoveDisabled).toBe(true);
    expect(view.forgetDisabled).toBe(true);
  });

  it("enables cancel only while generating", () => {
    const generating = { generating: true, navigating: false, navigationBase: 0, hasPrev: true, hasNext: true };
    expect(deriveView(snap({ playback: generating })).cancelDisabled).toBe(false);
    expect(deriveView(snap()).cancelDisabled).toBe(true);
  });

  it("disables generate without an open book", () => {
    expect(deriveView(snap({ book: undefined })).generateDisabled).toBe(true);
  });

  it("disables the file input only while the library is busy", () => {
    expect(deriveView(snap({ library: { busy: true, remembered: false } })).fileInputDisabled).toBe(true);
    expect(deriveView(snap({ voices: { busy: true, stored: true, message: "", error: "" } })).fileInputDisabled).toBe(false);
  });
});

describe("deriveView: resume", () => {
  it("is disabled without a saved position", () => {
    expect(deriveView(snap()).resumeDisabled).toBe(true);
  });
  it("is disabled for another book", () => {
    expect(deriveView(snap({ saved: savedFor("b.epub:20") })).resumeDisabled).toBe(true);
  });
  it("is disabled without an open book", () => {
    expect(deriveView(snap({ book: undefined, saved: savedFor("a.epub:10") })).resumeDisabled).toBe(true);
  });
  it("is enabled for the same book", () => {
    expect(deriveView(snap({ saved: savedFor("a.epub:10") })).resumeDisabled).toBe(false);
  });
});

describe("deriveView: forget", () => {
  it("is hidden when nothing is remembered", () => {
    expect(deriveView(snap({ library: { busy: false, remembered: false } })).forgetHidden).toBe(true);
    expect(deriveView(snap()).forgetHidden).toBe(false);
  });
  it("is disabled while audio plays", () => {
    expect(deriveView(snap({ paused: false })).forgetDisabled).toBe(true);
  });
  it("is disabled while navigating", () => {
    const navigating = { generating: false, navigating: true, navigationBase: 0, hasPrev: true, hasNext: true };
    expect(deriveView(snap({ playback: navigating })).forgetDisabled).toBe(true);
  });
});

describe("deriveView: previous and next", () => {
  it("follow hasPrev and hasNext", () => {
    const edge = { generating: false, navigating: false, navigationBase: 0, hasPrev: false, hasNext: true };
    const view = deriveView(snap({ playback: edge }));
    expect(view.prevDisabled).toBe(true);
    expect(view.nextDisabled).toBe(false);
  });
  it("disable Next at the end of the book and leave Previous enabled", () => {
    const end = { generating: false, navigating: false, navigationBase: 0, hasPrev: true, hasNext: false };
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
    const only = { generating: false, navigating: false, navigationBase: 0, hasPrev: false, hasNext: false };
    const view = deriveView(snap({ playback: only }));
    expect(view.prevDisabled).toBe(true);
    expect(view.nextDisabled).toBe(true);
  });
  it("are disabled while navigating, voices are busy or the library is busy", () => {
    const navigating = { generating: false, navigating: true, navigationBase: 0, hasPrev: true, hasNext: true };
    expect(deriveView(snap({ playback: navigating })).prevDisabled).toBe(true);
    expect(deriveView(snap({ playback: navigating })).nextDisabled).toBe(true);
    const voicesBusy = snap({ voices: { busy: true, stored: true, message: "", error: "" } });
    expect(deriveView(voicesBusy).prevDisabled).toBe(true);
    expect(deriveView(voicesBusy).nextDisabled).toBe(true);
    const libraryBusy = snap({ library: { busy: true, remembered: true } });
    expect(deriveView(libraryBusy).prevDisabled).toBe(true);
    expect(deriveView(libraryBusy).nextDisabled).toBe(true);
  });
  it("stay enabled while generating (they only wait on navigation and busy flags)", () => {
    const generating = { generating: true, navigating: false, navigationBase: 0, hasPrev: true, hasNext: true };
    const view = deriveView(snap({ playback: generating }));
    expect(view.prevDisabled).toBe(false);
    expect(view.nextDisabled).toBe(false);
  });
});

describe("deriveView: voice buttons and status", () => {
  it("enables download only when not stored", () => {
    const view = deriveView(snap({ voices: { busy: false, stored: false, message: "", error: "" } }));
    expect(view.voiceDownloadDisabled).toBe(false);
    expect(view.voiceRemoveDisabled).toBe(true);
  });
  it("enables remove only when stored", () => {
    const view = deriveView(snap());
    expect(view.voiceDownloadDisabled).toBe(true);
    expect(view.voiceRemoveDisabled).toBe(false);
  });
  it("disables both when the status is unknown", () => {
    const view = deriveView(snap({ voices: { busy: false, stored: undefined, message: "", error: "" } }));
    expect(view.voiceDownloadDisabled).toBe(true);
    expect(view.voiceRemoveDisabled).toBe(true);
  });

  it.each([
    ["busy shows the message", { busy: true, stored: false, message: "Downloading 40%", error: "boom" }, "Downloading 40%"],
    ["error shows the error", { busy: false, stored: true, message: "m", error: "boom" }, "boom"],
    ["unknown", { busy: false, stored: undefined, message: "", error: "" }, "Status unknown"],
    ["stored", { busy: false, stored: true, message: "", error: "" }, "Downloaded"],
    ["not stored", { busy: false, stored: false, message: "", error: "" }, "Not downloaded (about 61 MB)"],
  ])("status text: %s", (_name, voices, expected) => {
    expect(deriveView(snap({ voices })).voiceStatusText).toBe(expected);
  });

  it("falls back to 61 MB for an unknown voice", () => {
    const view = deriveView(
      snap({
        voices: { busy: false, stored: false, message: "", error: "" },
        settings: { voiceId: "no-such-voice", speed: 1 },
      }),
    );
    expect(view.voiceStatusText).toBe("Not downloaded (about 61 MB)");
  });
});

describe("deriveView: saved text", () => {
  it("says so when nothing is saved", () => {
    expect(deriveView(snap()).savedText).toBe("No saved position.");
  });
  it("prompts Resume when the saved book is open", () => {
    expect(deriveView(snap({ saved: savedFor("a.epub:10") })).savedText).toBe(
      'Saved: "Book A", chapter 2, sentence 5, 1:15 (3 s ago). Press Resume saved position.',
    );
  });
  it("asks for the same file when another book is open", () => {
    expect(deriveView(snap({ saved: savedFor("b.epub:20") })).savedText).toBe(
      'Saved: "Book A", chapter 2, sentence 5, 1:15 (3 s ago). Pick the same EPUB file to resume.',
    );
  });
  it("asks for the same file when no book is open", () => {
    expect(deriveView(snap({ book: undefined, saved: savedFor("a.epub:10") })).savedText).toContain(
      "Pick the same EPUB file to resume.",
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
