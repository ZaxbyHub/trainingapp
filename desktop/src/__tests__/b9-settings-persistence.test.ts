// B9 spec (issue #67): PUT /settings persistence across host restarts —
// the AC3 semantics. Pins: an accepted override is snapshotted to
// <profileDir>/settings.json and re-applied by a FRESH host on the same
// store path; a corrupt sidecar boots with defaults and a later PUT still
// works; a REJECTED patch (422) is never persisted; hosts without a store
// path keep engine-memory-only behavior (CI stub runs).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeBackendHost } from '../../main/backend';
import type { BackendHandle } from '../../main/backend/types';
import { StubEngine } from '../../main/backend/engine';

const TOKEN = 'b9-settings-persist-spec-token';

const tmpDirs: string[] = [];
let counter = 0;

function tempStorePath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `b9-settings-persist-${counter++}-`));
  tmpDirs.push(dir);
  return path.join(dir, 'profiles', 'default', 'store.sqlite');
}

function hostFor(storePath: string | undefined): NodeBackendHost {
  return new NodeBackendHost({
    token: TOKEN,
    tokenHeaderName: 'X-Desktop-Token',
    storePath,
    engine: new StubEngine(),
    env: { TRAININGAPP_DESKTOP_ENGINE: 'stub' },
  });
}

function url(handle: BackendHandle, reqPath: string): string {
  return `${handle.url}${reqPath}`;
}

async function getSettings(handle: BackendHandle): Promise<Record<string, unknown>> {
  const res = await fetch(url(handle, '/settings'), {
    headers: { 'x-desktop-token': TOKEN },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function putSetting(handle: BackendHandle, patch: Record<string, unknown>): Promise<number> {
  const res = await fetch(url(handle, '/settings'), {
    method: 'PUT',
    headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.status;
}

beforeAll(() => {});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file-lock race is fine in cleanup */
    }
  }
});

describe('b9-settings-persistence: accepted overrides survive a host restart', () => {
  it('persists rag_n_results=7 across a stop/start on the same profile dir', async () => {
    const storePath = tempStorePath();
    const host1 = hostFor(storePath);
    const handle1 = await host1.start();
    try {
      expect(await putSetting(handle1, { rag_n_results: 7 })).toBe(200);
      expect((await getSettings(handle1)).n_results).toBe(7);
    } finally {
      await host1.stop();
    }

    const host2 = hostFor(storePath);
    const handle2 = await host2.start();
    try {
      expect((await getSettings(handle2)).n_results).toBe(7);
    } finally {
      await host2.stop();
    }
  });

  it('never persists a REJECTED patch (422 unknown key)', async () => {
    const storePath = tempStorePath();
    const host1 = hostFor(storePath);
    const handle1 = await host1.start();
    try {
      expect(await putSetting(handle1, { totally_unknown_key: 1 })).toBe(422);
    } finally {
      await host1.stop();
    }
    const host2 = hostFor(storePath);
    const handle2 = await host2.start();
    try {
      // Default survived: the rejected patch was never snapshotted.
      expect((await getSettings(handle2)).n_results).toBe(4);
    } finally {
      await host2.stop();
    }
  });

  it('boots with defaults on a corrupt sidecar and a later PUT still works', async () => {
    const storePath = tempStorePath();
    const host1 = hostFor(storePath);
    const handle1 = await host1.start();
    try {
      expect(await putSetting(handle1, { rag_n_results: 7 })).toBe(200);
    } finally {
      await host1.stop();
    }

    const sidecar = path.join(path.dirname(storePath), 'settings.json');
    expect(existsSync(sidecar)).toBe(true);
    writeFileSync(sidecar, '{not valid json at all');

    const host2 = hostFor(storePath);
    const handle2 = await host2.start();
    try {
      expect((await getSettings(handle2)).n_results).toBe(4);
      expect(await putSetting(handle2, { rag_n_results: 6 })).toBe(200);
      expect((await getSettings(handle2)).n_results).toBe(6);
    } finally {
      await host2.stop();
    }

    // The successful second-boot PUT rewrote the sidecar as valid JSON.
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toMatchObject({ rag_n_results: 6 });
  });

  it('leaves hosts without a store path engine-memory-only (CI stub behavior)', async () => {
    const host = hostFor(undefined);
    const handle = await host.start();
    try {
      expect(await putSetting(handle, { rag_n_results: 7 })).toBe(200);
      expect((await getSettings(handle)).n_results).toBe(7);
    } finally {
      await host.stop();
    }
    const host2 = hostFor(undefined);
    const handle2 = await host2.start();
    try {
      expect((await getSettings(handle2)).n_results).toBe(4);
    } finally {
      await host2.stop();
    }
  });
});
