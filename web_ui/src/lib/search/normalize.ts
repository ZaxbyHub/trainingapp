/**
 * Search normalization for the keyword index (issue #281, Workstream E).
 *
 * Twin of desktop/main/backend/ingest/normalize.ts — one table-driven contract,
 * twin-tested by contracts/text-normalization-vectors.json in all four runtimes.
 * Wraps every index.add call site (ingest + rebuildFromEntries) and search so a
 * document whose extracted text carries Word optional hyphens, zero-width
 * characters, ligatures or fullwidth forms is found by the plain query a user
 * types. Persisted entries keep raw text (no IndexedDB version bump);
 * rebuildFromEntries re-normalizes on every load.
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
