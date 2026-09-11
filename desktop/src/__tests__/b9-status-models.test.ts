// B9 spec (issue #67): GET /status/models — the model-presence route the
// renderer's first-run gate consumes. Pins: route membership in the guarded
// table (405 on wrong method, 401 without the token), the stub payload
// (engine 'stub', nothing present, profile 'auto'), the LlamaEngine payload
// reflecting on-disk GGUF presence via the same modelPathFor resolution
// assertModelAvailable enforces, and the 503 degradation when no provider is
// wired (the /telemetry/memory shape).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { createLoopbackGuard } from '../../main/security/loopback-guard';
import { StubEngine } from '../../main/backend/engine';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import type { ModelStatus } from '../../main/backend/types';

const TOKEN = 'b9-status-models-spec-token';
const TOKEN_HEADER = 'x-desktop-token';

let server: http.Server;
let port: number;

function url(pathname: string): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function guardedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [TOKEN_HEADER]: TOKEN, ...extra };
}

beforeAll(async () => {
  const engine = new StubEngine();
  server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine,
    modelStatus: () => engine.modelStatus(),
  });
  port = await listenOnRandomPort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('b9-status-models: guarded route table membership', () => {
  it('answers GET with the stub payload and 405s other methods', async () => {
    const res = await fetch(url('/status/models'), { headers: guardedHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelStatus;
    expect(body.engine).toBe('stub');
    expect(body.profile).toBe('auto');
    expect(body.models.quality.present).toBe(false);
    expect(body.models.fast.present).toBe(false);
  });

  it('is token-guarded like every route', async () => {
    const unauthorized = await fetch(url('/status/models'));
    expect(unauthorized.status).toBe(401);
  });

  it('rejects wrong methods with 405 (known path, wrong verb)', async () => {
    const res = await fetch(url('/status/models'), {
      method: 'POST',
      headers: guardedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
  });

  it('degrades to the contract-safe 503 when no provider is wired', async () => {
    const bare = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine: new StubEngine(),
    });
    const barePort = await listenOnRandomPort(bare);
    try {
      const res = await fetch(`http://127.0.0.1:${barePort}/status/models`, {
        headers: guardedHeaders(),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toContain('not wired');
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

describe('b9-status-models: LlamaEngine presence reflects the disk, not residency', () => {
  it('reports present with the resolved path only when the GGUF is staged', async () => {
    const modelDir = mkdtempSync(path.join(os.tmpdir(), 'b9-status-models-'));
    // Stage ONLY the fast GGUF: quality stays absent, fast present.
    const fastDir = path.join(modelDir, 'lfm2.5-vl-450m');
    mkdirSync(fastDir);
    writeFileSync(path.join(fastDir, 'model.gguf'), 'gguf-bytes');

    const engine = new LlamaEngine({ modelDir: modelDir, profile: 'fast' });
    const status = engine.modelStatus();
    expect(status.engine).toBe('llama.cpp');
    expect(status.models.quality.present).toBe(false);
    expect(status.models.quality.path).toBeUndefined();
    expect(status.models.fast.present).toBe(true);
    expect(status.models.fast.path).toContain(path.join('lfm2.5-vl-450m', 'model.gguf'));

    // The staged profile must also PASS the readiness check the /ask route
    // runs — presence here must mean "an ask for that profile will not 503".
    await expect(engine.preflight()).resolves.toBeUndefined();
  });
});
