/**
 * universal-provider-settings-overhaul (Phase 4.2 guardrail, defect class:
 * "outbound network access implemented per call site instead of through the
 * shared policy / guarded client"). An AST scan (TypeScript compiler API) of
 * every production file under web_ui/src for outbound primitives — `fetch(`,
 * `new XMLHttpRequest`, `new EventSource`, `new WebSocket`, `sendBeacon(` and
 * (F-008, PR #142 review) `new Image`, any `.src =` / `setAttribute('src')`,
 * any `.href =` / `setAttribute('href')`
 * (created img/script/iframe), JSX `src` on img/script/iframe, and (PR #142
 * Stage B) `.srcset =` / `setAttribute('srcset')`, `.poster =` /
 * `setAttribute('poster')`, `new Worker` / `new SharedWorker`, JSX `src` on
 * video/audio/source/embed/object, JSX `srcSet` on img/source, `poster` on
 * video and `data` on object, `location` navigation (assignment, `.href =`,
 * `assign()`/`replace()`), `window.open`,
 * dynamic `import()` of a URL or a non-literal specifier, and fetch ALIASING
 * (any `fetch` reference that is not a direct call, `['fetch']` access) —
 * against an EXACT per-file allowlist. Aliasing fails closed: an alias the
 * scanner cannot follow is itself a hit. A new call site anywhere (or an extra
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
  // F-008 residual (`.href =`): the one anchor assignment in production code.
  'lib/export/conversation-export.ts': [1, 'a.href = blob: object URL (URL.createObjectURL of locally built export text) on a download anchor; no network, revoked after the click'],
  // F-008 additions (JSX src): local-only sources, recorded so a new one is reviewed.
  'components/ChatInput.tsx': [1, '<img src> of a user-attached image read locally as a data: URL (no network)'],
  'components/ChatMessageBubble.tsx': [1, '<img src> of a stored attached image data: URL (no network)'],
  'components/TrainingPlayer.tsx': [
    2,
    'course <iframe src> + its one same-element setAttribute("src") reload (browser-training-parity), both from trainingPlayerSrc: the app:// training-pack protocol in Electron (local), or in the browser app the dedicated player origin (player-origin.ts: the loopback alias of the app\'s own server, or an operator-configured bare https origin hosting the app\'s own static player files); course bytes come from the app page through the service-worker relay, so no user data leaves',
  ],
  // PR #142 Stage B (Worker constructions): same-origin bundled module worker.
  'lib/embeddings/embedding-service.ts': [1, 'new Worker(new URL("./embedding.worker.ts", import.meta.url)): the same-origin bundled embedding worker (its own outbound calls are scanned in its file)'],
  'lib/packs/training-player-host.ts': [
    1,
    'hidden boot <iframe>.src = `${playerOrigin}/training-boot.html` (browser-training-parity, ADR-0012): the validated player origin (loopback alias of the app\'s own server, or an operator-configured bare https origin serving the app\'s own static player files); it registers the course service worker and carries no user data',
  ],
  'lib/packs/player-origin.ts': [1,'same-origin runtime config player-origin.json (browser-training-parity), bounded 2 s, read once at app start'],
  'lib/packs/pack-update-browser.ts': [
    1,
    'opt-in signed pack update feed + artifact (browser-training-parity AC8): zero calls before opt-in, https-only request and final URL, credentials omit, no-referrer, size-capped, compiled out under VITE_AIRGAP; bytes are sha256 + Ed25519 verified before install',
  ],
};

// PR #142 Stage B: Worker / SharedWorker fetch their script URL; every
// construction is a hit (fail closed — a bundled same-origin worker is
// allowlisted with its reason).
const OUTBOUND_CTORS = new Set(['XMLHttpRequest', 'EventSource', 'WebSocket', 'Image', 'Worker', 'SharedWorker']);
/** Receivers whose `.open(...)` opens a browsing context. */
const WINDOW_NAMES = new Set(['window', 'globalThis', 'self', 'top', 'parent']);
/** JSX intrinsics whose `src` attribute makes the browser fetch (PR #142 Stage B: + media/embed/object). */
const SRC_ELEMENTS = new Set(['img', 'script', 'iframe', 'video', 'audio', 'source', 'embed', 'object']);
/**
 * Other JSX attributes that fetch, per element (PR #142 Stage B): `srcSet`
 * (React's spelling; `srcset` too) on img/source, `poster` on video, `data`
 * on object.
 */
const FETCHING_JSX_ATTRIBUTES: Record<string, Set<string>> = {
  srcSet: new Set(['img', 'source']),
  srcset: new Set(['img', 'source']),
  poster: new Set(['video']),
  data: new Set(['object']),
};
/** DOM properties whose assignment makes the element fetch (besides `src`). */
const FETCHING_PROPERTIES = new Set(['srcset', 'srcSet', 'poster']);
/** Attributes through which `setAttribute` makes an anchor/link navigate or fetch. */
const HREF_ATTRIBUTES = new Set(['href', 'xlink:href']);
/** Attributes through which `setAttribute` makes an element fetch (besides `src`). */
const FETCHING_SET_ATTRIBUTES = new Set(['srcset', 'poster']);
const URL_SPECIFIER = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

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

function isLocationExpr(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'location';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'location';
}

/** True when `node` is the callee of a call (`fetch(...)`, `x.fetch(...)`). */
function isCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
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
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'open' &&
        ts.isIdentifier(callee.expression) &&
        WINDOW_NAMES.has(callee.expression.text)
      ) {
        add(node, 'window.open');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'assign' || callee.name.text === 'replace') &&
        isLocationExpr(callee.expression)
      ) {
        add(node, 'location navigation');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'setAttribute' &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text.toLowerCase() === 'src'
      ) {
        add(node, 'src assignment');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'setAttribute' &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        HREF_ATTRIBUTES.has(node.arguments[0].text.toLowerCase())
      ) {
        add(node, 'href assignment');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'setAttribute' &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        FETCHING_SET_ATTRIBUTES.has(node.arguments[0].text.toLowerCase())
      ) {
        add(node, `${node.arguments[0].text.toLowerCase()} assignment`);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = node.arguments[0];
        if (spec === undefined || !ts.isStringLiteralLike(spec)) add(node, 'dynamic import (non-literal)');
        else if (URL_SPECIFIER.test(spec.text)) add(node, 'dynamic import (URL)');
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && OUTBOUND_CTORS.has(node.expression.text)) {
      add(node, `new ${node.expression.text}`);
    }
    // F-008 residual: ANY `x.href = ...` (an anchor `a.href = url; a.click()`
    // navigates or downloads) and any compound form (`x.href += ...`), fail
    // closed. `location.href` keeps its own kind and is not double-counted.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'href' &&
      !isLocationExpr(node.left.expression)
    ) {
      add(node, 'href assignment');
    }
    // Assignments: `x.src = ...`, `location = ...`, `location.href = ...`.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target) && target.name.text === 'src') add(node, 'src assignment');
      else if (ts.isPropertyAccessExpression(target) && FETCHING_PROPERTIES.has(target.name.text)) {
        add(node, `${target.name.text.toLowerCase()} assignment`);
      } else if (isLocationExpr(target)) add(node, 'location navigation');
      else if (ts.isPropertyAccessExpression(target) && target.name.text === 'href' && isLocationExpr(target.expression)) {
        add(node, 'location navigation');
      } else if (ts.isPropertyAccessExpression(target) && target.name.text === 'href') {
        add(node, 'href assignment');
      }
    }
    // JSX <img|script|iframe|video|audio|source|embed|object src={...}>, and
    // the other fetching attributes (srcSet, poster, object data).
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const attr = node.name.text;
      const element = node.parent.parent;
      const tag = (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) ? element.tagName : undefined;
      if (tag !== undefined && ts.isIdentifier(tag)) {
        if (attr === 'src' && SRC_ELEMENTS.has(tag.text)) add(node, `jsx <${tag.text} src>`);
        else if (FETCHING_JSX_ATTRIBUTES[attr]?.has(tag.text) === true) add(node, `jsx <${tag.text} ${attr}>`);
      }
    }
    // Fetch aliasing (fail closed): any reference to fetch that is not a
    // direct call — `const f = fetch`, `fetch.bind(...)`, `globalThis.fetch`
    // passed along, `window['fetch']` in any position.
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node);
      const isTypeofOperand = ts.isTypeOfExpression(parent);
      if (!isPropertyName && !isTypeofOperand && !isCallee(node)) add(node, 'fetch alias');
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'fetch' && !isCallee(node) && !ts.isTypeOfExpression(node.parent)) {
      add(node, 'fetch alias');
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    ) {
      add(node, 'fetch alias');
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

  it('F-008: the scanner sees every outbound shape (one self-test row per shape)', () => {
    const rows: Array<[string, string[]]> = [
      ["new Image().src = 'https://x/p.gif';", ['new Image', 'src assignment']],
      ["const img = new Image(); img.src = u;", ['new Image', 'src assignment']],
      ["const s = document.createElement('script'); s.src = u;", ['src assignment']],
      ["const f = document.createElement('iframe'); f.setAttribute('src', u);", ['src assignment']],
      ["location.href = 'https://x';", ['location navigation']],
      ["window.location.href = u;", ['location navigation']],
      ["location = u;", ['location navigation']],
      ["window.location = u;", ['location navigation']],
      ["document.location.assign(u);", ['location navigation']],
      ["location.replace(u);", ['location navigation']],
      ["const a = document.createElement('a'); a.href = url; a.click();", ['href assignment']],
      ["a.href = URL.createObjectURL(blob);", ['href assignment']],
      ["link.href += '?x=1';", ['href assignment']],
      ["el.setAttribute('href', u);", ['href assignment']],
      ["el.setAttribute('HREF', u);", ['href assignment']],
      ["use.setAttribute('xlink:href', u);", ['href assignment']],
      ["window.open('https://x');", ['window.open']],
      ["globalThis.open(u);", ['window.open']],
      ["await import('https://cdn.example/x.js');", ['dynamic import (URL)']],
      ["await import(u);", ['dynamic import (non-literal)']],
      ["await import(`${base}/x.js`);", ['dynamic import (non-literal)']],
      ["const f = fetch; f(u);", ['fetch alias']],
      ["const f = fetch.bind(window);", ['fetch alias']],
      ["const g = window.fetch; g(u);", ['fetch alias']],
      ["const h = globalThis.fetch;", ['fetch alias']],
      ["window['fetch'](u);", ['fetch alias']],
      ["run(fetch);", ['fetch alias']],
      ["const { fetch: f2 } = window;", ['fetch alias']],
      // PR #142 Stage B: srcset / poster assignment, workers.
      ["el.srcset = s;", ['srcset assignment']],
      ["img.srcSet = s;", ['srcset assignment']],
      ["el.setAttribute('srcset', s);", ['srcset assignment']],
      ["el.setAttribute('SRCSET', s);", ['srcset assignment']],
      ["v.poster = p;", ['poster assignment']],
      ["v.setAttribute('poster', p);", ['poster assignment']],
      ["const w = new Worker('https://cdn.example/w.js');", ['new Worker']],
      ["const w = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });", ['new Worker']],
      ["const sw = new SharedWorker(u);", ['new SharedWorker']],
    ];
    for (const [src, kinds] of rows) {
      expect(scanOutbound('x.ts', src).map((s) => s.kind).sort(), src).toEqual([...kinds].sort());
    }
    const jsx: Array<[string, string[]]> = [
      ['const a = <img src={u} />;', ['jsx <img src>']],
      ['const b = <iframe src={u}></iframe>;', ['jsx <iframe src>']],
      ['const c = <script src="https://x/a.js" />;', ['jsx <script src>']],
      // PR #142 Stage B: media / embed / object and the other fetching attributes.
      ['const d = <video src={u} />;', ['jsx <video src>']],
      ['const e = <audio src={u} />;', ['jsx <audio src>']],
      ['const f = <video><source src={u} /></video>;', ['jsx <source src>']],
      ['const g = <embed src={u} />;', ['jsx <embed src>']],
      ['const h = <object src={u} />;', ['jsx <object src>']],
      ['const i = <object data={u} />;', ['jsx <object data>']],
      ['const j = <img srcSet={s} />;', ['jsx <img srcSet>']],
      ['const k = <picture><source srcSet={s} /></picture>;', ['jsx <source srcSet>']],
      ['const l = <video poster={p} />;', ['jsx <video poster>']],
    ];
    for (const [src, kinds] of jsx) {
      expect(scanOutbound('x.tsx', src).map((s) => s.kind), src).toEqual(kinds);
    }
  });

  it('F-008: benign look-alikes are NOT hits (negative self-test rows)', () => {
    const rows = [
      "const m = await import('./chunk');",
      "const n = await import('../lib/x');",
      "if (typeof fetch === 'function') {}",
      "if (typeof window.fetch === 'function') {}",
      "const opts = { fetch: true }; interface I { fetch: number }",
      "dialog.open(); modal.open = true;",
      "const href = link.href; const s = el.srcset; img.alt = a;",
      "el.setAttribute('data-srcset', s); el.getAttribute('srcset'); const worker = createWorker();",
      "const u = a.href; if (a.href === b.href) {} el.getAttribute('href'); el.setAttribute('class', c); el.setAttribute('data-href', c);",
      "const o = { href: u }; foo({ href: u });",
      "const loc = { location: 1 };",
    ];
    for (const src of rows) {
      expect(scanOutbound('x.ts', src).map((s) => s.kind), src).toEqual([]);
    }
    expect(
      scanOutbound('x.tsx', 'const v = <Thumb src={u} />; const w = <Thumb poster={p} srcSet={s} data={d} />; const x = <div data-src={u} />;'),
    ).toEqual([]);
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
