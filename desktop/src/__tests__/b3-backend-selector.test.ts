// B3 acceptance spec (C5, NEW-SURFACE — issue #61): flipping backend.mode
// swaps the implementation WITHOUT touching call sites. The factory is the
// only consumer-side surface; two DIFFERENT implementations satisfy the SAME
// public interface (duck-typed method set), driven only by config.
import { afterEach, describe, expect, it } from 'vitest';
import { NodeBackendHost, SidecarBackendHost, createBackendHost } from '../../main/backend/index';
import type { BackendHost } from '../../main/backend/types';

const started: BackendHost[] = [];

afterEach(async () => {
  for (const host of started.splice(0).reverse()) {
    await host.stop();
  }
});

describe('b3-backend-selector (C5): one interface, config-driven swap', () => {
  it('mode "node" and mode "sidecar" yield two DIFFERENT implementations', () => {
    const node = createBackendHost({ token: 't', mode: 'node' });
    started.push(node);
    const sidecar = createBackendHost({
      token: 't',
      mode: 'sidecar',
      sidecar: { command: 'definitely-not-spawned-by-construction' },
    });
    expect(node).toBeInstanceOf(NodeBackendHost);
    expect(sidecar).toBeInstanceOf(SidecarBackendHost);
    expect(Object.getPrototypeOf(node)).not.toBe(Object.getPrototypeOf(sidecar));
  });

  it('both implementations expose the SAME public interface (duck-typed)', () => {
    const publicMethods = (host: BackendHost): string[] =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(host))
        .filter((name) => name !== 'constructor')
        .sort();
    const node = createBackendHost({ token: 't', mode: 'node' });
    started.push(node);
    const sidecar = createBackendHost({
      token: 't',
      mode: 'sidecar',
      sidecar: { command: 'definitely-not-spawned-by-construction' },
    });
    expect(publicMethods(node)).toEqual(publicMethods(sidecar));
    expect(publicMethods(node)).toEqual(expect.arrayContaining(['start', 'stop']));
    expect(typeof node.start).toBe('function');
    expect(typeof node.stop).toBe('function');
    expect(typeof sidecar.start).toBe('function');
    expect(typeof sidecar.stop).toBe('function');
  });

  it('the swap is driven ONLY by the config value — the call site is identical', () => {
    // Identical construction expression except for the mode string: this is
    // what "no call-site changes" means — a caller passes a different config
    // value and receives a fully compliant host.
    const make = (mode: 'node' | 'sidecar'): BackendHost =>
      createBackendHost({
        token: 't',
        mode,
        sidecar: mode === 'sidecar' ? { command: 'definitely-not-spawned-by-construction' } : undefined,
      });
    const a = make('node');
    started.push(a);
    const b = make('sidecar');
    expect(a.mode).toBe('node');
    expect(b.mode).toBe('sidecar');
    expect(a).toBeInstanceOf(NodeBackendHost);
    expect(b).toBeInstanceOf(SidecarBackendHost);
  });
});
