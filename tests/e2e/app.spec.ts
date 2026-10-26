import { BOOK_TITLE, sentenceText } from "./epub-fixture";
import {
  audioPaused,
  audioRate,
  audioSource,
  audioTime,
  currentIndex,
  expect,
  FAST_POLL,
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
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#welcome label[for=file]")).toHaveText("Open an EPUB");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "open");
  await expect(page.locator("#text")).toBeHidden();
});

test("open and remember: chapters, restore after reload, forget", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await expect(page.locator("#welcome")).toBeHidden();
  await expect(page.locator("#title")).toHaveText(BOOK_TITLE);
  await expect(page.locator("#chapter-name")).not.toHaveText("");
  const firstName = await page.locator("#chapter-name").innerText();
  await page.locator("#chapter").selectOption("2");
  await expect(page.locator("#chapter-name")).not.toHaveText(firstName);
  await expect(page.locator("#chapter-name")).toHaveText(/Chapter Two$/);
  await page.locator("#chapter").selectOption("1");
  await expect(page.locator("#book")).toContainText(BOOK_TITLE);
  await expect(page.locator("#chapter")).toContainText("Chapter One");
  await expect(page.locator("#chapter")).toContainText("Chapter Three");
  await expect(page.locator("#book")).toContainText("remembered");

  // The saved position is written when a chapter starts. Generate once so a chapter is saved, then pause.
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "listen");
  await generateChapter(page, 2);
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "pause");
  await page.locator("#primary").click();
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "play");
  expect(await audioPaused(page)).toBe(true);

  await page.reload();
  await expect(page.locator("#book")).toContainText("restored from this device");
  await expect(page.locator("#book")).toContainText(BOOK_TITLE);
  await expect(page.locator("#chapter")).toHaveValue("2");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "resume");
  await expect(page.locator("#listen-start")).toBeVisible();
  await expect(page.locator("#forget-book")).toBeVisible();

  await expect(page.locator("#forget-book")).toBeEnabled();
  await page.locator("#forget-book").click();
  await expect(page.locator("#forget-book")).toBeHidden();
  await expect(page.locator("#chapter option")).toHaveCount(0);
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "open");

  await page.reload();
  await expect(page.locator("#app-version")).toContainText("epub-tts v");
  await expect(page.locator("#book")).toHaveText("");
  await expect(page.locator("#chapter option")).toHaveCount(0);
});

test("generate and play: source, time, segment swap, highlight, speed", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await generateChapter(page, 1);
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "pause");
  expect(await audioSource(page)).not.toBe("");
  // Speed 1x: a segment lasts at least 4 s, so the time is seen above 0.3 s while polling every 100 ms.
  await expect.poll(() => audioTime(page), FAST_POLL).toBeGreaterThan(0.3);
  await expect(page.locator("#text .current")).toBeVisible();

  await page.locator("#primary").click();
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "play");
  expect(await audioPaused(page)).toBe(true);
  await page.locator("#primary").click();
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "pause");
  await expect.poll(() => audioPaused(page)).toBe(false);

  await page.locator("#speed-up").click();
  await page.locator("#speed-up").click();
  await expect(page.locator("#speed-label")).toHaveText("1.50x");
  await expect.poll(() => audioRate(page)).toBe(1.5);

  // Durable facts: the log keeps both swaps. The highlight index only moves forward inside the chapter.
  await expect(log(page)).toContainText("swap to segment 3", { timeout: 45_000 });
  expect(await audioRate(page)).toBe(1.5);
  await expect.poll(() => currentIndex(page), FAST_POLL).toBeGreaterThan(1);
});

test("stop: the primary button cancels generation before the first audio and returns to listen", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await page.locator("#chapter").selectOption("1");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "listen");
  // The mock worker is fast, so "stop" lasts well under a second. Click it from the attribute observer, not from the test.
  const stoppedAt = await page.locator("#primary").evaluate(
    (element) =>
      new Promise<string>((resolve) => {
        if (!(element instanceof HTMLElement)) throw new Error("#primary is not an HTML element");
        const button = element;
        const observer = new MutationObserver(() => {
          if (button.getAttribute("data-state") !== "stop") return;
          observer.disconnect();
          button.click();
          resolve("stop");
        });
        observer.observe(button, { attributes: true, attributeFilter: ["data-state"] });
        button.click();
      }),
  );
  expect(stoppedAt).toBe("stop");
  await expect(log(page)).toContainText("cancel requested");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", /^(listen|resume)$/, { timeout: 30_000 });
  await expect(page.locator("#primary")).toBeEnabled();
});

test("chapter navigation: next, previous, previous disabled on the first text chapter", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  // Slow playback keeps chapter 1 playing during the whole test, so it never moves on by itself.
  await page.locator("#speed-down").click();
  await expect(page.locator("#speed-down")).toBeDisabled();
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
  for (let press = 0; press < 4; press++) await page.locator("#speed-up").click();
  await expect(page.locator("#speed-label")).toHaveText("2.00x");
  await expect(page.locator("#speed-up")).toBeDisabled();
  await generateChapter(page, 2);
  // Only durable evidence. The log numbers are spine positions: Chapter Two is "chapter 3", Chapter Three is "chapter 4".
  await expect(log(page)).toContainText("generating chapter 3:");
  await expect(log(page)).toContainText("swap to chapter 4 (", { timeout: 60_000 });
  await expect(log(page)).toContainText("end of book", { timeout: 60_000 });
  await expect(page.locator("#chapter")).toHaveValue("3");
  await expect(page.locator("#text")).toContainText(sentenceText(3, 1));
  await expect(page.locator("#text")).not.toContainText(sentenceText(2, 1));
});

test("jump: a click on a sentence that is not generated yet restarts there", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await page.locator("#speed-down").click();
  await generateChapter(page, 1);
  // Sentence 10 (index 9). The generator is at most two segments ahead, so it is not generated yet.
  await page.locator('#text span[data-index="9"]').click();
  await expect(log(page)).toContainText("jump: restarting generation at sentence 10");
  await expect(log(page)).toContainText("starting at sentence 10", { timeout: 30_000 });
  await expect.poll(() => currentIndex(page), FAST_POLL).toBeGreaterThanOrEqual(9);
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
