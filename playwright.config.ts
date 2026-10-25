import { defineConfig, devices } from "@playwright/test";

const PORT = 4175;
const isCi = Boolean(process.env["CI"]);

/*
 * The tests run against the e2e build (`vite build --mode e2e`): a mock speech worker replaces Piper.
 * The e2e preview server sends COOP/COEP headers, so the page is cross-origin isolated by itself.
 * The app then skips coi-serviceworker, which would reload the page once. The tests need no service worker
 * handling and no reload wait. Service workers stay unused in these tests.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  reporter: isCi ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/epub-tts/`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 },
        },
      },
    },
  ],
  webServer: {
    command: `npm run build:e2e && npx vite preview --mode e2e --outDir dist-e2e --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/epub-tts/`,
    reuseExistingServer: !isCi,
    timeout: 180_000,
  },
});
