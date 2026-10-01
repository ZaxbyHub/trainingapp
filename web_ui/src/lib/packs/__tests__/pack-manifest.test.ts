// @vitest-environment node
/**
 * Browser install gates (trace browser-training-parity AC1/AC2): the desktop
 * PackManager validatedManifest sequence, one isolating row per gate. Each
 * row's manifest passes every EARLIER gate, so a row fails only when the gate
 * it names stops refusing.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PACKS_SQLITE_VEC_PIN,
  PACK_STORE_SCHEMA_VERSION,
  assertSafeDocPath,
  compareVersions,
  modelIdMatches,
  parseManifest,
  validateManifestGates,
  type ManifestGateConfig,
  type PackManifest,
} from '../pack-manifest';
import { canonicalManifestBytes } from '../pack-verify';

const enc = new TextEncoder();
const DOC = enc.encode(JSON.stringify({ slide_id: 'AAAAAAAAAAA', slide_title: 'Welcome', on_screen_text: 'hi' }));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function manifest(extra: Partial<PackManifest> = {}): PackManifest {
  return {
    id: 'gate-pack',
    name: 'Gate Pack',
    version: '1.0.0',
    published_at: '2026-10-01T00:00:00Z',
    source_class: 'training',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
    docs: [{ path: 'docs/slide-001-AAAAAAAAAAA.json', sha256: sha(DOC), title: 'Welcome', mime: 'application/json' }],
    ...extra,
  };
}

const OFF: ManifestGateConfig = { requireSignature: false, trustedKeys: [], embeddingModelId: 'bge-small-en-v1.5' };
const readDoc = (docs: Record<string, Uint8Array>) => async (p: string) => docs[p] ?? null;
const DOCS = { 'docs/slide-001-AAAAAAAAAAA.json': DOC };

async function gate(m: PackManifest, config: ManifestGateConfig = OFF, docs: Record<string, Uint8Array> = DOCS): Promise<Error | null> {
  try {
    const raw = enc.encode(JSON.stringify(m));
    await validateManifestGates(parseManifest(raw, 'gate.zip'), raw, 'gate.zip', readDoc(docs), config);
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe('browser install gates (desktop validatedManifest order)', () => {
  it('a clean manifest passes every gate', async () => {
    expect(await gate(manifest())).toBeNull();
  });

  it('parse: refuses invalid UTF-8 JSON', () => {
    expect(() => parseManifest(new Uint8Array([0xff, 0xfe]), 'p.zip')).toThrow(/p\.zip: pack\.json is not valid UTF-8 JSON/);
  });

  it('schema: refuses a manifest the schema rejects (missing docs)', () => {
    const raw = enc.encode(JSON.stringify({ ...manifest(), docs: [] }));
    expect(() => parseManifest(raw, 's.zip')).toThrow('pack failed validation: pack.json does not satisfy contracts/pack.schema.json');
  });

  it('doc path safety: refuses a traversal doc path', async () => {
    const m = manifest({ docs: [{ path: '../x.json', sha256: sha(DOC), title: 't', mime: 'application/json' }] });
    expect((await gate(m))?.message).toBe('doc path has a dot segment: ../x.json');
  });

  it('duplicate doc paths are refused', async () => {
    const entry = manifest().docs[0]!;
    expect((await gate(manifest({ docs: [entry, entry] })))?.message).toBe('gate.zip: duplicate docs[].path entries in manifest');
  });

  it('a manifest doc absent from the archive is refused', async () => {
    expect((await gate(manifest(), OFF, {}))?.message).toBe('doc unreadable: docs/slide-001-AAAAAAAAAAA.json: not present in the archive');
  });

  it('per-doc sha256 re-verification refuses tampered doc bytes', async () => {
    const error = await gate(manifest(), OFF, { 'docs/slide-001-AAAAAAAAAAA.json': enc.encode('tampered') });
    expect(error?.name).toBe('PackManagerError');
    expect(error?.message).toMatch(/^doc sha256 mismatch for docs\/slide-001-AAAAAAAAAAA\.json: manifest [0-9a-f]{64}, actual [0-9a-f]{64}$/);
  });

  it('index path safety', async () => {
    const m = manifest({ index: { path: '/abs/index.sqlite', schema_version: PACK_STORE_SCHEMA_VERSION, sqlite_vec_version: PACKS_SQLITE_VEC_PIN } });
    expect((await gate(m))?.message).toBe('doc path is absolute: /abs/index.sqlite');
  });

  it('index schema_version must match the store', async () => {
    const m = manifest({ index: { path: 'index.sqlite', schema_version: 99, sqlite_vec_version: PACKS_SQLITE_VEC_PIN } });
    expect((await gate(m))?.message).toBe('pack index schema_version 99 does not match store schema_version 3; refusing install');
  });

  it('sqlite-vec stamp must match the pin', async () => {
    const m = manifest({ index: { path: 'index.sqlite', schema_version: PACK_STORE_SCHEMA_VERSION, sqlite_vec_version: '0.0.1' } });
    expect((await gate(m))?.message).toMatch(/^pack index sqlite_vec_version 0\.0\.1 does not match the pinned 0\.1\.9/);
  });

  it('embedding-model pin', async () => {
    const m = manifest({ embedding: { model_id: 'other-model', dims: 384, normalize: true } });
    expect((await gate(m))?.message).toMatch(/^refusing to mix embedding spaces: gate-pack@1\.0\.0 was built with embedding model 'other-model'/);
  });

  it('require-signature: unsigned refused when on, accepted when off; a valid signature passes', async () => {
    const seed = createHash('sha256').update('pack-manifest-test').digest();
    const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const pub = createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
    const on: ManifestGateConfig = { requireSignature: true, trustedKeys: [{ key_id: 'k', public_key: pub }], embeddingModelId: 'bge-small-en-v1.5' };
    const unsigned = await gate(manifest(), on);
    expect(unsigned?.message).toBe(
      'gate-pack@1.0.0 failed signature verification (signature block is missing); a trusted ed25519 pack signature is required',
    );
    expect(await gate(manifest(), OFF)).toBeNull();
    const m = manifest();
    const value = sign(null, Buffer.from(canonicalManifestBytes(enc.encode(JSON.stringify(m)))), priv).toString('base64');
    expect(await gate({ ...m, signature: { algorithm: 'ed25519', key_id: 'k', value } }, on)).toBeNull();
  });
});

describe('helpers mirror desktop', () => {
  it.each([
    ['docs\\a', 'doc path has a backslash: docs\\a'],
    ['C:/a', 'doc path is absolute: C:/a'],
    ['', 'doc path is empty'],
    ['docs/./a', 'doc path has a dot segment: docs/./a'],
  ])('assertSafeDocPath(%j)', (value, message) => {
    expect(() => assertSafeDocPath(value)).toThrow(message);
  });

  it('semver precedence (pre-release below release, numeric ids numerically)', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0+b1', '1.0.0+b2')).toBe(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/unsupported pack version/);
  });

  it('model ids compare by basename, case-folded', () => {
    expect(modelIdMatches('BAAI/bge-small-en-v1.5', 'bge-small-en-v1.5')).toBe(true);
    expect(modelIdMatches('bge-base', 'bge-small-en-v1.5')).toBe(false);
  });
});
