import { BOOK_TITLE, sentenceText } from "./epub-fixture";
import {
  audioRate,
  audioSource,
  audioTime,
  currentIndex,
  expect,
  generateChapter,
  log,
  openApp,
  pickBook,
  test,
} from "./fixtures";

/*
 * Skips: none. Headless Chromium and Firefox both play the mock worker's wav files.
 * The page is cross-origin isolated by the e2e preview server headers, so coi-serviceworker never runs.
 */

test("startup: quiet page, version footer, five voices, Kristin by default", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#app-version")).toHaveText(/^epub-tts v\S+ \(\S+\)$/);
  const options = page.locator("#voice option");
  await expect(options).toHaveCount(5);
  const values = await options.evaluateAll((list) =>
    list.map((o) => (o instanceof HTMLOptionElement ? `${o.value} ${o.text}` : "")),
  );
  for (const value of values) expect(value.toLowerCase()).not.toContain("lessac");
  await expect(page.locator("#voice")).toHaveValue("en_US-kristin-medium");
});

test("open and remember: chapters, restore after reload, forget", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await expect(page.locator("#book")).toContainText(BOOK_TITLE);
  await expect(page.locator("#chapter")).toContainText("Chapter One");
  await expect(page.locator("#chapter")).toContainText("Chapter Three");
  await expect(page.locator("#book")).toContainText("remembered");

  await page.locator("#chapter").selectOption("2");
  // The saved position is written by generation. Generate once so a chapter is saved, then stop.
  await page.locator("#generate").click();
  await expect.poll(() => audioTime(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
  await page.locator("#cancel").click();
  await expect(page.locator("#cancel")).toBeDisabled();

  await page.reload();
  await expect(page.locator("#book")).toContainText("restored from this device");
  await expect(page.locator("#book")).toContainText(BOOK_TITLE);
  await expect(page.locator("#chapter")).toHaveValue("2");
  await expect(page.locator("#forget-book")).toBeVisible();

  await page.locator("#audio").evaluate((element) => {
    if (element instanceof HTMLMediaElement) element.pause();
  });
  await expect(page.locator("#forget-book")).toBeEnabled();
  await page.locator("#forget-book").click();
  await expect(page.locator("#forget-book")).toBeHidden();
  await expect(page.locator("#chapter option")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#app-version")).toContainText("epub-tts v");
  await expect(page.locator("#book")).toHaveText("");
  await expect(page.locator("#chapter option")).toHaveCount(0);
});

test("generate and play: source, time, segment swap, highlight, speed", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await generateChapter(page, 1);
  expect(await audioSource(page)).not.toBe("");
  const first = await currentIndex(page);
  expect(first).toBeGreaterThanOrEqual(0);
  await expect(page.locator("#text .current")).toBeVisible();

  await page.locator("#speed").fill("1.5");
  await expect(page.locator("#speed-label")).toHaveText("1.50x");
  await expect.poll(() => audioRate(page)).toBe(1.5);

  await expect(log(page)).toContainText("swap to segment", { timeout: 45_000 });
  await expect.poll(() => currentIndex(page), { timeout: 30_000 }).toBeGreaterThan(first + 1);
  expect(await audioRate(page)).toBe(1.5);
});

test("chapter navigation: next, previous, previous disabled on the first text chapter", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await generateChapter(page, 1);
  await expect(page.locator("#text")).toContainText(sentenceText(1, 1));
  // The cover has no text, so Previous is disabled once the background scan has checked it.
  await expect(page.locator("#chapter-prev")).toBeDisabled();

  await expect(page.locator("#chapter-next")).toBeEnabled();
  await page.locator("#chapter-next").click();
  await expect(page.locator("#chapter")).toHaveValue("2");
  await expect(page.locator("#text")).toContainText(sentenceText(2, 1));
  await expect(page.locator("#text")).not.toContainText(sentenceText(1, 1));

  await expect(page.locator("#chapter-prev")).toBeEnabled();
  await page.locator("#chapter-prev").click();
  await expect(page.locator("#chapter")).toHaveValue("1");
  await expect(page.locator("#text")).toContainText(sentenceText(1, 1));
  await expect(page.locator("#chapter-prev")).toBeDisabled();
});

test("continuous playback: chapter 2 continues into chapter 3 and the book ends", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await page.locator("#speed").fill("2");
  await generateChapter(page, 2);
  await expect(page.locator("#text")).toContainText(sentenceText(2, 1));
  await expect(page.locator("#chapter")).toHaveValue("3", { timeout: 60_000 });
  await expect(page.locator("#text")).toContainText(sentenceText(3, 1));
  await expect(log(page)).toContainText("end of book", { timeout: 60_000 });
});

test("jump: a click on a sentence that is not generated yet restarts there", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await generateChapter(page, 1);
  const last = 11;
  await page.locator(`#text span[data-index="${last}"]`).click();
  await expect(log(page)).toContainText("jump:");
  await expect.poll(() => currentIndex(page), { timeout: 30_000 }).toBe(last);
});

test("diagnostics: Copy log copies the header and the log", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await page.locator("#diagnostics summary").click();
  await expect(log(page)).toContainText("settings: voice=en_US-kristin-medium");
  await page.locator("#copy-log").click();
  await expect(page.locator("#copy-status")).toHaveText("Copied");
  // Firefox does not allow a clipboard read from a page. It only checks the status text above.
  if (browserName === "chromium") {
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith("epub-tts v")).toBe(true);
    expect(copied).toContain("settings: voice=");
  }
});
