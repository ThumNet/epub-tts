import { log } from "../log";
import { SEEK_STEP_S } from "./config";

export interface MediaSessionDeps {
  audio: HTMLAudioElement;
  getBookTitle: () => string | undefined;
  actions: {
    play(): void;
    pause(): void;
    seek(seconds: number): void;
    navigate(step: 1 | -1): void;
  };
}

export interface MediaSessionController {
  /** Registers the action handlers and the audio play/pause listeners. Call once, at boot. */
  setup(): void;
  updatePositionState(): void;
  resetPositionState(): void;
  setMetadata(title: string): void;
  setPlaybackState(state: MediaSessionPlaybackState): void;
}

export function createMediaSession(deps: MediaSessionDeps): MediaSessionController {
  const { audio, getBookTitle, actions } = deps;
  let lastPositionState = 0;

  function setup(): void {
    const session = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => actions.play()],
      ["pause", () => actions.pause()],
      [
        "seekto",
        (details) => {
          if (details.seekTime !== undefined) actions.seek(details.seekTime);
        },
      ],
      ["seekbackward", (d) => actions.seek(audio.currentTime - (d.seekOffset ?? SEEK_STEP_S))],
      ["seekforward", (d) => actions.seek(audio.currentTime + (d.seekOffset ?? SEEK_STEP_S))],
      ["previoustrack", () => actions.navigate(-1)],
      ["nexttrack", () => actions.navigate(1)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, (details) => {
          log(`media session action: ${action}`);
          handler(details);
        });
      } catch {
        log(`media session action not supported: ${action}`);
      }
    }
    audio.addEventListener("play", () => (session.playbackState = "playing"));
    audio.addEventListener("pause", () => (session.playbackState = "paused"));
  }

  function updatePositionState(): void {
    const now = Date.now();
    if (now - lastPositionState < 1000 || !Number.isFinite(audio.duration)) return;
    lastPositionState = now;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch {
      // Some browsers reject odd values. Ignore.
    }
  }

  function resetPositionState(): void {
    lastPositionState = 0;
  }

  function setMetadata(title: string): void {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: getBookTitle() ?? "EPUB TTS",
      album: "epub-tts",
      artwork: [{ src: `${import.meta.env.BASE_URL}icon.svg`, sizes: "512x512", type: "image/svg+xml" }],
    });
  }

  function setPlaybackState(state: MediaSessionPlaybackState): void {
    navigator.mediaSession.playbackState = state;
  }

  return { setup, updatePositionState, resetPositionState, setMetadata, setPlaybackState };
}
