import { HEARTBEAT_MS } from "./config";
import { log } from "../log";
import { loadGenerationMarker, setGenerationMarker } from "../store";

interface AudioSessionLike {
  type: string;
}

function isAudioSession(value: unknown): value is AudioSessionLike {
  return typeof value === "object" && value !== null && "type" in value;
}

function findAudioSession(): AudioSessionLike | undefined {
  if (!("audioSession" in navigator)) return undefined;
  const candidate: unknown = navigator.audioSession;
  return isAudioSession(candidate) ? candidate : undefined;
}

const AUDIO_EVENTS = [
  "play",
  "playing",
  "pause",
  "ended",
  "waiting",
  "stalled",
  "suspend",
  "emptied",
  "loadedmetadata",
  "error",
  "seeked",
];

export interface Diagnostics {
  /** Logs and clears the generation marker left by a session that died while generating. */
  reportStaleMarker(): void;
  startHeartbeat(): void;
  logAudioEvents(): void;
  setupAudioSession(): void;
}

export interface DiagnosticsDeps {
  audio: HTMLAudioElement;
  /** Returns the page visibility state. The engine cannot read `document`. */
  getVisibility: () => string;
}

/** Each method runs the code that stood inline in main.ts. The caller invokes it at the same position. */
export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const { audio, getVisibility } = deps;

  function reportStaleMarker(): void {
    const staleMarker = loadGenerationMarker();
    if (staleMarker) {
      log(
        `PREVIOUS SESSION ENDED WHILE GENERATING: chapter index ${staleMarker.chapterIndex}, ` +
          `${staleMarker.done}/${staleMarker.total} sentences, last update ${new Date(staleMarker.at).toLocaleTimeString()}. ` +
          "The tab was probably killed or reloaded.",
      );
      setGenerationMarker(undefined);
    }
  }

  function startHeartbeat(): void {
    setInterval(() => {
      if (!audio.paused) {
        log(
          `heartbeat: visibility=${getVisibility()} t=${audio.currentTime.toFixed(1)} s ` +
            `readyState=${audio.readyState} networkState=${audio.networkState}`,
        );
      }
    }, HEARTBEAT_MS);
  }

  function logAudioEvents(): void {
    for (const name of AUDIO_EVENTS) {
      audio.addEventListener(name, () => {
        const detail = name === "error" ? ` code=${audio.error?.code ?? "?"}` : "";
        log(`audio ${name} at ${audio.currentTime.toFixed(1)} s${detail}`);
      });
    }
  }

  function setupAudioSession(): void {
    const audioSession = findAudioSession();
    if (audioSession) {
      try {
        audioSession.type = "playback";
        log(`audioSession.type set to "${audioSession.type}"`);
      } catch (error) {
        log(`audioSession.type could not be set: ${String(error)}`);
      }
    } else {
      log("audioSession: not supported");
    }
  }

  return { reportStaleMarker, startHeartbeat, logAudioEvents, setupAudioSession };
}
