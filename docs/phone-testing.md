# Phone testing

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

## How to read the log

- `visibilitychange: hidden` and `visible` show when the screen locks and unlocks.
- `heartbeat` lines appear every 10 seconds while the audio plays. A gap while the screen is locked is normal if the page is suspended. Compare the `t=` value after unlock with the elapsed time.
- `audio pause` without a button press means the system paused the audio.
- `media session action` lines show lock-screen presses that reached the page.

- `recovery` and `stuck watch` lines show the watchdog and the segment reload.
- `segment N ready`, `dropped`, `regenerating` and `swap` lines show the segment life cycle.