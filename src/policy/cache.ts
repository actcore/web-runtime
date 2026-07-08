import type { Verdict } from './types.js';

// Deliberately a SEPARATE database from `actcore-host` (see ../cache.ts). That
// database is opened at version 1 by the transpile cache; bumping its version
// here would fire `onupgradeneeded` for every consumer, and any tab that still
// has an old open connection (or any code path that opens it at version 1
// after this module has upgraded it) hits a `VersionError` and silently loses
// the transpile cache — forcing a full re-transpile of a possibly 100MB+
// component on every load. Keeping the decision cache in its own database
// avoids that coupling entirely.
const DB_NAME = 'actcore-policy';
const STORE = 'decision-cache';
const DB_VERSION = 1;

type Remembered = Record<string, 'allow' | 'deny'>;

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

/**
 * Memoizes `(capId, key, action) → allow|deny` so a repeated access does not
 * re-prompt. `session` lives for the instance; `always` persists to IndexedDB
 * (in the `actcore-policy` database — see the note above) keyed by
 * `origin+ref+digest`; `once` is never stored.
 */
export class DecisionCache {
  #mem: Remembered = {};
  #durable: Remembered = {};
  #scopeKey: string;
  #persist: 'local' | 'session' | 'none';

  constructor(scopeKey: string, persist: 'local' | 'session' | 'none') {
    this.#scopeKey = scopeKey;
    this.#persist = persist;
  }

  get(opKey: string): 'allow' | 'deny' | undefined {
    return this.#mem[opKey];
  }

  put(opKey: string, verdict: Verdict): void {
    if (verdict.remember === 'once') return;
    const d: 'allow' | 'deny' = verdict.allow ? 'allow' : 'deny';
    this.#mem[opKey] = d;
    if (verdict.remember === 'always' && this.#persist === 'local') {
      this.#durable[opKey] = d;
      void this.#persistAll();
    }
  }

  /** Pure: given the currently-stored record, compute the record to write back.
   *  Read-modify-write — preserves prior persisted entries, excludes session-scoped ones. */
  persistPayload(stored: Remembered): Remembered {
    return { ...stored, ...this.#durable };
  }

  async loadPersisted(): Promise<void> {
    if (this.#persist !== 'local' || !idbAvailable()) return;
    try {
      const db = await openDb();
      try {
        const record = await new Promise<Remembered | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const r = tx.objectStore(STORE).get(this.#scopeKey);
          r.onsuccess = () => resolve(r.result as Remembered | undefined);
          r.onerror = () => reject(r.error ?? new Error('cache get failed'));
        });
        if (record) this.#mem = { ...record, ...this.#mem };
      } finally {
        db.close();
      }
    } catch {
      /* persistence is best-effort */
    }
  }

  async #persistAll(): Promise<void> {
    if (!idbAvailable()) return;
    try {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          const r = store.get(this.#scopeKey);
          r.onsuccess = () => {
            const stored = (r.result as Remembered | undefined) ?? {};
            store.put(this.persistPayload(stored), this.#scopeKey);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('cache put failed'));
          tx.onabort = () => reject(tx.error ?? new Error('cache put aborted'));
        });
      } finally {
        db.close();
      }
    } catch {
      /* ignore — cache write must not break a run */
    }
  }
}
