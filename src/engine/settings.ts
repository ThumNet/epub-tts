import { loadSettings, saveSettings } from "../store";
import { DEFAULT_VOICE_ID, findVoice } from "../voices";
import { roundSpeed } from "./pure";

/** The part of HTMLAudioElement that settings touch. */
export interface RateTarget {
  defaultPlaybackRate: number;
  playbackRate: number;
  preservesPitch: boolean;
}

export interface SettingsDeps {
  audio: RateTarget;
}

export interface LoadedSettings {
  voiceId: string;
  speed: number;
  /** The saved voice id when it is not in the voice list. The caller logs it. */
  rejectedVoice?: string;
}

export interface Settings {
  readonly speed: number;
  readonly voiceId: string;
  /** Stores the id, or the default voice when the id is unknown. */
  setVoiceId(id: string): void;
  /** Rounds and stores the speed. No log, no DOM. */
  setSpeed(value: number): void;
  /** Assigning audio.src resets playbackRate to defaultPlaybackRate, so set both. */
  applyPlaybackRate(): void;
  persist(): void;
  /** Reads the saved settings into the state and reports what it decided. Writes nothing. */
  load(): LoadedSettings;
}

export function createSettings(deps: SettingsDeps): Settings {
  const { audio } = deps;
  let speed = 1;
  let voiceId = DEFAULT_VOICE_ID;

  return {
    get speed(): number {
      return speed;
    },
    get voiceId(): string {
      return voiceId;
    },
    setVoiceId(id: string): void {
      voiceId = findVoice(id)?.id ?? DEFAULT_VOICE_ID;
    },
    setSpeed(value: number): void {
      speed = roundSpeed(value);
    },
    applyPlaybackRate(): void {
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
      audio.preservesPitch = true;
    },
    persist(): void {
      saveSettings({ voiceId, speed });
    },
    load(): LoadedSettings {
      const saved = loadSettings();
      const result: LoadedSettings = { voiceId: DEFAULT_VOICE_ID, speed };
      if (saved) {
        if (findVoice(saved.voiceId)) {
          result.voiceId = saved.voiceId;
        } else {
          result.rejectedVoice = saved.voiceId;
        }
        speed = roundSpeed(saved.speed);
        result.speed = speed;
      }
      voiceId = result.voiceId;
      return result;
    },
  };
}
