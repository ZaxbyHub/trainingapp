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

import {
  MIGRATION_KEY,
  PROFILE_KEY,
  REINDEX_FLAG_KEY,
  REGISTERED_PROFILES_KEY,
} from './persisted-keys';

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
  /**
   * IndexedDB name for the conversations store (issue #34 item 6p, R3-1):
   * profile-namespaced like every other store, so two operators sharing a
   * workstation never see each other's chat history. Uniform rule — no
   * default-'' special case (getProfilePrefix always holds a random prefix).
   */
  conversations: string;
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
 * Mint a fresh profile prefix (issue #34 item 6p, Settings "new profile"
 * flow): a brand-new namespace, registered by the caller and switched to via
 * profile-switch. Same shape guarantee as getProfilePrefix.
 */
export function newProfilePrefix(): string {
  return mintPrefix();
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
    conversations: `${prefix}-doc-qa-conversations`,
  };
}

/**
 * Pattern matching any legacy per-session namespace's databases. PRR-107
 * (PR #264 review): conversations is included — the per-profile
 * conversations db is a first-class namespace member, so a conversation-only
 * orphan prefix is discoverable (Adopt/Delete) and an orphan Delete removes
 * the chat history it owns.
 */
const ORPHAN_DB_RE = /^([a-z0-9]{3,8})-doc-qa-(documents|indexes|keywords|conversations)$/;

/**
 * One-time, best-effort migration of orphaned per-session databases into the
 * current stable profile namespace. Runs at most once per profile (guarded by
 * a localStorage flag that is set ONLY after a successful attempt on a browser
 * that supports the enumeration API).
 *
 * - Chrome/Edge: `indexedDB.databases()` is available; migration copies the
 *   most-recently-written orphan document set + keyword index into the stable
 *   namespace. The vector index is NOT copied (its WASM blob is not safely
 *   copyable across names); when any documents are migrated, the
 *   `rag-reindex-required` flag is set so the existing one-time re-index notice
 *   surfaces and the user knows to re-add documents for semantic search.
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

  // R3-5/R4-4 (issue #34 item 6p): this automatic merge is RETIRED from the
  // boot path (Settings → Profile data offers the only route to an
  // unregistered namespace: explicit Adopt/Delete). The guard remains for
  // any explicit caller: an UNHEALTHY registry refuses outright (colleagues'
  // namespaces are never eligible for merging on registry corruption), and a
  // REGISTERED profile's namespaces are never merged into another profile.
  const registry = readRegistry();
  if (!registry.healthy) {
    return;
  }
  const registered = new Set(registry.profiles);

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

  // Collect orphan prefixes (any non-current, UNREGISTERED profile prefix).
  const orphanPrefixes = new Set<string>();
  for (const db of dbs) {
    const name = db.name ?? '';
    const match = name.match(ORPHAN_DB_RE);
    if (match && match[1] !== currentPrefix && !registered.has(match[1])) {
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
  let migratedDocCount = 0;
  for (const orphanPrefix of orphanPrefixes) {
    try {
      migratedDocCount += await copyDocumentStore(`${orphanPrefix}-doc-qa-documents`, `${currentPrefix}-doc-qa-documents`);
      await copyKeywordIndex(`${orphanPrefix}-doc-qa-keywords`, `${currentPrefix}-doc-qa-keywords`);
    } catch (error) {
      console.warn(`[profile] Could not migrate orphan namespace ${orphanPrefix}:`, error);
    }
  }

  // PRR-002: the vector index cannot be copied across names, so any migrated
  // documents lack semantic-search vectors. Set the existing re-index flag so
  // the one-time notice tells the user to re-add their documents (rather than
  // silently presenting a corpus that keyword-searches but won't semantic-search).
  if (migratedDocCount > 0) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(REINDEX_FLAG_KEY, '1');
      }
    } catch {
      /* private mode / storage disabled — non-fatal */
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
 * deletes the source. Returns the number of documents copied. Best-effort.
 */
async function copyDocumentStore(sourceDbName: string, targetDbName: string): Promise<number> {
  const docs = await readAllFromStore<{ id: string }>(sourceDbName, 'documents');
  if (docs.length === 0) {
    return 0;
  }
  await mergeIntoStore(targetDbName, 'documents', 'id', docs);
  return docs.length;
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
  // B2/R3-5 (issue #34 item 6p): a REGISTERED colleague profile is never a
  // stale/orphan candidate, and an UNHEALTHY registry yields no deletion
  // candidates at all (fail closed — corruption must not make colleagues'
  // namespaces eligible for deletion).
  const registry = readRegistry();
  if (!registry.healthy) {
    return [];
  }
  const registered = new Set(registry.profiles);
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
      if (match && match[1] !== currentPrefix && !registered.has(match[1])) {
        prefixes.add(match[1]);
      }
    }
    return Array.from(prefixes);
  } catch {
    return [];
  }
}

/**
 * Delete a profile prefix's IndexedDB databases. Best-effort. TWO contracts
 * share this function (reviewer round 2, F1 — they must not be conflated):
 *
 *  - Clear Cache (SettingsPage) calls it for the CURRENT profile and PROMISES
 *    THE USER THE CHAT HISTORY IS KEPT — the default therefore deletes only
 *    the documents, vector-mapping and keyword DBs, never
 *    `{prefix}-doc-qa-conversations`.
 *  - The Settings → Profile data orphan-Delete row calls it with
 *    `includeConversations: true` for an UNREGISTERED namespace the user is
 *    destroying outright — there the conversations db goes with the rest
 *    (PRR-107: an orphan Delete previously left the chat history behind).
 *
 * NOTE (PRR-008): this cannot delete the native EdgeVec HNSW blob for the
 * prefix — that blob
 * is stored as a VALUE keyed by `${prefix}-doc-qa-index` inside the shared
 * `edgevec-db` database (see vite.config.ts IndexedDbBackend stub), not in a
 * per-profile database. Clearing it requires deleting the key from
 * `edgevec-db`'s data store (or deleting `edgevec-db` entirely, which would
 * affect ALL profiles). PR-5's Clear Cache UI must handle the EdgeVec blob
 * separately; deleting only these DBs leaves the vector blob orphaned.
 */
export async function deleteNamespace(
  prefix: string,
  options: { includeConversations?: boolean } = {},
): Promise<void> {
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
    ...(options.includeConversations === true ? [`${prefix}-doc-qa-conversations`] : []),
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

/**
 * ---------------------------------------------------------------------------
 * Profile registry (issue #34 item 6p, plan R4-5/R5-5/R5-9)
 * ---------------------------------------------------------------------------
 * A profile exists for switching purposes only when it is REGISTERED here.
 * Registration is explicit: first boot of an upgraded install
 * (ensureCurrentProfileRegistered), first-run wizard completion, profile
 * switching, or the Settings "Adopt orphan" action. A registered profile is
 * never an automatic-migration or Clear-Cache orphan candidate, so two
 * operators sharing a workstation can never destroy each other's data.
 *
 * The registry is a localStorage JSON array (internal key, preserved by Clear
 * Cache). Discovery never depends on `indexedDB.databases()`, so it works on
 * non-enumerating browsers (Firefox). Unreadable/corrupt registry state is
 * `healthy: false`: every destructive operation that consults the registry
 * REFUSES (fail closed) until the operator explicitly resets it.
 */

export interface RegisteredProfiles {
  profiles: string[];
  /** false = the stored registry was unreadable/corrupt; destructive ops must refuse. */
  healthy: boolean;
}

function isPrefixShape(prefix: unknown): prefix is string {
  return typeof prefix === 'string' && /^[a-z0-9]{3,8}$/.test(prefix);
}

function readRegistry(): RegisteredProfiles {
  let raw: string | null;
  try {
    // Storage unavailable (private mode): treat as healthy-but-empty. The
    // destructive ops that consult the registry ALSO need IndexedDB, which is
    // likewise unavailable there, so nothing becomes deletion-eligible.
    if (typeof localStorage === 'undefined') return { profiles: [], healthy: true };
    raw = localStorage.getItem(REGISTERED_PROFILES_KEY);
  } catch {
    return { profiles: [], healthy: true };
  }
  if (raw === null) {
    return { profiles: [], healthy: true };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { profiles: [], healthy: false };
    }
    const profiles = parsed.filter(isPrefixShape);
    if (profiles.length !== parsed.length) {
      // A malformed entry means the registry was corrupted, not merely empty.
      return { profiles: [], healthy: false };
    }
    return { profiles, healthy: true };
  } catch {
    return { profiles: [], healthy: false };
  }
}

function writeRegistry(profiles: string[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REGISTERED_PROFILES_KEY, JSON.stringify(profiles));
    }
  } catch {
    /* storage write failed (quota/private mode) — registration is best-effort */
  }
}

/** Read the profile registry. See the module block for the fail-closed contract. */
export function listRegisteredProfiles(): RegisteredProfiles {
  return readRegistry();
}

/** True when `prefix` is a registered profile (and the registry is healthy). */
export function isRegisteredProfile(prefix: string): boolean {
  const reg = readRegistry();
  return reg.healthy && reg.profiles.includes(prefix);
}

/**
 * Register `prefix` as a switchable profile. Idempotent. When the registry is
 * unhealthy, registration fails (returns false) — recovery is the explicit
 * Settings reset surface, never a silent repair.
 */
export function registerProfile(prefix: string): boolean {
  if (!isPrefixShape(prefix)) return false;
  const reg = readRegistry();
  if (!reg.healthy) return false;
  if (reg.profiles.includes(prefix)) return true;
  writeRegistry([...reg.profiles, prefix].sort());
  return true;
}

/**
 * Unregister a profile WITHOUT deleting its data (the data becomes an
 * explicit Adopt/Delete row in Settings). Intended for the registry-reset
 * surface. Fails (false) when the registry is unhealthy — reset first.
 */
export function unregisterProfile(prefix: string): boolean {
  const reg = readRegistry();
  if (!reg.healthy) return false;
  if (!reg.profiles.includes(prefix)) return true;
  writeRegistry(reg.profiles.filter((p) => p !== prefix));
  return true;
}

/**
 * Boot-time bootstrap (R4-5): register the current profile when the registry
 * is healthy and the prefix is not yet registered. Never throws; a corrupted
 * registry is left alone (destructive ops refuse until the explicit reset).
 */
export function ensureCurrentProfileRegistered(): void {
  try {
    const reg = readRegistry();
    if (!reg.healthy) return;
    const current = getProfilePrefix();
    if (!reg.profiles.includes(current)) {
      writeRegistry([...reg.profiles, current].sort());
    }
  } catch {
    /* bootstrap is best-effort */
  }
}

/**
 * Reset a corrupted registry (Settings recovery surface): clear the stored
 * registry and re-register ONLY the current profile. Returns false when the
 * registry was actually healthy (reset is not offered for a healthy registry)
 * or when the write failed — the operator sees the error and destructive ops
 * stay refused.
 */
export function resetProfileRegistry(): boolean {
  const reg = readRegistry();
  if (reg.healthy) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    // Unhealthy means the raw value is unusable; removing it entirely is safe.
    localStorage.removeItem(REGISTERED_PROFILES_KEY);
  } catch {
    return false;
  }
  const current = getProfilePrefix();
  writeRegistry([current]);
  return true;
}
