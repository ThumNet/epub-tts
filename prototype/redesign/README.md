# Redesign prototype (throwaway)

This folder holds a static prototype of the redesign in `plans/2026-10-26-redesign-design.md`.
It is not part of the app. Step 6 of the plan deletes it.

Open `index.html` in a browser. Use `?state=` (welcome, book, generating, playing, paused, resume), `?sheet=` (book, voice, diagnostics) and `?clean=1` (hide the debug bar).
`?theme=light|dark` forces a scheme. Only `shots.mjs` uses it.

Re-run the screenshots:

    node prototype/redesign/shots.mjs

The PNGs go to `prototype/redesign/shots/`.
