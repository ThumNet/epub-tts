import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// GitHub Pages project page. Override with VITE_BASE (for example "/" for a user page).
const base = process.env["VITE_BASE"] ?? "/epub-tts/";

interface PackageInfo {
  version: string;
}

function readVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    const info: PackageInfo = { version: parsed.version };
    return info.version;
  }
  return "0.0.0";
}

// Build id: first 7 characters of the commit SHA. CI sets GITHUB_SHA. Locally, ask git.
function readBuildId(): string {
  const fromCi = process.env["GITHUB_SHA"];
  if (fromCi) return fromCi.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

export default defineConfig(({ mode }) => {
  // Mode "e2e" builds the test-only variant: mock speech worker and URL overrides. No other mode sets the flag.
  const e2e = mode === "e2e";
  return {
    base,
    define: {
      __APP_VERSION__: JSON.stringify(readVersion()),
      __BUILD_ID__: JSON.stringify(readBuildId()),
      ...(e2e ? { "import.meta.env.VITE_E2E": '"1"' } : {}),
    },
    worker: { format: "es" },
    build: { target: "es2022" },
    // The e2e preview server sends COOP/COEP, so the page is cross-origin isolated and coi-serviceworker stays idle.
    preview: e2e
      ? { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } }
      : {},
    plugins: [
      // Outside mode "e2e", replace the mock worker factory with a stub. Vite would otherwise bundle the
      // mock worker even though the VITE_E2E branch is dead code.
      {
        name: "stub-e2e-worker",
        enforce: "pre" as const,
        resolveId(source: string) {
          if (!e2e && /(^|\/)e2e-worker$/.test(source)) return "\0e2e-worker-stub";
          return undefined;
        },
        load(id: string) {
          if (id === "\0e2e-worker-stub") {
            return 'export function createMockWorker() { throw new Error("The mock worker exists only in e2e builds."); }';
          }
          return undefined;
        },
      },
      viteStaticCopy({
        targets: [
          // ONNX Runtime WASM binaries (SIMD only. Every current phone browser supports SIMD).
          { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm", dest: "ort" },
          { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", dest: "ort" },
          // Piper phonemizer (espeak-ng) WASM and data.
          { src: "node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm", dest: "piper" },
          { src: "node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data", dest: "piper" },
          // Adds cross-origin isolation on hosts that cannot set COOP/COEP headers.
          { src: "node_modules/coi-serviceworker/coi-serviceworker.js", dest: "." },
        ],
      }),
    ],
  };
});
