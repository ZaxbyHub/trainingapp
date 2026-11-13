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

// Issue #324 AC3 (decision requested on #281, comment 6857107430): the
// SIX-CODE-POINT enumeration below is the normative Default_Ignorable
// contract — NOT the full Unicode property. The property adds directional
// marks (U+200E/U+200F), bidi controls (U+202A-202E, U+2066-2069), variation
// selectors (U+FE00-FE0F) and U+034F whose removal has no demonstrated
// lexical-search benefit; the twins and the vector corpus all pin this
// enumeration.
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
