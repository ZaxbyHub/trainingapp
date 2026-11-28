/**
 * Pins the documented edgevec 0.9 backend divergence (ASK-D3).
 *
 * The repo intentionally keeps the Vite `edgevecSnippetPlugin` stub instead of
 * edgevec 0.9's shipped snippet so the app's Clear-Cache and profile code keep
 * one IndexedDB schema. This spec does not claim parity: it pins the exact
 * difference so an owner decision cannot be made on an undocumented assumption.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const stubSource = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
const edgevecEntry = readFileSync(
  path.join(ROOT, 'node_modules/edgevec/edgevec.js'),
  'utf8'
);

describe('edgevec 0.9 backend divergence (ASK-D3)', () => {
  test('the shipped 0.9 entry imports its own content-addressed snippet', () => {
    expect(edgevecEntry).toMatch(
      /\.\/snippets\/edgevec-[0-9a-f]+\/src\/js\/storage\.js/
    );
    expect(edgevecEntry).not.toContain('edgevec-98e271a617b3aceb');
  });

  test('the repo stub uses the legacy app-owned schema, not the shipped schema', () => {
    expect(stubSource).toContain("indexedDB.open('edgevec-db', 1)");
    expect(stubSource).toContain("createObjectStore('data')");
    expect(stubSource).not.toContain("indexedDB.open('EdgeVecDB'");
  });

  test('the stub rejects on a missing index so boot treats it as "no index yet"', () => {
    expect(stubSource).toContain("reject(new Error('EdgeVec index not found: ' + dbName))");
  });
});
