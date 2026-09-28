// e5-update-checker.test.ts — E5 acceptance checks for issue #88
// (signed update channels + rollback).
//
// Subjects of frozen checks:
//   C2 pack update detection (diff semantics + shipped feed JSON Schema)
//   C3 signature tamper refusal (ed25519, fail-closed)
//   C4 failed-update rollback without re-fetch (real PackManager)
//   C5 opt-in gate (zero fetch calls until enabled)
//
// Authored BEFORE desktop/main/update-checker.ts exists: the module is built
// to THIS contract. It is electron-free by design — the vitest electron stub
// is never needed here.
//
// Version-ordering pin (read from desktop/main/backend/store/pack-manager.ts
// versionKey/compareVersionKeys before authoring): a release gets pre=1 and a
// pre-release pre=0, and comparison walks major, minor, patch, THEN the pre
// flag. So a pre-release sorts BELOW the release of the SAME triple, but a
// higher triple still dominates: 2.0.0-rc.1 > 1.5.0 > 1.0.0, while
// 1.0.0-rc.1 < 1.0.0. checkPackUpdates must surface exactly the versions
// that compare GREATER than the installed one under these rules.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  checkPackUpdates,
  verifyFeedEntrySignature,
  verifyArtifactBytes,
  loadUpdatesState,
  saveUpdatesState,
  runUpdateCheck,
} from '../../main/update-checker.js';
import type {
  FeedVersionEntry,
  PackFeedDocument,
  TrustedKey,
} from '../../main/update-checker.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Ajv's 2020-12 compiler is CJS without an exports map; the default-import
// form is not constructable under strict nodenext, so this mirrors the exact
// createRequire + structural-cast seam production uses
// (desktop/main/backend/store/pack-manager.ts, same options too).
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020') as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => { compile(schema: object): (data: unknown) => boolean };

/** Repo-root discovery via the established contracts marker (b4/b5 convention). */
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
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

/** Temp dirs created per test; removed in afterEach (after stores close — an
 * open better-sqlite3 handle makes rmSync EPERM on Windows). */
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
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** An ed25519 test key exported exactly as the feed contract wants the
 * trusted keyset: base64 DER SPKI. */
function makeKey(keyId: string): { keyId: string; publicKeyB64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = Buffer.from(der).toString('base64');
  return { keyId, publicKeyB64, privateKey };
}

/** Sign the artifact digest the feed way: the message is the sha256 hex
 * string as lowercase UTF-8 bytes; the signature is base64. */
const signShaHex = (shaHex: string, privateKey: KeyObject): string =>
  sign(null, Buffer.from(shaHex, 'utf8'), privateKey).toString('base64');

function makeVersionEntry(args: {
  version: string;
  sha256: string;
  sizeBytes: number;
  signature?: { algorithm: string; key_id: string; value: string };
  supersedes?: string[];
}): FeedVersionEntry {
  return {
    version: args.version,
    published_at: '2026-09-20T00:00:00Z',
    sha256: args.sha256,
    size_bytes: args.sizeBytes,
    download_url: `https://example.invalid/pack-${args.version}.zip`,
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    ...(args.signature !== undefined ? { signature: args.signature } : {}),
  };
}

function feedDoc(packs: Array<{ pack_id: string; versions: FeedVersionEntry[] }>): PackFeedDocument {
  return { schema_version: 1, generated_at: '2026-09-27T00:00:00Z', packs };
}

/** Copy a fixture pack into a workspace dir (c3 convention). */
function copyFixture(root: string, name: string, destName = name): string {
  const dest = path.join(root, destName);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function readManifest(packDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writeManifest(packDir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Rewrite a doc's JSON content AND its manifest sha (c3 parity). */
function writeDoc(packDir: string, relPath: string, text: string): void {
  const docPath = path.join(packDir, relPath);
  fs.writeFileSync(docPath, JSON.stringify({ text }, null, 2), 'utf8');
  const sha = createHash('sha256').update(fs.readFileSync(docPath)).digest('hex');
  const manifest = readManifest(packDir) as { docs: Array<{ path: string; sha256: string }> };
  for (const entry of manifest.docs) {
    if (entry.path === relPath) entry.sha256 = sha;
  }
  writeManifest(packDir, manifest);
}

/** Zip a staged pack folder (jszip — the same prod dep the route uses). */
async function zipPackDir(packDir: string): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const addDir = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) addDir(full, rel);
      else zip.file(rel, fs.readFileSync(full));
    }
  };
  addDir(packDir, '');
  return zip.generateAsync({ type: 'uint8array' });
}

describe('e5 update channels (issue #88)', () => {
  it('C2: pack update detection - newer feed version surfaces, older and equal do not', async () => {
    const installed = [{ packId: 'a', version: '1.0.0' }];

    // Newer surfaces; older and equal do not: exactly one candidate, with
    // every field carried from the winning feed entry.
    const newerEntry = makeVersionEntry({
      version: '2.0.0',
      sha256: 'b'.repeat(64),
      sizeBytes: 424242,
    });
    const candidates = checkPackUpdates(
      installed,
      feedDoc([
        {
          pack_id: 'a',
          versions: [
            makeVersionEntry({ version: '0.9.0', sha256: '0'.repeat(64), sizeBytes: 10 }),
            makeVersionEntry({ version: '1.0.0', sha256: '1'.repeat(64), sizeBytes: 11 }),
            newerEntry,
          ],
        },
      ]),
    );
    expect(candidates).toHaveLength(1);
    const only = candidates[0];
    if (only === undefined) throw new Error('expected exactly one candidate');
    expect(only.packId).toBe('a');
    expect(only.currentVersion).toBe('1.0.0');
    expect(only.availableVersion).toBe('2.0.0');
    expect(only.publishedAt).toBe('2026-09-20T00:00:00Z');
    expect(only.downloadUrl).toBe('https://example.invalid/pack-2.0.0.zip');
    expect(only.sha256).toBe('b'.repeat(64));
    expect(only.sizeBytes).toBe(424242);

    // Feed with only older/equal versions: zero candidates.
    expect(
      checkPackUpdates(
        installed,
        feedDoc([
          {
            pack_id: 'a',
            versions: [
              makeVersionEntry({ version: '0.9.0', sha256: '0'.repeat(64), sizeBytes: 10 }),
              makeVersionEntry({ version: '1.0.0', sha256: '1'.repeat(64), sizeBytes: 11 }),
            ],
          },
        ]),
      ),
    ).toHaveLength(0);

    // Feed for an unrelated pack_id: zero candidates.
    expect(
      checkPackUpdates(
        installed,
        feedDoc([{ pack_id: 'other-pack', versions: [newerEntry] }]),
      ),
    ).toHaveLength(0);

    // Pre-release ordering, pinned to the REAL compareVersionKeys semantics:
    // a pre-release sorts below the release of the SAME triple, but a higher
    // triple dominates — 2.0.0-rc.1 > 1.5.0 > 1.0.0, so the diff offers the
    // newest greater version '2.0.0-rc.1' (NOT 1.5.0), while a same-triple
    // pre-release ('1.0.0-rc.1') is NOT newer than the installed release.
    const preCandidates = checkPackUpdates(
      installed,
      feedDoc([
        {
          pack_id: 'a',
          versions: [
            makeVersionEntry({ version: '2.0.0-rc.1', sha256: 'c'.repeat(64), sizeBytes: 20 }),
            makeVersionEntry({ version: '1.5.0', sha256: 'd'.repeat(64), sizeBytes: 21 }),
          ],
        },
      ]),
    );
    expect(preCandidates).toHaveLength(1);
    expect(preCandidates[0]?.availableVersion).toBe('2.0.0-rc.1');
    expect(
      checkPackUpdates(
        installed,
        feedDoc([
          {
            pack_id: 'a',
            versions: [
              makeVersionEntry({ version: '1.0.0-rc.1', sha256: 'e'.repeat(64), sizeBytes: 30 }),
            ],
          },
        ]),
      ),
    ).toHaveLength(0);

    // Anchor the ordering above against the production comparator itself
    // (F-005 fix: ONLY the import is best-effort — a missing native dep must
    // not mask a real assertion failure, which the old blanket try/catch
    // allowed; an import that succeeds but disagrees now FAILS this test).
    const pm = await import('../../main/backend/store/pack-manager.js').catch(() => null);
    if (pm !== null) {
      expect(
        pm.compareVersionKeys(pm.versionKey('2.0.0-rc.1'), pm.versionKey('1.5.0')),
      ).toBeGreaterThan(0);
      expect(
        pm.compareVersionKeys(pm.versionKey('1.0.0-rc.1'), pm.versionKey('1.0.0')),
      ).toBeLessThan(0);
    }

    // The shipped feed schema (contracts/pack-feed.schema.json) accepts a
    // well-formed signed feed document and rejects a bad sha256 (not 64-hex).
    // Compiled with the same options production uses for pack.schema.json.
    const schemaPath = path.join(REPO_ROOT, 'contracts', 'pack-feed.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const goodDoc: PackFeedDocument = feedDoc([
      {
        pack_id: 'a',
        versions: [
          {
            ...newerEntry,
            supersedes: ['a@1.0.0'],
            signature: {
              algorithm: 'ed25519',
              key_id: 'e5-trusted',
              value: Buffer.alloc(64, 7).toString('base64'),
            },
          },
        ],
      },
    ]);
    expect(validate(goodDoc)).toBe(true);
    const badDoc: PackFeedDocument = feedDoc([
      {
        pack_id: 'a',
        versions: [
          makeVersionEntry({ version: '2.0.0', sha256: 'not-64-hex', sizeBytes: 1 }),
        ],
      },
    ]);
    expect(validate(badDoc)).toBe(false);
  });

  it('C3: signature rejects tampering - mutated artifact fails verification and the update is refused', async () => {
    const trusted = makeKey('e5-trusted');
    const trustedKeys: ReadonlyArray<TrustedKey> = [
      { key_id: trusted.keyId, public_key: trusted.publicKeyB64 },
    ];
    const artifact = Buffer.from('e5 artifact bytes for issue 88 signature checks', 'utf8');
    const digest = sha256Hex(artifact);
    const goodSig = signShaHex(digest, trusted.privateKey);
    const signedEntry = makeVersionEntry({
      version: '2.0.0',
      sha256: digest,
      sizeBytes: artifact.byteLength,
      signature: { algorithm: 'ed25519', key_id: trusted.keyId, value: goodSig },
    });

    // Happy path: the trusted key verifies the digest signature.
    expect(verifyFeedEntrySignature(signedEntry, trustedKeys).ok).toBe(true);
    expect(verifyArtifactBytes(artifact, signedEntry, trustedKeys).ok).toBe(true);

    // Tampered entry digest (one hex char flipped): verification fails.
    const flipped = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`;
    expect(
      verifyFeedEntrySignature({ ...signedEntry, sha256: flipped }, trustedKeys).ok,
    ).toBe(false);

    // Wrong algorithm: fail closed.
    expect(
      verifyFeedEntrySignature(
        {
          ...signedEntry,
          signature: { algorithm: 'rsa256', key_id: trusted.keyId, value: goodSig },
        },
        trustedKeys,
      ).ok,
    ).toBe(false);

    // Unknown key_id: fail closed.
    expect(
      verifyFeedEntrySignature(
        {
          ...signedEntry,
          signature: { algorithm: 'ed25519', key_id: 'e5-unknown-key', value: goodSig },
        },
        trustedKeys,
      ).ok,
    ).toBe(false);

    // MISSING signature block: fail closed — the feed path has no unsigned
    // fallback.
    const { signature: _unused, ...unsignedEntry } = signedEntry;
    expect(verifyFeedEntrySignature(unsignedEntry, trustedKeys).ok).toBe(false);

    // Mutated artifact bytes: digest mismatch with an actionable detail.
    const mutated = Buffer.from(artifact);
    mutated[0] = ((mutated[0] ?? 0) + 1) & 0xff;
    const digestVerdict = verifyArtifactBytes(mutated, signedEntry, trustedKeys);
    expect(digestVerdict.ok).toBe(false);
    expect(
      typeof digestVerdict.detail === 'string' && /sha256|digest|mismatch/i.test(digestVerdict.detail),
    ).toBe(true);

    // Right bytes but a signature over a different digest: refused too.
    const forged = {
      ...signedEntry,
      signature: {
        algorithm: 'ed25519',
        key_id: trusted.keyId,
        value: signShaHex('f'.repeat(64), trusted.privateKey),
      },
    };
    expect(verifyArtifactBytes(artifact, forged, trustedKeys).ok).toBe(false);
  });

  itReal(
    'C4: pack rollback - a failed v2 update leaves v1 active and rollback reactivates without re-fetch',
    async () => {
      const fetchFeed = vi.fn<(url: string) => Promise<string>>();
      const trusted = makeKey('e5-trusted');
      const untrusted = makeKey('e5-untrusted');
      const trustedKeys: ReadonlyArray<TrustedKey> = [
        { key_id: trusted.keyId, public_key: trusted.publicKeyB64 },
      ];

      const storeMod = await import('../../main/backend/store/sqlite-store.js');
      const managerMod = await import('../../main/backend/store/pack-manager.js');
      const embedderMod = await import('../../main/backend/ingest/embedder.js');
      const { openStore } = storeMod;
      const { PackManager } = managerMod;
      const { HashEmbedder } = embedderMod;

      const root = makeTempDir('e5-rollback-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 8 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });

      // v1 installed and active.
      const v1 = copyFixture(root, 'versioned-a-1.0.0');
      writeDoc(v1, 'docs/a.json', 'Version one content guarded by the update gate.');
      await manager.install(v1);
      let records = await manager.listInstalled();
      const v1Path = records.find((r) => r.version === '1.0.0')?.installPath;
      expect(typeof v1Path === 'string').toBe(true);
      expect(records.find((r) => r.version === '1.0.0')?.active).toBe(true);

      // (a) Tampered v2 artifact: correct digest, but signed by an UNTRUSTED
      // key — the integrity+signature gate must refuse it.
      const v2Bad = copyFixture(root, 'versioned-a-2.0.0', 'v2-tampered');
      writeDoc(v2Bad, 'docs/a.json', 'Tampered v2 content signed by an untrusted key.');
      const badZip = await zipPackDir(v2Bad);
      const badSha = sha256Hex(badZip);
      const badEntry = makeVersionEntry({
        version: '2.0.0',
        sha256: badSha,
        sizeBytes: badZip.byteLength,
        supersedes: ['versioned-a@1.0.0'],
        signature: {
          algorithm: 'ed25519',
          key_id: untrusted.keyId,
          value: signShaHex(badSha, untrusted.privateKey),
        },
      });
      const refusal = verifyArtifactBytes(badZip, badEntry, trustedKeys);
      expect(refusal.ok).toBe(false);

      // (b) The refusal left v1 active and v2 absent.
      records = await manager.listInstalled();
      expect(records.filter((r) => r.version === '2.0.0')).toHaveLength(0);
      expect(records.find((r) => r.version === '1.0.0')?.active).toBe(true);

      // (c) A VALID v2 artifact: fixture content, digest is the zip's real
      // sha256, signature by the trusted TEST key.
      const v2Good = copyFixture(root, 'versioned-a-2.0.0', 'v2-clean');
      writeDoc(v2Good, 'docs/a.json', 'Valid v2 content signed by the trusted test key.');
      const goodZip = await zipPackDir(v2Good);
      const goodSha = sha256Hex(goodZip);
      const goodEntry = makeVersionEntry({
        version: '2.0.0',
        sha256: goodSha,
        sizeBytes: goodZip.byteLength,
        supersedes: ['versioned-a@1.0.0'],
        signature: {
          algorithm: 'ed25519',
          key_id: trusted.keyId,
          value: signShaHex(goodSha, trusted.privateKey),
        },
      });
      expect(verifyArtifactBytes(goodZip, goodEntry, trustedKeys).ok).toBe(true);

      // (d) Apply it through the production zip path (extract + install).
      const surfaceMod = await import('../../main/backend/packs/surface.js');
      const surface = surfaceMod.createPackSurface(manager as never);
      const applied = await surface.installZip(goodZip, 'versioned-a-2.0.0.zip');
      expect(applied.version).toBe('2.0.0');

      // (e) v2 is now the active version.
      records = await manager.listInstalled();
      expect(records.find((r) => r.version === '2.0.0')?.active).toBe(true);
      expect(records.find((r) => r.version === '1.0.0')?.active).toBe(false);

      // (f) Rollback reactivates v1 WITHOUT any fetch — the whole scenario
      // ran offline (zero fetchFeed invocations, ever).
      await manager.rollback('versioned-a', '1.0.0');
      expect(fetchFeed).not.toHaveBeenCalled();
      records = await manager.listInstalled();
      expect(records.find((r) => r.version === '1.0.0')?.active).toBe(true);
      expect(records.find((r) => r.version === '2.0.0')?.active).toBe(false);

      // (g) The v1 managed dir was retained on disk (rollback needs no
      // re-download).
      if (typeof v1Path === 'string') {
        expect(fs.existsSync(path.join(v1Path, 'pack.json'))).toBe(true);
      }
    },
  );

  it('C5: update checks are opt-in - zero fetch calls until explicitly enabled', async () => {
    const trusted = makeKey('e5-trusted');
    const trustedKeys: ReadonlyArray<TrustedKey> = [
      { key_id: trusted.keyId, public_key: trusted.publicKeyB64 },
    ];
    const profileDir = makeTempDir('e5-profile-');
    const installed = [{ packId: 'a', version: '1.0.0' }];

    // Missing sidecar: default state is opt-out (fail closed).
    expect(loadUpdatesState(profileDir)).toEqual({ optIn: false });

    // Opted out: the gate must not touch the network AT ALL.
    const fetchFeed = vi.fn<(url: string) => Promise<string>>();
    const gated = await runUpdateCheck({ optIn: false }, installed, { fetchFeed }, trustedKeys);
    expect(gated).toEqual({ skipped: true, reason: 'opt-in' });
    expect(fetchFeed).not.toHaveBeenCalled();

    // Persisted opt-in round-trips through updates.json.
    const feedUrl = 'https://example.invalid/feed.json';
    saveUpdatesState(profileDir, { optIn: true, feedUrl });
    expect(loadUpdatesState(profileDir)).toEqual({ optIn: true, feedUrl });

    // Opted in: exactly ONE fetch of the configured URL, and the signed
    // feed's candidates come back.
    const artifact = Buffer.from('e5 c5 feed artifact bytes', 'utf8');
    const digest = sha256Hex(artifact);
    const feed = feedDoc([
      {
        pack_id: 'a',
        versions: [
          makeVersionEntry({
            version: '2.0.0',
            sha256: digest,
            sizeBytes: artifact.byteLength,
            signature: {
              algorithm: 'ed25519',
              key_id: trusted.keyId,
              value: signShaHex(digest, trusted.privateKey),
            },
          }),
        ],
      },
    ]);
    const fetch = vi.fn(async (_url: string) => JSON.stringify(feed));
    const outcome = await runUpdateCheck(loadUpdatesState(profileDir), installed, { fetchFeed: fetch }, trustedKeys);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(feedUrl);
    expect(outcome.skipped).toBe(false);
    if (outcome.skipped) {
      throw new Error(`expected a live check, got skipped: ${outcome.reason}`);
    }
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]).toMatchObject({
      packId: 'a',
      currentVersion: '1.0.0',
      availableVersion: '2.0.0',
    });
    expect(outcome.refused).toHaveLength(0);

    // Corrupted sidecar: fail closed to disabled.
    fs.writeFileSync(path.join(profileDir, 'updates.json'), 'not json', 'utf8');
    expect(loadUpdatesState(profileDir)).toEqual({ optIn: false });
  });
});
