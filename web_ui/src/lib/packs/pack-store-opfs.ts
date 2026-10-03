// pack-store-opfs.ts — origin-private storage for installed packs in the
// browser app, trace browser-training-parity AC7/AC9.
//
// Layout (APP origin only; the untrusted player origin never stores pack
// bytes — ADR-0012):
//   OPFS  trainingapp-packs-<profile>/<packId>/<version>-<nonce>/<entry path>
//   IDB   <profile>-doc-qa-packs, object store 'versions', key '<packId>@<version>'
// A version directory is written completely BEFORE its registry row exists,
// and the active pointer (the `active` flags of one pack id) flips inside ONE
// IndexedDB transaction, so a crash mid-install leaves at most an unreferenced
// directory that the startup orphan sweep removes (OPFS has no atomic rename).
import { getProfilePrefix } from '../storage/profile';

/** One installed pack version (the registry row). */
export interface PackVersionRecord {
  packId: string;
  version: string;
  name: string;
  sourceClass: string;
  publishedAt: string;
  supersedes: string[];
  active: boolean;
  /** Version directory name under the pack directory: '<version>-<nonce>'. */
  dir: string;
  /** Uncompressed bytes written for this version. */
  sizeBytes: number;
  installedAt: string;
  /** Manifest docs[] paths (slide documents) for index cleanup. */
  docPaths: string[];
  /** True once this version's chunks are in the vector index (resumable embedding). */
  embedded?: boolean;
}

// --------------------------------------------------------------------- //
// registry
// --------------------------------------------------------------------- //

export interface PackRegistry {
  list(): Promise<PackVersionRecord[]>;
  /**
   * Apply `puts` and `deletes` in ONE atomic transaction (the active-pointer
   * flip): either every change lands or none does.
   */
  commit(puts: PackVersionRecord[], deletes: Array<{ packId: string; version: string }>): Promise<void>;
  clear(): Promise<void>;
}

const keyOf = (packId: string, version: string): string => `${packId}@${version}`;

export function packRegistryDbName(): string {
  return `${getProfilePrefix()}-doc-qa-packs`;
}

const STORE = 'versions';

function openRegistryDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      // v1 is the only schema, so this is a fresh-create only (as in the other
      // web_ui IndexedDB stores, none of which has a ladder yet). Bumping the
      // version to 2 MUST add a migration ladder here keyed on
      // event.oldVersion: installed pack registries in the field are at v1 and
      // must be carried forward, not recreated empty (PR 144 review F11).
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('pack registry: indexedDB.open failed'));
    request.onblocked = () => reject(new Error('pack registry: database upgrade blocked by another tab'));
  });
}

/** The production registry (IndexedDB, app origin). */
export class IndexedDbPackRegistry implements PackRegistry {
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** The database name is resolved on first use (the profile prefix lives in localStorage). */
  constructor(private readonly dbName?: string) {}

  private db(): Promise<IDBDatabase> {
    if (this.dbPromise === null) {
      this.dbPromise = openRegistryDb(this.dbName ?? packRegistryDbName()).catch((error: unknown) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  async list(): Promise<PackVersionRecord[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as PackVersionRecord[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  async commit(puts: PackVersionRecord[], deletes: Array<{ packId: string; version: string }>): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const record of puts) store.put(record, keyOf(record.packId, record.version));
      for (const key of deletes) store.delete(keyOf(key.packId, key.version));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('pack registry transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('pack registry transaction aborted'));
    });
  }

  async clear(): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** In-memory registry with the same atomic-commit contract (tests). */
export class MemoryPackRegistry implements PackRegistry {
  private rows = new Map<string, PackVersionRecord>();
  async list(): Promise<PackVersionRecord[]> {
    return [...this.rows.values()].map((r) => ({ ...r, supersedes: [...r.supersedes], docPaths: [...r.docPaths] }));
  }
  async commit(puts: PackVersionRecord[], deletes: Array<{ packId: string; version: string }>): Promise<void> {
    const next = new Map(this.rows);
    for (const record of puts) next.set(keyOf(record.packId, record.version), { ...record });
    for (const key of deletes) next.delete(keyOf(key.packId, key.version));
    this.rows = next;
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
}

// --------------------------------------------------------------------- //
// file storage
// --------------------------------------------------------------------- //

/** Writer for one file of a version directory. */
export interface PackFileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface PackFileStore {
  /** Create (or truncate) `<packId>/<dir>/<segments...>` and return a writer. */
  createFile(packId: string, dir: string, segments: readonly string[]): Promise<PackFileWriter>;
  /** The bytes of `<packId>/<dir>/<segments...>`, or null when absent. */
  readFile(packId: string, dir: string, segments: readonly string[]): Promise<Blob | null>;
  /** Remove a version directory recursively (absent is fine). */
  removeVersionDir(packId: string, dir: string): Promise<void>;
  /** Pack id -> version directory names currently on storage. */
  listVersionDirs(): Promise<Map<string, string[]>>;
  /** Remove everything (Clear Cache). */
  clear(): Promise<void>;
}

export function packFilesRootName(): string {
  return `trainingapp-packs-${getProfilePrefix()}`;
}

/** The production store: Origin Private File System of the APP origin. */
export class OpfsPackFileStore implements PackFileStore {
  /** The root directory name is resolved on first use (profile prefix). */
  constructor(private readonly rootNameOverride?: string) {}

  private get rootName(): string {
    return this.rootNameOverride ?? packFilesRootName();
  }

  private async root(): Promise<FileSystemDirectoryHandle> {
    const origin = await navigator.storage.getDirectory();
    return origin.getDirectoryHandle(this.rootName, { create: true });
  }

  private async dirFor(packId: string, dir: string, segments: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let handle = await (await this.root()).getDirectoryHandle(packId, { create });
    handle = await handle.getDirectoryHandle(dir, { create });
    for (const segment of segments) handle = await handle.getDirectoryHandle(segment, { create });
    return handle;
  }

  async createFile(packId: string, dir: string, segments: readonly string[]): Promise<PackFileWriter> {
    const parent = await this.dirFor(packId, dir, segments.slice(0, -1), true);
    const file = await parent.getFileHandle(segments[segments.length - 1]!, { create: true });
    const writable = await file.createWritable({ keepExistingData: false });
    return {
      write: async (chunk) => {
        await writable.write(chunk as unknown as FileSystemWriteChunkType);
      },
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }

  async readFile(packId: string, dir: string, segments: readonly string[]): Promise<Blob | null> {
    try {
      const parent = await this.dirFor(packId, dir, segments.slice(0, -1), false);
      const handle = await parent.getFileHandle(segments[segments.length - 1]!, { create: false });
      return await handle.getFile();
    } catch {
      return null;
    }
  }

  async removeVersionDir(packId: string, dir: string): Promise<void> {
    try {
      const packDir = await (await this.root()).getDirectoryHandle(packId, { create: false });
      await packDir.removeEntry(dir, { recursive: true });
    } catch (error) {
      if ((error as DOMException)?.name !== 'NotFoundError') throw error;
    }
  }

  async listVersionDirs(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const root = await this.root();
    for await (const [packId, handle] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== 'directory') continue;
      const dirs: string[] = [];
      for await (const [name, child] of (handle as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (child.kind === 'directory') dirs.push(name);
      }
      out.set(packId, dirs);
    }
    return out;
  }

  async clear(): Promise<void> {
    try {
      const origin = await navigator.storage.getDirectory();
      await origin.removeEntry(this.rootName, { recursive: true });
    } catch (error) {
      if ((error as DOMException)?.name !== 'NotFoundError') throw error;
    }
  }
}

/** In-memory file store (tests). */
export class MemoryPackFileStore implements PackFileStore {
  readonly files = new Map<string, Uint8Array>();
  private path(packId: string, dir: string, segments: readonly string[]): string {
    return [packId, dir, ...segments].join('/');
  }
  async createFile(packId: string, dir: string, segments: readonly string[]): Promise<PackFileWriter> {
    const key = this.path(packId, dir, segments);
    const chunks: Uint8Array[] = [];
    return {
      write: async (chunk) => {
        chunks.push(chunk.slice());
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        this.files.set(key, out);
      },
      abort: async () => undefined,
    };
  }
  async readFile(packId: string, dir: string, segments: readonly string[]): Promise<Blob | null> {
    const bytes = this.files.get(this.path(packId, dir, segments));
    return bytes === undefined ? null : new Blob([bytes.slice()]);
  }
  async removeVersionDir(packId: string, dir: string): Promise<void> {
    const prefix = `${packId}/${dir}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }
  async listVersionDirs(): Promise<Map<string, string[]>> {
    const out = new Map<string, Set<string>>();
    for (const key of this.files.keys()) {
      const [packId, dir] = key.split('/');
      if (packId === undefined || dir === undefined) continue;
      if (!out.has(packId)) out.set(packId, new Set());
      out.get(packId)!.add(dir);
    }
    return new Map([...out.entries()].map(([k, v]) => [k, [...v]]));
  }
  async clear(): Promise<void> {
    this.files.clear();
  }
}

// --------------------------------------------------------------------- //
// cross-tab single flight
// --------------------------------------------------------------------- //

const localChains = new Map<string, Promise<unknown>>();

/**
 * Run `work` while holding the named lock: Web Locks across tabs when the
 * browser has them, else an in-tab promise chain (same ordering guarantee
 * inside the tab).
 */
export function withPackLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined) ?? undefined;
  if (locks !== undefined && typeof locks.request === 'function') {
    return locks.request(name, { mode: 'exclusive' }, () => work()) as Promise<T>;
  }
  const previous = localChains.get(name) ?? Promise.resolve();
  const next = previous.then(work, work);
  localChains.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}
