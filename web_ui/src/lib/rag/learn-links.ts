// learn-links.ts — linked Learn rows for the browser app (trace
// browser-training-parity AC6, plan step 8).
//
// Desktop assembles "linked" Learn rows from the #80 links table: for every
// cited (non-slide) document chunk, its top-3 training slides by cosine
// similarity above a 0.5 floor (desktop/main/backend/store/links.ts,
// DEFAULT_LINKS_COSINE_THRESHOLD / LINKS_TOP_K). The browser has no SQLite
// links table, so it computes the same relation at ask time: each cited
// chunk is embedded with the browser model and the vector index is searched
// for the nearest INSTALLED-PACK slide chunks. Same floor, same top-k, same
// kernel offer/dedup rules afterwards (learn-kernel.ts). The browser embeds
// with its own model, so scores are on that model's scale (ADR-0012).
import type { SearchResult } from '../../types/search';
import { parseMarker, slideIdFromName, type LinkedSlide } from './learn-kernel';

/** Mirror of desktop DEFAULT_LINKS_COSINE_THRESHOLD. */
export const LINKS_COSINE_THRESHOLD = 0.5;
/** Mirror of desktop LINKS_TOP_K. */
export const LINKS_TOP_K = 3;
/** Neighbours fetched per cited chunk before keeping the top slide hits. */
const SEARCH_K = 24;
/** Ask-time budget: linked rows are best-effort and never delay the answer long. */
export const LINKS_TIME_BUDGET_MS = 4000;

export interface LinkDeps {
  encodeBatch(texts: string[]): Promise<ArrayLike<number>[]>;
  search(vector: ArrayLike<number>, k: number): Promise<SearchResult[]>;
}

const SNIPPET_MAX_CHARS = 120;

function snippetOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const body = text.includes('\n') ? text.slice(text.indexOf('\n') + 1).trim() : '';
  return body.length > 0 ? body.slice(0, SNIPPET_MAX_CHARS) : undefined;
}

/** Top-3 linked pack slides (score > floor) of every cited non-slide chunk. */
export async function computeLinkedSlides(cited: SearchResult[], deps: LinkDeps): Promise<LinkedSlide[]> {
  const sources = cited.filter((chunk) => slideIdFromName(chunk.source) === null && (chunk.text ?? '').trim() !== '');
  if (sources.length === 0) return [];
  const vectors = await deps.encodeBatch(sources.map((chunk) => chunk.text ?? ''));
  const links: LinkedSlide[] = [];
  for (const vector of vectors) {
    const hits = await deps.search(vector, SEARCH_K);
    const slides = hits
      .filter((hit) => hit.packId !== undefined && slideIdFromName(hit.source) !== null && hit.score > LINKS_COSINE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, LINKS_TOP_K);
    for (const hit of slides) {
      const { section, title } = parseMarker(hit.text);
      const snippet = snippetOf(hit.text);
      links.push({
        slide_id: slideIdFromName(hit.source)!,
        score: hit.score,
        ...(title !== null ? { title } : {}),
        ...(section !== null ? { section } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
        ...(hit.packId !== undefined ? { pack_id: hit.packId } : {}),
      });
    }
  }
  return links;
}

/** computeLinkedSlides under a time budget; any failure or timeout yields no linked rows. */
export async function linkedSlidesWithin(cited: SearchResult[], deps: LinkDeps, budgetMs = LINKS_TIME_BUDGET_MS): Promise<LinkedSlide[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LinkedSlide[]>((resolve) => {
    timer = setTimeout(() => resolve([]), budgetMs);
  });
  try {
    return await Promise.race([computeLinkedSlides(cited, deps).catch(() => []), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
