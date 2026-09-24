/**
 * e133-asar-sqlite-vec.test.ts — issue #133 guardrail: the sqlite-vec native
 * extension must load from a REAL file path in packaged builds.
 *
 * Root cause this pins: sqlite-vec's load(db) resolves vec0.dll via
 * require.resolve, which inside a packaged app yields a path in the VIRTUAL
 * app.asar archive; native loadExtension cannot open virtual files, the store
 * open fails ("The specified module could not be found"), the store degrades
 * to null, and the whole pack lifecycle (embedder + PackManager) never
 * constructs — the wizard could never complete and /packs 503'd.
 *
 * Pins (1) the unpackAsarPath rewrite behavior (asar path with an existing
 * .unpacked twin → twin; asar path without a twin → unchanged; non-asar path
 * → unchanged) and (2) the WIRING in both consumers — sqlite-store.ts's
 * openStore and pack-manager.ts's readPrebuiltIndex must call the helper at
 * their load sites (a helper nobody calls is unwired).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackAsarPath } from '../../main/backend/store/sqlite-store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('unpackAsarPath (#133 asar-safe native loads)', () => {
  it('rewrites an in-asar path to its existing app.asar.unpacked twin', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e133-asar-'));
    const twin = path.join(tmp, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64');
    fs.mkdirSync(twin, { recursive: true });
    fs.writeFileSync(path.join(twin, 'vec0.dll'), 'twin-bytes');
    const inAsar = path.join(tmp, 'app.asar', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll');
    expect(unpackAsarPath(inAsar)).toBe(path.join(twin, 'vec0.dll'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes an in-asar path through unchanged when no unpacked twin exists', () => {
    const inAsar = path.join('C:', 'resources', 'app.asar', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll');
    expect(unpackAsarPath(inAsar)).toBe(inAsar);
  });

  it('passes non-asar paths through unchanged (dev / plain node)', () => {
    const plain = path.join('C:', 'repo', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll');
    expect(unpackAsarPath(plain)).toBe(plain);
  });
});

describe('both sqlite-vec consumers are wired to the helper (#133)', () => {
  const consumers = [
    'desktop/main/backend/store/sqlite-store.ts',
    'desktop/main/backend/store/pack-manager.ts',
  ];

  it.each(consumers)('%s loads through unpackAsarPath(getLoadablePath())', (rel) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    expect(source, `${rel} must import or define the helper`).toMatch(/unpackAsarPath/);
    // The call site: db.loadExtension(unpackAsarPath(sqliteVec.getLoadablePath()))
    expect(source, `${rel} must CALL the helper at its sqlite-vec load site`).toMatch(
      /loadExtension\(\s*unpackAsarPath\(\s*\w+\.getLoadablePath\(\)\s*\)/,
    );
  });
});
