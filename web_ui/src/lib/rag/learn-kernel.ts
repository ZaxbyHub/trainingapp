// Learn-panel result assembly, browser surface (issue #82 / D6).
//
// Mirrors learn_panel.py and desktop/main/backend/learn.ts (the D4 precedent
// of mirrored kernels with mirrored golden tests) — keep the three in
// lockstep: union of direct training-slide hits and linked slides of the
// cited chunks, deduped by slide_id keeping the highest score (direct
// preferred on ties), ranked descending, capped at MAX_LEARN_RESULTS.
//
// The browser path has no links store (packs on this surface are #76, an
// open ADR) and no grounding field yet (#72, contract-reserved): the kernel
// takes both as optional inputs so the browser behavior is exactly the
// documented divergence of the shared algorithm.
import type { LearnResult } from '../api/types';
import type { SearchResult } from '../../types/search';

export const MAX_LEARN_RESULTS = 5;

const SNIPPET_MAX_CHARS = 120;

// Storyline slide docs are named docs/slide-<digits>-<slide_id>.json; the
// browser store carries only the filename (SearchResult.source), so
// detection matches the basename.
const SLIDE_NAME_RE = /slide-\d+-(.+)\.json$/i;

const MARKER_RE = /^\[training-slide\] section=(.*) \| title=(.*) \| slide_id=(\S+)\s*$/;

export function slideIdFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const match = SLIDE_NAME_RE.exec(base);
  return match === null ? null : (match[1] ?? null);
}

/**
 * Parse the `[training-slide] section=… | title=… | slide_id=…` marker line.
 *
 * D7 (issue #83): deliberately exported (previously module-private) so the
 * pinned-slide resolver (`lib/training/slide-doc-resolver.ts`) reuses the
 * EXACT marker grammar `buildLearnResults` already parses — a second copy of
 * the regex would drift the same way the mirrored kernels guard against.
 */
export function parseMarker(text: string | null | undefined): { section: string | null; title: string | null } {
  if (!text) return { section: null, title: null };
  const firstLine = text.split('\n', 1)[0].trim();
  const match = MARKER_RE.exec(firstLine);
  if (match === null) return { section: null, title: null };
  return { section: match[1] ?? null, title: match[2] ?? null };
}

function snippetAfterMarker(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  let body = text;
  const firstLine = body.split('\n', 1)[0].trim();
  if (MARKER_RE.test(firstLine)) {
    const rest = body.includes('\n') ? body.slice(body.indexOf('\n') + 1) : '';
    body = rest;
  }
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, SNIPPET_MAX_CHARS);
}

export interface BuildLearnOptions {
  /** #72 provenance value when present; "general" suppresses all results. */
  grounding?: string | null;
  maxResults?: number;
}

export function buildLearnResults(chunks: SearchResult[], options: BuildLearnOptions = {}): LearnResult[] {
  if (options.grounding === 'general') return [];
  const maxResults = options.maxResults ?? MAX_LEARN_RESULTS;

  const best = new Map<string, LearnResult>();
  const offer = (row: LearnResult): void => {
    const current = best.get(row.slide_id);
    const prefer =
      current === undefined ||
      row.score > current.score ||
      (row.score === current.score && row.reason === 'direct' && current.reason !== 'direct');
    if (prefer) {
      if (current !== undefined && row.snippet === undefined && current.snippet !== undefined) {
        row.snippet = current.snippet;
      }
      best.set(row.slide_id, row);
    }
  };

  for (const chunk of chunks) {
    const slideId = slideIdFromName(chunk.source);
    if (slideId === null) continue;
    const { section, title } = parseMarker(chunk.text);
    const snippet = snippetAfterMarker(chunk.text);
    offer({
      slide_id: slideId,
      title: title ?? slideId,
      section: section ?? '',
      score: chunk.score,
      reason: 'direct',
      ...(snippet !== undefined ? { snippet } : {}),
    });
    // Linked results need the #80 links store, which the browser surface
    // does not have (documented divergence; #76 owns browser pack support).
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
}
