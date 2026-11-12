// @vitest-environment node
/**
 * #266 (AC13, frozen check C10): the boot ensure is idempotent — a second
 * boot with the record installed (or NEWER) installs nothing and leaves the
 * record untouched; satisfaction is screened BEFORE installPack; and an
 * install that loses a race to a concurrent equal-version install (the throw
 * installPack makes on an equal ACTIVE version) counts as SUCCESS after the
 * post-error satisfaction re-check.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

import { BrowserPackManager, type PackIndexHooks } from '../browser-pack-manager';
import { MemoryPackFileStore, MemoryPackRegistry } from '../pack-store-opfs';
import { buildRawZip } from './zip-fixture';
import {
  ensureBundledPacksInBrowser,
  isBundledPackSatisfied,
  resetBundledPacksBootForTests,
  type BundledPackManifestEntry,
  type BundledPacksManifest,
  type BundledPacksManagerSurface,
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

function response(bytes: Uint8Array, json: unknown = {}): Response {
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
  const installPackSpy = vi.spyOn(manager, 'installPack');
  const activeRecordsSpy = vi.spyOn(manager, 'activeRecords');
  return { manager, registry, hooks, installPackSpy, activeRecordsSpy };
}

function fetchFor(manifest: BundledPacksManifest, zips: Map<string, Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('packs.manifest.json')) {
      return response(enc.encode(JSON.stringify(manifest)), manifest);
    }
    const name = url.split('/').pop() ?? '';
    const bytes = zips.get(name);
    if (bytes === undefined) return { ok: false, status: 404 } as unknown as Response;
    return response(bytes);
  }) as unknown as typeof fetch;
}

describe('ensureBundledPacksInBrowser idempotency (#266 AC13)', () => {
  it('satisfaction is screened BEFORE installPack (the screen is required: installPack throws on an equal active version)', async () => {
    resetBundledPacksBootForTests();
    const { manager, installPackSpy, activeRecordsSpy } = setup();
    const a = buildPackZip('bundled-a', '1.0.0');
    const fetchImpl = fetchFor({ packs: [a.entry] }, new Map([[a.entry.file, a.zip]]));

    // First boot: install.
    await ensureBundledPacksInBrowser({ manager, fetchImpl });
    expect(installPackSpy).toHaveBeenCalledTimes(1);

    // The screen ran before the install on the FIRST boot too.
    const firstActive = activeRecordsSpy.mock.invocationCallOrder[0]!;
    const firstInstall = installPackSpy.mock.invocationCallOrder[0]!;
    expect(firstActive).toBeLessThan(firstInstall);

    // Second boot: satisfied, zero installs, record untouched.
    installPackSpy.mockClear();
    const rowsBefore = await manager.activeRecords();
    const second = await ensureBundledPacksInBrowser({ manager, fetchImpl });
    expect(second.results).toEqual([{ id: 'bundled-a', outcome: 'satisfied', version: '1.0.0' }]);
    expect(installPackSpy).not.toHaveBeenCalled();
    const rowsAfter = await manager.activeRecords();
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it('a NEWER installed record satisfies the bundled entry (version-or-newer, desktop parity)', async () => {
    resetBundledPacksBootForTests();
    const { manager, installPackSpy } = setup();
    const newer = buildPackZip('bundled-a', '1.2.0');
    await manager.installPack(new File([newer.zip as Uint8Array<ArrayBuffer>], newer.entry.file));
    installPackSpy.mockClear();

    const bundled = buildPackZip('bundled-a', '1.0.0');
    const second = await ensureBundledPacksInBrowser({
      manager,
      fetchImpl: fetchFor({ packs: [bundled.entry] }, new Map([[bundled.entry.file, bundled.zip]])),
    });
    expect(second.results).toEqual([{ id: 'bundled-a', outcome: 'satisfied', version: '1.0.0' }]);
    expect(installPackSpy).not.toHaveBeenCalled();
  });

  it('an install that loses a race to a concurrent equal-version install counts as SUCCESS (post-error re-check)', async () => {
    resetBundledPacksBootForTests();
    const { manager } = setup();
    const a = buildPackZip('bundled-a', '1.0.0');
    const failures: Array<[string, string]> = [];

    // A wrapper simulating the losing racer: the CONCURRENT install commits
    // the record, then our own installPack attempt throws the equal-active-
    // version refusal (the exact production refusal text).
    const racingManager: BundledPacksManagerSurface = {
      activeRecords: manager.activeRecords.bind(manager),
      missingCapabilities: () => [],
      installPack: async (file) => {
        await manager.installPack(file);
        throw new Error(`${(file as File).name}: ${'bundled-a@1.0.0'} is already installed and active; remove it first`);
      },
    };

    const result = await ensureBundledPacksInBrowser({
      manager: racingManager,
      fetchImpl: fetchFor({ packs: [a.entry] }, new Map([[a.entry.file, a.zip]])),
      onPackFailure: (id, detail) => failures.push([id, detail]),
    });
    // The post-error satisfaction re-check turns the lost race into SUCCESS.
    expect(result.results).toEqual([{ id: 'bundled-a', outcome: 'recovered', version: '1.0.0' }]);
    expect(failures).toEqual([]);
    // And the record really is installed exactly once.
    expect(await manager.activeRecords()).toMatchObject([{ packId: 'bundled-a', version: '1.0.0' }]);
  });

  it('module-level single-flight: concurrent callers join ONE run', async () => {
    resetBundledPacksBootForTests();
    const { manager, installPackSpy } = setup();
    const a = buildPackZip('bundled-a', '1.0.0');
    const fetchImpl = fetchFor({ packs: [a.entry] }, new Map([[a.entry.file, a.zip]]));
    const [first, second] = await Promise.all([
      ensureBundledPacksInBrowser({ manager, fetchImpl }),
      ensureBundledPacksInBrowser({ manager, fetchImpl }),
    ]);
    expect(first).toEqual(second);
    expect(installPackSpy).toHaveBeenCalledTimes(1);
  });

  it('isBundledPackSatisfied: active record at entry version or newer only', () => {
    const records = [
      { packId: 'a', version: '1.0.0' },
      { packId: 'b', version: '0.9.0' },
    ];
    expect(isBundledPackSatisfied({ id: 'a', version: '1.0.0' }, records)).toBe(true);
    expect(isBundledPackSatisfied({ id: 'a', version: '1.1.0' }, records)).toBe(false);
    expect(isBundledPackSatisfied({ id: 'b', version: '1.0.0' }, records)).toBe(false);
    expect(isBundledPackSatisfied({ id: 'c', version: '1.0.0' }, records)).toBe(false);
  });
});
