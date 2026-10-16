// embed-seam-contract.test.ts — executable contract between the desktop
// embed seam (main/backend/ingest/embed-threads.ts) and packtool's build
// embedder session literal (packtool/build/embedder.ts), issue #211.
//
// The two mechanisms have opposite defaults by design (packtool pins 1
// thread for its reproducible-build contract; desktop is default-OFF for
// cost), so their knob values are duplicated across a package boundary that
// cannot share source. These pins make that duplication executable: the
// values must agree, the seam's mapping must stay fixed at n=1 and n=2, the
// createPipeline call site must keep using the named constant, and both
// file headers must state the divergence (scoped claims only). Changing
// either side without reconciling the other goes red here.

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

describe('packtool-drift', () => {
  it('pins the seam 1-thread output and the packtool constant to the frozen literal', () => {
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1' })).toEqual(FROZEN_ONE_THREAD);
    expect(PACK_EMBED_SESSION_OPTIONS).toEqual(FROZEN_ONE_THREAD);
  });

  it('pins the seam n=2 mapping (interOp stays 1, sequential)', () => {
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '2' })).toEqual(FROZEN_TWO_THREAD);
  });

  it("keeps packtool's pinned options equal to the seam output at 1 thread", () => {
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1' })).toEqual(PACK_EMBED_SESSION_OPTIONS);
  });

  it("keeps packtool's createPipeline call site on the named constant", () => {
    const source = fs.readFileSync(PACKTOOL_EMBEDDER_SOURCE, 'utf8');
    expect(source, 'packtool must pass session_options from PACK_EMBED_SESSION_OPTIONS, not an inline literal')
      .toMatch(/\bsession_options:\s*PACK_EMBED_SESSION_OPTIONS\b/);
  });
});

describe('shared-definition-claim', () => {
  it("scopes the seam header claim and names packtool's pinned divergence", () => {
    const header = readLeadingComment(SEAM_SOURCE);
    expect(header, 'the seam header must name packtool (the coverage outside its claim)').toMatch(/packtool/i);
    expect(header, 'the seam header must cite the drift pin').toMatch(/drift[- ]?(pin|guard)/i);
    for (const line of header.split('\n')) {
      if (/ONE shared definition/i.test(line)) {
        expect(
          line,
          'every ONE-shared-definition line must carry its scope qualifier on the same line',
        ).toMatch(/desktop|retrieval/i);
      }
    }
  });

  it("pins packtool's header divergence declaration to the seam", () => {
    const header = readLeadingComment(PACKTOOL_EMBEDDER_SOURCE);
    expect(header, "packtool's header must name the desktop seam it deliberately diverges from").toMatch(
      /embed-threads|embed seam|desktop.*seam/i,
    );
    expect(header, "packtool's header must cite the drift pin").toMatch(/drift[- ]?(pin|guard)/i);
  });
});

describe('default-off-contract', () => {
  it('returns undefined for unset, empty, zero, and junk env', () => {
    expect(embedSessionOptions({})).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '0' })).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: 'abc' })).toBeUndefined();
  });
});
