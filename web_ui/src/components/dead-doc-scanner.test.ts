/**
 * dead-doc-scanner (#260 AC2/AC3/AC4) — the class-wide dead-doc guardrail.
 * SUPERSEDES dead-doc-references-35.test.tsx: the old ratchet's detector was
 * family-blind (PACKAGING family only) and passed green while two same-class
 * docs/updates.md pointers lived inside one of its own pinned files. The 8
 * GUARDED_SOURCES files from that spec migrate into the 'guarded-sources'
 * leg below, so the old file may be deleted by the fix without losing
 * user-visible-copy coverage.
 *
 * Real scope of the detector, stated honestly (AC4 corrects the old "clean of
 * the class" overclaim; the swarm-pr-review round on PR #261 then corrected
 * this section again — see "Known residuals"):
 *   - Detector: FAMILY UNION. Arm 1 = the legacy PACKAGING family
 *     /PACKAGING\.md|packaging guide|Packaging guide/i (case forms per the
 *     old spec). Arm 2 = path-shaped repo-doc tokens (x/y.md ...), found by a
 *     linear manual scan (findPathDocTokens) — a backtracking-prone regex
 *     version was replaced after review measured quadratic blowup on long
 *     dotted/kebab runs. The union matters: PACKAGING.md carries no slash, so
 *     arm 2 alone cannot see it, and arm 1 alone cannot see any non-PACKAGING
 *     repo-doc path.
 *   - Comment-aware via a block+line comment classifier (visibleText): // and
 *     /* *\/ interiors are blanked out (offset-preserving) so developer-facing
 *     prose never counts. String and template literals are NOT treated as
 *     comments — they are user-visible copy, so their contents stay
 *     scannable; the classifier only prevents their contents (a URL's //, a
 *     '/*' wildcard) from being misread as comment starts. A '//' that is the
 *     tail of a '://' URL scheme is never a comment start (JSX text carries
 *     URLs outside string literals).
 *   - Allowlist: SHIPPED_DOCS — repo documents the installer actually
 *     stages, each entry with a reason. Today that is docs/licenses.md
 *     (shipped via desktop/installer-resources/docs/); user-visible pointer
 *     precedent: FirstRunWizard.tsx licensing-notices step ("ship with the
 *     installer (docs/licenses.md)"). An allowlisted token is not a
 *     dead-doc reference; family hits are never allowlisted.
 *   - Roots walked: web_ui/src, desktop/main, desktop/preload, web_ui/public
 *     — resolved from THIS FILE's own location (import.meta.url), never
 *     process.cwd(); a relocated checkout cannot pass from a wrong cwd, and a
 *     missing root fails closed with ENOENT rather than passing silently. The
 *     live-tree leg additionally asserts every root yields at least one
 *     scannable file, so a root that silently contributes nothing (the old
 *     desktop/src, which held only a skipped __tests__/) fails loudly instead
 *     of passing vacuously.
 *   - Exclusions: test trees (*.test.*, *.spec.*, __tests__/) never count.
 *     As a throughput guard only (not a correctness tradeoff) the walk also
 *     skips non-source extensions and files larger than 2 MiB, and scopes a
 *     public/models assembly area to its two tracked doc files — the
 *     packaged model weights under web_ui/public/models/ are multi-GB
 *     untracked binaries, while the tracked copy-bearing files there
 *     (README.md, manifest.json) are KB-scale. That scoping is a NAMED
 *     EXCEPTION, not class-complete coverage of that subtree: a raw-text
 *     grep over web_ui/public with no scanner scoping is the review trigger
 *     for any future tracked addition in the assembly area.
 *   - Known residuals (disclosed, not class-complete): regex literals are not
 *     modeled (a /.../ containing // or /* could mask the rest of its line);
 *     a bare '//' in JSX text that is not part of a URL scheme still starts a
 *     comment for the remainder of that line; a '/*' in JSX text opens a
 *     phantom block; an apostrophe in JSX text can pair with a later
 *     apostrophe and protect the span between them from comment detection
 *     (fail-toward-scanning, never fail-toward-masking); HTML comments
 *     (<!-- -->) are not modeled, so a doc path inside one in a walked .html
 *     file reads as copy; non-ASCII path segments and uppercase .MD
 *     extensions produce no token; a slash-less bare doc name (e.g.
 *     CONFIGURATION.md) evades both arms. Each residual is fail-loud or
 *     fail-safe for the zero-hit guarantee; the raw Phase 4.2 predicates in
 *     the trace's 08a-recurrence-sweep.md are the complementary manual
 *     census.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Detector constants
// ---------------------------------------------------------------------------

/** Arm 1 — the legacy PACKAGING family (verbatim from the old ratchet). */
const FAMILY_RE = /PACKAGING\.md|packaging guide|Packaging guide/i;

/** Shipped docs allowlist: repo documents the installer actually stages, so
 *  a user-visible pointer to them is not dead. One constant, per-entry
 *  reasons (AC2/issue design point 5). Membership is tested with
 *  Object.hasOwn so Object.prototype keys can never be allowlisted. */
const SHIPPED_DOCS: Readonly<Record<string, string>> = {
  'docs/licenses.md':
    'Shipped: desktop/installer-resources/docs/ stages licenses.md + licenses/ into the installer. ' +
    'User-visible pointer precedent: FirstRunWizard.tsx licensing-notices step.',
};

/** Text-source extensions the walk reads. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json', '.md', '.mdx', '.txt',
]);

/** Throughput ceiling: no copy-bearing tracked file in the roots is anywhere
 *  near this; the untracked model weights are skipped by extension before
 *  the size check ever runs. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** public/models is a packaging-time assembly area, not authored copy: its
 *  own tracked .gitignore ignores everything except the two documentation
 *  files below (exactly the two GUARDED_SOURCES entries under public/).
 *  Upstream weight bundles vendored there by scripts/prepare-models.mjs —
 *  e.g. embeddings/<model>/README.md riding inside a weights drop — are not
 *  this repo's user-visible copy and are not scanned. */
const PUBLIC_MODELS_DOC_FILES = new Set(['README.md', 'manifest.json']);

/** A dead-doc reference found in user-visible (non-comment) copy. */
interface Hit {
  file: string;
  line: number;
  token: string;
}

// ---------------------------------------------------------------------------
// Comment classifier (string-aware)
// ---------------------------------------------------------------------------

/** ASCII word char — the same class the old regexes' \w matched. */
function isWordChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
}

/** Index of the closing quote for a string starting at `open`, honoring
 *  backslash escapes; -1 when the line ends first (unterminated). */
function findStringEnd(line: string, open: number, quote: string): number {
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

/** Index of the closing backtick for a template literal starting at `open`,
 *  honoring backslash escapes; -1 when the line ends first (the template
 *  continues on the next line). */
function findTemplateEnd(line: string, open: number): number {
  return findStringEnd(line, open, '`');
}

/** For each line of `text`, the line with COMMENT interiors blanked to
 *  spaces (offset-preserving): // line comments and /* *\/ block comments are
 *  replaced, while code, string literals and template literals — all
 *  user-visible copy surfaces — are preserved for the detector. Block and
 *  template state carry across lines. A '//' that is the tail of a '://' URL
 *  scheme is not a comment start. */
function visibleText(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock = false;
  let inTemplate = false;
  for (const line of lines) {
    const chars = line.split('');
    const blank = (from: number, to: number) => {
      for (let k = from; k < to; k++) chars[k] = ' ';
    };
    let i = 0;
    if (inBlock) {
      const close = line.indexOf('*/', i);
      if (close === -1) {
        out.push(' '.repeat(line.length));
        continue;
      }
      blank(i, close + 2);
      inBlock = false;
      i = close + 2;
    }
    if (inTemplate) {
      const close = findTemplateEnd(line, i);
      if (close === -1) {
        out.push(line); // whole line is template-literal interior: keep it
        continue;
      }
      inTemplate = false;
      i = close + 1;
    }
    while (i < line.length) {
      const ch = line[i];
      if (ch === "'" || ch === '"') {
        const close = findStringEnd(line, i, ch);
        if (close === -1) break; // unterminated: keep the rest scannable
        i = close + 1;
        continue;
      }
      if (ch === '`') {
        const close = findTemplateEnd(line, i);
        if (close === -1) {
          inTemplate = true; // continues on the next line: keep the rest
          break;
        }
        i = close + 1;
        continue;
      }
      if (ch === '/' && line[i + 1] === '*') {
        const close = line.indexOf('*/', i + 2);
        if (close === -1) {
          blank(i, line.length);
          inBlock = true;
          break;
        }
        blank(i, close + 2);
        i = close + 2;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        // A '//' that is the tail of a '://' URL scheme is not a comment
        // start: JSX text carries URLs outside string literals.
        if (i > 0 && line[i - 1] === ':') {
          i += 2;
          continue;
        }
        blank(i, line.length);
        break;
      }
      i++;
    }
    out.push(chars.join(''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/** True when c can appear inside a path-shaped repo-doc token (the character
 *  class the old regex used, expressed as a predicate). */
function isTokenChar(c: string): boolean {
  return isWordChar(c) || c === '.' || c === '-' || c === '/';
}

/** Linear scan for the path-shaped repo-doc tokens (x/y.md ...). Produces
 *  the same tokens the old backtracking regex /\b[\w.-]+\/[\w./-]*\.md\b/g
 *  produced: for each maximal run of token characters, the match starts at
 *  the run's first word char (the regex's \b), requires a '/' before the
 *  match, and ends at the LAST '.md' followed by a non-word char (the regex's
 *  greedy tail with minimal backtrack). Linear by construction — no nested
 *  quantifiers — so a long dotted/kebab run cannot blow up scan time. */
function findPathDocTokens(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isTokenChar(text[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && isTokenChar(text[j]!)) j++;
    const run = text.slice(i, j);
    let s = 0;
    while (s < run.length && !isWordChar(run[s]!)) s++;
    if (s < run.length) {
      for (let k = run.length - 3; k >= s + 1; k--) {
        if (!run.startsWith('.md', k)) continue;
        if (k + 3 < run.length && isWordChar(run[k + 3]!)) continue;
        const slash = run.indexOf('/', s);
        if (slash > s && slash < k + 3) {
          tokens.push(run.slice(s, k + 3));
          break;
        }
      }
    }
    i = j;
  }
  return tokens;
}

/** Apply the family-union detector to the comment-blanked visible text;
 *  allowlisted shipped-doc path tokens are dropped. Returns line+token
 *  pairs. */
function scanText(text: string): Array<{ line: number; token: string }> {
  const lines = visibleText(text);
  const found: Array<{ line: number; token: string }> = [];
  const seen = new Set<string>();
  const record = (line: number, token: string) => {
    const key = `${line}:${token}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ line, token });
    }
  };
  lines.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    const family = lineText.match(FAMILY_RE);
    if (family) record(lineNo, family[0]);
    for (const token of findPathDocTokens(lineText)) {
      if (!Object.hasOwn(SHIPPED_DOCS, token)) record(lineNo, token);
    }
  });
  return found;
}

/** Recursively collect scannable files under `root`: skip test trees
 *  (*.test.*, *.spec.*, __tests__/), non-source extensions, oversized files,
 *  and the vendored weight bundles inside a public/models assembly area (see
 *  PUBLIC_MODELS_DOC_FILES). A missing root throws ENOENT (fail closed). */
function walk(root: string, out: string[] = [], assemblyArea = false): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (assemblyArea || entry.name === '__tests__') continue;
      const isModelsAssembly = entry.name === 'models' && basename(root) === 'public';
      walk(path, out, isModelsAssembly);
    } else if (entry.isFile()) {
      if (assemblyArea && !PUBLIC_MODELS_DOC_FILES.has(entry.name)) continue;
      if (/\.(test|spec)\./.test(entry.name)) continue;
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (statSync(path).size > MAX_SCAN_BYTES) continue;
      out.push(path);
    }
  }
  return out;
}

/** Scan the given roots and report hits as repo-relative
 *  `<file>:<line> <token>` records (file paths relative to `baseDir`). */
function scan(rootDirs: string[], baseDir: string): Hit[] {
  const hits: Hit[] = [];
  for (const root of rootDirs) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const { line, token } of scanText(text)) {
        hits.push({ file: relative(baseDir, file).split(sep).join('/'), line, token });
      }
    }
  }
  return hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Live-tree roots (resolved from THIS FILE, never process.cwd())
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/web_ui/src/components
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LIVE_ROOTS = [
  resolve(HERE, '..'), // <repo>/web_ui/src
  join(REPO_ROOT, 'desktop', 'main'), // the desktop main process (user-visible dialogs)
  join(REPO_ROOT, 'desktop', 'preload'), // the desktop preload bridge
  join(REPO_ROOT, 'web_ui', 'public'), // <repo>/web_ui/public
];

// ---------------------------------------------------------------------------
// The 8 files pinned by the legacy ratchet dead-doc-references-35.test.tsx
// (GUARDED_SOURCES). That spec is superseded by this file and may be deleted;
// its coverage migrates here: each path is re-pinned by planting the named
// PACKAGING-family reference into a temp copy at the same in-scope location.
// The planted forms rotate through all three family case forms.
// ---------------------------------------------------------------------------
const GUARDED_SOURCES: ReadonlyArray<{ path: string; planted: string }> = [
  {
    path: 'src/components/ModelBlockedOverlay.tsx',
    planted: 'export const note = "See PACKAGING.md for the bundled-weights policy.";\n',
  },
  {
    path: 'src/lib/llm/model-readiness.ts',
    planted: 'export const tip = "Read the packaging guide before filing a bug.";\n',
  },
  {
    path: 'src/pages/SettingsPage.tsx',
    planted: 'const help = "See the Packaging guide section on offline mirrors.";\n',
  },
  {
    path: 'src/lib/inference/InferenceModeContext.tsx',
    planted: 'export const doc = "Weights policy: PACKAGING.md.";\n',
  },
  {
    path: 'src/lib/llm/wllama-service.ts',
    planted: 'export const hint = "The model list lives in the packaging guide.";\n',
  },
  {
    path: 'src/components/IsolationBanner.tsx',
    planted: 'export const msg = "Packaging guide covers offline install.";\n',
  },
  {
    path: 'public/models/README.md',
    planted: 'The weights layout follows PACKAGING.md.\n',
  },
  {
    path: 'public/models/manifest.json',
    planted: '{ "note": "See the packaging guide for the feed." }\n',
  },
];

/** The exact eight legacy GUARDED_SOURCES paths from the deleted ratchet
 *  dead-doc-references-35.test.tsx — pinned as an INDEPENDENT literal, not
 *  derived from GUARDED_SOURCES above: removing or renaming an entry in the
 *  array under test must fail the guarded-sources leg even though the planted
 *  set and the expectation would otherwise shrink together (plan-critic
 *  round 1, AC4 tautology repair). */
const LEGACY_GUARDED_PATHS: readonly string[] = [
  'src/components/ModelBlockedOverlay.tsx',
  'src/lib/llm/model-readiness.ts',
  'src/pages/SettingsPage.tsx',
  'src/lib/inference/InferenceModeContext.tsx',
  'src/lib/llm/wllama-service.ts',
  'src/components/IsolationBanner.tsx',
  'public/models/README.md',
  'public/models/manifest.json',
];

/** Scan `content` as a single source file; convenience for the self-tests. */
function scanContent(content: string): Array<{ line: number; token: string }> {
  return scanText(content);
}

/** Materialize `files` (path -> content) under a fresh temp root and scan
 *  the mirrored live-root layout (src, public, desktop); never writes into
 *  the real tree. All three mirrored roots are created so the scan itself
 *  cannot pass vacuously from a missing root (fail-closed contract). */
function scanTempTree(files: Array<{ path: string; content: string }>): Hit[] {
  const base = mkdtempSync(join(tmpdir(), 'dead-doc-scanner-'));
  try {
    for (const rootName of ['src', 'public', 'desktop']) {
      mkdirSync(join(base, rootName), { recursive: true });
    }
    for (const { path, content } of files) {
      const target = join(base, path.split('/').join(sep));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
    return scan([join(base, 'src'), join(base, 'public'), join(base, 'desktop')], base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe('dead-doc class scanner (#260 AC2/AC3/AC4)', () => {
  it('live-tree: user-visible copy under web_ui/src, desktop/main, desktop/preload, public/ references no unshipped repo doc (family union + path shapes; comments excluded; shipped docs allowlisted)', () => {
    // Positive control (PR #261 review PRR-006): a root that silently yields
    // no scannable file must fail loudly, not pass vacuously.
    for (const root of LIVE_ROOTS) {
      const files = walk(root);
      expect(
        files.length,
        `live scan root ${relative(REPO_ROOT, root).split(sep).join('/')} yielded no scannable files (vacuous coverage)`,
      ).toBeGreaterThan(0);
    }
    const hits = scan(LIVE_ROOTS, REPO_ROOT);
    const listing = hits.map((h) => `${h.file}:${h.line} ${h.token}`).join('\n');
    expect(
      hits,
      [
        'dead-doc references in user-visible copy (expected 0 hits):',
        listing,
        `(detector = PACKAGING family UNION path-shaped .md tokens; comments excluded by the classifier;`,
        ` shipped-docs allowlist: ${Object.keys(SHIPPED_DOCS).join(', ')})`,
      ].join('\n'),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // AC4 — guarded-sources leg (-t guarded-sources)
  // -------------------------------------------------------------------------

  it('guarded-sources: a reintroduced PACKAGING-family reference in any of the 8 legacy ratchet files is flagged, and the guardrail docstring states the real scope', () => {
    // Leg 0 — the list contract: the migrated coverage equals the legacy
    // eight, pinned against an INDEPENDENT literal. A removed or renamed
    // GUARDED_SOURCES entry fails here even though the planted set below
    // would shrink with it (plan-critic round 1 AC4 tautology repair).
    expect(
      GUARDED_SOURCES.map((g) => g.path).sort(),
      'the migrated GUARDED_SOURCES list must equal the legacy eight paths exactly (independent pin)',
    ).toEqual([...LEGACY_GUARDED_PATHS].sort());

    // Leg 0b — each legacy path still exists in the live walked roots (the
    // fix deletes only the old ratchet spec, never the guarded sources).
    for (const rel of LEGACY_GUARDED_PATHS) {
      const abs = resolve(REPO_ROOT, 'web_ui', rel);
      expect(
        () => readFileSync(abs, 'utf8'),
        `legacy guarded source must still exist: web_ui/${rel}`,
      ).not.toThrow();
    }

    // Leg 1 — each migrated GUARDED_SOURCES path: the scanner flags the
    // planted family reference in the temp copy at the same in-scope
    // location (survives deletion of dead-doc-references-35.test.tsx).
    const hits = scanTempTree(GUARDED_SOURCES.map(({ path, planted }) => ({ path, content: planted })));
    const flagged = hits.map((h) => h.file).sort();
    const expected = GUARDED_SOURCES.map(({ path }) => path).sort();
    expect(
      flagged,
      `the scanner must flag a planted PACKAGING-family reference in every legacy guarded source (migrated from dead-doc-references-35.test.tsx); got: ${flagged.join(', ')}`,
    ).toEqual(expected);
    for (const hit of hits) {
      expect(
        hit.token,
        `hit on ${hit.file}:${hit.line} must be a PACKAGING-family token`,
      ).toMatch(FAMILY_RE);
    }

    // Leg 2 — the guardrail docstring states the detector's real scope:
    // family union + allowlist (correcting the old spec's "clean of the
    // class" overclaim). Read this spec's own header docstring.
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const headerEnd = own.indexOf('*/');
    expect(headerEnd, 'the spec must carry a header docstring').toBeGreaterThan(0);
    const docstring = own.slice(0, headerEnd + 2);
    expect(
      docstring,
      'the guardrail docstring must state the detector is a family union (PACKAGING family ∪ path-shaped tokens)',
    ).toMatch(/family\s+union/i);
    expect(
      docstring,
      'the guardrail docstring must state the shipped-docs allowlist',
    ).toMatch(/allowlist/i);
  });

  // -------------------------------------------------------------------------
  // AC2 — self-tests (NOT matched by the -t tokens above)
  // -------------------------------------------------------------------------

  it('a planted reference in a NEW file inside a temp root is flagged (class coverage beyond the legacy 8)', () => {
    const hits = scanTempTree([
      { path: 'src/components/BrandNewWidget.tsx', content: "const s = 'Verify against docs/updates.md.';\n" },
    ]);
    expect(hits.map((h) => `${h.file}:${h.line} ${h.token}`)).toEqual([
      'src/components/BrandNewWidget.tsx:1 docs/updates.md',
    ]);
  });

  it('comment classifier: //-leading, trailing, and block-comment interiors are not user-visible; code around comments still is', () => {
    const content = [
      '// see docs/updates.md for the old wording',
      "const url = 'https://mirror.example/feed'; // trailing comment: see docs/updates.md",
      '/**',
      ' * Design notes follow docs/design/design-language.md section 5.',
      ' */',
      'const ok = 1;',
      "/* inline note */ const s = 'docs/updates.md'; // see PACKAGING.md too",
      'const plain = "See the packaging guide";',
    ].join('\n');
    const hits = scanContent(content);
    expect(
      hits.map((h) => `${h.line} ${h.token}`),
      'line 7 must report only the code-segment docs/updates.md (the trailing PACKAGING.md is comment; lines 1-4 are all comment)',
    ).toEqual(['7 docs/updates.md', '8 packaging guide']);
  });

  it('string and template literals are user-visible copy: their contents are scanned, and their //, /* and escapes do not start comments', () => {
    // A URL's // inside a string must not mask the rest of the line (PR #261
    // review PRR-003), and a '/*' inside a string must not open a phantom
    // block comment (PRR-002 — the live DropZone.tsx:59 shape).
    expect(
      scanContent("const s = 'See https://example.com and docs/updates.md';").map((h) => h.token),
    ).toEqual(['docs/updates.md']);
    expect(
      scanContent("const s = 'https://example.com/docs/updates.md';").map((h) => h.token),
    ).toEqual(['example.com/docs/updates.md']);
    expect(
      scanContent("const s = 'it\\'s // fine'; const p = 'docs/updates.md';").map((h) => h.token),
    ).toEqual(['docs/updates.md']);
    expect(
      scanContent('const s = `see https://x docs/updates.md`;').map((h) => h.token),
    ).toEqual(['docs/updates.md']);
    // The DropZone.tsx:59 shape: a '/*' inside a string must not mask the
    // lines that follow.
    const dropzoneShape = [
      "const matches = (token: string) => { if (token.endsWith('/*')) { return true; } return false; };",
      '// filler',
      'const copy = "Drop files here or see docs/updates.md";',
      '/* eslint-disable */',
      'export default matches;',
    ].join('\n');
    expect(
      scanContent(dropzoneShape).map((h) => `${h.line} ${h.token}`),
      'a /* inside a string must not open a phantom block comment',
    ).toEqual(['3 docs/updates.md']);
    // A template literal may span lines; its interior stays scannable.
    const multiLineTemplate = [
      'const s = `see https://x',
      'docs/updates.md for the feed`;',
    ].join('\n');
    expect(
      scanContent(multiLineTemplate).map((h) => `${h.line} ${h.token}`),
    ).toEqual(['2 docs/updates.md']);
  });

  it('a pointer after a URL in JSX text is detected (the :// URL scheme is not a comment start)', () => {
    expect(
      scanContent('<p>See https://example.com and docs/updates.md</p>').map((h) => h.token),
    ).toEqual(['docs/updates.md']);
    expect(
      scanContent('<a href="https://example.com">See docs/updates.md</a>').map((h) => h.token),
    ).toEqual(['docs/updates.md']);
    // A genuine line comment after code is still excluded.
    expect(scanContent('const a = 1; // see docs/updates.md')).toEqual([]);
  });

  it('the shipped-docs allowlist entry (docs/licenses.md) passes', () => {
    const content =
      "const s = 'Model and pack licenses ship with the installer (docs/licenses.md).';\n";
    expect(scanContent(content)).toEqual([]);
    // The allowlist is exact-token: an unshipped sibling doc still fires.
    const sibling = "const t = 'See docs/updates.md and (docs/licenses.md).';\n";
    expect(scanContent(sibling).map((h) => h.token)).toEqual(['docs/updates.md']);
  });

  it('the union detector fires on both arms: path-shaped tokens and slash-less PACKAGING.md', () => {
    expect(scanContent("const a = 'see docs/updates.md';\n").map((h) => h.token)).toEqual([
      'docs/updates.md',
    ]);
    expect(scanContent("const b = 'see PACKAGING.md';\n").map((h) => h.token)).toEqual([
      'PACKAGING.md',
    ]);
    expect(scanContent('const c = "read the packaging guide";\n').map((h) => h.token)).toEqual([
      'packaging guide',
    ]);
  });

  it('the linear path-token scan matches the old backtracking regex token-for-token', () => {
    // Equivalence pin (PR #261 review PRR-005): the manual scan must produce
    // exactly the tokens the old /\b[\w.-]+\/[\w./-]*\.md\b/g produced.
    const OLD_RE = /\b[\w.-]+\/[\w./-]*\.md\b/g;
    const cases = [
      'docs/updates.md',
      'docs/design/design-language.md section 5',
      'a/b/c.md',
      'a/b.md/baz',
      'a/b.md.c/d.md',
      'docs/updates.md.bak',
      '../docs/licenses.md',
      'x/.md',
      '/x.md',
      'see https://example.com/docs/updates.md here',
      'plain text no tokens',
      'weird..dots--dashes/no-slash-suffix.md',
      'trailing docs/updates.md.',
      'node_modules/pkg/readme.md',
      'CONFIGURATION.md',
      'docs/updates.MD',
      'a' + '/b'.repeat(40) + '.md',
      'x'.repeat(200) + '.md',
      ('q/'.repeat(50) + 'end.md'),
    ];
    for (const content of cases) {
      const expected = Array.from(content.matchAll(OLD_RE), (m) => m[0]);
      expect(findPathDocTokens(content), `token equivalence for: ${content}`).toEqual(expected);
    }
    // And a long dotted/kebab run must scan in bounded time (the old regex
    // took ~76s at 320k chars; the linear scan is sub-millisecond).
    const longRun = 'a.'.repeat(160000);
    const started = Date.now();
    expect(findPathDocTokens(longRun)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('test trees (*.test.*, *.spec.*, __tests__/) are excluded from the walk', () => {
    const hits = scanTempTree([
      { path: 'src/lib/thing.test.ts', content: "const s = 'docs/updates.md';\n" },
      { path: 'src/lib/thing.spec.tsx', content: "const s = 'docs/updates.md';\n" },
      { path: 'src/__tests__/thing.ts', content: "const s = 'docs/updates.md';\n" },
      { path: 'src/lib/clean.ts', content: 'const s = 1;\n' },
    ]);
    expect(hits).toEqual([]);
  });

  it('the public/models assembly-area scoping is a named, deliberate exception: only its two tracked doc files are scanned there', () => {
    // Hermetic proof that the scoping is deliberate and tested: a third file
    // planted in a temp models assembly area is NOT scanned (the vendored
    // weight bundles are not authored copy), while the two tracked doc files
    // ARE scanned. This is a NAMED EXCEPTION, not class-complete coverage of
    // that subtree — an unguarded raw-text grep over web_ui/public is the
    // review trigger for any future tracked addition there.
    const skipped = scanTempTree([
      { path: 'public/models/weights-notes.md', content: 'weights layout follows docs/updates.md\n' },
      { path: 'public/models/embeddings/some-model/README.md', content: 'upstream card: see docs/updates.md\n' },
    ]);
    expect(skipped, 'files beyond the two tracked docs in a public/models assembly area are not scanned').toEqual([]);
    const scanned = scanTempTree([
      { path: 'public/models/README.md', content: 'The weights layout follows PACKAGING.md.\n' },
      { path: 'public/models/manifest.json', content: '{ "note": "See the packaging guide for the feed." }\n' },
    ]);
    expect(scanned.map((h) => h.file).sort()).toEqual([
      'public/models/README.md',
      'public/models/manifest.json',
    ]);
  });

  it('a missing scan root fails closed with ENOENT (a wrong cwd can never pass silently)', () => {
    const base = mkdtempSync(join(tmpdir(), 'dead-doc-closed-'));
    try {
      const missing = join(base, 'no-such-root');
      expect(() => walk(missing)).toThrow(/ENOENT/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
