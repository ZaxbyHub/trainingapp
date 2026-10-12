// dev-server-args.test.ts — issue #100 item 5a: direct coverage for the
// headless dev-server's argument/env contract, which previously had NO test
// (dev-server.ts was never imported anywhere; a regression in its arg wiring
// surfaced only via the conformance-host CI script).
//
// Importing the module is safe: dev-server.ts runs main() only under its
// ESM-entry guard, so parseArgs/resolveStorePath are pure to import here.
import { describe, expect, it } from 'vitest';
import { parseArgs, resolveStorePath } from '../../main/backend/dev-server';

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
});
