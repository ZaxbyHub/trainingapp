// c8-pack-security.test.ts — issue #75 (C8): hardened pack installation,
// Node side. The in-repo mirror of the frozen acceptance drivers
// (.agents/issue-traces/75-harden-pack-installation/repro/{py_driver.py,
// node_driver.mjs}) so repo-suite green and frozen-check green cannot diverge.
//
// FROZEN CONSTANTS (documented here; identical to the drivers and the Python
// twin's tests/test_pack_security.py — do not change one without the others):
//   - zip-bomb cap ........ 4 MiB (4 * 1024 * 1024) vs a 6 MiB honest payload,
//                           declared-ratio cap 10
//   - entry cap ........... 100 vs a 150-entry archive
//   - default entry cap ... 5000 (a 2500-entry archive is ACCEPTED)
//   - traversal matrix .... 'E:../x', 'C:/x', '../../x', backslash, symlink
//   - signature ........... ed25519 over canonical manifest bytes, three arms
//                           (default installs unsigned / required+untrusted
//                           refuses / required+trusted accepts)
//
// Harness: the c3 pattern (openStore + the REAL PackManager + HashEmbedder).
// Zips are built with JSZip EXCEPT where JSZip normalizes hostile entry names
// away on load — traversal/attack archives use the hand-rolled store-only zip
// writer below (the same writer the frozen node driver uses, copied from
// repro/node_driver.mjs so bytes match bit for bit).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

// The frozen constants (see header).
const BOMB_CAP_BYTES = 4 * 1024 * 1024;
const BOMB_PAYLOAD_BYTES = 6 * 1024 * 1024;
const BOMB_RATIO_CAP = 10;
const ENTRY_CAP = 100;
const ENTRY_CAP_ARCHIVE_ENTRIES = 150;
const DEFAULT_ENTRY_CAP = 5000;
const DEFAULT_ENTRY_ACCEPT_ENTRIES = 2500;

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed by the test itself
      }
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows EPERM on a still-open handle: the OS temp cleaner gets it.
      }
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadModules() {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  const extractMod = await import('../../main/backend/packs/pack-extract.js');
  return {
    openStore: storeMod.openStore,
    PackManager: managerMod.PackManager,
    PackManagerError: managerMod.PackManagerError,
    HashEmbedder: embedderMod.HashEmbedder,
    extractPackZip: extractMod.extractPackZip,
    canonicalManifestBytes: extractMod.canonicalManifestBytes,
    resolvePacksSecurity: extractMod.resolvePacksSecurity,
    DEFAULT_PACK_EMBEDDING_MODEL_ID: extractMod.DEFAULT_PACK_EMBEDDING_MODEL_ID,
  };
}

interface SqlDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

// ------------------------------------------------------------------ //
// hand-rolled store-only zip writer (exact control over entry names,
// external attributes, EOCD comment, and ZIP64 markers — JSZip normalizes
// hostile names away on load, so attack archives must bypass it).
// Copied from the frozen driver repro/node_driver.mjs.
// ------------------------------------------------------------------ //
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface RawZipEntry {
  name: string;
  data: Buffer;
  method?: number;
  /** Raw 32-bit external attributes (unix mode << 16). */
  externalAttrs?: number;
}

function buildRawZip(entries: RawZipEntry[], opts?: { comment?: string; zip64EntryCountMarker?: boolean }): Buffer {
  const parts: Buffer[] = [];
  const central: Array<{ name: Buffer; method: number; crc: number; csize: number; usize: number; offset: number; externalAttrs: number }> = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const payload = e.method === 8 ? zlib.deflateRawSync(e.data, { level: 9 }) : Buffer.from(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(e.method ?? 0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, payload);
    const externalAttrs = e.externalAttrs ?? (0o100644 << 16) >>> 0;
    central.push({ name, method: e.method ?? 0, crc, csize: payload.length, usize: e.data.length, offset, externalAttrs });
    offset += 30 + name.length + payload.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(c.method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.csize, 20); ch.writeUInt32LE(c.usize, 24);
    ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(c.externalAttrs, 38); ch.writeUInt32LE(c.offset, 42);
    parts.push(ch, c.name);
    cdSize += 46 + c.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(opts?.zip64EntryCountMarker ? 0xffff : central.length, 8);
  eocd.writeUInt16LE(opts?.zip64EntryCountMarker ? 0xffff : central.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  const comment = Buffer.from(opts?.comment ?? '', 'utf8');
  eocd.writeUInt16LE(comment.length, 20);
  parts.push(eocd, comment);
  return Buffer.concat(parts);
}

/** A ZIP64 EOCD locator record (immediately precedes the EOCD when present). */
function zip64Locator(): Buffer {
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  return loc;
}

const PACK_JSON_STUB = Buffer.from(JSON.stringify({ id: 'stub', version: '1.0.0', docs: [] }));

function fillerEntries(count: number, prefix = 'docs/f'): RawZipEntry[] {
  const out: RawZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ name: `${prefix}${String(i).padStart(4, '0')}.txt`, data: Buffer.from('x'), method: 0 });
  }
  return out;
}

// ------------------------------------------------------------------ //
// pack fixtures + install harness (mirrors the driver's makePackDir)
// ------------------------------------------------------------------ //
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface MakePackOpts {
  modelId?: string;
  index?: { path: string; schema_version: number; sqlite_vec_version: string };
  tamper?: boolean;
  signature?: Record<string, unknown>;
}

function makePackDir(root: string, packId: string, opts: MakePackOpts = {}): { pack: string; manifest: Record<string, unknown> } {
  const pack = path.join(root, packId);
  fs.mkdirSync(path.join(pack, 'docs'), { recursive: true });
  const docBytes = Buffer.from(
    JSON.stringify({ title: 'Doc A', text: 'Probe doc for the pack-installation hardening checks.' }, null, 2),
  );
  const written = opts.tamper
    ? Buffer.from(
        JSON.stringify({ title: 'Doc A', text: 'Probe doc for the pack-installation hardening checks. Tampered, sha now stale.' }, null, 2),
      )
    : docBytes;
  fs.writeFileSync(path.join(pack, 'docs', 'a.json'), written);
  const manifest: Record<string, unknown> = {
    id: packId,
    name: 'C8 Probe',
    version: '1.0.0',
    published_at: '2026-09-01T00:00:00Z',
    source_class: 'bundled',
    embedding: { model_id: opts.modelId ?? 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'fixed-words', size: 256, overlap: 100 },
    docs: [{ path: 'docs/a.json', sha256: sha256(docBytes), title: 'Doc A', mime: 'application/json' }],
  };
  if (opts.index) manifest['index'] = opts.index;
  if (opts.signature) manifest['signature'] = opts.signature;
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { pack, manifest };
}

async function makeManager(dir: string, packsSecurity?: import('../../main/backend/packs/pack-extract.js').PacksSecurityOverrides) {
  const { openStore, PackManager, HashEmbedder } = await loadModules();
  const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8 });
  openStores.push(store);
  const manager = new PackManager({
    store,
    embedder: new HashEmbedder({ dims: 8 }),
    packsRoot: path.join(dir, 'packs'),
    repoRoot: REPO_ROOT,
    ...(packsSecurity !== undefined ? { packsSecurity } : {}),
  });
  return { store, manager };
}

function chunkCount(store: { db: SqlDb }): number {
  return (store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
}

/** Remove probe files a botched extraction could have planted (defensive). */
function cleanupEscapeCandidates(names: string[]): void {
  for (const name of names) {
    const candidates = new Set<string>([path.resolve(name)]);
    try {
      candidates.add(path.resolve(path.join(...name.split('/'))));
    } catch {
      /* ignore */
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
  }
}

// ------------------------------------------------------------------ //
// extraction legs
// ------------------------------------------------------------------ //
describe('c8 pack security (issue #75) — extraction', () => {
  itReal('refuses a 6 MiB honest bomb under the frozen 4 MiB cap (ratio 10)', async () => {
    const { extractPackZip, PackManagerError } = await loadModules();
    const zip = buildRawZip([
      { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
      { name: 'docs/bomb.bin', data: Buffer.alloc(BOMB_PAYLOAD_BYTES), method: 8 },
    ]);
    let message = '';
    await expect(
      extractPackZip(new Uint8Array(zip), 'bomb.zip', {
        maxUncompressedBytes: BOMB_CAP_BYTES,
        maxEntries: DEFAULT_ENTRY_CAP,
        maxCompressionRatio: BOMB_RATIO_CAP,
      }),
    ).rejects.toBeInstanceOf(PackManagerError);
    try {
      await extractPackZip(new Uint8Array(zip), 'bomb.zip', {
        maxUncompressedBytes: BOMB_CAP_BYTES,
        maxEntries: DEFAULT_ENTRY_CAP,
        maxCompressionRatio: BOMB_RATIO_CAP,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/byte cap|compression ratio/);
  });

  itReal('refuses 150 entries under the frozen 100-entry cap', async () => {
    const { extractPackZip, PackManagerError } = await loadModules();
    const zip = buildRawZip([{ name: 'pack.json', data: PACK_JSON_STUB, method: 0 }, ...fillerEntries(ENTRY_CAP_ARCHIVE_ENTRIES - 1)]);
    await expect(
      extractPackZip(new Uint8Array(zip), 'many.zip', {
        maxUncompressedBytes: 2147483648,
        maxEntries: ENTRY_CAP,
        maxCompressionRatio: 100,
      }),
    ).rejects.toThrow(PackManagerError);
    await expect(
      extractPackZip(new Uint8Array(zip), 'many.zip', {
        maxUncompressedBytes: 2147483648,
        maxEntries: ENTRY_CAP,
        maxCompressionRatio: 100,
      }),
    ).rejects.toThrow(/entry cap/);
  });

  itReal('accepts a 2500-entry archive at the 5000 default (no explicit limits)', { timeout: 120_000 }, async () => {
    const { extractPackZip } = await loadModules();
    const zip = buildRawZip([{ name: 'pack.json', data: PACK_JSON_STUB, method: 0 }, ...fillerEntries(DEFAULT_ENTRY_ACCEPT_ENTRIES - 1)]);
    const outDir = await extractPackZip(new Uint8Array(zip), 'default-entries.zip');
    tempDirs.push(outDir);
    expect(fs.existsSync(path.join(outDir, 'pack.json'))).toBe(true);
    const written = fs.readdirSync(path.join(outDir, 'docs')).length;
    expect(written).toBe(DEFAULT_ENTRY_ACCEPT_ENTRIES - 1);
  });

  itReal('refuses every traversal variant cleanly, nothing lands outside the root', async () => {
    const { extractPackZip, PackManagerError } = await loadModules();
    const variants = [
      'E:../p75c8node-drive-rel.txt',
      'C:/p75c8node-drive-abs.txt',
      '../../p75c8node-dotdot.txt',
      'docs/..\\p75c8node-backslash.txt',
    ];
    for (const name of variants) {
      cleanupEscapeCandidates([name]);
      const zip = buildRawZip([
        { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
        { name, data: Buffer.from('x'), method: 0 },
      ]);
      await expect(extractPackZip(new Uint8Array(zip), 'probe.zip')).rejects.toBeInstanceOf(PackManagerError);
      await expect(extractPackZip(new Uint8Array(zip), 'probe.zip')).rejects.toThrow(/unsafe archive entry path/);
      // On-disk containment: no candidate escape location exists.
      for (const candidate of [path.resolve(name), path.resolve(path.join(...name.split('/')))]) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    }
  });

  itReal('refuses symlink entries regardless of how they are spelled', async () => {
    const { extractPackZip, PackManagerError } = await loadModules();
    // Unix mode S_IFLNK | 0777 in the raw external attributes.
    const zip = buildRawZip([
      { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
      { name: 'docs/link.txt', data: Buffer.from('../../outside-target', 'utf8'), method: 0, externalAttrs: (0o120777 << 16) >>> 0 },
    ]);
    await expect(extractPackZip(new Uint8Array(zip), 'symlink.zip')).rejects.toThrow(PackManagerError);
    await expect(extractPackZip(new Uint8Array(zip), 'symlink.zip')).rejects.toThrow(/symlink/);
  });

  itReal('accepts an archive whose EOCD carries a zip comment (backward scan honors it)', async () => {
    const { extractPackZip } = await loadModules();
    const zip = buildRawZip(
      [{ name: 'pack.json', data: PACK_JSON_STUB, method: 0 }, { name: 'docs/a.txt', data: Buffer.from('x'), method: 0 }],
      { comment: 'trailing archive comment that embeds no structures' },
    );
    const outDir = await extractPackZip(new Uint8Array(zip), 'comment.zip');
    tempDirs.push(outDir);
    expect(fs.existsSync(path.join(outDir, 'docs', 'a.txt'))).toBe(true);
  });

  itReal('refuses ZIP64 markers with the 4 GiB / 65535-entry message', async () => {
    const { extractPackZip, PackManagerError } = await loadModules();
    const base = [{ name: 'pack.json', data: PACK_JSON_STUB, method: 0 }] as RawZipEntry[];
    // EOCD entry-count fields at the ZIP32 sentinel 0xffff.
    const sentinel = buildRawZip(base, { zip64EntryCountMarker: true });
    await expect(extractPackZip(new Uint8Array(sentinel), 'zip64.zip')).rejects.toBeInstanceOf(PackManagerError);
    await expect(extractPackZip(new Uint8Array(sentinel), 'zip64.zip')).rejects.toThrow(/4 GiB \/ 65535/);
    // A ZIP64 EOCD locator immediately before a well-formed EOCD.
    const normal = buildRawZip(base);
    const eocdOffset = normal.length - 22;
    const spliced = Buffer.concat([
      normal.subarray(0, eocdOffset),
      zip64Locator(),
      normal.subarray(eocdOffset),
    ]);
    await expect(extractPackZip(new Uint8Array(spliced), 'zip64.zip')).rejects.toBeInstanceOf(PackManagerError);
    await expect(extractPackZip(new Uint8Array(spliced), 'zip64.zip')).rejects.toThrow(/4 GiB \/ 65535/);
  });

  itReal('resolves the TRAININGAPP_PACKS_* env seam and pinned defaults', async () => {
    const { resolvePacksSecurity, DEFAULT_PACK_EMBEDDING_MODEL_ID } = await loadModules();
    const defaults = resolvePacksSecurity({});
    expect(defaults.maxUncompressedBytes).toBe(2147483648);
    expect(defaults.maxEntries).toBe(DEFAULT_ENTRY_CAP);
    expect(defaults.maxCompressionRatio).toBe(100);
    expect(defaults.requireSignature).toBe(false);
    expect(defaults.trustedKeys).toEqual([]);
    expect(defaults.embeddingModelId).toBe(DEFAULT_PACK_EMBEDDING_MODEL_ID);
    expect(DEFAULT_PACK_EMBEDDING_MODEL_ID).toBe('bge-small-en-v1.5');

    const overridden = resolvePacksSecurity({
      TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES: '4194304',
      TRAININGAPP_PACKS_MAX_ENTRIES: '100',
      TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO: '10',
      TRAININGAPP_PACKS_REQUIRE_SIGNATURE: 'true',
      TRAININGAPP_PACKS_TRUSTED_KEYS: JSON.stringify([{ key_id: 'k1', public_key: 'AAAA' }]),
      TRAININGAPP_PACKS_EMBEDDING_MODEL_ID: 'hash',
    });
    expect(overridden.maxUncompressedBytes).toBe(BOMB_CAP_BYTES);
    expect(overridden.maxEntries).toBe(ENTRY_CAP);
    expect(overridden.maxCompressionRatio).toBe(BOMB_RATIO_CAP);
    expect(overridden.requireSignature).toBe(true);
    expect(overridden.trustedKeys).toEqual([{ key_id: 'k1', public_key: 'AAAA' }]);
    expect(overridden.embeddingModelId).toBe('hash');
  });
});

// ------------------------------------------------------------------ //
// install-gate legs
// ------------------------------------------------------------------ //
describe('c8 pack security (issue #75) — install gates', () => {
  itReal('tampered doc sha stays fail-closed: refusal, zero chunks', async () => {
    const { PackManagerError } = await loadModules();
    const dir = makeTempDir('c8-tamper-');
    const { pack } = makePackDir(dir, 'c8-tamper', { tamper: true });
    const { store, manager } = await makeManager(dir);
    await expect(manager.install(pack)).rejects.toBeInstanceOf(PackManagerError);
    await expect(manager.install(pack)).rejects.toThrow(/sha256 mismatch/);
    expect(chunkCount(store)).toBe(0);
  });

  itReal('wrong embedding model is refused with the packtool remedy text', async () => {
    const { PackManagerError } = await loadModules();
    const dir = makeTempDir('c8-embedding-');
    // DEFAULT manager (no packsSecurity, no env): the pin default gate must
    // refuse a wrong-model pack by itself (frozen C5).
    const { pack } = makePackDir(dir, 'c8-wrongmodel', { modelId: 'wrong-model-75' });
    const { store, manager } = await makeManager(dir);
    let message = '';
    await expect(manager.install(pack)).rejects.toBeInstanceOf(PackManagerError);
    try {
      await manager.install(pack);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const lower = message.toLowerCase();
    expect(lower).toContain('build-docs');
    expect(lower).toContain('embedding-model');
    expect(chunkCount(store)).toBe(0);
  });

  itReal('index stamps: schema_version 4 and sqlite_vec_version 0.9.9 refused; correct stamps install', async () => {
    const { PackManagerError } = await loadModules();
    const arms: Array<{ name: string; index: { path: string; schema_version: number; sqlite_vec_version: string }; mustInstall: boolean }> = [
      { name: 'schema4', index: { path: 'index.sqlite', schema_version: 4, sqlite_vec_version: '0.1.9' }, mustInstall: false },
      { name: 'vec999', index: { path: 'index.sqlite', schema_version: 3, sqlite_vec_version: '0.9.9' }, mustInstall: false },
      { name: 'good', index: { path: 'index.sqlite', schema_version: 3, sqlite_vec_version: '0.1.9' }, mustInstall: true },
    ];
    for (const arm of arms) {
      const dir = makeTempDir(`c8-schema-${arm.name}-`);
      const { pack } = makePackDir(dir, `c8-${arm.name}`, { index: arm.index });
      const { store, manager } = await makeManager(dir);
      if (arm.mustInstall) {
        const result = await manager.install(pack);
        expect(result.chunksAdded).toBeGreaterThan(0);
      } else {
        await expect(manager.install(pack)).rejects.toBeInstanceOf(PackManagerError);
        expect(chunkCount(store)).toBe(0);
      }
    }
  });

  itReal('signature three arms: default installs unsigned; required+untrusted refuses; required+trusted accepts', async () => {
    const { canonicalManifestBytes } = await loadModules();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trustedKeys = [
      { key_id: 'c8key', public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    ];
    const wrongKey = generateKeyPairSync('ed25519');

    // Arm 1: default config — an unsigned pack installs normally.
    {
      const dir = makeTempDir('c8-sig-default-');
      const { pack } = makePackDir(dir, 'c8-unsigned');
      const { manager } = await makeManager(dir);
      const result = await manager.install(pack);
      expect(result.chunksAdded).toBeGreaterThan(0);
    }

    // Arm 2: requireSignature with an untrusted keyset — an unsigned pack is
    // refused, and so is a pack signed by a key outside the keyset.
    {
      const dir = makeTempDir('c8-sig-refuse-');
      const { pack } = makePackDir(dir, 'c8-unsigned-refused');
      const { store, manager } = await makeManager(dir, { requireSignature: true, trustedKeys });
      await expect(manager.install(pack)).rejects.toThrow(/signature/);
      expect(chunkCount(store)).toBe(0);

      const signedWrongKey = makePackDir(dir, 'c8-wrongkey');
      const wrongSig = cryptoSign(
        null,
        canonicalManifestBytes(fs.readFileSync(path.join(signedWrongKey.pack, 'pack.json'))),
        wrongKey.privateKey,
      );
      signedWrongKey.manifest['signature'] = { algorithm: 'ed25519', key_id: 'c8key', value: wrongSig.toString('base64') };
      fs.writeFileSync(path.join(signedWrongKey.pack, 'pack.json'), JSON.stringify(signedWrongKey.manifest, null, 2), 'utf8');
      const { store: store2, manager: manager2 } = await makeManager(dir, { requireSignature: true, trustedKeys });
      await expect(manager2.install(signedWrongKey.pack)).rejects.toThrow(/signature/);
      expect(chunkCount(store2)).toBe(0);
    }

    // Arm 3: requireSignature with the trusted key — a pack signed over the
    // canonical manifest bytes (signature block REMOVED, keys sorted, compact
    // separators, raw UTF-8) installs.
    {
      const dir = makeTempDir('c8-sig-accept-');
      const made = makePackDir(dir, 'c8-signed');
      const signature = cryptoSign(
        null,
        canonicalManifestBytes(fs.readFileSync(path.join(made.pack, 'pack.json'))),
        privateKey,
      );
      made.manifest['signature'] = { algorithm: 'ed25519', key_id: 'c8key', value: signature.toString('base64') };
      fs.writeFileSync(path.join(made.pack, 'pack.json'), JSON.stringify(made.manifest, null, 2), 'utf8');
      const { store, manager } = await makeManager(dir, { requireSignature: true, trustedKeys });
      const result = await manager.install(made.pack);
      expect(result.chunksAdded).toBeGreaterThan(0);
      expect(chunkCount(store)).toBeGreaterThan(0);

      // Tamper the manifest AFTER signing: the signature must stop verifying.
      const tamperedManifest = { ...made.manifest, name: 'C8 Probe TAMPERED' };
      fs.writeFileSync(path.join(made.pack, 'pack.json'), JSON.stringify(tamperedManifest, null, 2), 'utf8');
      const dir2 = makeTempDir('c8-sig-tamper-');
      const { store: store2, manager: manager2 } = await makeManager(dir2, { requireSignature: true, trustedKeys });
      await expect(manager2.install(made.pack)).rejects.toThrow(/signature/);
      expect(chunkCount(store2)).toBe(0);
    }
  });

  itReal('signature negative arms: cross-key-type signature, RSA trusted key, and malformed base64 are refused fail-closed (PRR-009)', async () => {
    const { canonicalManifestBytes } = await loadModules();
    const edPair = generateKeyPairSync('ed25519');
    const trustedKeys = [
      { key_id: 'c8key', public_key: edPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    ];

    // Arm 1: a pack signed by an RSA key but claiming the trusted ed25519
    // key id — the wrong private key simply fails verification.
    {
      const dir = makeTempDir('c8-sig-rsasig-');
      const made = makePackDir(dir, 'c8-rsasig');
      const { privateKey: rsaPrivate } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const signature = cryptoSign(
        null,
        canonicalManifestBytes(fs.readFileSync(path.join(made.pack, 'pack.json'))),
        rsaPrivate,
      );
      made.manifest['signature'] = { algorithm: 'ed25519', key_id: 'c8key', value: signature.toString('base64') };
      fs.writeFileSync(path.join(made.pack, 'pack.json'), JSON.stringify(made.manifest, null, 2), 'utf8');
      const { store, manager } = await makeManager(dir, { requireSignature: true, trustedKeys });
      await expect(manager.install(made.pack)).rejects.toThrow(/signature/);
      expect(chunkCount(store)).toBe(0);
    }

    // Arm 2: an RSA-SPKI entry in trustedKeys — the key-type gate refuses it
    // (a null-digest RSA signature would otherwise VERIFY; PRR-022).
    {
      const dir = makeTempDir('c8-sig-rsakey-');
      const made = makePackDir(dir, 'c8-rsakey');
      const { privateKey: rsaPrivate, publicKey: rsaSpki } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const signature = cryptoSign(
        null,
        canonicalManifestBytes(fs.readFileSync(path.join(made.pack, 'pack.json'))),
        rsaPrivate,
      );
      made.manifest['signature'] = { algorithm: 'ed25519', key_id: 'c8rsakey', value: signature.toString('base64') };
      fs.writeFileSync(path.join(made.pack, 'pack.json'), JSON.stringify(made.manifest, null, 2), 'utf8');
      const rsaTrusted = [
        { key_id: 'c8rsakey', public_key: rsaSpki.export({ format: 'der', type: 'spki' }).toString('base64') },
      ];
      const { store, manager } = await makeManager(dir, { requireSignature: true, trustedKeys: rsaTrusted });
      await expect(manager.install(made.pack)).rejects.toThrow(/signature/);
      expect(chunkCount(store)).toBe(0);
    }

    // Arm 3: a malformed base64 signature value — refused fail-closed.
    {
      const dir = makeTempDir('c8-sig-b64-');
      const made = makePackDir(dir, 'c8-b64');
      made.manifest['signature'] = { algorithm: 'ed25519', key_id: 'c8key', value: '!!!not-base64!!!' };
      fs.writeFileSync(path.join(made.pack, 'pack.json'), JSON.stringify(made.manifest, null, 2), 'utf8');
      const { store, manager } = await makeManager(dir, { requireSignature: true, trustedKeys });
      await expect(manager.install(made.pack)).rejects.toThrow(/signature/);
      expect(chunkCount(store)).toBe(0);
    }
  });
});
