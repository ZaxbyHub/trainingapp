// settings-external-scrub.test.ts — issue #256 AC3/AC4: the desktop boot
// path must rewrite a settings.json that carries external.* keys (a stale or
// hand-edited file) so no plaintext external key persists on disk after
// load, and must never attempt that rewrite for a missing, corrupt, or
// unreadable sidecar (the settings-store nonfatal-sidecar contract).
//
// Closed-set + declared-extras convention (packaged-smoke contract): the
// frozen acceptance battery's -t filters select exactly one test each —
// `-t scrub-on-load` and `-t corrupt-file-untouched` — while the remaining
// tests are declared extras covered by the full-file run in the quality
// battery. Suite-wide -t filters may also select these names; the
// file-scoped guarantee is the closed-set one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBackendHost } from '../../main/backend/index.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import { createMemorySecretStore } from '../../main/security/secret-store.js';

// The scrub spies/fails through the REAL settings-store module (importOriginal),
// so every test below drives the genuine load path; only saveSettingsSnapshot
// is wrapped.
const scrubControl = vi.hoisted(() => ({
  failNextScrub: false,
  saveCalls: 0,
}));
vi.mock('../../main/backend/settings-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/settings-store.js')>();
  return {
    ...actual,
    saveSettingsSnapshot: (storePath: string, patch: Record<string, unknown>) => {
      scrubControl.saveCalls += 1;
      if (scrubControl.failNextScrub) {
        throw new Error('EACCES: permission denied, simulated scrub write failure');
      }
      return actual.saveSettingsSnapshot(storePath, patch);
    },
  };
});

const TOKEN = 'scrub-test-token';
const KEY = 'sk-engine-SENTINEL-5150';

const hosts: NodeBackendHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.stop();
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  scrubControl.failNextScrub = false;
  scrubControl.saveCalls = 0;
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function mapStore() {
  const data = new Map<string, string>();
  return {
    get: (n: string) => data.get(n) ?? null,
    set: (n: string, v: string) => {
      data.set(n, v);
    },
    delete: (n: string) => {
      data.delete(n);
    },
    dump: () => Object.fromEntries(data),
  };
}
function newEngine() {
  const llamaFactory = vi.fn(async () => {
    throw new Error('local model must not load');
  });
  const engine = new LlamaEngine({
    modelDir: tmp('scrub-models-'),
    llamaFactory,
    externalProvider: { secretStore: mapStore() },
  });
  return engine;
}
async function boot(profileDir: string) {
  const host = new NodeBackendHost({
    token: TOKEN,
    tokenHeaderName: 'X-Desktop-Token',
    storePath: path.join(profileDir, 'store.sqlite'),
    engine: newEngine(),
    env: { TRAININGAPP_DESKTOP_ENGINE: 'stub' },
  });
  const handle = await host.start();
  hosts.push(host);
  return { host, handle };
}
const responseSettings = async (handle: { url: string }) =>
  (await (await fetch(`${handle.url}/settings`, { headers: { 'x-desktop-token': TOKEN } })).json()) as Record<
    string,
    unknown
  >;

describe('settings.json external.* scrub at boot (issue #256 AC3/AC4)', () => {
  it('scrub-on-load: a stale settings.json carrying external.* (incl. a plaintext key) is rewritten without it at boot, with no PUT issued', async () => {
    const profileDir = tmp('scrub-host-');
    fs.writeFileSync(
      path.join(profileDir, 'settings.json'),
      JSON.stringify({ rag_n_results: 5, 'external.enabled': true, 'external.apiKey': KEY }),
    );
    const { handle } = await boot(profileDir);
    // NO PUT /settings is issued anywhere in this test — the rewrite must
    // have happened during load.
    const applied = await responseSettings(handle);
    expect(applied['external.enabled']).toBe(false);
    expect(applied['external.apiKeySet']).toBe(false);
    expect(applied['n_results']).toBe(5);
    const onDisk = fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8');
    expect(onDisk).not.toContain('external.');
    expect(onDisk).not.toContain(KEY);
    expect(JSON.parse(onDisk)).toEqual({ rag_n_results: 5 });
    // The scrub never routes keys into external.json either.
    expect(fs.existsSync(path.join(profileDir, 'external.json'))).toBe(false);
    expect(scrubControl.saveCalls).toBe(1);
  });

  it('corrupt-file-untouched: a corrupt or unreadable settings.json is not rewritten: boot proceeds on defaults and no write is attempted', async () => {
    // Leg A: corrupt JSON — byte-identical on disk after boot.
    const corruptDir = tmp('scrub-corrupt-');
    const corruptBytes = '{"rag_n_results": 5, NOT VALID JSON';
    fs.writeFileSync(path.join(corruptDir, 'settings.json'), corruptBytes);
    await boot(corruptDir);
    expect(fs.readFileSync(path.join(corruptDir, 'settings.json'), 'utf8')).toBe(corruptBytes);
    // Leg B: unreadable through the real read path — a DIRECTORY named
    // settings.json makes readFileSync fail with EISDIR, so
    // loadSettingsSnapshot returns null exactly like a corrupt file.
    const dirLegDir = tmp('scrub-unreadable-');
    fs.mkdirSync(path.join(dirLegDir, 'settings.json'));
    await boot(dirLegDir);
    expect(fs.statSync(path.join(dirLegDir, 'settings.json')).isDirectory()).toBe(true);
    // Neither leg attempted the rewrite.
    expect(scrubControl.saveCalls).toBe(0);
  });

  it('an external-only settings.json is scrubbed to an empty snapshot (declared extra)', async () => {
    const profileDir = tmp('scrub-extonly-');
    fs.writeFileSync(
      path.join(profileDir, 'settings.json'),
      JSON.stringify({ 'external.enabled': true, 'external.apiKey': KEY }),
    );
    const { handle } = await boot(profileDir);
    const applied = await responseSettings(handle);
    expect(applied['external.enabled']).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('case-variant External.apiKey keys are scrubbed like their lowercase siblings (declared extra, round-2 PRR-003)', async () => {
    const profileDir = tmp('scrub-case-');
    fs.writeFileSync(
      path.join(profileDir, 'settings.json'),
      JSON.stringify({ rag_n_results: 5, 'External.apiKey': KEY }),
    );
    const { handle } = await boot(profileDir);
    const applied = await responseSettings(handle);
    expect(applied['external.apiKeySet']).toBe(false);
    const onDisk = fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8');
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).not.toContain('External.');
  });

  it('a clean settings.json without external.* is not rewritten at boot (declared extra)', async () => {
    const profileDir = tmp('scrub-clean-');
    const cleanBytes = JSON.stringify({ rag_n_results: 7 });
    fs.writeFileSync(path.join(profileDir, 'settings.json'), cleanBytes);
    await boot(profileDir);
    expect(scrubControl.saveCalls).toBe(0);
    expect(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8')).toBe(cleanBytes);
  });

  it('a missing settings.json never attempts a write (declared extra)', async () => {
    const profileDir = tmp('scrub-missing-');
    await boot(profileDir);
    expect(scrubControl.saveCalls).toBe(0);
    expect(fs.existsSync(path.join(profileDir, 'settings.json'))).toBe(false);
  });

  it('a failed scrub write rejects the start instead of returning from load with the key on disk (declared extra)', async () => {
    const profileDir = tmp('scrub-fail-');
    fs.writeFileSync(
      path.join(profileDir, 'settings.json'),
      JSON.stringify({ rag_n_results: 5, 'external.apiKey': KEY }),
    );
    scrubControl.failNextScrub = true;
    const host = new NodeBackendHost({
      token: TOKEN,
      tokenHeaderName: 'X-Desktop-Token',
      storePath: path.join(profileDir, 'store.sqlite'),
      engine: newEngine(),
      env: { TRAININGAPP_DESKTOP_ENGINE: 'stub' },
    });
    await expect(host.start()).rejects.toThrow(/could not be scrubbed/);
    // The plaintext key is still on disk (the write failed) — which is
    // exactly why the boot must fail: load does NOT return successfully
    // while the file keeps the key.
    expect(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8')).toContain(KEY);
    scrubControl.failNextScrub = false;
    // A retry (next boot) scrubs normally.
    const { handle } = await boot(profileDir);
    expect(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8')).not.toContain(KEY);
    void handle;
  });
});
