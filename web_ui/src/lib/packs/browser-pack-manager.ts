// browser-pack-manager.ts — the browser app's pack lifecycle (install,
// list, rollback, remove, storage report), trace browser-training-parity
// AC1/AC2/AC7/AC9. The desktop twin is PackManager
// (desktop/main/backend/store/pack-manager.ts); semantics and refusal text
// follow it:
//   * install runs every archive guard (pack-extract-browser.ts) and every
//     manifest gate (pack-manifest.ts, incl. the opt-in signature policy)
//     BEFORE a byte is written, refuses downgrades and same-version
//     reinstalls of the active version, supersedes the previously active
//     version (kept for rollback), and honors manifest `supersedes`;
//   * rollback re-activates a retained version; remove deletes a version's
//     files and its index rows (no other version is auto-activated).
// Browser-specific: files live in the APP origin's OPFS
// (pack-store-opfs.ts), every lifecycle operation is single-flight per pack
// id across tabs (Web Locks), an install is refused BEFORE storing when the
// app page's navigator.storage.estimate() cannot hold about twice the pack's
// unpacked size (the previous version is retained for rollback), and
// persistent storage is requested on install.
import type { InstallPackResult, PackInfo } from '../api/types';
import { PackManagerError, openPackArchive, sourceFromBlob, type ArchiveFileEntry } from './pack-extract-browser';
import { compareVersions, parseManifest, validateManifestGates, type ManifestGateConfig, type PackManifest } from './pack-manifest';
import { packGateConfig } from './pack-policy';
import {
  IndexedDbPackRegistry,
  OpfsPackFileStore,
  withPackLock,
  type PackFileStore,
  type PackRegistry,
  type PackVersionRecord,
} from './pack-store-opfs';

/** Storage headroom factor: the new version plus the retained previous one. */
export const QUOTA_HEADROOM_FACTOR = 2;

export interface StorageReport {
  usage: number;
  quota: number;
  available: number;
  persisted: boolean | null;
}

/** Hooks the manager calls after a committed install / removal (search-index ingestion, AC6). */
export interface PackIndexHooks {
  onInstalled(record: PackVersionRecord, manifest: PackManifest, docs: Map<string, Uint8Array>): Promise<void>;
  onRemoved(records: PackVersionRecord[]): Promise<void>;
  onActivated?(record: PackVersionRecord): Promise<void>;
}

export interface BrowserPackManagerDeps {
  registry: PackRegistry;
  files: PackFileStore;
  gateConfig?: () => ManifestGateConfig;
  hooks?: PackIndexHooks;
  /** navigator.storage in the APP page (stubbable). */
  storage?: Pick<StorageManager, 'estimate'> & Partial<Pick<StorageManager, 'persist' | 'persisted'>>;
  now?: () => Date;
  nonce?: () => string;
  /** Missing browser capabilities (default: missingPackCapabilities). */
  capabilities?: () => string[];
}

export type PackChangeListener = () => void;

/** Browser features a pack install needs; returns the missing ones. */
export function missingPackCapabilities(): string[] {
  const missing: string[] = [];
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') missing.push('Origin Private File System');
  if (typeof DecompressionStream === 'undefined') missing.push('DecompressionStream');
  if (typeof crypto === 'undefined' || typeof crypto.subtle?.importKey !== 'function') missing.push('Web Crypto');
  if (typeof indexedDB === 'undefined') missing.push('IndexedDB');
  return missing;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class BrowserPackManager {
  private readonly listeners = new Set<PackChangeListener>();
  private gcDone: Promise<void> | null = null;

  constructor(private readonly deps: BrowserPackManagerDeps) {}

  /** Subscribe to registry changes (install/rollback/remove in this tab). */
  subscribe(listener: PackChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* a listener failure never breaks a committed operation */
      }
    }
  }

  private gate(): ManifestGateConfig {
    return (this.deps.gateConfig ?? packGateConfig)();
  }

  /**
   * Startup sweep: remove version directories no registry row references
   * (a tab that died mid-install). Runs per pack under that pack's lock, so
   * it never races an install in another tab.
   */
  collectOrphans(): Promise<void> {
    if (this.missingCapabilities().length > 0) return Promise.resolve();
    if (this.gcDone === null) {
      this.gcDone = (async () => {
        const onDisk = await this.deps.files.listVersionDirs();
        for (const [packId, dirs] of onDisk) {
          await withPackLock(`pack:${packId}`, async () => {
            const referenced = new Set((await this.deps.registry.list()).filter((r) => r.packId === packId).map((r) => r.dir));
            for (const dir of dirs) if (!referenced.has(dir)) await this.deps.files.removeVersionDir(packId, dir);
          });
        }
      })().catch((error: unknown) => {
        this.gcDone = null;
        console.warn('[packs] orphan sweep failed:', error);
      });
    }
    return this.gcDone;
  }

  /** Browser features a pack install needs that this browser lacks. */
  missingCapabilities(): string[] {
    return (this.deps.capabilities ?? missingPackCapabilities)();
  }

  /** A browser without the pack runtime has no installed packs (nothing could have been stored). */
  async listPacks(): Promise<PackInfo[]> {
    if (this.missingCapabilities().length > 0) return [];
    const rows = await this.deps.registry.list();
    return rows
      .sort((a, b) => (a.packId === b.packId ? compareVersions(a.version, b.version) : a.packId.localeCompare(b.packId)))
      .map((r) => ({
        packId: r.packId,
        version: r.version,
        name: r.name,
        sourceClass: r.sourceClass,
        publishedAt: r.publishedAt,
        active: r.active,
        supersedes: [...r.supersedes],
      }));
  }

  /** The active version record of a pack, or null. */
  async activeVersion(packId: string): Promise<PackVersionRecord | null> {
    return (await this.deps.registry.list()).find((r) => r.packId === packId && r.active) ?? null;
  }

  /** Read one file of a specific installed version (index rebuild after rollback). */
  async readVersionFile(record: Pick<PackVersionRecord, 'packId' | 'dir'>, segments: readonly string[]): Promise<Uint8Array | null> {
    const blob = await this.deps.files.readFile(record.packId, record.dir, segments);
    return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
  }

  /** Record that a version's chunks are in the vector index (resumable embedding). */
  async markEmbedded(packId: string, version: string, embedded: boolean): Promise<void> {
    await withPackLock(`pack:${packId}`, async () => {
      const row = (await this.deps.registry.list()).find((r) => r.packId === packId && r.version === version);
      if (row !== undefined && row.embedded !== embedded) await this.deps.registry.commit([{ ...row, embedded }], []);
    });
  }

  /** Active versions whose chunks still await the embedding model. */
  async pendingEmbeddings(): Promise<PackVersionRecord[]> {
    if (this.missingCapabilities().length > 0) return [];
    return (await this.deps.registry.list()).filter((r) => r.active && r.embedded !== true);
  }

  /** Read one file of a pack's ACTIVE version (the player relay's only read path). */
  async readActiveFile(packId: string, segments: readonly string[]): Promise<Blob | null> {
    const record = await this.activeVersion(packId);
    if (record === null) return null;
    return this.deps.files.readFile(packId, record.dir, ['assets', 'player', ...segments]);
  }

  async storageReport(): Promise<StorageReport> {
    const storage = this.deps.storage ?? navigator.storage;
    const estimate = await storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    let persisted: boolean | null = null;
    try {
      persisted = typeof storage.persisted === 'function' ? await storage.persisted() : null;
    } catch {
      persisted = null;
    }
    return { usage, quota, available: Math.max(0, quota - usage), persisted };
  }

  /** Install a pack zip picked by the user (or a verified update artifact). */
  async installPack(file: Blob & { name: string }): Promise<InstallPackResult> {
    const missing = this.missingCapabilities();
    if (missing.length > 0) {
      throw new PackManagerError(
        `this browser cannot install training packs (missing ${missing.join(', ')}); use a current Chrome or Edge, or the desktop app (Safari is not supported)`,
      );
    }
    const filename = file.name;
    // 1. Archive guards (pre-decompression) + pack.json + manifest gates.
    const archive = await openPackArchive(sourceFromBlob(file), filename);
    const raw = await archive.readEntry(archive.manifestEntry);
    const manifest = parseManifest(raw, filename);
    const byPath = new Map<string, ArchiveFileEntry>(archive.files.map((entry) => [entry.segments.join('/'), entry]));
    const docs = await validateManifestGates(
      manifest,
      raw,
      filename,
      async (docPath) => {
        const entry = byPath.get(docPath.split('/').filter((s) => s.length > 0).join('/'));
        return entry === undefined ? null : archive.readEntry(entry);
      },
      this.gate(),
    );

    // 2. Quota: refuse BEFORE storing anything (estimate read in this page).
    const declaredBytes = archive.files.reduce((n, entry) => n + entry.uncompressedSize, 0);
    const report = await this.storageReport();
    const needed = declaredBytes * QUOTA_HEADROOM_FACTOR;
    if (needed > report.available) {
      throw new PackManagerError(
        `${filename}: not enough browser storage for this pack: it needs about ${formatMb(needed)} (twice its ${formatMb(declaredBytes)} unpacked size, so the previous version can be kept for rollback) but only ${formatMb(report.available)} is available`,
      );
    }
    void this.requestPersistence();

    // 3. Lifecycle under the per-pack lock (single flight across tabs).
    const result = await withPackLock(`pack:${manifest.id}`, async () => {
      const rows = await this.deps.registry.list();
      const ownActive = rows.filter((r) => r.packId === manifest.id && r.active);
      for (const active of ownActive) {
        const order = compareVersions(manifest.version, active.version);
        if (order < 0) {
          throw new PackManagerError(`refusing downgrade of ${manifest.id}: ${active.version} is installed and active; use rollback`);
        }
        if (order === 0) {
          throw new PackManagerError(`${manifest.id}@${manifest.version} is already installed and active; remove it first`);
        }
      }
      const dir = `${manifest.version}-${(this.deps.nonce ?? randomNonce)()}`;
      try {
        for (const entry of archive.files) {
          const writer = await this.deps.files.createFile(manifest.id, dir, entry.segments);
          try {
            await archive.pipeEntry(entry, (chunk) => writer.write(chunk));
            await writer.close();
          } catch (error) {
            await writer.abort().catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        await this.deps.files.removeVersionDir(manifest.id, dir).catch(() => undefined);
        if (error instanceof PackManagerError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new PackManagerError(
          /quota/i.test(message)
            ? `${filename}: not enough browser storage while installing: ${message}`
            : `${filename}: extraction failed: ${message}`,
        );
      }

      const replaced = rows.find((r) => r.packId === manifest.id && r.version === manifest.version) ?? null;
      const outgoing = [...ownActive];
      for (const target of manifest.supersedes ?? []) {
        const at = target.indexOf('@');
        const row = rows.find((r) => r.packId === target.slice(0, at) && r.version === target.slice(at + 1));
        if (row !== undefined && row.active && !outgoing.includes(row)) outgoing.push(row);
      }
      const record: PackVersionRecord = {
        packId: manifest.id,
        version: manifest.version,
        name: manifest.name,
        sourceClass: manifest.source_class,
        publishedAt: manifest.published_at,
        supersedes: [...(manifest.supersedes ?? [])],
        active: true,
        dir,
        sizeBytes: archive.writtenBytes(),
        installedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        docPaths: manifest.docs.map((d) => d.path),
      };
      try {
        // The atomic pointer flip: new row active + every outgoing row inactive, one transaction.
        await this.deps.registry.commit([record, ...outgoing.map((r) => ({ ...r, active: false }))], []);
      } catch (error) {
        await this.deps.files.removeVersionDir(manifest.id, dir).catch(() => undefined);
        throw new PackManagerError(
          `${filename}: could not record the installed pack: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (replaced !== null && replaced.dir !== dir) {
        await this.deps.files.removeVersionDir(manifest.id, replaced.dir).catch(() => undefined);
      }
      if (outgoing.length > 0) await this.deps.hooks?.onRemoved(outgoing).catch(() => undefined);
      return record;
    });

    try {
      await this.deps.hooks?.onInstalled(result, manifest, docs);
    } catch (error) {
      // Indexing is best-effort: the pack is installed and plays; retrieval
      // simply lacks its slide docs until a re-install.
      console.warn(`[packs] indexing ${result.packId}@${result.version} failed:`, error);
    }
    this.notify();
    return { packId: result.packId, version: result.version };
  }

  async rollbackPack(packId: string, toVersion: string): Promise<void> {
    await withPackLock(`pack:${packId}`, async () => {
      const rows = await this.deps.registry.list();
      const target = rows.find((r) => r.packId === packId && r.version === toVersion);
      if (target === undefined) throw new PackManagerError(`${packId}@${toVersion} is not installed`);
      if (target.active) throw new PackManagerError(`${packId}@${toVersion} is already the active version`);
      const actives = rows.filter((r) => r.packId === packId && r.active);
      await this.deps.registry.commit([{ ...target, active: true }, ...actives.map((r) => ({ ...r, active: false }))], []);
      if (actives.length > 0) await this.deps.hooks?.onRemoved(actives).catch(() => undefined);
      await this.deps.hooks?.onActivated?.({ ...target, active: true }).catch(() => undefined);
    });
    this.notify();
  }

  async removePack(packId: string, version?: string): Promise<number> {
    const removed = await withPackLock(`pack:${packId}`, async () => {
      const rows = (await this.deps.registry.list()).filter(
        (r) => r.packId === packId && (version === undefined || r.version === version),
      );
      if (rows.length === 0) {
        throw new PackManagerError(`nothing installed matches ${packId}${version === undefined ? '' : `@${version}`}`);
      }
      // Registry first: once the rows are gone nothing can serve the files,
      // and a failed directory removal is collected by the orphan sweep.
      await this.deps.registry.commit([], rows.map((r) => ({ packId: r.packId, version: r.version })));
      for (const row of rows) await this.deps.files.removeVersionDir(row.packId, row.dir).catch(() => undefined);
      // Only the ACTIVE version's documents are in the search indexes (doc
      // ids are version-independent), so removing a superseded version must
      // not unindex the active one's slides.
      const activeRemoved = rows.filter((r) => r.active);
      if (activeRemoved.length > 0) await this.deps.hooks?.onRemoved(activeRemoved).catch(() => undefined);
      return rows.length;
    });
    this.notify();
    return removed;
  }

  /** Ask the browser to keep pack storage (surfaced in the Packs panel). */
  async requestPersistence(): Promise<boolean | null> {
    const storage = this.deps.storage ?? (typeof navigator !== 'undefined' ? navigator.storage : undefined);
    try {
      return typeof storage?.persist === 'function' ? await storage.persist() : null;
    } catch {
      return null;
    }
  }

  /** Remove every pack and the registry (Clear Cache). */
  async clearAll(): Promise<void> {
    // A browser without the pack runtime never stored packs.
    if (this.missingCapabilities().length > 0) return;
    const rows = await this.deps.registry.list();
    await this.deps.registry.clear();
    await this.deps.files.clear();
    if (rows.length > 0) await this.deps.hooks?.onRemoved(rows).catch(() => undefined);
    this.notify();
  }
}

let singleton: BrowserPackManager | null = null;

/** Parse a version's stored pack.json and read its manifest docs back from storage. */
async function storedVersionDocs(
  manager: BrowserPackManager,
  record: PackVersionRecord,
): Promise<{ manifest: PackManifest; docs: Map<string, Uint8Array> } | null> {
  const raw = await manager.readVersionFile(record, ['pack.json']);
  if (raw === null) return null;
  const manifest = parseManifest(raw, `${record.packId}@${record.version}`);
  const docs = new Map<string, Uint8Array>();
  for (const entry of manifest.docs) {
    const bytes = await manager.readVersionFile(record, entry.path.split('/').filter((segment) => segment.length > 0));
    if (bytes !== null) docs.set(entry.path, bytes);
  }
  return { manifest, docs };
}

/**
 * Embed the chunks of every active version still marked pending (the model
 * was not ready at install time). Called after an install and on the app's
 * 'embedding-service-ready' event; each version is marked once embedded, so
 * the work resumes after a reload.
 */
export async function embedPendingPackChunks(manager: BrowserPackManager = getBrowserPackManager()): Promise<void> {
  const ingest = await import('./pack-ingest');
  for (const record of await manager.pendingEmbeddings()) {
    const stored = await storedVersionDocs(manager, record);
    if (stored === null) continue;
    const chunks = ingest.buildPackChunks(stored.manifest, stored.docs);
    if (await ingest.embedPackChunks(chunks)) await manager.markEmbedded(record.packId, record.version, true);
  }
}

/**
 * The production index hooks (pack-ingest.ts, loaded on demand so the search
 * indexes and their WASM stay out of modules that only list packs).
 */
export function searchIndexHooks(managerRef: () => BrowserPackManager): PackIndexHooks {
  return {
    onInstalled: async (_record, manifest, docs) => {
      const ingest = await import('./pack-ingest');
      await ingest.indexPackKeywords(manifest, docs);
      // Embeddings in the background: retrieval and the pinned-slide section
      // already work from the keyword index.
      void embedPendingPackChunks(managerRef()).catch((error: unknown) => console.warn('[packs] embedding failed:', error));
    },
    onRemoved: async (records) => {
      const ingest = await import('./pack-ingest');
      await ingest.unindexPackDocs(records);
    },
    onActivated: async (record) => {
      const manager = managerRef();
      await manager.markEmbedded(record.packId, record.version, false);
      const stored = await storedVersionDocs(manager, record);
      if (stored === null) return;
      const ingest = await import('./pack-ingest');
      await ingest.indexPackKeywords(stored.manifest, stored.docs);
      void embedPendingPackChunks(manager).catch((error: unknown) => console.warn('[packs] embedding failed:', error));
    },
  };
}

/** The app-wide manager over the app origin's OPFS + IndexedDB. */
export function getBrowserPackManager(): BrowserPackManager {
  if (singleton === null) {
    const manager: BrowserPackManager = new BrowserPackManager({
      registry: new IndexedDbPackRegistry(),
      files: new OpfsPackFileStore(),
      hooks: searchIndexHooks(() => manager),
    });
    singleton = manager;
  }
  return singleton;
}

/** Tests only. */
export function resetBrowserPackManagerForTests(manager: BrowserPackManager | null = null): void {
  singleton = manager;
}
