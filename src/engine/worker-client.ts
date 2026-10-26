import { log } from "../log";
import type { WorkerEvent, WorkerRequest } from "../protocol";
import { createMockWorker } from "../e2e-worker";
import { INIT_TIMEOUT_MS } from "./config";
import type { Clip } from "../wav";

export interface GeneratedClip {
  clip: Clip;
  genMs: number;
}

/** Thrown when the worker holds another voice than the request expects. */
export class VoiceChangedError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Worker voice changed (expected ${expected}, worker has ${actual ?? "none"}).`);
    this.name = "VoiceChangedError";
  }
}

export interface WorkerClientHooks {
  setStatus(text: string): void;
  /** Called after an init succeeded, right after the "model ready" log line. */
  onReady(): void;
}

export interface WorkerClient {
  /** Make the worker hold a session for `voiceId`. */
  ensure(voiceId: string): Promise<void>;
  /** Generate one sentence. Rejects with VoiceChangedError when the worker holds another voice. */
  clip(text: string, voiceId: string): Promise<GeneratedClip>;
  /**
   * The worker part of cancelling. While an init waits, the worker is terminated and true is returned.
   * Otherwise a "cancel" request is posted and false is returned.
   */
  cancel(): boolean;
}

export function createWorkerClient(hooks: WorkerClientHooks): WorkerClient {
  function createWorker(): Worker {
    // End-to-end builds (VITE_E2E) use a mock worker with the same message protocol. No network, no model.
    const created = import.meta.env.VITE_E2E
      ? createMockWorker()
      : new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
    created.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
      if (created !== worker) return;
      const data = event.data;
      if (data.type === "log") log(data.text);
      onWorkerEvent(data);
    });
    created.addEventListener("error", (event) => {
      if (created !== worker) return;
      log(`worker error: ${event.message}`);
      failWorker(new Error(`Worker error: ${event.message || "unknown"}`));
    });
    created.addEventListener("messageerror", () => {
      if (created !== worker) return;
      log("worker messageerror");
      failWorker(new Error("Worker message could not be read."));
    });
    return created;
  }

  let worker = createWorker();
  let workerReady = false;
  // The voice the worker session holds. Undefined until the first init succeeds.
  let workerVoiceId: string | undefined;
  // True once the worker received an init request. A used worker is replaced, never re-initialised.
  let workerUsed = false;
  let onWorkerEvent: (event: WorkerEvent) => void = () => {};
  // Rejects the worker wait in flight (init or clip). Set only while a wait is pending.
  let rejectPending: ((error: Error) => void) | undefined;
  // True while an init request waits for "ready".
  let initPending = false;

  /**
   * Throw the worker away and create a fresh one. The old worker is terminated, and its late
   * messages are ignored because the listeners compare against the current `worker`.
   */
  function resetWorker(): void {
    worker.terminate();
    worker = createWorker();
    workerReady = false;
    workerVoiceId = undefined;
    workerUsed = false;
  }

  /** A worker crash or unreadable message. Resets the worker and settles the pending wait. */
  function failWorker(error: Error): void {
    resetWorker();
    rejectPending?.(error);
  }

  function post(request: WorkerRequest): void {
    worker.postMessage(request);
  }

  function waitForEvent(type: WorkerEvent["type"], timeoutMs?: number): Promise<WorkerEvent> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const finish = (): void => {
        globalThis.clearTimeout(timer);
        onWorkerEvent = () => {};
        rejectPending = undefined;
      };
      rejectPending = (error) => {
        finish();
        reject(error);
      };
      if (timeoutMs !== undefined) {
        timer = globalThis.setTimeout(() => {
          log(`worker wait for "${type}" timed out after ${timeoutMs / 1000} s`);
          rejectPending?.(new Error(`Timed out after ${timeoutMs / 1000} s while loading the voice.`));
        }, timeoutMs);
      }
      onWorkerEvent = (event) => {
        if (event.type === type) {
          finish();
          resolve(event);
        } else if (event.type === "error") {
          finish();
          reject(new Error(event.message));
        } else if (event.type === "model-progress") {
          const percent = Math.round((event.loaded * 100) / event.total);
          hooks.setStatus(`Downloading voice model: ${percent}%`);
        }
      };
    });
  }

  // The worker handles one request at a time and reports through one global handler.
  // Every clip request waits for the previous one. Forward generation and regeneration
  // interleave per sentence this way and never overlap in the worker.
  let workerQueue: Promise<unknown> = Promise.resolve();

  /**
   * Make the worker hold a session for `voiceId`. The library keeps one global session per worker and
   * ignores a new voice id, so a voice change replaces the whole worker. Terminating the old worker
   * releases its model and WASM memory. Runs inside the worker queue, so no clip request is in flight.
   */
  function ensureWorker(voiceId: string): Promise<void> {
    const run = workerQueue.then(() => initWorker(voiceId));
    workerQueue = run.catch(() => undefined);
    return run;
  }

  async function initWorker(voiceId: string): Promise<void> {
    if (workerReady && workerVoiceId === voiceId) return;
    if (workerUsed) {
      log(`replacing worker session (${workerVoiceId ?? "failed init"} -> ${voiceId})`);
      resetWorker();
    }
    workerUsed = true;
    workerReady = false;
    workerVoiceId = undefined;
    hooks.setStatus("Loading voice model and WASM...");
    const ready = waitForEvent("ready", INIT_TIMEOUT_MS);
    initPending = true;
    post({
      type: "init",
      voiceId,
      baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href,
    });
    let event: WorkerEvent;
    try {
      event = await ready;
    } catch (error) {
      // Init failed, timed out or was cancelled. Drop the worker unless it was already reset.
      if (workerUsed) resetWorker();
      throw error;
    } finally {
      initPending = false;
    }
    workerReady = true;
    workerVoiceId = voiceId;
    if (event.type === "ready") log(`model ${voiceId} ready in ${(event.initMs / 1000).toFixed(1)} s`);
    hooks.onReady();
  }

  /**
   * Generate one sentence. One sentence per worker request lets the page pause between sentences.
   * The request carries the voice it expects. It fails without sending anything when the worker
   * holds another voice, so a clip is never made with the wrong voice.
   */
  function generateClip(text: string, voiceId: string): Promise<GeneratedClip> {
    const run = workerQueue.then(() => {
      if (!workerReady || workerVoiceId !== voiceId) throw new VoiceChangedError(voiceId, workerVoiceId);
      return requestClip(text);
    });
    workerQueue = run.catch(() => undefined);
    return run;
  }

  function requestClip(text: string): Promise<GeneratedClip> {
    return new Promise((resolve, reject) => {
      let result: GeneratedClip | undefined;
      const finish = (): void => {
        onWorkerEvent = () => {};
        rejectPending = undefined;
      };
      rejectPending = (error) => {
        finish();
        reject(error);
      };
      onWorkerEvent = (event) => {
        if (event.type === "clip") {
          result = { clip: { sampleRate: event.sampleRate, pcm: event.pcm }, genMs: event.genMs };
        } else if (event.type === "done") {
          finish();
          if (result) resolve(result);
          else reject(new Error("Worker finished without a clip."));
        } else if (event.type === "cancelled") {
          finish();
          reject(new Error("Generation cancelled."));
        } else if (event.type === "error") {
          finish();
          reject(new Error(event.message));
        }
      };
      post({ type: "generate", sentences: [text] });
    });
  }

  function cancel(): boolean {
    if (initPending) {
      // No generate request is running. Terminate the worker so the init wait settles.
      log("cancel during voice init: terminating the worker");
      failWorker(new Error("Generation cancelled."));
      return true;
    }
    post({ type: "cancel" });
    return false;
  }

  return { ensure: ensureWorker, clip: generateClip, cancel };
}
