// universal-provider-settings-overhaul (Phase 4.2 guardrail, defect class:
// "outbound network access implemented per call site instead of through the
// shared policy / guarded client"). An AST scan (TypeScript compiler API) of
// every module under desktop/main for outbound primitives:
//   - fetch(...) / <x>.fetch(...)                 (global fetch, electron net.fetch)
//   - <http|https|alias>.request(...) / .get(...) (node:http / node:https, incl.
//     variables initialized from those imports, e.g. `isHttps ? https : http`)
//   - <net|tls|alias>.connect(...) / net.createConnection(...)
//   - electron `net.request(...)`
// against an EXACT per-file allowlist. External model endpoints must go
// through backend/net/guarded-request.ts (policy + connect-time address
// checks + no redirects); every other entry is a documented loopback or
// opt-in channel. The guarded client must keep its pinned lookup and its
// per-request agent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'main');

const ALLOWLIST: Record<string, [number, string]> = {
  'backend/net/guarded-request.ts': [1, 'THE external-endpoint client: policy, pinned validated lookup, no redirects, timeouts'],
  'backend/server.ts': [1, 'sidecar-mode proxy to the loopback sidecar (127.0.0.1)'],
  'backend/sidecar-manager.ts': [1, 'loopback sidecar health probe'],
  'index.ts': [1, 'loopback desktop backend GET /packs for the first-run wizard'],
  'update-checker.ts': [2, 'opt-in signed update feed (ADR-0010) + loopback POST /packs/install'],
};

const NODE_HTTP = new Set(['node:http', 'node:https', 'http', 'https']);
const NODE_SOCKET = new Set(['node:net', 'node:tls', 'net', 'tls']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export function scanOutbound(fileName: string, source: string): Array<{ line: number; kind: string }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const httpNames = new Set<string>();
  const socketNames = new Set<string>();
  const electronNet = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const from = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    const bucket = NODE_HTTP.has(from) ? httpNames : NODE_SOCKET.has(from) ? socketNames : null;
    if (bucket !== null) {
      if (clause.name) bucket.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bucket.add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (['request', 'get', 'connect', 'createConnection'].includes(imported)) bucket.add(`fn:${el.name.text}`);
        }
      }
    }
    if (from === 'electron' && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'net') electronNet.add(el.name.text);
    }
  }
  // Aliases: `const transport = cond ? https : http` (structural — an
  // identifier, conditional or parenthesized expression over the imports;
  // string literals such as 'http://127.0.0.1/' never count).
  const aliasOf = (expr: ts.Expression, names: Set<string>): boolean => {
    if (ts.isIdentifier(expr)) return names.has(expr.text);
    if (ts.isParenthesizedExpression(expr)) return aliasOf(expr.expression, names);
    if (ts.isConditionalExpression(expr)) return aliasOf(expr.whenTrue, names) || aliasOf(expr.whenFalse, names);
    return false;
  };
  const visitAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      if (aliasOf(node.initializer, httpNames)) httpNames.add(node.name.text);
      if (aliasOf(node.initializer, socketNames)) socketNames.add(node.name.text);
    }
    ts.forEachChild(node, visitAliases);
  };
  visitAliases(sf);
  const sites: Array<{ line: number; kind: string }> = [];
  const add = (node: ts.Node, kind: string) => sites.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === 'fetch') add(node, 'fetch');
        if (httpNames.has(`fn:${callee.text}`)) add(node, `http ${callee.text}`);
        if (socketNames.has(`fn:${callee.text}`)) add(node, `socket ${callee.text}`);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const obj = callee.expression.text;
        const method = callee.name.text;
        if (method === 'fetch') add(node, `${obj}.fetch`);
        else if (httpNames.has(obj) && (method === 'request' || method === 'get')) add(node, `${obj}.${method}`);
        else if (socketNames.has(obj) && (method === 'connect' || method === 'createConnection')) add(node, `${obj}.${method}`);
        else if (electronNet.has(obj) && method === 'request') add(node, `${obj}.request`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('outbound guardrail (desktop/main)', () => {
  it('every outbound primitive is in an allowlisted module with the exact recorded count', () => {
    const counts = new Map<string, number>();
    const violations: string[] = [];
    for (const file of sources(MAIN_ROOT)) {
      const sites = scanOutbound(file, fs.readFileSync(file, 'utf8'));
      if (sites.length === 0) continue;
      const key = path.relative(MAIN_ROOT, file).split(path.sep).join('/');
      counts.set(key, sites.length);
      if (!(key in ALLOWLIST)) {
        for (const s of sites) violations.push(`${key}:${s.line} ${s.kind} — external calls must use backend/net/guarded-request.ts`);
      }
    }
    expect(violations).toEqual([]);
    const drift = Object.entries(ALLOWLIST)
      .filter(([file, [count]]) => counts.get(file) !== count)
      .map(([file, [count]]) => `${file}: allowlisted ${count}, found ${counts.get(file) ?? 0}`);
    expect(drift).toEqual([]);
  });

  it('the guarded client keeps its pinned lookup and per-request agent', () => {
    const source = fs.readFileSync(path.join(MAIN_ROOT, 'backend', 'net', 'guarded-request.ts'), 'utf8');
    expect(source).toContain('lookup: pinnedLookup');
    expect(source).toContain('agent: false');
    expect(source).toMatch(/status >= 300 && status < 400/);
  });

  it('the scanner sees direct, aliased, named and electron forms (non-vacuity)', () => {
    const src = [
      "import http from 'node:http';",
      "import https from 'node:https';",
      "import { request as req } from 'node:https';",
      "import net from 'node:net';",
      "import { net as enet } from 'electron';",
      'const t = cond ? https : http;',
      "fetch('https://x'); http.get('http://y'); t.request({}); req({}); net.connect(80); enet.request('https://z'); enet.fetch('https://w');",
    ].join('\n');
    expect(scanOutbound('x.ts', src).map((s) => s.kind)).toEqual([
      'fetch',
      'http.get',
      't.request',
      'http req',
      'net.connect',
      'enet.request',
      'enet.fetch',
    ]);
  });
});
