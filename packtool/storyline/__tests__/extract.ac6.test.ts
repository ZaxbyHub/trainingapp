// AC6 — %player.var% tokens stripped, issue #77.
//
// Per G3, `%player.<var>%`-style tokens (regex %player\.[A-Za-z0-9_.]+%) are
// stripped from every text piece BEFORE assembly. The real export contains 0
// occurrences (verified corpus-wide, correction C2), so this test uses an
// inline synthetic slide payload (the issue explicitly allows "unit input").
//
// Assembly order per G3, in document order (slideLayers[] -> objects[]):
//   1. object.data.vectorData.altText when a non-empty string — its own piece
//   2. object.textLib[].vartext.blocks[].spans[].text concatenated
// Pieces joined with "\n". Derivation of the expected string:
//   altText  'Score: %player.score%!'      -> strip token -> 'Score: !'
//   vartext  'Rate: %player.myVar% points' -> strip token -> 'Rate: ' + ' points'
//                                                                  = 'Rate:  points'
//   joined   'Score: !\nRate:  points'   (note the double space after 'Rate:')
//   chars    8 + 1 + 13 = 22   ('Rate:  points' is 13 chars; the originally
//            frozen 23 was an arithmetic slip — amended via CHECK_WRONG)
//
// Frozen contract under test:
//   import { walkSlideText } from '../walk'
//     walkSlideText(slidePayload: object): { onScreenText: string; textChars: number }

import { describe, expect, it } from 'vitest';
import { walkSlideText } from '../walk';

const SYNTHETIC_SLIDE = {
  id: 'syntheticTokenSlide',
  slideLayers: [
    {
      isBaseLayer: true,
      kind: 'layer',
      objects: [
        {
          kind: 'vectorshape',
          id: 'objAlt',
          referenceName: 'objAlt',
          data: { vectorData: { altText: 'Score: %player.score%!' } },
        },
        {
          kind: 'vectorshape',
          id: 'objText',
          referenceName: 'objText',
          data: { vectorData: { altText: '' } },
          textLib: [
            {
              kind: 'textdata',
              uniqueId: 'objText_-1',
              id: '01',
              linkId: 'txt__default_objText',
              type: 'acctext',
              vartext: {
                blocks: [{ spans: [{ text: 'Rate: %player.myVar% points', style: {} }] }],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('AC6: %player.var% tokens are stripped before assembly', () => {
  it('no % interpolation syntax survives the walk', () => {
    const result = walkSlideText(SYNTHETIC_SLIDE);
    expect(result.onScreenText).not.toContain('%');
  });

  it('stripped text assembles altText-first with token gaps removed', () => {
    const result = walkSlideText(SYNTHETIC_SLIDE);
    expect(result.onScreenText).toBe('Score: !\nRate:  points');
    expect(result.textChars).toBe(22);
  });
});
