/**
 * The wallet record (address, passkey credential id, public key, rpId), kept
 * twice in this browser: localStorage and IndexedDB. Clearing one leaves the
 * other, and the next load copies it back. Clearing all site data removes
 * both; then only the backup code (or, for a discoverable passkey, the
 * passkey itself) can bring the wallet back. Nothing stored here is secret.
 */

const DB_NAME = "autumn";
const STORE = "records";

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).finally(() => db.close()) as Promise<string | null>;
}

async function idbPut(key: string, value: string | null): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (value === null) store.delete(key);
      else store.put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  }).finally(() => db.close());
}

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Writes the record to both stores. Resolves with what was written where. */
export async function saveRecord(key: string, value: string): Promise<{ localStorage: boolean; indexedDb: boolean }> {
  const ls = lsSet(key, value);
  const idb = await idbPut(key, value);
  // Ask the browser not to evict this site's storage under pressure. Best effort; the answer is not needed.
  void navigator.storage?.persist?.().catch(() => false);
  if (!ls && !idb) throw new Error("This browser would not save the wallet. Check that site storage is allowed, then try again.");
  return { localStorage: ls, indexedDb: idb };
}

/** The record from localStorage (synchronous; call `reconcileRecord` once first). */
export function readRecord(key: string): string | null {
  return lsGet(key);
}

/**
 * Makes the two stores agree: a record only in IndexedDB is copied back to
 * localStorage, and one only in localStorage (wallets saved before IndexedDB
 * was used) is copied to IndexedDB. When both hold different records,
 * localStorage wins (it is written first on every save).
 */
export async function reconcileRecord(key: string): Promise<string | null> {
  const ls = lsGet(key);
  const idb = await idbGet(key);
  if (ls === null && idb !== null) {
    lsSet(key, idb);
    return idb;
  }
  if (ls !== null && idb !== ls) await idbPut(key, ls);
  return ls;
}
