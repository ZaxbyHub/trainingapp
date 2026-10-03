// @vitest-environment node
/**
 * Browser pack lifecycle (trace browser-training-parity AC7/AC9): install,
 * downgrade/same-version refusals (desktop wording), quota refusal BEFORE
 * anything is stored, persist requested, atomic active flip, rollback,
 * remove frees files, manifest `supersedes`, orphan sweep, and the relay's
 * active-version read path.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BrowserPackManager, QUOTA_HEADROOM_FACTOR, type PackIndexHooks } from '../browser-pack-manager';
import { MemoryPackFileStore, MemoryPackRegistry } from '../pack-store-opfs';
import { buildRawZip } from './zip-fixture';

const enc = new TextEncoder();
const DOC = enc.encode(JSON.stringify({ slide_id: 'AAAAAAAAAAA', slide_title: 'Welcome', section_title: 'Intro', on_screen_text: 'Hello' }));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function packZip(version: string, opts: { id?: string; media?: number; supersedes?: string[]; html?: string } = {}): File {
  const manifest = {
    id: opts.id ?? 'course-a',
    name: 'Course A',
    version,
    published_at: '2026-10-01T00:00:00Z',
    source_class: 'training',
    ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
    docs: [{ path: 'docs/slide-001-AAAAAAAAAAA.json', sha256: sha(DOC), title: 'Welcome', mime: 'application/json' }],
  };
  const zip = buildRawZip([
    { name: 'pack.json', data: JSON.stringify(manifest) },
    { name: 'docs/slide-001-AAAAAAAAAAA.json', data: DOC },
    { name: 'assets/player/story.html', data: opts.html ?? `<html>${version}</html>`, method: 8 },
    { name: `assets/player/media/${version}.bin`, data: new Uint8Array(opts.media ?? 1024).fill(7) },
  ]);
  return new File([zip], `course-a-${version}.zip`, { type: 'application/zip' });
}

function setup(quota = 1024 * 1024 * 1024, usage = 0) {
  const files = new MemoryPackFileStore();
  const registry = new MemoryPackRegistry();
  const persist = vi.fn(async () => true);
  const estimate = vi.fn(async () => ({ quota, usage }));
  const hooks: PackIndexHooks = { onInstalled: vi.fn(async () => undefined), onRemoved: vi.fn(async () => undefined), onActivated: vi.fn(async () => undefined) };
  let n = 0;
  const manager = new BrowserPackManager({
    registry,
    files,
    hooks,
    storage: { estimate, persist, persisted: async () => true },
    gateConfig: () => ({ requireSignature: false, trustedKeys: [], embeddingModelId: 'bge-small-en-v1.5' }),
    capabilities: () => [],
    nonce: () => `n${(n += 1)}`,
  });
  return { manager, files, registry, persist, estimate, hooks };
}

const text = async (b: Blob | null): Promise<string | null> => (b === null ? null : b.text());

describe('BrowserPackManager', () => {
  it('installs, lists, serves the active version, and requests persistence', async () => {
    const { manager, persist, hooks } = setup();
    await expect(manager.installPack(packZip('1.0.0'))).resolves.toEqual({ packId: 'course-a', version: '1.0.0' });
    expect(await manager.listPacks()).toEqual([
      { packId: 'course-a', version: '1.0.0', name: 'Course A', sourceClass: 'training', publishedAt: '2026-10-01T00:00:00Z', active: true, supersedes: [] },
    ]);
    expect(await text(await manager.readActiveFile('course-a', ['story.html']))).toBe('<html>1.0.0</html>');
    expect(persist).toHaveBeenCalled();
    expect(hooks.onInstalled).toHaveBeenCalledTimes(1);
  });

  it('a newer version supersedes (retained), rollback flips back, the relay follows the active version', async () => {
    const { manager } = setup();
    await manager.installPack(packZip('1.0.0'));
    await manager.installPack(packZip('1.1.0'));
    const rows = await manager.listPacks();
    expect(rows.map((r) => [r.version, r.active])).toEqual([
      ['1.0.0', false],
      ['1.1.0', true],
    ]);
    expect(await text(await manager.readActiveFile('course-a', ['story.html']))).toBe('<html>1.1.0</html>');
    await manager.rollbackPack('course-a', '1.0.0');
    expect((await manager.listPacks()).map((r) => [r.version, r.active])).toEqual([
      ['1.0.0', true],
      ['1.1.0', false],
    ]);
    expect(await text(await manager.readActiveFile('course-a', ['story.html']))).toBe('<html>1.0.0</html>');
  });

  it('rollback completes when the activation hook re-enters the manager (no self-deadlock on the per-pack lock)', async () => {
    const { manager, hooks } = setup();
    // The production activation hook (searchIndexHooks) calls markEmbedded,
    // which takes the same per-pack lock rollbackPack holds.
    hooks.onActivated = vi.fn(async (record: { packId: string; version: string }) => manager.markEmbedded(record.packId, record.version, false));
    // A pack id of its own: a deadlock here must not poison the module-level
    // in-tab lock chain the other rows use for 'course-a'.
    await manager.installPack(packZip('1.0.0', { id: 'course-lock' }));
    await manager.installPack(packZip('1.1.0', { id: 'course-lock' }));
    const outcome = await Promise.race([
      manager.rollbackPack('course-lock', '1.0.0').then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('deadlocked'), 2000)),
    ]);
    expect(outcome).toBe('done');
    expect(hooks.onActivated).toHaveBeenCalledTimes(1);
    expect((await manager.listPacks()).find((r) => r.active)?.version).toBe('1.0.0');
  });

  it('refuses a downgrade and a same-version reinstall with the desktop wording', async () => {
    const { manager } = setup();
    await manager.installPack(packZip('1.1.0'));
    await expect(manager.installPack(packZip('1.0.0'))).rejects.toThrow(
      'refusing downgrade of course-a: 1.1.0 is installed and active; use rollback',
    );
    await expect(manager.installPack(packZip('1.1.0'))).rejects.toThrow('course-a@1.1.0 is already installed and active; remove it first');
  });

  it('rollback refusals mirror desktop', async () => {
    const { manager } = setup();
    await manager.installPack(packZip('1.0.0'));
    await expect(manager.rollbackPack('course-a', '9.9.9')).rejects.toThrow('course-a@9.9.9 is not installed');
    await expect(manager.rollbackPack('course-a', '1.0.0')).rejects.toThrow('course-a@1.0.0 is already the active version');
  });

  it('remove deletes the version files and rows; no other version is auto-activated', async () => {
    const { manager, files, hooks } = setup();
    await manager.installPack(packZip('1.0.0', { media: 4096 }));
    await manager.installPack(packZip('1.1.0', { media: 4096 }));
    const before = files.files.size;
    await manager.removePack('course-a', '1.1.0');
    expect(files.files.size).toBeLessThan(before);
    expect([...files.files.keys()].some((k) => k.includes('/1.1.0-'))).toBe(false);
    expect((await manager.listPacks()).map((r) => [r.version, r.active])).toEqual([['1.0.0', false]]);
    expect(await manager.readActiveFile('course-a', ['story.html'])).toBeNull();
    expect(hooks.onRemoved).toHaveBeenCalled();
    await expect(manager.removePack('course-a', '1.1.0')).rejects.toThrow('nothing installed matches course-a@1.1.0');
  });

  it('refuses an install that cannot fit BEFORE storing anything (quota from the page estimate)', async () => {
    const zip = packZip('1.0.0', { media: 8 * 1024 * 1024 });
    const { manager, files, registry, persist } = setup(6 * 1024 * 1024, 1 * 1024 * 1024);
    await expect(manager.installPack(zip)).rejects.toThrow(/not enough browser storage for this pack/);
    expect(files.files.size).toBe(0);
    expect(await registry.list()).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(QUOTA_HEADROOM_FACTOR).toBe(2);
  });

  it('a pack that fits installs under the same quota', async () => {
    const { manager } = setup(6 * 1024 * 1024, 1 * 1024 * 1024);
    await expect(manager.installPack(packZip('1.0.0', { media: 100 * 1024 }))).resolves.toMatchObject({ version: '1.0.0' });
  });

  it('hostile archives are refused before any write (guards run first)', async () => {
    const { manager, files } = setup();
    const slip = buildRawZip([
      { name: 'pack.json', data: '{}' },
      { name: '../evil.txt', data: 'pwn' },
    ]);
    await expect(manager.installPack(new File([slip], 'slip.zip'))).rejects.toThrow(/unsafe archive entry path/);
    expect(files.files.size).toBe(0);
  });

  it('tampered doc bytes are refused (per-doc sha256) before any write', async () => {
    const { manager, files } = setup();
    const manifest = JSON.stringify({
      id: 'course-a', name: 'A', version: '1.0.0', published_at: '2026-10-01T00:00:00Z', source_class: 'training',
      embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true }, chunking: { strategy: 'slide-aware', size: 1, overlap: 0 },
      docs: [{ path: 'docs/a.json', sha256: sha(DOC), title: 't', mime: 'application/json' }],
    });
    const zip = buildRawZip([{ name: 'pack.json', data: manifest }, { name: 'docs/a.json', data: 'tampered' }]);
    await expect(manager.installPack(new File([zip], 't.zip'))).rejects.toThrow(/doc sha256 mismatch for docs\/a\.json/);
    expect(files.files.size).toBe(0);
  });

  it('manifest supersedes deactivates the named installed version of another pack', async () => {
    const { manager } = setup();
    await manager.installPack(packZip('1.0.0', { id: 'course-old' }));
    await manager.installPack(packZip('2.0.0', { id: 'course-new', supersedes: ['course-old@1.0.0'] }));
    const rows = await manager.listPacks();
    expect(rows.find((r) => r.packId === 'course-old')?.active).toBe(false);
    expect(rows.find((r) => r.packId === 'course-new')?.active).toBe(true);
  });

  it('the orphan sweep removes version directories no registry row references', async () => {
    const { manager, files } = setup();
    await manager.installPack(packZip('1.0.0'));
    const writer = await files.createFile('course-a', '1.2.0-dead', ['assets', 'player', 'x.js']);
    await writer.write(enc.encode('x'));
    await writer.close();
    await manager.collectOrphans();
    expect([...files.files.keys()].some((k) => k.includes('1.2.0-dead'))).toBe(false);
    expect(await text(await manager.readActiveFile('course-a', ['story.html']))).toBe('<html>1.0.0</html>');
  });

  it('a failed write leaves no version directory and no registry row', async () => {
    const { manager, files, registry } = setup();
    const original = files.createFile.bind(files);
    let calls = 0;
    files.createFile = async (...args) => {
      calls += 1;
      if (calls === 3) throw new DOMException('quota exceeded', 'QuotaExceededError');
      return original(...args);
    };
    await expect(manager.installPack(packZip('1.0.0'))).rejects.toThrow(/not enough browser storage while installing/);
    expect(files.files.size).toBe(0);
    expect(await registry.list()).toEqual([]);
  });

  it('concurrent installs of one pack are single-flight (no interleaved registry state)', async () => {
    const { manager } = setup();
    const results = await Promise.allSettled([manager.installPack(packZip('1.0.0')), manager.installPack(packZip('1.1.0'))]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await manager.listPacks();
    expect(rows.filter((r) => r.active)).toHaveLength(1);
    expect(rows.find((r) => r.active)?.version).toBe('1.1.0');
  });
});
