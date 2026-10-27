import { download, remove, stored } from "@mintplex-labs/piper-tts-web";
import { log } from "../log";
import { removeVoiceFiles } from "../voices";
import type { EngineHooks } from "./hooks";
import { errorName } from "./pure";

export interface VoicesStoreDeps {
  hooks: Pick<EngineHooks, "notifyChange">;
  getVoiceId: () => string;
  isVoiceInUse: (id: string) => boolean;
  isLibraryBusy: () => boolean;
  /** True while a chapter change or a changed-voice restart cancels and restarts the generation. */
  isTransitioning: () => boolean;
  persistSettings: () => void;
}

export interface VoicesStore {
  /** True while a voice download or removal runs. */
  readonly busy: boolean;
  /** Whether the selected voice is in the browser storage. Undefined when unknown. */
  readonly stored: boolean | undefined;
  /** Every voice id in the browser storage. Undefined when unknown. */
  readonly storedIds: readonly string[] | undefined;
  readonly message: string;
  /** Text of the last failed voice action. Cleared when a new voice action starts or the voice changes. */
  readonly error: string;
  refresh(): Promise<void>;
  /** The change handler of the voice select, after the settings hold the new voice id. */
  select(): void;
  startDownload(): void;
  startRemove(): void;
}

export function createVoicesStore(deps: VoicesStoreDeps): VoicesStore {
  const { hooks, getVoiceId, isVoiceInUse, isLibraryBusy, isTransitioning, persistSettings } = deps;
  let voiceBusy = false;
  let storedList: readonly string[] | undefined;
  let voiceMessage = "";
  let voiceError = "";
  let voiceStatusToken = 0;

  async function readStoredVoices(): Promise<string[] | undefined> {
    try {
      return await stored();
    } catch (error) {
      log(`voice storage unavailable: ${errorName(error)}`);
      return undefined;
    }
  }

  async function refreshVoiceStatus(): Promise<void> {
    const token = ++voiceStatusToken;
    const list = await readStoredVoices();
    if (token !== voiceStatusToken) return;
    storedList = list;
    hooks.notifyChange();
  }

  /** The library does not wait for its file write, so poll a few times after a download. */
  async function waitUntilStored(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const list = await readStoredVoices();
      if (!list) return false;
      if (list.includes(id)) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  return {
    get busy(): boolean {
      return voiceBusy;
    },
    get stored(): boolean | undefined {
      return storedList?.includes(getVoiceId());
    },
    get storedIds(): readonly string[] | undefined {
      return storedList;
    },
    get message(): string {
      return voiceMessage;
    },
    get error(): string {
      return voiceError;
    },
    refresh: refreshVoiceStatus,
    select(): void {
      const id = getVoiceId();
      persistSettings();
      log(`voice selected: ${id}. The worker switches before the next generation.`);
      voiceError = "";
      hooks.notifyChange();
      void refreshVoiceStatus();
    },
    startDownload(): void {
      // The same conditions as the disabled Download button. A transition starts a worker init without a recheck,
      // and the worker must not read the voice files that this download writes.
      if (
        voiceBusy ||
        storedList === undefined ||
        isVoiceInUse(getVoiceId()) ||
        isLibraryBusy() ||
        isTransitioning()
      ) {
        return;
      }
      const id = getVoiceId();
      voiceBusy = true;
      voiceError = "";
      voiceMessage = "Downloading 0%";
      hooks.notifyChange();
      log(`voice download started: ${id}`);
      void (async () => {
        try {
          await download(id, (progress) => {
            if (progress.total <= 0) return;
            voiceMessage = `Downloading ${Math.round((progress.loaded * 100) / progress.total)}%`;
            hooks.notifyChange();
          });
          const ok = await waitUntilStored(id);
          log(ok ? `voice download finished: ${id}` : `voice download finished but ${id} was not found in storage`);
        } catch (error) {
          log(`voice download failed: ${errorName(error)}`);
        } finally {
          voiceBusy = false;
          hooks.notifyChange();
          await refreshVoiceStatus();
        }
      })();
    },
    startRemove(): void {
      if (
        voiceBusy ||
        storedList === undefined ||
        isVoiceInUse(getVoiceId()) ||
        isLibraryBusy() ||
        isTransitioning()
      ) {
        return;
      }
      const id = getVoiceId();
      voiceBusy = true;
      voiceError = "";
      voiceMessage = "Removing...";
      hooks.notifyChange();
      log(`voice remove started: ${id}`);
      void (async () => {
        try {
          await remove(id);
          // The library swallows errors and needs FileSystemHandle.remove() (not in Safari). Check, then delete directly.
          if ((await readStoredVoices())?.includes(id)) {
            log(`library remove left ${id} in storage: deleting the files directly`);
            await removeVoiceFiles(id);
          }
          const left = await readStoredVoices();
          if (left?.includes(id)) throw new Error("the files are still in storage after deletion");
          log(`voice removed: ${id}`);
        } catch (error) {
          voiceError = `Could not remove the voice: ${errorName(error)}`;
          log(`voice remove failed: ${errorName(error)}`);
        } finally {
          voiceBusy = false;
          hooks.notifyChange();
          await refreshVoiceStatus();
        }
      })();
    },
  };
}
