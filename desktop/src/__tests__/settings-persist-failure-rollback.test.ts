// settings-wiring-honesty (PR #140 review FB140-001): a settings change the
// sidecar could not save must leave the ENGINE unchanged too. Before the fix
// the engine committed the patch first and kept it when the disk write threw:
// GET /settings then served values the 500 said were not saved, and the next
// restart silently reverted them from the stale sidecar. Pinned over the real
// host + route + settings sidecar for the three write paths: a PUT patch, a
// PUT `reset`, and the first-run wizard's applyEngineSettings seam.
//
// The sidecar is made unwritable by replacing settings.json with a directory:
// saveSettingsSnapshot's rename onto it throws (EISDIR/EPERM) on every OS,
// while loadSettingsSnapshot treats it as unreadable (null), so boot is
// unaffected.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeBackendHost } from '../../main/backend';
import type { BackendHandle } from '../../main/backend/types';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import { loadSettingsSnapshot } from '../../main/backend/settings-store';

const TOKEN = 'settings-persist-failure-spec-token';
const tmpDirs: string[] = [];
let counter = 0;

function tempProfile(): { storePath: string; sidecar: string; models: { quality: string; fast: string } } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `settings-persist-failure-${counter++}-`));
  tmpDirs.push(dir);
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  writeFileSync(quality, 'x');
  writeFileSync(fast, 'x');
  const storePath = path.join(dir, 'profiles', 'default', 'store.sqlite');
  return { storePath, sidecar: path.join(path.dirname(storePath), 'settings.json'), models: { quality, fast } };
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

/** Make every later sidecar write throw. */
function breakSidecar(sidecar: string): void {
  rmSync(sidecar, { recursive: true, force: true });
  mkdirSync(sidecar, { recursive: true });
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

describe('settings persist failure: the engine is rolled back, nothing changes', () => {
  it('PUT patch (rag + inference keys): 500, and GET /settings equals the pre-PUT state', async () => {
    const { storePath, sidecar, models } = tempProfile();
    const host = hostFor(storePath, models);
    const handle = await host.start();
    try {
      const before = await getSettings(handle);
      expect(before.explicit_keys).toEqual([]);
      breakSidecar(sidecar);

      const res = await put(handle, { rag_n_results: 7, rag_max_tokens: 300, 'inference.profile': 'fast' });
      expect(res.status).toBe(500);

      const after = await getSettings(handle);
      expect(after.n_results).toBe(before.n_results);
      expect(after.explicit_keys).toEqual([]);
      expect(after.requested).toEqual(before.requested);
      expect(after.effective).toEqual(before.effective);
      expect(after['inference.profile']).toBe('quality');
      expect(after).toEqual(before);
      expect(String(res.body.detail)).toMatch(/could not be saved/i);
      expect(String(res.body.detail)).toMatch(/nothing was changed/i);
    } finally {
      await host.stop();
    }
  });

  it('PUT reset after a saved explicit value: 500, and the explicit value is still in effect', async () => {
    const { storePath, sidecar, models } = tempProfile();
    const host = hostFor(storePath, models);
    const handle = await host.start();
    try {
      expect((await put(handle, { rag_n_results: 7, rag_max_tokens: 300 })).status).toBe(200);
      const before = await getSettings(handle);
      expect(before.explicit_keys).toEqual(['rag_max_tokens', 'rag_n_results']);
      breakSidecar(sidecar);

      const res = await put(handle, { reset: ['rag_n_results', 'rag_max_tokens'] });
      expect(res.status).toBe(500);

      const after = await getSettings(handle);
      expect(after.n_results).toBe(7);
      expect(after.explicit_keys).toEqual(['rag_max_tokens', 'rag_n_results']);
      expect(after.requested).toMatchObject({ n_results: 7, max_tokens: 300 });
      expect(after.effective).toMatchObject({ n_results: 7, max_tokens: 300 });
      expect(after).toEqual(before);
      expect(String(res.body.detail)).toMatch(/nothing was changed/i);
    } finally {
      await host.stop();
    }
  });

  it('first-run applyEngineSettings: a failed save returns 500 and leaves the engine profile unchanged', async () => {
    const { storePath, sidecar, models } = tempProfile();
    const host = hostFor(storePath, models);
    const handle = await host.start();
    try {
      const before = await getSettings(handle);
      expect(before['inference.profile']).toBe('quality');
      breakSidecar(sidecar);

      const applied = host.applyEngineSettings?.({ 'inference.profile': 'fast' });
      expect(applied).toMatchObject({ ok: false, status: 500 });

      const after = await getSettings(handle);
      expect(after['inference.profile']).toBe('quality');
      expect(after).toEqual(before);
      if (applied !== undefined && !applied.ok) expect(applied.detail).toMatch(/nothing was changed/i);
    } finally {
      await host.stop();
    }
  });

  // universal-provider-settings-overhaul, composed with FB140-001 on rebase:
  // the rollback restores only the settings.json-backed state, so a mixed
  // rag + external.* patch writes external.json BEFORE settings.json. In the
  // other order a failed external.json write would leave settings.json
  // holding values the engine just rolled back, and the next boot would
  // replay them. (external.* itself is not in the rollback snapshot.)
  it('PUT mixed rag + external.* patch: a failed external.json write leaves settings.json unwritten', async () => {
    const { storePath, sidecar, models } = tempProfile();
    const host = hostFor(storePath, models);
    const handle = await host.start();
    try {
      const before = await getSettings(handle);
      breakSidecar(path.join(path.dirname(sidecar), 'external.json'));

      const res = await put(handle, { rag_n_results: 7, 'external.grounded': false });
      expect(res.status).toBe(500);
      expect(String(res.body.detail)).toMatch(/could not be saved/i);

      const after = await getSettings(handle);
      expect(after.n_results).toBe(before.n_results);
      expect(after.explicit_keys).toEqual(before.explicit_keys);
      expect(loadSettingsSnapshot(storePath)?.rag_n_results).toBeUndefined();
    } finally {
      await host.stop();
    }
  });
});
