// C5 / AC7 (issue #60, Workstream B2): the per-launch desktop auth token is
// minted with crypto.randomBytes(32) as 64 hex chars, is unique per mint
// (unguessable, fresh every launch), and is never persisted to disk nor
// logged — main-process memory only.
//
// Seam contract (frozen; desktop/main/security/token.ts — NEW module):
//   export function mintLaunchToken(): string
//     - returns crypto.randomBytes(32).toString('hex'): a 64-char lowercase
//       hex string (32 bytes of entropy);
//     - every call yields a fresh value (no caching across launches/calls);
//     - performs NO filesystem writes and logs nothing (no console method
//       receives the token — or anything else — during a mint).
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias), though
// this seam is expected to stay Electron-free.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { mintLaunchToken } from '../../main/security/token';

let writeSync: ReturnType<typeof vi.spyOn>;
let appendSync: ReturnType<typeof vi.spyOn>;
let writeAsync: ReturnType<typeof vi.spyOn>;
let consoleSpies: Map<string, ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  __resetElectronStub();
  // Persistence guard: minting must not touch the filesystem through the
  // usual write surfaces (verified viable on node:fs / fs.promises here).
  writeSync = vi.spyOn(fs, 'writeFileSync');
  appendSync = vi.spyOn(fs, 'appendFileSync');
  writeAsync = vi.spyOn(fs.promises, 'writeFile');
  // Logging guard: no console method may receive the token.
  consoleSpies = new Map(
    (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => [m, vi.spyOn(console, m).mockImplementation(() => {})]),
  );
});

afterEach(() => {
  writeSync.mockRestore();
  appendSync.mockRestore();
  writeAsync.mockRestore();
  for (const s of consoleSpies.values()) s.mockRestore();
});

/** Flattened string rendering of every argument every console spy received. */
function consoleOutput(): string {
  let all = '';
  for (const s of consoleSpies.values()) {
    for (const call of s.mock.calls) all += call.map((a) => String(a)).join(' ') + '\n';
  }
  return all;
}

describe('C5 token lifecycle (AC7)', () => {
  it('mints a 64-char lowercase hex token (crypto.randomBytes(32).toString("hex"))', () => {
    const token = mintLaunchToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a UNIQUE token on every call (fresh per launch, unguessable)', () => {
    const mints = new Set<string>();
    for (let i = 0; i < 8; i++) mints.add(mintLaunchToken());
    expect(mints.size, '8 mints must produce 8 distinct tokens').toBe(8);
  });

  it('never persists the token: no fs write surface is called during a mint', () => {
    const token = mintLaunchToken();
    expect(writeSync).not.toHaveBeenCalled();
    expect(appendSync).not.toHaveBeenCalled();
    expect(writeAsync).not.toHaveBeenCalled();
    // Belt-and-braces: even if some write fired, the token must not be in it.
    for (const spy of [writeSync, appendSync, writeAsync]) {
      for (const call of spy.mock.calls) {
        expect(call.some((a) => String(a).includes(token))).toBe(false);
      }
    }
  });

  it('never logs the token: no console method receives it during a mint', () => {
    const token = mintLaunchToken();
    expect(consoleOutput()).not.toContain(token);
  });
});
