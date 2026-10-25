import { log } from "./log";

/** The one remembered book. Stored in IndexedDB under the key `current`. */
export interface StoredBook {
  blob: Blob;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  title: string;
  /** Epoch milliseconds. */
  savedAt: number;
}

export type SaveResult = { ok: true; size: number } | { ok: false; reason: string };

const DB_NAME = "epub-tts";
const STORE_NAME = "book";
const KEY = "current";

function reasonOf(error: unknown): string {
  if (error instanceof DOMException) return error.name;
  if (error instanceof Error) return error.name === "Error" ? error.message : error.name;
  return String(error);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        // The open was already rejected (blocked). Do not keep this late connection.
        db.close();
        return;
      }
      settled = true;
      // Another tab upgrades the database: close ours so it is not blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("could not open the database"));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("the database is blocked by another tab"));
    };
  });
}

// All operations run one after another, so a save and a forget never overlap.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Run one request in a transaction. Resolves after the transaction completes. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error("transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
    });
  } finally {
    db.close();
  }
}

function isStoredBook(value: unknown): value is StoredBook {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.blob instanceof Blob &&
    typeof record.size === "number" &&
    record.size === record.blob.size &&
    typeof record.name === "string" &&
    typeof record.type === "string" &&
    typeof record.lastModified === "number" &&
    typeof record.title === "string" &&
    typeof record.savedAt === "number"
  );
}

/** Replace the remembered book with this file. Never throws. */
export function saveBook(file: File, title: string): Promise<SaveResult> {
  return enqueue(() => saveNow(file, title));
}

async function saveNow(file: File, title: string): Promise<SaveResult> {
  log(`remember start: "${file.name}" (${file.size} bytes)`);
  try {
    const record: StoredBook = {
      blob: file.slice(0, file.size, file.type),
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      title,
      savedAt: Date.now(),
    };
    await withStore("readwrite", (store) => store.put(record, KEY));
    log(`remember ok: ${file.size} bytes`);
    return { ok: true, size: file.size };
  } catch (error) {
    const reason = reasonOf(error);
    log(`remember failed: ${reason}`);
    return { ok: false, reason };
  }
}

/** Read the remembered book. Returns undefined when there is none or on any failure. Never throws. */
export function loadBook(): Promise<StoredBook | undefined> {
  return enqueue(loadNow);
}

async function loadNow(): Promise<StoredBook | undefined> {
  try {
    const value: unknown = await withStore("readonly", (store) => store.get(KEY));
    if (value === undefined) return undefined;
    if (!isStoredBook(value)) {
      log("remembered book record has an unexpected shape: ignoring it");
      return undefined;
    }
    return value;
  } catch (error) {
    log(`remembered book could not be read: ${reasonOf(error)}`);
    return undefined;
  }
}

/** Delete the remembered book. Returns true on success. Never throws. */
export function forgetBook(): Promise<boolean> {
  return enqueue(forgetNow);
}

async function forgetNow(): Promise<boolean> {
  try {
    await withStore("readwrite", (store) => store.delete(KEY));
    log("remembered book forgotten");
    return true;
  } catch (error) {
    log(`forget failed: ${reasonOf(error)}`);
    return false;
  }
}

/** Rebuild a File with the same name, size, type and lastModified, so the book id stays the same. */
export function storedBookToFile(stored: StoredBook): File {
  return new File([stored.blob], stored.name, { type: stored.type, lastModified: stored.lastModified });
}
