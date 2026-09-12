// Document assembly: publish folder -> per-slide SlideDocs + one OutlineDoc
// (issue #77, G5). Serialization key order here is normative: the golden
// fixture files (tests/fixtures/storyline-mini/expected/) are compared
// byte-for-byte.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeGlobalProvideData, readTextFile } from './decode.js';
import { buildSpine } from './spine.js';
import type { OutlineDoc, SlideDoc } from './types.js';
import { resolveVideoRefs } from './video-refs.js';
import { walkSlideText } from './walk.js';

const SLIDE_NNN_PAD = 3;

export function extractPublishDir(publishDir: string, outDir: string): void {
  const spine = buildSpine(publishDir);

  const slidesDir = join(outDir, 'slides');
  mkdirSync(slidesDir, { recursive: true });

  const docs: SlideDoc[] = [];
  spine.slides.forEach((entry, index) => {
    const slidePath = join(publishDir, ...entry.html5url.split('/'));
    const payload = decodeGlobalProvideData('slide', readTextFile(slidePath));
    const { onScreenText, textChars } = walkSlideText(payload as object);
    const videoRefs = resolveVideoRefs(payload as object, publishDir);

    const sourceFiles = ['meta.xml', 'html5/data/js/data.js', 'html5/data/js/frame.js', entry.html5url];
    if (videoRefs.transcriptSource === 'sidecar' && videoRefs.narrationRef !== undefined) {
      sourceFiles.push(videoRefs.narrationRef);
    }

    // Spread-insertion preserves golden key order: transcript fields follow
    // transcript_source only when present.
    const doc: SlideDoc = {
      course: spine.course,
      scene_number: entry.sceneNumber,
      section_title: entry.sectionTitle,
      slide_number_in_scene: entry.slideNumberInScene,
      slide_id: entry.slideId,
      slide_title: entry.slideTitle,
      on_screen_text: onScreenText,
      text_chars: textChars,
      transcript_source: videoRefs.transcriptSource,
      ...(videoRefs.transcriptText !== undefined ? { transcript_text: videoRefs.transcriptText } : {}),
      ...(videoRefs.narrationRef !== undefined ? { narration_ref: videoRefs.narrationRef } : {}),
      provenance: `${entry.sectionTitle} > Slide ${entry.slideNumberInScene}`,
      source_files: sourceFiles,
      html5url: entry.html5url,
    };

    const nnn = String(index + 1).padStart(SLIDE_NNN_PAD, '0');
    writeFileSync(join(slidesDir, `slide-${nnn}-${entry.slideId}.json`), serialize(doc));
    docs.push(doc);
  });

  const outline: OutlineDoc = {
    course: spine.course,
    duration: spine.duration,
    scene_count: new Set(spine.slides.map((s) => s.sceneNumber)).size,
    sections: spine.sections,
  };
  writeFileSync(join(outDir, 'outline.json'), serialize(outline));
}

function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
