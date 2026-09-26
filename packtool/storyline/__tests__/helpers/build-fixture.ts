// helpers/build-fixture.ts — synthetic Storyline publish + ASR store for the
// build-storyline acceptance tests (issue #79). Shapes mirror the committed
// extract.ac8 test payloads and the #78 ASR store byte format, so the D1
// extractor decodes the publish cleanly and the --asr-dir overlay resolves.
// Slide matrix: S1 "Intro" (video + native sidecar -> transcript_source
// "sidecar", distinctive word "Quokka"), S2 "Drill" (audio object with an ASR
// twin -> "asr" under --asr-dir, distinctive word "Wombat"), S3 "Review"
// (no media -> "none", distinctive word "summary").
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function providePayload(name: string, payload: unknown): string {
  const json = JSON.stringify(payload).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `window.globalProvideData('${name}', '${json}');\n`;
}

function sidecarContent(assetName: string, transcripts: unknown): string {
  const data = { transcripts };
  return [
    '(function() {',
    `    const data = ${JSON.stringify(data)};`,
    `    window.globalLoadJsAsset('${assetName}', JSON.stringify(data));`,
    '})();',
    '',
  ].join('\n');
}

export interface SyntheticFixture {
  publishDir: string;
  asrDir: string;
}

export function makeSyntheticPublish(targetDir: string): SyntheticFixture {
  const publishDir = join(targetDir, 'publish');
  const asrDir = join(targetDir, 'asr');
  mkdirSync(join(publishDir, 'html5', 'data', 'js'), { recursive: true });
  mkdirSync(join(publishDir, 'html5', 'lib', 'framework'), { recursive: true });
  mkdirSync(join(publishDir, 'story_content'), { recursive: true });
  // Mobile image variants (the optional player sibling compose copies since
  // review PRR-226): real Storyline publishes emit these for image assets.
  mkdirSync(join(publishDir, 'mobile'), { recursive: true });
  mkdirSync(asrDir, { recursive: true });

  writeFileSync(
    join(publishDir, 'meta.xml'),
    '<?xml version="1.0" encoding="utf-8"?><meta title="SYN79 Course" duration="3m" viewslides="3"><project id="syn79proj" courseid="syn79course" /><author name="Synthetic Author" email="" website="" /></meta>\n',
    'utf8',
  );
  writeFileSync(
    join(publishDir, 'story.html'),
    '<!DOCTYPE html><html><head><title>SYN79</title></head><body>synthetic story player SYN79-STORY-MARKER</body></html>\n',
    'utf8',
  );
  writeFileSync(join(publishDir, 'html5', 'lib', 'framework', 'nested.js'), '// synthetic nested player asset SYN79-NESTED-MARKER\n', 'utf8');
  writeFileSync(join(publishDir, 'html5', 'lib', 'loader.js'), '// synthetic player loader SYN79-LOADER-MARKER\n', 'utf8');
  writeFileSync(join(publishDir, 'mobile', 'SYN79_slide_mobile.jpg'), 'synthetic mobile image variant SYN79-MOBILE-MARKER\n', 'utf8');

  const dataPayload = {
    slideCount: 3,
    scenes: [
      { isMessageScene: true, kind: 'scene', sceneNumber: 0, slides: [{ id: 'MSG', title: 'Resume Prompt' }] },
      {
        isMessageScene: false,
        kind: 'scene',
        sceneNumber: 1,
        lmsId: 'SC1',
        startingSlide: 'S1',
        slides: [{ id: 'S1', title: 'Intro', lmsId: 'S1', html5url: 'html5/data/js/S1.js', slideNumberInScene: 1 }],
      },
      {
        isMessageScene: false,
        kind: 'scene',
        sceneNumber: 2,
        lmsId: 'SC2',
        startingSlide: 'S2',
        slides: [
          { id: 'S2', title: 'Drill', lmsId: 'S2', html5url: 'html5/data/js/S2.js', slideNumberInScene: 1 },
          { id: 'S3', title: 'Review', lmsId: 'S3', html5url: 'html5/data/js/S3.js', slideNumberInScene: 2 },
        ],
      },
    ],
  };
  writeFileSync(join(publishDir, 'html5', 'data', 'js', 'data.js'), providePayload('data', dataPayload), 'utf8');

  const framePayload = {
    navData: {
      outline: {
        links: [
          { displaytext: 'Section One', links: [{ slideid: '_player.sec1.S1' }] },
          { displaytext: 'Section Two', links: [{ slideid: '_player.sec2.S2' }, { slideid: '_player.sec2.S3' }] },
        ],
      },
    },
  };
  writeFileSync(join(publishDir, 'html5', 'data', 'js', 'frame.js'), providePayload('frame', framePayload), 'utf8');

  writeFileSync(
    join(publishDir, 'html5', 'data', 'js', 'S1.js'),
    providePayload('slide', {
      id: 'S1',
      slideLayers: [
        {
          kind: 'layer',
          isBaseLayer: true,
          objects: [
            {
              kind: 'video',
              id: 'vidSide1',
              referenceName: 'vidSide1',
              data: { videodata: { altText: 'intro.mp4', lmstext: '', transcriptAssetId: 1 } },
            },
            { kind: 'shape', id: 'shp1', data: { vectorData: { altText: 'Quokka hydration checklist' } } },
          ],
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(publishDir, 'html5', 'data', 'js', 'S2.js'),
    providePayload('slide', {
      id: 'S2',
      slideLayers: [
        {
          kind: 'layer',
          isBaseLayer: true,
          objects: [
            {
              kind: 'shape',
              id: 'shp2',
              data: { vectorData: { altText: 'Wombat splint drill board' } },
              textLib: [{ vartext: { blocks: [{ spans: [{ text: 'Secure the splint with two straps.' }] }] } }],
            },
          ],
          audiolib: [{ kind: 'audio', id: 'audAsr2', assetId: 42 }],
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(publishDir, 'html5', 'data', 'js', 'S3.js'),
    providePayload('slide', {
      id: 'S3',
      slideLayers: [
        {
          kind: 'layer',
          isBaseLayer: true,
          objects: [{ kind: 'shape', id: 'shp3', data: { vectorData: { altText: 'Review the summary notes' } } }],
        },
      ],
    }),
    'utf8',
  );

  writeFileSync(
    join(publishDir, 'story_content', 'vidSide1_transcripts.js'),
    sidecarContent('vidSide1_transcripts.js', [
      {
        name: 'captions',
        cues: [
          { start: 0, text: 'Quokka hydration overview. ' },
          { start: 2400, text: 'Drink water at fixed intervals.' },
        ],
      },
    ]),
    'utf8',
  );
  writeFileSync(
    join(asrDir, 'audAsr2_transcripts.js'),
    sidecarContent('audAsr2_transcripts.js', [
      {
        name: 'captions',
        source: 'asr',
        model: 'distil-large-v3',
        cues: [
          { start_ms: 0, text: 'Wombat splint drill narration. ' },
          { start_ms: 1800, text: 'Tighten both straps firmly.' },
        ],
      },
    ]),
    'utf8',
  );

  return { publishDir, asrDir };
}
