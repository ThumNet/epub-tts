# How it works

Technical description of epub-tts internals.

## Pipeline

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

## Chapter navigation and continuous playback

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

## Recovery from stuck resume on iOS

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