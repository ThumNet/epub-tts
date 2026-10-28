# Development

## Requirements

Node.js 20.19 or newer, and npm.

## Run locally

1. Run `npm install`.
2. Run `npm run dev`.
3. Open the URL that Vite prints. The path starts with `/epub-tts/`, for example `http://localhost:5173/epub-tts/`.
4. Pick an EPUB file, pick a chapter, and press "Generate chapter audio". Playback starts after the first segment.

Other scripts:

- `npm run typecheck` checks the types.
- `npm run build` checks the types and builds into `dist/`.
- `npm run preview` serves `dist/` at `http://localhost:4173/epub-tts/`.

## Unit tests and boundary check

Run `npm test` to run the unit tests (Vitest, in Node, no DOM). The tests are in `tests/unit/`. `npm run typecheck` also runs `scripts/check-boundaries.mjs`. The script fails if a file in `src/engine/` uses the DOM or imports from `ui/` or `main`. It also fails if any import cycle exists in `src/`.

## End-to-end tests

The tests use Playwright on Chromium and Firefox. A mock speech worker replaces Piper, so the tests need no network and no voice download.

1. Run `npm run test:e2e:install` once to install the browsers.
2. Run `npm run test:e2e`. It builds the e2e bundle (`npm run build:e2e`, into `dist-e2e/`), serves it with `vite preview` and runs the tests in `tests/e2e/`.

The build mode `e2e` sets `VITE_E2E`. The flag has two effects: the app uses `src/worker.mock.ts` (a quiet tone for each sentence) and it accepts `?segmentSeconds=<n>` to shorten the segments. A normal build (`npm run build`) contains neither. The e2e preview server sends COOP/COEP headers, so the page is cross-origin isolated and coi-serviceworker does not run. CI runs the tests in `.github/workflows/ci.yml`. Real audio, the lock screen and real voices stay manual checks on a phone.

## Large files

The repository does not contain the large files. No download script is needed.

- The ONNX Runtime WASM files and the Piper phonemizer files (about 18 MB) come from npm. The build copies them from `node_modules` into `dist/ort/` and `dist/piper/`.
- The voice model comes from Hugging Face at run time. The library hard-codes the URL for the voice. For `en_US-lessac-medium` it is `https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx`. The default voice is now `en_US-kristin-medium`, because Lessac has a research-only licence.
- `node_modules/` and `dist/` are in `.gitignore`.

## See also

- [Deployment](deployment.md)
- [Phone testing](phone-testing.md)