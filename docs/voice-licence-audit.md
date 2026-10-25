# Voice licence audit

Result of phase 1 of `plans/2026-10-25-release-v1.md`. Date: 2026-10-25.
This document is not legal advice.

## Decision

- Drop `en_US-lessac-medium`, the voice used in the prototype.
- Offer five voices to the invited group, in the medium tier: kristin, norman, john, ljspeech, cori.
- Exclude voices derived from Lessac, voices with non-commercial (NC) data, and voices with unknown lineage.

## Method

- On 2026-10-25 we read the MODEL_CARD of every English voice and tier in `rhasspy/piper-voices` on Hugging Face (en_US and en_GB, 30 voices).
- We checked that the card text of the five shortlisted voices is identical on the `diffusionstudio/piper-voices` mirror.
- `@mintplex-labs/piper-tts-web` 1.0.5 downloads from that mirror (`node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js`, line 13).
- We read the Lessac licence page and the LibriVox and LJ Speech dataset pages.
- We did not get legal advice.
- We did not read per-dataset licence pages for the excluded voices.

Key findings:

1. No card states a licence for the model files. Cards state the licence of the training dataset and the training base.
2. The mirror shows "License: mit" at repo level. That label does not clear the dataset terms.

## Shortlist

All five voices are trained from scratch on a public-domain dataset, or fine-tuned from such a voice. None derives from Lessac.
All five exist in the library voice list (`voices_static-*.js`).

| Voice | Gender/accent | Training | Dataset licence (per card) | Download size | Card URL |
|---|---|---|---|---|---|
| en_US-kristin-medium | female, US | from scratch, 2000 epochs, ~11.5 h LibriVox | public domain | 60.6 MB | [card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/kristin/medium/MODEL_CARD) |
| en_US-norman-medium | male, US | from scratch, 1200 epochs, ~15.5 h LibriVox | public domain | 60.6 MB | [card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/norman/medium/MODEL_CARD) |
| en_US-john-medium | male, US | fine-tuned from kristin, +600 epochs, ~12.5 h LibriVox | public domain | 60.6 MB | [card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/john/medium/MODEL_CARD) |
| en_US-ljspeech-medium | female, US | from scratch, 1000 epochs, LJ Speech | public domain (dataset page says "Public Domain"; audio by LibriVox) | 60.6 MB | [card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/medium/MODEL_CARD) |
| en_GB-cori-medium | female, UK | from scratch, 640 epochs, ~24 h LibriVox | public domain | 60.6 MB | [card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_GB/cori/medium/MODEL_CARD) |

- Offer the medium tier (60.6 MB each).
- The high tiers of ljspeech and cori (108.9 MB each) are an option later. The cori high card says 500 epochs.
- Suggested default voice: `en_US-kristin-medium`. Listening tests must confirm it.

## Excluded voices

| Group | Voices | Reason |
|---|---|---|
| Lessac | en_US-lessac (low, medium, high) | Data is under a "Research Licence Agreement" for "Research Purposes only". The licence goes only to the named licensee. A scout also read non-commercial and no-third-party-use terms. We did not re-read the full text. |
| Fine-tuned from lessac medium | amy (medium), arctic, hfc_female, hfc_male, joe, kusal, l2arctic, libritts_r (see 'Later ideas' in plans/2026-10-25-release-v1.md), mike, ryan (medium), sam, reza_ibrahim, alan (medium), alba, aru, jenny_dioco, northern_english_male, semaine, vctk | Per the cards, these start from lessac medium. It is unresolved whether Lessac terms carry over. We exclude them to avoid the risk. |
| Fine-tuned from Ryan low | alan (low), amy (low), danny, kathleen, southern_english_female | RyanSpeech is CC BY-NC-SA 4.0 per the card. |
| Ryan from scratch | ryan (high, low) | Trained on CC BY-NC-SA 4.0 data. The share-alike term makes the licensing of the model files unclear. Excluded for now. |
| LibriTTS | libritts (high) | CC BY 4.0 per the card, 904 speakers. Not shortlisted: the app needs speaker selection and attribution. Possible later: see 'Later ideas' in plans/2026-10-25-release-v1.md. |
| Unknown lineage | bryce (medium) | Public domain per the card. Fine-tuned from an unreleased voice. |

## Attribution

Public-domain data needs no credit. We credit the sources anyway.
Phase 2 puts these credits in the notices file:

- The LibriVox volunteer readers.
- Bryce Beattie, who trained kristin, norman, john, cori, and ljspeech, per the cards. He published them at https://brycebeattie.com/files/tts/.
- Keith Ito (LJ Speech).
- The Piper project and the Hugging Face voice repository.

## Remaining risks

- (a) No card or other source states a model-file licence. We assume the dataset terms govern the model files. This is an unverified inference. It does not establish permission to serve the files. The risk may be lower for public-domain data, but it is not zero.
- (b) LibriVox says its recordings are public domain in the USA and "not necessarily in other countries". Invited users outside the USA may be in a different position.
- (c) The library downloads from the diffusionstudio mirror. Its card text matched for the five voices today. It could change.
- (d) We have not listened to the shortlisted voices. Listening tests are a phase 3 task.
- (e) We did not read per-dataset licence pages for the excluded voices. Exclusion rests on card statements and lineage risk.

## Sources

- https://huggingface.co/rhasspy/piper-voices
- https://huggingface.co/diffusionstudio/piper-voices
- https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html
- https://keithito.com/LJ-Speech-Dataset/
- https://librivox.org/pages/public-domain/
- https://brycebeattie.com/files/tts/
- Card URLs in the Shortlist table.
