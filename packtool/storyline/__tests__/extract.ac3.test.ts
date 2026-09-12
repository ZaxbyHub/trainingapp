// AC3 — Non-ASCII (U+2019) decode correctness, issue #77.
//
// The fixture slide 5b8obQzpBWu carries the real ’ (U+2019 RIGHT SINGLE
// QUOTATION MARK) in a vectorData.altText, and the sidecar's second cue
// carries one in "patient’s". Decoding must preserve these codepoints exactly:
// the decoded strings must CONTAIN the real U+2019 and must NOT contain the
// mojibake replacement character U+FFFD (the failure mode a unicode_escape /
// latin-1 style decode produces — banned by G1).
//
// Frozen contract under test:
//   import { decodeGlobalProvideData, decodeSidecarAsset } from '../decode'
//     decodeGlobalProvideData(payloadName: string, text: string): unknown
//       - throws an Error whose message mentions 'globalProvideData' when the
//         wrapper is absent from `text`
//     decodeSidecarAsset(text: string): unknown

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeGlobalProvideData, decodeSidecarAsset } from '../decode';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'storyline-mini');
const U_2019 = '\u2019'; // ’ real right single quotation mark
const U_FFFD = '\uFFFD'; // � replacement character (mojibake marker)

function readText(path: string): string {
  let t = readFileSync(path, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // utf-8-sig semantics
  return t;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  throw new Error(`expected object, got ${typeof v}`);
}

// Recursively collect every string stored under an `altText` key (the G3/G4
// text-bearing field), written from the spec, independent of the implementation.
function collectAltTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectAltTexts(item, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'altText' && typeof v === 'string') out.push(v);
      else collectAltTexts(v, out);
    }
  }
  return out;
}

describe('AC3: U+2019 survives decode (no mojibake, no U+FFFD)', () => {
  it('slide 5b8obQzpBWu decodes with the real provider\u2019s intended dose', () => {
    const text = readText(join(FIXTURE_DIR, 'html5', 'data', 'js', '5b8obQzpBWu.js'));
    const decoded = decodeGlobalProvideData('slide', text);

    const altTexts = collectAltTexts(decoded);
    expect(altTexts.length).toBeGreaterThan(0);
    const providerAlt = altTexts.find((s) => s.includes('provider'));
    expect(providerAlt, `an altText containing "provider" must exist in ${JSON.stringify(altTexts)}`).toBeDefined();
    expect(providerAlt).toContain(`provider${U_2019}s intended dose`);
    expect(providerAlt).not.toContain(U_FFFD);
    // No altText anywhere in the decoded slide may carry a replacement char.
    for (const s of altTexts) expect(s).not.toContain(U_FFFD);
  });

  it('sidecar decode keeps patient\u2019s (U+2019) in the second cue', () => {
    const text = readText(join(FIXTURE_DIR, 'story_content', '5a5ry690OX4_transcripts.js'));
    const asset = decodeSidecarAsset(text);

    const transcripts = asRecord(asset)['transcripts'];
    if (!Array.isArray(transcripts)) throw new Error('sidecar has no transcripts[] array');
    const first = asRecord(transcripts[0]);
    const cues = first['cues'];
    if (!Array.isArray(cues)) throw new Error('sidecar transcript has no cues[] array');
    expect(cues.length).toBeGreaterThanOrEqual(2);

    const secondCue = asRecord(cues[1]);
    const cueText = secondCue['text'];
    expect(typeof cueText).toBe('string');
    expect(cueText).toContain(`patient${U_2019}s`);
    expect(cueText).not.toContain(U_FFFD);
    for (const cue of cues) {
      const t = asRecord(cue)['text'];
      if (typeof t === 'string') expect(t).not.toContain(U_FFFD);
    }
  });

  it('decodeGlobalProvideData throws a globalProvideData-mentioning error when the wrapper is absent', () => {
    expect(() => decodeGlobalProvideData('slide', 'const nothing = true;\n')).toThrow(/globalProvideData/);
  });
});
