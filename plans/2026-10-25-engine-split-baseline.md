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

Line counts: `src/main.ts` 1793 (was 1980 at commit 0d30ea6, before step 3; an earlier version of this line said 1959, which was wrong), `src/engine/worker-client.ts` 235.

## Step 4a result

Step 4a moves the diagnostics pieces into `src/engine/diagnostics.ts` (`createDiagnostics({ audio, getVisibility })`). Four methods, each called from `main.ts` at the position of the code it replaced: `reportStaleMarker()` (the stale generation marker), `startHeartbeat()`, `logAudioEvents()`, `setupAudioSession()`. `getVisibility` is `() => document.visibilityState`. The page-lifecycle listeners stay in `main.ts`.

Results: `npm run typecheck` OK (`boundaries OK: 16 files, 24 imports, 0 cycles, 5 engine files checked`), `npm test` 82 passed, `npm run test:e2e` 14 passed (12.6 s). `dist` has no mock strings.

| File in `dist/assets` | Size (vite, kB) | Step 3 |
|---|---|---|
| `index-CX8mpg3Q.js` | 407.70 | 407.41 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-DP79wuly.js` (407.88 kB).

Line counts: `src/main.ts` 1737 (was 1793), `src/engine/diagnostics.ts` 98.

## Step 4b result

Step 4b moves the settings state into `src/engine/settings.ts` (`createSettings({ audio })`). API: `speed` and `voiceId` getters, `setVoiceId(id)` (unknown id falls back to the default voice, as `selectedVoiceId()` did), `setSpeed(value)` (rounds, no log, no DOM), `applyPlaybackRate()` (the three assignments, including `preservesPitch`), `persist()`, `load()` (reads the saved settings into the state, returns `{ voiceId, speed, rejectedVoice? }`, writes nothing). `main.ts` keeps `showSpeed`, the `setSpeed(value, reason)` wrapper with its log line, `initSettings` with its log lines, and a thin `applyPlaybackRate()` wrapper. The voice `change` handler calls `settings.setVoiceId(voiceSelect.value)` first.

Results: `npm run typecheck` OK (`boundaries OK: 17 files, 28 imports, 0 cycles, 6 engine files checked`), `npm test` 90 passed (7 files, new `settings.test.ts`), `npm run test:e2e` 14 passed (12.9 s). `dist` has no `mock` string.

| File in `dist/assets` | Size (vite, kB) | Step 4a |
|---|---|---|
| `index-oMhJka7f.js` | 408.11 | 407.70 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-cjE_ysxU.js` (408.29 kB).

Line counts: `src/main.ts` 1724 (was 1737), `src/engine/settings.ts` 79 (an earlier note said 76; the file has 79 lines).

## Step 4c result

Step 4c moves the voice download, remove and status logic into `src/engine/voices-store.ts` (`createVoicesStore({ hooks, getVoiceId, isGenerating, persistSettings })`). It owns `voiceBusy`, `voiceStored`, `voiceMessage`, `voiceError`, `voiceStatusToken`. API: getters `busy`, `stored`, `message`, `error`; `refresh()`, `select()`, `startDownload()`, `startRemove()`. `readStoredVoices` and `waitUntilStored` are private. `errorName` moved to `src/engine/pure.ts`. `main.ts` keeps the DOM listeners and `updateControls()`, which reads the store.

Results: `npm run typecheck` OK (`boundaries OK: 18 files, 33 imports, 0 cycles, 7 engine files checked`), `npm test` 103 passed (8 files, new `voices-store.test.ts`, 13 tests), `npm run test:e2e` 14 passed. `dist` has no `mock` string.

| File in `dist/assets` | Size (vite, kB) | Step 4b |
|---|---|---|
| `index-Dh3kQ3B-.js` | 408.54 | 408.11 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-CJXtiIq_.js` (408.72 kB).

Line counts: `src/main.ts` 1632 (was 1724), `src/engine/voices-store.ts` 144.

## Step 5a result

Step 5a moves the book state and the chapter text logic into `src/engine/book.ts` (`createBook({ hooks })`, hooks: `notifyChange` only). It owns `opened` and the has-text array. API: live getters `opened` and `hasText` (the current array, no copy), `open(book)` (sets the book and a fresh array filled with `undefined`), `clear()`, `chapterSentences`, `findTextChapter` (exported `TextChapter`), `scanChapters`. `main.ts` creates it as `bookStore`, before `loaded` and before the first `refreshSavedUi()`, and calls `bookStore.chapterSentences(...)` etc. directly (no wrappers).

Results: `npm run typecheck` OK (`boundaries OK: 19 files, 38 imports, 0 cycles, 8 engine files checked`), `npm test` 112 passed (9 files, new `book.test.ts`, 9 tests), `npm run test:e2e` 14 passed (12.6 s). `dist` has no `mock` string.

| File in `dist/assets` | Size (vite, kB) | Step 4c |
|---|---|---|
| `index-6z_pOJXp.js` | 408.96 | 408.54 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-Bphzjj0A.js` (409.14 kB).

Line counts: `src/main.ts` 1587 (was 1632), `src/engine/book.ts` 88.

## Step 5b result

Step 5b moves the library flows into `src/engine/library.ts` (`createLibrary(deps)`). It owns `bookToken`, `bookRemembered`, `bookBusy`. API: live getters `remembered` and `busy`, `pick(file)`, `restore()`, `forget()`. `showBook`, `formatSize` and `showBookInfo` are private. Deps: `hooks`, `bookStore`, `isGenerating`, `cancelGeneration`, `activeGeneration` (live getter), `unloadChapter`, `isNavigating`, `isPaused`, `voicesBusy`. New hooks: `setBookInfo`, `appendBookInfo`, `fillChapters`, `clearChapters`, `refreshSaved`. `unloadChapter` stays in `main.ts` (playback code). The DOM listeners stay in `main.ts`; the `fileInput` listener reads the file, clears the input, then calls `library.pick(file)`.

Results: `npm run typecheck` OK (`boundaries OK: 20 files, 45 imports, 0 cycles, 9 engine files checked`), `npm test` 143 passed (10 files, new `library.test.ts`, 31 tests), `npm run test:e2e` 14 passed (12.6 s). `dist` has no `mock` string.

| File in `dist/assets` | Size (vite, kB) | Step 5a |
|---|---|---|
| `index-B2bJlnE8.js` | 409.62 | 408.96 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-DuAEKRiE.js` (409.80 kB).

Line counts: `src/main.ts` 1474 (was 1587), `src/engine/library.ts` 198.

## Step 6 result

Step 6 moves the media session code into `src/engine/media-session.ts` (`createMediaSession(deps)`). API: `setup`, `updatePositionState`, `resetPositionState`, `setMetadata`, `setPlaybackState`. `main.ts` calls `mediaSession.setup()` at the old `setupMediaSession()` position. `playFromMediaSession`, `seekWithinSegment` and the pause action (`pauseFromMediaSession`) stay in `main.ts`.

Results: `npm run typecheck` OK (`boundaries OK: 21 files, 48 imports, 0 cycles, 10 engine files checked`), `npm test` 158 passed (11 files, new `media-session.test.ts`, 15 tests). `dist` has no `mock` string. `npm run test:e2e`: 13 of 14 passed; Firefox "continuous playback" timed out twice (see the report).

| File in `dist/assets` | Size (vite, kB) | Step 5b |
|---|---|---|
| `index-D9LJe0P2.js` | 410.08 | 409.62 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-BzMGaTTM.js` (410.26 kB).

Line counts: `src/main.ts` 1431 (was 1474), `src/engine/media-session.ts` 91.

## Step 7 result

Step 7 moves the playback core into `src/engine/playback.ts` (`createPlayback(deps)`), as one block. No logic line changed. Scoping and dependency edits only (see the report).

Results: `npm run typecheck` OK (`boundaries OK: 22 files, 59 imports, 0 cycles, 11 engine files checked`), `npm test` 163 passed (12 files, new `playback.test.ts`, 5 tests), `npm run build` and `build:e2e` OK, `dist` has no `mock` string. `npm run test:e2e` run twice, 14 of 14 both times.

| File in `dist/assets` | Size (vite, kB) | Step 6 |
|---|---|---|
| `index-rz1kmTrW.js` | 411.25 | 410.08 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

Same asset list, no new chunk. The e2e build has `index-D3HHscmy.js` (411.43 kB).

Line counts: `src/main.ts` 464 (was 1431), `src/engine/playback.ts` 1098.

Module-load registration order (same before and after):

1. injectIsolationWorker, log lines, `diagnostics.reportStaleMarker()`
2. workerClient created (then `createPlayback`, which has no side effect)
3. `setInterval` persist (calls `playback.persistPosition`), `diagnostics.startHeartbeat()`, `refreshSavedUi()`
4. page lifecycle listeners (`visibilitychange`, `pagehide`, `pageshow`, `freeze`, `resume`)
5. `diagnostics.logAudioEvents()`, `diagnostics.setupAudioSession()`
6. audio `play` (wantPlaying), audio `pause` (recovery) -> now `playback.registerPlayPauseListeners()`
7. `mediaSession.setup()`
8. audio `timeupdate` -> now `playback.registerTimeUpdateListener()`
9. text `click` (stays in main, calls `playback.clickSentence`)
10. audio `ended` -> now `playback.registerEndedListener()`
11. speed listeners, audio `ratechange`
12. `initSettings()`, then UI wiring (audio `play`/`pause` -> notifyChange), `library.restore()`, `log("ready")`

`createPlayback` dependencies: `audio`, `hooks`, `workerClient`, `settings` (only `applyPlaybackRate`), `getVoiceId`, `isVoicesBusy`, `isLibraryBusy`, `bookStore`, `mediaSession`, `segmentTargetS`.

Oddities noticed, not fixed:

- `recoverPlayback` sets `recoveryCausedPause` inline instead of calling `ignoreSourceChangePause()`. Same effect.
- `playingChapterIndex` doc and `selectChapter` log text say "while generating" even when called while idle and navigating.
- `view()` reads the select value through `hooks.getSelectedChapter()` on every call (DOM read as state source, known).

## Step 8 result

Step 8 moves the UI shell into `src/ui/shell.ts` (`createShell()`). `createShell` collects the DOM elements and builds the hooks. It returns phase methods that hold the old DOM code. The engine modules do not exist yet at that point, so `shell.bind({...})` gives the shell its engine references. `main.ts` is now the boot list. No logic line changed.

Results: `npm run typecheck` OK (`boundaries OK: 23 files, 68 imports, 0 cycles, 11 engine files checked`), `npm test` 163 passed (12 files), `npm run build` and `build:e2e` OK, `dist` has no `mock`, `segmentSeconds`, `e2e-worker` or `EPUB_TTS_MOCK_WORKER` string. `npm run test:e2e` run twice, 14 of 14 both times.

| File in `dist/assets` | Size (vite, kB) | Step 7 |
|---|---|---|
| `index-T3oUztOn.js` | 412.36 | 411.25 |
| `ort.wasm.min-4XBKGcRb.js` | 141.89 | 141.89 |
| `piper-o91UDS6e-DchrM4kQ.js` | 88.80 | 88.80 |
| `worker-Bf42NmSi.js` | 16.11 | 16.11 |

The e2e build has `index--w2pLEpc.js` (412.54 kB) and the same `worker.mock` chunk (0.87 kB).

Line counts: `src/main.ts` 97 (was 464), `src/ui/shell.ts` 437. Main is over the 80-line target because the factory calls with their dependency objects take about 50 lines.

Boot order, before (old `main.ts`) and after (`main.ts` calling the shell). The order is the same:

1. refs, `VERSION_LABEL`, hooks object (no side effect except the version text)
2. `createDiagnostics`
3. `injectIsolationWorker`, two log lines (`shell.logEnvironment()`)
4. `diagnostics.reportStaleMarker()`
5. `createBook`, `createMediaSession`, `createSettings`, `createVoicesStore`, `createLibrary`, `createWorkerClient`, `createPlayback` (`shell.bind` is new and has no side effect)
6. `setInterval` persist (`shell.startPersistTimer()`)
7. `diagnostics.startHeartbeat()`
8. `refreshSavedUi()` (`shell.refreshSavedUi()`)
9. page lifecycle listeners (`shell.registerLifecycleListeners()`)
10. `diagnostics.logAudioEvents()`, `diagnostics.setupAudioSession()`
11. `playback.registerPlayPauseListeners()`
12. `mediaSession.setup()`
13. `playback.registerTimeUpdateListener()`
14. text `click` (`shell.registerTextClickListener()`)
15. `playback.registerEndedListener()`
16. speed, `ratechange`, voice listeners (`shell.registerSettingsListeners()`)
17. `initSettings()` (`shell.initSettings()`)
18. file, audio `play`/`pause`, forget, chapter, generate, cancel, resume, copy-log listeners (`shell.registerControlListeners()`)
19. `library.restore()`, `log("ready")`

Differences beyond scoping: the old `selectedVoiceId()` is now `settings.voiceId` in `main.ts` (factory dependencies) and `engine().settings.voiceId` in the shell. The shell reads engine modules through `engine()`, which throws if `bind` has not run. The old code would have hit a temporal-dead-zone error in the same case.
