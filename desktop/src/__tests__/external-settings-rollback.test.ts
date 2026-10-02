// PR #142 rebase RB-001 / review F-013 + F-014: a settings save that fails
// must leave EVERYTHING as it was — the engine's external.* values, the
// session key, and the SecretStore (memory AND secrets.bin) — whenever the
// 500 says "nothing was changed". Exercised over the real host + route +
// sidecars + a real file-backed SecretStore (fake safeStorage cipher).
//
// A sidecar is made unwritable by replacing it with a directory: the atomic
// rename onto it throws on every OS, while the loaders treat it as unreadable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeBackendHost } from '../../main/backend';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import { loadExternalSnapshot } from '../../main/backend/external-store';
import { createSafeStorageSecretStore, type SecretStore } from '../../main/security/secret-store';

const TOKEN = 'external-rollback-token';
const KEY_A = 'Zq7-rollback-KEY-AAAA-0001';
const KEY_B = 'Zq7-rollback-KEY-BBBB-0002';
const URL_A = 'http://127.0.0.1:9';
const URL_B = 'http://127.0.0.1:10';

const dirs: string[] = [];
const hosts: NodeBackendHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.stop();
  while (dirs.length > 0) {
    try {
      fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* windows file-lock race in cleanup */
    }
  }
});

const fakeSafe = (state: { decryptOk: boolean } = { decryptOk: true }) => ({
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.concat([Buffer.from('ENC:'), Buffer.from(plain, 'utf8').reverse()]),
  decryptString: (cipher: Buffer) => {
    if (!state.decryptOk || cipher.subarray(0, 4).toString() !== 'ENC:') throw new Error('cannot decrypt');
    return Buffer.from(cipher.subarray(4)).reverse().toString('utf8');
  },
});

function profile(): { dir: string; storePath: string; secrets: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-rollback-'));
  dirs.push(dir);
  return { dir, storePath: path.join(dir, 'store.sqlite'), secrets: path.join(dir, 'secrets.bin') };
}

/** Make every later write of `file` throw. */
function breakFile(file: string): void {
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(file, { recursive: true });
}

/** The entries as a FRESH store reads them from disk. */
function onDisk(secrets: string): { key: string | null; origin: string | null } {
  const fresh = createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: secrets });
  return { key: fresh.get('external-api-key'), origin: fresh.get('external-api-key-origin') };
}

function live(store: SecretStore): { key: string | null; origin: string | null } {
  return { key: store.get('external-api-key'), origin: store.get('external-api-key-origin') };
}

async function boot(p: { storePath: string; secrets: string }, store?: SecretStore) {
  const secretStore = store ?? createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: p.secrets });
  const engine = new LlamaEngine({
    modelDir: path.join(path.dirname(p.storePath), 'models'),
    llamaFactory: async () => {
      throw new Error('local model must not load');
    },
    externalProvider: { secretStore },
  });
  const host = new NodeBackendHost({
    token: TOKEN,
    tokenHeaderName: 'X-Desktop-Token',
    storePath: p.storePath,
    engine,
    env: { TRAININGAPP_DESKTOP_ENGINE: 'stub' },
  });
  hosts.push(host);
  const handle = await host.start();
  const get = async (): Promise<Record<string, unknown>> => {
    const res = await fetch(`${handle.url}/settings`, { headers: { 'x-desktop-token': TOKEN } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const put = async (body: unknown): Promise<{ status: number; detail: string }> => {
    const res = await fetch(`${handle.url}/settings`, {
      method: 'PUT',
      headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, detail: String(json.detail ?? '') };
  };
  return { host, engine, secretStore, get, put };
}

/** A saved, bound key and an enabled external model. */
const BASELINE = {
  'external.enabled': true,
  'external.protocol': 'openai',
  'external.baseUrl': URL_A,
  'external.model': 'm1',
  'external.apiKey': KEY_A,
};

describe('RB-001: a failed save rolls external.* and the SecretStore back', () => {
  it('mixed rag + external.* patch (incl. a new key) with external.json failing: GET and the secrets are unchanged', async () => {
    const p = profile();
    const { secretStore, get, put } = await boot(p);
    expect((await put(BASELINE)).status).toBe(200);
    const before = await get();
    const secretsBefore = onDisk(p.secrets);
    expect(secretsBefore).toEqual({ key: KEY_A, origin: URL_A });
    breakFile(path.join(p.dir, 'external.json'));

    const res = await put({
      rag_n_results: 7,
      'external.baseUrl': URL_B,
      'external.model': 'm2',
      'external.grounded': false,
      'external.protocol': 'anthropic',
      'external.apiKey': KEY_B,
    });
    expect(res.status).toBe(500);
    expect(res.detail).toMatch(/nothing was changed/i);

    expect(await get()).toEqual(before);
    expect(onDisk(p.secrets)).toEqual(secretsBefore);
    expect(live(secretStore)).toEqual(secretsBefore);
  });

  it('a key write with persistence failing: GET and the secrets are unchanged', async () => {
    const p = profile();
    const { secretStore, get, put } = await boot(p);
    expect((await put(BASELINE)).status).toBe(200);
    const before = await get();
    breakFile(path.join(p.dir, 'external.json'));

    const res = await put({ 'external.apiKey': KEY_B });
    expect(res.status).toBe(500);
    expect(res.detail).toMatch(/nothing was changed/i);

    expect(await get()).toEqual(before);
    expect(onDisk(p.secrets)).toEqual({ key: KEY_A, origin: URL_A });
    expect(live(secretStore)).toEqual({ key: KEY_A, origin: URL_A });
  });

  it('a key reset with persistence failing: the key is NOT deleted (GET and the secrets are unchanged)', async () => {
    const p = profile();
    const { secretStore, get, put } = await boot(p);
    expect((await put(BASELINE)).status).toBe(200);
    const before = await get();
    expect(before['external.apiKeySet']).toBe(true);
    breakFile(path.join(p.dir, 'external.json'));

    const res = await put({ reset: ['external.apiKey'] });
    expect(res.status).toBe(500);
    expect(res.detail).toMatch(/nothing was changed/i);

    expect(await get()).toEqual(before);
    expect(onDisk(p.secrets)).toEqual({ key: KEY_A, origin: URL_A });
    expect(live(secretStore)).toEqual({ key: KEY_A, origin: URL_A });
  });

  it('F-013: settings.json failing AFTER external.json was written re-writes external.json from the rolled-back engine', async () => {
    const p = profile();
    const { get, put } = await boot(p);
    expect((await put(BASELINE)).status).toBe(200);
    const before = await get();
    const externalBefore = loadExternalSnapshot(p.storePath);
    expect(externalBefore?.['external.grounded']).toBe(true);
    breakFile(path.join(p.dir, 'settings.json'));

    const res = await put({ rag_n_results: 7, 'external.grounded': false, 'external.model': 'm2' });
    expect(res.status).toBe(500);
    expect(res.detail).toMatch(/nothing was changed/i);

    expect(await get()).toEqual(before);
    // The next boot replays external.json: it must not be ahead of the engine.
    expect(loadExternalSnapshot(p.storePath)).toEqual(externalBefore);
  });

  it('a compensating SecretStore write that fails is reported, never "nothing was changed"', async () => {
    const p = profile();
    const real = createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: p.secrets });
    let failWrites = false;
    const flaky: SecretStore = {
      get: (n) => real.get(n),
      set: (n, v) => {
        if (failWrites) throw new Error('disk gone');
        real.set(n, v);
      },
      delete: (n) => {
        if (failWrites) throw new Error('disk gone');
        real.delete(n);
      },
    };
    const { get, put } = await boot(p, flaky);
    expect((await put(BASELINE)).status).toBe(200);
    // external.json write fails AFTER the key was written; then the store
    // stops accepting writes, so the restore cannot put KEY_A back.
    const externalPath = path.join(p.dir, 'external.json');
    breakFile(externalPath);
    const origSet = flaky.set;
    flaky.set = (n, v) => {
      origSet(n, v);
      if (n === 'external-api-key-origin') failWrites = true;
    };
    const res = await put({ 'external.apiKey': KEY_B });
    expect(res.status).toBe(500);
    expect(res.detail).not.toMatch(/nothing was changed/i);
    expect(res.detail).toMatch(/API key could not be put back/i);
    // Stage B RB-001: the detail must not claim the previous settings
    // (incl. the key) are back in effect — the engine now refuses the stored
    // key until one is entered again, and the detail says so.
    expect(res.detail).not.toMatch(/The previous settings are back in effect/);
    expect(res.detail).toMatch(/other than the API key are back in effect/);
    expect(res.detail).toMatch(/will not be used until you enter it again/);
    const after = await get();
    expect(after['external.baseUrl']).toBe(URL_A);
    expect(after['external.apiKeySet']).toBe(false);
  });
});

describe('F-014: a SecretStore delete that fails is surfaced, never swallowed', () => {
  it('PUT reset external.apiKey with secrets.bin unwritable answers 500 and the key stays in effect', async () => {
    const p = profile();
    const { secretStore, get, put } = await boot(p);
    expect((await put(BASELINE)).status).toBe(200);
    const before = await get();
    breakFile(p.secrets);

    const res = await put({ reset: ['external.apiKey'] });
    expect(res.status).toBe(500);
    expect(res.detail).toMatch(/could not be saved/i);
    expect(await get()).toEqual(before);
    expect(live(secretStore)).toEqual({ key: KEY_A, origin: URL_A });

    const cleared = await put({ 'external.apiKey': '' });
    expect(cleared.status).toBe(500);
    expect(await get()).toEqual(before);
  });

  it('a new key that cannot be stored, when the older key cannot be removed either, answers 500 (no stale key left behind a session-only one)', async () => {
    const p = profile();
    const real = createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: p.secrets });
    let failWrites = false;
    const store: SecretStore = {
      get: (n) => real.get(n),
      set: (n, v) => {
        if (failWrites) throw new Error('secure storage unavailable');
        real.set(n, v);
      },
      delete: (n) => {
        if (failWrites) throw new Error('disk gone');
        real.delete(n);
      },
    };
    const { get, put } = await boot(p, store);
    expect((await put(BASELINE)).status).toBe(200);
    const before = await get();
    failWrites = true;

    const res = await put({ 'external.apiKey': KEY_B });
    // Before F-014 this answered 200 with KEY_B "session-only" while KEY_A
    // stayed on disk and came back at the next start.
    expect(res.status).toBe(500);
    expect(res.detail).toMatch(/nothing was changed/i);
    expect(await get()).toEqual(before);
    expect(onDisk(p.secrets)).toEqual({ key: KEY_A, origin: URL_A });
    expect(live(store)).toEqual({ key: KEY_A, origin: URL_A });
  });

  it('secret-store delete() persists before forgetting the plaintext: a failed write keeps the key readable', () => {
    const p = profile();
    const decrypt = { decryptOk: true };
    const store = createSafeStorageSecretStore({ safeStorage: fakeSafe(decrypt), filePath: p.secrets });
    store.set('external-api-key', KEY_A);
    expect(store.get('external-api-key')).toBe(KEY_A);
    breakFile(p.secrets);
    // The OS secret service is unavailable for a moment: only the in-memory
    // plaintext can answer. The failed delete must not have dropped it.
    decrypt.decryptOk = false;
    expect(() => store.delete('external-api-key')).toThrow();
    expect(store.get('external-api-key')).toBe(KEY_A);
  });
});
