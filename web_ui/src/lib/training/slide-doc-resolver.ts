// Slide-document resolver for the pinned-slide context (issue #83, D7).
//
// The player bridge (D5) reports only { slideId, slideTitle } — its postMessage
// protocol is frozen (desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md §5)
// and the Storyline runtime exposes no section variable. Section and on-screen
// text therefore resolve renderer-side from the SAME ingested slide docs the
// Learn kernel parses: chunks whose source filename matches
// `docs/slide-<n>-<slideId>.json` and whose first line carries the
// `[training-slide] section=… | title=… | slide_id=…` marker.
//
// Degradation contract: `null` whenever the index is not ready or no chunk
// matches — the caller (App) falls back to a title-only pin rather than
// guessing. Resolution happens ONCE per slidechange, not per query.
import { getKeywordIndex } from '../search/keyword-index';
import { parseMarker, slideIdFromName } from '../rag/learn-kernel';

/** Hard cap on injected on-screen text (budget is charged downstream in
 *  rag-orchestrator's computeReservedTokens; the cap keeps a single pin from
 *  starving retrieval even before the charge applies). */
export const MAX_SLIDE_TEXT_CHARS = 2000;

export interface ResolvedSlideDoc {
  section?: string;
  text?: string;
}

/**
 * Find the indexed chunk for `slideId` and extract its section + on-screen
 * text. Synchronous: the keyword index mapping is in-memory once initialized.
 */
export function resolveSlideDoc(slideId: string): ResolvedSlideDoc | null {
  if (!slideId) return null;
  const keywordIndex = getKeywordIndex();
  if (!keywordIndex.isReady()) return null;

  const chunk = keywordIndex
    .findChunks((meta) => slideIdFromName(meta.source) === slideId, 1)
    .find((c) => (c.text ?? '').length > 0);
  if (!chunk) return null;

  const text = chunk.text ?? '';
  const firstLine = text.split('\n', 1)[0].trim();
  // Only trust chunks whose first line IS the marker — a continuation chunk
  // whose source filename matches but whose body has no marker would still
  // carry the slide's text; prefer the marker chunk, fall back to raw text.
  const marker = parseMarker(firstLine);
  let body = text;
  if (marker.section !== null || marker.title !== null) {
    body = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
  }
  const trimmedBody = body.trim();
  return {
    ...(marker.section ? { section: marker.section } : {}),
    ...(trimmedBody.length > 0
      ? { text: trimmedBody.slice(0, MAX_SLIDE_TEXT_CHARS) }
      : {}),
  };
}
