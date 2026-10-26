import { BOOK_TITLE, sentenceText } from "./epub-fixture";
import {
  audioPaused,
  audioRate,
  audioSource,
  audioTime,
  closeSheet,
  currentIndex,
  expect,
  FAST_POLL,
  generateChapter,
  log,
  openApp,
  openSheet,
  pickBook,
  sheetDialog,
  sheetOpener,
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
  await openSheet(page, "book");
  await page.locator("#chapter").selectOption("2");
  await expect(page.locator("#chapter-name")).not.toHaveText(firstName);
  await expect(page.locator("#chapter-name")).toHaveText(/Chapter Two$/);
  await page.locator("#chapter").selectOption("1");
  await expect(page.locator("#book")).toContainText(BOOK_TITLE);
  await expect(page.locator("#chapter")).toContainText("Chapter One");
  await expect(page.locator("#chapter")).toContainText("Chapter Three");
  await expect(page.locator("#book")).toContainText("remembered");
  await closeSheet(page, "book");

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
  await openSheet(page, "book");
  await expect(page.locator("#forget-book")).toBeVisible();

  await expect(page.locator("#forget-book")).toBeEnabled();
  await page.locator("#forget-book").click();
  // Forget closes the Book sheet, because the main screen changes to the welcome state.
  await expect(sheetDialog(page, "book")).toBeHidden();
  await expect(page.locator("#forget-book")).toBeHidden();
  await expect(page.locator("#chapter option")).toHaveCount(0);
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "open");

  await page.reload();
  await expect(page.locator("#app-version")).toContainText("epub-tts v");
  await expect(page.locator("#book")).toHaveText("");
  await expect(page.locator("#chapter option")).toHaveCount(0);
});

test("preview: the chapter text shows before Listen, follows the select, and Listen keeps it", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  // The cover has no text, so the first chapter with text is shown and selected. No audio runs.
  await expect(page.locator("#text")).toBeVisible();
  await expect(page.locator("#text")).toContainText(sentenceText(1, 1));
  await expect(page.locator("#chapter")).toHaveValue("1");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "listen");
  await expect(page.locator("#text .current")).toHaveCount(0);
  expect(await audioSource(page)).toBe("");

  await openSheet(page, "book");
  await page.locator("#chapter").selectOption("2");
  await closeSheet(page, "book");
  await expect(page.locator("#text")).toContainText(sentenceText(2, 1));
  await expect(page.locator("#text")).not.toContainText(sentenceText(1, 1));
  await expect(page.locator("#text .current")).toHaveCount(0);
  expect(await audioSource(page)).toBe("");

  await page.locator("#primary").click();
  await expect(log(page)).toContainText("segment 1 play() resolved", { timeout: 30_000 });
  await expect(page.locator("#text")).toContainText(sentenceText(2, 1));
  await expect(page.locator("#text")).not.toContainText(sentenceText(1, 1));
  await expect(page.locator("#text .current")).toBeVisible();
});

test("preview: a tap on a sentence before Listen starts generation at that sentence", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await expect(page.locator("#text")).toContainText(sentenceText(1, 4));
  await page.locator('#text span[data-index="3"]').click();
  await expect(log(page)).toContainText("preview: starting at sentence 4");
  await expect(log(page)).toContainText("starting at sentence 4", { timeout: 30_000 });
  await expect(log(page)).toContainText("segment 1 play() resolved", { timeout: 30_000 });
  await expect.poll(() => currentIndex(page), FAST_POLL).toBeGreaterThanOrEqual(3);
});

test("preview: after a reload the saved chapter text shows in the resume state", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await generateChapter(page, 2);
  await page.locator("#primary").click();
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "play");
  await page.reload();
  await expect(page.locator("#book")).toContainText("restored from this device");
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "resume");
  await expect(page.locator("#text")).toContainText(sentenceText(2, 1));
  await expect(page.locator("#text .current")).toHaveCount(0);
  expect(await audioSource(page)).toBe("");
});

test("generate and play: source, time, segment swap, highlight, speed", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await generateChapter(page, 1);
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "pause");
  expect(await audioSource(page)).not.toBe("");
  await expect(page.locator("#audio")).not.toHaveAttribute("controls");
  await expect(page.locator("audio[controls]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(play|pause)$/i })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^(play|pause)$/i })).toHaveAttribute("id", "primary");
  // Speed 1x: a segment lasts at least 4 s, so the time is seen above 0.3 s while polling every 100 ms.
  await expect.poll(() => audioTime(page), FAST_POLL).toBeGreaterThan(0.3);
  await expect(page.locator("#text .current")).toBeVisible();

  await page.locator("#primary").click();
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "play");
  expect(await audioPaused(page)).toBe(true);
  await page.locator("#primary").click();
  await expect(page.locator("#primary")).toHaveAttribute("data-state", "pause");
  await expect.poll(() => audioPaused(page)).toBe(false);

  await openSheet(page, "voice");
  await page.locator("#speed-up").click();
  await page.locator("#speed-up").click();
  await expect(page.locator("#speed-label")).toHaveText("1.50x");
  await closeSheet(page, "voice");
  await expect.poll(() => audioRate(page)).toBe(1.5);

  // Durable facts: the log keeps both swaps. The highlight index only moves forward inside the chapter.
  await expect(log(page)).toContainText("swap to segment 3", { timeout: 45_000 });
  expect(await audioRate(page)).toBe(1.5);
  await expect.poll(() => currentIndex(page), FAST_POLL).toBeGreaterThan(1);
});

test("stop: the primary button cancels generation before the first audio and returns to listen", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await openSheet(page, "book");
  await page.locator("#chapter").selectOption("1");
  await closeSheet(page, "book");
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
  await openSheet(page, "voice");
  await page.locator("#speed-down").click();
  await expect(page.locator("#speed-down")).toBeDisabled();
  await closeSheet(page, "voice");
  await generateChapter(page, 1);
  await expect(page.locator("#text")).toContainText(sentenceText(1, 1));
  await openSheet(page, "book");
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
  await openSheet(page, "voice");
  for (let press = 0; press < 4; press++) await page.locator("#speed-up").click();
  await expect(page.locator("#speed-label")).toHaveText("2.00x");
  await expect(page.locator("#speed-up")).toBeDisabled();
  await closeSheet(page, "voice");
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
  await openSheet(page, "voice");
  await page.locator("#speed-down").click();
  await closeSheet(page, "voice");
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
  await openSheet(page, "diagnostics");
  await expect(log(page)).toContainText("settings: voice=en_US-kristin-medium");
  await page.locator("#copy-log").click();
  await expect(page.locator("#copy-status")).toHaveText("Copied");
  // Firefox does not allow a clipboard read from a page. It only checks the status text above.
  if (browserName === "chromium") {
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith("epub-tts v")).toBe(true);
    expect(copied).toContain("settings: voice=");
  }
  await page.keyboard.press("Escape");
  await expect(sheetDialog(page, "diagnostics")).toBeHidden();
  await expect(sheetOpener(page, "diagnostics")).toBeFocused();
});

for (const name of ["book", "voice", "diagnostics"] as const) {
  test(`sheet ${name}: opens, hides its content when closed, closes by Escape and by Close, returns focus`, async ({
    page,
  }) => {
    await openApp(page);
    await pickBook(page);
    const dialog = sheetDialog(page, name);
    const opener = sheetOpener(page, name);
    await expect(opener).toHaveAccessibleName(/\S/);
    await expect(dialog).toBeHidden();
    await expect(dialog.locator(".sheet-body")).toBeHidden();

    await openSheet(page, name);
    await expect(dialog.locator(".sheet-body")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await openSheet(page, name);
    await closeSheet(page, name);
    await expect(opener).toBeFocused();
  });
}

test("sheets: the slide animation runs by default and is off with reduced motion", async ({ page }) => {
  await openApp(page);
  const animationName = () => sheetDialog(page, "voice").evaluate((element) => getComputedStyle(element).animationName);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSheet(page, "voice");
  expect(await animationName()).toBe("slide-up");
  await closeSheet(page, "voice");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSheet(page, "voice");
  expect(await animationName()).toBe("none");
});

test("sheets: a click on the backdrop closes the sheet at a phone size", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await openSheet(page, "voice");
  await page.mouse.click(200, 5);
  await expect(sheetDialog(page, "voice")).toBeHidden();
  await expect(sheetOpener(page, "voice")).toBeFocused();
});

test("sheets: a click that targets the dialog but lands inside its box (safe-area padding) keeps it open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await openSheet(page, "voice");
  // Headless browsers have no safe-area inset, so send the click the padding would produce: target is the dialog, point is inside.
  await sheetDialog(page, "voice").evaluate((element) => {
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1, clientX: box.left + box.width / 2, clientY: box.bottom - 2 }),
    );
  });
  await expect(sheetDialog(page, "voice")).toBeVisible();
});

test("sheets: a coordinate-less dialog click (keyboard activation, detail 0) keeps the sheet open", async ({ page }) => {
  await openApp(page);
  await openSheet(page, "voice");
  await sheetDialog(page, "voice").evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0, clientX: 0, clientY: 0 }));
  });
  await expect(sheetDialog(page, "voice")).toBeVisible();
});

test("sheets: a Book sheet reopened while Forget runs does not stay over the welcome state", async ({ page }) => {
  await openApp(page);
  await pickBook(page);
  await openSheet(page, "book");
  // Forget is rejected until the book is saved, and the save ends after the chapter options appear.
  await expect(page.locator("#forget-book")).toBeEnabled();
  // Click Forget and the opener in one task, so the sheet reopens before the asynchronous deletion ends.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#forget-book")?.click();
    document.querySelector<HTMLElement>("#open-book")?.click();
  });
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(sheetDialog(page, "book")).toBeHidden();
});

test("sheets: Voice and speed and Diagnostics open from the welcome state, Book does not", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(sheetOpener(page, "book")).toBeHidden();
  await openSheet(page, "voice");
  await expect(page.locator("#speed-label")).toBeVisible();
  await closeSheet(page, "voice");
  await openSheet(page, "diagnostics");
  await expect(page.locator("#app-version")).toBeVisible();
});
