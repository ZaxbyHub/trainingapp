// AC2 — Walked-count invariant, issue #77.
//
// The real 384-slide corpus cannot run in CI; this test freezes the invariant
// that the slide count comes from WALKING data.js scenes filtered to
// !isMessageScene (G2), never from the data.js `slideCount` field (which merely
// coincides by construction and hides a differently-shaped message scene).
//
// Frozen contract under test:
//   import { decodeGlobalProvideData } from '../decode'
//     decodeGlobalProvideData(payloadName: string, text: string): unknown
//   import { buildSpine } from '../spine'
//     buildSpine(publishDir: string): {
//       course: string; duration: string;
//       slides: Array<{ slideId, slideTitle, sceneNumber, slideNumberInScene,
//                       html5url, sectionTitle }>;
//     }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeGlobalProvideData } from '../decode';
import { buildSpine } from '../spine';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'storyline-mini');

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

// The G2 walk rule itself, written from the spec (not from any implementation):
// scenes with isMessageScene === true are excluded; the rest contribute their
// slides[] entries in order.
function walkContentSlides(data: unknown): unknown[] {
  const scenes = asRecord(data)['scenes'];
  if (!Array.isArray(scenes)) throw new Error('data.js payload has no scenes[] array');
  const out: unknown[] = [];
  for (const scene of scenes) {
    const s = asRecord(scene);
    if (s['isMessageScene'] === true) continue;
    const slides = s['slides'];
    if (Array.isArray(slides)) out.push(...slides);
  }
  return out;
}

function allSceneSlideEntries(data: unknown): unknown[] {
  const scenes = asRecord(data)['scenes'];
  if (!Array.isArray(scenes)) throw new Error('data.js payload has no scenes[] array');
  const out: unknown[] = [];
  for (const scene of scenes) {
    const slides = asRecord(scene)['slides'];
    if (Array.isArray(slides)) out.push(...slides);
  }
  return out;
}

// Synthetic data.js-like payload: ONE isMessageScene carrying 2 slides, while
// the slideCount field claims 2. A walk-based count yields 0; an
// implementation that trusts slideCount would yield 2 (the real-corpus trap
// that produced 386 instead of 384 on the 384-slide course).
const SYNTHETIC_DATA = {
  id: '_player',
  courseId: 'syntheticCourse',
  version: '3.114.36620.0',
  slideCount: 2,
  scenes: [
    {
      id: 'SyntheticMessageScene',
      isMessageScene: true,
      kind: 'scene',
      lmsId: '',
      sceneNumber: 0,
      startingSlide: '_player.SyntheticMessageScene.MsgA',
      slides: [
        { id: 'MsgA', title: 'Resume', lmsId: '', slideNumberInScene: 0, kind: 'slide', includeInSlideCounts: false },
        { id: 'MsgB', title: 'Warning', lmsId: '', slideNumberInScene: 0, kind: 'slide', includeInSlideCounts: false },
      ],
    },
  ],
};

describe('AC2: slide count comes from the scene walk, not slideCount', () => {
  it('buildSpine on the fixture yields exactly 6 walked content slides in content order', () => {
    const spine = buildSpine(FIXTURE_DIR);
    expect(spine.course).toBe('OpMed CDP Mini Fixture');
    expect(spine.duration).toBe('About 3 minutes');
    expect(spine.slides).toHaveLength(6);
    expect(spine.slides.map((s) => s.slideId)).toEqual([
      '5rN4PvXJM5d',
      '5b8obQzpBWu',
      '6fxKq2mV8bR',
      '7bLnWpQxT4s',
      '8cMoXyRz5Jq',
      '9dNpYzSa6Kr',
    ]);
  });

  it('decoding the fixture data.js: the isMessageScene-filtered walk is what produces 6', () => {
    const text = readText(join(FIXTURE_DIR, 'html5', 'data', 'js', 'data.js'));
    const data = decodeGlobalProvideData('data', text);

    const scenes = asRecord(data)['scenes'];
    expect(Array.isArray(scenes)).toBe(true);
    expect(scenes).toHaveLength(3); // 1 message scene + 2 content scenes

    // Raw entries: 8 (2 message-scene slides + 6 content slides).
    expect(allSceneSlideEntries(data)).toHaveLength(8);

    // The walk filters the message scene out: 6.
    expect(walkContentSlides(data)).toHaveLength(6);

    // slideCount merely coincides with the walked count (trap field).
    expect(asRecord(data)['slideCount']).toBe(6);
  });

  it('real-corpus guard: an isMessageScene-only payload with slideCount=2 walks to length 0', () => {
    const syntheticText = `window.globalProvideData('data', '${JSON.stringify(SYNTHETIC_DATA)}');\n`;
    const decoded = decodeGlobalProvideData('data', syntheticText);

    // The payload really claims 2 slides...
    expect(asRecord(decoded)['slideCount']).toBe(2);
    // ...but the walk (the only legal count source) yields 0 content slides.
    expect(walkContentSlides(decoded)).toHaveLength(0);
  });
});
