import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// GitHub Pages project page. Override with VITE_BASE (for example "/" for a user page).
const base = process.env["VITE_BASE"] ?? "/epub-tts/";

export default defineConfig({
  base,
  worker: { format: "es" },
  build: { target: "es2022" },
  plugins: [
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
});
