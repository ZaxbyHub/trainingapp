// AC4 — Empty-text slides do not crash, issue #77.
//
// Fixture slide 6fxKq2mV8bR has objects whose altText values are "" and null,
// and no textLib entries at all. Per G3 the walk must yield empty on-screen
// text and text_chars 0 — the slide is still walkable, never a crash, never
// an omission.
//
// Frozen contract under test:
//   import { decodeGlobalProvideData } from '../decode'
//   import { walkSlideText } from '../walk'
//     walkSlideText(slidePayload: object): { onScreenText: string; textChars: number }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeGlobalProvideData } from '../decode';
import { walkSlideText } from '../walk';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'storyline-mini');

function readText(path: string): string {
  let t = readFileSync(path, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // utf-8-sig semantics
  return t;
}

describe('AC4: all-empty altText and no vartext yields empty text, no crash', () => {
  it('walkSlideText on decoded fixture slide 6fxKq2mV8bR returns empty text with 0 chars', () => {
    const text = readText(join(FIXTURE_DIR, 'html5', 'data', 'js', '6fxKq2mV8bR.js'));
    const payload = decodeGlobalProvideData('slide', text);

    const result = walkSlideText(payload as object);
    expect(result).toEqual({ onScreenText: '', textChars: 0 });
  });

  it('AMENDED (CHECK_WRONG): two EMPTY pieces still join to empty — empty pieces are dropped, not joined', () => {
    // The fixture slide carries only one pushable empty piece (its second
    // object's altText is null and is skipped at the typeof gate), so an
    // implementation that PUSHES empty pieces and joins them with "\n" would
    // still produce '' here (one piece, no separator). This synthetic payload
    // has TWO empty-string pieces, which forces the join to differ ('\n') and
    // therefore pins the drop-empty-pieces behavior the G3 spec requires.
    const twoEmptyObjects = {
      id: 'syntheticTwoEmpty',
      slideLayers: [
        {
          isBaseLayer: true,
          kind: 'layer',
          objects: [
            { kind: 'vectorshape', id: 'e1', referenceName: 'e1', data: { vectorData: { altText: '' } } },
            { kind: 'vectorshape', id: 'e2', referenceName: 'e2', data: { vectorData: { altText: '' } } },
          ],
        },
      ],
    };
    const result = walkSlideText(twoEmptyObjects);
    expect(result).toEqual({ onScreenText: '', textChars: 0 });
  });
});
