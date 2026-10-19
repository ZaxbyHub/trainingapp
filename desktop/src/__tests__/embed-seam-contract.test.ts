// embed-seam-contract.test.ts — executable contract between the desktop
// embed seam (main/backend/ingest/embed-threads.ts) and packtool's build
// embedder session literal (packtool/build/embedder.ts), issue #211.
//
// The two mechanisms have opposite defaults by design (packtool pins 1
// thread for its reproducible-build contract; desktop is default-OFF for
// cost), so their knob values are duplicated across a package boundary that
// cannot share source. These pins make that duplication executable: the
// values must agree, the seam's mapping must stay fixed, every session
// construction site must bind the seam-derived options (never an inline
// literal), both file headers must state the divergence as a scoped claim,
// and the seam's parsing contract stays default-OFF. Rewording the claim,
// re-inlining a literal, or deleting the divergence declaration goes red.
//
// Coverage note: this spec is validated by vitest at runtime only —
// desktop/tsconfig.json includes main/** only, so no tsc project compiles
// src/__tests__. The cross-package import of packtool source is intentional
// (the pin must bind the real production module) and matches the
// browser-pack-schema-drift.test.ts precedent.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  embedSessionOptions,
  seamEnvRecord,
} from '../../main/backend/ingest/embed-threads.js';
import { PACK_EMBED_SESSION_OPTIONS } from '../../../packtool/build/embedder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Marker-walk root resolution (issue #215 AC14, the 43-sibling convention):
// walk up to the repo root by probing a real marker, with an explicit
// diagnosable failure — never a fixed-depth path.resolve (moving this spec
// one directory deeper would silently re-point its source reads).
function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    // Review PRR-024/UCR-04: stop at the checkout root — a marker-less
    // checkout must fail closed, never bind a foreign ancestor's marker.
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}
const REPO_ROOT = findRepoRoot(here);
const SEAM_SOURCE = path.join(REPO_ROOT, 'desktop', 'main', 'backend', 'ingest', 'embed-threads.ts');
const PACKTOOL_EMBEDDER_SOURCE = path.join(REPO_ROOT, 'packtool', 'build', 'embedder.ts');
const DESKTOP_BACKEND_DIR = path.join(REPO_ROOT, 'desktop', 'main', 'backend');
const PIN_PATH = 'desktop/src/__tests__/embed-seam-contract.test.ts';

const FROZEN_ONE_THREAD = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: 'sequential',
} as const;
const FROZEN_TWO_THREAD = {
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  executionMode: 'sequential',
} as const;

/** Leading // comment block of a source file (its contract header). */
function readLeadingComment(file: string): string {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('//') || line.trim() === '') {
      out.push(line);
      continue;
    }
    break;
  }
  return out.join('\n');
}

/** Source with comments stripped — pins must not be satisfiable by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('packtool-drift', () => {
  it('pins the seam outputs and the packtool constant to the frozen literals', () => {
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1' })).toEqual(FROZEN_ONE_THREAD);
    expect(PACK_EMBED_SESSION_OPTIONS).toEqual(FROZEN_ONE_THREAD);
    // The AC1 "the two must match" relation, stated directly: the seam output
    // at 1 thread and packtool's pinned options are the same value.
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1' })).toEqual(PACK_EMBED_SESSION_OPTIONS);
  });

  it('pins the seam mapping at n=2 and n=3 (interOp stays 1, sequential)', () => {
    // Explicit coreCount (issue #204 AC6): the seam clamps to the host's
    // parallelism, so the mapping pin injects a fixed coreCount — otherwise
    // these rows would fail on a 1–2 core host.
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '2' }, 8)).toEqual(FROZEN_TWO_THREAD);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '3' }, 8)).toEqual({
      intraOpNumThreads: 3,
      interOpNumThreads: 1,
      executionMode: 'sequential',
    });
  });

  it("keeps packtool's createPipeline call site on the named constant", () => {
    const stripped = stripComments(fs.readFileSync(PACKTOOL_EMBEDDER_SOURCE, 'utf8'));
    expect(stripped, 'no inline session_options object literal may appear in packtool code').not.toMatch(
      /session_options\s*:\s*\{/,
    );
    expect(
      stripped,
      'the createPipeline feature-extraction call must pass session_options from PACK_EMBED_SESSION_OPTIONS',
    ).toMatch(/createPipeline\('feature-extraction'[\s\S]{0,600}?session_options:\s*PACK_EMBED_SESSION_OPTIONS\b/);
    expect(stripped).toMatch(/\bsession_options:\s*PACK_EMBED_SESSION_OPTIONS\b/);
  });

  it('pins every desktop session construction site to the seam (default-OFF shape)', () => {
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(DESKTOP_BACKEND_DIR)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (rel === 'desktop/main/backend/ingest/embed-threads.ts') continue;
      const lines = stripComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/);
      // Per-usage binding: each `session_options: sessionOptions` must be
      // backed by the NEAREST preceding declaration being a real seam call,
      // and the default-OFF omit-key guard must appear between them.
      let declLine = -1;
      let declIsSeam = false;
      lines.forEach((line, index) => {
        // Declaration state first — and do NOT return: a line may join a
        // declaration and a usage in one statement sequence, and such a line
        // is exactly where an inline literal would hide.
        if (/\b(?:const|let)\s+sessionOptions\s*=/.test(line)) {
          declLine = index;
          // The binding must be a bare seam call statement — a `?? fallback`
          // or other wrapping expression would silently defeat default-OFF.
          declIsSeam = /\b(?:const|let)\s+sessionOptions\s*=\s*embedSessionOptions\([^)]*\)\s*;/.test(line);
        }
        if (/session_options\s*\?/.test(line)) return; // structural type declaration
        if (/session_options\s*:\s*sessionOptions\b/.test(line)) {
          if (!declIsSeam) {
            offenders.push(`${rel}:${index + 1}: session_options bound from a non-seam sessionOptions declaration`);
            return;
          }
          const segment = lines.slice(declLine, index + 1).join('\n');
          if (!/sessionOptions\s*===\s*undefined/.test(segment)) {
            offenders.push(`${rel}:${index + 1}: session_options usage lacks the default-OFF omit-key guard`);
          }
          return;
        }
        if (line.includes('session_options')) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'every session_options usage outside the seam must bind the seam-derived sessionOptions behind the default-OFF guard (no inline literals; no unbound site)',
    ).toEqual([]);
  });
});

describe('shared-definition-claim', () => {
  it('scopes the seam header claim, names packtool, and cites the real pin path', () => {
    const header = readLeadingComment(SEAM_SOURCE);
    expect(header, 'the seam header must name packtool (the coverage outside its claim)').toMatch(/packtool/i);
    expect(header, 'the seam header must cite the drift pin').toMatch(/drift[- ]?(pin|guard)/i);
    expect(header, `the seam header must cite the pin at its repo-relative path ${PIN_PATH}`).toContain(PIN_PATH);

    // The canonical claim phrase must exist (the named AC2 mutant class: any
    // scope change to the claim must touch this pin), and every
    // one/single/only ... definition phrasing must be scoped by ITS OWN
    // complement — the noun phrase up to the next punctuation (one immediate
    // parenthetical may carry the qualifier), not later prose in the header.
    expect(header, 'the canonical shared-definition claim must remain present').toContain('ONE shared definition');
    const joined = header.split(/\r?\n/).join(' ');
    const claimPattern = /\b(?:ONE|single|only)\s+(?:shared\s+)?definition\b/gi;
    const matches = [...joined.matchAll(claimPattern)];
    expect(matches.length, 'the seam header must contain exactly one shared-definition claim').toBeGreaterThan(0);
    for (const match of matches) {
      const after = joined.slice(match.index + match[0].length);
      let cut = after.search(/[.,;(]/);
      if (cut >= 0 && cut <= 5 && after[cut] === '(') {
        const close = after.indexOf(')', cut);
        if (close !== -1) cut = close + 1;
      } else if (cut >= 0 && cut <= 5 && after[cut] === ',') {
        // Comma-apposed qualifier ("..., desktop retrieval session knobs"):
        // continue the complement past one immediate comma.
        const rest = after.slice(cut + 1);
        const next = rest.search(/[.;(]/);
        cut = next === -1 ? after.length : cut + 1 + next;
      }
      const complement = after.slice(0, cut === -1 ? after.length : cut);
      expect(
        complement,
        'every shared-definition claim must be scoped by its own complement (desktop/retrieval)',
      ).toMatch(/desktop|retrieval/i);
      const before = joined.slice(Math.max(0, match.index - 30), match.index);
      expect(
        before + match[0],
        'a negated or explicitly-unscoped claim must not satisfy the scope pin',
      ).not.toMatch(/\b(?:NOT|never|unscoped|intentionally)\b/i);
    }
  });

  it("pins packtool's divergence declaration and its qualified mirroring claim", () => {
    const whole = fs.readFileSync(PACKTOOL_EMBEDDER_SOURCE, 'utf8');
    expect(whole, "packtool's divergence-rationale block must state the deliberate non-import").toMatch(
      /deliberately NOT imported/,
    );
    expect(whole, "packtool's divergence-rationale block must cite the reproducible-build contract").toMatch(
      /reproducible-build/,
    );
    expect(whole, "packtool's divergence-rationale block must name the goes-red tie").toMatch(/goes red/);
    const header = readLeadingComment(PACKTOOL_EMBEDDER_SOURCE);
    expect(header, "packtool's header must name the desktop seam it deliberately diverges from").toMatch(
      /embed-threads|embed seam|desktop.*seam/i,
    );
    expect(header, "packtool's header must cite the drift pin").toMatch(/drift[- ]?(pin|guard)/i);
    expect(header, "packtool's mirroring claim must keep its not-by-construction qualification").toMatch(
      /not by construction/i,
    );
  });
});

describe('default-off-contract', () => {
  it('returns undefined for unset, empty, zero, junk, negative, float, and unsafe-integer env', () => {
    expect(embedSessionOptions({})).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '0' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: 'abc' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '-1' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1.5' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '9'.repeat(400) })).toBeUndefined();
  });

  it('trims and accepts normalized digit forms (the seam parser contract)', () => {
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: ' 2 ' }, 8)).toEqual(FROZEN_TWO_THREAD);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '007' }, 8)).toEqual({
      intraOpNumThreads: 7,
      interOpNumThreads: 1,
      executionMode: 'sequential',
    });
  });
});

describe('session-call-sites (issue #204)', () => {
  it('session-options-call-sites: every desktop session site binds the seam behind the default-OFF guard', () => {
    // Positive presence pin (issue #204 AC5): each named call site must bind
    // sessionOptions from a bare embedSessionOptions(...) call (single-token
    // args, so the declaration regex above keeps its pin power) and guard with
    // sessionOptions === undefined before omitting the key. The forbidden
    // shape (session_options: undefined / inline literals) stays pinned by the
    // packtool-drift row above; this row polices the DROP-THE-SEAM half.
    // Named mutant: delete the seam binding at rerank-worker.ts (one of its
    // two sites) — this row must go red.
    const sites: Array<[string, string, number]> = [
      ['desktop/main/backend/ingest/embedder.ts', 'embedSessionOptions(this.env)', 1],
      ['desktop/main/backend/retrieval/rerank-worker.ts', 'embedSessionOptions(seamEnv)', 2],
    ];
    for (const [rel, call, expected] of sites) {
      const stripped = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      const occurrences = stripped.split(call).length - 1;
      expect(occurrences, `${rel} must bind the seam exactly ${expected}x via ${call}`).toBe(expected);
      // Per-site, not per-file (review PRR-020): rerank-worker.ts carries two
      // call sites, so a file-wide toContain stays green when one of the two
      // guards is deleted. One omit-key guard per pinned call site.
      const guards = stripped.split('sessionOptions === undefined').length - 1;
      expect(
        guards,
        `${rel} must keep the default-OFF omit-key guard at each of its ${expected} seam call sites`,
      ).toBe(expected);
    }
  });

  it('env-record-merge: a partial injected record keeps ambient pins (review PRR-011)', () => {
    // The seam resolves its env via seamEnvRecord: injected STRING values win
    // per key, omitted/undefined keys keep ambient values. Whole-record
    // substitution dropped the ambient thread pin whenever a host injected a
    // partial record. Named mutant: restore `workerData.env ?? process.env`
    // (or `opts.env ?? process.env`) and this row must go red.
    const KEY = 'TRAININGAPP_TEST_PRR011_AMBIENT';
    const saved = process.env[KEY];
    try {
      process.env[KEY] = 'ambient';
      expect(seamEnvRecord({ OTHER: 'injected' })[KEY], 'omitted keys keep ambient').toBe('ambient');
      expect(seamEnvRecord({ [KEY]: 'injected' })[KEY], 'injected strings win per key').toBe(
        'injected',
      );
      expect(
        seamEnvRecord({ [KEY]: undefined })[KEY],
        'an undefined injected value never erases the ambient pin',
      ).toBe('ambient');
      expect(seamEnvRecord(null)[KEY], 'no injection falls back to ambient').toBe('ambient');
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
    // Both PR-introduced seam bindings must resolve their record through the
    // merge helper (call-form pin, comment-stripped).
    const strip = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(
      strip(fs.readFileSync(path.join(REPO_ROOT, 'desktop/main/backend/retrieval/rerank-worker.ts'), 'utf8')),
      'the rerank worker must merge the injected record',
    ).toContain('seamEnvRecord(');
    expect(
      strip(fs.readFileSync(path.join(REPO_ROOT, 'desktop/main/backend/ingest/embedder.ts'), 'utf8')),
      'resolveEmbedder must merge the injected record',
    ).toContain('seamEnvRecord(opts.env)');
  });

  it('env-injection: the seam reads the injected host record, never ambient process.env', () => {
    // Issue #204 AC7. Named mutant: restore the ambient read
    // (embedSessionOptions()) at embedder.ts:122 — this row must go red.
    // Raw-source matching (comment-tolerant patterns): index.ts carries
    // strings with `/*` globs, which defeat naive block-comment stripping.
    const stripLine = (rel: string): string =>
      fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\/\/[^\n]*/g, '');
    const embedder = stripLine('desktop/main/backend/ingest/embedder.ts');
    expect(embedder, 'the embedder seam call must take the injected env record').toContain(
      'embedSessionOptions(this.env)',
    );
    expect(embedder, 'no ambient seam read may remain in the embedder').not.toMatch(/embedSessionOptions\(\s*\)/);
    expect(embedder, 'resolveEmbedder must pass the resolved env record to OnnxEmbedder').toContain(
      'new OnnxEmbedder(staged, env)',
    );
    // Review PRR-012: a bare one-arg construction silently reads ambient
    // env — the pin must ban the shape, not just require the two-arg one.
    expect(
      embedder,
      'bare one-arg OnnxEmbedder constructions read ambient env and must not appear',
    ).not.toMatch(/new OnnxEmbedder\([^,()]+\)/);

    const worker = stripLine('desktop/main/backend/retrieval/rerank-worker.ts');
    expect(worker, 'the worker seam calls must take the injected workerData env record').toContain(
      'embedSessionOptions(seamEnv)',
    );
    expect(worker, 'no ambient seam read may remain in the worker').not.toMatch(/embedSessionOptions\(\s*\)/);

    const reranker = stripLine('desktop/main/backend/retrieval/reranker.ts');
    expect(reranker, 'WorkerReranker must forward the injected record through workerData').toMatch(
      /env:\s*this\.env\s*\?\?\s*null/,
    );

    const index = fs.readFileSync(path.join(REPO_ROOT, 'desktop/main/backend/index.ts'), 'utf8');
    expect(index, 'the host must inject config.env into the reranker options').toMatch(
      /new ResumableReranker\(\{[\s\S]{0,400}?\benv,/,
    );
  });
});
