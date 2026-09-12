// Spine construction: the scene->slide index plus frame.js section titles
// (issue #77, G2).
//
// - data.js: scenes with isMessageScene === true are excluded (scene 0 carries
//   the ResumePromptSlide / ExternalInterfaceErrorSlide message slides); every
//   remaining scene contributes its slides[] in array order. The WALKED entries
//   are the document count — data.slideCount is never trusted (it coincides by
//   construction; AC2's synthetic discriminator).
// - frame.js: navData.outline.links[] top-level displaytext is the ONLY source
//   of section titles. Sub-link slideid is `_player.<sectionId>.<slideId>`;
//   the LAST component equals data.js slide.id (384/384 on the real corpus).
//   displaytext is HTML-entity-decoded (the corpus carries &amp; on 5 real
//   slides); slide titles themselves come from data.js slide.title.

import { join } from 'node:path';
import { decodeGlobalProvideData, readTextFile } from './decode.js';
import type { SpineEntry } from './types.js';

type Rec = Record<string, unknown>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#([0-9]+);/g, (m, digits: string) => {
      const code = Number.parseInt(digits, 10);
      return Number.isFinite(code) && code >= 0x20 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    })
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

function asRecord(value: unknown): Rec {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Rec;
  }
  throw new Error(`expected an object, got ${value === null ? 'null' : typeof value}`);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`expected an array, got ${typeof value}`);
}

function requireString(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`expected ${what} to be a string, got ${typeof value}`);
}

function extractMetaAttribute(metaXml: string, attribute: string): string {
  const m = new RegExp(`\\b${attribute}="([^"]*)"`).exec(metaXml);
  if (m === null || m[1] === undefined) {
    throw new Error(`meta.xml is missing the "${attribute}" attribute`);
  }
  return m[1];
}

/** Build the section map (slideId -> section title) from the frame.js payload. */
function sectionMapFromFrame(frame: unknown): Map<string, string> {
  const sections = new Map<string, string>();
  const navData = asRecord(asRecord(frame)['navData']);
  const outline = asRecord(navData['outline']);
  const topLinks = asArray(outline['links']);
  for (const topLink of topLinks) {
    const top = asRecord(topLink);
    const sectionTitle = decodeHtmlEntities(requireString(top['displaytext'], 'outline link displaytext'));
    for (const subLink of asArray(top['links'] ?? [])) {
      const sub = asRecord(subLink);
      const slideid = requireString(sub['slideid'], 'outline sub-link slideid');
      const parts = slideid.split('.');
      const slideId = parts[parts.length - 1];
      if (slideId !== undefined && slideId.length > 0) sections.set(slideId, sectionTitle);
    }
  }
  return sections;
}

export interface Spine {
  course: string;
  duration: string;
  slides: SpineEntry[];
  /** Ordered section titles with walked per-section slide counts. */
  sections: Array<{ title: string; slide_count: number }>;
}

export function buildSpine(publishDir: string): Spine {
  const metaXml = readTextFile(join(publishDir, 'meta.xml'));
  const course = extractMetaAttribute(metaXml, 'title');
  const duration = extractMetaAttribute(metaXml, 'duration');

  const data = asRecord(decodeGlobalProvideData('data', readTextFile(join(publishDir, 'html5', 'data', 'js', 'data.js'))));
  const frame = asRecord(decodeGlobalProvideData('frame', readTextFile(join(publishDir, 'html5', 'data', 'js', 'frame.js'))));
  const sectionsBySlideId = sectionMapFromFrame(frame);

  const scenes = asArray(data['scenes']);
  const slides: SpineEntry[] = [];
  const sectionCounts = new Map<string, number>();
  for (const scene of scenes) {
    const sc = asRecord(scene);
    if (sc['isMessageScene'] === true) continue;
    const sceneNumber = sc['sceneNumber'];
    for (const slideEntry of asArray(sc['slides'])) {
      const sl = asRecord(slideEntry);
      const slideId = requireString(sl['id'], 'slide id');
      const html5url = requireString(sl['html5url'], `slide ${slideId} html5url`);
      const sectionTitle = sectionsBySlideId.get(slideId) ?? '';
      slides.push({
        slideId,
        slideTitle: requireString(sl['title'], `slide ${slideId} title`),
        sceneNumber: typeof sceneNumber === 'number' ? sceneNumber : 0,
        slideNumberInScene:
          typeof sl['slideNumberInScene'] === 'number' ? (sl['slideNumberInScene'] as number) : 0,
        html5url,
        sectionTitle,
      });
      if (sectionTitle !== '') {
        sectionCounts.set(sectionTitle, (sectionCounts.get(sectionTitle) ?? 0) + 1);
      }
    }
  }

  // Sections keep frame.js outline order with walked counts.
  const sections: Array<{ title: string; slide_count: number }> = [];
  for (const title of sectionsBySlideId.values()) {
    if (!sections.some((s) => s.title === title)) {
      sections.push({ title, slide_count: sectionCounts.get(title) ?? 0 });
    }
  }

  return { course, duration, slides, sections };
}
