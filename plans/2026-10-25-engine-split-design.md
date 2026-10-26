---
title: Split the engine out of src/main.ts
date: 2026-10-25
branch: feat/release-foundation (PR #3)
status: proposed. The user confirms before any extraction starts.
parent: plans/2026-10-25-release-v1.md, phase 4 step 2
---

# Split the engine out of `src/main.ts`

## Verdict

Move code into owner modules with explicit factories and two synchronous hooks (`notifyChange`, `setStatus`).
Move the playback core as one block, last, nearly verbatim. Do not split the core internally in this PR.

Why: every subtle bug so far lived in the core. The split must not change its timing or its token checks.
Synchronous hooks keep the call order identical. They are also the exact seam the later `render(state)` step needs.

## 1. What `main.ts` does today (1,989 lines)

| Cluster | Lines | State it owns | State it reads from others |
|---|---|---|---|
| Config and DOM lookups | 21-72 | constants, 25 element refs | `location` (E2E `segmentSeconds`) |
| Environment and diagnostics | 74-103, 296-347, 1923-1985 | stale marker, heartbeat timers, `copyStatusTimer` | `audio`, `loaded`, `currentSentence` |
| Worker client | 200-258, 904-1041 | `worker`, `workerReady`, `workerVoiceId`, `workerUsed`, `onWorkerEvent`, `rejectPending`, `initPending`, `workerQueue` | writes `statsElement` (progress), calls `refreshVoiceStatus` |
| Saved position | 260-309 | none (localStorage) | `openedBook`, `loaded`, `currentSentence`, `audio` |
| Watchdog and recovery | 377-554 | `recoveryOwner`, `recoveryCausedPause`, `watchToken`, `attemptsUsed` | writes `loaded.url`, `wantPlaying`; reads `buffering` |
| Media session | 556-647 | `lastPositionState` | `loaded`, `openedBook`; calls `loadSegment`, `navigateChapter` |
| Text and highlight | 649-726 | `currentSentence` | `loaded`; calls `loadSegment`, `jumpToSentence` |
| Segment switching | 728-881 | `loadToken` | `loaded`, `pendingChapter`, `generating`, `buffering`, `wantPlaying`, `cancelEpoch`, `wakeGeneration`; writes DOM (select, text, stats) |
| Generation pipeline | 883-1371 | `generating`, `cancelRequested`, `cancelEpoch`, `generationVoiceId`, `pendingChapter`, `generatingChapterIndex`, `awaitingFirstSegment`, `activeGeneration`, `wakeGeneration`, `regenerations`, `wakeLock` | `openedBook`, `chapterHasText`, `loaded`, voice select |
| Cancel and navigation | 1373-1496, 1541-1572 | `navigating` | everything above, `chapterSelect.value` |
| Settings and voices | 1498-1718 | `speed`, `voiceBusy`, `voiceStored`, `voiceMessage`, `voiceError`, `voiceStatusToken` | `generating` |
| `updateControls()` | 1574-1601 | none | 12 flags across 5 clusters, `loadPosition()`, `audio.paused` |
| Library | 1722-1898 | `openedBook`, `chapterHasText`, `bookToken`, `bookRemembered`, `bookBusy` | `generating`, `navigating`, `activeGeneration`, `audio.paused` |
| Startup wiring | 1900-1989 | none | all |

### Coupling that breaks a naive split

- **Real call cycle in the core.** Switching calls the pipeline (`regenerateSegment`, `wakeGeneration`).
  The pipeline calls switching (`onSegmentReady` → `switchSegment`, `switchToPendingChapter`).
  The `ended` handler reads `generating` and `pendingChapter`. Two modules here means an import cycle.
- **Token families cross clusters.** `loadToken` (switching) is checked in `regenerateSegment` (pipeline).
  `cancelEpoch` (cancel) is checked in `loadSegment`. `watchToken` is bumped by the pause listener and the media session.
  `bookToken` gates `showBook`, which awaits `activeGeneration`.
- **Identity checks.** `loaded === active`, `loaded?.segments === run.segments`, `book !== openedBook`.
  These compare object identity. A copy or a getter that returns a new object breaks them silently.
- **Shared flags with many writers.** `wantPlaying` has 6 writers in 4 clusters. `buffering` has 9.
  `currentSentence` is written by switching, the pipeline and the library.
- **`updateControls()` reads everything.** It is called from 20 places. Some calls sit mid-function and the order matters
  (for example `switchToPendingChapter` calls it after `renderText`).
- **Module-load order.** The file runs top to bottom with side effects: the worker is created at line 224,
  `refreshSavedUi()` runs at 309 (it calls `updateControls`, which is hoisted, and reads `let` bindings declared earlier).
  `initSettings()` at 1718 and `restoreBook()` at 1987. Moving a `let` into a module that loads later causes a TDZ error.
- **Listener order on `audio`.** `play` and `pause` have 3 listeners each (lines 545/549, 619/620, 1846/1847).
  They run in registration order. The `wantPlaying` update must run before the controls refresh.
- **The DOM is a state source.** `selectedVoiceId()` reads `voiceSelect.value`. `navigationBase()` falls back to `chapterSelect.value`.
- **Worker URL seam.** `new Worker(new URL("./worker.ts", import.meta.url))` must stay a literal Vite can scan.
  `vite.config.ts` stubs `e2e-worker` by module id. A path change can ship the mock or drop the worker chunk.

## 2. Options

| | (a) File moves + shared mutable `state` module | (b) Owner modules, factories, sync hooks (**recommended**) | (c) Store with typed actions now |
|---|---|---|---|
| Risk | Low per step. Cycles stay hidden. | Low-medium. Core moves as one unit. | High. Rewrites every write site in the core. |
| Diff size | Small | Medium | Large |
| Testability | Poor. Everything reaches into `state`. | Good for pure parts and the worker client. | Good, but only after the risky rewrite. |
| Fit with store + render | Weak. A global bag is not a store. | Strong. `notifyChange` becomes `render(snapshot())`. | Already there, but it is the next step, done too early. |
| Main danger | Locks in the coupling under new file names. | A hook fired at another moment than before. | Changes async timing in the core. Not testable on iOS here. |

Hybrid inside (b): the core keeps its module-private `let` variables exactly as today.
Only the edges change: DOM writes become hooks, DOM reads become injected getters.

What I would NOT do:

- No event emitter with async or queued delivery. Every hook is a plain synchronous call.
- No splitting of switching, pipeline, watchdog and cancel into separate files in this PR. That is where the cycle lives.
- No getters that clone state. Identity checks must keep working.
- No class hierarchy. One factory per module, one returned object.

## 3. Target layout

```
src/
  main.ts                 boot only: create modules in today's order, wire hooks
  engine/                 no DOM queries, no `document`, no import from ui/
    config.ts             constants, segmentTargetSeconds()
    pure.ts               pure functions (see section 4)
    hooks.ts              EngineHooks type
    worker-client.ts      createWorkerClient()
    book.ts               createBook(): openedBook, chapterHasText, chapterSentences, findTextChapter, scan
    library.ts            createLibrary(): open, restore, forget; bookToken, bookRemembered, bookBusy
    voices-store.ts       createVoiceStore(): download, remove, refresh; voiceBusy, voiceStored, message, error
    settings.ts           speed, voiceId; load and persist
    media-session.ts      setupMediaSession(actions), setMetadata(), updatePositionState()
    playback.ts           the core, moved as one block (lines 377-1496 minus the parts above)
    diagnostics.ts        audio session, stale marker, heartbeat, audio event logging
  ui/
    shell.ts              byId, element refs, listeners, updateControls(view), renderText, highlight DOM, copy log
```

### Import rules

- `engine/*` imports only `engine/*`, `epub`, `store`, `book-store`, `voices`, `wav`, `log`, `protocol`, `e2e-worker`.
- `engine/*` never imports `ui/*` or `main`. It never touches `document`.
  It may use the `HTMLAudioElement` it receives, `navigator.mediaSession`, `URL`, timers.
- `ui/*` may import `engine/*` types and factories.
- No import cycles. `playback.ts` imports `book`, `worker-client`, `media-session`, `settings`. Nothing imports `playback` except `library` and `main`.
- Enforce with `scripts/check-boundaries.mjs` (grep `src/engine` for `from "../ui`, `document.`, `getElementById`). Run it in `npm run typecheck`.

### Interfaces (sketch, not code to paste)

```ts
// engine/hooks.ts — every hook is synchronous and called exactly where the old DOM write was.
export interface EngineHooks {
  notifyChange(): void;                 // was updateControls()
  setStatus(text: string): void;        // was statsElement.textContent = ...
  showChapter(index: number): void;     // was chapterSelect.value = String(index)
  renderChapter(sentences: Sentence[]): void; // was renderText()
  highlight(index: number): void;       // DOM part of highlight(); engine keeps currentSentence
  clearText(): void;                    // was textElement.replaceChildren()
  getSelectedChapter(): number;         // was Number(chapterSelect.value); DOM read stays in the shell
}

// engine/worker-client.ts
export interface WorkerClient {
  ensure(voiceId: string): Promise<void>;
  clip(text: string, voiceId: string): Promise<GeneratedClip>; // throws VoiceChangedError
  cancel(reason: string): void;   // terminate if initPending, else post "cancel"
  readonly ready: boolean;
}
export function createWorkerClient(hooks: { setStatus(t: string): void; onReady(): void }): WorkerClient;

// engine/playback.ts
export interface Playback {
  generateChapter(index: number, start?: number, preparsed?: Sentence[]): Promise<void>;
  cancel(): void;
  cancelAndWait(): Promise<void>;           // cancel + await activeGeneration (used by library)
  navigateChapter(step: 1 | -1, source: string): Promise<void>;
  selectChapter(index: number): Promise<void>;
  clickSentence(index: number): void;       // body of today's text click handler
  play(): void; pause(): void; seek(seconds: number): void;
  applySpeed(): void; unload(): void;
  persistPosition(reason: string): void;
  checkStuck(reason: string): void;         // visibilitychange "visible"
  view(): PlaybackView;                     // flags for updateControls; plain values, read-only
}
export interface PlaybackView {
  generating: boolean; navigating: boolean; paused: boolean;
  navigationBase: number; hasPrev: boolean; hasNext: boolean;
}
```

`updateControls()` moves to `ui/shell.ts` unchanged in logic. It reads `playback.view()`, `library.view()`,
`voices.view()` and `loadPosition()` instead of globals. Step 3 of the release plan then replaces it with
`render(snapshot())`, where `snapshot()` merges these views. No engine change is needed for that.

## 4. Extraction order

Each step is one commit. Each step passes: `npm run typecheck`, `npm run build`, `npm run build:e2e`,
`npm run test:e2e` (14 tests, Chromium and Firefox), the boundary check, and an independent code review.

| # | What moves | Shims left | Main risk | Guard |
|---|---|---|---|---|
| 0 | Tooling only: add vitest, `npm test`, boundary script. Record baseline: e2e green, list of `dist/assets` files, `grep -c mock dist` = 0. | none | none | baseline recorded in the PR |
| 1 | `config.ts`, `pure.ts` with unit tests. `main.ts` calls them. | none | an off-by-one in a rewritten helper | unit tests; e2e "generate and play", "jump" |
| 2 | Inside `main.ts` only: add `hooks` object; replace all `statsElement.textContent =` with `hooks.setStatus`, all `updateControls()` with `hooks.notifyChange()`. | hooks point at the old functions | a missed write site | grep shows 0 direct `statsElement` writes outside the hook; full e2e |
| 3 | `worker-client.ts` | `main.ts` keeps thin wrappers `ensureWorker`, `generateClip` | worker URL path (`../worker.ts`), eager creation order, `initPending` read by cancel | prod `dist` has the worker chunk and no mock; e2e "generate", "navigation", "jump"; one desktop run with real Piper and a voice change |
| 4 | `diagnostics.ts`, `settings.ts`, `voices-store.ts`. `selectedVoiceId()` reads `settings.voiceId`; the shell sets it on `change`. | none | listener order; voice value drift | e2e "startup" (5 voices, Kristin default), "speed"; manual voice download/remove on desktop |
| 5 | `book.ts`, `library.ts`. Library gets `playback` functions as injected deps (still in `main.ts`). | deps object | `bookToken` vs `activeGeneration` ordering in `showBook` | e2e "open and remember", "navigation" (scan drives Previous disabled) |
| 6 | `media-session.ts` | none | `lastPositionState` reset in 3 places | e2e speed test (ratechange); manual lock-screen check in the final phone pass |
| 7 | `playback.ts`: lines 377-1496 remaining, moved as a block. Only edits: DOM writes → hooks, globals → module-private. | none | TDZ, identity checks, listener order | full e2e twice; reviewer diffs the block with `git diff --color-moved` and checks zero logic lines changed |
| 8 | `ui/shell.ts` gets DOM refs, listeners and `updateControls`. `main.ts` becomes boot. | none | listener registration order | full e2e; boot order list in `main.ts` matches section 5 |

Steps 1-2 are cheap and catch tooling problems early. Step 7 is the only risky move and runs last, after all its dependencies exist.

### Unit tests (vitest, Node, no DOM)

| Function | Cases |
|---|---|
| `sentenceIn(segment, seconds)` | before first timing → start; exact boundary; past last; empty timings |
| `segmentForSentence(segments, index)` (from the click handler) | in first, in middle, not generated → -1 |
| `segmentsAhead(loadedLen, current, pendingLen?)` | loaded only; with pending; pending without loaded → 0 |
| `farSegments(count, current, behind, ahead)` | window edges; current never dropped |
| `playingChapterIndex(flags)` | awaiting first segment; loaded; generating without loaded; idle |
| `hasTextChapter(flags, from, step)` | unknown counts as maybe; all false; non-integer `from` |
| `clampSpeed`, speed rounding | below min, above max, 1.234 → 1.23 |
| `describePosition(p, now)` | minutes and padded seconds; inject `now` |
| `segmentTargetSeconds(search, e2e)` | no override; valid; 0 and NaN fall back to 60 |
| `joinClips` (`wav.ts`) | gaps produce timings; duration sums; header length |
| `loadPosition` / `loadSettings` parsing (`store.ts`) | missing, corrupt JSON, wrong types |
| `splitSentences` (`epub.ts`) | paragraph ends kept; abbreviations, if it handles them today |

Make functions pure by passing values in. Do not change their callers' behaviour to make them testable.

## 5. Risk register

| Risk | Where | Mitigation |
|---|---|---|
| Token or identity check breaks after a move | step 7 | Move the core verbatim. State stays module-private `let`. No getters that copy. Reviewer checks every `=== loaded`, `loadToken`, `cancelEpoch`, `watchToken` line is unchanged. |
| TDZ or load order | steps 3-8 | Factories, no top-level side effects in engine modules. `main.ts` calls them in today's order: isolation worker, logs, stale marker, worker, saved UI, timers, lifecycle and audio logging, audio session, media session, settings, restore. |
| Listener duplication or reordering | steps 4, 6, 8 | Each listener registered in exactly one place. Keep the order for `audio` `play`/`pause`: wantPlaying, mediaSession state, controls. Add a comment listing the order. |
| Hidden import cycle | all | Boundary script also runs `madge --circular` or a short custom check. No module imports `playback` except `library` and `main`. |
| Worker lifecycle | step 3 | Keep `created !== worker` stale-message guard. Keep `resetWorker` semantics. Real-Piper desktop check covers init timeout path and voice switch. |
| Worker URL scan and mock seam | step 3 | Keep the `new Worker(new URL(...), { type: "module" })` literal and the import of `../e2e-worker` by that name (the plugin regex matches `e2e-worker`). Compare `dist/assets` against the step-0 baseline. `grep worker.mock dist` must be empty. |
| Vite chunking changes | steps 3-8 | Compare asset list and sizes with the baseline. A new chunk is a finding, not a failure, but the reviewer must explain it. |
| Hook fired at a different moment | step 2, 7 | Hooks are synchronous and replace the write in place. Never batch, never defer. |
| e2e blind spots | all | The mock worker does not cover iOS audio, stuck playback, lock screen, memory. These stay for the final phone pass. Keep the watchdog code byte-identical so that pass tests the same logic. |

**Rollback rule.** If a step fails the e2e suite or the verifier twice, revert the step commit. Do not patch forward a third time.
Redo the step smaller. A single flaky e2e test may be re-run once; a second failure counts.

## 6. Acceptance criteria

- `src/main.ts` is boot only (under about 80 lines).
- `src/engine/*` has no `document` use and no `ui/` import. The boundary check passes in CI.
- No import cycles.
- typecheck, build, unit tests, and 14 e2e tests pass on every commit of the split.
- The production `dist` asset list matches the baseline, apart from explained chunk changes. No mock code ships.
- The watchdog, recovery, switching and pipeline code is unchanged apart from hook calls (`git diff --color-moved` review).
- Every log line text is unchanged. Logs are the only diagnostics on a phone.

### Non-goals

- No behaviour change. No new features. No UI redesign. No bug fixes, even known ones; note them for later.
- No store and no `render(state)` in this step.
- No split of the playback core into smaller files. Revisit after v1, with the phone pass as a baseline.
- No framework, no event bus library.

## Where this plan can hurt

- Step 7 is still a 700-line move. The review is the only real guard for iOS behaviour. Budget time for it.
- Injected getters (`getSelectedChapter`) keep the DOM as a state source. That is deliberate for this step. The store step must remove it.
- Vitest adds a dev dependency and a CI job. The release plan already asks for it, so this is not scope creep.
