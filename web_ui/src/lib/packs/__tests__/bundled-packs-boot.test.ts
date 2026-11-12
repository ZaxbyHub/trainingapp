// @vitest-environment node
/**
 * #266 (AC12, frozen check C9): the boot ensure installs an unsatisfied
 * bundled pack exactly once through the REAL guarded install path (Memory
 * registry + store), with keyword-first ingestion and vector-embeddings left
 * PENDING when the embedder is not ready — and drives the polite status line.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

import { BrowserPackManager, type PackIndexHooks } from '../browser-pack-manager';
import { MemoryPackFileStore, MemoryPackRegistry } from '../pack-store-opfs';
import { buildRawZip } from './zip-fixture';
import {
  BUNDLED_PACKS_STATUS_TEXT,
  ensureBundledPacksInBrowser,
  resetBundledPacksBootForTests,
  type BundledPackManifestEntry,
  type BundledPacksManifest,
  isBundledPacksBootEligible,
  resolvePacksBase,
} from '../bundled-packs-boot';

const enc = new TextEncoder();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const DOC = enc.encode(
  JSON.stringify({ slide_id: 'AAAAAAAAAAA', slide_title: 'Welcome', section_title: 'Intro', on_screen_text: 'Hello' }),
);

function buildPackZip(id: string, version: string): { zip: Uint8Array; entry: BundledPackManifestEntry } {
  const manifest = {
    id,
    name: `Pack ${id}`,
    version,
    published_at: '2026-10-01T00:00:00Z',
    source_class: 'bundled',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
    docs: [{ path: 'docs/slide-001-AAAAAAAAAAA.json', sha256: sha(DOC), title: 'Welcome', mime: 'application/json' }],
  };
  const zip = buildRawZip([
    { name: 'pack.json', data: JSON.stringify(manifest) },
    { name: 'docs/slide-001-AAAAAAAAAAA.json', data: DOC },
    { name: 'assets/player/story.html', data: `<html>${id}</html>`, method: 8 },
  ]);
  return {
    zip,
    entry: { id, version, file: `${id}-${version}.zip`, sha256: sha(zip), size: zip.byteLength },
  };
}

function fakeFetch(manifest: BundledPacksManifest, zips: Map<string, Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('packs.manifest.json')) {
      return { ok: true, status: 200, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }
    const name = url.split('/').pop() ?? '';
    const bytes = zips.get(name);
    if (bytes === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * The production-shaped manager: REAL install path over the Memory stores,
 * with the production hooks' SEMANTICS — keyword-first ingest immediately,
 * vectors left PENDING when the embedder is not ready (embedded stays unset).
 */
function setupManager() {
  const files = new MemoryPackFileStore();
  const registry = new MemoryPackRegistry();
  const keywordIndexed: string[] = [];
  const hooks: PackIndexHooks = {
    onInstalled: async (record, manifest) => {
      // Keyword-first: the pack's docs land in the keyword index immediately.
      keywordIndexed.push(`${record.packId}@${record.version}:${manifest.docs.length}`);
    },
    onRemoved: async () => undefined,
    onActivated: async () => undefined,
  };
  const manager = new BrowserPackManager({
    registry,
    files,
    hooks,
    storage: { estimate: vi.fn(async () => ({ quota: 1024 * 1024 * 1024, usage: 0 })), persist: vi.fn(async () => true), persisted: vi.fn(async () => true) },
    gateConfig: () => ({ requireSignature: false, trustedKeys: [], embeddingModelId: 'bge-small-en-v1.5' }),
    capabilities: () => [],
    nonce: () => 'n1',
  });
  return { manager, registry, files, keywordIndexed };
}

describe('ensureBundledPacksInBrowser installs unsatisfied packs (#266 AC12)', () => {
  it('installs the unsatisfied bundled pack exactly once, keyword-first, vectors pending', async () => {
    resetBundledPacksBootForTests();
    const { manager, registry, keywordIndexed } = setupManager();
    const a = buildPackZip('bundled-a', '1.0.0');
    const manifest: BundledPacksManifest = { packs: [a.entry] };

    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fakeFetch(manifest, new Map([[a.entry.file, a.zip]])),
    });

    expect(result.manifestError).toBeUndefined();
    expect(result.results).toEqual([{ id: 'bundled-a', outcome: 'installed', version: '1.0.0' }]);
    // Exactly ONE install: one registry row, keyword-indexed once.
    const rows = await registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ packId: 'bundled-a', version: '1.0.0', active: true });
    expect(keywordIndexed).toEqual(['bundled-a@1.0.0:1']);
    // Vector side PENDING: the embedder was not ready, so the record's
    // embedded flag was never set to true.
    expect(rows[0]?.embedded).not.toBe(true);
  });

  it('drives the polite status line: set while work runs, cleared at the end', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setupManager();
    const a = buildPackZip('bundled-a', '1.0.0');
    const statuses: Array<string | null> = [];
    await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fakeFetch({ packs: [a.entry] }, new Map([[a.entry.file, a.zip]])),
      onStatus: (text) => statuses.push(text),
    });
    expect(statuses[0]).toBe(BUNDLED_PACKS_STATUS_TEXT);
    expect(statuses[statuses.length - 1]).toBeNull();
  });

  it('no status line when everything is already satisfied (the every-boot fast path)', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setupManager();
    const statuses: Array<string | null> = [];
    await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fakeFetch({ packs: [] }, new Map()),
      onStatus: (text) => statuses.push(text),
    });
    expect(statuses).toEqual([]);
  });

  it('a missing manifest is not an error and installs nothing (never throws)', async () => {
    resetBundledPacksBootForTests();
    const { manager, registry } = setupManager();
    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: (async () => ({ ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(result.results).toEqual([]);
    expect(result.manifestError).toMatch(/404/);
    expect(await registry.list()).toEqual([]);
  });

  it('REL-2: a browser missing pack capabilities skips the ensure entirely — zero fetches, no status, manifestError names the miss', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setupManager();
    // The real manager with the capability probe saying OPFS is missing —
    // the exact BrowserPackManager.missingCapabilities surface the ensure
    // gates on before anything else.
    vi.spyOn(manager, 'missingCapabilities').mockReturnValue(['OPFS']);
    let fetchCalls = 0;
    const fetchSpy = (async () => {
      fetchCalls += 1;
      return { ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;
    const statuses: Array<string | null> = [];
    const failures: Array<[string, string]> = [];

    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fetchSpy,
      onStatus: (text) => statuses.push(text),
      onPackFailure: (packId, detail) => failures.push([packId, detail]),
    });

    // Not even the MANIFEST was fetched; no status raised; no per-pack toast.
    expect(fetchCalls).toBe(0);
    expect(statuses).toEqual([]);
    expect(failures).toEqual([]);
    expect(result.results).toEqual([]);
    // The miss is named through manifestError (the component warns it).
    expect(result.manifestError).toMatch(/OPFS/);
  });

  it('COR-2: a throwing satisfaction screen is that pack\'s named failure; the OTHER pack still installs and the status clears', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setupManager();
    // Seed an ACTIVE record for the same id as a manifest entry whose version
    // "1.0" is not semver — compareVersions throws inside the satisfaction
    // screen, which used to sit OUTSIDE the per-pack try (it would abort the
    // whole ensure and strand the status line).
    const seeded = buildPackZip('screen-throw', '1.0.0');
    await manager.installPack(Object.assign(new Blob([seeded.zip as Uint8Array<ArrayBuffer>]), { name: seeded.entry.file }));
    const good = buildPackZip('good-pack', '1.0.0');
    const badEntry: BundledPackManifestEntry = { ...seeded.entry, version: '1.0' };
    const failures: Array<[string, string]> = [];
    const statuses: Array<string | null> = [];

    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fakeFetch({ packs: [badEntry, good.entry] }, new Map([[good.entry.file, good.zip]])),
      onPackFailure: (packId, detail) => failures.push([packId, detail]),
      onStatus: (text) => statuses.push(text),
    });

    // The throwing screen became THAT pack's named failure...
    expect(result.results[0]).toMatchObject({ id: 'screen-throw', outcome: 'failed' });
    expect(failures).toEqual([['screen-throw', expect.stringContaining('semver')]]);
    // ...the OTHER pack still installed...
    expect(result.results[1]).toEqual({ id: 'good-pack', outcome: 'installed', version: '1.0.0' });
    expect(await manager.activeRecords()).toHaveLength(2);
    // ...and the status line was cleared (not stranded) despite the throw.
    expect(statuses[statuses.length - 1]).toBeNull();
  });

  it('boot eligibility: skipped in Electron (desktopApi present) and in framed contexts; eligible in the plain browser app', () => {
    const electronScope = { desktopApi: {}, self: {} };
    expect(isBundledPacksBootEligible(electronScope)).toBe(false);
    const framedScope = { self: {} as unknown };
    (framedScope as { self: { top?: unknown } }).self.top = { sentinel: 1 };
    expect(isBundledPacksBootEligible(framedScope)).toBe(false);
    const plain: { self: unknown; desktopApi?: unknown } = { self: {} };
    (plain.self as { top?: unknown }).top = plain.self;
    expect(isBundledPacksBootEligible(plain)).toBe(true);
  });

  it('resolvePacksBase is deploy-aware: subpath deployments fetch /docqa/packs/, origin root stays /packs/ (final critic r1)', () => {
    const g = globalThis as { document?: { baseURI?: string } };
    const saved = g.document;
    const env = import.meta.env as { BASE_URL?: string };
    const savedBase = env.BASE_URL;
    try {
      env.BASE_URL = './';
      g.document = { baseURI: 'https://host/docqa/app/' };
      expect(resolvePacksBase()).toBe('/docqa/app/packs/');
      g.document = { baseURI: 'https://host/' };
      expect(resolvePacksBase()).toBe('/packs/');
    } finally {
      g.document = saved;
      env.BASE_URL = savedBase;
    }
  });
});
