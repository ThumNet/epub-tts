# Known limitations and maintenance notes

## iOS lock-screen resume

- After a pause of about 3 to 6 seconds in the background, resume from the lock screen stops working. It works again after you bring the app to the foreground.
- Source: the owner's own log on one iPhone (iOS 18.7), in a Safari tab and in the home-screen app. We did not verify it on other devices or iOS versions.
- What we tried:
  - Set `navigator.audioSession.type` to `playback`.
  - Add stuck-resume recovery: a watchdog plus a reload of the current segment.
- Ideas not done:
  - Play a silent keep-alive audio during the pause.
  - Wrap the app in a native app.
- We did not confirm that these ideas fix the limit.

## Phonemizer

The phonemizer is old. We leave it as it is for now.

- The build copies `piper_phonemize.wasm` (about 0.6 MB) and `piper_phonemize.data` (about 18 MB) from `@diffusionstudio/piper-wasm` 1.0.0. See `vite.config.ts` and `src/worker.ts`. `@mintplex-labs/piper-tts-web` 1.0.5 is hard-wired to that same build.
- That build dates from 2024-07-05. It uses emsdk 3.1.47 (current: 6.0.13). It uses `rhasspy/espeak-ng`, which is archived. The maintained source is `espeak-ng/espeak-ng` (1.52.0, released 2024-12-12). The upstream recipe does not pin the espeak-ng or piper-phonemize revisions. These facts come from a research pass on 2026-10-25. We did not re-check them against the sources in this repo.
- Reason to keep it: a rebuild probably shrinks the wasm by tens of KB only (unverified). It risks breaking the phonemizer interface, the stderr output and the phoneme output. The effort is 1 to 3 days (unverified estimate, not measured).
- Idea for later, not done: trim `espeak-ng-data` to the languages the app needs. This could cut most of the 18 MB and speed up loading on the phone, because `piper-tts-web` re-creates the phonemizer for each chunk. The gain is unverified and not measured.
- Rebuild only if a phonemization bug appears.
- The phonemizer bundle is derived from espeak-ng, so it is GPL-licensed.

## Status

The app works on the owner's phone. The test results for each device and browser are not recorded in this repository. See "Risks" in `PLAN.md`.