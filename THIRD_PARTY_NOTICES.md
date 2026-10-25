# Third-party notices

epub-tts is licensed under GPL-3.0-only. See `LICENSE`.

This file lists the runtime dependencies, the shipped assets and the voices. Versions and licences come from `node_modules/*/package.json`.

## Runtime dependencies

| Name | Version | Licence | URL |
| --- | --- | --- | --- |
| @mintplex-labs/piper-tts-web | 1.0.5 | MIT | https://github.com/Mintplex-Labs/piper-tts-web |
| @diffusionstudio/piper-wasm | 1.0.0 | MIT (npm label). See the note below. | https://github.com/diffusion-studio/piper-wasm |
| onnxruntime-web | 1.18.0 | MIT | https://github.com/Microsoft/onnxruntime |
| coi-serviceworker | 0.1.7 | MIT | https://github.com/gzuidhof/coi-serviceworker |
| epubjs | 0.3.93 | BSD-2-Clause | https://github.com/futurepress/epub.js |

Two packages ship a licence file in `node_modules`:

- coi-serviceworker has a `LICENSE` file. It reads "Copyright (c) 2021 Guido Zuidhof".
- epubjs has a `license` file. It reads "Copyright (c) 2013, FuturePress".

The other three packages ship no licence file. For these, the licence names above come from the `license` field of each `package.json`.

### Note on @diffusionstudio/piper-wasm

The build copies `piper_phonemize.wasm` and `piper_phonemize.data` from this package into the site. This phonemizer contains espeak-ng and piper-phonemize. Both are GPL-3.0-derived. The npm package label says MIT. The label does not change the licence of the espeak-ng and piper-phonemize code inside the files.

## Shipped assets

| Asset | Source | Licence |
| --- | --- | --- |
| `ort/ort-wasm-simd.wasm`, `ort/ort-wasm-simd-threaded.wasm` | onnxruntime-web 1.18.0 | MIT |
| `piper/piper_phonemize.wasm`, `piper/piper_phonemize.data` | @diffusionstudio/piper-wasm 1.0.0 | Contains GPL-3.0-derived code (espeak-ng, piper-phonemize) |
| `coi-serviceworker.js` | coi-serviceworker 0.1.7 | MIT |

## Voices

The app loads Piper voices from the Hugging Face repository `diffusionstudio/piper-voices`. This repository mirrors `rhasspy/piper-voices`. The app downloads the voice files at run time. The repository does not contain them.

The voice picker offers these voices:

- en_US-kristin-medium
- en_US-norman-medium
- en_US-john-medium
- en_US-ljspeech-medium
- en_GB-cori-medium

According to their model cards, all five voices are trained on public-domain data.

No model card states a licence for the model files. We assume the dataset terms apply. This is an unverified inference and not legal advice.

### Credits

- The LibriVox volunteer readers, who recorded the public-domain audio.
- Bryce Beattie, who trained kristin, norman, john, cori and ljspeech. https://brycebeattie.com/files/tts/
- Keith Ito, who created the LJ Speech dataset. https://keithito.com/LJ-Speech-Dataset/
- The Piper project. https://github.com/rhasspy/piper
- The Hugging Face repositories `diffusionstudio/piper-voices` and `rhasspy/piper-voices`.
