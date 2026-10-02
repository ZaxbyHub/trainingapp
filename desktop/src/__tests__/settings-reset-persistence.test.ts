// settings-wiring-honesty (IC1): the PUT /settings `reset` directive over the
// real host + route + settings sidecar, b9-style. A reset key leaves the
// explicit set AND settings.json, so a restarted host neither reports it as
// explicit nor replays it, while every other saved key (inference.profile
// included) survives. `reset` itself is never persisted.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeBackendHost } from '../../main/backend';
import type { BackendHandle } from '../../main/backend/types';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';

const TOKEN = 'settings-reset-spec-token';
const tmpDirs: string[] = [];
let counter = 0;

function tempProfile(): { storePath: string; models: { quality: string; fast: string } } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `settings-reset-${counter++}-`));
  tmpDirs.push(dir);
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  writeFileSync(quality, 'x');
  writeFileSync(fast, 'x');
  return { storePath: path.join(dir, 'profiles', 'default', 'store.sqlite'), models: { quality, fast } };
}

function hostFor(storePath: string, models: { quality: string; fast: string }): NodeBackendHost {
  return new NodeBackendHost({
    token: TOKEN,
    tokenHeaderName: 'X-Desktop-Token',
    storePath,
    engine: new LlamaEngine({
      profile: 'quality',
      freeMemBytes: () => 8 * 1024 ** 3,
      cpuCount: () => 8,
      models,
      llamaFactory: async () => ({
        generate: async () => ({ answer: 'ok', cancelled: false }),
        dispose: async () => undefined,
      }),
    }),
    env: { TRAININGAPP_DESKTOP_ENGINE: 'stub' },
  });
}

async function getSettings(handle: BackendHandle): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.url}/settings`, { headers: { 'x-desktop-token': TOKEN } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function put(handle: BackendHandle, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${handle.url}/settings`, {
    method: 'PUT',
    headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file-lock race is fine in cleanup */
    }
  }
});

describe('settings-reset-persistence: reset survives a host restart; other saved keys are kept', () => {
  it('PUT a value, PUT reset, restart: the key is neither explicit nor in settings.json; others survive', async () => {
    const { storePath, models } = tempProfile();
    const sidecar = path.join(path.dirname(storePath), 'settings.json');
    const host1 = hostFor(storePath, models);
    const handle1 = await host1.start();
    try {
      expect((await put(handle1, { rag_max_tokens: 300, rag_n_results: 7 })).status).toBe(200);
      expect((await put(handle1, { 'inference.profile': 'fast' })).status).toBe(200);
      expect((await getSettings(handle1)).explicit_keys).toEqual(['rag_max_tokens', 'rag_n_results']);

      const reset = await put(handle1, { reset: ['rag_max_tokens'] });
      expect(reset.status).toBe(200);
      // The UI confirms a reset through explicit_keys in the response.
      expect(reset.body.explicit_keys).toEqual(['rag_n_results']);
      // Not explicit any more: the fast profile's 384 applies again.
      expect(reset.body.max_tokens).toBe(384);
    } finally {
      await host1.stop();
    }

    const persisted = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('rag_max_tokens');
    expect(persisted).not.toHaveProperty('reset');
    expect(persisted).toMatchObject({ rag_n_results: 7, 'inference.profile': 'fast' });

    const host2 = hostFor(storePath, models);
    const handle2 = await host2.start();
    try {
      const settings = await getSettings(handle2);
      expect(settings.explicit_keys).toEqual(['rag_n_results']);
      expect(settings['inference.profile']).toBe('fast');
      expect(settings.n_results).toBe(7);
      expect(settings.max_tokens).toBe(384);
      expect(settings.requested).toMatchObject({ max_tokens: null, n_results: 7 });
    } finally {
      await host2.stop();
    }
  });

  it('rejects malformed or combined reset requests with 422 and commits nothing', async () => {
    const { storePath, models } = tempProfile();
    const host = hostFor(storePath, models);
    const handle = await host.start();
    try {
      expect((await put(handle, { rag_n_results: 6 })).status).toBe(200);
      for (const body of [
        { reset: ['rag_n_results'], rag_max_tokens: 300 },
        { reset: 'rag_n_results' },
        { reset: ['bogus_key'] },
        { reset: ['inference.profile'] },
      ]) {
        expect((await put(handle, body)).status).toBe(422);
      }
      const settings = await getSettings(handle);
      expect(settings.explicit_keys).toEqual(['rag_n_results']);
      expect(settings.n_results).toBe(6);
    } finally {
      await host.stop();
    }
  });
});
