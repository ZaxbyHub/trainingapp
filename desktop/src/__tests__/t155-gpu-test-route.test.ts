// PR #159 review PRR-034: POST /settings/inference/gpu-test had no test at
// all - neither the wired 200 nor the contract-safe 503 when the host does not
// wire `gpuTest`. `GpuProbeResponse` and `ModelStatus.gpu` were likewise
// unpinned. This pins both shapes against the declared contract.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLoopbackGuard } from '../../main/security/loopback-guard';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { StubEngine } from '../../main/backend/engine';

const TOKEN = 't155-route-token';
const TOKEN_HEADER = 'x-desktop-token';

let server: Server;
let port: number;

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

beforeAll(async () => {
  // No `gpuTest` option: this is the SHAPE a host without probe support
  // produces, and the contract requires a 503 rather than a 404.
  server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: TOKEN_HEADER,
    engine: new StubEngine(),
  });
  port = await listenOnRandomPort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('issue #155: POST /settings/inference/gpu-test', () => {
  it('answers 503 with the contract detail when the host does not wire a probe', async () => {
    const res = await fetch(url('/settings/inference/gpu-test'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail?: string };
    // Byte-identical to the 503 api_server.py raises, which is what
    // run_conformance.py's contract_drift compares.
    expect(body.detail).toBe('GPU probing is not wired on this host');
  });

  it('still traverses the trust guard - no unauthenticated caller reaches the handler', async () => {
    const unauthorized = await fetch(url('/settings/inference/gpu-test'), { method: 'POST' });
    expect(unauthorized.status).toBe(401);
    const wrongOrigin = await fetch(url('/settings/inference/gpu-test'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, origin: 'http://evil.example' },
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it('returns a GpuProbeResponse-shaped 200 when a host wires gpuTest', async () => {
    const wired = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: TOKEN_HEADER,
      engine: new StubEngine(),
      gpuTest: async () => ({
        backend: 'vulkan' as const,
        ok: true,
        reason: 'stub: gpu usable',
        device: 'stub-gpu-0',
      }),
    });
    const wiredPort = await listenOnRandomPort(wired);
    try {
      const res = await fetch(`http://127.0.0.1:${wiredPort}/settings/inference/gpu-test`, {
        method: 'POST',
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Exactly the four fields contracts/api.openapi.yaml's GpuProbeResponse
      // declares, with `required: [backend, ok, reason]`.
      expect(Object.keys(body).sort()).toEqual(['backend', 'device', 'ok', 'reason']);
      expect(body.backend).toBe('vulkan');
      expect(body.ok).toBe(true);
      expect(typeof body.reason).toBe('string');
      expect(typeof body.device === 'string' || body.device === null).toBe(true);
    } finally {
      await new Promise<void>((resolve) => wired.close(() => resolve()));
    }
  });
});
