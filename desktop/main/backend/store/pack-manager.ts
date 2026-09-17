// store/pack-manager.ts — Node PackManager lifecycle (issue #70, C3).
//
// Ports the Python reference semantics (pack_manager.py, C2/#69) onto the
// shared SQLite store: install / supersede / rollback / remove / listInstalled
// with ADR-0004 content-hash identity — doc id = sha256(raw doc bytes),
// chunk id = sha256(`${docSha}:${chunkIndex}:${normalizedText}`). Identity is
// NEVER path-derived, so a pack installed here produces the same chunk ids as
// the Python implementation (cross-backend parity: contracts/tests/
// test_pack_parity.py + desktop/src/__tests__/c3-pack-parity.test.ts).
//
// Deliberate divergences from the B6 ingest pipeline (both sanctioned):
//   - chunking uses the pack manifest's fixed-words strategy (naive whitespace
//     word windows, pack_manager.py:152-169) — NOT TextChunker, which is the
//     semantic ad-hoc-ingestion chunker and would break cross-backend parity
//     for any multi-chunk doc;
//   - manifests are validated against the AUTHORITATIVE
//     contracts/pack.schema.json (Ajv 2020-12, loaded from disk — never
//     copied) plus the C2 semantic checks (doc-bytes re-hash, safe paths).
//
// Atomicity (plan D7): the embedder runs BEFORE any write; every mutation is
// one BEGIN IMMEDIATE..COMMIT with ROLLBACK preserving the original error
// (repo pattern). supersedes rows are carried as JSON arrays of "id@version"
// strings, exactly like the C2 registry rows.
//
// Link maintenance composes the D4 store-layer helpers (#80 named #70 as the
// caller): removeLinksForPack / pruneOrphanLinks / recomputeLinksForDocs run
// inside the same transactions that remove or add chunks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { StoreHandle } from './sqlite-store.js';
import {
  recomputeLinksForDocs,
  removeLinksForPack,
  pruneOrphanLinks,
  type LinksDb,
} from './links.js';
import type { EmbeddingSurface } from '../ingest/embedder.js';
import { findRepoRoot } from './sqlite-store.js';

// Ajv's 2020-12 compiler and the format pack are CJS without an exports map;
// they resolve through createRequire exactly like the native addons in
// sqlite-store.ts (same ESM/CJS seam, typed structurally below).
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020') as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => { compile(schema: object): (data: unknown) => boolean };
const addFormats = require('ajv-formats') as (ajv: unknown) => unknown;

/** The authoritative pack manifest schema, relative to the repository root. */
export const PACK_SCHEMA_RELATIVE_PATH = 'contracts/pack.schema.json';

/** Raised for refused or failed pack lifecycle operations (C2 parity name). */
export class PackManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackManagerError';
  }
}

/** One installed pack version row, as stored in the packs table (v3). */
export interface PackRecord {
  packId: string;
  version: string;
  active: boolean;
  installPath: string | null;
  supersedes: string[];
  docs: Record<string, { doc_sha256: string; doc_id: string }>;
}

export interface InstallResult {
  packId: string;
  version: string;
  sourcePath: string;
  installPath: string;
  docsInstalled: number;
  chunksAdded: number;
  replacedDocIds: string[];
  superseded: string[];
  warnings: string[];
}

interface PackManifestDoc {
  path: string;
  sha256: string;
  title: string;
  mime: string;
}

interface PackManifest {
  id: string;
  name: string;
  version: string;
  published_at: string;
  source_class: string;
  embedding: { model_id: string; dims: number; normalize: boolean };
  chunking: { strategy?: string; size?: number; overlap?: number };
  docs: PackManifestDoc[];
  supersedes?: string[];
  index?: { path: string; schema_version: number; sqlite_vec_version: string };
  signature?: unknown;
}

interface PacksRow {
  id: string;
  version: string;
  name: string;
  published_at: string | null;
  source_class: string;
  active: number;
  install_path: string | null;
  supersedes: string | null;
}

interface ChunkPayload {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
}

/** Structural subset of better-sqlite3's statement API this module uses. */
interface Statement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// --- identity helpers (byte-match twins of ingest/pipeline.ts and
// pack_manager.py:89-107; pinned by the cross-backend parity test) ---

/** ADR-0004 normalization: CRLF -> LF, trailing horizontal whitespace
 * stripped per line. Bare CR is intentionally NOT normalized. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** ADR-0004 chunk identity; the ':' separators are part of the formula. */
export function chunkIdFor(docSha256: string, chunkIndex: number, normalized: string): string {
  return sha256Hex(`${docSha256}:${chunkIndex}:${normalized}`);
}

// --- semver 2.0.0 precedence (pack_manager.py:110-129 port) ---

type PreId = [number, number, string];

/**
 * Mirrors _version_key: numeric triple, then pre-release (a pre-release sorts
 * BELOW its release; numeric identifiers compare numerically and sort below
 * alphanumeric ones). Compared with compareVersionKeys — JS arrays do not
 * compare lexicographically the way Python tuples do.
 */
export function versionKey(version: string): {
  major: number;
  minor: number;
  patch: number;
  pre: number;
  ids: PreId[];
} {
  let core = version;
  const plus = core.indexOf('+');
  if (plus >= 0) core = core.slice(0, plus);
  let pre = '';
  const dash = core.indexOf('-');
  if (dash >= 0) {
    pre = core.slice(dash + 1);
    core = core.slice(0, dash);
  }
  const segments = core.split('.');
  if (segments.length !== 3 || segments.some((s) => !/^\d+$/.test(s))) {
    throw new PackManagerError(`unsupported pack version (semver 2.0.0 expected): ${version}`);
  }
  const ids: PreId[] =
    pre === ''
      ? []
      : pre.split('.').map((part) =>
          /^\d+$/.test(part) ? [0, Number.parseInt(part, 10), ''] : [1, 0, part],
        );
  return {
    major: Number.parseInt(segments[0] ?? '0', 10),
    minor: Number.parseInt(segments[1] ?? '0', 10),
    patch: Number.parseInt(segments[2] ?? '0', 10),
    pre: pre === '' ? 1 : 0,
    ids,
  };
}

function compareIds(a: PreId, b: PreId): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

function compareIdArrays(a: PreId[], b: PreId[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const c = compareIds(a[i] as PreId, b[i] as PreId);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** -1 when a < b, 0 when equal, 1 when a > b (Python tuple semantics). */
export function compareVersionKeys(
  a: ReturnType<typeof versionKey>,
  b: ReturnType<typeof versionKey>,
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre !== b.pre) return a.pre - b.pre;
  return compareIdArrays(a.ids, b.ids);
}

// --- manifest doc text extraction (pack_manager.py:132-149 port) ---

export function extractDocText(raw: Buffer, mime: string): string {
  if (mime === 'application/json') {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw new PackManagerError(
        `doc is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof data !== 'object' || data === null || typeof (data as { text?: unknown }).text !== 'string') {
      throw new PackManagerError("JSON doc must be an object with a string 'text'");
    }
    return (data as { text: string }).text;
  }
  if (mime.startsWith('text/')) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new PackManagerError('text doc is not valid UTF-8');
    }
  }
  throw new PackManagerError(
    `unsupported doc mime ${JSON.stringify(mime)}; prebuilt-index packs are the C6 path`,
  );
}

// --- fixed-words chunking (pack_manager.py:152-169 port; NOT TextChunker) ---

/**
 * fixed-words windows over whitespace-separated words. The under-size case
 * returns the ORIGINAL text un-normalized (single chunk); windowed pieces are
 * normalized as they are built — the chunk builder then normalizes EVERY piece
 * uniformly, reproducing C2's two-layer structure byte-for-byte.
 */
export function splitWords(text: string, size: number, overlap: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= size) return [text];
  if (overlap >= size) {
    throw new PackManagerError('chunking overlap must be smaller than size');
  }
  const pieces: string[] = [];
  const step = size - overlap;
  let start = 0;
  while (start < words.length) {
    const window = words.slice(start, start + size);
    pieces.push(normalizeText(window.join(' ')));
    if (start + size >= words.length) break;
    start += step;
  }
  return pieces;
}

// --- safe doc path guard (validate_pack.py:121-140 semantics) ---

/** Refuse absolute paths, backslashes, dot segments, NUL and control chars. */
export function assertSafeDocPath(value: string): void {
  if (value.length === 0) throw new PackManagerError('doc path is empty');
  if (value.includes('\\')) throw new PackManagerError(`doc path has a backslash: ${value}`);
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new PackManagerError(`doc path is absolute: ${value}`);
  }
  for (const segment of value.split('/')) {
    if (segment === '..' || segment === '.') {
      throw new PackManagerError(`doc path has a dot segment: ${value}`);
    }
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0 || code < 32 || code === 127) {
      throw new PackManagerError(`doc path has a control character: ${JSON.stringify(value)}`);
    }
  }
}

export interface PackManagerOptions {
  store: StoreHandle;
  embedder: EmbeddingSurface;
  /** Managed pack copies live under <packsRoot>/<packId>/<version>/. */
  packsRoot: string;
  /** Repository root (where contracts/ lives); auto-discovered by default. */
  repoRoot?: string;
}

export class PackManager {
  /**
   * The bound store handle. REBINDABLE: store-swap paths (clear cache /
   * recovery) close and reopen the connection, so the host calls
   * `rebindStore` with the fresh handle — mirrors the StoreDocumentSurface
   * get/set accessor contract (PRR-003).
   */
  private storeHandle: StoreHandle | null;
  private readonly embedder: EmbeddingSurface;
  readonly packsRoot: string;
  private readonly repoRoot: string;
  private validateManifestSchema: ((data: unknown) => boolean) | null = null;
  /**
   * C2 parity for `pack_manager.py:82 _registry_lock`: every public lifecycle
   * operation serializes behind this promise chain (PRR-005). Node's event
   * loop prevents true intra-call concurrency but NOT cross-surface
   * interleaving at await points (embed runs between the policy checks and
   * the write transaction); the queue restores C2's one-operation-at-a-time
   * contract.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PackManagerOptions) {
    this.storeHandle = opts.store;
    this.embedder = opts.embedder;
    this.packsRoot = opts.packsRoot;
    this.repoRoot = opts.repoRoot ?? findRepoRoot();
  }

  /** Rebind after a store swap (host clear-cache / recovery paths). */
  rebindStore(handle: StoreHandle | null): void {
    this.storeHandle = handle;
  }

  private get store(): StoreHandle {
    if (this.storeHandle === null) {
      throw new PackManagerError(
        'store handle unavailable (swapped by a clear-cache/recovery operation); retry after the host reopens the store',
      );
    }
    return this.storeHandle;
  }

  /** Serialize every public lifecycle operation (C2 _registry_lock parity). */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private get db(): LinksDb {
    return this.store.db as unknown as LinksDb;
  }

  private stmt(sql: string): Statement {
    return this.store.db.prepare(sql) as unknown as Statement;
  }

  // ------------------------------------------------------------- #
  // public lifecycle API (external contract mirrors pack_manager.py)
  // ------------------------------------------------------------- #

  install(packPath: string): Promise<InstallResult> {
    return this.enqueue(() => this.installLocked(packPath));
  }

  private async installLocked(packPath: string): Promise<InstallResult> {
    const source = path.resolve(packPath);
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      // PackSource would validate a zip fine, but install/ingest below
      // require a folder on disk; refuse cleanly instead of crashing.
      throw new PackManagerError(
        `${source}: folder-form packs only; zip ingestion (and prebuilt indexes) land with C6 packtool / C8 hardening`,
      );
    }
    const manifest = this.validatedManifest(source);
    const packId = manifest.id;
    const version = manifest.version;

    const rows = this.readPackRows();
    const ownActive = rows.filter((r) => r.id === packId && r.active === 1);
    if (ownActive.length > 0) {
      const activeVersion = ownActive[0]!.version;
      if (compareVersionKeys(versionKey(version), versionKey(activeVersion)) < 0) {
        throw new PackManagerError(
          `refusing downgrade of ${packId}: ${activeVersion} is installed and active; use rollback`,
        );
      }
      if (compareVersionKeys(versionKey(version), versionKey(activeVersion)) === 0) {
        throw new PackManagerError(
          `${packId}@${version} is already installed and active; remove it first`,
        );
      }
    }

    // Resolve supersedes targets; absent targets warn and are recorded on the
    // new row only.
    const targets: PacksRow[] = [];
    const warnings: string[] = [];
    for (const entry of manifest.supersedes ?? []) {
      const at = entry.indexOf('@');
      const targetId = at === -1 ? entry : entry.slice(0, at);
      const targetVersion = at === -1 ? '' : entry.slice(at + 1);
      const target = rows.find((r) => r.id === targetId && r.version === targetVersion);
      if (target === undefined) {
        warnings.push(
          `supersedes entry ${entry} names no installed pack version; recorded on the new row only`,
        );
      } else if (!targets.includes(target)) {
        targets.push(target);
      }
    }
    // Outgoing rows: the prior same-id active version (any transition
    // direction — implicit upgrade is the common case) + supersede targets.
    const outgoing: PacksRow[] = [...ownActive];
    for (const target of targets) {
      if (!outgoing.includes(target)) outgoing.push(target);
    }

    // Managed copy; the source path is never referenced again.
    const managed = path.join(this.packsRoot, packId, version);
    try {
      fs.rmSync(managed, { recursive: true, force: true }); // failed-attempt residue
      fs.mkdirSync(path.dirname(managed), { recursive: true });
      fs.cpSync(source, managed, { recursive: true });
    } catch (error) {
      throw new PackManagerError(
        `failed to stage managed copy of ${packId}@${version}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Build chunks + embed BEFORE any write: an embedder that cannot produce
    // one correctly-sized vector per chunk fails the install explicitly, so a
    // pack is never recorded as complete with borrowed or missing vectors.
    const chunks = this.buildChunks(managed, manifest);
    const vectors = await this.embedChecked(chunks);

    // Outgoing docs maps (derived from each row's retained managed manifest —
    // sha values are the install-validated ones).
    const outgoingDocs = outgoing.map((row) => ({ row, docs: this.docsMapForRow(row) }));

    const replacedDocIds: string[] = [];
    const supersededNames: string[] = outgoing.map((r) => `${r.id}@${r.version}`);
    const docIds = manifest.docs.map((entry) => entry.sha256);

    this.inTransaction(() => {
      // delete-before-reingest: for each outgoing row, drop docs whose content
      // changed at the same manifest path, or which the new manifest no longer
      // carries. Content-identical docs keep their chunks (same ids as the
      // incoming inserts; the delete-then-insert below dedupes).
      for (const { docs } of outgoingDocs) {
        for (const [relPath, info] of Object.entries(docs)) {
          const incoming = manifest.docs.find((entry) => entry.path === relPath);
          if (incoming === undefined || incoming.sha256 !== info.doc_sha256) {
            if (this.deleteDocumentLocked(info.doc_id)) replacedDocIds.push(info.doc_id);
          }
        }
      }

      this.writeLiveChunksLocked(manifest, chunks, vectors);

      // Deactivate outgoing rows (files retained on disk).
      for (const row of outgoing) {
        this.stmt('UPDATE packs SET active = 0 WHERE id = ? AND version = ?').run(row.id, row.version);
        removeLinksForPack(this.db, row.id);
      }

      // Drop any residue row for this exact id@version (failed attempt), then
      // record the new row active.
      this.stmt('DELETE FROM packs WHERE id = ? AND version = ?').run(packId, version);
      this.stmt(
        'INSERT INTO packs (id, version, name, published_at, source_class, active, install_path, supersedes) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      ).run(
        packId,
        version,
        manifest.name,
        manifest.published_at ?? null,
        manifest.source_class,
        managed,
        JSON.stringify(manifest.supersedes ?? []),
      );

      // D4 contract: link maintenance inside the same transaction — prune the
      // orphans the deletions left, recompute for the incoming docs.
      pruneOrphanLinks(this.db);
      if (docIds.length > 0) recomputeLinksForDocs(this.db, docIds);
    });

    for (const warning of warnings) {
      console.warn(`[pack-manager] install ${packId}@${version}: ${warning}`);
    }
    return {
      packId,
      version,
      sourcePath: source,
      installPath: managed,
      docsInstalled: manifest.docs.length,
      chunksAdded: chunks.length,
      replacedDocIds,
      superseded: supersededNames,
      warnings,
    };
  }

  supersede(packId: string, fromVersion: string, toVersion: string): Promise<void> {
    return this.enqueue(() => this.supersedeLocked(packId, fromVersion, toVersion));
  }

  private async supersedeLocked(packId: string, fromVersion: string, toVersion: string): Promise<void> {
    const rows = this.readPackRows();
    const fromRow = rows.find((r) => r.id === packId && r.version === fromVersion);
    const toRow = rows.find((r) => r.id === packId && r.version === toVersion);
    if (fromRow === undefined || toRow === undefined) {
      throw new PackManagerError(
        `supersede requires both versions installed: ${packId}@${fromVersion}, ${packId}@${toVersion}`,
      );
    }
    // Prepare the activation payload BEFORE the transaction (embed is async;
    // the transaction itself stays synchronous, per the single-writer rule).
    const activation =
      toRow.active === 1 ? null : await this.prepareActivation(toRow);
    this.inTransaction(() => {
      // Deactivate the from-version first, then activate the to-version. C2's
      // registry model applies the same two transitions in the opposite order
      // against in-memory rows saved once; on SQLite the deactivate-first
      // order keeps shared-content chunk ids live (identical bytes across the
      // two versions share ids — activate-after-delete re-inserts them,
      // activate-before-delete would remove the just-inserted rows).
      if (fromRow.active === 1) this.deactivateLocked(fromRow);
      if (activation !== null) this.applyActivationLocked(activation);
      this.stmt('UPDATE packs SET active = 0 WHERE id = ? AND version = ?').run(packId, fromVersion);
      this.stmt('UPDATE packs SET active = 1 WHERE id = ? AND version = ?').run(packId, toVersion);
    });
  }

  rollback(packId: string, toVersion: string): Promise<void> {
    return this.enqueue(() => this.rollbackLocked(packId, toVersion));
  }

  private async rollbackLocked(packId: string, toVersion: string): Promise<void> {
    const rows = this.readPackRows();
    const toRow = rows.find((r) => r.id === packId && r.version === toVersion);
    if (toRow === undefined) {
      throw new PackManagerError(`${packId}@${toVersion} is not installed`);
    }
    if (toRow.active === 1) {
      throw new PackManagerError(`${packId}@${toVersion} is already the active version`);
    }
    const actives = rows.filter((r) => r.id === packId && r.active === 1);
    const activation = await this.prepareActivation(toRow);
    this.inTransaction(() => {
      for (const row of actives) this.deactivateLocked(row);
      this.applyActivationLocked(activation);
      for (const row of actives) {
        this.stmt('UPDATE packs SET active = 0 WHERE id = ? AND version = ?').run(row.id, row.version);
      }
      this.stmt('UPDATE packs SET active = 1 WHERE id = ? AND version = ?').run(packId, toVersion);
    });
  }

  remove(packId: string, version?: string): Promise<number> {
    return this.enqueue(() => this.removeLocked(packId, version));
  }

  private async removeLocked(packId: string, version?: string): Promise<number> {
    const rows = this.readPackRows().filter(
      (r) => r.id === packId && (version === undefined || r.version === version),
    );
    if (rows.length === 0) {
      throw new PackManagerError(
        `nothing installed matches ${packId}${version === undefined ? '' : `@${version}`}`,
      );
    }
    // Derive the docs maps FIRST — they come from the managed manifests, and
    // the managed dirs are removed inside the loop below (C2's registry kept
    // the map in the row; this store derives it, so the read must precede the
    // delete). The transaction is idempotent on retry either way.
    const docMaps = rows.map((row) => ({ row, docs: this.docsMapForRow(row) }));
    for (const { row } of docMaps) {
      if (row.install_path !== null) {
        try {
          fs.rmSync(row.install_path, { recursive: true, force: true });
        } catch (error) {
          throw new PackManagerError(
            `failed to delete managed dir ${row.install_path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    this.inTransaction(() => {
      for (const { docs } of docMaps) {
        for (const info of Object.values(docs)) this.deleteDocumentLocked(info.doc_id);
      }
      for (const { row } of docMaps) {
        removeLinksForPack(this.db, row.id);
        this.stmt('DELETE FROM packs WHERE id = ? AND version = ?').run(row.id, row.version);
      }
      pruneOrphanLinks(this.db);
    });
    return rows.length;
  }

  listInstalled(): Promise<PackRecord[]> {
    return this.enqueue(async () =>
      this.readPackRows().map((row) => {
      let supersedes: string[] = [];
      if (row.supersedes !== null) {
        try {
          const parsed: unknown = JSON.parse(row.supersedes);
          if (!Array.isArray(parsed)) throw new Error('not an array');
          supersedes = parsed.map(String);
        } catch {
          throw new PackManagerError(
            `pack registry row ${row.id}@${row.version} has malformed supersedes: ${row.supersedes}`,
          );
        }
      }
      return {
        packId: row.id,
        version: row.version,
        active: row.active === 1,
        installPath: row.install_path,
        supersedes,
        docs: this.docsMapForRow(row),
      };
      }),
    );
  }

  // ------------------------------------------------------------- #
  // validation
  // ------------------------------------------------------------- #

  private schemaValidator(): (data: unknown) => boolean {
    if (this.validateManifestSchema === null) {
      const schemaPath = path.join(this.repoRoot, PACK_SCHEMA_RELATIVE_PATH);
      let schemaJson: unknown;
      try {
        schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      } catch (error) {
        throw new PackManagerError(
          `pack manifest schema unreadable at ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      this.validateManifestSchema = ajv.compile(schemaJson as object) as (data: unknown) => boolean;
    }
    return this.validateManifestSchema;
  }

  private validatedManifest(packPath: string): PackManifest {
    const manifestPath = path.join(packPath, 'pack.json');
    let raw: Buffer;
    try {
      raw = fs.readFileSync(manifestPath);
    } catch {
      throw new PackManagerError(`${packPath}: pack.json is missing from the pack`);
    }
    let manifest: PackManifest;
    try {
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as PackManifest;
    } catch (error) {
      throw new PackManagerError(
        `${packPath}: pack.json is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const isValid = this.schemaValidator()(manifest);
    if (!isValid) {
      throw new PackManagerError(`pack failed validation: pack.json does not satisfy ${PACK_SCHEMA_RELATIVE_PATH}`);
    }

    // Semantic checks (validate_pack.py ports): safe paths, doc-bytes re-hash,
    // duplicate paths. The schema pins field shapes; these pin content.
    const seen = new Set<string>();
    for (const entry of manifest.docs) {
      assertSafeDocPath(entry.path);
      if (seen.has(entry.path)) {
        throw new PackManagerError(`${packPath}: duplicate docs[].path entries in manifest`);
      }
      seen.add(entry.path);
      let docBytes: Buffer;
      try {
        docBytes = fs.readFileSync(path.join(packPath, entry.path));
      } catch (error) {
        throw new PackManagerError(
          `doc unreadable: ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const actual = sha256Hex(docBytes);
      if (actual !== entry.sha256.toLowerCase()) {
        throw new PackManagerError(
          `doc sha256 mismatch for ${entry.path}: manifest ${entry.sha256}, actual ${actual}`,
        );
      }
    }

    // AC4: a pack that carries a prebuilt index block must match the store's
    // schema version — a mismatch is an explicit refusal, never silent.
    if (manifest.index !== undefined && manifest.index.schema_version !== this.store.schemaVersion) {
      throw new PackManagerError(
        `pack index schema_version ${manifest.index.schema_version} does not match store schema_version ${this.store.schemaVersion}; refusing install`,
      );
    }
    return manifest;
  }

  // ------------------------------------------------------------- #
  // chunking / embedding
  // ------------------------------------------------------------- #

  private buildChunks(installDir: string, manifest: PackManifest): ChunkPayload[] {
    const strategy = manifest.chunking.strategy ?? 'fixed-words';
    const size = manifest.chunking.size ?? 256;
    const overlap = manifest.chunking.overlap ?? 0;
    const chunks: ChunkPayload[] = [];
    for (const entry of manifest.docs) {
      let raw: Buffer;
      try {
        raw = fs.readFileSync(path.join(installDir, entry.path));
      } catch (error) {
        throw new PackManagerError(
          `doc unreadable: ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const docSha = sha256Hex(raw);
      const text = extractDocText(raw, entry.mime);
      let pieces: string[];
      if (strategy === 'fixed-words') {
        pieces = splitWords(text, size, overlap);
      } else if (text.split(/\s+/).filter((w) => w.length > 0).length <= size) {
        // Under-size docs are one chunk regardless of strategy.
        pieces = [normalizeText(text)];
      } else {
        throw new PackManagerError(
          `chunking strategy ${JSON.stringify(strategy)} over size is not built here; ship a prebuilt index (C6 packtool) for this pack`,
        );
      }
      for (let index = 0; index < pieces.length; index += 1) {
        const chunkText = normalizeText(pieces[index] ?? '');
        chunks.push({
          chunkId: chunkIdFor(docSha, index, chunkText),
          docId: docSha,
          chunkIndex: index,
          text: chunkText,
          contentHash: sha256Hex(chunkText),
        });
      }
    }
    return chunks;
  }

  private async embedChecked(chunks: ChunkPayload[]): Promise<number[][]> {
    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    if (vectors.length !== chunks.length) {
      throw new PackManagerError(
        `embedder returned ${vectors.length} vectors for ${chunks.length} chunks; refusing partial install`,
      );
    }
    for (const vector of vectors) {
      if (vector.length !== this.store.dims) {
        throw new PackManagerError(
          `embedding width ${vector.length} does not match store dims ${this.store.dims}`,
        );
      }
    }
    return vectors;
  }

  // ------------------------------------------------------------- #
  // SQLite helpers (all *_Locked helpers run inside the caller's transaction)
  // ------------------------------------------------------------- #

  private readPackRows(): PacksRow[] {
    try {
      return this.stmt(
        'SELECT id, version, name, published_at, source_class, active, install_path, supersedes FROM packs ORDER BY id, version',
      ).all() as unknown as PacksRow[];
    } catch (error) {
      if (error instanceof PackManagerError) throw error;
      throw new PackManagerError(
        `pack registry read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Doc map for an installed row, derived from its retained managed manifest
   * (the sha values are the install-validated ones; the managed dir is
   * app-owned). Prebuilt wholesale rows (install_path NULL) have none. */
  private docsMapForRow(row: PacksRow): Record<string, { doc_sha256: string; doc_id: string }> {
    if (row.install_path === null) return {};
    const manifestPath = path.join(row.install_path, 'pack.json');
    let raw: Buffer;
    try {
      raw = fs.readFileSync(manifestPath);
    } catch {
      console.warn(
        `[pack-manager] ${row.id}@${row.version}: managed manifest unreadable at ${manifestPath}; treating as no docs`,
      );
      return {};
    }
    try {
      const manifest = JSON.parse(raw.toString('utf8')) as PackManifest;
      const docs: Record<string, { doc_sha256: string; doc_id: string }> = {};
      for (const entry of manifest.docs) {
        docs[entry.path] = { doc_sha256: entry.sha256, doc_id: entry.sha256 };
      }
      return docs;
    } catch {
      console.warn(
        `[pack-manager] ${row.id}@${row.version}: managed manifest unparseable at ${manifestPath}; treating as no docs`,
      );
      return {};
    }
  }

  /** Delete a doc's live content: chunks + embeddings + fts + links + the docs
   * row (chunk cascade mirrors ingest/pipeline.ts:353-369; the docs row is
   * re-created on reactivation). Returns false when nothing was live (the C2
   * delete_document contract: deactivation proceeds and logs). */
  private deleteDocumentLocked(docId: string): boolean {
    const chunkIds = (
      this.stmt('SELECT id FROM chunks WHERE doc_id = ?').all(docId) as Array<{ id: string }>
    ).map((r) => r.id);
    const docsRow = this.stmt('SELECT id FROM docs WHERE id = ?').get(docId) as
      | { id: string }
      | undefined;
    if (chunkIds.length === 0 && docsRow === undefined) return false;
    for (const chunkId of chunkIds) {
      this.stmt('DELETE FROM embeddings WHERE chunk_id = ?').run(chunkId);
      this.stmt('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunkId);
      this.stmt('DELETE FROM links WHERE chunk_id = ?').run(chunkId);
    }
    this.stmt('DELETE FROM chunks WHERE doc_id = ?').run(docId);
    this.stmt('DELETE FROM docs WHERE id = ?').run(docId);
    return true;
  }

  /** Write (or rewrite) a version's live chunk rows. Identity is content-hash,
   * so identical content elsewhere in the store is intentionally REPLACED by
   * the same rows (the single live copy C2's replace mode produces). fts5 has
   * no uniqueness on chunk_id, so leftovers are deleted before insert instead
   * of relying on any upsert. */
  private writeLiveChunksLocked(manifest: PackManifest, chunks: ChunkPayload[], vectors: number[][]): void {
    // Docs rows FIRST: chunks.doc_id references docs(id) and better-sqlite3
    // runs with PRAGMA foreign_keys=ON by default (the pipeline does the same).
    for (const entry of manifest.docs) {
      this.stmt(
        'INSERT OR IGNORE INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(entry.sha256, manifest.source_class, entry.path, entry.sha256, entry.title, manifest.published_at ?? null, manifest.id);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      this.stmt('DELETE FROM embeddings WHERE chunk_id = ?').run(chunk.chunkId);
      this.stmt('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.chunkId);
      this.stmt('DELETE FROM links WHERE chunk_id = ?').run(chunk.chunkId);
      this.stmt('DELETE FROM chunks WHERE id = ?').run(chunk.chunkId);
      this.stmt('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
        chunk.chunkId,
        chunk.docId,
        chunk.chunkIndex,
        chunk.text,
        chunk.contentHash,
      );
      this.stmt('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
        chunk.chunkId,
        JSON.stringify(vectors[i]),
      );
      this.stmt('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(chunk.chunkId, chunk.text);
    }
    this.stmt("UPDATE meta SET value = ? WHERE key = 'embedding_model_id'").run(this.embedder.modelId);
  }

  /** Deactivate inside a transaction: delete the version's live chunks; the
   * packs row and managed files stay (C2 _deactivate contract). */
  private deactivateLocked(row: PacksRow): void {
    for (const info of Object.values(this.docsMapForRow(row))) {
      if (!this.deleteDocumentLocked(info.doc_id)) {
        // Single-user semantics: deactivate proceeds; the orphan is absorbed
        // by the next reactivation of this version (content-hash ids make
        // re-ingest byte-identical).
        console.warn(
          `[pack-manager] ${row.id}@${row.version}: no live chunks for doc ${info.doc_id}; row deactivated`,
        );
      }
    }
  }

  /** Activation payload prepared OUTSIDE any transaction (async embed). */
  private async prepareActivation(row: PacksRow): Promise<{
    row: PacksRow;
    manifest: PackManifest;
    chunks: ChunkPayload[];
    vectors: number[][];
  }> {
    if (row.install_path === null) {
      throw new PackManagerError(
        `${row.id}@${row.version} has no managed folder (prebuilt-index rows cannot be activated by the folder-form PackManager)`,
      );
    }
    const manifest = this.validatedManifest(row.install_path);
    const chunks = this.buildChunks(row.install_path, manifest);
    const vectors = await this.embedChecked(chunks);
    return { row, manifest, chunks, vectors };
  }

  /** Apply a prepared activation inside the caller's transaction. */
  private applyActivationLocked(activation: {
    row: PacksRow;
    manifest: PackManifest;
    chunks: ChunkPayload[];
    vectors: number[][];
  }): void {
    this.writeLiveChunksLocked(activation.manifest, activation.chunks, activation.vectors);
    recomputeLinksForDocs(this.db, activation.manifest.docs.map((entry) => entry.sha256));
  }

  /** Run `work` inside one BEGIN IMMEDIATE..COMMIT; ROLLBACK preserves the
   * original error (repo pattern from pipeline.ts / migrate.ts). */
  private inTransaction(work: () => void): void {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.store.db.exec('COMMIT');
    } catch (error) {
      try {
        this.store.db.exec('ROLLBACK');
      } catch {
        // The connection may be unusable after some failures; surface the cause.
      }
      if (error instanceof PackManagerError) throw error;
      throw new PackManagerError(
        `pack lifecycle operation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
