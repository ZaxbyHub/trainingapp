// AC7 — Missing-transcript slides are marked, not dropped, issue #77.
//
// Per G4: objects with kind === 'video' link to a transcript sidecar via the
// OBJECT's id (media-id space, not slide ids) at
// <publishDir>/story_content/<id>_transcripts.js.
//   sidecar present  -> transcript_source 'sidecar', transcript_text = cue
//                       texts concatenated with NO separator, narration_ref =
//                       'story_content/<id>_transcripts.js'
//   sidecar absent   -> transcript_source 'missing', no narrationRef
//   no video object  -> transcript_source 'none'
//
// Fixture ground truth:
//   7bLnWpQxT4s has video object id 5a5ry690OX4 -> sidecar EXISTS (3 cues,
//     no-separator join = "Patient documentation from outside of CDP can be
//     imported and associated with your patient’s current encounter by using
//     the Import Document Button.[End Video]" — matches the hand-derived
//     golden doc slide-004).
//   8cMoXyRz5Jq has video object id 6qX2mV8bR1k -> story_content/
//     6qX2mV8bR1k_transcripts.js does NOT exist -> 'missing'.
//   5rN4PvXJM5d has no video object -> 'none'.
//
// Frozen contract under test:
//   import { decodeGlobalProvideData } from '../decode'
//   import { resolveVideoRefs } from '../video-refs'
//     resolveVideoRefs(slidePayload: object, publishDir: string): {
//       transcriptSource: 'sidecar' | 'missing' | 'none';
//       transcriptText?: string;
//       narrationRef?: string;
//     }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeGlobalProvideData } from '../decode';
import { resolveVideoRefs } from '../video-refs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'storyline-mini');
const U_2019 = '\u2019';

function readText(path: string): string {
  let t = readFileSync(path, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // utf-8-sig semantics
  return t;
}

function decodeSlide(slideId: string): object {
  const text = readText(join(FIXTURE_DIR, 'html5', 'data', 'js', `${slideId}.js`));
  return decodeGlobalProvideData('slide', text) as object;
}

// Exact expected transcript, hand-derived from the fixture sidecar cues
// ("…imported " + "and associated…Button." + "[End Video]", no separator).
const EXPECTED_TRANSCRIPT =
  'Patient documentation from outside of CDP can be imported and associated with your ' +
  `patient${U_2019}s current encounter by using the Import Document Button.[End Video]`;

describe('AC7: video transcript resolution — sidecar, missing, none', () => {
  it('7bLnWpQxT4s resolves the existing sidecar via video object id 5a5ry690OX4', () => {
    const result = resolveVideoRefs(decodeSlide('7bLnWpQxT4s'), FIXTURE_DIR);
    expect(result.transcriptSource).toBe('sidecar');
    expect(result.narrationRef).toBe('story_content/5a5ry690OX4_transcripts.js');
    expect(result.transcriptText).toBeDefined();
    expect(result.transcriptText?.startsWith('Patient documentation from outside of CDP can be imported ')).toBe(true);
    expect(result.transcriptText?.endsWith('[End Video]')).toBe(true);
    expect(result.transcriptText).toBe(EXPECTED_TRANSCRIPT);
  });

  it('8cMoXyRz5Jq (video id 6qX2mV8bR1k, no sidecar on disk) is marked missing with no narrationRef', () => {
    const result = resolveVideoRefs(decodeSlide('8cMoXyRz5Jq'), FIXTURE_DIR);
    expect(result.transcriptSource).toBe('missing');
    expect(result.narrationRef).toBeUndefined();
    expect(result.transcriptText).toBeUndefined();
  });

  it('5rN4PvXJM5d (no video object) is marked none', () => {
    const result = resolveVideoRefs(decodeSlide('5rN4PvXJM5d'), FIXTURE_DIR);
    expect(result.transcriptSource).toBe('none');
    expect(result.narrationRef).toBeUndefined();
    expect(result.transcriptText).toBeUndefined();
  });
});
