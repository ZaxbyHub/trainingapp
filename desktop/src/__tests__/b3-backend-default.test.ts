// B3 acceptance spec (C8, NEW-SURFACE — issue #61): the backend-mode selector
// contract. Default (no config) -> node host; "node" -> node host; "sidecar"
// -> sidecar host; both expose the ONE interface (start resolves to the bound
// port, stop). Also pins the env-flip: TRAININGAPP_DESKTOP_BACKEND_MODE
// changes the resolved default without touching call sites.
import { afterEach, describe, expect, it } from 'vitest';
import { SidecarBackendHost, createBackendHost, resolveBackendMode, NodeBackendHost } from '../../main/backend/index';
import { BACKEND_MODE_ENV, DEFAULT_BACKEND_MODE, RESERVED_PROFILE_HEADER_NAME } from '../../main/backend/types';
import type { BackendHost } from '../../main/backend/types';

const started: BackendHost[] = [];

afterEach(async () => {
  for (const host of started.splice(0).reverse()) {
    await host.stop();
  }
  delete process.env[BACKEND_MODE_ENV];
});

describe('b3-backend-default (C8): selector contract', () => {
  it('defaults to the node host when no mode is configured', () => {
    expect(DEFAULT_BACKEND_MODE).toBe('node');
    expect(resolveBackendMode({ env: {} })).toBe('node');
    const host = createBackendHost({ token: 't', env: {} });
    started.push(host);
    expect(host.mode).toBe('node');
    expect(host).toBeInstanceOf(NodeBackendHost);
  });

  it('resolves explicit "node" to the node host', () => {
    const host = createBackendHost({ token: 't', mode: 'node' });
    started.push(host);
    expect(host).toBeInstanceOf(NodeBackendHost);
  });

  it('resolves explicit "sidecar" to the sidecar host', () => {
    const host = createBackendHost({
      token: 't',
      mode: 'sidecar',
      sidecar: { command: 'definitely-not-spawned-by-construction' },
    });
    expect(host).toBeInstanceOf(SidecarBackendHost);
  });

  it(`flips the default via ${BACKEND_MODE_ENV}`, () => {
    expect(resolveBackendMode({ env: { [BACKEND_MODE_ENV]: 'sidecar' } })).toBe('sidecar');
    expect(resolveBackendMode({ env: { [BACKEND_MODE_ENV]: 'node' } })).toBe('node');
    expect(resolveBackendMode({ env: { [BACKEND_MODE_ENV]: 'garbage' } })).toBe('node');
    const host = createBackendHost({
      token: 't',
      env: { [BACKEND_MODE_ENV]: 'sidecar' },
      sidecar: { command: 'definitely-not-spawned-by-construction' },
    });
    expect(host).toBeInstanceOf(SidecarBackendHost);
  });

  it('the one interface: node host start() resolves to the bound loopback port and stop() releases it', async () => {
    const host = createBackendHost({ token: 't', mode: 'node' });
    started.push(host);
    const handle = await host.start();
    expect(handle.mode).toBe('node');
    expect(Number.isInteger(handle.port)).toBe(true);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
    await host.stop();
    // Idempotent stop.
    await host.stop();
  });

  it('the sidecar host refuses to start without sidecar.command (loud, not silent)', async () => {
    const host = createBackendHost({ token: 't', mode: 'sidecar' });
    await expect(host.start()).rejects.toThrow(/sidecar\.command/);
  });

  it('reserves the B6 profile header slot as a named constant', () => {
    expect(RESERVED_PROFILE_HEADER_NAME).toBe('X-Profile-Id');
  });
});
