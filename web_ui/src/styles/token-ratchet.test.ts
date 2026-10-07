/**
 * Lumen phase 8: the repo-wide design-token ratchet (docs/design/design-language.md
 * section 6, phase 8 guardrails). Walks every non-test css/ts/tsx file under web_ui/src and
 * enforces, with comments stripped first:
 *
 *   1. no retired (pre-Lumen) token anywhere             (styles/retired-tokens.ts)
 *   2. no color literal outside lumen-tokens.css: hex, any color function (rgb/hsl/hwb/lab/lch/oklab/oklch/color),
 *      and, in CSS color-bearing declarations, CSS named colors (styles/color-literals.ts)
 *   3. every var(--x) resolves to a Lumen token, a runtime property published via
 *      setProperty (--ui-tooltip-shift, --settings-nav-h), or a custom property declared in the same file
 *   4. `outline: none|0` only when a paired :focus-visible rule for the same selector
 *      supplies a replacement, or via the explicit OUTLINE_ALLOW list below (with reasons)
 *   5. inline `style={...}` carries geometry keys only (no color / spacing / border / font)
 *   6. `var(--x, fallback)` only for the exact sanctioned pairs in SANCTIONED_FALLBACKS (a fallback
 *      masks an UNDEFINED token); a stale allow-list entry fails
 *   7. no imperative style writes in .ts/.tsx beyond geometry and the enumerated allow-list:
 *      - `el.style.color = ...`, `style.setProperty('color', ...)`, cssText, setAttribute('style')
 *      - the style object escaping (`const s = el.style`, `{ style } = el`, `Object.assign(el.style, ..)`,
 *        `el['style']`), because an alias hides every later write; `.style.<prop>` access stays legal
 *      - `attributeStyleMap`, attribute-node and setAttributeNS style writes
 *      - injected markup/sheets: a `<style` element (JSX or string), `style="..."` markup, createElement('style'),
 *        rel=stylesheet, the HTML sinks innerHTML/outerHTML/insertAdjacentHTML/createContextualFragment/
 *        document.write/srcdoc, and the stylesheet APIs (CSSStyleSheet, replaceSync, insertRule, deleteRule,
 *        addRule, cssRules, styleSheets, adoptedStyleSheets)
 *
 * TS/TSX comments are found with the TypeScript parser (not a regex scanner), so a `//` in JSX text, a URL,
 * a string, a template or a regex literal is never mistaken for a comment.
 *
 * Residual (a lint, not a security boundary): `Reflect.set` / `Object.defineProperty` on a style object,
 * `setAttribute(nameVariable, ...)` with a computed name, `React.createElement('div', { style })` /
 * `cloneElement` props (rule 5 reads JSX `style={...}` only), a style value assembled across files, and
 * eval/Function. Code that does any of these must be caught in review.
 *
 * Each rule is a pure function with a self-test that feeds it a violating fixture, so a rule
 * that silently stops matching fails here rather than passing vacuously. The per-surface
 * hygiene tests (ui/, layouts/, ...) stay as the stricter extra guard for the migrated surfaces.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { COLOR_LITERAL_RE, findNamedColors } from './color-literals';
import { RETIRED_TOKEN_RE } from './retired-tokens';

const SRC = resolve(__dirname, '..');

// ---------------------------------------------------------------------------------------------
// Allow-lists (each entry has a reason; stale entries fail the test)
// ---------------------------------------------------------------------------------------------

/** Files that legitimately hold color literals: the token definitions themselves. */
const LITERAL_ALLOWED = new Set(['styles/lumen-tokens.css']);

/** Data modules that NAME retired tokens / legacy literals by design; never shipped to the app. */
const DATA_MODULES = new Set(['styles/retired-tokens.ts', 'styles/token-remap.ts']);

/** `outline: none` blocks with no :focus-visible replacement, keyed `file|selector`. */
const OUTLINE_ALLOW: Record<string, string> = {
  'ui/ui.css|.ui-shell__main:focus':
    'programmatic focus target (tabIndex -1) after drawer navigation; a ring around the whole content region is noise, not a keyboard affordance',
};

/**
 * The ONLY `var(--x, fallback)` uses in the app, keyed `file|--x`. Both are properties the code publishes at
 * runtime or defaults on purpose, never Lumen tokens (a fallback on a Lumen token would hide it being undefined:
 * the wizard once shipped var(--color-bg-surface, #1e1e1e), a dark panel in the light theme).
 */
const SANCTIONED_FALLBACKS: Record<string, string> = {
  'components/settings.css|--settings-nav-h':
    'SettingsNav publishes its measured height via setProperty; before the first measurement scroll-margin falls back to var(--space-16)',
  'ui/ui.css|--ui-tooltip-shift':
    'Tooltip publishes a viewport-clamp shift via setProperty only when it would overflow; 0px is the no-shift default',
};

/** The only custom properties code may publish at runtime (pinned: a new one is a deliberate, reviewed edit). */
const RUNTIME_PROP_NAMES = ['--settings-nav-h', '--ui-tooltip-shift'];

/** Imperative `el.style.<prop> =` writes that are not geometry, keyed `file|prop`, each with a reason. */
const STYLE_WRITE_ALLOW: Record<string, string> = {
  'lib/packs/training-player-host.ts|display':
    'hides the course iframe while no course is open (visibility toggle, not a color/spacing decision)',
};

/** Inline-style keys that are layout geometry (computed per render), never color/spacing. */
const GEOMETRY_KEYS = new Set([
  'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'transform',
]);

// ---------------------------------------------------------------------------------------------
// Source walking + comment stripping
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'test', 'node_modules']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(p);
    return [p];
  });
}

const isSource = (rel: string): boolean => /\.(css|tsx?)$/.test(rel) && !/\.test\.tsx?$/.test(rel);

/** Index just past the string literal starting at t[i] (' " or `); template `${}` nests. */
function skipString(t: string, i: number): number {
  const q = t[i];
  let j = i + 1;
  while (j < t.length) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    // JSX text can hold a lone apostrophe: recover at end of line rather than eating the file.
    if (q !== '`' && c === '\n') return j;
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && t[j + 1] === '{') { j = skipBraces(t, j + 1); continue; }
    j++;
  }
  return j;
}

/** Index just past the `{...}` group starting at t[i], skipping strings and comments. */
function skipBraces(t: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < t.length) {
    const c = t[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(t, j); continue; }
    if (c === '/' && t[j + 1] === '/') { while (j < t.length && t[j] !== '\n') j++; continue; }
    if (c === '/' && t[j + 1] === '*') { const e = t.indexOf('*/', j + 2); j = e < 0 ? t.length : e + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return j;
}

/** A scanned .ts/.tsx text the TypeScript parser could not parse cleanly (see stripTsComments). */
class TsParseError extends Error {
  readonly fileName: string;
  readonly diagnostics: string[];
  constructor(fileName: string, diagnostics: string[]) {
    super(`${fileName} does not parse cleanly: ${diagnostics.join('; ')}`);
    this.fileName = fileName;
    this.diagnostics = diagnostics;
  }
}

/**
 * The parser's syntax diagnostics. `parseDiagnostics` is internal (not in the public typings): if a
 * TypeScript upgrade drops it, this throws (fails closed) rather than silently stop checking.
 */
function parseDiagnosticsOf(sf: ts.SourceFile, fileName: string): readonly ts.Diagnostic[] {
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) throw new TsParseError(fileName, ['TypeScript no longer exposes SourceFile.parseDiagnostics']);
  return diagnostics;
}

/**
 * Blanks every comment of one TS/TSX text (comment characters become spaces, newlines stay), leaving
 * strings, templates and regex literals untouched. Comments are located with the TypeScript parser: the
 * trivia before each token, JSX text skipped (a `//` there is text). `.ts` files parse as TS, not TSX, so
 * `<T>x` assertions stay valid.
 *
 * Fails CLOSED (PR #151 final review LOW-F): createSourceFile never throws, and on a syntax error it
 * recovers by guessing, which can turn live code into "comment" trivia that is then blanked. So any
 * parse diagnostic throws a TsParseError instead of returning a silently blanked text.
 */
function stripTsComments(t: string, tsx = true, fileName = tsx ? 'x.tsx' : 'x.ts'): string {
  const sf = ts.createSourceFile(fileName, t, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diagnostics = parseDiagnosticsOf(sf, fileName);
  if (diagnostics.length > 0) {
    throw new TsParseError(
      fileName,
      diagnostics.map((d) => `${d.start ?? '?'}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
    );
  }
  const spans = new Map<number, number>();
  const collect = (pos: number): void => {
    for (const r of [...(ts.getLeadingCommentRanges(t, pos) ?? []), ...(ts.getTrailingCommentRanges(t, pos) ?? [])]) spans.set(r.pos, r.end);
  };
  const visit = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.JsxText) return;
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) collect(n.getFullStart());
    else kids.forEach(visit);
  };
  visit(sf);
  let out = '';
  let at = 0;
  for (const [pos, end] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (pos < at) continue;
    out += t.slice(at, pos) + t.slice(pos, end).replace(/[^\n]/g, ' ');
    at = end;
  }
  return out + t.slice(at);
}

/** Strips block comments from CSS; quoted strings are copied through (a `"/*"` in `content:` is not a comment). */
function stripCssComments(t: string): string {
  let out = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < t.length) {
        if (t[j] === '\\') { j += 2; continue; }
        if (t[j] === c) { j++; break; }
        if (t[j] === '\n') break; // unterminated string: recover at end of line
        j++;
      }
      out += t.slice(i, j);
      i = j;
    } else if (c === '/' && t[i + 1] === '*') {
      const e = t.indexOf('*/', i + 2);
      const end = e < 0 ? t.length : e + 2;
      out += t.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `.css` strips CSS comments; `.tsx` parses as TSX and every other (`.ts`) file as plain TS. */
const strip = (rel: string, text: string): string =>
  rel.endsWith('.css') ? stripCssComments(text) : stripTsComments(text, rel.endsWith('.tsx'), rel);

// ---------------------------------------------------------------------------------------------
// Rules (pure; each takes comment-stripped text)
// ---------------------------------------------------------------------------------------------

const COLOR_LITERAL = new RegExp(COLOR_LITERAL_RE.source, 'g');

function findRetiredTokens(text: string): string[] {
  const re = new RegExp(RETIRED_TOKEN_RE.source, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

function findColorLiterals(text: string): string[] {
  return [...text.matchAll(COLOR_LITERAL)].map((m) => m[0]);
}

/** Hex / color-function literals everywhere, plus named colors in CSS color-bearing declarations. */
function findLiterals(rel: string, text: string): string[] {
  return [...findColorLiterals(text), ...(rel.endsWith('.css') ? findNamedColors(text) : [])];
}

/** Names of every `var(--x, ...)` that carries a fallback. */
function findVarFallbacks(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[\w-]+)\s*,/g)].map((m) => m[1]);
}

const USED_VAR = /var\(\s*(--[\w-]+)/g;

/** Custom properties a file declares itself: CSS `--x:`, setProperty('--x'), or an inline-style key '--x'. */
function declaredHere(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]);
  for (const m of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) out.add(m[1]);
  return out;
}

function findUnresolvedVars(text: string, lumen: Set<string>, runtime: Set<string>): string[] {
  const local = declaredHere(text);
  return [...text.matchAll(USED_VAR)].map((m) => m[1]).filter((n) => !lumen.has(n) && !runtime.has(n) && !local.has(n));
}

const OUTLINE_OFF =
  /(?:^|[;\s])(?:outline(?:-style)?\s*:\s*(?:none|0)\b|outline-width\s*:\s*0\b|outline(?:-color)?\s*:\s*transparent\b)/;
const REPLACEMENT = /(?:^|[;\s])(?:outline|box-shadow)\s*:\s*(?!\s|none\b|0\b|transparent\b)/;

interface Block { selector: string; body: string }

function cssBlocks(css: string): Block[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
}

const focusRoot = (part: string): string =>
  part.replace(/:focus:not\(:focus-visible\)/g, '').replace(/:focus-visible/g, '').replace(/:focus(?![\w-])/g, '').trim();

/** `file|selector` keys for every `outline: none|0` block that has no :focus-visible replacement. */
function findUnpairedOutlineOff(css: string, file: string): string[] {
  const blocks = cssBlocks(css);
  const out: string[] = [];
  for (const b of blocks) {
    if (!OUTLINE_OFF.test(b.body)) continue;
    for (const part of b.selector.split(',').map((s) => s.trim())) {
      const root = focusRoot(part);
      const paired = blocks.some(
        // The replacement selector must START with `root:focus-visible` (the sibling-ring form
        // `root:focus-visible + .ring` qualifies); a substring match let `.elsewhere root:focus-visible` pair.
        (o) =>
          o !== b &&
          o.selector.split(',').some((s) => s.trim().startsWith(`${root}:focus-visible`)) &&
          REPLACEMENT.test(o.body)
      );
      if (!paired) out.push(`${file}|${part}`);
    }
  }
  return out;
}

/** Top-level comma split of an object literal body (depth- and string-aware). */
function topLevelSegments(body: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < body.length; ) {
    const c = body[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(body, j); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { segs.push(body.slice(start, j)); start = j + 1; }
    j++;
  }
  segs.push(body.slice(start));
  return segs.map((s) => s.trim()).filter(Boolean);
}

function segmentKey(seg: string): string {
  if (seg.startsWith('...')) return '...';
  const m = /^(?:'([^']*)'|"([^"]*)"|\[[^\]]*\]|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(seg);
  return m ? (m[1] ?? m[2] ?? m[3] ?? seg) : seg;
}

/**
 * Violations of rule 5 in one TSX text: every non-geometry inline-style key, `...spread`,
 * computed key, or a `style={expr}` that holds no object literal and is not `undefined`.
 */
function findInlineStyleViolations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bstyle=\{/g)) {
    const open = m.index! + m[0].length - 1;
    const end = skipBraces(text, open);
    const expr = text.slice(open + 1, end - 1);
    let found = false;
    for (let j = 0; j < expr.length; ) {
      const c = expr[j];
      if (c === '"' || c === "'" || c === '`') { j = skipString(expr, j); continue; }
      if (c === '{') {
        const e = skipBraces(expr, j);
        found = true;
        for (const seg of topLevelSegments(expr.slice(j + 1, e - 1))) {
          const key = segmentKey(seg);
          if (!GEOMETRY_KEYS.has(key)) out.push(key);
        }
        j = e;
        continue;
      }
      j++;
    }
    if (!found && expr.trim() !== 'undefined') out.push(`style={${expr.trim()}}`);
  }
  return out;
}

/** Stylesheet-construction APIs: any mention is a way to ship CSS the CSS-file rules never see. */
const SHEET_API = /\b(?:CSSStyleSheet|replaceSync|insertRule|deleteRule|addRule|removeRule|cssRules|styleSheets|adoptedStyleSheets)\b/g;
/** HTML sinks: markup that can carry a `<style>` or `style="..."` (banned outright; a concatenated string defeats a content check). */
const HTML_SINK = /\b(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|dangerouslySetInnerHTML)\b|\bdocument\.write(?:ln)?\b|\bsrcdoc\b/gi;

/**
 * Imperative style writes in one comment-stripped TS/TSX text (rule 7). Geometry properties are legal.
 * Labels are deterministic (the allow-list and its stale-entry check key on `file|label`).
 */
function findImperativeStyleWrites(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\.style\s*\??\.\s*(\w+)\s*(?:=(?!=)|\+=)/g)) if (!GEOMETRY_KEYS.has(m[1])) out.push(m[1]);
  for (const m of text.matchAll(/\bstyle\s*\??\.\s*setProperty\s*\(\s*(?:(['"`])([^'"`]*)\1|([^'"`\s)][^,)]*))/g)) {
    const name = m[2] ?? '<dynamic>';
    if (!RUNTIME_PROP_NAMES.includes(name)) out.push(`setProperty(${name})`);
  }
  if (/\bstyle\s*\??\.\s*setProperty\b(?!\s*\()/.test(text)) out.push('style.setProperty (unbound)');
  // The style object escaping into a variable, argument or property hides every later write through the alias.
  if (/\.style\b(?![\w$-])(?!\s*\??\.\s*\w)/.test(text)) out.push('style (aliased)');
  if (/\[\s*['"`]style['"`]\s*\]/.test(text) || /\.style\s*\??\.?\s*\[/.test(text)) out.push('style[...]');
  if (/\{[^{}]*\bstyle\b[^{}]*\}\s*=(?![=>])/.test(text)) out.push('{ style } = ...');
  if (/\battributeStyleMap\b/.test(text)) out.push('attributeStyleMap');
  if (/\bsetAttribute(?:NS)?\([^)]*['"`]style['"`]/.test(text)) out.push("setAttribute('style')");
  if (/\b(?:get|set)AttributeNode(?:NS)?\b|\battributes\s*(?:\.\s*style\b|\[\s*['"`]style)/.test(text)) out.push('style attribute node');
  if (/Object\.assign\([^;]*\.style\b/.test(text)) out.push('Object.assign(...style)');
  if (/<style\b/i.test(text)) out.push('<style>');
  if (/(?<![\w$.])(?<!(?:const|let|var)\s+)style\s*=\s*\\?["']/.test(text)) out.push('style="..."');
  if (/\bcreateElement(?:NS)?\([^)]*['"`]style['"`]/i.test(text)) out.push("createElement('style')");
  if (/['"`]stylesheet['"`]/i.test(text)) out.push('rel=stylesheet');
  for (const m of text.matchAll(HTML_SINK)) out.push(`html sink: ${m[0]}`);
  for (const m of text.matchAll(SHEET_API)) out.push(`sheet API: ${m[0]}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

interface Source { rel: string; text: string }

/** One scanned file: comment-stripped, or (unparseable) recorded in `failures` and kept raw. */
function loadSource(rel: string, raw: string, failures: string[]): Source {
  try {
    return { rel, text: strip(rel, raw) };
  } catch (e) {
    if (!(e instanceof TsParseError)) throw e;
    failures.push(e.message);
    return { rel, text: raw };
  }
}

interface Scan {
  sources: Source[];
  /** Files the TS parser rejected (LOW-F), with their diagnostics. */
  parseFailures: string[];
}

/**
 * Scan every non-test css/ts/tsx file under `root`. A file the TS parser rejects is recorded in the
 * scan's OWN `parseFailures` (not thrown, so one bad file fails the dedicated test below with its
 * diagnostics instead of aborting the whole module) and is scanned unstripped. The list is created
 * here and returned, so no caller can hand the scan a throwaway array (critic-final-2 P11); the
 * scanTree self-test below runs this on a fixture tree.
 */
function scanTree(root: string): Scan {
  const parseFailures: string[] = [];
  const sources = walk(root)
    .map((p) => relative(root, p).replace(/\\/g, '/'))
    .filter((rel) => isSource(rel) && !DATA_MODULES.has(rel))
    .map((rel) => loadSource(rel, readFileSync(join(root, rel), 'utf8'), parseFailures));
  return { sources, parseFailures };
}

const SCAN = scanTree(SRC);
const sources: Source[] = SCAN.sources;

const declaredIn = (css: string): Set<string> => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const LUMEN = declaredIn(sources.find((s) => s.rel === 'styles/lumen-tokens.css')?.text ?? '');
// Properties that code publishes at runtime via style.setProperty (e.g. Tooltip's --ui-tooltip-shift,
// SettingsNav's --settings-nav-h). They are declared by that call, not by any stylesheet.
const RUNTIME_PROPS = new Set(
  sources.flatMap((s) => [...s.text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map((m) => m[1]))
);

const offenders = (fn: (s: Source) => string[]): string[] => sources.flatMap((s) => fn(s).map((x) => `${s.rel}: ${x}`));

describe('repo-wide token ratchet (web_ui/src)', () => {
  it('scans the real source tree (guards against a vacuous walk)', () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const rel of ['App.tsx', 'styles/theme.css', 'styles/lumen-tokens.css', 'ui/ui.css', 'pages/training.css', 'components/TrainingPlayer.tsx', 'lib/index.ts']) {
      expect(sources.some((s) => s.rel === rel), rel).toBe(true);
    }
    expect(sources.some((s) => /\.test\./.test(s.rel) || s.rel.startsWith('test/'))).toBe(false);
    expect(LUMEN.has('--accent')).toBe(true);
    expect(RUNTIME_PROPS.has('--ui-tooltip-shift')).toBe(true);
  });

  it('every scanned ts/tsx file parses cleanly (an unparseable file is an error, never silently blanked: LOW-F)', () => {
    expect(SCAN.parseFailures).toEqual([]);
  });

  it('1. no retired token anywhere (definition or reference)', () => {
    expect(offenders((s) => findRetiredTokens(s.text))).toEqual([]);
  });

  it('2. no color literal outside lumen-tokens.css', () => {
    expect(offenders((s) => (LITERAL_ALLOWED.has(s.rel) ? [] : findLiterals(s.rel, s.text)))).toEqual([]);
  });

  it('the runtime-published custom properties are exactly the pinned pair (a new one needs a deliberate edit here)', () => {
    expect([...RUNTIME_PROPS].sort()).toEqual([...RUNTIME_PROP_NAMES].sort());
  });

  it('3. every var(--x) resolves to a Lumen token, a setProperty runtime property, or a same-file declaration', () => {
    expect(offenders((s) => findUnresolvedVars(s.text, LUMEN, RUNTIME_PROPS))).toEqual([]);
  });

  it('4. outline: none|0 only with a paired :focus-visible replacement or an allow-list entry', () => {
    const raw = sources.filter((s) => s.rel.endsWith('.css')).flatMap((s) => findUnpairedOutlineOff(s.text, s.rel));
    expect(raw.filter((k) => !(k in OUTLINE_ALLOW))).toEqual([]);
    // A stale allow-list entry (the block was fixed or removed) must be deleted.
    expect(Object.keys(OUTLINE_ALLOW).filter((k) => !raw.includes(k))).toEqual([]);
  });

  it('5. inline style props carry geometry keys only', () => {
    expect(offenders((s) => (s.rel.endsWith('.tsx') ? findInlineStyleViolations(s.text) : []))).toEqual([]);
  });

  it('7. no imperative style writes in ts/tsx beyond geometry and the enumerated allow-list', () => {
    const raw = sources
      .filter((s) => /\.tsx?$/.test(s.rel))
      .flatMap((s) => findImperativeStyleWrites(s.text).map((k) => `${s.rel}|${k}`));
    expect(raw.filter((k) => !(k in STYLE_WRITE_ALLOW))).toEqual([]);
    expect(Object.keys(STYLE_WRITE_ALLOW).filter((k) => !raw.includes(k))).toEqual([]);
  });

  it('6. var(--x, fallback) only for the enumerated sanctioned fallbacks', () => {
    const raw = sources.flatMap((s) => findVarFallbacks(s.text).map((n) => `${s.rel}|${n}`));
    expect(raw.filter((k) => !(k in SANCTIONED_FALLBACKS))).toEqual([]);
    // A stale allow-list entry (the fallback was removed) must be deleted.
    expect(Object.keys(SANCTIONED_FALLBACKS).filter((k) => !raw.includes(k))).toEqual([]);
  });

  // DATA_MODULES is filtered out of the scan before EVERY rule, and LITERAL_ALLOWED exempts rule 2 wholesale: a
  // member added to either silently exempts that file from the ratchet, so growing them is a deliberate edit here.
  it('the file-level exemptions are exactly the pinned members (PRR-152-02)', () => {
    expect([...DATA_MODULES].sort()).toEqual(['styles/retired-tokens.ts', 'styles/token-remap.ts']);
    expect([...LITERAL_ALLOWED].sort()).toEqual(['styles/lumen-tokens.css']);
  });
});

// ---------------------------------------------------------------------------------------------
// Self-tests: every rule must detect a violation (mutation check) and pass clean input
// ---------------------------------------------------------------------------------------------

describe('token ratchet self-tests', () => {
  it('comment stripping removes line, trailing, block and JSX comments but keeps strings and URLs', () => {
    const ts = [
      "const a = 1; // see issue #123 and #fff",
      "/* #abc rgb(1,2,3) */ const b = 'http://x.test/#fade';",
      '{/* #def */}',
      "const c = '#00f'; // trailing",
      'const re = /\\/\\*/; const d = "//";',
    ].join('\n');
    const out = stripTsComments(ts);
    expect(out).not.toMatch(/#123|#fff|#abc|rgb\(|#def|trailing/);
    expect(out).toContain("'http://x.test/#fade'");
    expect(out).toContain("'#00f'");
    expect(out).toContain('"//"');
    expect(findColorLiterals(out)).toEqual(['#fade', '#00f']);
    expect(findColorLiterals(stripCssComments('/* #123 */ a { color: #fff; }'))).toEqual(['#fff']);
  });

  it('comment stripping never erases live code after a "/*" in a CSS string or a "//" URL in JSX text or a string (P8-M1)', () => {
    const css = '.p::before{content:"/*"} .q{color:#00ff00} .r::after{content:"*/"} .s{content:\'/*\'} .t{color:#abcdef}';
    expect(findColorLiterals(stripCssComments(css))).toEqual(['#00ff00', '#abcdef']);
    expect(findColorLiterals(stripCssComments('.a{color:#111} /* #222 */ .b{content:"x"} /* "#333" */ .c{color:#444}'))).toEqual(['#111', '#444']);
    const jsx = "<p>see http://example.com</p>; const c = '#123456'; const r = 'var(--color-primary)';";
    expect(findColorLiterals(stripTsComments(jsx))).toEqual(['#123456']);
    expect(findRetiredTokens(stripTsComments(jsx))).toEqual(['--color-primary']);
    const str = "const u = 'http://example.com'; const c = '#654321';";
    expect(findColorLiterals(stripTsComments(str))).toEqual(['#654321']);
    // A real comment after a colon (note the space) and an ordinary line comment are still stripped.
    expect(findColorLiterals(stripTsComments('const o = { a: // #aaa\n 1 }; // #bbb\nconst c = \'#ccc\';'))).toEqual(['#ccc']);
  });

  it('comment stripping keeps live code after a "//" in JSX text, with or without a colon or a space before it (Q5)', () => {
    const planted = [
      "const a = <p>see a // b</p>; const hexOne = '#111111';",
      "const b = <p>x//y</p>; const hexTwo = '#222222';",
      'const c = (',
      '  <p>',
      '    // looks like a comment but is text',
      "    {ok && <i title=\"//\">{'#333333'}</i>}",
      '  </p>',
      ');',
    ].join('\n');
    expect(findColorLiterals(stripTsComments(planted))).toEqual(['#111111', '#222222', '#333333']);
    // The "//" in JSX text with a live {expression} on the SAME line (PR #151 final review LOW-A): a
    // stripper that treated the JSX text as trivia would blank the rest of the line, expression included.
    const sameLine = "const c = (<p>\n  // see {'#333333'}</p>);";
    expect(stripTsComments(sameLine)).toBe(sameLine);
    expect(findColorLiterals(stripTsComments(sameLine))).toEqual(['#333333']);
    // The same text with real comments still strips them, and JSX comments are stripped.
    const real = "const d = <p>t</p>; // #aaaaaa\nconst e = <p>{/* #bbbbbb */ 'x'}</p>; /* #cccccc */ const f = '#dddddd';";
    expect(findColorLiterals(stripTsComments(real))).toEqual(['#dddddd']);
    // A .ts file parses as TS (angle-bracket assertions are not JSX) and keeps its strings and regexes.
    const plainTs = "const g = <string>h; // #eeeeee\nconst r = /\\/\\//; const s = '#123abc'; const u = `${'//'}#abcdef`;";
    expect(findColorLiterals(stripTsComments(plainTs, false))).toEqual(['#123abc', '#abcdef']);
  });

  it('comment stripping fails closed on a file the TS parser rejects, and routes .ts as TS and .tsx as TSX (LOW-F)', () => {
    // JSX in a .ts file is a parse error, so it is reported, not recovered into blanked "comments".
    const jsxInTs = "export const C = () => <Banner tone=\"warning\">x // y</Banner>; const y = '#444444';";
    expect(() => strip('components/a.ts', jsxInTs)).toThrow(TsParseError);
    expect(() => strip('components/a.ts', jsxInTs)).toThrow(/components\/a\.ts does not parse cleanly/);
    // The same text is valid TSX.
    expect(findColorLiterals(strip('components/a.tsx', jsxInTs))).toEqual(['#444444']);
    // Any other syntax error fails closed too.
    expect(() => strip('lib/b.tsx', "const a = {; // c\nconst b = '#555555';")).toThrow(TsParseError);
    expect(() => strip('lib/b.ts', "const a = `open ${x}\nconst b = '#666666';")).toThrow(TsParseError);
    // A .ts angle-bracket assertion parses as TS (it would be an unclosed JSX element under TSX).
    const assertion = "const g = <string>h; // #eeeeee\nconst s = '#123abc';";
    expect(findColorLiterals(strip('lib/c.ts', assertion))).toEqual(['#123abc']);
    expect(() => strip('lib/c.tsx', assertion)).toThrow(TsParseError);
    // A TypeScript without the internal parseDiagnostics field fails closed, not open.
    expect(() => parseDiagnosticsOf({} as ts.SourceFile, 'lib/d.ts')).toThrow(/no longer exposes SourceFile\.parseDiagnostics/);
  });

  it('the real-tree scan records an unparseable file as a failure (with its name) and keeps its raw text (LOW-F)', () => {
    const failures: string[] = [];
    const bad = "export const C = () => <Banner tone=\"warning\">x // y</Banner>; const y = '#444444';";
    const loaded = loadSource('components/broken.ts', bad, failures);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^components\/broken\.ts does not parse cleanly: /);
    expect(loaded).toEqual({ rel: 'components/broken.ts', text: bad });
    // A clean file records nothing and comes back stripped.
    const clean: string[] = [];
    expect(loadSource('lib/ok.ts', "const a = 1; // #abcabc\nconst b = '#123123';", clean).text).not.toContain('#abcabc');
    expect(clean).toEqual([]);
  });

  it('scanTree scans exactly the non-test sources of a tree and reports its unparseable files in its own list (P11)', () => {
    const root = mkdtempSync(join(tmpdir(), 'token-ratchet-scan-'));
    try {
      const files: Record<string, string> = {
        'components/broken.ts': "export const C = () => <Banner tone=\"warning\">x // y</Banner>; const y = '#444444';",
        'lib/ok.ts': "const a = 1; // #abcabc\nconst b = '#123123';",
        'styles/a.css': 'a { color: var(--accent); }',
        'components/x.test.ts': "const c = '#999999';",
        'test/helper.ts': "const d = '#888888';",
        'styles/retired-tokens.ts': "export const R = ['--color-primary'];",
        'notes.md': '# not a source',
      };
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
      const scan = scanTree(root);
      expect(scan.sources.map((s) => s.rel).sort()).toEqual(['components/broken.ts', 'lib/ok.ts', 'styles/a.css']);
      // The broken file is reported by name, in the scan's own list, and kept raw.
      expect(scan.parseFailures).toHaveLength(1);
      expect(scan.parseFailures[0]).toMatch(/^components\/broken\.ts does not parse cleanly: /);
      expect(scan.sources.find((s) => s.rel === 'components/broken.ts')?.text).toBe(files['components/broken.ts']);
      expect(scan.sources.find((s) => s.rel === 'lib/ok.ts')?.text).not.toContain('#abcabc');
      // Two scans never share a failure list.
      expect(scanTree(root).parseFailures).not.toBe(scan.parseFailures);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('comment stripping survives a JSX apostrophe and a template literal with nested braces', () => {
    const ts = "const x = <p>Don't</p>; // gone #111\nconst y = `a ${ {k: '#222'}.k } b`; // gone #333\nconst z = '#444';";
    const out = stripTsComments(ts);
    expect(findColorLiterals(out)).toEqual(['#222', '#444']);
  });

  it('rule 1 detects a retired token and keeps --font-family-mono / --font-mono legal', () => {
    expect(findRetiredTokens('a { color: var(--color-primary); font: var(--font-family) }')).toEqual(['--color-primary', '--font-family']);
    expect(findRetiredTokens('--spacing-md: 4px;')).toEqual(['--spacing-md']);
    expect(findRetiredTokens('var(--font-family-mono) var(--font-mono) var(--shadow-1) var(--space-4)')).toEqual([]);
  });

  it('rule 2 detects hex literals and every color function', () => {
    expect(findColorLiterals('a{color:#fff;b:#12345678;c:rgb(1,2,3);d:rgba(0,0,0,.5);e:hsl(1,2%,3%);f:hsla(1,2%,3%,.4);g:oklch(1 0 0)}')).toHaveLength(7);
    expect(findColorLiterals('a{b:hwb(1 2% 3%);c:lab(1 2 3);d:lch(1 2 3);e:oklab(1 2 3);f:color(srgb 1 0 0)}')).toHaveLength(5);
    // color-mix over tokens holds no literal; with literal operands each is matched on its own.
    expect(findColorLiterals('a{b:color-mix(in srgb, var(--bg-canvas) 70%, transparent)}')).toEqual([]);
    expect(findColorLiterals('a{b:color-mix(in srgb, #fff 50%, rgb(0 0 0))}')).toEqual(['#fff', 'rgb(']);
    expect(findColorLiterals('a { color: var(--accent); background: Highlight; border-color: CanvasText }')).toEqual([]);
  });

  it('rule 2 detects named colors in color-bearing CSS declarations and ignores keywords, tokens and strings', () => {
    expect(findNamedColors('a { color: red; background: white url(x.png); border: 1px solid Tomato }')).toEqual(['red', 'white', 'Tomato']);
    expect(findNamedColors('a { background: color-mix(in srgb, var(--accent) 40%, blue) } b { --mine: navy }')).toEqual(['blue', 'navy']);
    expect(findNamedColors('a { box-shadow: 0 0 0 2px gold; outline: 2px solid var(--focus-ring, red) }')).toEqual(['gold', 'red']);
    // Legal: system colors, transparent/currentColor, tokens, token names that contain a color word, strings, non-color properties.
    expect(
      findNamedColors(
        'a { color: CanvasText; background: Highlight; border-color: transparent; fill: currentColor; stroke: var(--red-ish); content: "red"; font-family: Tan, sans-serif; grid-area: green; background-image: url(red.png) }'
      )
    ).toEqual([]);
    expect(findLiterals('x.css', 'a { color: red }')).toEqual(['red']);
    expect(findLiterals('x.tsx', "const label = 'red'; const c = 'tan';")).toEqual([]);
  });

  it('rule 6 finds a fallback on any var() and ignores nested token-only var()s', () => {
    expect(findVarFallbacks('a { b: var(--x, #fff); c: var( --y ,1px); d: var(--z) }')).toEqual(['--x', '--y']);
    expect(findVarFallbacks('a { b: calc(var(--settings-nav-h, var(--space-16)) + var(--space-2)) }')).toEqual(['--settings-nav-h']);
    expect(findVarFallbacks('a { b: var(--space-3) }')).toEqual([]);
    for (const reason of Object.values(SANCTIONED_FALLBACKS)) expect(reason.length).toBeGreaterThan(20);
  });

  it('rule 3 detects an unresolved var() and accepts Lumen, setProperty runtime and same-file declarations', () => {
    const lumen = new Set(['--accent']);
    const rt = new Set(['--ui-tooltip-shift']);
    expect(findUnresolvedVars('a { color: var(--nope); b: var(--color-border, #444) }', lumen, rt)).toEqual(['--nope', '--color-border']);
    expect(findUnresolvedVars('a { color: var(--accent); b: var(--ui-tooltip-shift) }', lumen, rt)).toEqual([]);
    expect(findUnresolvedVars('a { --mine: 1px; b: var(--mine) } c { d: var(--other) }', lumen, rt)).toEqual(['--other']);
    expect(findUnresolvedVars("el.style.setProperty('--dyn', '1'); const s = 'var(--dyn)';", lumen, rt)).toEqual([]);
  });

  it('rule 4 detects an unpaired outline removal and accepts paired :focus-visible replacements', () => {
    expect(findUnpairedOutlineOff('.x:focus { outline: none; }', 'f.css')).toEqual(['f.css|.x:focus']);
    expect(findUnpairedOutlineOff('.x { outline: 0; }', 'f.css')).toEqual(['f.css|.x']);
    expect(findUnpairedOutlineOff('.x:focus-visible { outline: none }', 'f.css')).toEqual(['f.css|.x:focus-visible']);
    // A replacement that is itself `none` is not a replacement.
    expect(findUnpairedOutlineOff('.x:focus { outline: none } .x:focus-visible { outline: none }', 'f.css')).toHaveLength(2);
    // A :focus-visible rule for a DIFFERENT root does not pair.
    expect(findUnpairedOutlineOff('.x:focus { outline: none } .y:focus-visible { outline: 2px solid red }', 'f.css')).toHaveLength(1);
    expect(
      findUnpairedOutlineOff(
        '.x:focus:not(:focus-visible) { outline: none } .x:focus-visible { outline: 2px solid var(--focus-ring) }',
        'f.css'
      )
    ).toEqual([]);
    expect(
      findUnpairedOutlineOff(
        '.s .i:focus-visible + .t { outline: 2px solid var(--focus-ring) } .s .i:focus-visible { outline: none }',
        'f.css'
      )
    ).toEqual([]);
    // P8-M2: a :focus-visible rule under a DIFFERENT ancestor is not the replacement; outline-color: transparent is a removal.
    expect(findUnpairedOutlineOff('.z:focus { outline: none } .nonexistent .z:focus-visible { outline: 2px solid red }', 'f.css')).toEqual(['f.css|.z:focus']);
    expect(findUnpairedOutlineOff('.y:focus { outline-color: transparent }', 'f.css')).toEqual(['f.css|.y:focus']);
    expect(findUnpairedOutlineOff('.y:focus { outline: transparent }', 'f.css')).toEqual(['f.css|.y:focus']);
    expect(findUnpairedOutlineOff('.y:focus { outline-color: transparent } .y:focus-visible { outline: 2px solid red }', 'f.css')).toEqual([]);
    expect(findUnpairedOutlineOff('.y:focus { outline: none } .y:focus-visible { outline: transparent }', 'f.css')).toEqual(['f.css|.y:focus', 'f.css|.y:focus-visible']);
    expect(findUnpairedOutlineOff('.y:focus { outline: none } .a, .y:focus-visible { outline: 2px solid red }', 'f.css')).toEqual([]);
    // Inside @media the block is still found.
    expect(findUnpairedOutlineOff('@media (min-width: 1px) { .m:focus { outline: none; } }', 'f.css')).toEqual(['f.css|.m:focus']);
  });

  it('rule 4 allow-list entries all name a real unpaired block with a stated reason', () => {
    for (const [key, reason] of Object.entries(OUTLINE_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(key).toMatch(/\.css\|/);
    }
  });

  it('rule 7 detects imperative style writes and accepts geometry and the pinned runtime properties (P8-L1)', () => {
    expect(findImperativeStyleWrites("el.style.color = 'red'; el.style.padding = '3px'; el.style.backgroundColor = x;")).toEqual(['color', 'padding', 'backgroundColor']);
    expect(findImperativeStyleWrites("el.style.height = 'auto'; el.style.width = `${w}px`; el.style.transform += 'x'; if (el.style.height == 'a') {}")).toEqual([]);
    expect(findImperativeStyleWrites("el.style.cssText = 'color:red'; el.style.display = 'none';")).toEqual(['cssText', 'display']);
    expect(findImperativeStyleWrites("host.style.setProperty('--settings-nav-h', '1px'); tip.style.setProperty(\"--ui-tooltip-shift\", '0px');")).toEqual([]);
    expect(findImperativeStyleWrites("el.style.setProperty('color', 'red'); el.style.setProperty('--made-up', '1'); el.style.setProperty(name, v);")).toEqual(['setProperty(color)', 'setProperty(--made-up)', 'setProperty(<dynamic>)']);
    expect(findImperativeStyleWrites("el.style['color'] = 'red';")).toEqual(['style (aliased)', 'style[...]']);
    expect(findImperativeStyleWrites("el['style'].color = 'red';")).toEqual(['style[...]']);
    expect(findImperativeStyleWrites("sheet.insertRule('a{}'); el.setAttribute('style', 'x'); Object.assign(el.style, { color: 'red' });")).toEqual([
      'style (aliased)',
      "setAttribute('style')",
      'Object.assign(...style)',
      'sheet API: insertRule',
    ]);
    for (const reason of Object.values(STYLE_WRITE_ALLOW)) expect(reason.length).toBeGreaterThan(20);
  });

  it('rule 7 closes the aliased el.style bypass: the style object may not escape (Q1)', () => {
    expect(findImperativeStyleWrites("const s = el.style; s.color = 'red';")).toEqual(['style (aliased)']);
    expect(findImperativeStyleWrites("const { style } = el; style.color = 'red';")).toEqual(['{ style } = ...']);
    expect(findImperativeStyleWrites("const { style: s, id } = el; s.padding = '1px';")).toEqual(['{ style } = ...']);
    expect(findImperativeStyleWrites("Object.assign(el.style, { color: 'red' });")).toEqual(['style (aliased)', 'Object.assign(...style)']);
    expect(findImperativeStyleWrites("paint(el.style, 'red'); const t = cond ? el.style : other;")).toEqual(['style (aliased)']);
    expect(findImperativeStyleWrites("el.style = 'color: red';")).toEqual(['style (aliased)']);
    expect(findImperativeStyleWrites("el\n  ?.style\n  .color = 'red';")).toEqual(['color']);
    const setProp = findImperativeStyleWrites('const set = el.style.setProperty; set.call(el.style, "color", "red");');
    expect(setProp).toContain('style.setProperty (unbound)');
    // Legal: geometry writes, reads through a member, a computed-style read and an unrelated destructure.
    expect(findImperativeStyleWrites("el.style.height = 'auto'; const h = el.style.height; el?.style.width;")).toEqual([]);
    expect(findImperativeStyleWrites("const style = window.getComputedStyle(el); const v = style.getPropertyValue('--x'); const { a, b } = el;")).toEqual([]);
    expect(findImperativeStyleWrites('function F({ style }: Props) { return null; }')).toEqual([]);
  });

  it('rule 7 closes attributeStyleMap and attribute-node style writes (Q2)', () => {
    expect(findImperativeStyleWrites("el.attributeStyleMap.set('color', 'red');")).toEqual(['attributeStyleMap']);
    expect(findImperativeStyleWrites("const m = el.attributeStyleMap; m.set('color', 'red');")).toEqual(['attributeStyleMap']);
    expect(findImperativeStyleWrites("el.setAttributeNS(null, 'style', 'color:red');")).toEqual(["setAttribute('style')"]);
    expect(findImperativeStyleWrites("el.setAttributeNode(attr); el.attributes.style.value = 'x';")).toEqual(['value', 'style attribute node']);
    expect(findImperativeStyleWrites("el.setAttribute('tabindex', '-1'); el.setAttribute('aria-hidden', 'true');")).toEqual([]);
  });

  it('rule 7 closes injected style elements, style markup and HTML sinks (Q3)', () => {
    expect(findImperativeStyleWrites("const s = document.createElement('style'); s.textContent = 'a{color:red}';")).toEqual(["createElement('style')"]);
    expect(findImperativeStyleWrites('document.head.append(document.createElement("style"));')).toEqual(["createElement('style')"]);
    expect(findImperativeStyleWrites("host.innerHTML = '<p>x</p>';")).toEqual(['html sink: innerHTML']);
    expect(findImperativeStyleWrites("host.insertAdjacentHTML('beforeend', '<style>a{color:red}</style>');")).toEqual(['<style>', 'html sink: insertAdjacentHTML']);
    expect(findImperativeStyleWrites("host.insertAdjacentHTML('beforeend', '<' + 'sty' + 'le>')")).toEqual(['html sink: insertAdjacentHTML']);
    expect(findImperativeStyleWrites('const x = <style>{css}</style>;')).toEqual(['<style>']);
    expect(findImperativeStyleWrites("const h = '<div style=\"color:red\">x</div>';")).toEqual(['style="..."']);
    expect(findImperativeStyleWrites("const h = '<div style=\\'color:red\\'>x</div>';")).toEqual(['style="..."']);
    expect(findImperativeStyleWrites("el.outerHTML = a; range.createContextualFragment(a); document.write(a); f.srcdoc = a; <div dangerouslySetInnerHTML={x} />")).toEqual([
      'html sink: outerHTML',
      'html sink: createContextualFragment',
      'html sink: document.write',
      'html sink: srcdoc',
      'html sink: dangerouslySetInnerHTML',
    ]);
    expect(findImperativeStyleWrites("link.rel = 'stylesheet'; link.href = u;")).toEqual(['rel=stylesheet']);
    // Legal: a variable named style, JSX style props (rule 5 owns them), non-style createElement, DOMParser for XML.
    expect(findImperativeStyleWrites("const style = 'x'; let y = <div style={{ width: 1 }} />; const m = document.createElement('meta'); new DOMParser().parseFromString(x, 'text/xml');")).toEqual([]);
  });

  it('rule 7 closes constructable stylesheets and CSSOM rule APIs but leaves String.replace alone (Q4)', () => {
    expect(findImperativeStyleWrites("const sh = new CSSStyleSheet(); sh.replaceSync('a{color:red}');")).toEqual(['sheet API: CSSStyleSheet', 'sheet API: replaceSync']);
    expect(findImperativeStyleWrites("await sh.replace('a{color:red}'); document.adoptedStyleSheets = [sh];")).toEqual(['sheet API: adoptedStyleSheets']);
    expect(findImperativeStyleWrites("document.styleSheets[0].cssRules[0]; sheet.deleteRule(0); sheet.addRule('a', 'b');")).toEqual([
      'sheet API: styleSheets',
      'sheet API: cssRules',
      'sheet API: deleteRule',
      'sheet API: addRule',
    ]);
    expect(findImperativeStyleWrites("const t = name.replace(/a/g, 'b').replace('c', 'd'); x.replaceAll('a', 'b');")).toEqual([]);
  });

  it('every real-tree style-write allow-list key names an existing file (no dangling entry)', () => {
    for (const key of Object.keys(STYLE_WRITE_ALLOW)) expect(sources.some((s) => s.rel === key.split('|')[0]), key).toBe(true);
  });

  it('rule 5 detects non-geometry inline-style keys, spreads, computed keys and non-literal style values', () => {
    expect(findInlineStyleViolations('<div style={{ width: `${p}%`, height }} />')).toEqual([]);
    expect(findInlineStyleViolations('<div style={{ position: "relative", top: 1, transform: `translateY(${y}px)` }} />')).toEqual([]);
    expect(findInlineStyleViolations('<div style={ok ? { width: `${pct}%` } : undefined} />')).toEqual([]);
    expect(findInlineStyleViolations('<div style={{ color: "red" }} />')).toEqual(['color']);
    expect(findInlineStyleViolations('<div style={{ width: 1, backgroundColor: x, padding: 2 }} />')).toEqual(['backgroundColor', 'padding']);
    expect(findInlineStyleViolations('<div style={{ "--accent": "x", margin: 0 }} />')).toEqual(['--accent', 'margin']);
    expect(findInlineStyleViolations('<div style={{ ...base, width: 1 }} />')).toEqual(['...']);
    expect(findInlineStyleViolations('<div style={styles} />')).toEqual(['style={styles}']);
    expect(findInlineStyleViolations('<div style={{ width: fn(a, { color: 1 }), height: 2 }} />')).toEqual([]);
    expect(findInlineStyleViolations('<div style={cond ? { color: "red" } : { width: 1 }} />')).toEqual(['color']);
  });
});
