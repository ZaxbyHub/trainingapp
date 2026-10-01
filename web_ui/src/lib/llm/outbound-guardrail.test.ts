/**
 * universal-provider-settings-overhaul (Phase 4.2 guardrail, defect class:
 * "outbound network access implemented per call site instead of through the
 * shared policy / guarded client"). An AST scan (TypeScript compiler API) of
 * every production file under web_ui/src for outbound primitives — `fetch(`,
 * `new XMLHttpRequest`, `new EventSource`, `new WebSocket`, `sendBeacon(` —
 * against an EXACT per-file allowlist. A new call site anywhere (or an extra
 * one in an allowlisted file) fails until it is reviewed: either it routes
 * through lib/llm/external-http.ts (external endpoints: policy-checked,
 * redirect-refusing) or it is a same-origin / desktop-loopback call recorded
 * here with its reason. The one external transport call must keep
 * `redirect: 'error'` and `credentials: 'omit'`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** file (relative to web_ui/src, forward slashes) -> [exact count, reason]. */
const ALLOWLIST: Record<string, [number, string]> = {
  'lib/llm/external-http.ts': [1, 'THE external-endpoint transport: URL policy first, redirect: error, credentials: omit'],
  'lib/api/client.ts': [15, 'desktop backend loopback API (token-guarded) / same-origin'],
  'lib/api/auth.ts': [2, 'same-origin auth routes of the app backend'],
  'lib/api/streaming.ts': [1, 'desktop backend /ask/stream SSE (loopback)'],
  'lib/desktop-session.tsx': [1, 'desktop backend GET /status/models (loopback)'],
  'lib/inference/InferenceModeContext.tsx': [1, 'desktop backend GET /auth/status connectivity probe (loopback)'],
  'lib/models/model-manifest.ts': [1, 'same-origin packaged model manifest'],
  'lib/models/probe.ts': [1, 'same-origin packaged model probe'],
};

const OUTBOUND_CTORS = new Set(['XMLHttpRequest', 'EventSource', 'WebSocket']);

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__' || full === path.join(SRC_ROOT, 'test')) continue;
      out.push(...productionSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

export interface OutboundSite {
  line: number;
  kind: string;
  node: ts.Node;
}

/** Every outbound primitive in `source`. */
export function scanOutbound(fileName: string, source: string): OutboundSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: OutboundSite[] = [];
  const add = (node: ts.Node, kind: string) =>
    sites.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, node });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') add(node, 'fetch');
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch') add(node, 'fetch');
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sendBeacon') add(node, 'sendBeacon');
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && OUTBOUND_CTORS.has(node.expression.text)) {
      add(node, `new ${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function rel(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

describe('outbound guardrail (web_ui/src)', () => {
  it('every outbound primitive is in an allowlisted file with the exact recorded count', () => {
    const counts = new Map<string, number>();
    const violations: string[] = [];
    for (const file of productionSources(SRC_ROOT)) {
      const sites = scanOutbound(file, fs.readFileSync(file, 'utf8'));
      if (sites.length === 0) continue;
      const key = rel(file);
      counts.set(key, sites.length);
      if (!(key in ALLOWLIST)) {
        for (const s of sites) violations.push(`${key}:${s.line} ${s.kind} — route external calls through lib/llm/external-http.ts`);
      }
    }
    expect(violations).toEqual([]);
    const drift = Object.entries(ALLOWLIST)
      .filter(([file, [count]]) => counts.get(file) !== count)
      .map(([file, [count]]) => `${file}: allowlisted ${count}, found ${counts.get(file) ?? 0}`);
    expect(drift).toEqual([]);
  });

  it('the external transport fetch refuses redirects and omits credentials', () => {
    const file = path.join(SRC_ROOT, 'lib', 'llm', 'external-http.ts');
    const [site] = scanOutbound(file, fs.readFileSync(file, 'utf8'));
    const call = site?.node as ts.CallExpression;
    const init = call.arguments[1];
    expect(init !== undefined && ts.isObjectLiteralExpression(init)).toBe(true);
    const props = new Map<string, string>();
    for (const p of (init as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) props.set(p.name.text, p.initializer.getText());
    }
    expect(props.get('redirect')).toBe("'error'");
    expect(props.get('credentials')).toBe("'omit'");
  });

  it('the scanner sees fetch, window.fetch, sendBeacon and outbound constructors (non-vacuity)', () => {
    const src =
      "fetch('https://x'); window.fetch('https://y'); navigator.sendBeacon('https://z', ''); new WebSocket('wss://a'); new EventSource('/s'); new XMLHttpRequest();";
    expect(scanOutbound('x.ts', src).map((s) => s.kind)).toEqual([
      'fetch',
      'fetch',
      'sendBeacon',
      'new WebSocket',
      'new EventSource',
      'new XMLHttpRequest',
    ]);
  });
});
