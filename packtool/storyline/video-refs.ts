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
  // narration sidecar). Resolution is TWO-PASS (PRR6-F6): pass 1 probes ALL
  // candidates for a NATIVE sidecar, pass 2 (overlay set) probes all for an
  // ASR transcript, candidate order within each pass. A single combined loop
  // would let an earlier candidate's ASR twin (e.g. a silent bumper's empty
  // transcript) shadow a later candidate's human-authored sidecar, inverting
  // the documented sidecar > asr > missing priority. An unsafe id (PRR-001)
  // or a contained-path violation (PRR-006) is filtered once, up front — an
  // adversarial publish cannot trigger arbitrary file reads under
  // story_content/ or the ASR store.
  const candidates: Array<{ id: string; kind: 'video' | 'audio' }> = [
    ...videoIds.map((id) => ({ id, kind: 'video' as const })),
    ...audioIds.map((id) => ({ id, kind: 'audio' as const })),
  ];
  const safe: Array<{ id: string; sidecarPath: string; narrationRef: string; asrPath?: string; asrRef?: string }> = [];
  const resolvedStory = resolvePath(publishDir, 'story_content');
  for (const candidate of candidates) {
    const videoId = candidate.id;
    if (isUnsafeComponent(videoId)) {
      continue;
    }
    const sidecarPath = join(publishDir, 'story_content', `${videoId}_transcripts.js`);
    const resolvedSidecar = resolvePath(sidecarPath);
    if (
      resolvedSidecar !== resolvedStory &&
      !resolvedSidecar.startsWith(resolvedStory + sep)
    ) {
      continue;
    }
    const entry: { id: string; sidecarPath: string; narrationRef: string; asrPath?: string; asrRef?: string } = {
      id: videoId,
      sidecarPath,
      narrationRef: `story_content/${videoId}_transcripts.js`,
    };
    if (asrDir !== undefined) {
      // ASR overlay leg (#78): same object-id key space, same byte format,
      // same decode path — no shape adapter. asrRef is ASR-store-relative and
      // deliberately NOT publish-relative (the file lives in asrDir).
      const asrRef = `${videoId}_transcripts.js`;
      const asrPath = join(asrDir, asrRef);
      const resolvedAsr = resolvePath(asrPath);
      const resolvedAsrDir = resolvePath(asrDir);
      if (resolvedAsr === resolvedAsrDir || resolvedAsr.startsWith(resolvedAsrDir + sep)) {
        entry.asrPath = asrPath;
        entry.asrRef = asrRef;
      }
    }
    safe.push(entry);
  }
  // Pass 1: the first candidate with a native sidecar wins for the slide.
  for (const entry of safe) {
    if (existsSync(entry.sidecarPath)) {
      const sidecar = decodeSidecarAsset(readTextFile(entry.sidecarPath), entry.sidecarPath);
      return { transcriptSource: 'sidecar', transcriptText: sidecarTranscriptText(sidecar), narrationRef: entry.narrationRef };
    }
  }
  // Pass 2: otherwise the first candidate with an ASR transcript (overlay set).
  if (asrDir !== undefined) {
    for (const entry of safe) {
      if (entry.asrPath !== undefined && existsSync(entry.asrPath)) {
        const asrSidecar = decodeSidecarAsset(readTextFile(entry.asrPath), entry.asrPath);
        return {
          transcriptSource: 'asr',
          transcriptText: sidecarTranscriptText(asrSidecar),
          narrationRef: entry.asrRef!,
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
