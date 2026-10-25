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

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * Delete the stored files of a voice straight from the browser file storage (OPFS). The library's
 * remove() uses FileSystemHandle.remove(), which Safari lacks, and it swallows every error.
 * The library stores `${id}.onnx` and `${id}.onnx.json` in the folder "piper". A missing file is fine.
 */
export async function removeVoiceFiles(id: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await root.getDirectoryHandle("piper");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const name of [`${id}.onnx`, `${id}.onnx.json`]) {
    try {
      await dir.removeEntry(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export function findVoice(id: string): VoiceOption | undefined {
  return VOICES.find((voice) => voice.id === id);
}
