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

/** A string-literal element-access argument (`x['name']`), or null. */
function literalElement(node: ts.ElementAccessExpression): string | null {
  const arg = node.argumentExpression;
  return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
}

/** The storage member name read through `node.parent` (`.name` or `['name']`), or null. */
function memberName(ref: ts.Node): string | null {
  const parent = ref.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === ref) return parent.name.text;
  if (ts.isElementAccessExpression(parent) && parent.expression === ref) return literalElement(parent);
  return null;
}

/** True when an identifier sits in a declaration/name slot rather than reading a value. */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
    ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent)) && parent.name === node) ||
    ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) || ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent)
  );
}

/** The static text of a property name (`a`, `'a'`, `['a']`), or null when computed. */
function staticPropertyName(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  }
  return null;
}

/** An object literal used as a destructuring-assignment target (`({ a: b } = src)`). */
function isAssignmentPattern(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  return ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** Globals that expose `localStorage` as a property. */
const STORAGE_HOSTS = new Set(['window', 'globalThis', 'self']);

/**
 * `window[expr]` / `globalThis[expr]` / `self[expr]` with a non-literal key:
 * it may resolve to localStorage and cannot be followed statically.
 */
function isComputedGlobalAccess(node: ts.Node): node is ts.ElementAccessExpression {
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    STORAGE_HOSTS.has(node.expression.text) &&
    literalElement(node) === null
  );
}

/** `localStorage`, `<expr>.localStorage` or `<expr>['localStorage']` as a value. */
function isLocalStorageRef(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'localStorage' && !isNamePosition(node);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'localStorage';
  if (ts.isElementAccessExpression(node)) return literalElement(node) === 'localStorage';
  return false;
}

interface StorageWrite {
  line: number;
  method: string;
  ok: boolean;
  detail: string;
}

/**
 * Every localStorage write in `source`, judged against the registry rule
 * (PR #140 review FB140-009 widened the shapes):
 *  - receivers: `localStorage`, `window.localStorage`, `x['localStorage']`,
 *    and aliases of those, followed to a fixpoint (`const a = localStorage;
 *    const b = a`, `b = a`, `const { localStorage: s } = window`, ...);
 *  - methods: `.setItem` / `.removeItem` and `['setItem']` / `['removeItem']`
 *    — the key must be a registered persisted-keys identifier; `.clear()`
 *    (a keyless wipe) is always a violation;
 *  - any OTHER use of a storage reference (passed as an argument,
 *    destructured into a pattern, `.length`, an alias used as a value,
 *    `export default`, ...) is a violation, so a new shape fails loudly
 *    instead of slipping past. Only `typeof` guards and member reads/calls
 *    such as getItem are allowed;
 *  - `window` / `globalThis` / `self` indexed with a non-literal key is a
 *    violation (it cannot be resolved statically).
 *
 * Limits, stated honestly:
 *  - the analysis is PER FILE. An importer of a storage handle is never seen,
 *    so exporting one (`export const s = localStorage`, `export { s }`,
 *    `export { s as t }`, exported destructuring) is itself a violation;
 *  - aliases are tracked by NAME, not by scope (a shadowing name can only
 *    over-report, never hide a write);
 *  - host aliases (`const w = window; w[expr]` or `w.localStorage`) and
 *    reflective enumeration (`Object.entries(window)`, `Object.values(...)`)
 *    are NOT followed;
 *  - sessionStorage is out of scope: Clear Cache clears localStorage only.
 */
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
  // Aliases: `const s = localStorage` (any storage-reference initializer,
  // INCLUDING another alias, so chains like `const b = a` are followed), plain
  // assignments `b = a`, and the storage property destructured out of ANY
  // object, renamed or not (`const { localStorage: s } = window`,
  // `function f({ localStorage: s })`, `({ localStorage: s } = globalThis)`).
  // Computed to a FIXPOINT: passes repeat until the alias set stops growing,
  // so declaration order does not matter. A destructuring target that is
  // itself a pattern cannot be followed and is flagged as unresolved.
  const aliases = new Set<string>();
  // The declarations / assignments the collector recorded as alias sources —
  // the only places a storage reference may appear without being judged.
  const aliasDecls = new Set<ts.Node>();
  const unresolved = new Set<ts.Node>();
  const isStorageRef = (node: ts.Node): boolean =>
    isLocalStorageRef(node) || (ts.isIdentifier(node) && aliases.has(node.text) && !isNamePosition(node));
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isStorageRef(node.initializer)) {
      aliases.add(node.name.text);
      aliasDecls.add(node);
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) && isStorageRef(node.right)
    ) {
      aliases.add(node.left.text);
      aliasDecls.add(node);
    }
    if (ts.isBindingElement(node) && staticPropertyName(node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined)) === 'localStorage') {
      if (ts.isIdentifier(node.name)) aliases.add(node.name.text);
      else unresolved.add(node);
    }
    if (ts.isObjectLiteralExpression(node) && isAssignmentPattern(node)) {
      for (const prop of node.properties) {
        if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'localStorage') {
          aliases.add(prop.name.text);
        } else if (ts.isPropertyAssignment(prop) && staticPropertyName(prop.name) === 'localStorage') {
          if (ts.isIdentifier(prop.initializer)) aliases.add(prop.initializer.text);
          else unresolved.add(prop);
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  for (let size = -1; aliases.size !== size; ) {
    size = aliases.size;
    collectAliases(sf);
  }

  // Module boundary: names this file exports (exported variable statements,
  // including destructured bindings, and local `export { a as b }` lists).
  // An exported storage handle is checked below as a violation, because
  // its importers are outside this per-file analysis.
  const exportSites: Array<{ local: string; site: ts.Node }> = [];
  const addBindingNames = (name: ts.BindingName, site: ts.Node): void => {
    if (ts.isIdentifier(name)) {
      exportSites.push({ local: name.text, site });
      return;
    }
    for (const el of name.elements) {
      if (!ts.isOmittedExpression(el)) addBindingNames(el.name, site);
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of stmt.declarationList.declarations) addBindingNames(decl.name, decl);
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier === undefined && stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) exportSites.push({ local: (spec.propertyName ?? spec.name).text, site: spec });
    }
  }

  const writes: StorageWrite[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (isComputedGlobalAccess(node)) {
      writes.push({ line: lineOf(node), method: '<computed>', ok: false, detail: `unresolvable computed global access: ${node.getText(sf)}` });
      return;
    }
    if (isStorageRef(node)) {
      const parent = node.parent;
      const method = memberName(node);
      if (ts.isTypeOfExpression(parent) || ts.isTypeQueryNode(parent)) {
        // `typeof localStorage` guard — not a write.
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && aliasDecls.has(parent)) {
        // Recorded alias declaration — the alias's own uses are judged.
      } else if (ts.isBinaryExpression(parent) && aliasDecls.has(parent) && (parent.left === node || parent.right === node)) {
        // Recorded alias assignment `b = a` — the alias's own uses are judged.
      } else if (
        ts.isPropertyAssignment(parent) && parent.initializer === node &&
        ts.isObjectLiteralExpression(parent.parent) && isAssignmentPattern(parent.parent) &&
        staticPropertyName(parent.name) === 'localStorage'
      ) {
        // `({ localStorage: s } = src)` — the alias target; its uses are judged.
      } else if (method !== null) {
        const call = parent.parent;
        const called = call !== undefined && ts.isCallExpression(call) && call.expression === parent;
        if (method === 'setItem' || method === 'removeItem') {
          if (!called) {
            writes.push({ line: lineOf(node), method, ok: false, detail: `${method} referenced without being called` });
          } else {
            const arg = call.arguments[0];
            let ok = false;
            let detail = arg === undefined ? '<no key>' : arg.getText(sf);
            if (arg !== undefined && ts.isIdentifier(arg) && imported.has(arg.text)) {
              const exportedName = imported.get(arg.text) as string;
              const value = (registry as Record<string, unknown>)[exportedName];
              ok = typeof value === 'string' && REGISTERED.has(value);
              detail = `${exportedName}=${String(value)}`;
            }
            writes.push({ line: lineOf(node), method, ok, detail });
          }
        } else if (method === 'clear') {
          writes.push({ line: lineOf(node), method, ok: false, detail: 'clear() removes every key, registered or not' });
        } else if (!called && !['getItem', 'key'].includes(method)) {
          writes.push({ line: lineOf(node), method, ok: false, detail: `unexpected storage member '${method}'` });
        }
        // getItem / key reads are allowed.
      } else {
        writes.push({ line: lineOf(node), method: '<reference>', ok: false, detail: `bare storage reference: ${node.getText(sf)}` });
      }
      // The receiver's own sub-expressions (e.g. `window`) need no visit.
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const { local, site } of exportSites) {
    if (aliases.has(local) || local === 'localStorage') {
      writes.push({ line: lineOf(site), method: '<exported>', ok: false, detail: `storage handle exported across a module boundary: ${local}` });
    }
  }
  for (const node of unresolved) {
    writes.push({ line: lineOf(node), method: '<reference>', ok: false, detail: `unresolved destructuring of localStorage: ${node.getText(sf)}` });
  }
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

  // PR #140 review (FB140-009): shapes the first scanner let through silently.
  it('the scanner flags element-access methods/receivers and aliased receivers with an unregistered key', () => {
    const okOf = (src: string) => scanStorageWrites('x.ts', src).map((w) => w.ok);
    expect(okOf("localStorage['setItem']('new-setting', '1');")).toEqual([false]);
    expect(okOf("window['localStorage'].setItem('new-setting', '1');")).toEqual([false]);
    expect(okOf("window['localStorage']['removeItem']('new-setting');")).toEqual([false]);
    expect(okOf("const s = localStorage; s.setItem('new-setting', '1');")).toEqual([false]);
    expect(okOf("const s = window.localStorage; s['removeItem']('new-setting');")).toEqual([false]);
  });

  it('the scanner accepts a registered key through an alias or an element-access method', () => {
    const imp = "import { THEME_PREFERENCE_KEY as T } from '../storage/persisted-keys';\n";
    const okOf = (src: string) => scanStorageWrites('x.ts', imp + src).map((w) => w.ok);
    expect(okOf("const s = localStorage; s.setItem(T, 'dark');")).toEqual([true]);
    expect(okOf("const store = window.localStorage; store.removeItem(T);")).toEqual([true]);
    expect(okOf("localStorage['setItem'](T, 'dark');")).toEqual([true]);
  });

  // Stage B review: renamed destructuring of the storage property.
  it('the scanner follows renamed destructuring of localStorage (window / globalThis / self / assignment)', () => {
    const okOf = (src: string) => scanStorageWrites('x.ts', src).map((w) => w.ok);
    expect(okOf("const { localStorage: ls } = window; ls.setItem('new-setting', '1');")).toEqual([false]);
    expect(okOf("const { localStorage: store } = globalThis; store.removeItem('new-setting');")).toEqual([false]);
    expect(okOf("const { 'localStorage': ls } = self; ls['setItem']('new-setting', '1');")).toEqual([false]);
    expect(okOf("function f({ localStorage: ls }: Window) { ls.setItem('new-setting', '1'); }")).toEqual([false]);
    expect(okOf("let ls: Storage; ({ localStorage: ls } = window); ls.setItem('new-setting', '1');")).toEqual([false]);
    // A nested pattern cannot be followed: it is flagged, not silently skipped.
    expect(okOf("const { localStorage: { setItem } } = window; setItem('new-setting', '1');")).toEqual([false]);
  });

  it('the scanner accepts a registered key through a renamed-destructuring alias', () => {
    const imp = "import { THEME_PREFERENCE_KEY as T } from '../storage/persisted-keys';\n";
    const okOf = (src: string) => scanStorageWrites('x.ts', imp + src).map((w) => w.ok);
    expect(okOf("const { localStorage: ls } = window; ls.setItem(T, 'dark');")).toEqual([true]);
    expect(okOf("const { localStorage: store } = globalThis; store.removeItem(T);")).toEqual([true]);
  });

  // Stage B round 2: alias chains and unresolvable computed global access.
  it('the scanner follows alias chains to a fixpoint', () => {
    const okOf = (src: string) => scanStorageWrites('x.ts', src).map((w) => w.ok);
    expect(okOf("const a = localStorage; const b = a; b.setItem('bad', '1');")).toEqual([false]);
    expect(okOf("const { localStorage: a } = window; const b = a; b.setItem('bad', '1');")).toEqual([false]);
    // Three deep, declared out of order (the fixpoint must not depend on source order).
    expect(okOf("function f() { c.removeItem('bad'); } const a = window.localStorage; const b = a; const c = b;")).toEqual([false]);
    // Plain assignment extends the chain too.
    expect(okOf("const a = localStorage; let b: Storage; b = a; b['setItem']('bad', '1');")).toEqual([false]);
  });

  it('the scanner accepts a registered key through an alias chain', () => {
    const imp = "import { THEME_PREFERENCE_KEY as T } from '../storage/persisted-keys';\n";
    const okOf = (src: string) => scanStorageWrites('x.ts', imp + src).map((w) => w.ok);
    expect(okOf("const a = localStorage; const b = a; const c = b; c.setItem(T, 'dark');")).toEqual([true]);
    expect(okOf("const { localStorage: a } = globalThis; const b = a; b.removeItem(T);")).toEqual([true]);
    // Declared in reverse source order: only the alias fixpoint resolves this chain.
    expect(okOf("function f() { c.setItem(T, 'dark'); } const c = b; const b = a; const a = localStorage;")).toEqual([true]);
  });

  it('the scanner flags non-literal computed access on window / globalThis / self', () => {
    const scan = (src: string) => scanStorageWrites('x.ts', src).map((w) => ({ ok: w.ok, method: w.method }));
    expect(scan("window['local' + 'Storage'].setItem('bad', '1');")).toEqual([{ ok: false, method: '<computed>' }]);
    expect(scan("const k = 'localStorage'; globalThis[k].setItem('bad', '1');")).toEqual([{ ok: false, method: '<computed>' }]);
    expect(scan("const s = self[`local${'Storage'}`];")).toEqual([{ ok: false, method: '<computed>' }]);
    // A literal key that is not localStorage is not storage access.
    expect(scan("const d = window['document'];")).toEqual([]);
  });

  // Stage B round 3: the analysis is per-file, so a storage handle exported
  // across a module boundary is itself a violation.
  it('the scanner flags a storage handle exported from the module', () => {
    const scan = (src: string) => scanStorageWrites('x.ts', src).map((w) => ({ ok: w.ok, method: w.method }));
    const exported = [{ ok: false, method: '<exported>' }];
    expect(scan('export const store = localStorage;')).toEqual(exported);
    expect(scan('const store = localStorage; export { store };')).toEqual(exported);
    expect(scan('const store = localStorage; export { store as storage };')).toEqual(exported);
    expect(scan('export const { localStorage: store } = window;')).toEqual(exported);
    expect(scan('export let store: Storage; store = localStorage;')).toEqual(exported);
    expect(scan('const a = window.localStorage; const b = a; export { b as storage };')).toEqual(exported);
    // `export default <alias>` stays a bare-reference violation.
    expect(scan('const store = localStorage; export default store;')).toEqual([{ ok: false, method: '<reference>' }]);
    // Exports that are not storage handles are untouched.
    expect(scan("export const KEY = 'x'; const s = localStorage; s.getItem(KEY); export { KEY as K };")).toEqual([]);
  });

  it('the scanner fails loudly on any other bare localStorage reference, and allows typeof guards and reads', () => {
    const okOf = (src: string) => scanStorageWrites('x.ts', src).map((w) => w.ok);
    expect(okOf('const n = localStorage.length;')).toEqual([false]);
    expect(okOf('persist(localStorage);')).toEqual([false]);
    expect(okOf('localStorage.clear();')).toEqual([false]);
    expect(okOf('const { setItem } = localStorage;')).toEqual([false]);
    expect(okOf('const s = localStorage; persist(s);')).toEqual([false]);
    // Guards and reads are not writes.
    expect(okOf("if (typeof localStorage !== 'undefined') localStorage.getItem('x');")).toEqual([]);
    expect(okOf("if (typeof window.localStorage !== 'undefined') window.localStorage.getItem('x');")).toEqual([]);
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

// PRR-220 (PR 150 review): the Clear Cache copy (SettingsPage) promises that "last-opened
// course" and "course progress" are removed; the generic loops above only check whatever
// IS registered, so dropping either key from USER_SETTING_KEYS would keep every test green
// while the copy lied. Pin the two Training keys explicitly.
describe('Training keys are cleared by Clear Cache (PRR-220)', () => {
  it('TRAINING_PROGRESS_KEY and LAST_PACK_KEY are registered user settings, not internal keys', () => {
    expect(registry.USER_SETTING_KEYS).toContain(registry.TRAINING_PROGRESS_KEY);
    expect(registry.USER_SETTING_KEYS).toContain(registry.LAST_PACK_KEY);
    expect(registry.INTERNAL_KEYS).not.toContain(registry.TRAINING_PROGRESS_KEY);
    expect(registry.INTERNAL_KEYS).not.toContain(registry.LAST_PACK_KEY);
  });

  it('clearUserSettings removes the stored course progress and last-opened course', () => {
    localStorage.clear();
    localStorage.setItem(registry.TRAINING_PROGRESS_KEY, '{"course-a":3}');
    localStorage.setItem(registry.LAST_PACK_KEY, 'course-a/1.0.0');
    const removed = registry.clearUserSettings();
    expect(removed).toEqual(expect.arrayContaining([registry.TRAINING_PROGRESS_KEY, registry.LAST_PACK_KEY]));
    expect(localStorage.getItem(registry.TRAINING_PROGRESS_KEY)).toBeNull();
    expect(localStorage.getItem(registry.LAST_PACK_KEY)).toBeNull();
  });
});

// Review round 2 (R2-F3): the sessionStorage leg of Clear Cache. A session-only
// (Remember off) external API key and its bound origin are written to
// sessionStorage; every entry written there must be registered in
// SESSION_SETTING_KEYS, and clearSessionSettings() must leave none behind.
describe('clearSessionSettings (Clear Cache, session-only external key)', () => {
  it('removes the session-only key AND its bound origin; every session entry is registered', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const ext = await import('../llm/external-provider');
    ext.saveExternalConfig({ baseUrl: 'http://localhost:1234', apiKey: 'sk-session-only-1', rememberKey: false });
    const written: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) written.push(sessionStorage.key(i) as string);
    expect(written.sort()).toEqual(['external-provider-apikey', 'external-provider-apikey-origin']);
    for (const key of written) expect(registry.SESSION_SETTING_KEYS).toContain(key);
    registry.clearSessionSettings();
    expect(sessionStorage.length).toBe(0);
    localStorage.clear();
  });
});
