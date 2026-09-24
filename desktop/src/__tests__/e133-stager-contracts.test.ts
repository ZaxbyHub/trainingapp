/**
 * e133-stager-contracts.test.ts — issue #133 guardrail: the packaging chain
 * must stage the store/pack contract files INSIDE the asar payload.
 *
 * Root cause this pins: openStore and PackManager locate
 * contracts/store.schema.sql / contracts/pack.schema.json by walking UP from
 * the compiled module. In a packaged app those modules live inside app.asar
 * and nothing outside the asar exists on a clean install — the packaged store
 * only booted when the app happened to sit inside a repo checkout. The fix
 * stages byte-copies under desktop/dist/contracts/, which the electron-builder
 * "dist" files glob packs into app.asar where both walks find them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGED_CONTRACTS, stageContracts } from '../../scripts/stage-installer-resources.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('stageContracts (#133 packaged findRepoRoot)', () => {
  it('stages exactly the two contract files, byte-identical, under dist/contracts/', () => {
    expect(STAGED_CONTRACTS).toEqual(['contracts/store.schema.sql', 'contracts/pack.schema.json']);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e133-stager-'));
    try {
      stageContracts(tmp);
      for (const rel of STAGED_CONTRACTS) {
        const staged = path.join(tmp, 'dist', rel);
        expect(fs.existsSync(staged), `staged copy missing: ${rel}`).toBe(true);
        const original = fs.readFileSync(path.join(REPO_ROOT, rel));
        expect(fs.readFileSync(staged).equals(original), `${rel} must be a byte-identical copy`).toBe(true);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the electron-builder files glob carries dist/contracts into app.asar', () => {
    const yml = fs.readFileSync(path.join(REPO_ROOT, 'desktop', 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/- dist\/\*\*\/\*/);
  });
});
