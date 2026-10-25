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
