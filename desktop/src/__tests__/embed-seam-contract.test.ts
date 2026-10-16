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
import { embedSessionOptions } from '../../main/backend/ingest/embed-threads.js';
import { PACK_EMBED_SESSION_OPTIONS } from '../../../packtool/build/embedder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// desktop/src/__tests__ -> desktop -> repo root
const REPO_ROOT = path.resolve(here, '..', '..', '..');
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
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '2' })).toEqual(FROZEN_TWO_THREAD);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '3' })).toEqual({
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
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: ' 2 ' })).toEqual(FROZEN_TWO_THREAD);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '007' })).toEqual({
      intraOpNumThreads: 7,
      interOpNumThreads: 1,
      executionMode: 'sequential',
    });
  });
});
