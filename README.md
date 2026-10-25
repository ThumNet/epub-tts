# epub-tts

A web app that reads an EPUB chapter aloud with Piper TTS in the browser. It runs on a phone and on a desktop. It has no backend.

## For testers

1. Open https://thumnet.github.io/epub-tts/ on your phone.
2. Optional on iPhone: add the app to the home screen. Open the page in Safari, tap Share, then tap "Add to Home Screen".
3. Pick an EPUB file. Pick a chapter. Press "Generate chapter audio". Playback starts after the first segment.
4. Pick a voice in the "Voice" list. The default is Kristin. The page shows whether the voice is downloaded. Use "Download" to fetch it ahead of time (about 61 MB) or "Remove" to free the space. If the library cannot remove the files (Safari lacks the call it uses), the app deletes them directly. The page shows an error if the voice stays stored. The first generation downloads the voice by itself if needed.
5. Use the "Speed" slider (0.75x to 2x) to change the playback speed. "Reset to 1x" returns to normal speed. The app remembers your voice and speed.
6. The app remembers the last EPUB you opened on this device. After a restart, the app reopens it and shows "restored from this device". Press "Forget this book" to delete it from the device. The saved position and settings stay. The browser may clear site storage. We did not verify this on iOS. Offline use comes in a later phase.

Known limit: on iOS, after a pause of about 3 to 6 seconds, resume from the lock screen stops working. It works again after you bring the app to the foreground. This comes from the owner's own phone log. We did not verify it on other devices.

To report a bug:

1. Open "Diagnostics" at the bottom of the page. Press "Copy log".
2. Open a new issue in this repository. Choose the "Bug report" template.
3. Paste the log into the template.

The app version shows in the footer. Licence: see `LICENSE`. Third-party licences and voice credits: see `THIRD_PARTY_NOTICES.md`.

## How it works

- You pick an EPUB file and a chapter. The app splits the chapter into sentences.
- The app has no character limit. It reads the whole chapter.
- The app generates the audio in segments of about 60 seconds (`SEGMENT_TARGET_S`). Playback starts when the first segment is ready.
- The generator stays at most 2 ready segments ahead of the playing one (`SEGMENTS_AHEAD`).
- To cap memory, the app keeps the audio of 3 played segments behind the playing one (`SEGMENTS_BEHIND`). It drops older audio.
- If you seek to a dropped segment, the app regenerates it on demand.
- Tap a sentence to play from there. If the sentence is not generated yet, the app restarts generation from that sentence. Playback then starts after a short wait.
- If playback reaches a segment that is not ready, the app shows "Buffering" and continues when the segment is ready.
- The app saves the reading position. After a restart, press "Resume saved position". Generation then restarts from the saved sentence.
- The app remembers one book. After you open an EPUB, the app stores a copy in the browser (IndexedDB database `epub-tts`, store `book`). Opening another EPUB replaces it. At startup the app reopens it and preselects the saved chapter. Nothing starts by itself. If you pick a file during the reopen, your file wins. If the stored book cannot be parsed, the app forgets it. "Forget this book" deletes the copy. The button is hidden when no book is stored. It is disabled while the app generates or plays. The app does not store generated audio. If the app cannot store the book, it shows a message and the book still works.
- The app sets Media Session metadata and the lock-screen actions play, pause, seek, seek backward, seek forward, previous track and next track.

### Chapter navigation and continuous playback

- Use the "Prev" and "Next" buttons beside the chapter list. They go to the nearest chapter with text and start it from the beginning. They skip chapters without text, such as a cover. They also cancel a running generation.
- "Prev" is disabled on the first chapter with text. "Next" is disabled on the last one.
- The lock-screen previous track and next track buttons do the same. Support depends on the device and the browser.
- When the last segment of a chapter ends, playback continues into the next chapter with text. The same audio element plays it, so there is no stop.
- After a chapter is fully generated, the app generates the first segments of the next chapter in the background. These segments share the 2-segment lookahead limit (`SEGMENTS_AHEAD`) with the playing chapter.
- If the next chapter is not ready when the current one ends, the app shows "Buffering" and continues when it is ready.
- Playback stops at the end of the book. Cancel, Prev, Next and a new Generate discard the prefetched chapter.
- The app saves the position of the new chapter when playback enters it. "Resume saved position" continues there.
- While a generation runs, picking another chapter in the list works like Prev and Next: the app cancels the generation and starts that chapter. The list always shows the playing chapter. Prev and Next move from the playing chapter.
- When you pick an EPUB that matches the saved position, the app preselects the saved chapter. It does not start by itself. Press "Resume saved position".
- The on-screen log records diagnostics. Open "Diagnostics" and press "Copy log" to copy it.

### Recovery from stuck resume on iOS

- The app sets `navigator.audioSession.type` to `playback` when the browser supports it.
- A watchdog checks whether the playback time advances 1.5 s after it starts. If it does not, the app reloads the current segment and plays again.
- The watchdog starts in these cases (verified in `src/main.ts`):
  - A Media Session play action (the page handler for lock-screen play).
  - The start of the first segment.
  - A switch to another segment, when that switch plays audio.
  - A recovery attempt (a follow-up check).
  - The page becomes visible while the audio is playing.
- A play from the native audio controls does not start the watchdog. The app only records that the user wants sound.
- The watchdog makes at most 2 recovery attempts for each resume.

See `PLAN.md` for goals, decisions and risks.

## Run locally

Requirements: Node.js 20.19 or newer, and npm.

1. Run `npm install`.
2. Run `npm run dev`.
3. Open the URL that Vite prints. The path starts with `/epub-tts/`, for example `http://localhost:5173/epub-tts/`.
4. Pick an EPUB file, pick a chapter, and press "Generate chapter audio". Playback starts after the first segment.

Other scripts:

- `npm run typecheck` checks the types.
- `npm run build` checks the types and builds into `dist/`.
- `npm run preview` serves `dist/` at `http://localhost:4173/epub-tts/`.

The first generation downloads the voice model (about 63 MB). The browser stores it in the origin private file system.

## Large files

The repository does not contain the large files. No download script is needed.

- The ONNX Runtime WASM files and the Piper phonemizer files (about 18 MB) come from npm. The build copies them from `node_modules` into `dist/ort/` and `dist/piper/`.
- The voice model comes from Hugging Face at run time. The library hard-codes the URL for the voice. For `en_US-lessac-medium` it is `https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx`. The default voice is now `en_US-kristin-medium`, because Lessac has a research-only licence.
- `node_modules/` and `dist/` are in `.gitignore`.

## Deploy to GitHub Pages

1. Create a GitHub repository named `epub-tts`. Push the project to the `main` branch.
2. In the repository settings, open "Pages". Set "Source" to "GitHub Actions".
3. The workflow `.github/workflows/pages.yml` builds and deploys on each push to `main`.
4. Open `https://<user>.github.io/epub-tts/`.

The workflow sets `VITE_BASE` to `/<repository name>/`. To build by hand for another path, run `VITE_BASE=/other/ npm run build`.

## Run the phone tests

Use any EPUB. The app reads the whole chapter, in segments of about one minute.

1. Open the deployed page on the phone. Use a Safari tab first.
2. Pick the EPUB file. Pick the chapter. Press "Generate chapter audio".
3. Keep the screen on while the first segment generates. Playback then starts on its own.
4. Follow the checklist below.
5. Open "Diagnostics" and press "Copy log" after each test. Save the log with the device, browser and result.

Checklist (the full version is in `PLAN.md`):

- [ ] Lock while playing. Wait 5 minutes. Does the audio still play?
- [ ] Pause from the lock screen. Resume after 20 s, 1 min, 5 min and 15 min. Note where resume fails.
- [ ] Check the lock-screen title, play/pause and seek controls.
- [ ] Force-close and reopen. Check that the page shows the saved position. Pick the same EPUB. Press "Resume saved position".
- [ ] Read the real-time factor (RTF) in the log. RTF is generation time divided by audio length.
- [ ] Play a long chapter. Check that old segments drop (`segment N dropped` in the log) and that seeking back regenerates them.
- [ ] Check for a tab kill during generation. The log shows a warning at the next start-up.
- [ ] Repeat as the installed home-screen app on iPhone. Then repeat on Android Chrome.

How to read the log:

- `visibilitychange: hidden` and `visible` show when the screen locks and unlocks.
- `heartbeat` lines appear every 10 seconds while the audio plays. A gap while the screen is locked is normal if the page is suspended. Compare the `t=` value after unlock with the elapsed time.
- `audio pause` without a button press means the system paused the audio.
- `media session action` lines show lock-screen presses that reached the page.

- `recovery` and `stuck watch` lines show the watchdog and the segment reload.
- `segment N ready`, `dropped`, `regenerating` and `swap` lines show the segment life cycle.

## Known limitations / maintenance notes

### iOS lock-screen resume

- After a pause of about 3 to 6 seconds in the background, resume from the lock screen stops working. It works again after you bring the app to the foreground.
- Source: the owner's own log on one iPhone (iOS 18.7), in a Safari tab and in the home-screen app. We did not verify it on other devices or iOS versions.
- What we tried:
  - Set `navigator.audioSession.type` to `playback`.
  - Add stuck-resume recovery: a watchdog plus a reload of the current segment.
- Ideas not done:
  - Play a silent keep-alive audio during the pause.
  - Wrap the app in a native app.
- We did not confirm that these ideas fix the limit.

### Phonemizer

The phonemizer is old. We leave it as it is for now.

- The build copies `piper_phonemize.wasm` (about 0.6 MB) and `piper_phonemize.data` (about 18 MB) from `@diffusionstudio/piper-wasm` 1.0.0. See `vite.config.ts` and `src/worker.ts`. `@mintplex-labs/piper-tts-web` 1.0.5 is hard-wired to that same build.
- That build dates from 2024-07-05. It uses emsdk 3.1.47 (current: 6.0.13). It uses `rhasspy/espeak-ng`, which is archived. The maintained source is `espeak-ng/espeak-ng` (1.52.0, released 2024-12-12). The upstream recipe does not pin the espeak-ng or piper-phonemize revisions. These facts come from a research pass on 2026-10-25. We did not re-check them against the sources in this repo.
- Reason to keep it: a rebuild probably shrinks the wasm by tens of KB only (unverified). It risks breaking the phonemizer interface, the stderr output and the phoneme output. The effort is 1 to 3 days (unverified estimate, not measured).
- Idea for later, not done: trim `espeak-ng-data` to the languages the app needs. This could cut most of the 18 MB and speed up loading on the phone, because `piper-tts-web` re-creates the phonemizer for each chunk. The gain is unverified and not measured.
- Rebuild only if a phonemization bug appears.
- The phonemizer bundle is derived from espeak-ng, so it is GPL-licensed.

## Status

The app works on the owner's phone. The test results for each device and browser are not recorded in this repository. See "Risks" in `PLAN.md`.
