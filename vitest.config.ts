import { defineConfig } from "vitest/config";

// Unit tests run in Node, without a DOM. The e2e specs in tests/e2e belong to Playwright.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
