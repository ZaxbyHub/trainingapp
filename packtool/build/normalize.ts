/**
 * Search normalization for the derived lexical mirror (issue #281, Workstream E).
 *
 * Twin of desktop/main/backend/ingest/normalize.ts — one table-driven contract,
 * twin-tested by contracts/text-normalization-vectors.json in all four runtimes.
 * Applied in packtool's chunks_fts writer (build) and verbatim-row composer
 * (compose normalizes rows copied from packs built by older packtool).
 *
 * This function NEVER touches chunk identity: chunks.text, chunk ids and
 * content_hash stay byte-identical (ADR-0004).
 */

const DEFAULT_IGNORABLES = /[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const SINGLE_QUOTES = /[\u2018\u2019]/g;
const DOUBLE_QUOTES = /[\u201C\u201D]/g;
const ELLIPSIS = /\u2026/g;

export function normalizeForSearch(text: string): string {
  let out = text.normalize('NFKC').replace(DEFAULT_IGNORABLES, '');
  out = out.replace(DASHES, '-');
  out = out.replace(SINGLE_QUOTES, "'");
  out = out.replace(DOUBLE_QUOTES, '"');
  out = out.replace(ELLIPSIS, '...');
  // Explicit JS-whitespace set (python str \s ALSO matches U+0085 and
  // U+001C-1F, which this set does not) - the shared explicit class keeps
  // both twins byte-identical on every input (impl-review r1 parity question).
  return out.replace(/[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
}
