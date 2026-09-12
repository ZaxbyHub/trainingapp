// Video -> transcript sidecar resolution (issue #77, G4; PRR feedback fixes).
//
// A video object is kind === 'video' with data.videodata (altText there is the
// ORIGINAL media filename — never on-screen text). The sidecar lookup key is
// the OBJECT's id (the media-id space: on the real corpus the 24 video-object
// ids are not slide ids and match the 24 story_content/<id>_transcripts.js
// stems 1:1). Present sidecars give transcriptSource 'sidecar' with the cue
// texts concatenated with NO separator (cues carry their own spacing) and
// narrationRef 'story_content/<id>_transcripts.js' (the D2/#78 placeholder);
// absent sidecars are marked 'missing' — never silently dropped; slides with
// no video object are 'none'.
//
// PRR-001 fix: videoId is also untrusted data.js content. The same
// path-safety contract as slideId/html5url applies: refuse any value with
// separators, NUL, or '..'/'.' segments before it reaches path.join. A
// rejected videoId produces transcriptSource 'missing' (not 'sidecar'),
// matching the sidecar-absent behavior; the slide still gets a doc with
// narration_ref undefined.
//
// PRR-006 fix: decode errors thrown here carry the sidecar file path so the
// CLI caller can identify the malformed file.

import { existsSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { decodeSidecarAsset, readTextFile } from './decode.js';

type Rec = Record<string, unknown>;

export interface VideoRefs {
  transcriptSource: 'sidecar' | 'missing' | 'none';
  transcriptText?: string;
  narrationRef?: string;
}

function asRecord(value: unknown): Rec {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Rec;
  }
  throw new Error(`expected an object, got ${value === null ? 'null' : typeof value}`);
}

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

/** Concatenate cue texts with no separator (cues carry their own spacing). */
export function sidecarTranscriptText(sidecar: unknown): string {
  const root = asRecord(sidecar);
  const transcripts = root['transcripts'];
  if (!Array.isArray(transcripts)) {
    throw new Error('sidecar payload has no transcripts[] array');
  }
  let out = '';
  for (const transcript of transcripts) {
    const cues = asRecord(transcript)['cues'];
    if (!Array.isArray(cues)) continue;
    for (const cue of cues) {
      const text = asRecord(cue)['text'];
      if (typeof text === 'string') out += text;
    }
  }
  return out;
}

export function resolveVideoRefs(slidePayload: object, publishDir: string): VideoRefs {
  const slide = asRecord(slidePayload);
  const layers = slide['slideLayers'];
  const videoIds: string[] = [];
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      const objects = asRecord(layer)['objects'];
      if (!Array.isArray(objects)) continue;
      for (const object of objects) {
        const obj = asRecord(object);
        if (obj['kind'] === 'video' && typeof obj['id'] === 'string') {
          videoIds.push(obj['id']);
        }
      }
    }
  }
  if (videoIds.length === 0) return { transcriptSource: 'none' };

  // A slide may carry several video objects (15 on the real corpus, where the
  // first video is often an untranscribed bumper and a later one has the
  // narration sidecar). Deterministically prefer the FIRST video object that
  // has a sidecar; report 'missing' only when none does (or when every
  // candidate videoId is rejected by the path-safety check — an adversarial
  // publish cannot trigger arbitrary file reads under story_content/).
  for (const videoId of videoIds) {
    const narrationRef = `story_content/${videoId}_transcripts.js`;
    const sidecarPath = join(publishDir, 'story_content', `${videoId}_transcripts.js`);
    // PRR-001 videoId leg: refuse any component that could escape publishDir.
    // Defense-in-depth: even though the literal-sidecar lookup later runs
    // existsSync, the join() above has already normalized the path; an unsafe
    // videoId would yield a path outside story_content/ and either miss
    // (existsSync=false → 'missing', which is acceptable) or hit a real file
    // the operator never intended. Refusing unsafe videoIds makes the
    // adversarial case deterministically 'missing' and observable.
    if (isUnsafeComponent(videoId)) {
      continue;
    }
    // PRR-006 belt-and-suspenders: also verify the joined path stays inside
    // story_content/.
    const resolvedSidecar = resolvePath(sidecarPath);
    const resolvedStory = resolvePath(publishDir, 'story_content');
    if (
      resolvedSidecar !== resolvedStory &&
      !resolvedSidecar.startsWith(resolvedStory + sep)
    ) {
      continue;
    }
    if (!existsSync(sidecarPath)) continue;
    const sidecar = decodeSidecarAsset(readTextFile(sidecarPath), sidecarPath);
    return { transcriptSource: 'sidecar', transcriptText: sidecarTranscriptText(sidecar), narrationRef };
  }
  return { transcriptSource: 'missing' };
}
