# Engine split: step 0 baseline

Date: 2026-10-25
Branch: `refactor/engine-split`
Commit: the baseline was taken on branch `refactor/engine-split` at base commit 61f20cb (docs: add the design record for splitting the engine out of main.ts). The step 0 tooling files were present but uncommitted at measurement time. `src/` is identical to `main` at 228f209 (the squash merge of PR #3).

Later steps compare against these numbers. See `plans/2026-10-25-engine-split-design.md`.

## Command results

| Command | Result |
|---|---|
| `npm run typecheck` | pass. `boundaries OK: 11 files, 11 imports, 0 cycles, 0 engine files checked` |
| `npm run build` | pass. 124 modules transformed |
| `npm run build:e2e` | pass. 124 modules transformed |
| `npm test` | pass. 2 test files, 29 tests (the first run had 10 tests; the count grew when the boundary tests were hardened, and grew again when the checker was extended to flag `.document`/`.window` on `globalThis`, `window`, `self` and `top`) |
| `npm run test:e2e` | pass. 14 tests (7 on Chromium, 7 on Firefox), 12.9 s |

`npm run build` runs only `tsc --noEmit` and `vite build`. The boundary check runs in `npm run typecheck`. CI runs `typecheck` before `build`.

The real `src/` tree has no import cycle.

## Production assets (`dist/assets`)

| File | Bytes |
|---|---|
| `index-DEv4_LFq.js` | 406236 |
| `ort.wasm.min-4XBKGcRb.js` | 141886 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88803 |
| `worker-Bf42NmSi.js` | 16109 |

Total: 653034 bytes in 4 files. `dist/index.html` is 4.52 kB.

The e2e build (`dist-e2e/assets`) has the same files plus `worker.mock-CIdlIZTb.js` (0.87 kB). Its `index` file is 406.38 kB.

## Mock strings in `dist/`

A search of `dist/` for `EPUB_TTS_MOCK_WORKER`, `worker.mock`, `segmentSeconds` and `e2e-worker` found no match.

## Source size

- `src/main.ts`: 1989 lines.
- All `src/*.ts` files: 2718 lines in 12 files.

| File | Lines |
|---|---|
| `main.ts` | 1989 |
| `book-store.ts` | 182 |
| `epub.ts` | 116 |
| `store.ts` | 107 |
| `worker.ts` | 86 |
| `worker.mock.ts` | 72 |
| `wav.ts` | 67 |
| `voices.ts` | 49 |
| `log.ts` | 22 |
| `protocol.ts` | 15 |
| `env.d.ts` | 9 |
| `e2e-worker.ts` | 4 |

## Step 1 result

Step 1 moves the constants into `src/engine/config.ts` and the pure helpers into `src/engine/pure.ts`.

- `npm test`: 6 files, 82 tests (baseline: 2 files, 29 tests). New files: `pure.test.ts`, `config.test.ts`, `store.test.ts`, `epub.test.ts`.
- `npm run typecheck`: `boundaries OK: 13 files, 14 imports, 0 cycles, 2 engine files checked`.
- `npm run test:e2e`: 14 passed (12.6 s).

| File in `dist/assets` | Bytes | Baseline |
|---|---|---|
| `index-CB3e2XBS.js` | 406703 | 406236 |
| `ort.wasm.min-4XBKGcRb.js` | 141886 | 141886 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88803 | 88803 |
| `worker-Bf42NmSi.js` | 16109 | 16109 |

The `index` file is 467 bytes larger. The new function call forms and exported helpers add code. The asset list is the same, with no new chunk.
A search of `dist/` for `segmentSeconds`, `EPUB_TTS_MOCK_WORKER` and `worker.mock` finds no match.
The `import.meta.env.VITE_E2E` test stays in `main.ts`. If it moved into the engine as a parameter, `segmentSeconds` would ship in production.

Line counts: `src/main.ts` 1959 (was 1989), `src/engine/config.ts` 38, `src/engine/pure.ts` 124.

## Step 2 result

Step 2 adds `src/engine/hooks.ts` (`EngineHooks`, types only) and one `hooks` object in `main.ts`, defined right after the DOM lookups (before the first `refreshSavedUi()` at module load). Every hook is synchronous and replaces the old code in place.

| Hook | Call sites converted | Remaining direct uses |
|---|---|---|
| `setStatus` | 15 (before: 15 direct writes) | 1 (hook body) |
| `notifyChange` | 24 (before: 25 `updateControls()` calls) | 1 (hook body) |
| `showChapter` | 7 | 1 (hook body) |
| `renderChapter` | 2 | 0 (hook body calls `renderText`) |
| `highlight` | 1 (DOM part of `highlight()`) | 0 |
| `clearText` | 2 | 0 |
| `getSelectedChapter` | 3 (`navigationBase`, Generate click, chapter `change` handler) | 1 (hook body) |

The `highlight()` function keeps the guard and `currentSentence = index`. The hook now removes `.current` after that assignment instead of before it. Nothing reads `currentSentence` in between, so there is no observable difference.

DOM touches left in engine-destined code (no hook fits, so left as is):
- `src/main.ts` `showBook`: `chapterSelect.replaceChildren(...)` and `chapterSelect.disabled = false` (chapter list fill).
- `src/main.ts` forget handler: `chapterSelect.replaceChildren()` and `chapterSelect.disabled = true`.
- `src/main.ts` `renderText` body, which is the shell render function behind `renderChapter`.
- Shell, by design: `bookInfo`, `voiceStatus`, `speedLabel`, `savedElement`, `copyStatus`, `versionElement`, `fileInput`, button flags, listener registrations.

Results: `npm run typecheck` OK (`boundaries OK: 14 files, 16 imports, 0 cycles, 3 engine files checked`), `npm test` 82 passed, `npm run test:e2e` 14 passed (12.6 s).

| File in `dist/assets` | Size (vite, kB) | Step 1 |
|---|---|---|
| `index-C78aMtyl.js` | 407.25 | 406.70 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. `index` grew about 0.55 kB (hook object and arrow wrappers).

## Step 3 result

Step 3 moves the worker cluster into `src/engine/worker-client.ts` (`createWorkerClient(hooks)`, `VoiceChangedError`, `GeneratedClip`). `main.ts` creates `workerClient` where `let worker = createWorker()` stood. It keeps thin wrappers `ensureWorker` and `generateClip`. `cancelGeneration()` calls `workerClient.cancel()`.

Changes beyond closure scoping and the import path:
- `window.setTimeout` / `window.clearTimeout` became `globalThis.setTimeout` / `globalThis.clearTimeout`. The boundary check bans `window`. In a browser the two are the same function. The `timer` type is now `ReturnType<typeof globalThis.setTimeout> | undefined` (the Node typings are loaded too).
- `refreshVoiceStatus()` at the end of `initWorker` became the hook `hooks.onReady()` (an extra hook next to `setStatus`). It runs at the same point, after the "model ready" log line.
- The log line "cancel during voice init: terminating the worker" and the worker part of `cancelGeneration` are now in `cancel()`. The order is unchanged.

Results: `npm run typecheck` OK (`boundaries OK: 15 files, 20 imports, 0 cycles, 4 engine files checked`), `npm test` 82 passed, `npm run test:e2e` 14 passed (12.6 s).

| File in `dist/assets` | Size (vite, kB) | Step 2 |
|---|---|---|
| `index-DIW7Ddl9.js` | 407.41 | 407.25 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. `dist` has no `EPUB_TTS_MOCK_WORKER`, `worker.mock`, `segmentSeconds` or `e2e-worker`. The e2e build (`dist-e2e/assets`) has `worker.mock-CIdlIZTb.js` (0.87 kB) and `index-BKjLQhn5.js` (407.59 kB).

Line counts: `src/main.ts` 1793 (was 1959), `src/engine/worker-client.ts` 235.
