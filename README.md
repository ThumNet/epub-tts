# epub-tts

A web app that reads an EPUB chapter aloud with Piper TTS in the browser. It runs on a phone and on a desktop. It has no backend.

Open it at https://thumnet.github.io/epub-tts/. Pick an EPUB file, pick a chapter, and press "Generate chapter audio". Playback starts after the first segment.

## What it does

- Reads whole chapters aloud, with no character limit. Audio is generated in segments of about one minute, so playback starts before the chapter is finished.
- Runs entirely in the browser. No server, no account, no upload of your book.
- Works on phones and desktops. Can be installed to the home screen on iPhone.
- Lets you choose a voice (Piper). Voices download on demand (about 61 MB) and can be removed to free space.
- Adjustable playback speed from 0.75x to 2x.
- Remembers the last book, the reading position, the voice and the speed on the device.
- Chapter navigation with Prev/Next, including from the lock screen, and continuous playback across chapters.
- Lock-screen controls through the Media Session API.
- Keeps memory bounded by dropping audio of old segments; seeks back regenerate them.
- Records diagnostics in an on-screen log you can copy.

## Documentation

- [User guide](docs/user-guide.md): how to use the app, known iOS limit, reporting bugs.
- [How it works](docs/how-it-works.md): pipeline, chapter navigation, iOS resume recovery.
- [Development](docs/development.md): running locally, tests, large files.
- [Deployment](docs/deployment.md): GitHub Pages.
- [Phone testing](docs/phone-testing.md): manual test checklist and log reading.
- [Known limitations](docs/limitations.md): iOS lock-screen resume, phonemizer, status.

## Licence

Licence: see `LICENSE`. Third-party licences and voice credits: see `THIRD_PARTY_NOTICES.md`. The app version shows in the footer.

See `PLAN.md` for goals, decisions and risks.