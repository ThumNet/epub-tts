# User guide

How to use epub-tts on a phone or desktop. No installation and no account are needed.

## Try it

1. Open https://thumnet.github.io/epub-tts/ on your phone.
2. Optional on iPhone: add the app to the home screen. Open the page in Safari, tap Share, then tap "Add to Home Screen".
3. Pick an EPUB file. Pick a chapter. Press "Generate chapter audio". Playback starts after the first segment.
4. Pick a voice in the "Voice" list. The default is Kristin. The page shows whether the voice is downloaded. Use "Download" to fetch it ahead of time (about 61 MB) or "Remove" to free the space. If the library cannot remove the files (Safari lacks the call it uses), the app deletes them directly. The page shows an error if the voice stays stored. The first generation downloads the voice by itself if needed.
5. Use the "Speed" slider (0.75x to 2x) to change the playback speed. "Reset to 1x" returns to normal speed. The app remembers your voice and speed.
6. The app remembers the last EPUB you opened on this device. After a restart, the app reopens it and shows "restored from this device". Press "Forget this book" to delete it from the device. The saved position and settings stay. The browser may clear site storage. We did not verify this on iOS. Offline use comes in a later phase.

## Known limit on iOS

On iOS, after a pause of about 3 to 6 seconds, resume from the lock screen stops working. It works again after you bring the app to the foreground. This comes from the owner's own phone log. We did not verify it on other devices.

## Report a bug

1. Open "Diagnostics" at the bottom of the page. Press "Copy log".
2. Open a new issue in this repository. Choose the "Bug report" template.
3. Paste the log into the template.

The app version shows in the footer. Licence: see `LICENSE`. Third-party licences and voice credits: see `THIRD_PARTY_NOTICES.md`.

## See also

- [How it works](how-it-works.md)
- [Known limitations and maintenance notes](limitations.md)