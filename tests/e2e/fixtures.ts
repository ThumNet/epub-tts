import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { buildTestBook } from "./epub-fixture";

/** Every test fails on an uncaught page error or a console.error, so the page must stay quiet. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
    });
    await use(page);
    expect(problems).toEqual([]);
  },
});

export { expect };

/** Segments of 3 s (instead of 60 s), so a chapter has several segments. Works only in the e2e build. */
export async function openApp(page: Page): Promise<void> {
  await page.goto("./?segmentSeconds=3");
  await expect(page.locator("#app-version")).toContainText("epub-tts v");
}

export async function pickBook(page: Page): Promise<void> {
  await page.locator("#file").setInputFiles(await buildTestBook());
  await expect(page.locator("#chapter option")).toHaveCount(4);
}

/** Chapter select value of chapter N of the test book. Value 0 is the empty cover. */
export function chapterValue(chapter: 1 | 2 | 3): string {
  return String(chapter);
}

/**
 * Pick a chapter, press the primary button (Listen) and wait until the first segment started to play. The wait uses the
 * log line "segment 1 play() resolved", which stays in the log. It does not depend on how fast the audio plays.
 * Call it once per page, because the log line is the same for every generation.
 */
export async function generateChapter(page: Page, chapter: 1 | 2 | 3): Promise<void> {
  await openSheet(page, "book");
  await page.locator("#chapter").selectOption(chapterValue(chapter));
  await closeSheet(page, "book");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "listen");
  await expect(page.locator("#primary")).toBeEnabled();
  await page.locator("#primary").click();
  await expect(log(page)).toContainText("segment 1 play() resolved", { timeout: 30_000 });
}

export type SheetName = "book" | "voice" | "diagnostics";

const SHEET_IDS: Record<SheetName, { dialog: string; opener: string }> = {
  book: { dialog: "#sheet-book", opener: "#open-book" },
  voice: { dialog: "#sheet-voice", opener: "#open-voice" },
  diagnostics: { dialog: "#diagnostics", opener: "#open-diagnostics" },
};

export function sheetDialog(page: Page, name: SheetName): Locator {
  return page.locator(SHEET_IDS[name].dialog);
}

export function sheetOpener(page: Page, name: SheetName): Locator {
  return page.locator(SHEET_IDS[name].opener);
}

/** A modal sheet makes the page behind it inert, so a test must open the sheet before it uses a control inside. */
export async function openSheet(page: Page, name: SheetName): Promise<void> {
  await sheetOpener(page, name).click();
  await expect(sheetDialog(page, name)).toBeVisible();
}

export async function closeSheet(page: Page, name: SheetName): Promise<void> {
  await sheetDialog(page, name).getByRole("button", { name: "Close" }).click();
  await expect(sheetDialog(page, name)).toBeHidden();
}

/** Poll often, so a state that lasts only a few seconds is still seen. */
export const FAST_POLL = { intervals: [100], timeout: 30_000 };

export function log(page: Page): Locator {
  return page.locator("#log");
}

export function currentIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const element = document.querySelector("#text .current");
    return element ? Number(element.getAttribute("data-index")) : -1;
  });
}

export function audioTime(page: Page): Promise<number> {
  return page.locator("#audio").evaluate((element) => (element instanceof HTMLMediaElement ? element.currentTime : -1));
}

export function audioPaused(page: Page): Promise<boolean> {
  return page.locator("#audio").evaluate((element) => (element instanceof HTMLMediaElement ? element.paused : false));
}

export function audioSource(page: Page): Promise<string> {
  return page.locator("#audio").evaluate((element) => (element instanceof HTMLMediaElement ? element.currentSrc : ""));
}

export function audioRate(page: Page): Promise<number> {
  return page.locator("#audio").evaluate((element) => (element instanceof HTMLMediaElement ? element.playbackRate : -1));
}
