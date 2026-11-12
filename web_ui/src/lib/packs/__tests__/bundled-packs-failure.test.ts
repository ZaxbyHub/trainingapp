// @vitest-environment node
/**
 * #266 (AC14, frozen check C11): per-pack failure isolation — one bundled
 * pack failing (fetch 404, size or sha256 mismatch) never aborts the others,
 * never throws out of the ensure, and the notice NAMES the pack. The app
 * stays usable.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

import { BrowserPackManager, type PackIndexHooks } from '../browser-pack-manager';
import { MemoryPackFileStore, MemoryPackRegistry } from '../pack-store-opfs';
import { buildRawZip } from './zip-fixture';
import {
  ensureBundledPacksInBrowser,
  resetBundledPacksBootForTests,
  type BundledPackManifestEntry,
  type BundledPacksManifest,
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
  return { zip, entry: { id, version, file: `${id}-${version}.zip`, sha256: sha(zip), size: zip.byteLength } };
}

function okResponse(bytes: Uint8Array, json: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function setup() {
  const files = new MemoryPackFileStore();
  const registry = new MemoryPackRegistry();
  const hooks: PackIndexHooks = { onInstalled: vi.fn(async () => undefined), onRemoved: vi.fn(async () => undefined), onActivated: vi.fn(async () => undefined) };
  const manager = new BrowserPackManager({
    registry,
    files,
    hooks,
    storage: { estimate: vi.fn(async () => ({ quota: 1024 * 1024 * 1024, usage: 0 })), persist: vi.fn(async () => true), persisted: vi.fn(async () => true) },
    gateConfig: () => ({ requireSignature: false, trustedKeys: [], embeddingModelId: 'bge-small-en-v1.5' }),
    capabilities: () => [],
    nonce: () => 'n1',
  });
  return { manager, registry };
}

/**
 * A fetch impl with per-pack behaviors: 'ok' serves the real zip, 'missing'
 * 404s, 'wrong-sha' serves bytes whose digest disagrees with the entry.
 */
function fetchWith(manifest: BundledPacksManifest, zips: Map<string, { zip: Uint8Array; behavior: 'ok' | 'missing' | 'wrong-sha' }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('packs.manifest.json')) return okResponse(enc.encode(JSON.stringify(manifest)), manifest);
    const name = url.split('/').pop() ?? '';
    const staged = zips.get(name);
    if (staged === undefined || staged.behavior === 'missing') {
      return { ok: false, status: 404 } as unknown as Response;
    }
    if (staged.behavior === 'wrong-sha') {
      const tampered = new Uint8Array(staged.zip);
      tampered[0] ^= 0xff;
      return okResponse(tampered);
    }
    return okResponse(staged.zip);
  }) as unknown as typeof fetch;
}

describe('ensureBundledPacksInBrowser per-pack failure isolation (#266 AC14)', () => {
  it('a failing pack is isolated: the other pack installs, the notice NAMES the pack, nothing throws', async () => {
    resetBundledPacksBootForTests();
    const { manager, registry } = setup();
    const failing = buildPackZip('bundled-bad', '1.0.0');
    const good = buildPackZip('bundled-good', '1.0.0');
    const manifest: BundledPacksManifest = { packs: [failing.entry, good.entry] };
    const failures: Array<[string, string]> = [];
    const statuses: Array<string | null> = [];

    // Fails FIRST — isolation means the LATER pack still installs.
    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fetchWith(
        manifest,
        new Map([
          [failing.entry.file, { zip: failing.zip, behavior: 'missing' }],
          [good.entry.file, { zip: good.zip, behavior: 'ok' }],
        ]),
      ),
      onPackFailure: (id, detail) => failures.push([id, detail]),
      onStatus: (t) => statuses.push(t),
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ id: 'bundled-bad', outcome: 'failed' });
    expect(result.results[1]).toEqual({ id: 'bundled-good', outcome: 'installed', version: '1.0.0' });
    // The notice names the pack.
    expect(failures).toHaveLength(1);
    expect(failures[0]![0]).toBe('bundled-bad');
    expect(failures[0]![1]).toMatch(/404/);
    // The app stays usable: the good pack is installed and ACTIVE, and the
    // status line cleared even though a pack failed.
    expect(await registry.list()).toHaveLength(1);
    // activeRecords() only returns ACTIVE rows by definition — the good pack
    // is the one active record.
    expect(await manager.activeRecords()).toMatchObject([{ packId: 'bundled-good', version: '1.0.0' }]);
    expect(statuses[statuses.length - 1]).toBeNull();
  });

  it('a sha256 mismatch fails only that pack (the artifact does not match the manifest)', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setup();
    const a = buildPackZip('bundled-a', '1.0.0');
    const failures: Array<[string, string]> = [];
    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fetchWith({ packs: [a.entry] }, new Map([[a.entry.file, { zip: a.zip, behavior: 'wrong-sha' }]])),
      onPackFailure: (id, detail) => failures.push([id, detail]),
    });
    expect(result.results).toEqual([{ id: 'bundled-a', outcome: 'failed', detail: expect.stringMatching(/sha256 mismatch/) }]);
    expect(failures[0]![0]).toBe('bundled-a');
    expect(await manager.activeRecords()).toEqual([]);
  });

  it('a size mismatch is refused before install', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setup();
    const a = buildPackZip('bundled-a', '1.0.0');
    const entry = { ...a.entry, size: a.entry.size + 1 };
    const result = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fetchWith({ packs: [entry] }, new Map([[a.entry.file, { zip: a.zip, behavior: 'ok' }]])),
      onPackFailure: () => undefined,
    });
    expect(result.results[0]).toMatchObject({ id: 'bundled-a', outcome: 'failed' });
    expect((result.results[0] as { detail: string }).detail).toMatch(/size mismatch/);
  });
});
