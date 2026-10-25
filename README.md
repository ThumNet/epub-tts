# EPUB TTS prototype

A throwaway prototype. It reads one EPUB chapter aloud with Piper TTS in the browser.

It answers one question. Does a pre-generated chapter keep playing, and can it pause and resume, with the phone screen locked? See `PLAN.md` for goals, decisions and risks.

## Run locally

Requirements: Node.js 20.19 or newer, and npm.

1. Run `npm install`.
2. Run `npm run dev`.
3. Open the URL that Vite prints. The path starts with `/epub-tts/`, for example `http://localhost:5173/epub-tts/`.
4. Pick an EPUB file, pick a chapter, and press "Generate chapter audio".

Other scripts:

- `npm run typecheck` checks the types.
- `npm run build` checks the types and builds into `dist/`.
- `npm run preview` serves `dist/` at `http://localhost:4173/epub-tts/`.

The first generation downloads the voice model (about 63 MB). The browser stores it in the origin private file system.

## Large files

The repository does not contain the large files. No download script is needed.

- The ONNX Runtime WASM files and the Piper phonemizer files (about 18 MB) come from npm. The build copies them from `node_modules` into `dist/ort/` and `dist/piper/`.
- The voice model comes from Hugging Face at run time. The library hard-codes the URL: `https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx`.
- `node_modules/` and `dist/` are in `.gitignore`.

## Deploy to GitHub Pages

1. Create a GitHub repository named `epub-tts`. Push the project to the `main` branch.
2. In the repository settings, open "Pages". Set "Source" to "GitHub Actions".
3. The workflow `.github/workflows/pages.yml` builds and deploys on each push to `main`.
4. Open `https://<user>.github.io/epub-tts/`.

The workflow sets `VITE_BASE` to `/<repository name>/`. To build by hand for another path, run `VITE_BASE=/other/ npm run build`.

## Run the phone tests

Use an EPUB with a chapter of 10 to 15 minutes of audio. The default limit of 9,000 characters gives about 10 minutes. Set 13,500 for about 15 minutes.

1. Open the deployed page on the phone. Use a Safari tab first.
2. Pick the EPUB file. Pick the chapter. Press "Generate chapter audio". Keep the screen on until generation ends.
3. Press play. Then follow the checklist below.
4. Press "Copy log" after each test. Save the log with the device, browser and result.

Checklist (the full version is in `PLAN.md`):

- [ ] Lock while playing. Wait 5 minutes. Does the audio still play?
- [ ] Pause from the lock screen. Resume after 20 s, 1 min, 5 min and 15 min. Note where resume fails.
- [ ] Check the lock-screen title, play/pause and seek controls.
- [ ] Force-close and reopen. Check that the page shows the saved position. Pick the same EPUB. Press "Resume saved position".
- [ ] Read the real-time factor (RTF) in the log. RTF is generation time divided by audio length.
- [ ] Check for a tab kill during generation. The log shows a warning at the next start-up.
- [ ] Repeat as the installed home-screen app on iPhone. Then repeat on Android Chrome.

How to read the log:

- `visibilitychange: hidden` and `visible` show when the screen locks and unlocks.
- `heartbeat` lines appear every 10 seconds while the audio plays. A gap while the screen is locked is normal if the page is suspended. Compare the `t=` value after unlock with the elapsed time.
- `audio pause` without a button press means the system paused the audio.
- `media session action` lines show lock-screen presses that reached the page.

## Not tested yet

I built and type-checked the code. I did not run it on a phone. I did not hear any audio. See "Risks" in `PLAN.md`.
