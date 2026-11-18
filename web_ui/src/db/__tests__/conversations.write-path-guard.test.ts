// Static write-path guard (issue #367 guardrail a, NOT frozen): the ONLY
// production writers of the conversations table live in web_ui/src/db/* and
// go through db-crypto. A raw write outside the db layer fails this guard
// (executed mutant in 08a: a stray db.conversations.put in a storage helper).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i += 1) {
    if (readdirSync(dir).includes('contracts')) return dir;
    dir = join(dir, '..');
  }
  throw new Error('repo root not found');
}

const ROOT = repoRoot();
const WRITE_CALL = /\.(conversations|meta)\s*\.\s*(add|put|bulkPut|update|delete|clear)\s*\(/;
const CRYPTO_IMPORT = /from\s+['"][^'"]*db-crypto['"]/;

function productionFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report', '.agents', 'scripts']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.|\.spec\.|__tests__|\/e2e\//.test(entry.name.replace(/\\/g, '/'))) continue;
      out.push(join(dir, entry.name));
    }
  };
  walk(join(ROOT, 'web_ui', 'src'));
  walk(join(ROOT, 'desktop', 'src'));
  return out;
}

describe('conversations write-path guard (#367 guardrail a)', () => {
  it('no production file outside web_ui/src/db writes the conversations/meta tables (write-path-guard)', () => {
    const violations: string[] = [];
    for (const file of productionFiles()) {
      const rel = file.replace(/\\/g, '/').slice(ROOT.length + 1);
      if (rel.startsWith('web_ui/src/db/')) continue; // the db layer owns writes
      const text = readFileSync(file, 'utf-8');
      if (WRITE_CALL.test(text)) violations.push(rel);
    }
    expect(violations, `raw table writes outside the db layer: ${violations.join(', ')}`).toEqual([]);
  });

  it('db-crypto is imported only by the db layer (write-path-guard)', () => {
    const violations: string[] = [];
    for (const file of productionFiles()) {
      const rel = file.replace(/\\/g, '/').slice(ROOT.length + 1);
      if (rel.startsWith('web_ui/src/db/')) continue;
      const text = readFileSync(file, 'utf-8');
      if (CRYPTO_IMPORT.test(text)) violations.push(rel);
    }
    expect(violations, `db-crypto imported outside the db layer: ${violations.join(', ')}`).toEqual([]);
  });
});
