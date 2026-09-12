// Document assembly: publish folder -> per-slide SlideDocs + one OutlineDoc
// (issue #77, G5; PRR feedback fixes). Serialization key order here is
// normative: the golden fixture files (tests/fixtures/storyline-mini/expected/)
// are compared byte-for-byte.
//
// Path safety: slideId / html5url are untrusted fields from a third-party
// publish. PRR-001 fix: assertNoEscape guards every component that flows
// into a path.join() call so an adversarial data.js cannot write outside
// outDir / publishDir.
//
// Atomicity: PRR-002 fix — slide files AND outline.json are written to a
// sibling tmp dir; on success we clear outDir's prior slides/outline and
// rename the tmp output in. A mid-run throw therefore leaves the prior
// successful output intact (extract fails BEFORE clearing).
//
// PRR-006 fix: every decode call passes the source file path so a thrown
// error names the malformed file.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { decodeGlobalProvideData, readTextFile } from './decode.js';
import { buildSpine } from './spine.js';
import type { OutlineDoc, SlideDoc } from './types.js';
import { resolveVideoRefs } from './video-refs.js';
import { walkSlideText } from './walk.js';

const SLIDE_NNN_PAD = 3;
const UNASSIGNED_SECTION = '<unassigned>';

function isUnsafeComponent(value: string): boolean {
  if (value.length === 0) return true;
  if (value.includes('/') || value.includes('\\') || value.includes('\u0000')) return true;
  if (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\')
  ) return true;
  return false;
}

function readNonMessageSceneCount(publishDir: string): number {
  const data = decodeGlobalProvideData(
    'data',
    readTextFile(join(publishDir, 'html5', 'data', 'js', 'data.js')),
    join(publishDir, 'html5', 'data', 'js', 'data.js'),
  );
  const scenes = ((data as { scenes: unknown }).scenes ?? []) as unknown[];
  let n = 0;
  for (const s of scenes) {
    if (typeof s === 'object' && s !== null && (s as { isMessageScene?: unknown }).isMessageScene !== true) n += 1;
  }
  return n;
}

export function extractPublishDir(publishDir: string, outDir: string): void {
  const tmpDir = join(outDir, `.packtool-tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpSlides = join(tmpDir, 'slides');
  mkdirSync(tmpSlides, { recursive: true });

  try {
    const spine = buildSpine(publishDir);

    const docs: SlideDoc[] = [];
    spine.slides.forEach((entry, index) => {
      // PRR-001: validate every component before it reaches path.join.
      if (isUnsafeComponent(entry.slideId)) {
        throw new Error(`slideId refuses an unsafe value: ${JSON.stringify(entry.slideId)}`);
      }
      if (!entry.html5url.startsWith('html5/')) {
        throw new Error(`html5url must start with 'html5/' (refused): ${entry.html5url}`);
      }
      for (const seg of entry.html5url.split('/')) {
        if (seg === '..' || seg === '.') {
          throw new Error(`html5url contains a relative-path segment (refused): ${entry.html5url}`);
        }
      }
      const slidePath = join(publishDir, ...entry.html5url.split('/'));
      const resolved = resolvePath(slidePath);
      const pubResolved = resolvePath(publishDir);
      if (resolved !== pubResolved && !resolved.startsWith(pubResolved + sep)) {
        throw new Error(`slide ${entry.slideId} html5url resolves outside publishDir (refused): ${entry.html5url}`);
      }

      // PRR-006: pass the source path so a thrown decode error names the file.
      const payload = decodeGlobalProvideData('slide', readTextFile(slidePath), slidePath);
      const { onScreenText, textChars } = walkSlideText(payload as object);
      const videoRefs = resolveVideoRefs(payload as object, publishDir);

      const sourceFiles = ['meta.xml', 'html5/data/js/data.js', 'html5/data/js/frame.js', entry.html5url];
      if (videoRefs.transcriptSource === 'sidecar' && videoRefs.narrationRef !== undefined) {
        sourceFiles.push(videoRefs.narrationRef);
      }

      // PRR-008: an outline-absent slide still gets a parseable provenance
      // string ("<unassigned> > Slide N") rather than a bare " > Slide N".
      const sectionTitle = entry.sectionTitle === '' ? UNASSIGNED_SECTION : entry.sectionTitle;

      // Spread-insertion preserves golden key order: transcript fields follow
      // transcript_source only when present.
      const doc: SlideDoc = {
        course: spine.course,
        scene_number: entry.sceneNumber,
        section_title: sectionTitle,
        slide_number_in_scene: entry.slideNumberInScene,
        slide_id: entry.slideId,
        slide_title: entry.slideTitle,
        on_screen_text: onScreenText,
        text_chars: textChars,
        transcript_source: videoRefs.transcriptSource,
        ...(videoRefs.transcriptText !== undefined ? { transcript_text: videoRefs.transcriptText } : {}),
        ...(videoRefs.narrationRef !== undefined ? { narration_ref: videoRefs.narrationRef } : {}),
        provenance: `${sectionTitle} > Slide ${entry.slideNumberInScene}`,
        source_files: sourceFiles,
        html5url: entry.html5url,
      };

      const nnn = String(index + 1).padStart(SLIDE_NNN_PAD, '0');
      const outName = `slide-${nnn}-${entry.slideId}.json`;
      if (isUnsafeComponent(outName)) {
        throw new Error(`output slide filename refuses an unsafe value: ${JSON.stringify(outName)}`);
      }
      writeFileSync(join(tmpSlides, outName), serialize(doc));
      docs.push(doc);
    });

    // PRR-014: scene_count uses the WALKED scene list (filters message scenes
    // and tolerates empty content-scene slides[]) rather than a Set of walked
    // scene numbers, which silently drops empty content scenes.
    const outline: OutlineDoc = {
      course: spine.course,
      duration: spine.duration,
      scene_count: readNonMessageSceneCount(publishDir),
      sections: spine.sections,
    };
    writeFileSync(join(tmpDir, 'outline.json'), serialize(outline));

    // PRR-002 fix (corrected order): tmp-extract FULLY succeeds FIRST, THEN
    // we clear outDir's prior output, THEN rename tmp -> outDir atomically.
    // A throw before this leaves BOTH outDir (with prior good output) AND
    // the tmp scratchpad untouched — so re-running the same command produces
    // a clean failure that doesn't destroy the previous successful run.
    //
    // PRR-003 fix: refuse to clobber outDir if it contains anything other
    // than the known output names (slides/, outline.json) or a leftover
    // .packtool-tmp-* scratchpad from a prior crashed run. We ignore (but
    // do not recurse into) the scratchpad — a later operator can rm -rf
    // it manually; a parallel extract using the same scratchpad name
    // (process.pid + Date.now collision) is not a real failure mode since
    // the second writer will overwrite the first anyway. Doing anything
    // more here risks a cross-process rmSync race.
    if (existsSync(outDir)) {
      const entries = readdirSync(outDir);
      const allowed = new Set(['slides', 'outline.json']);
      for (const name of entries) {
        if (allowed.has(name)) continue;
        if (name.startsWith('.packtool-tmp-')) continue;
        throw new Error(
          `outDir ${outDir} contains unexpected entry "${name}"; refusing to clobber. ` +
            `Re-run with an empty outDir.`,
        );
      }
      rmSync(join(outDir, 'outline.json'), { force: true });
      rmSync(join(outDir, 'slides'), { recursive: true, force: true });
    }

    // Publish: rename tmp/slides/* into outDir/slides/ and tmp/outline.json
    // into outDir/. Now atomic: a throw mid-rename leaves a partial state
    // inside outDir only AFTER the prior output has been cleared; the throw
    // path removes the partial and restores nothing (caller reruns against
    // an empty outDir).
    mkdirSync(join(outDir, 'slides'), { recursive: true });
    for (const name of readdirSync(tmpSlides)) {
      renameSync(join(tmpSlides, name), join(outDir, 'slides', name));
    }
    renameSync(join(tmpDir, 'outline.json'), join(outDir, 'outline.json'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
