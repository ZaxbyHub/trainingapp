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
 *   7. no imperative style writes in .ts/.tsx (`el.style.color = ...`, `style.setProperty('color', ...)`,
 *      cssText, insertRule, setAttribute('style'), ...) beyond geometry and the enumerated allow-list
 *
 * Known limit of the comment stripper: a `//` preceded by whitespace inside JSX *text* is read as a line
 * comment (JSX text cannot be told apart from code without a parser); `http://x` is handled.
 *
 * Each rule is a pure function with a self-test that feeds it a violating fixture, so a rule
 * that silently stops matching fails here rather than passing vacuously. The per-surface
 * hygiene tests (ui/, layouts/, ...) stay as the stricter extra guard for the migrated surfaces.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

/** Strips // and block comments from TS/TSX/JSX, leaving string, template and regex literals intact. */
function stripTsComments(t: string): string {
  let out = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if ((c === '"' || c === "'") && /[\w$]$/.test(out)) {
      // An apostrophe/quote glued to a word is JSX text (Don't), not a string opener.
      out += c;
      i++;
    } else if (c === '"' || c === "'" || c === '`') {
      const j = skipString(t, i);
      out += t.slice(i, j);
      i = j;
    } else if (c === '/' && t[i + 1] === '/' && t[i - 1] === ':' && !/\s/.test(t[i + 2] ?? ' ')) {
      // `http://x` in JSX text: a URL scheme, not a line comment (a real `key: // note` has a space after the slashes).
      out += '//';
      i += 2;
    } else if (c === '/' && t[i + 1] === '/') {
      while (i < t.length && t[i] !== '\n') i++;
    } else if (c === '/' && t[i + 1] === '*') {
      const e = t.indexOf('*/', i + 2);
      const end = e < 0 ? t.length : e + 2;
      out += t.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else if (c === '/' && /(^|[(,=:[!&|?{};])\s*$/.test(out)) {
      // Regex literal: copy through the closing slash (a `/` or quote inside must not start a comment/string).
      let j = i + 1;
      let inClass = false;
      while (j < t.length && t[j] !== '\n') {
        if (t[j] === '\\') { j += 2; continue; }
        if (t[j] === '[') inClass = true;
        else if (t[j] === ']') inClass = false;
        else if (t[j] === '/' && !inClass) break;
        j++;
      }
      out += t.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
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

const strip = (rel: string, text: string): string => (rel.endsWith('.css') ? stripCssComments(text) : stripTsComments(text));

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

/** Imperative style writes in one comment-stripped TS/TSX text (rule 7). Geometry properties are legal. */
function findImperativeStyleWrites(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\.style\.(\w+)\s*(?:=(?!=)|\+=)/g)) if (!GEOMETRY_KEYS.has(m[1])) out.push(m[1]);
  for (const m of text.matchAll(/\bstyle\.setProperty\(\s*(?:(['"`])([^'"`]*)\1|([^'"`\s)][^,)]*))/g)) {
    const name = m[2] ?? '<dynamic>';
    if (!RUNTIME_PROP_NAMES.includes(name)) out.push(`setProperty(${name})`);
  }
  if (/\.style\[/.test(text)) out.push('style[...]');
  if (/\binsertRule\b|\badoptedStyleSheets\b/.test(text)) out.push('insertRule/adoptedStyleSheets');
  if (/setAttribute\(\s*['"`]style['"`]/.test(text)) out.push("setAttribute('style')");
  if (/Object\.assign\([^;]*\.style\b/.test(text)) out.push('Object.assign(...style)');
  return out;
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

interface Source { rel: string; text: string }

const sources: Source[] = walk(SRC)
  .map((p) => relative(SRC, p).replace(/\\/g, '/'))
  .filter((rel) => isSource(rel) && !DATA_MODULES.has(rel))
  .map((rel) => ({ rel, text: strip(rel, readFileSync(join(SRC, rel), 'utf8')) }));

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
    expect(findImperativeStyleWrites("el.style['color'] = 'red';")).toEqual(['style[...]']);
    expect(findImperativeStyleWrites("sheet.insertRule('a{}'); el.setAttribute('style', 'x'); Object.assign(el.style, { color: 'red' });")).toEqual([
      'insertRule/adoptedStyleSheets',
      "setAttribute('style')",
      'Object.assign(...style)',
    ]);
    for (const reason of Object.values(STYLE_WRITE_ALLOW)) expect(reason.length).toBeGreaterThan(20);
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
