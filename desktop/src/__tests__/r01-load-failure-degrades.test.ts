// r01-load-failure-degrades.test.ts — PRR-001 regression pin (PR #202 review).
//
// The lazy native-addon loading introduced by the test-batch made a
// MODULE_NOT_FOUND / ABI load failure reachable inside
// `checkStoreIntegrity`'s corruption verdict, which drove `recoverStore`'s
// auto path to `fs.rmSync` the user's real store before the rethrow degraded
// to store-less. The contract pinned here: a native-addon LOAD failure is an
// environment failure — the host DEGRADES ("continuing without store") and
// the store file is left untouched; it is never routed into corruption
// recovery, and a direct `recoverStore` caller refuses loudly.
//
// The forced load failure is produced by intercepting Node's CJS loader
// (recovery.ts resolves the addon through createRequire, which goes through
// Module._load) — a real MODULE_NOT_FOUND shape, not a mock of the module.
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverOrDegradeStore } from '../../main/backend/index.js';
import { checkStoreIntegrity, recoverStore } from '../../main/backend/store/recovery.js';

type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };

function withMissingAddon<T>(fn: () => T): T {
  const mod = Module as unknown as ModuleWithLoad;
  const original = mod._load;
  mod._load = (request, parent, isMain) => {
    if (request === 'better-sqlite3' || request === 'sqlite-vec') {
      const err = new Error(`Cannot find module '${request}'`);
      (err as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return original.call(mod, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    mod._load = original;
  }
}

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r01-load-failure-'));
  dbPath = path.join(tempDir, 'store.sqlite');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('native-addon load failure degrades, never deletes (PRR-001)', () => {
  it('checkStoreIntegrity classifies a load failure as loadFailure, not corruption', () => {
    fs.writeFileSync(dbPath, 'pretend store bytes');
    const result = withMissingAddon(() => checkStoreIntegrity(dbPath));
    expect(result.ok).toBe(false);
    expect(result.loadFailure, 'a missing addon must be flagged as a load failure').toBe(true);
    expect(result.message).toContain('native addon unavailable');
  });

  it('recoverOrDegradeStore degrades to a null store and leaves the store file untouched', async () => {
    const payload = 'pretend store bytes that recovery must never delete';
    fs.writeFileSync(dbPath, payload);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let handle: unknown;
    let logged = '';
    try {
      handle = await withMissingAddon(() =>
        recoverOrDegradeStore({ storePath: dbPath }, new Error('injected open failure')),
      );
      // Capture BEFORE mockRestore — restore clears the recorded calls.
      logged = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    } finally {
      errorSpy.mockRestore();
    }
    expect(handle).toBeNull();
    // The named mutant (drop `|| integrity.loadFailure === true` from the
    // degrade gate) routes this call into recoverStore instead — the store
    // file survives ONLY because recoverStore's own refusal guard throws, so
    // the discriminating assertion is WHICH branch ran: degrade must log
    // "continuing without store", never the recovery-failure line.
    expect(logged, 'the degrade branch must run').toContain('continuing without store');
    expect(logged, 'the recovery branch must NOT run').not.toContain('recovery could not restore');
    expect(fs.existsSync(dbPath), 'the store file must survive a load failure').toBe(true);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe(payload);
  });

  it('recoverStore refuses loudly on a load failure instead of reinitializing', async () => {
    fs.writeFileSync(dbPath, 'pretend store bytes');
    await expect(
      withMissingAddon(() =>
        recoverStore({ dbPath, backupsDir: path.join(tempDir, 'backups'), dims: 384 }),
      ),
    ).rejects.toThrow(/native addon could not be loaded.*store was left untouched/s);
    expect(fs.existsSync(dbPath), 'the store file must survive the refused recovery').toBe(true);
  });
});
