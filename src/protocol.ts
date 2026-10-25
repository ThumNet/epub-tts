/** Messages between the page and the TTS worker. */

export type WorkerRequest =
  | { type: "init"; voiceId: string; baseUrl: string }
  | { type: "generate"; sentences: string[] }
  | { type: "cancel" };

export type WorkerEvent =
  | { type: "log"; text: string }
  | { type: "model-progress"; loaded: number; total: number }
  | { type: "ready"; initMs: number }
  | { type: "clip"; index: number; sampleRate: number; pcm: Int16Array; genMs: number }
  | { type: "done"; totalMs: number }
  | { type: "cancelled" }
  | { type: "error"; message: string };
