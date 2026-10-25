/** The curated voice list. Source of the choice: docs/voice-licence-audit.md. */

export interface VoiceOption {
  id: string;
  label: string;
  /** Approximate download size in MB. */
  sizeMb: number;
}

export const DEFAULT_VOICE_ID = "en_US-kristin-medium";

export const VOICES: readonly VoiceOption[] = [
  { id: "en_US-kristin-medium", label: "Kristin (US, female)", sizeMb: 60.6 },
  { id: "en_US-norman-medium", label: "Norman (US, male)", sizeMb: 60.6 },
  { id: "en_US-john-medium", label: "John (US, male)", sizeMb: 60.6 },
  { id: "en_US-ljspeech-medium", label: "LJ Speech (US, female)", sizeMb: 60.6 },
  { id: "en_GB-cori-medium", label: "Cori (UK, female)", sizeMb: 60.6 },
];

export function findVoice(id: string): VoiceOption | undefined {
  return VOICES.find((voice) => voice.id === id);
}
