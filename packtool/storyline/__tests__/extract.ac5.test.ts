// AC5 — Section titles resolved from frame.js, not data.js, issue #77.
//
// Section titles come from frame.js navData.outline.links[] top-level
// displaytext, HTML-entity-decoded (the fixture's raw displaytext is
// "Tasks &amp; Drills" -> "Tasks & Drills"). Slide-to-section linkage is via
// the outline sub-link slideid `_player.<sectionId>.<slideId>` whose LAST
// component equals slide.id (G2). The control test proves data.js alone
// cannot produce a section title: its scene objects carry no title-bearing
// field at all.
//
// Frozen contract under test:
//   import { decodeGlobalProvideData } from '../decode'
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

// The complete slideId -> sectionTitle partition, derived by hand from the
// fixture frame.js outline subtree (sub-link slideid last components):
//   Course Introduction: 5rN4PvXJM5d, 5b8obQzpBWu
//   Tasks &amp; Drills:  6fxKq2mV8bR, 7bLnWpQxT4s, 8cMoXyRz5Jq, 9dNpYzSa6Kr
const EXPECTED_SECTION_TITLES: Record<string, string> = {
  '5rN4PvXJM5d': 'Course Introduction',
  '5b8obQzpBWu': 'Course Introduction',
  '6fxKq2mV8bR': 'Tasks & Drills',
  '7bLnWpQxT4s': 'Tasks & Drills',
  '8cMoXyRz5Jq': 'Tasks & Drills',
  '9dNpYzSa6Kr': 'Tasks & Drills',
};

describe('AC5: section titles come from frame.js (entity-decoded), never data.js', () => {
  it('the raw fixture frame.js really encodes the entity form "Tasks &amp; Drills"', () => {
    // Guards against the fixture drifting to a pre-decoded value, which would
    // make the entity-decode assertion below vacuous.
    const frameRaw = readText(join(FIXTURE_DIR, 'html5', 'data', 'js', 'frame.js'));
    expect(frameRaw).toContain('Tasks &amp; Drills');
  });

  it('slide 9dNpYzSa6Kr has sectionTitle "Tasks & Drills" (decoded from &amp;)', () => {
    const spine = buildSpine(FIXTURE_DIR);
    const slide = spine.slides.find((s) => s.slideId === '9dNpYzSa6Kr');
    expect(slide).toBeDefined();
    expect(slide?.sectionTitle).toBe('Tasks & Drills');
  });

  it('slide 5rN4PvXJM5d has sectionTitle "Course Introduction"', () => {
    const spine = buildSpine(FIXTURE_DIR);
    const slide = spine.slides.find((s) => s.slideId === '5rN4PvXJM5d');
    expect(slide).toBeDefined();
    expect(slide?.sectionTitle).toBe('Course Introduction');
  });

  it('every slide carries its frame.js-outline section title', () => {
    const spine = buildSpine(FIXTURE_DIR);
    expect(spine.slides).toHaveLength(6);
    for (const slide of spine.slides) {
      expect(slide.sectionTitle).toBe(EXPECTED_SECTION_TITLES[slide.slideId]);
    }
  });

  it('CONTROL: data.js scene objects alone cannot produce a section title', () => {
    const text = readText(join(FIXTURE_DIR, 'html5', 'data', 'js', 'data.js'));
    const data = decodeGlobalProvideData('data', text);

    const scenes = asRecord(data)['scenes'];
    if (!Array.isArray(scenes)) throw new Error('data.js payload has no scenes[] array');
    expect(scenes).toHaveLength(3);

    // Verified fixture shape: scene objects carry EXACTLY these keys — no
    // title, no displaytext, no links/outline, no section field of any kind.
    const expectedSceneKeys = ['id', 'isMessageScene', 'kind', 'lmsId', 'sceneNumber', 'slides', 'startingSlide'];
    for (const scene of scenes) {
      expect(Object.keys(asRecord(scene)).sort()).toEqual([...expectedSceneKeys].sort());
    }
  });
});
