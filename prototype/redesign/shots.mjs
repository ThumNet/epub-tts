import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, "shots");
mkdirSync(out, { recursive: true });
const page_url = pathToFileURL(path.join(dir, "index.html")).href;

const sizes = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};
const views = [
  ["welcome", "state=welcome"],
  ["book", "state=book"],
  ["generating", "state=generating"],
  ["playing", "state=playing"],
  ["paused", "state=paused"],
  ["resume", "state=resume"],
  ["sheet-book", "state=book&sheet=book"],
  ["sheet-voice", "state=book&sheet=voice"],
  ["sheet-diagnostics", "state=book&sheet=diagnostics"],
];

const browser = await chromium.launch();
for (const [sizeName, opts] of Object.entries(sizes)) {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ ...opts, colorScheme: scheme });
    const page = await context.newPage();
    for (const [name, query] of views) {
      await page.goto(`${page_url}?${query}&clean=1&theme=${scheme}`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${sizeName}-${scheme}-${name}.png`) });
    }
    await context.close();
  }
}
await browser.close();
console.log("done");
