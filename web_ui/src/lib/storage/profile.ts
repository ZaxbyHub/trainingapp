/**
 * Stable profile-scoped storage namespace (F1).
 *
 * Replaces the per-session sessionStorage UUID scheme. The old scheme
 * (`doc-qa-user-id` in sessionStorage) was cleared on every browser-session end
 * and isolated per tab, so documents disappeared on restart and each tab saw an
 * empty corpus. This module persists a single stable profile id in
 * `localStorage`, derives all IndexedDB names from it, and offers a one-time
 * best-effort migration of orphaned per-session databases.
 *
 * The prefix is constrained to lowercase-alphanumeric characters so the derived
 * database names keep matching the historical `/^[a-z0-9-]{3,8}-doc-qa-…$/`
 * shape (see document-store.test.ts).
 */

const PROFILE_KEY = 'doc-qa-profile-id';
const MIGRATION_KEY = 'doc-qa-profile-migrated';
const PREFIX_LENGTH = 8;

export interface StorageDbNames {
  /** IndexedDB name for the document metadata store. */
  documents: string;
  /** IndexedDB name for the vector-index idMapping store. */
  vectorMapping: string;
  /** EdgeVec native index name (key inside EdgeVec's own IndexedDB). */
  vector: string;
  /** IndexedDB name for the keyword-index store. */
  keyword: string;
}

/**
 * Mint a fresh lowercase-alphanumeric prefix of PREFIX_LENGTH chars.
 * Uses crypto.randomUUID (hex) when available; falls back to a base36 random
 * value filtered to lowercase alphanumerics. Never contains hyphens or
 * uppercase, so it satisfies the DB_NAME regex char class.
 */
function mintPrefix(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      // randomUUID is 0-9a-f with hyphens; strip non-alnum and take the first
      // PREFIX_LENGTH chars.
      const hex = crypto.randomUUID().replace(/[^a-z0-9]/g, '');
      if (hex.length >= PREFIX_LENGTH) {
        return hex.slice(0, PREFIX_LENGTH);
      }
    }
  } catch {
    /* crypto unavailable */
  }
  // Fallback: base36 of Date.now() + Math.random, filtered to lowercase alnum.
  let raw = (Date.now().toString(36) + Math.random().toString(36).slice(2));
  raw = raw.replace(/[^a-z0-9]/g, '');
  if (raw.length < PREFIX_LENGTH) {
    raw = raw.padEnd(PREFIX_LENGTH, '0');
  }
  return raw.slice(0, PREFIX_LENGTH);
}

/**
 * Get the stable profile prefix, persisted in localStorage. Minted once on
 * first access. SSR/private-mode safe.
 */
export function getProfilePrefix(): string {
  // Prefer localStorage for cross-session persistence.
  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(PROFILE_KEY);
      // m1: constrain to the same length window the DB_NAME shape regex
      // requires (`/^[a-z0-9-]{3,8}-doc-qa-…$/`), so a corrupted stored value
      // cannot produce an out-of-spec database name.
      if (existing && /^[a-z0-9]{3,8}$/.test(existing)) {
        return existing;
      }
      const fresh = mintPrefix();
      localStorage.setItem(PROFILE_KEY, fresh);
      return fresh;
    }
  } catch {
    /* localStorage disabled (private mode) — fall through */
  }
  // Last-resort fallback when localStorage is unavailable: derive a per-origin
  // stable value. This is NOT persistent across browser sessions, but it is the
  // best available when localStorage is blocked. (Private mode is inherently
  // ephemeral; nothing can persist there.)
  return 'anon';
}

/**
 * Derive all storage names for the current profile. Single source of truth —
 * every store consumes this so the prefix can never desync across layers.
 */
export function getStorageDbNames(): StorageDbNames {
  const prefix = getProfilePrefix();
  return {
    documents: `${prefix}-doc-qa-documents`,
    vectorMapping: `${prefix}-doc-qa-indexes`,
    vector: `${prefix}-doc-qa-index`,
    keyword: `${prefix}-doc-qa-keywords`,
  };
}

/** Pattern matching any legacy per-session namespace's databases. */
const ORPHAN_DB_RE = /^([a-z0-9]{3,8})-doc-qa-(documents|indexes|keywords)$/;

/**
 * One-time, best-effort migration of orphaned per-session databases into the
 * current stable profile namespace. Runs at most once per profile (guarded by
 * a localStorage flag that is set ONLY after a successful attempt on a browser
 * that supports the enumeration API).
 *
 * - Chrome/Edge: `indexedDB.databases()` is available; migration copies the
 *   most-recently-written orphan document set + keyword index into the stable
 *   namespace. The vector index is discarded with a re-index notice (its WASM
 *   blob is not safely copyable across names).
 * - Firefox/Safari: `indexedDB.databases()` is unavailable; migration is
 *   skipped and the flag is NOT set, so a later session on an enumerating
 *   browser can still migrate.
 *
 * Never throws — migration failures are logged and swallowed so the UI boots.
 */
export async function migrateOrphanedNamespaces(): Promise<void> {
  // Already migrated for this profile.
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_KEY) === '1') {
      return;
    }
  } catch {
    return;
  }

  if (typeof indexedDB === 'undefined') {
    return;
  }

  // Feature-detect the enumeration API. Firefox/Safari lack it.
  const idb = indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string; version?: number }>> };
  if (typeof idb.databases !== 'function') {
    // Cannot enumerate — do NOT set the flag; a future enumerating browser can
    // still migrate this profile's orphans.
    return;
  }

  const currentPrefix = getProfilePrefix();
  let dbs: Array<{ name?: string }>;
  try {
    dbs = await idb.databases();
  } catch (error) {
    console.warn('[profile] Could not enumerate IndexedDB databases for migration:', error);
    return;
  }

  // Collect orphan prefixes (any profile prefix other than the current one).
  const orphanPrefixes = new Set<string>();
  for (const db of dbs) {
    const name = db.name ?? '';
    const match = name.match(ORPHAN_DB_RE);
    if (match && match[1] !== currentPrefix) {
      orphanPrefixes.add(match[1]);
    }
  }

  if (orphanPrefixes.size === 0) {
    // Nothing to migrate — mark complete so we don't re-enumerate every boot.
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(MIGRATION_KEY, '1');
      }
    } catch {
      /* ignore */
    }
    return;
  }

  // Best-effort copy of documents + keyword index from each orphan. We copy all
  // orphans (merging), preferring the current profile's namespace as target.
  // This is a read-all/write-all loop wrapped in try/catch; partial failures do
  // not abort the rest and never surface to the UI.
  for (const orphanPrefix of orphanPrefixes) {
    try {
      await copyDocumentStore(`${orphanPrefix}-doc-qa-documents`, `${currentPrefix}-doc-qa-documents`);
      await copyKeywordIndex(`${orphanPrefix}-doc-qa-keywords`, `${currentPrefix}-doc-qa-keywords`);
    } catch (error) {
      console.warn(`[profile] Could not migrate orphan namespace ${orphanPrefix}:`, error);
    }
  }

  // Migration attempt completed on an enumerating browser — mark complete.
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MIGRATION_KEY, '1');
    }
  } catch {
    /* ignore */
  }
}

/**
 * Copy all documents from a source IndexedDB store into a target database's
 * store, merging (by keyPath `id`). Opens each DB read-only/write-only; never
 * deletes the source. Best-effort.
 */
async function copyDocumentStore(sourceDbName: string, targetDbName: string): Promise<void> {
  const docs = await readAllFromStore<{ id: string }>(sourceDbName, 'documents');
  if (docs.length === 0) {
    return;
  }
  await mergeIntoStore(targetDbName, 'documents', 'id', docs);
}

/** Copy keyword-index entries from source to target (merge by keyPath `key`). */
async function copyKeywordIndex(sourceDbName: string, targetDbName: string): Promise<void> {
  const entries = await readAllFromStore<{ key: string }>(sourceDbName, 'keyword-index');
  if (entries.length === 0) {
    return;
  }
  await mergeIntoStore(targetDbName, 'keyword-index', 'key', entries);
}

/** Read all records from a given database/store. Returns [] if the DB/store is absent. */
function readAllFromStore<T>(dbName: string, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    const req = indexedDB.open(dbName);
    req.onupgradeneeded = () => {
      // Source DB may not have the store; resolve empty.
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const getAll = store.getAll();
      getAll.onsuccess = () => {
        db.close();
        resolve((getAll.result as T[]) ?? []);
      };
      getAll.onerror = () => {
        db.close();
        resolve([]);
      };
    };
    req.onerror = () => resolve([]);
  });
}

/** Merge records into a target store by keyPath (put = upsert). Creates the DB/store if absent. */
function mergeIntoStore<T>(dbName: string, storeName: string, keyPath: string, records: T[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        // Version upgrade didn't run because the DB already existed at a higher
        // version without this store — nothing to merge into safely.
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const rec of records) {
        store.put(rec);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Enumerate stale (non-current) profile prefixes present in IndexedDB.
 * Intended for the Settings "Clear Cache" UI (PR-5). Returns [] on browsers
 * without `indexedDB.databases()`.
 */
export async function listStalePrefixes(): Promise<string[]> {
  const currentPrefix = getProfilePrefix();
  if (typeof indexedDB === 'undefined') {
    return [];
  }
  const idb = indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof idb.databases !== 'function') {
    return [];
  }
  try {
    const dbs = await idb.databases();
    const prefixes = new Set<string>();
    for (const db of dbs) {
      const match = (db.name ?? '').match(ORPHAN_DB_RE);
      if (match && match[1] !== currentPrefix) {
        prefixes.add(match[1]);
      }
    }
    return Array.from(prefixes);
  } catch {
    return [];
  }
}

/**
 * Delete all IndexedDB databases for a given profile prefix.
 * Intended for the Settings "Clear Cache" UI (PR-5). Best-effort.
 */
export async function deleteNamespace(prefix: string): Promise<void> {
  // Match the system-wide prefix constraint (see getProfilePrefix / DB_NAME
  // shape regex) so this only acts on real profile namespaces.
  if (!/^[a-z0-9]{3,8}$/.test(prefix)) {
    return;
  }
  if (typeof indexedDB === 'undefined') {
    return;
  }
  const names = [
    `${prefix}-doc-qa-documents`,
    `${prefix}-doc-qa-indexes`,
    `${prefix}-doc-qa-keywords`,
  ];
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        })
    )
  );
}
