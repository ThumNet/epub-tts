---
title: Draw the UI from state with one render(state)
date: 2026-10-26
branch: refactor/store-render (from main 5577d99)
status: proposed. The user answered the four open questions (see "Answered"). The user confirms before step 0 starts.
parent: plans/2026-10-25-release-v1.md, phase 4 step 3
---

# Draw the UI from state with one `render(state)`

## Verdict

Keep the engine modules as the owners of engine state. Add one small UI state object in the shell for the UI-only fields.
Turn every hook into "update state, then call `render(snapshot())` synchronously". Do not add a subscribe store.

Why: the engine already exposes live views (`playback.view()`, `voices.*`, `library.*`, `bookStore.opened`).
A second copy of that state in a store adds a sync problem and changes nothing for the user.
Synchronous render keeps the exact call order that the split preserved (`plans/2026-10-25-engine-split-design.md:207`).
The engine does not change, apart from removing one DOM read (`getSelectedChapter`).

Decision (user accepted): there is no central store. Engine state stays in the engine modules, and `notifyChange()` calls `render(snapshot())` synchronously.
A central store would give one fact two owners (the engine and the store). The app has no UI framework yet, so a store has no consumer that needs it.
A thin UI-state store stays an option if the tripwire in section 8 is reached.

Exception to "no behaviour change": this PR replaces the speed slider with minus and plus buttons. It is a new first step, step 0 (section 6a).

## 1. State shape

### Today: every DOM write that reflects state

| # | Write site | What it writes | Replaced by state field |
|---|---|---|---|
| 1 | `src/ui/shell.ts:247` | `generateButton.disabled` | derived: `controls.generate` |
| 2 | `src/ui/shell.ts:248` | `cancelButton.disabled` | derived: `controls.cancel` |
| 3 | `src/ui/shell.ts:250` | `resumeButton.disabled` (reads `loadPosition()` at 249) | derived from `saved` |
| 4 | `src/ui/shell.ts:251` | `voiceSelect.disabled` | derived |
| 5 | `src/ui/shell.ts:252-253` | `forgetButton.hidden`, `.disabled` (reads `audio.paused`) | derived from `library.remembered`, `paused` |
| 6 | `src/ui/shell.ts:254` | `fileInput.disabled` | derived from `library.busy` |
| 7 | `src/ui/shell.ts:255-256` | Previous / Next `.disabled` | derived from `playback.view()` (`src/engine/playback.ts:1084-1093`) |
| 8 | `src/ui/shell.ts:257-258` | voice download / remove `.disabled` | derived from `voices.stored` |
| 9 | `src/ui/shell.ts:259-270` | `voiceStatus.textContent` (5 branches) | derived: `voiceStatusText` |
| 10 | `src/ui/shell.ts:90` (hook `setStatus`) | `statsElement.textContent` | `ui.status` |
| 11 | `src/ui/shell.ts:93` (hook `showChapter`), `:392` | `chapterSelect.value` | `ui.selectedChapter` |
| 12 | `src/ui/shell.ts:109`, `:112` (`setBookInfo`, `appendBookInfo`) | `bookInfo.textContent` | `ui.bookInfo` |
| 13 | `src/ui/shell.ts:115-116` (`fillChapters`) | select options, `disabled = false` | `ui.chapters` (array identity) |
| 14 | `src/ui/shell.ts:119-120` (`clearChapters`) | empty options, `disabled = true` | `ui.chapters = []` |
| 15 | `src/ui/shell.ts:155-160` (`refreshSavedUi`) | `savedElement.textContent` | derived from `saved` and `bookStore.opened` |
| 16 | `src/ui/shell.ts:230-231` (`showSpeed`) | `speedLabel` text only, after step 0 (the `speedInput.value` write goes away). Also `#speed-down` / `#speed-up` `.disabled` at the limits (new in step 0) | `settings.speed`, derived |
| 17 | `src/ui/shell.ts:306` | `voiceSelect.value` | `settings.voiceId` |
| 18 | `src/ui/shell.ts:350`, `:353` | `copyStatus.textContent` | `ui.copyStatus` |

Removed by step 0: the `speedInput.value` write in `showSpeed` and the `input` listener write to `speedLabel` (`src/ui/shell.ts:277`, was row 17, `ui.speedDraft`). The slider no longer exists, so these write sites go away.

Writes that stay imperative are in section 4: `:97-101`, `:105`, `:196-208`, `:301`, `:362`, `:74`.

### Proposed snapshot

```ts
// ui/state.ts — sketch, not code to paste
interface UiState {            // owned by the shell, mutated only by hooks and listeners
  status: string;              // stats line
  bookInfo: string;
  chapters: ReadonlyArray<ChapterInfo>;  // replaced, never mutated; identity marks a refill
  selectedChapter: number;     // was the select value
  copyStatus: string;
}
interface Snapshot {           // built on each render, plain values, no copies of engine objects
  ui: UiState;
  playback: PlaybackView;      // generating, navigating, navigationBase, hasPrev, hasNext
  voices: { busy: boolean; stored: boolean | undefined; message: string; error: string | undefined };
  library: { busy: boolean; remembered: boolean };
  book: { id: string; title: string } | undefined;
  settings: { voiceId: string; speed: number };
  saved: SavedPosition | undefined;      // loadPosition(), read once per render
  paused: boolean;                       // audio.paused
}
```

Ownership:

- **Engine-owned** (read through live getters, never stored twice): `playback`, `voices`, `library`, `book`, `settings`.
- **Browser-owned**: `saved` (localStorage), `paused` (the audio element). The snapshot reads them. Today `updateControls` reads them the same way (`src/ui/shell.ts:249`, `:253`).
- **UI-only**: everything in `UiState`.

`status` and `bookInfo` are UI-only on purpose. The engine pushes text through hooks today. Moving the text into engine state is a behaviour-neutral but larger change. Defer it.

Decision (user): `status` and `bookInfo` stay plain strings in this PR. The design pass decides whether to give them structure (kind and text).
The `UiState` text fields are the seam for that change (for example `status: { kind, text }`). Do not do it here.

## 2. Store mechanics

| | (a) Tiny `subscribe/set` store holding all state | (b) Engine stays owner, `notifyChange` → `render(snapshot())` (**recommended**) |
|---|---|---|
| Engine change | Every engine module writes to the store. Many write sites in the core. | None, except `getSelectedChapter` (section 3). |
| Risk | Two sources of truth during migration. A missed write shows stale UI. | Low. Hooks keep their call sites (`src/engine/playback.ts:544-551`, `src/engine/library.ts:72-80`). |
| Fit with the design pass | Good | Good. `render` takes one plain `Snapshot`. Tests build snapshots by hand. |
| Tripwire to Vue/Preact | Moves closer to a framework store. | Same. A framework would replace `render`, not the engine. |

Publish path: each hook body becomes `ui.x = value; renderAll()`. `notifyChange` becomes `renderAll()`. `renderAll()` is `render(snapshot(), dom)`.

### Synchronous, not batched

Render runs synchronously inside every hook. Do not use `queueMicrotask` or `requestAnimationFrame`.

What batching would change:

- **Status line.** `setStatus` is often followed by an `await` (`src/engine/playback.ts:981`, `:640`). With rAF the user would see no intermediate text in some runs. e2e tests that wait for a status text could time out or flake.
- **Chapter fill order.** `fillChapters` (`src/engine/library.ts:72`) runs before `showChapter` (`:77`). With batching the order no longer matters, but with synchronous render it must be kept. Render writes options first, then `value`. That keeps the order inside one render.
- **Highlight and scroll.** `highlight` (`src/engine/playback.ts:395`) runs after `renderChapter` (`:545`, `:749`). The spans must exist. Highlight stays imperative (section 4), so this is unchanged.

Cost: a full controls render per hook. There are about 60 hook calls in the engine. Each render touches about 20 elements. This is cheap. Do not optimise.

Guard: e2e stays unchanged. Any test edit in this PR is a finding that the reviewer must explain.

## 3. DOM reads that are state today

| Read | Where | Moves to |
|---|---|---|
| `Number(chapterSelect.value)` | hook `getSelectedChapter`, `src/ui/shell.ts:107`. Called by `navigationBase()` on every `view()` (`src/engine/playback.ts:1037`, `plans/2026-10-25-engine-split-baseline.md:276`), and by generate (`src/ui/shell.ts:384`) and chapter change (`:376`). | `ui.selectedChapter`. The `change` listener sets it from the event, then calls the engine. `showChapter` sets it. The hook returns the field. |
| `voiceSelect.value` | `src/ui/shell.ts:290` | Already `settings.voiceId` since step 4. The listener stays. Render writes `voiceSelect.value = settings.voiceId`. |
| `speedInput.value` | `src/ui/shell.ts:276`, `:280` | Gone after step 0. The slider no longer exists. The button listeners read `settings.speed` and call `setSpeed`. |

Edge case for `selectedChapter`. Today an empty select gives `Number("") === 0`. A value that is not an option also gives `""` and then `0`.
Keep this: initial value `0`. `clearChapters` sets it to `0`. `showChapter` stores the index as given.
Then render writes `chapterSelect.value`. If the index is not an option, the DOM shows nothing, like today.
This can differ from today in one case: `showChapter(i)` with `i` out of range now returns `i` instead of `0`.
I did not find a call that does this. The reviewer must check `src/engine/library.ts:77` and `src/engine/playback.ts:952`, `:988`.

Keep `getSelectedChapter` in `EngineHooks` for this PR. Removing it from the engine would touch `navigationBase`. That is an engine change with no user benefit.

## 4. Writes that stay imperative

| Write | Where | Why |
|---|---|---|
| `renderText(sentences)` | `src/ui/shell.ts:195-209` | Hundreds of spans. Rebuild only when the chapter changes. Putting sentences in state invites a full rebuild per render. |
| `highlight` and `scrollIntoView` | `src/ui/shell.ts:96-103` | Scroll is an action, not a state. A render that scrolls would scroll on every hook. |
| `clearText` | `src/ui/shell.ts:105` | Pair of `renderText`. |
| Clipboard and fallback textarea | `src/ui/shell.ts:329-346`, `:397-419` | One-off side effect. Only the result text moves to `ui.copyStatus`. |
| File input reset `fileInput.value = ""` | `src/ui/shell.ts:362` | Needed to re-fire `change` for the same file. Not state. |
| Voice option fill | `src/ui/shell.ts:301` | Static list, filled once at boot. |
| Version label | `src/ui/shell.ts:74` | Constant. |

## 5. Render strategy

Full render of all controls from the snapshot, with one guard:

1. **Chapter options:** rebuild only when `ui.chapters` identity differs from the last rendered array. Rebuilding on every render resets focus and an open picker on iOS.

The slider-drag guard is removed. After step 0 there is no slider and no drag, so `applyView` writes the speed label and the two button states on every render.

No generic diff. No virtual DOM. Split `render` into a pure part and a DOM part:

- `deriveView(snapshot): ControlsView`, pure. Returns `{ generate: { disabled }, ..., voiceStatusText, savedText, speedLabel }`. It is the logic of `updateControls` (`src/ui/shell.ts:243-271`) and `refreshSavedUi` (`:151-163`).
- `applyView(view, dom)`. Assignments only, no branches beyond the two guards.

`describePosition` needs `now`. Pass `now` into the snapshot so `deriveView` stays pure.

## 6a. Step 0: replace the speed slider with buttons

This is the one deliberate behaviour change in the PR. It comes first, so the later steps never handle a slider.

`index.html`:

- Replace `<input id="speed" type="range" ...>` (line 75) with two buttons around the existing `#speed-label`: `#speed-down` (label "−" or "Slower") and `#speed-up` (label "+" or "Faster").
- Keep `#speed-label` and `#speed-reset`. Update the `<label for="speed">` (line 74), because its target no longer exists. Use plain text or `aria-label`s on the buttons.
- CSS: remove the `#speed` rule (line 32). Give `#speed-down` and `#speed-up` `min-width: 44px; min-height: 44px` for a touch target. This is the one allowed CSS change. Keep `#speed-label` as is (line 33).

`src/ui/shell.ts`:

- Each press changes the speed by 0.25. Compute `roundSpeed(clampSpeed(settings.speed ± 0.25))`. Clamp to `SPEED_MIN` 0.75 and `SPEED_MAX` 2.
- Disable `#speed-down` at `SPEED_MIN` and `#speed-up` at `SPEED_MAX`. The disabled state is derived in `deriveView` once step 1 exists. Until then, set it in `showSpeed`.
- The log line keeps its format: `speed set to ...x (<reason>)`. The reasons are `slower`, `faster` and `reset`.
- Remove the `input` draft listener, the `speedDraft` field and the slider-drag guard in `applyView`. They have no purpose without a slider.
- `#speed-reset` stays and keeps its reason `reset`.

Saved speed: `localStorage` still loads as today. A saved value that is not a multiple of 0.25 stays valid. The old slider used step 0.05, so a saved 1.35 is possible.
The next press moves from that value and clamps. Example: 1.35 + 0.25 = 1.60, and 1.35 − 0.25 = 1.10.
Do not snap to the 0.25 grid. Snapping rewrites a user value without a user action. The grid adds no benefit, because the buttons already work from any value.

`tests/e2e/app.spec.ts`: replace the four `#speed` `fill` calls (lines 75, 89, 111, 125) with button presses. Keep the `#speed-label` assertions.

| Line | Old | New |
|---|---|---|
| 75 | `fill("1.5")` | press `#speed-up` twice (1.0 → 1.5) |
| 89 | `fill("0.75")` | press `#speed-down` once (1.0 → 0.75) |
| 111 | `fill("2")` | press `#speed-up` four times (1.0 → 2.0) |
| 125 | `fill("0.75")` | press `#speed-down` once (1.0 → 0.75) |

Check the starting speed at each line when you edit. If an earlier step in the same test changed the speed, press `#speed-reset` first, or adjust the press count.
Add one e2e assertion that `#speed-up` is disabled at 2.00x and `#speed-down` is disabled at 0.75x.

Unit test: add cases for the clamp at both limits and for a saved 1.35 (see section 7).

PR description: state the one-time user-visible change. The speed slider became two buttons. The speed step is 0.25. A saved speed stays valid.

## 6. Migration steps

Step 0 (section 6a) comes before steps 1-6.

Each step is one commit. Each step passes `npm run typecheck` (with the boundary check), `npm run build`, `npm test`, `npm run build:e2e`, `npm run test:e2e` (14 tests, Chromium and Firefox), and an independent review.

| # | Change | Main risk | Guard |
|---|---|---|---|
| 0 | Replace the speed slider with `#speed-down` / `#speed-up` buttons (section 6a). Update the four e2e `fill` lines. Remove `speedDraft` and the `input` listener. | A wrong clamp or a stale button state. A saved off-grid speed. | Unit test for clamp and off-grid. e2e "speed" with button presses. |
| 1 | Add `ui/view.ts` with pure `deriveView(snapshot)` and unit tests. `updateControls` builds a snapshot and applies the result. Voice status text and `refreshSavedUi` text included. | A flag inverted while moving the logic | Unit table with one case per row in section 1. Reviewer compares each boolean line by line with `src/ui/shell.ts:247-270`. |
| 2 | Add `UiState`. `setStatus`, `setBookInfo`, `appendBookInfo`, copy status write the field, then render the text. | `appendBookInfo` after an `await` concatenates onto stale text | Same string results. e2e "open and remember". |
| 3 | `selectedChapter` in `UiState`. `showChapter` and select `change` set it. `getSelectedChapter` returns it. | Value differs from the old `Number(select.value)` in edge cases (section 3) | e2e "navigation", "jump", resume. Reviewer checks every `showChapter` call. |
| 4 | `chapters` in `UiState`. `fillChapters`/`clearChapters` set it. Render rebuilds options on identity change, then sets `value`. | Fill and select order. Disabled state of the select | e2e "open and remember", "navigation". |
| 5 | Speed: `showSpeed` (label and button states) goes through render. Voice select value from `settings.voiceId`. | A stale label or button state | e2e "speed". |
| 6 | Merge: one `render()` function. `notifyChange` and `refreshSaved` both call it. Remove `updateControls`, `showSpeed`, `refreshSavedUi` bodies. | A hook that no longer renders a field it used to | grep: no `.textContent =`, `.disabled =`, `.value =` in `shell.ts` outside `applyView` and section 4 sites. |

Steps 2-5 do not depend on each other after step 1. Keep the order to keep reviews small.

**Rollback rule.** If a step fails the e2e suite or the review twice, revert the step commit. Do not patch forward a third time. Redo the step smaller. A single flaky e2e test may be re-run once. A second failure counts.

## 7. Testing

- **Unit (vitest, Node, no DOM):** `deriveView` takes a hand-built `Snapshot`. Cases:
  - locked by `generating`, by `voices.busy`, by `library.busy`;
  - Resume: no saved position, other book, same book;
  - Forget: hidden when not remembered, disabled while playing or navigating;
  - Previous/Next from `hasPrev`/`hasNext` and `navigating`;
  - voice status: all 5 branches, unknown voice falls back to 61 MB;
  - saved text: none, matches, other book (fixed `now`);
  - speed label from `settings.speed`;
  - speed buttons: `#speed-down` disabled at 0.75, `#speed-up` disabled at 2, both enabled between;
  - speed press: ±0.25 clamps at both limits, and a saved 1.35 moves to 1.60 / 1.10.
- **e2e:** the only test edits are the four speed lines changed in step 0, plus one assertion for the disabled buttons at the limits. Any other e2e edit needs a reason in the PR.
- **Boundary check:** unchanged. `src/engine/*` stays DOM-free. `ui/view.ts` must not import `document` either, so tests run in Node. Add it to the boundary script.

## 8. Out of scope

- The visual redesign stays out of scope. That is phase 4 step 4. The one exception is the speed control (step 0): its buttons, labels and CSS.
- No other behaviour change, also not for known oddities (`plans/2026-10-25-engine-split-baseline.md:272-276`). Step 0 is the only exception.
- No engine state moved into a store. No change to tokens, timing or hook call sites in `src/engine/*`.
- No framework. Tripwire for Vue or Preact: a third screen, or more than about 8 components that share state.
- No structured status messages. Strings stay strings.

## Where this plan can hurt

- The snapshot calls `playback.view()`, which calls `hasTextChapter` twice per render. That is cheap now. It is worth a look if render runs per `timeupdate` later.
- `loadPosition()` parses localStorage on every render. Today it does the same in `updateControls` (`src/ui/shell.ts:249`). Keep it. Cache only if a profile shows a cost.
- Section 3's edge case is the one possible behaviour change. If the reviewer finds a call that passes an out-of-range index, clamp to `0` to match today.

## Answered

1. **Store:** no central store. Engine state stays in the engine modules (option b).
2. **`status` and `bookInfo`:** plain strings in this PR. The design pass decides on structure.
3. **Speed slider:** replace it with minus and plus buttons now, as step 0. This also removes the slider-drag check that the old question 3 asked about.
4. **Tripwire:** unchanged. A third screen, or more than about 8 shared-state components, triggers Vue or Preact.

## Open questions for the user

None.

## Step 0 result

Done. The speed slider is now two buttons.

Files changed:

- `index.html`: removed `#speed` and its CSS rule. Added `#speed-down` ("−", aria-label "Slower") and `#speed-up` ("+", aria-label "Faster") with `min-width: 44px; min-height: 44px`. The `<label for="speed">` became a plain `<span>Speed</span>`.
- `src/engine/pure.ts`: added `SPEED_STEP` (0.25) and `stepSpeed(current, direction)`. It returns `roundSpeed(current + direction * 0.25)`.
- `src/ui/shell.ts`: removed the slider ref and the `input` and `change` listeners. Added click listeners with reasons `slower` and `faster`. `showSpeed` writes the label and both disabled states, so it is the one place for them.
- `tests/unit/pure.test.ts`: three `stepSpeed` cases (steps, both limits, off-grid 1.35 gives 1.6 and 1.1).
- `tests/e2e/app.spec.ts`: see below.

Test counts: unit 166 passed (12 files). e2e 14 of 14 passed, twice. `typecheck`, `build` and `build:e2e` pass. `dist` has no "mock" string.

e2e edits:

- "generate and play": `fill("1.5")` became two `#speed-up` clicks.
- "chapter navigation": `fill("0.75")` became one `#speed-down` click, plus `#speed-down` `toBeDisabled()` (0.75x).
- "continuous playback": `fill("2")` became four `#speed-up` clicks, plus a `2.00x` label check and `#speed-up` `toBeDisabled()`.
- "jump": `fill("0.75")` became one `#speed-down` click.

All tests start at 1.0x, so no `#speed-reset` press was needed.

## Step 1 result

Done. `deriveView(snapshot)` is pure. `updateControls`, `refreshSavedUi` and `showSpeed` build a snapshot, derive, and apply only their own subset.

Files:

- `src/ui/view.ts` (new): `Snapshot`, `ControlsView`, `deriveView`. No DOM, no `document`/`window`.
- `src/ui/shell.ts`: added `snapshot()`. It reads `playback.view()`, `voices`, `library`, `bookStore.opened`, `settings`, `loadPosition()` (once), `audio.paused` and `Date.now()` at call time. Nothing is cached. The three functions keep their names and call sites. `updateControls` keeps the old order of assignments.
- `tests/unit/view.test.ts` (new): 34 tests. Unit total 200 (was 166).

Mapping of old line to `ControlsView` field (old `locked = generating || voices.busy || library.busy`):

| Old write | Field |
|---|---|
| `generateButton.disabled = locked \|\| !bookStore.opened` | `generateDisabled = locked \|\| !book` |
| `cancelButton.disabled = !view.generating` | `cancelDisabled` |
| `resumeButton.disabled = locked \|\| !saved \|\| opened?.id !== saved.bookId` | `resumeDisabled` |
| `voiceSelect.disabled = locked` | `voiceSelectDisabled` |
| `forgetButton.hidden = !library.remembered` | `forgetHidden` |
| `forgetButton.disabled = locked \|\| library.busy \|\| navigating \|\| !audio.paused` | `forgetDisabled` (uses `paused`) |
| `fileInput.disabled = library.busy` | `fileInputDisabled` |
| prev: `voices.busy \|\| library.busy \|\| navigating \|\| !hasPrev` | `prevDisabled` |
| next: same with `!hasNext` | `nextDisabled` |
| `voiceDownloadButton.disabled = locked \|\| stored !== false` | `voiceDownloadDisabled` |
| `voiceRemoveButton.disabled = locked \|\| stored !== true` | `voiceRemoveDisabled` |
| `voiceStatus.textContent` (busy: message; error; unknown; stored; else size, fallback 61) | `voiceStatusText` |
| `savedElement.textContent` in `refreshSavedUi` | `savedText` |
| `speedLabel.textContent` in `showSpeed` | `speedLabel` |
| `speed <= SPEED_MIN`, `speed >= SPEED_MAX` | `speedDownDisabled`, `speedUpDisabled` |

Differences:

- `refreshSavedUi` and `showSpeed` now call `playback.view()` and the other reads through `snapshot()`, although they apply one field. These reads have no side effects. `refreshSavedUi` also still calls `hooks.notifyChange()` after writing the text.
- `voices.error` is a `string` in the engine, so the snapshot type is `string`, and the check stays a truthiness test.
- `selectedVoiceId()` stays in the shell for the resume log line.
- Boundary script: not changed. It only checks `src/engine`. A DOM-free rule for `ui/view.ts` needs a new function and a new summary line. Left for a decision. `view.ts` is DOM-free today and its test runs in Node.

Checks: `typecheck`, `build`, `build:e2e` pass. e2e 14 of 14 twice, no e2e edits. `dist` has no "mock" and the same four assets.

## Step 2 result

Done. The shell holds `ui: UiState` (`status`, `bookInfo`, `copyStatus`). `applyTexts()` writes the three elements from it. No behaviour change.

Files:

- `src/ui/state.ts` (new, DOM-free): `UiState` and `createUiState()`. Initial values equal `index.html`: status `"Idle."` (`#stats`), bookInfo `""` (`#book`), copyStatus `""` (`#copy-status`).
- `src/ui/shell.ts`: `ui` and `applyTexts()` (lines 79-88). No diff guard.

Write sites converted (`src/ui/shell.ts`, new line numbers):

| Old write | New |
|---|---|
| `setStatus`: `statsElement.textContent = text` | line 100: `ui.status = text; applyTexts()` |
| `setBookInfo`: `bookInfo.textContent = text` | line 120: `ui.bookInfo = text; applyTexts()` |
| `appendBookInfo`: `bookInfo.textContent += text` | line 124: `ui.bookInfo += text; applyTexts()` |
| `showCopyStatus`: `copyStatus.textContent = message` | line 351: `ui.copyStatus = message; applyTexts()` |
| `showCopyStatus` timer: `copyStatus.textContent = ""` | line 355: `ui.copyStatus = ""; applyTexts()` |

Other writers: none. A grep of `src` finds the three `textContent` writes only in `applyTexts` (lines 85-87). `src/engine/hooks.ts` only mentions them in comments. The `+=` is equal to the old one because `ui.bookInfo` always holds the last assigned string.

No unit tests added: there is no pure logic beyond assignment.

Checks: `typecheck`, `build`, `build:e2e` pass. Unit 203 passed (13 files). e2e 14 of 14 twice, no e2e edits. `dist` has no "mock" and the same four assets.

## Step 3 result

Done. `UiState` has `selectedChapter: number` (initial 0). The select stays the owner of options. No behaviour change. Files: `src/ui/state.ts`, `src/ui/shell.ts`.

Two helpers in `shell.ts`:

- `applySelectedChapter()` writes `chapterSelect.value = String(ui.selectedChapter)` and then syncs back from the DOM.
- `syncSelectedChapterFromDom()` sets `ui.selectedChapter = Number(chapterSelect.value)`. Step 4 removes it.

Sites converted:

| Old | New |
|---|---|
| hook `showChapter`: `chapterSelect.value = String(index)` | `ui.selectedChapter = index; applySelectedChapter()` |
| hook `getSelectedChapter`: `Number(chapterSelect.value)` | `ui.selectedChapter` |
| select `change` listener (engine read via the hook) | `syncSelectedChapterFromDom()` first, then the engine call |
| generate click (engine read via the hook) | `syncSelectedChapterFromDom()` first, then `generateChapter` |
| hook `fillChapters` | `syncSelectedChapterFromDom()` after the DOM fill |
| hook `clearChapters` | `ui.selectedChapter = 0` |

The resume click calls `hooks.showChapter`, so it is covered. Library preselect is also covered.

DOM read-back syncs (the DOM-as-state leftovers for step 4):

1. `applySelectedChapter()`, after each `showChapter` write.
2. `change` listener.
3. Generate click.
4. `fillChapters`, after `replaceChildren`. The browser picks the first option.
5. `clearChapters` sets 0 directly. This equals `Number("")`.

`showChapter` call sites, out-of-range check:

- `library.ts:77`: guarded by `opened.chapters[savedPosition.chapterIndex]`. Always in range.
- `playback.ts` calls (544, 748, 952, 988, 1043): the index is a run, target or playing chapter index, so it should be in range. I did not prove this for every path.
- Resume click in `shell.ts`: the saved index is not checked against the chapter list. It can be out of range if the saved position is stale. The read-back then gives 0, the same as the old code.

Checks: `typecheck`, `build`, `build:e2e` pass. Unit 203 passed. e2e 14 of 14 twice, no e2e or engine edits. `dist` has no "mock". The `dist` assets are unchanged: worker, piper, ort.wasm and index. The only `Number(chapterSelect.value)` left in `src` is in `syncSelectedChapterFromDom()` (a comment in `hooks.ts` also mentions it).
