/**
 * settings-wiring-honesty guardrail (a): every `localStorage.setItem` /
 * `removeItem` in web_ui/src names its key through an identifier imported
 * from persisted-keys.ts whose value is registered as a user setting (cleared
 * by Clear Cache) or as internal bookkeeping. A new persisted setting that
 * bypasses the registry — a string literal, a local constant — fails here,
 * so Clear Cache can never silently miss it again (the AC5 defect class).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as registry from './persisted-keys';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_FILE = path.join(SRC_ROOT, 'lib', 'storage', 'persisted-keys.ts');
const REGISTERED = new Set<string>([...registry.USER_SETTING_KEYS, ...registry.INTERNAL_KEYS]);

/** Production source files (tests, test helpers and the registry itself excluded). */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__' || full === path.join(SRC_ROOT, 'test')) continue;
      out.push(...productionSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      if (full !== REGISTRY_FILE) out.push(full);
    }
  }
  return out;
}

function isLocalStorage(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'localStorage';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'localStorage';
}

interface StorageWrite {
  line: number;
  method: string;
  ok: boolean;
  detail: string;
}

/** Every localStorage.setItem/removeItem call in `source`, judged against the registry rule. */
function scanStorageWrites(fileName: string, source: string): StorageWrite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // local name -> exported name, for imports from the registry module
  const imported = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!/(^|\/)persisted-keys$/.test(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) imported.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  const writes: StorageWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'setItem' || node.expression.name.text === 'removeItem') &&
      isLocalStorage(node.expression.expression)
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const arg = node.arguments[0];
      let ok = false;
      let detail = arg === undefined ? '<no key>' : arg.getText(sf);
      if (arg !== undefined && ts.isIdentifier(arg) && imported.has(arg.text)) {
        const exportedName = imported.get(arg.text) as string;
        const value = (registry as Record<string, unknown>)[exportedName];
        ok = typeof value === 'string' && REGISTERED.has(value);
        detail = `${exportedName}=${String(value)}`;
      }
      writes.push({ line, method: node.expression.name.text, ok, detail });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return writes;
}

describe('persisted-keys guardrail (a): storage writes go through the registry', () => {
  it('every localStorage.setItem/removeItem key in web_ui/src is a registered persisted-keys identifier', () => {
    const violations: string[] = [];
    let total = 0;
    for (const file of productionSources(SRC_ROOT)) {
      for (const write of scanStorageWrites(file, fs.readFileSync(file, 'utf8'))) {
        total += 1;
        if (!write.ok) violations.push(`${path.relative(SRC_ROOT, file)}:${write.line} ${write.method}(${write.detail})`);
      }
    }
    // Non-vacuity: the scan must actually see the app's storage writes.
    expect(total).toBeGreaterThanOrEqual(12);
    expect(violations).toEqual([]);
  });

  it('the scanner flags a literal key, an unregistered local constant, and window.localStorage', () => {
    const literal = scanStorageWrites('x.ts', "localStorage.setItem('new-setting', '1');");
    const localConst = scanStorageWrites('x.ts', "const K = 'theme-preference'; localStorage.removeItem(K);");
    const viaWindow = scanStorageWrites('x.ts', "window.localStorage.setItem('k', 'v');");
    const registered = scanStorageWrites(
      'x.ts',
      "import { THEME_PREFERENCE_KEY as T } from '../storage/persisted-keys'; localStorage.setItem(T, 'dark');",
    );
    expect(literal.map((w) => w.ok)).toEqual([false]);
    expect(localConst.map((w) => w.ok)).toEqual([false]);
    expect(viaWindow.map((w) => w.ok)).toEqual([false]);
    expect(registered.map((w) => w.ok)).toEqual([true]);
  });
});

describe('clearUserSettings (Clear Cache, AC5)', () => {
  it('removes every registered user setting and keeps internal bookkeeping keys', () => {
    localStorage.clear();
    for (const key of registry.USER_SETTING_KEYS) localStorage.setItem(key, 'x');
    for (const key of registry.INTERNAL_KEYS) localStorage.setItem(key, 'keep');

    const removed = registry.clearUserSettings();

    expect([...removed].sort()).toEqual([...registry.USER_SETTING_KEYS].sort());
    for (const key of registry.USER_SETTING_KEYS) expect(localStorage.getItem(key)).toBeNull();
    for (const key of registry.INTERNAL_KEYS) expect(localStorage.getItem(key)).toBe('keep');
    localStorage.clear();
  });

  it('covers the settings the issue named (mode blob, theme, provider API key)', () => {
    expect(registry.USER_SETTING_KEYS).toEqual(
      expect.arrayContaining(['inference-mode', 'theme-preference', 'openai-provider-apikey']),
    );
    // User settings and internal keys never overlap.
    expect(registry.USER_SETTING_KEYS.filter((k) => registry.INTERNAL_KEYS.includes(k))).toEqual([]);
  });
});
