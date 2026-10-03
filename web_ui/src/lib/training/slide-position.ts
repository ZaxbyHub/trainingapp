// Slide position and slide count for the Training surface (Lumen phase 6:
// "slide x of n" in the player header, the slide count on a course card).
//
// The player bridge reports only { slideId, slideTitle } (frozen protocol, see
// slide-doc-resolver.ts), so the position comes from the course's INGESTED slide
// docs: packtool writes them as `docs/slide-<n>-<slideId>.json` where <n> is the
// slide's 1-based position in the course spine (packtool/storyline/extract.ts),
// and pack ingest tags every chunk with the course's packId.
//
// Honest degradation: `null` whenever the keyword index is not ready (always the
// case in the desktop app, whose renderer never boots the browser-local index),
// the course has no slide docs, or the slide is not among them. Callers then show
// the slide title alone and omit the count; nothing is guessed.
import { getKeywordIndex } from '../search/keyword-index';

/**
 * The SAME anchored shape pack ingest uses to recognise a slide doc
 * (`isSlideDocPath` in lib/packs/pack-ingest.ts), plus capture groups for the
 * position and the slide id. Ingest stores the pack-relative path as the chunk
 * source, so the anchor matches exactly what ingest treated as a slide doc; a
 * looser pattern could count other docs. Mirrored rather than imported because
 * that predicate is module-private in the security-scoped lib/packs, which this
 * phase leaves untouched; slide-position.test.ts pins the two in sync.
 */
export const SLIDE_DOC_PATH_RE = /^docs\/slide-(\d+)-(.+)\.json$/;

/** Whether slide docs can be read at all (the browser keyword index is ready). */
export function slideDocsAvailable(): boolean {
  return getKeywordIndex().isReady();
}

/** slideId -> 1-based spine position, for one course; null when unavailable. */
function courseSlides(courseId: string): Map<string, number> | null {
  if (!courseId) return null;
  const index = getKeywordIndex();
  if (!index.isReady()) return null;
  const slides = new Map<string, number>();
  // chunkIndex 0 = exactly one hit per slide doc; no result cap.
  const hits = index.findChunks(
    (meta) => meta.packId === courseId && meta.chunkIndex === 0 && SLIDE_DOC_PATH_RE.test(meta.source ?? ''),
    Number.POSITIVE_INFINITY
  );
  for (const hit of hits) {
    const match = SLIDE_DOC_PATH_RE.exec(hit.source ?? '');
    if (match === null) continue;
    const position = Number(match[1]);
    if (Number.isInteger(position) && position > 0) slides.set(match[2], position);
  }
  return slides.size > 0 ? slides : null;
}

/** Number of slides in the course, or null when it cannot be known. */
export function courseSlideCount(courseId: string): number | null {
  return courseSlides(courseId)?.size ?? null;
}

export interface SlidePosition {
  /** 1-based position in the course. */
  index: number;
  total: number;
}

/** Where `slideId` sits in the course, or null when it cannot be known. */
export function slidePosition(courseId: string, slideId: string): SlidePosition | null {
  const slides = courseSlides(courseId);
  if (slides === null || !slideId) return null;
  const index = slides.get(slideId);
  if (index === undefined || index > slides.size) return null;
  return { index, total: slides.size };
}
