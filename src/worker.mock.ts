/**
 * Test-only speech worker. It speaks the same message protocol as worker.ts but makes a quiet tone
 * instead of speech. No network and no model. Only end-to-end builds (VITE_E2E) include it.
 * Marker string for the production-build check: EPUB_TTS_MOCK_WORKER.
 */
import type { WorkerEvent, WorkerRequest } from "./protocol";

const SAMPLE_RATE = 22050;
const SECONDS_PER_CHARACTER = 0.06;
const MIN_SECONDS = 0.4;
const TONE_HZ = 220;
const AMPLITUDE = 3000;
const GENERATE_DELAY_MS = 20;

let cancelled = false;

function send(event: WorkerEvent, transfer: Transferable[] = []): void {
  postMessage(event, { transfer });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tone(text: string): Int16Array {
  const seconds = Math.max(MIN_SECONDS, text.length * SECONDS_PER_CHARACTER);
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = Math.round(AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE));
  }
  return pcm;
}

async function init(): Promise<void> {
  const started = performance.now();
  await pause(GENERATE_DELAY_MS);
  send({ type: "ready", initMs: performance.now() - started });
}

// Same semantics as worker.ts: the flag is checked before each sentence. The last sentence always finishes.
async function generate(sentences: string[]): Promise<void> {
  cancelled = false;
  const started = performance.now();
  for (let index = 0; index < sentences.length; index += 1) {
    if (cancelled) {
      send({ type: "cancelled" });
      return;
    }
    const text = sentences[index];
    if (text === undefined) continue;
    const clipStart = performance.now();
    await pause(GENERATE_DELAY_MS);
    const pcm = tone(text);
    send({ type: "clip", index, sampleRate: SAMPLE_RATE, pcm, genMs: performance.now() - clipStart }, [pcm.buffer]);
  }
  send({ type: "done", totalMs: performance.now() - started });
}

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case "init":
      void init();
      break;
    case "generate":
      void generate(request.sentences);
      break;
    case "cancel":
      cancelled = true;
      break;
  }
});
