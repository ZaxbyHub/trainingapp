// Video/audio -> transcript resolution (issue #77 G4 + #78 ASR overlay; PRR fixes).
//
// A video object is kind === 'video' with data.videodata (altText there is the
// ORIGINAL media filename — never on-screen text). The sidecar lookup key is
// the OBJECT's id (the media-id space: on the real corpus the 24 video-object
// ids are not slide ids and match the 24 story_content/<id>_transcripts.js
// stems 1:1). Present sidecars give transcriptSource 'sidecar' with the cue
// texts concatenated with NO separator (cues carry their own spacing) and
// narrationRef 'story_content/<id>_transcripts.js'; absent transcripts are
// marked 'missing' — never silently dropped; slides with no media object are
// 'none'. With the #78 ASR overlay (options.asrDir), AUDIO objects (kind
// === 'audio', recursive walk — they nest under layer audiolib[] arrays too)
// join the candidates, and a candidate may also resolve from the ASR store
// written by packtool/storyline/transcribe.py: '<asrDir>/<id>_transcripts.js'
// in the SAME byte format as native sidecars, decoded by the unchanged
// decodeSidecarAsset path ('asr'; narrationRef '<id>_transcripts.js',
// ASR-store-relative, deliberately NOT publish-relative and never pushed into
// source_files). Without asrDir the pre-#78 contract is preserved exactly:
// audio objects are not scanned, so audio-only slides stay 'none'.
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
  transcriptSource: 'sidecar' | 'asr' | 'missing' | 'none';
  transcriptText?: string;
  narrationRef?: string;
}

export interface ResolveRefsOptions {
  /** ASR transcript store (transcribe.py --out). Undefined = pre-#78 behavior. */
  asrDir?: string;
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

export function resolveVideoRefs(
  slidePayload: object,
  publishDir: string,
  options: ResolveRefsOptions = {},
): VideoRefs {
  const asrDir = options.asrDir;
  const slide = asRecord(slidePayload);
  const layers = slide['slideLayers'];
  const videoIds: string[] = [];
  const audioIds: string[] = [];
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
  // ASR overlay only (#78): audio objects join the candidates. They nest under
  // layer audiolib[] arrays as well as objects[] depending on publisher
  // version, so the walk is fully recursive — a deliberate safe superset.
  // Without an asrDir, audio objects are NOT scanned (pre-#78 behavior:
  // audio-only-narration slides stay 'none' and golden outputs are unchanged).
  if (asrDir !== undefined) {
    collectAudioIds(slide, audioIds);
  }
  if (videoIds.length === 0 && audioIds.length === 0) return { transcriptSource: 'none' };

  // A slide may carry several video objects (15 on the real corpus, where the
  // first video is often an untranscribed bumper and a later one has the
  // narration sidecar). Deterministically prefer the FIRST candidate that has
  // a native sidecar; report 'missing' only when none does (or when every
  // candidate videoId is rejected by the path-safety check — an adversarial
  // publish cannot trigger arbitrary file reads under story_content/ or the
  // ASR store).
  const candidates: Array<{ id: string; kind: 'video' | 'audio' }> = [
    ...videoIds.map((id) => ({ id, kind: 'video' as const })),
    ...audioIds.map((id) => ({ id, kind: 'audio' as const })),
  ];
  for (const candidate of candidates) {
    const videoId = candidate.id;
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
    if (existsSync(sidecarPath)) {
      const sidecar = decodeSidecarAsset(readTextFile(sidecarPath), sidecarPath);
      return { transcriptSource: 'sidecar', transcriptText: sidecarTranscriptText(sidecar), narrationRef };
    }
    // ASR overlay leg (#78): same object-id key space, same byte format, same
    // decode path — no shape adapter. narrationRef is ASR-store-relative and
    // deliberately NOT publish-relative (the file lives in asrDir).
    if (asrDir !== undefined) {
      const asrRef = `${videoId}_transcripts.js`;
      const asrPath = join(asrDir, asrRef);
      const resolvedAsr = resolvePath(asrPath);
      const resolvedAsrDir = resolvePath(asrDir);
      if (
        (resolvedAsr === resolvedAsrDir || resolvedAsr.startsWith(resolvedAsrDir + sep)) &&
        existsSync(asrPath)
      ) {
        const asrSidecar = decodeSidecarAsset(readTextFile(asrPath), asrPath);
        return {
          transcriptSource: 'asr',
          transcriptText: sidecarTranscriptText(asrSidecar),
          narrationRef: asrRef,
        };
      }
    }
  }
  return { transcriptSource: 'missing' };
}

/** Collect audio object ids (kind === 'audio', string id) recursively. */
function collectAudioIds(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectAudioIds(child, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const rec = node as Rec;
  if (rec['kind'] === 'audio' && typeof rec['id'] === 'string') {
    out.push(rec['id']);
  }
  for (const value of Object.values(rec)) collectAudioIds(value, out);
}
