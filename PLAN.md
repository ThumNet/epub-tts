---
outcome: "Outdated, original outcome. See Status below. A throwaway prototype that answers one question. Does a pre-generated chapter keep playing, and can it pause and resume, with the phone screen locked?"
scope: Vite and vanilla TypeScript. Piper TTS in a Web Worker. English only. One chapter at a time. No tests. No polish. Static hosting on GitHub Pages.
acceptance: The page builds and deploys. The phone tests below run on iPhone Safari, the installed iPhone app, and Android Chrome. Each result is written down.
source: "chat session 2026-10-25, deep-research runs run_6ec6ffa55e41 / run_e743bd8d338d / run_045ccc6c34bd"
---

# PLAN: EPUB reader with in-browser neural TTS

## Status (updated at merge to main)

This plan started as a phone-test prototype. The app has moved on. Some sections below keep the original text as history. Each outdated part is marked "Outdated".

Current behaviour, verified in `src/main.ts`:

- The app has no character limit.
- The app streams a chapter in segments of about 60 seconds (`SEGMENT_TARGET_S`). It does not generate the whole chapter first.
- The generator stays at most 2 segments ahead (`SEGMENTS_AHEAD`). The app keeps 3 played segments behind (`SEGMENTS_BEHIND`) and drops older audio to cap memory.
- The app regenerates a dropped segment on demand.
- The app sets `navigator.audioSession.type` to `playback` and runs a stuck-resume watchdog. The watchdog reloads the current segment, with at most 2 attempts for each resume.
- The watchdog starts on a Media Session play, on the first segment start, on a segment switch that plays, on a recovery follow-up, and when the page becomes visible during playback. A play from the native audio controls does not start it.
- The app logs diagnostics and saves and resumes the reading position.

Observation from the owner's phone tests (not verified in source):

- After a pause of about 3 to 6 seconds in the background, lock-screen resume stops until the app is in the foreground.
- Source: the owner's own log on one iPhone (iOS 18.7), in a Safari tab and in the home-screen app. We did not verify it on other devices or iOS versions.
- See "Known limitations / maintenance notes" in `docs/limitations.md`.
- Ideas not done for that limit: a silent keep-alive audio, and a native wrapper.

Open: the phone test results are not recorded here. The "Tests to run on phone" checklist still applies.

## Goal

Build a personal installable PWA. It runs on a static host with no backend. It reads EPUB files aloud with natural neural TTS that runs in the browser.

Target languages are English and Dutch. iPhone and Android are the primary devices.

Outdated: the first prototype answered one question. Did a pre-generated chapter keep playing, and could it pause and resume, with the screen locked? The app now streams segments. See "Status".

## Decisions so far

- The app is a personal tool.
- The user uploads the EPUB file.
- TTS runs in the browser, with a neural model.
- The app is an installable PWA.
- The host is static (GitHub Pages). There is no backend.
- The target is English and Dutch. Version 1 and the prototype are English only.
- The engine is Piper only.
  - The user tried Piper on iPhone Safari through quick-tts.com.
  - The English voice sounded natural enough.
  - Audio kept playing while the phone was locked.
  - Pause from the lock screen worked.
  - Resume after about 20 seconds failed.
  - Kokoro sounds better on desktop. It is not for phones.
- The app pre-generates audio per chapter. It does not buffer live. (Outdated: the app now generates ahead in 60 s segments. See "Status".)
- The app will detect the language from the EPUB metadata later.
- First-version features:
  - text highlighting
  - playback controls
  - resume position
  - chapter navigation
  - background audio
- Download size does not matter.
- "Dutch must sound equally natural" is not resolved. English comes first. Dutch comes later.

## Prototype scope (Outdated: original scope. See "Status" for the current behaviour.)

The prototype was throwaway code. It had no tests and no polish. The list below describes the first version. The app now joins clips into segments of about 60 seconds, not one chapter file.

What it does:

- Vite and vanilla TypeScript.
- Piper runs in one Web Worker (see "Chosen Piper path" below).
- It parses one chapter of a user-uploaded EPUB with epub.js.
- It splits the chapter into sentences with `Intl.Segmenter`.
- It generates one audio clip per sentence while the screen is on.
- It joins the clips into one chapter WAV file (a Blob). It keeps the start and end time of each sentence.
- It plays the file in an `<audio>` element. No TTS runs during playback.
- It sets Media Session metadata and the play, pause, seek, seek-backward and seek-forward actions.
- It highlights the current sentence from the timings. A tap on a sentence seeks to it.
- It saves the reading position to `localStorage` on `visibilitychange` (hidden), on `pagehide`, and every 5 seconds while playing.
- It shows an on-screen log with:
  - model load time
  - generation time, audio duration and real-time factor (RTF)
  - page visibility events (hidden, visible, pagehide, pageshow, freeze, resume)
  - audio element events and Media Session actions
  - a heartbeat every 10 seconds while playing
  - a warning at start-up if the last session ended during generation
- It requests a screen wake lock while it generates.
- The deploy runs on GitHub Pages. The workflow is `.github/workflows/pages.yml`.

### Chosen Piper path

The prototype uses the npm package `@mintplex-labs/piper-tts-web` 1.0.5. It is a fork of `@diffusionstudio/vits-web`.

Why this path:

- It is small. The published `dist` has about 160 KB of JavaScript plus typings.
- It has typed `TtsSession` and `predict()` APIs. They fit a per-sentence loop.
- It runs Piper models with `onnxruntime-web` and a phonemizer built from espeak-ng.
- It accepts local paths for the ONNX Runtime WASM files and the phonemizer files. The app serves these from its own origin.
- It lists the voices needed now (for example `en_US-lessac-medium`) and the Dutch voices for later.
- Its licence is MIT. Its npm page shows an update on 2026-08-17.
  Source: https://registry.npmjs.org/@mintplex-labs/piper-tts-web

What the app loads, and from where:

| File | Source | Pinned by |
| --- | --- | --- |
| ONNX Runtime WASM (`ort-wasm-simd*.wasm`) | App origin, copied from `onnxruntime-web` 1.18.0 at build | `package.json` |
| Phonemizer (`piper_phonemize.wasm` and `.data`, 18 MB) | App origin, copied from `@diffusionstudio/piper-wasm` 1.0.0 at build | `package.json` |
| Voice model (`en_US-lessac-medium.onnx`, about 63 MB) | `https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/lessac/medium/` | Hard-coded in the library |

The library caches the voice model in the origin private file system (OPFS) after the first download.

Paths I considered and did not choose:

- sherpa-onnx. The npm package `sherpa-onnx` 2.0.0 (Apache-2.0) targets Node.js (`sherpa-onnx-wasm-nodejs.wasm`). The browser TTS build exists as a separate WASM app in the sherpa-onnx repository. It needs a custom build with the model embedded. This is a heavier path. It stays the fallback if the chosen path fails on a phone.
  Sources: https://github.com/k2-fsa/sherpa-onnx and https://k2-fsa.github.io/sherpa/onnx/tts/piper.html
- `piper-tts-web` 1.1.2 (Poket-Jony). The npm metadata shows version 1.1.2, an MIT licence and the dependencies `@huggingface/transformers` and `onnxruntime-web`. Source: https://registry.npmjs.org/piper-tts-web. Its README lists WebWorker support. It tells Vite users to copy the `dist/onnx`, `dist/piper` and `dist/worker` folders into the public directory. Source: https://unpkg.com/piper-tts-web@1.1.2/README.md. I did not test it. I judge it needs more setup for the same result. This is my opinion, not a measured result.

Outdated: when I wrote this, I ran no browser and heard no audio. The app has since run on the owner's phone.

### Hosting

- GitHub Pages serves over HTTPS.
- Pages cannot set COOP and COEP headers.
- The app uses `coi-serviceworker` (copied from npm at build, same origin). It adds the headers from a service worker. Android Chrome can then use WASM threads where possible.
- iOS Safari threads are unreliable. The app does not register `coi-serviceworker` on iOS. The iOS path uses one thread.
- The Vite `base` is `/epub-tts/` by default. Set the `VITE_BASE` environment variable to change it.
- The web app manifest is minimal. The only service worker is `coi-serviceworker`. It also gives Android Chrome an installable app.
- On iOS, "Add to Home Screen" works from the manifest and meta tags. The icon is an SVG. iOS may show a plain tile instead. A PNG icon is not part of the prototype.

## Tests to run on phone

Outdated: the character limit no longer exists. The app reads the whole chapter. Use a long chapter (10 to 15 minutes of audio or more) for the tests. The old limit input (9,000 characters for about 10 minutes) is gone.

Run the list in this order:

1. iPhone Safari tab.
2. iPhone installed home-screen app.
3. Android Chrome (tab first, then installed).

Checklist for each run:

- [ ] 1. Lock while playing. Wait 5 minutes. Does the audio still play?
- [ ] 2. Pause from the lock screen. Resume after 20 s, 1 min, 5 min and 15 min. At which delay does resume fail?
- [ ] 3. Do the lock-screen controls show title, play/pause and seek? Do they work?
- [ ] 4. Force-close the app and reopen it. Does the page offer the saved position? Does "Resume saved position" work after you pick the same EPUB?
- [ ] 5. Speed. Read RTF in the log. RTF is generation time divided by audio length.
- [ ] 6. Memory. Was the tab killed while generating? At what chapter length? (The log warns at the next start-up.)
- [ ] 7. Repeat on the installed home-screen app on iPhone. Then repeat on Android Chrome.

After each run, press "Copy log" and save the log with the device, browser and result.

## What results decide

- Resume works from the file. The design holds.
- Resume fails after some delay. Offer "continue from saved position" when the app reopens. (Status: on the owner's iPhone, resume failed after about 3 to 6 s in the background. This comes from one device and is not verified elsewhere. The app offers the saved position.)
- Generation is too slow, or the tab is killed. Generate smaller units (a paragraph) or use a smaller Piper voice. (Status: the app now generates 60 s segments.)

## Not decided

- **Dutch voice quality.** It is untested. Piper has these Dutch voices: nl_NL (mls, pim, ronnie, alex) and nl_BE (nathalie, rdh). The package voice list shows only `nl_NL-mls*`, `nl_BE-nathalie*` and `nl_BE-rdh*`. I did not confirm pim, ronnie and alex in it. Kokoro has no Dutch.
  Sources: https://huggingface.co/rhasspy/piper-voices/tree/main/nl and https://rhasspy.github.io/piper-samples/
- **GPL licence handling.** The current Piper repository `OHF-Voice/piper1-gpl` is GPL-3.0 and embeds espeak-ng. The old `rhasspy/piper` is MIT and archived. sherpa-onnx is Apache-2.0. Personal use is probably fine. This is not a legal conclusion.
  Sources: https://github.com/OHF-Voice/piper1-gpl and https://github.com/rhasspy/piper
- **Kokoro on desktop.** Deferred.
- **Optional cloud TTS.** Mistral Voxtral TTS 3 is API only and needs an API key. I did not find a price per minute. A Dutch preset exists. Deferred.
  Source: https://docs.mistral.ai/studio/audio/text-to-speech/overview

## Risks

- **No audio check yet.** (Outdated: the app now works on the owner's phone. Per-device results are not recorded.) I could not hear audio or use a phone when I wrote this. Piper inference in the browser was untested then.
- **Single-source claims.** The numbers about iPhone Safari (about 800 ms inference, tab memory ceilings of about 256 MB on iOS and about 512 MB on Android, tab kills, unreliable threads) come from one developer's blog (quick-tts.com). Treat them as unconfirmed.
- **Memory.** (Partly outdated: the segment window now caps the audio kept in memory.) The voice model is about 63 MB. ONNX Runtime and the 15 MB-plus WASM add more. A segment WAV adds about 2.6 MB per minute (22,050 Hz, 16-bit). Test 6 measures tab kills.
- **OPFS on Safari.** The library caches the model with `createWritable`. Safari may not support this call. The library then ignores the error and downloads 63 MB again on every load. The prototype does not fix this.
- **Library hard-codes the model URL.** The model comes from Hugging Face. The app cannot host the model on its own origin without a patch to the library. If Hugging Face changes the path, the voice fails to load.
- **Thread count.** The library sets the thread count to `navigator.hardwareConcurrency`. ONNX Runtime falls back to one thread when the page is not cross-origin isolated. A first load on Android Chrome reloads once after `coi-serviceworker` installs.
- **Service worker side effect.** `coi-serviceworker` sets COEP on all responses. Cross-origin fetches without CORS headers fail. The Hugging Face model URL sends CORS headers, so it works.
- **epub.js typings.** `Section.load()` has a wrong type (it returns a Promise at run time). The code reads `section.document` after the await. epub.js 0.3.93 has had no release since 2023-09-26.
- **Licence.** See "Not decided".
- **Dutch.** Not tested.

## Findings from research

Single-source claims are marked.

- Piper voice samples, including Dutch: https://rhasspy.github.io/piper-samples/
- Dutch Piper voice files: https://huggingface.co/rhasspy/piper-voices/tree/main/nl
- sherpa-onnx (Apache-2.0, runs Piper models in WASM and native): https://github.com/k2-fsa/sherpa-onnx and https://k2-fsa.github.io/sherpa/onnx/tts/piper.html
- Piper repositories. The old `rhasspy/piper` is MIT and archived: https://github.com/rhasspy/piper. The current repository is GPL-3.0: https://github.com/OHF-Voice/piper1-gpl
- Native Piper benchmark: median RTF 0.247 on Android and 0.115 on iOS. This is native code, not browser WASM. Single source: https://eist.app/research/on-device-tts-benchmarks/piper
- Piper WASM on iPhone Safari: about 800 ms inference, tab memory ceilings of about 256 MB (iOS) and about 512 MB (Android), tab kills, unreliable threads on iOS Safari. Single source (one developer): https://quick-tts.com/blog/piper-wasm-on-ios.html
- Comparison of Web Speech API, Piper and Kokoro. Single source: https://quick-tts.com/blog/web-speech-api-vs-piper-vs-kokoro.html
- EPUB parsers: https://github.com/futurepress/epub.js (chosen) and https://github.com/johnfactotum/foliate-js
- Sentence splitting: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
- Lock-screen controls: https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API
- Page freeze and resume events: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- Cloud TTS option (deferred): https://docs.mistral.ai/studio/audio/text-to-speech/overview
