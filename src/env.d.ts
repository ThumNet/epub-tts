/** App version from package.json. Set by Vite `define`. */
declare const __APP_VERSION__: string;
/** First 7 characters of the commit SHA, or "dev". Set by Vite `define`. */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** Set to "1" by Vite `define` in vite.config.ts when the mode is `e2e`. Enables the test-only mock worker and URL overrides. */
  readonly VITE_E2E?: string;
}
