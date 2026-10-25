/** Test-only. The production build replaces this module with a stub (see vite.config.ts), so no mock code ships. */
export function createMockWorker(): Worker {
  return new Worker(new URL("./worker.mock.ts", import.meta.url), { type: "module" });
}
