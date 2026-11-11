/**
 * Search normalization for the derived lexical mirror (issue #281, Workstream E).
 *
 * One table-driven contract, twin-tested by contracts/text-normalization-vectors.json
 * in all four runtimes (desktop, web_ui, packtool, python) and applied at every
 * chunks_fts write site, in sanitizeFtsQuery, and in the browser keyword index.
 *
 * This function NEVER touches chunk identity: chunks.text, chunk ids and
 * content_hash stay byte-identical (ADR-0004); only the derived lexical text and
 * the query are normalized. Schema v5 rebuilds chunks_fts from chunks.text through
 * this function on first open after the upgrade.
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
  return out.replace(/\s+/g, ' ').trim();
}
