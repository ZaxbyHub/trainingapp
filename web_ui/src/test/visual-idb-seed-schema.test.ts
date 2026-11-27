/**
 * Visual-spec IndexedDB seed guardrail (issue #393).
 *
 * Executes the REAL page.evaluate seed callback from each Lumen visual spec
 * against a cold fake IndexedDB and asserts the documents schema exists before
 * any transaction. This tests the shipped spec source, not a copy of the fix:
 * reverting either spec's versioned open / store creation turns its row RED.
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptTarget, transpileModule } from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..'); // src/test -> src -> web_ui

const SPECS = [
  'e2e/visual/lumen-doc-list-scroll.spec.ts',
  'e2e/visual/lumen-baseline.spec.ts',
] as const;

/** Extract the seed callback from a spec's source and transpile it to JS. */
function seedCallback(relPath: string): string {
  const source = readFileSync(join(ROOT, relPath), 'utf8');
  const pattern = /page\.evaluate\(\s*(async \([^)]*\) => \{[\s\S]*?\n\s*\})\s*,/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[1].includes('indexedDB.open')) continue;
    const js = transpileModule(`(${match[1]});`, {
      compilerOptions: { target: ScriptTarget.ES2020 },
    }).outputText.trim();
    return js.endsWith(';') ? js.slice(0, -1) : js;
  }
  throw new Error(`no IndexedDB seed callback found in ${relPath}`);
}

describe('Lumen visual specs seed the documents schema before transacting', () => {
  for (const rel of SPECS) {
    test(`${rel}: cold-profile seed resolves and leaves the production schema`, async () => {
      const prefix = `seedguard-${rel.replace(/\W/g, '')}`;
      localStorage.setItem('doc-qa-profile-id', prefix);
      const name = `${prefix}-doc-qa-documents`;

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'));
        request.onblocked = () => resolve();
      });

      const callback = new Function(`return (${seedCallback(rel)})`)() as (args: {
        prefix: string;
        now: number;
        count: number;
      }) => Promise<void>;
      await expect(callback({ prefix, now: Date.UTC(2026, 8, 30, 12, 0, 0), count: 2 })).resolves.toBeUndefined();

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(Array.from(db.objectStoreNames)).toContain('documents');
      const store = db.transaction('documents').objectStore('documents');
      expect(store.keyPath).toBe('id');
      expect(Array.from(store.indexNames).sort()).toEqual(['status', 'uploadedAt']);
      db.close();
    });
  }
});
