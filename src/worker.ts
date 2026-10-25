import { TtsSession } from "@mintplex-labs/piper-tts-web";
import type { WorkerEvent, WorkerRequest } from "./protocol";

let session: TtsSession | undefined;
let cancelled = false;

function send(event: WorkerEvent, transfer: Transferable[] = []): void {
  postMessage(event, { transfer });
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Read a 16-bit mono PCM WAV blob produced by the Piper session. */
async function readWav(blob: Blob): Promise<{ sampleRate: number; pcm: Int16Array }> {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const sampleRate = view.getUint32(24, true);
  const pcm = new Int16Array(buffer.slice(44));
  return { sampleRate, pcm };
}

async function init(voiceId: string, baseUrl: string): Promise<void> {
  const started = performance.now();
  session = await TtsSession.create({
    voiceId,
    // Model files come from Hugging Face (pinned inside the library). WASM files come from this origin.
    wasmPaths: {
      onnxWasm: `${baseUrl}ort/`,
      piperData: `${baseUrl}piper/piper_phonemize.data`,
      piperWasm: `${baseUrl}piper/piper_phonemize.wasm`,
    },
    progress: (p) => {
      if (p.total > 0 && p.url.endsWith(".onnx")) {
        send({ type: "model-progress", loaded: p.loaded, total: p.total });
      }
    },
    logger: (text) => send({ type: "log", text: `piper: ${text}` }),
  });
  send({ type: "ready", initMs: performance.now() - started });
}

async function generate(sentences: string[]): Promise<void> {
  if (!session) {
    send({ type: "error", message: "Worker is not initialised." });
    return;
  }
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
    const wav = await session.predict(text);
    const { sampleRate, pcm } = await readWav(wav);
    send(
      { type: "clip", index, sampleRate, pcm, genMs: performance.now() - clipStart },
      [pcm.buffer],
    );
  }
  send({ type: "done", totalMs: performance.now() - started });
}

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case "init":
      init(request.voiceId, request.baseUrl).catch((e: unknown) =>
        send({ type: "error", message: describeError(e) }),
      );
      break;
    case "generate":
      generate(request.sentences).catch((e: unknown) =>
        send({ type: "error", message: describeError(e) }),
      );
      break;
    case "cancel":
      cancelled = true;
      break;
  }
});
