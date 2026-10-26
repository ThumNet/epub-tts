---
title: Redesign the UI as one phone-first reader screen with sheets
date: 2026-10-26
branch: feat/redesign (from main a9ecb92)
status: proposed. The user answered the design interview (see "Answered"). The user approves the prototype screenshots before step 1 starts.
parent: plans/2026-10-25-release-v1.md, phase 4 step 4 (line 69)
---

# Redesign the UI as one phone-first reader screen with sheets

## Interview summary

All decisions are settled. No open questions remain.

- Phone first, scales up to desktop.
- One screen with sheets. No third screen.
- Calm reader. Reading text in a serif font.
- Warm amber accent.
- Light and dark follow the system. No manual toggle.
- Own Play/Pause button replaces the native audio controls.
- One primary action. Resume is the main action when a saved position exists.
- ~~Stop shows while generating.~~ Reversed 2026-10-26: there is no separate Stop button (see "Answered", item 16).
- The primary button shows a small icon beside its text (2026-10-26).
- One button during generation (2026-10-26). Before the first audio plays it reads "Stop" and cancels generation. Once audio plays it reads "Pause". There is no "starting" disabled state.
- Welcome state on first run.
- The text fills the free screen height.
- Element ids may change. The e2e tests keep the same behaviours.
- Prototype first, approved from screenshots only.
- All speed controls live in the "Voice and speed" sheet. The main screen has none.
- The native chapter picker stays in the Book sheet.
- Chapter Previous and Next move into the Book sheet (user decision 2026-10-26, after seeing the prototype). This reverses the earlier "chapter Previous and Next always visible". The main screen has none.
- The engine exposes `wantPlaying` in `PlaybackView`. This is the one allowed engine change.

## Verdict

Build one reader screen with three native `<dialog>` sheets. Derive the primary button purely in `deriveView`. Move the CSS to `src/styles.css`, linked from `index.html`.
Keep the render structure from the store-render plan: the same hooks, the same draw sections, no store, no framework.

Why: every settled requirement fits the existing `render()` split (`src/ui/shell.ts:95-144`). The primary button is one more derived field. The sheets are DOM containers. They hold no state that the engine needs.
The only engine change is one read-only flag, `wantPlaying` (section 2, gap G1). The user accepted it.

## Answered

These are settled. Do not reopen them.

1. **Target.** Phone first (iPhone), scales up to desktop. One screen with sheets that slide up from the bottom. No third screen. The Vue/Preact tripwire is unchanged: a third screen, or more than about 8 components that share state.
2. **Feel.** A calm reader. Reading text in a system serif stack (Iowan Old Style, Georgia). Controls in system sans. Accent: warm amber, for the primary button and the current-sentence highlight.
3. **Theme.** Light and dark follow `prefers-color-scheme`. No manual toggle. Today the page is dark only (`color-scheme: dark`, `index.html:15`, `theme-color` `#111111` at `index.html:6`). The redesign needs both palettes and one `theme-color` per scheme.
4. **Text size.** Fixed. It follows the system text size setting. No in-app control.
5. **Main screen** always shows:
   - the book title and the chapter name;
   - the reading text, which fills the free height and scrolls inside;
   - one primary button, full bar width: Listen, Resume, Stop, Pause or Play, with a small icon beside the text (item 16). (Chapter Previous and Next are not here. They moved into the Book sheet, item 15.) ~~A small Stop button shows while generation runs.~~ Reversed 2026-10-26 (item 16): the primary button itself reads "Stop" before the first audio plays. Stop is today's Cancel;
   - the status line (`#stats`), small.
6. **Resume.** When the open book has a saved position, Resume ("Resume at chapter N, 12 min ago") is the main action. "Listen from chapter start" becomes secondary.
7. **Audio.** An own Play/Pause replaces the native `<audio controls>` (`index.html:72`). The audio element stays, without controls. Media session lock screen controls stay. No progress bar. No new features.
8. **First run** with no book shows a welcome and a large "Open an EPUB" button.
9. **Sheets.**
   - Book and chapters: open another book, chapter list, Previous chapter and Next chapter buttons, Forget.
   - Voice and speed: voice select, download, remove, status, and all speed controls (Slower, speed label, Faster, Reset to 1x).
   - Diagnostics: copy log, log, version.
10. **Tests.** Element ids and e2e tests may change. The rewritten e2e tests keep the same behaviours: startup, open and remember, generate and play, chapter navigation, continuous playback, jump, diagnostics.
11. **Approval.** A throwaway static prototype, shown as Playwright screenshots. Sizes: phone 390x844 and desktop. Schemes: light and dark. States: welcome, book open, generating, playing, paused, resume available, and the three sheets (Book, Voice and speed, Diagnostics). The user approves from screenshots only. Then the real build follows in small verified steps.
12. **Engine flag (answered).** Yes. The engine exposes `wantPlaying` as one read-only field in `PlaybackView` (`src/engine/playback.ts`, `view()` and the `PlaybackView` type). It is the one allowed engine change. Step 3 adds it with a unit test. The primary-button derivation uses it to avoid the flicker at segment changes.
13. **Speed (answered).** All speed controls move into the Voice sheet, renamed "Voice and speed": Slower, speed label, Faster and Reset to 1x. The main screen shows no speed controls. The user chose this on 2026-10-26, after seeing the earlier answer "speed buttons always visible". This reverses that earlier answer.
14. **Chapter picker (answered).** The native `<select>` in the Book sheet is accepted.
15. **Chapter Previous and Next (answered).** They move from the main screen into the Book sheet. The user chose this on 2026-10-26, after seeing the prototype: "you would not change chapter that often". This reverses the earlier answer "chapter Previous and Next always visible". The buttons are text buttons ("Previous chapter", "Next chapter"), at least 44 px high, next to the native chapter select. The ids `#chapter-prev` and `#chapter-next` stay. The lock screen previous and next track actions still map to chapters through the media session. The header keeps the chapter name.
16. **Icon and one button during generation (answered).** The user chose this on 2026-10-26, after seeing the prototype. This reverses the earlier "Stop shows while generating" (a separate Stop button) and the `starting` state (a disabled "Listen").
    - The primary button shows a small icon beside its text.
    - There is one button during generation. Before the first audio plays (generation runs, nothing loaded) it reads "Stop" and cancels generation. Once audio plays it reads "Pause" as usual.
    - There is no separate Stop button and no disabled "Starting" state.
    - Reason from the user: generation takes about 10 s for a minute of audio, so a Stop during playback is not needed.
    - Icon set: inline SVG, no font and no download, `fill` or `stroke` set to `currentColor`. Play triangle for Listen and Play. Two bars for Pause. Filled square for Stop. Circular arrow for Resume.
    - Accessible name: the button text stays the accessible name. Each SVG has `aria-hidden="true"` and `focusable="false"`.
    - Style: amber stays for Listen, Resume, Play and Pause. Stop uses the same size with a transparent background and a 2 px outline in the text colour. It looks calm and not like an error.

## 1. Sheet mechanism

| | (a) Native `<dialog>` + `showModal()` (**recommended**) | (b) `<details>` | (c) Custom div + own focus trap |
|---|---|---|---|
| Modal, inert background | Built in. The top layer makes the rest of the page inert. | No. The page behind stays live. | Own code: `inert` on the main element, own trap. |
| Escape | Built in (`cancel` event). | No. | Own code. |
| `::backdrop` | Built in. | No. | Own overlay div. |
| Focus into the sheet | Built in (first focusable, or `autofocus`). | No. | Own code. |
| Focus return | Browsers return focus on close. Safari behaviour varies, so return it in code. | n/a | Own code. |
| iOS Safari | `<dialog>` since 15.4. | Everywhere. | Everywhere. |
| Slide-up animation | CSS on `dialog[open]`. The closing animation needs a class and `transitionend`, or no close animation. | Awkward. | Free. |
| Code size | About 20 lines. | Small, but not a sheet. | About 80 lines plus edge cases. |

Recommendation: (a). It gives modality, Escape and focus for free. iOS 15.0-15.3 lacks `<dialog>`. Accept that floor: those versions are too old for the speech worker targets anyway. I did not verify the app's real iOS floor. Check it in the phone pass.

Rules for the sheets:

- **Sheet open state is not `UiState`.** The `<dialog>` element owns `open`, like the browser owns `audio.paused`. `render()` never opens or closes a sheet. Opening is an action, like scroll (store-render plan, section 4).
- **Render does not depend on visibility.** The sheet content stays in the DOM when closed. Hooks keep drawing into it: `drawTexts` writes `#book`, `drawChapters` writes the chapter select, `drawControls` writes the voice status. So a sheet shows current values the moment it opens. No draw on open is needed.
- **Open:** a button on the main screen calls `dialog.showModal()` and stores the opener.
- **Close:** a Close button (`<form method="dialog">`), Escape (native), and a tap on the backdrop (click on the dialog element itself, outside the content box). On `close`, focus the stored opener.
- **Aria:** each `<dialog>` gets `aria-labelledby` pointing at its heading. The opener buttons get `aria-haspopup="dialog"`. Status text inside keeps `role="status"` (`#voice-status`, `#copy-status`).
- **Auto close.** Picking a book file closes the Book sheet. Picking a chapter while idle keeps the sheet open (the user may change their mind). Forget closes the sheet, because the main screen changes to the welcome state.
- **Background scroll.** Set `overscroll-behavior: contain` on the sheet body. iOS can still scroll the page behind a modal. The main screen does not scroll as a page (section 3), so this risk is small.

## 2. Primary button state machine

### Inputs (all in the snapshot today, except where marked)

| Input | Source |
|---|---|
| `book` | `bookStore.opened` (`src/ui/shell.ts:230`) |
| `generating`, `navigating` | `playback.view()` (`src/engine/playback.ts:1084-1093`) |
| `paused` | `audio.paused` (`src/ui/shell.ts:233`). Rows 3 and 4 use `wantPlaying` instead (G1). |
| `saved` | `loadPosition()` (`src/ui/shell.ts:232`) |
| `locked` | `generating || voices.busy || library.busy` (`src/ui/view.ts:59`) |
| `loaded` (**new snapshot field**, no engine change) | `playback.hasLoaded()` (`src/engine/playback.ts:107`, `:1077`). The shell already calls it (`src/ui/shell.ts:295`). Add it to `Snapshot` in `snapshot()`. |

### States

`deriveView` returns `primary: { state, label, icon, disabled }` and `secondaryHidden`. (Updated 2026-10-26: `stopHidden` is removed, because there is no separate Stop button.) Evaluate the rows top to bottom. The first match wins.

Updated 2026-10-26. The rows are: open, listen, resume, stop, pause, play. The old `starting` row (disabled "Listen") is removed. The `stop` row replaces it, in the same position.

| # | State | Condition | Label and icon | Click calls |
|---|---|---|---|---|
| 1 | `open` | `!book` | "Open an EPUB" (welcome), no icon | Opens the file picker (`<label for="file">`, section 4). Disabled when `library.busy`. |
| 2 | `stop` | `generating && !loaded` | "Stop", square icon | `playback.cancelGeneration()` (`playback.ts:903`). Never disabled. |
| 3 | `pause` | `loaded && wantPlaying` | "Pause", two bars | `playback.pauseFromMediaSession()` (`playback.ts:379`) |
| 4 | `play` | `loaded && !wantPlaying` | "Play", triangle | `playback.playFromMediaSession()` (`playback.ts:310`) |
| 5 | `resume` | `saved && saved.bookId === book.id` | "Resume", circular arrow, + sub-line (section 2, "Resume text") | The existing resume handler (`src/ui/shell.ts:431-437`). Disabled when `locked` (today's `resumeDisabled`, `view.ts:63`). |
| 6 | `listen` | otherwise | "Listen", triangle | `playback.generateChapter(ui.selectedChapter)` (today's generate handler, `shell.ts:424-427`). Disabled when `generateDisabled` (`view.ts:61`). |

Order note: `stop` comes before `pause` and `play`. While the first segment generates, `loaded` is false, so no playing row can match. The earlier text put `pause` and `play` first (rows 2 and 3) and `starting` at row 4. `stop` can sit above them only because `generating && !loaded` excludes them.

Engine check (reading only, `src/engine/playback.ts`). `view()` exposes `generating` (`:1087`). The snapshot gets `loaded` from `hasLoaded()` (`:1077`, `loaded !== undefined`). The engine also has an internal flag `awaitingFirstSegment` (`:133`, set at `:831`, cleared at `:742` and `:883`). The flag reaches `navigationBase` (`:1029`) but not `PlaybackView`. So the shell does not need a new engine field. `generating && !loaded` decides `stop`. This is the same condition the earlier design used for `starting`.
Edge case, not verified in the browser: if a chapter is already loaded and a new generation starts (for example a chapter picked while generating), `loaded` is true and the button shows Pause or Play. Step 3 must observe this and not assume it.

Secondary "Listen from chapter start": shown only in state `resume`. It calls the generate handler. Disabled when `generateDisabled`.

There is no separate Stop button (reversed 2026-10-26). The old `stopHidden` field and `cancelDisabled` inverted (`view.ts:62`) go. Cancel is reachable only through the `stop` state of `#primary`. After the first audio plays, generation continues in the background and the user cannot cancel it. The user accepted this, because generation is fast (item 16).

Stop, Play and Pause are not disabled by `locked`. The native controls are never disabled today, so the own buttons must not be either.

### Transitions (what the user sees)

1. Welcome (`open`) → pick file → `listen`, or `resume` when the book has a saved position.
2. `listen` or `resume` → click → `stop` (the same button reads "Stop") → first segment plays → `pause`. (Was `starting` with a separate Stop button, reversed 2026-10-26.)
3. `pause` ↔ `play` on click, on lock screen actions, and on headphone controls. The `play` and `pause` audio events already call `notifyChange` (`shell.ts:405-406`).
4. Click on `stop` (Cancel) → `generating` becomes false. Nothing was loaded, so the state returns to `listen` or `resume`. (Updated 2026-10-26: Stop now shows only when nothing is loaded.) Earlier text: if a chapter stays loaded, the state stays `pause` or `play`. If not, it returns to `listen` or `resume`. I did not verify whether Cancel unloads the chapter. The prototype and step 3 must observe it, not assume it.
5. Forget → `open`.

### Resume text and the saved-text trigger

The store-render plan (step 6 decision) draws the age text ("12 min ago") only from `refreshSavedUi`, never on every render.
Keep that rule. The primary label is the fixed word "Resume". The sub-line under it is today's `#saved` element, drawn by `renderSaved()` (`shell.ts:112-114`). Change `savedText` (`view.ts:51-55`) to the new wording: "Chapter N, 12 min ago". Do not put the age into the primary label.

### Engine API gaps (for the user, not invented here)

- **G1, segment gaps flip the button.** At each segment end the audio element pauses (`ended`), and the next `src` loads. `paused` is true for that moment. The button flips to "Play" and back. With 60 s segments this is once a minute. During buffering at a chapter edge it can last seconds. The engine knows the intent (`wantPlaying`, `playback.ts:311`, `:335`, `:341`, `:380`) but `PlaybackView` does not expose it (`playback.ts:88-94`).
  Decision: the user accepted this. Add one read-only field `wantPlaying` to `PlaybackView`, and use `wantPlaying` instead of `!paused` in rows 3 and 4 (numbering updated 2026-10-26). This is the one allowed engine change. It is one line in `view()` plus the type. Step 3 does it, with a unit test. Note: `playFromMediaSession` sets `wantPlaying` while buffering without a notify (`playback.ts:311-316`). The button then updates at the next event.
- **G2, end of book.** After "end of book" the chapter may stay loaded and paused, so the state is `play`. I did not verify what `playFromMediaSession` does then (replay of the last segment, or nothing). Observe it in step 3. Do not change the engine for it.
- **G3, Play while nothing is loaded.** Row 2 (`stop`) prevents it. `audio.play()` without `src` rejects. That is logged, not a `console.error`, but avoid it.

### What e2e can observe

- `#primary` gets `data-state` = one of the six states: `open`, `listen`, `resume`, `stop`, `pause`, `play`. Tests assert `data-state`, not the label text. Labels and icons may change after the screenshot review.
- `#primary` `toBeDisabled()` for `locked` (`listen`, `resume`). `stop` is never disabled. (Updated 2026-10-26: `starting` is removed.)
- Stop: click `#primary` while `data-state` is `stop`. Then generation ends and `data-state` returns to `listen` or `resume`. There is no `#stop` element (reversed 2026-10-26).
- Pause and Play: click `#primary` in `pause`, then `audioPaused(page)` is true and `data-state` is `play`. This replaces the old direct `element.pause()` in the open-and-remember test (`tests/e2e/app.spec.ts:52-54`).

## 3. Layout and CSS

### Layout (mobile first)

- `body` is a column flex box with `height: 100dvh` (fallback `100vh` first). The page itself does not scroll.
- Rows, top to bottom:
  1. Header: book title (one line, ellipsis), chapter name, and two icon buttons (Book, Voice and speed). Diagnostics opens from the Book sheet footer and from the version line.
  2. `#text`: `flex: 1; min-height: 0; overflow-y: auto`. This replaces `max-height: 30vh` (`index.html:23`).
  3. Status line `#stats`: one line, small, muted.
  4. Control bar: the primary button only, with a 20 px icon before the label. It fills the bar width and is the largest control. The button itself reads "Stop" while generation runs before the first audio (reversed 2026-10-26: no separate Stop button). No chapter buttons and no speed controls (both live in sheets).
- Safe areas: `padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)` with a minimum, through `max()`. `viewport-fit=cover` is already set (`index.html:5`). The control bar gets the bottom inset, so it sits above the home indicator.
- Touch targets: every button at least 44x44 px (today `index.html:21`, `:31-32`). The primary button is at least 56 px high.
- Desktop (`min-width: 700px`): the same column, `max-width: 42rem`, centred. The sheets become centred dialogs of the same width, not full-width bottom sheets. No second column.
- Reading text: serif stack, `line-height: 1.6`, `font-size: 1.125rem` in `rem`, so it follows the system text size. On iOS this needs `font: -apple-system-body` on `:root` to follow Dynamic Type. Check it in the phone pass.

**Form controls.** Selects use `appearance: none` with a custom chevron and `padding-right` of at least 2.5rem. The arrow never touches the border. The native picker (the iOS wheel) still opens on tap.

### CSS organisation

| | Keep inline `<style>` in `index.html` | `src/styles.css`, linked from `index.html` (**recommended**) | `import "./styles.css"` in `main.ts` |
|---|---|---|---|
| Size | About 150 lines in HTML. Hard to review. | Separate file, clear diffs. | Same. |
| Build | No change. | Vite emits one CSS asset with a `<link>` in `<head>`. No flash of unstyled content. | Same output. CSS is tied to a TS module. |
| Boundary check | No effect. | No effect. The check covers `src/engine` imports only (store-render plan, step 1 result). | `main.ts` gets a non-TS import. Harmless, but one more thing to check. |
| Prototype reuse | Copy and paste. | The prototype links the same file. | No. |

Recommendation: `<link rel="stylesheet" href="/src/styles.css">` in `index.html`. Expected `dist` change: one more asset (CSS). Earlier steps checked "the same four assets". Update that check to five, once, in step 1.

### Design tokens

Define on `:root`. Override in `@media (prefers-color-scheme: dark)`. Set `color-scheme: light dark`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#faf7f2` | `#16140f` | Page |
| `--surface` | `#ffffff` | `#211e18` | Sheets, control bar |
| `--text` | `#2a2520` | `#ece6dc` | Reading text |
| `--muted` | `#6e665c` | `#a39a8c` | Status, labels |
| `--accent` | `#9a5a00` | `#f0a63a` | Primary button, focus ring |
| `--on-accent` | `#ffffff` | `#1a1408` | Primary button text |
| `--highlight` | `#fde7bf` | `#4a3612` | Current sentence |
| `--border` | `#e4ddd2` | `#3a342b` | Dividers |
| `--font-read` | `"Iowan Old Style", "Palatino Linotype", Georgia, serif` | same | `#text` |
| `--font-ui` | `system-ui, -apple-system, sans-serif` | same | Controls |
| `--radius` | `12px` | same | Buttons, sheets |

The values are a start for the prototype. The screenshot review sets the final values. Check text contrast at WCAG AA (4.5:1) for `--text`, `--muted` and `--on-accent` in both schemes.

`theme-color`: replace the single meta (`index.html:6`) with two: `<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)">` and the dark one with `#16140f`. The manifest keeps one `theme_color`. That is a known limit of the manifest.

## 4. Element map

| Current element (`index.html`) | New place | New id |
|---|---|---|
| `h1` "epub-tts" (:42) | Welcome state only | none |
| `#saved` (:45) | Main, sub-line under the primary button in state `resume`. Hidden in other states. | `#saved` (kept) |
| `#file` (:47) | Visually hidden input. Opened by `<label for="file">` styled as a button: welcome "Open an EPUB" and the Book sheet "Open another book". | `#file` (kept) |
| `#book` (:48) | Book sheet, info line | `#book` (kept) |
| new | Main header, book title | `#title` (derived from `snapshot.book.title`) |
| new | Main header, chapter name | `#chapter-name` (label of `ui.selectedChapter` in `ui.chapters`) |
| `#forget-book` (:49) | Book sheet | kept |
| `#chapter` select (:53) | Book sheet, as the chapter list. Keep the native `<select>`. | kept |
| `#chapter-prev`, `#chapter-next` (:52, :54) | Book sheet (`#sheet-book`), as text buttons "Previous chapter" and "Next chapter" next to `#chapter`. Moved from the main screen (item 15). | kept |
| `#voice` (:57) | Voice and speed sheet | kept |
| `#voice-status`, `#voice-download`, `#voice-remove` (:59-61) | Voice and speed sheet | kept |
| `#generate` (:64) | Replaced by `#primary` (states `listen`) and `#listen-start` (secondary in `resume`) | `#primary`, `#listen-start` |
| `#cancel` (:65) | Merged into `#primary` (state `stop`). Updated 2026-10-26: the earlier `#stop` button is removed. | removed |
| `#resume` (:66) | Merged into `#primary` (state `resume`) | removed |
| `#stats` (:68) | Main, above the control bar | kept |
| `#audio` (:72) | Stays in the DOM, no `controls`, `hidden` | kept |
| `#speed-down`, `#speed-label`, `#speed-up` (:75-77) | Voice and speed sheet. Not on the main screen. | kept |
| `#speed-reset` (:78) | Voice and speed sheet, a "Reset to 1x" button | kept |
| `#text` (:80) | Main, fills the free height | kept |
| `#diagnostics` `<details>` (:84) | Diagnostics `<dialog>` | `#diagnostics` (now the dialog) |
| `#copy-log`, `#copy-status`, `#log` (:87-90) | Diagnostics sheet | kept |
| `#app-version` (:94) | Diagnostics sheet. Also a small muted line on the welcome state. | kept |
| new | Sheet dialogs and openers | `#sheet-book`, `#sheet-voice` (title "Voice and speed"), `#diagnostics`. Openers: `#open-book`, `#open-voice`, `#open-diagnostics`. |

Why keep the native chapter `<select>`: `drawChapters` (`shell.ts:102-109`), the `ui.chapterValue` rules (store-render plan, step 4 attempt 2) and the `change` listener (`shell.ts:412-420`) stay unchanged. A custom list would redo that work for a visual gain only. On iOS the native select opens the system wheel, which is fine. Revisit only if the screenshot review rejects it. The user accepted the native picker.

### Changes to `render()` sections

- `drawTexts` (`shell.ts:95-99`): unchanged.
- `drawChapters` (`shell.ts:102-109`): adds `#chapter-name`. It reads the same `ui` fields, so it is drawn in the same hooks.
- `drawControls` (`shell.ts:123-136`): `generateButton`, `cancelButton`, `resumeButton` lines go. New: `#primary` (`data-state` with the values `listen`, `resume`, `stop`, `pause`, `play`, plus label, icon and `disabled`), `#listen-start` (`hidden`, `disabled`), `#title`, and the welcome versus reader class on `body` (`data-book="none"`). `#saved` `hidden` (shown only in `resume`).
- `drawSettings`: unchanged.
- `renderSaved` (`shell.ts:112-114`): unchanged trigger, new wording.
- `ControlsView`: remove `generateDisabled`, `cancelDisabled`, `resumeDisabled` only after the click handlers use `primary`. Keep them while steps 3 and 5 are in progress.

### Text and highlight

- `renderText` (`shell.ts:275-289`): unchanged markup (`p` and `span[data-index]`).
- Current sentence: `.current` uses `--highlight` background, `border-radius: 3px`, and `box-decoration-break: clone`, so a wrapped sentence looks whole.
- Scroll: `scrollIntoView({ block: "nearest" })` (`shell.ts:165`) now scrolls the tall `#text`. Change it to `block: "center"` so the sentence stays in the reading zone and not at the bottom edge. Use `behavior: "smooth"` only when `prefers-reduced-motion` is not `reduce`. This is a visible change. The screenshot review does not show it, so note it in the PR.
- Tap to jump: unchanged (`shell.ts:291-300`). Spans keep `cursor: pointer`.

## 5. Migration steps

Each step is one commit. Each step passes `npm run typecheck`, `npm run build`, `npm test`, `npm run build:e2e`, `npm run test:e2e` (Chromium and Firefox, twice), and an independent review.

| # | Change | Main risk | Guard |
|---|---|---|---|
| 0 | Prototype: static HTML files in `prototype/` (not in the Vite build), with fake text and fixed states. The main screen has no speed controls. The Voice and speed sheet holds them. A screenshot script writes 2 sizes x 2 schemes x 9 views. The user approves. | The prototype promises something the engine cannot do (for example G1). | Each prototype state maps to one row in section 2. No state without a row. |
| 1 | Tokens and `src/styles.css`, light and dark, two `theme-color` metas, with the current markup. No id change. | A broken style hides a control (`hidden` attribute overridden by `display`). | e2e unchanged. Add `[hidden] { display: none !important; }`. `dist` asset count becomes five. |
| 2 | Main screen layout and the welcome state. Move elements per section 4, except the three sheets (they stay as plain sections at the end of the page for now). `#title`, `#chapter-name`. `#chapter-prev` and `#chapter-next` move to the Book section. | Tests that click elements now off screen or covered. | e2e edits limited to locators that moved. Each edit is listed in the PR. |
| 3 | Primary state machine in `deriveView`, `loaded` in the snapshot, `#primary` (with icons), `#listen-start`. No `#stop`. Old `#generate`, `#cancel`, `#resume` are removed. Also adds `wantPlaying` to `PlaybackView` (the one allowed engine change) with a unit test, and rows 2 and 3 use it. | A wrong row order (for example `resume` shown while playing). | Unit table: one case per row and per transition. e2e: `generateChapter` helper uses `#primary`. |
| 4 | Sheets: Book, Voice and speed, Diagnostics as `<dialog>`. The speed controls move into the Voice and speed sheet and leave the main screen (ids kept). Openers, Close, Escape, backdrop tap, focus return. | A closed dialog hides elements that tests click (`#chapter`, `#chapter-prev`, `#chapter-next`, `#forget-book`, `#copy-log`, `#speed-down`, `#speed-up`, `#speed-reset`). | e2e helpers `openSheet(page, "book")` and `closeSheet`. Assertions on `#log` text work on a closed dialog, because the text stays in the DOM. |
| 5 | Remove `controls` from `#audio`, hide it. Wire Play and Pause through `#primary`. | Lock screen and headphone controls stop working. Audio does not play without controls on some browser. | e2e pause and play via `#primary`. Phone pass item (section 7). |
| 6 | Polish: safe areas, focus rings, `prefers-reduced-motion`, scroll `block: "center"`, contrast check. Delete `prototype/`. | Layout breaks in standalone PWA mode. | Screenshot script against the real build at the same sizes. Compare with the approved prototype by eye. |

**Rollback rule.** If a step fails the e2e suite or the review twice, revert the step commit. Do not patch forward a third time. Redo the step smaller. A single flaky e2e test may be re-run once. A second failure counts.

## 6. Testing

- **Unit (vitest, Node, no DOM):** `tests/unit/view.test.ts` gets a table for `primary`:
  - each of the six rows with the minimal snapshot that matches it;
  - row order: `loaded` and a matching `saved` gives `pause` or `play`, not `resume`;
  - `generating && !loaded` gives `stop`, even with a matching `saved`;
  - `resume` only when `saved.bookId === book.id`. Another book gives `listen`;
  - disabled: `listen` and `resume` disabled when `locked`; `stop`, `play` and `pause` never disabled;
  - `secondaryHidden` is false only in `resume`;
  - new `savedText` wording with a fixed `now`;
  - `wantPlaying` with `paused` true gives `pause`. Add a unit test for the `wantPlaying` field in `view()` too.
- **e2e:** rewrite `tests/e2e/app.spec.ts` and `fixtures.ts` per step. The seven behaviours stay one test each. New assertions:
  - startup: the welcome state (`#primary[data-state=open]`) and the version text inside the Diagnostics sheet;
  - open and remember: `data-state` is `resume` after reload. Pause through `#primary` before Forget;
  - generate and play: `data-state` goes `stop`, then `pause`. A second test clicks `#primary` in `stop` and expects `listen` or `resume`. One Pause and one Play click change `audio.paused`;
  - diagnostics: open the sheet, copy, Escape closes it, and focus returns to the opener.
  The quiet-page rule (`fixtures.ts:6-16`) stays: no `console.error` and no page error.
  - Chapter navigation: the e2e tests that click `#chapter-prev`, `#chapter-next` or use `#chapter` must open the Book sheet first (`openSheet(page, "book")`). The ids stay. The lock screen previous and next track actions are not affected. They still map to chapters through the media session.
  - Speed: the e2e tests that press speed buttons must open the Voice and speed sheet first (`openSheet(page, "voice")`). The ids `#speed-down`, `#speed-up`, `#speed-label` and `#speed-reset` stay, so only the sheet opening is new.
- **Screenshot script (not a CI test):** `scripts/screenshots.mjs` uses Playwright. Viewports 390x844 and 1280x800. `colorScheme` light and dark (`page.emulateMedia`). It writes PNG files to an ignored folder. In step 0 it opens the prototype states. From step 6 it drives the e2e build with the mock worker to reach the same states.

## 7. iOS risks for the phone test pass

1. **Gesture and audio.** `#primary` in `listen` starts generation. In `stop` it cancels. The icons are inline SVG with `aria-hidden`, so they add no download. Check that they render at the same size on iOS. The first `audio.play()` runs later, after the worker produces a segment, outside the tap. This is the same path as today's Generate button, so it is no new risk. Play in state `play` calls `audio.play()` inside the tap, which is safer than today. Check both on the phone.
2. **No native controls.** Confirm that the lock screen and Control Center still show the media session after `controls` is removed (step 5).
3. **`100dvh`.** Safari changes the toolbar height while scrolling. Because the page does not scroll, `dvh` should stay stable. Check in Safari and in the standalone PWA.
4. **`<dialog>`.** Needs iOS 15.4 or later. Check Escape-free close (the backdrop tap and Close), focus return, and that the background does not scroll.
5. **Standalone safe areas.** In the installed PWA there is no Safari toolbar. The top inset covers the status bar and the bottom inset covers the home indicator. Check both orientations.
6. **Dynamic Type.** Check that the reading text follows the system text size, and that the control bar still fits at the largest size. The bar now holds one button, so the risk is lower. Check that the two chapter buttons in the Book sheet still fit, or wrap.
7. **Hidden file input.** Check that the `<label for="file">` opens the iOS file picker from the welcome button and from the Book sheet.

## 8. Out of scope

- No progress bar, no seek bar, no sleep timer.
- No new settings. No text size control. No manual theme toggle.
- No framework. The tripwire is unchanged.
- No engine changes, except `wantPlaying`. It is one read-only field in `PlaybackView`.
- No change to `renderText` markup, the hooks (`src/engine/hooks.ts`) or the draw triggers from the store-render plan.
- No structured status messages. `status` and `bookInfo` stay strings.

## Where this plan can hurt

- Step 4 hides most controls in closed dialogs. Many e2e helpers must open a sheet first. This is the step most likely to need the rollback rule.
- Removing `#generate`, `#cancel` and `#resume` in step 3 touches every e2e test through `generateChapter` (`fixtures.ts:41-46`). Change the helper once, not each test.
- Without `wantPlaying` (G1) the primary button would flicker at every segment swap. The step 3 unit test guards it. The screenshots do not show this, because they are static.

## Open questions for the user

None. The user answered all of them (see "Answered", items 12 to 15).

## Step 1 result

Files: `src/styles.css` (new), `index.html` (inline `<style>` removed, stylesheet link added, theme-color metas). No TypeScript, markup, id or e2e change.

CSS approach: `<link rel="stylesheet" href="/src/styles.css" />` in the root `index.html`, the same form as the `/src/main.ts` script. Vite processes it and rewrites it with the production base. `dist/index.html` has `href="/epub-tts/assets/index-CjTZqEP4.css"`. No `import` in `main.ts` is needed, so no TypeScript file changes.

Tokens (`:root`, light values; dark values in `@media (prefers-color-scheme: dark)`, no `data-theme`): `--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--on-accent`, `--highlight`, `--border`, `--danger`, `--ok`, `--focus-ring`, `--radius`, `--radius-sm`, `--space-1..4`, `--font-read`, `--font-ui`. `color-scheme: light dark`. Light bg `#faf7f2`, dark bg `#16140f`, copied from the prototype. `--ok` and `--focus-ring` are new (copy-status green, focus outline). `--danger` is defined but unused until later steps.

Theme-color metas: `#faf7f2` (light) and `#16140f` (dark), each with a `media` query.

Dist assets (build): `index-DDzvAxMV.js` 414.19 kB, `index-CjTZqEP4.css` 3.35 kB (gzip 1.37 kB, new), `ort.wasm.min` 141.89 kB, `piper` 88.80 kB, `worker` 16.11 kB. `dist/index.html` 3.12 kB. No mock strings in `dist`.

Old-page styling kept: `#generate` is the amber primary button, `#text` uses the serif stack, `#text span.current` uses `--highlight`. Not checked visually (no browser screenshot run): both schemes, the select chevron and contrast. Check these on the phone or with the prototype shots.

e2e impact: none. 14/14 passed twice with no test edits.

### Attempt 2

Fix: the light `--accent` (and `--focus-ring`) changed from `#b86e00` to `#9a5a00`. White text on `#b86e00` was about 3.99:1, below AA. Dark values are unchanged. The prototype light token changed the same way, and the token table in section 3 shows the new value.

Ratios, from sRGB relative luminance (`#9a5a00` has L = 0.2126 x 0.3231 + 0.7152 x 0.1022 = 0.1418):
- White `--on-accent` on `--accent` (primary button): 1.05 / 0.1918 = 5.47:1.
- `--accent` text or focus ring on `--bg` `#faf7f2` (L 0.932): 0.982 / 0.1918 = 5.12:1.
- `--accent` on `--surface` `#ffffff`: 5.47:1.
- Dark `--accent` `#f0a63a` on dark `--bg`: unchanged, 8.91:1 for the button text.

All uses of `--accent` in light mode (button fill, link text, focus ring) are at least 4.5:1. The focus ring needs only 3:1. The current-sentence highlight uses `--highlight`, not `--accent`.

## Step 2 result

Files: `index.html`, `src/styles.css`, `src/ui/view.ts`, `src/ui/shell.ts`, `tests/unit/view.test.ts`, `tests/e2e/app.spec.ts`, this plan. `src/engine` is untouched.

Layout: `body` no longer carries the card padding. `main.screen` is a 100dvh column (safe-area top, `100vh` fallback). Inside it, `.welcome` and `.reader` swap on `body[data-book]`. The reader holds `header` (`#title`, `#chapter-name`), `#text` (flex 1, scrolls inside), `#stats`, and the `.controls` bar. The bar holds `#saved`, the current `#generate`, `#cancel` and `#resume` buttons, and the native `#audio controls`. The bar has the bottom safe-area inset. The welcome shows the `<label for="file">` "Open an EPUB" styled as a large amber button (tokens reused, white on `#9a5a00` = 5.47:1).

Below the screen, plain sections (not dialogs): `#sheet-book` (file label "Open another book", `#book`, `#forget-book`, `#chapter-prev`, `#chapter`, `#chapter-next`), `#sheet-voice` (voice, status, download, remove, all speed controls, ids kept) and Diagnostics. `#file` is now visually hidden (`.visually-hidden`).

View: `deriveView` returns `titleText` (book title or "") and `welcomeVisible` (`!book`). New pure export `chapterNameText(chapters, index)`. It finds the label by `index`, not by position. `Snapshot` is unchanged, because the chapters live in `UiState`. Shell: `drawControls` writes `#title` and `body[data-book]`. `drawChapters` writes `#chapter-name`. Unit tests added for the title, the welcome flag and `chapterNameText`.

e2e edits (no locator needed to move, because every moved element stays in the DOM and visible below the screen):
- startup test: added the welcome assertions (`#welcome` visible, label text "Open an EPUB", `#text` hidden).
- open-and-remember test: added `#welcome` hidden, `#title` = book title, `#chapter-name` not empty after opening.
No other e2e line changed. Same 7 behaviours, 14 tests.

Results: `npm run typecheck` OK (0 cycles). `npm run build` OK, no mock strings in `dist` (CSS 4.94 kB). `npm test` 219 passed. `npm run build:e2e` OK. `npm run test:e2e` 14 passed, twice.

Not checked visually: no screenshot was taken. The phone layout, the dark scheme, the safe-area insets, how the welcome and the sections below the 100dvh screen look, and the long-title ellipsis are unverified. The sections below the screen scroll the page for now. That is temporary until step 4.

### Attempt 2

Fix: the chapter `change` handler in `src/ui/shell.ts` now calls `drawChapters()` after it updates `ui.selectedChapter`. The idle branch only called `notifyChange()`, and `render()` does not draw `#chapter-name`. The draw sections are unchanged. Added an e2e assertion in the open-and-remember test: after opening a book, selecting chapter 2 while idle changes `#chapter-name` (it ends with "Chapter Two"). Labels carry a number prefix, for example "3. Chapter Two". typecheck (0 cycles), build, `npm test` (219), build:e2e and `npm run test:e2e` (14 passed, run twice after the fix) are green.
