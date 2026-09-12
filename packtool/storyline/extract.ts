// Document assembly: publish folder -> per-slide SlideDocs + one OutlineDoc
// (issue #77, G5; PRR feedback fixes). Serialization key order here is
// normative: the golden fixture files (tests/fixtures/storyline-mini/expected/)
// are compared byte-for-byte.
//
// Path safety: slideId / html5url / videoId are untrusted fields from a
// third-party publish. PRR-001 fix: assertNoEscape() guards every component
// that flows into a path.join() call so an adversarial data.js cannot write
// outside outDir / publishDir.
//
// Atomicity: PRR-002 fix — slide files are written to a sibling tmp dir then
// rename-d into outDir/slides/<file>; outline.json the same. A mid-run throw
// leaves outDir either fully populated or untouched. PRR-003 fix — outDir is
// cleared at start so a re-run against a different publish never leaves stale
// slide-*.json behind.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { decodeGlobalProvideData, readTextFile } from './decode.js';
import { buildSpine } from './spine.js';
import type { OutlineDoc, SlideDoc } from './types.js';
import { resolveVideoRefs } from './video-refs.js';
import { walkSlideText } from './walk.js';

const SLIDE_NNN_PAD = 3;
const UNASSIGNED_SECTION = '<unassigned>';

function assertNoEscape(name: string, value: string): void {
  if (value.length === 0) throw new Error(`${name} is empty`);
  if (value.includes('/') || value.includes('\\') || value.includes('\u0000')) {
    throw new Error(`${name} contains a path separator or NUL (refused): ${value}`);
  }
  if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../') || value.startsWith('.\\') || value.startsWith('..\\')) {
    throw new Error(`${name} is a relative-path segment (refused): ${value}`);
  }
}

function assertRelativeUnder(base: string, child: string, what: string): void {
  const resolved = resolvePath(base, child);
  const baseResolved = resolvePath(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + sep)) {
    throw new Error(`${what} resolves outside its base (refused): ${child}`);
  }
}

function readNonMessageSceneCount(publishDir: string): number {
  const data = decodeGlobalProvideData('data', readTextFile(join(publishDir, 'html5', 'data', 'js', 'data.js')));
  const scenes = ((data as { scenes: unknown }).scenes ?? []) as unknown[];
  let n = 0;
  for (const s of scenes) {
    if (typeof s === 'object' && s !== null && (s as { isMessageScene?: unknown }).isMessageScene !== true) n += 1;
  }
  return n;
}

export function extractPublishDir(publishDir: string, outDir: string): void {
  // PRR-003: clear stale output so a re-run against a different publish never
  // leaves a mix of old and new files. Only delete known extension types; if
  // outDir contains anything else (a user's own files), throw instead.
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    const allowed = new Set(['slides', 'outline.json']);
    for (const name of entries) {
      if (!allowed.has(name)) {
        throw new Error(
          `outDir ${outDir} contains unexpected entry "${name}"; refusing to clobber. ` +
            `Re-run with an empty outDir.`,
        );
      }
    }
    rmSync(join(outDir, 'outline.json'), { force: true });
    rmSync(join(outDir, 'slides'), { recursive: true, force: true });
  }

  const tmpDir = join(outDir, `.packtool-tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpSlides = join(tmpDir, 'slides');
  mkdirSync(tmpSlides, { recursive: true });

  try {
    const spine = buildSpine(publishDir);

    const docs: SlideDoc[] = [];
    spine.slides.forEach((entry, index) => {
      // PRR-001: validate every component before it reaches path.join.
      assertNoEscape('slideId', entry.slideId);
      if (!entry.html5url.startsWith('html5/')) {
        throw new Error(`html5url must start with 'html5/' (refused): ${entry.html5url}`);
      }
      for (const seg of entry.html5url.split('/')) {
        if (seg === '..' || seg === '.') {
          throw new Error(`html5url contains a relative-path segment (refused): ${entry.html5url}`);
        }
      }
      assertRelativeUnder(publishDir, entry.html5url, `slide ${entry.slideId} html5url`);

      const slidePath = join(publishDir, ...entry.html5url.split('/'));
      const payload = decodeGlobalProvideData('slide', readTextFile(slidePath));
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
      assertNoEscape('output slide filename', outName);
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

    // PRR-002: atomically publish the tmp dir to outDir. A throw before this
    // leaves outDir untouched.
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
