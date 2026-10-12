// dev-server-args.test.ts — issue #100 item 5a: direct coverage for the
// headless dev-server's argument/env contract, which previously had NO test
// (dev-server.ts was never imported anywhere; a regression in its arg wiring
// surfaced only via the conformance-host CI script).
//
// Importing the module is safe: dev-server.ts runs main() only under its
// ESM-entry guard, so parseArgs/resolveStorePath are pure to import here.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installShutdownHandlers, parseArgs, resolveStorePath } from '../../main/backend/dev-server';

describe('dev-server parseArgs (issue #100 item 5a)', () => {
  it('parses the frozen CLI shape including --store-path', () => {
    const args = parseArgs(['--port-file', '/tmp/pf', '--token', 'tk', '--store-path', '/tmp/store.db']);
    expect(args.portFile).toBe('/tmp/pf');
    expect(args.token).toBe('tk');
    expect(args.storePath).toBe('/tmp/store.db');
    expect(args.sidecar?.args).toEqual([]);
  });

  it('rejects an unknown argument loudly', () => {
    expect(() => parseArgs(['--port-file', 'pf', '--token', 'tk', '--bogus'])).toThrow(
      'unknown argument: --bogus',
    );
  });

  it('rejects a flag missing its value', () => {
    expect(() => parseArgs(['--port-file'])).toThrow('--port-file requires a value');
  });

  it('requires both --port-file and --token', () => {
    expect(() => parseArgs([])).toThrow('--port-file is required');
    expect(() => parseArgs(['--port-file', 'pf'])).toThrow('--token is required');
  });
});

describe('dev-server resolveStorePath (issue #100 item 5a)', () => {
  it('prefers the CLI flag over the env fallback', () => {
    expect(
      resolveStorePath({ storePath: '/cli/store.db' }, { TRAININGAPP_DESKTOP_STORE_PATH: '/env/store.db' }),
    ).toBe('/cli/store.db');
  });

  it('falls back to TRAININGAPP_DESKTOP_STORE_PATH, then undefined', () => {
    expect(resolveStorePath({}, { TRAININGAPP_DESKTOP_STORE_PATH: '/env/store.db' })).toBe(
      '/env/store.db',
    );
    expect(resolveStorePath({}, {})).toBeUndefined();
  });

  // swarm-pr-review PRR-013: an empty string counts as unset at BOTH levels —
  // `--store-path ""` (an empty-variable accident) must fall through to the
  // env value instead of shadowing it, and an empty env must not win either.
  it('treats an empty CLI flag or env value as unset (PRR-013)', () => {
    expect(
      resolveStorePath({ storePath: '' }, { TRAININGAPP_DESKTOP_STORE_PATH: '/env/store.db' }),
    ).toBe('/env/store.db');
    expect(resolveStorePath({ storePath: '' }, {})).toBeUndefined();
    expect(resolveStorePath({}, { TRAININGAPP_DESKTOP_STORE_PATH: '' })).toBeUndefined();
    expect(resolveStorePath({ storePath: '' }, { TRAININGAPP_DESKTOP_STORE_PATH: '' })).toBeUndefined();
  });
});

describe('dev-server single-source store-path pin (swarm-pr-review PRR-017)', () => {
  it('reads TRAININGAPP_DESKTOP_STORE_PATH through env in exactly one place', () => {
    // Every consumer must resolve through resolveStorePath; a second direct
    // env read would silently reintroduce per-site precedence drift.
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../main/backend/dev-server.ts', import.meta.url)),
      'utf8',
    );
    const directReads = source.match(/env\.TRAININGAPP_DESKTOP_STORE_PATH/g) ?? [];
    expect(directReads).toHaveLength(1);
  });
});

describe('dev-server installShutdownHandlers (swarm-pr-review PRR-033)', () => {
  it('wires stdin end, SIGINT and SIGTERM to the one stop callback', () => {
    const registrations: Array<{ ns: string; event: string; cb: () => void }> = [];
    const record =
      (ns: string) =>
      (event: string, cb: () => void): void => {
        registrations.push({ ns, event, cb });
      };
    let stopCalls = 0;
    installShutdownHandlers({ on: record('stdin') }, { on: record('proc') }, () => {
      stopCalls += 1;
    });

    // Exact event names: a swapped or duplicate registration (e.g. SIGINT
    // twice, SIGTERM never) must fail, not just "three handlers exist".
    expect(registrations.map((r) => `${r.ns}:${r.event}`)).toEqual([
      'stdin:end',
      'proc:SIGINT',
      'proc:SIGTERM',
    ]);
    for (const r of registrations) r.cb();
    expect(stopCalls).toBe(3);
  });
});
