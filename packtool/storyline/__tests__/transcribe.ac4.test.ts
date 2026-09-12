// AC4 (issue #78) — normalized ASR cues feed the EXISTING D1 consumer with no
// ad-hoc shape adapter.
//
// packtool/storyline/transcribe.py writes `<asrDir>/<objectId>_transcripts.js`
// files in the SAME byte format as native story_content sidecars
// (`const data = {...}; window.globalLoadJsAsset(...)`), so resolveVideoRefs
// consumes them through the unchanged decodeSidecarAsset +
// sidecarTranscriptText path. This test pins that contract both ways:
// transcribe.py's output format (recreated here byte-compatibly) must decode
// with the existing decoder, and the resolver must distinguish transcript
// source 'asr' from 'sidecar' on that path. If D1 ever needed an adapter for
// ASR cues, this file fails.
//
// Case matrix (fix plan U5 / critic R6):
//   (a) audio-only slide WITH an ASR twin           -> 'asr' + exact text
//   (b) audio-only slide WITHOUT an ASR twin        -> 'missing'
//   (c) audio+video, video native sidecar wins      -> 'sidecar'
//   (d) unsafe audio object id                      -> treated absent ('missing')
//   (e) default path (no asrDir), audio object only -> 'none' (audio not scanned)
//   (f) video, no sidecar, no ASR twin              -> 'missing'
//   (g) video WITH an ASR twin, no native sidecar   -> 'asr' (videos resolve too)

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeSidecarAsset } from '../decode';
import { resolveVideoRefs } from '../video-refs';

const ASR_MODEL = 'distil-large-v3';

function asrSidecarContent(objectId: string, cues: Array<{ start_ms: number; text: string }>): string {
  // Byte-compatible with packtool/storyline/transcribe.py write_asr_sidecar().
  const data = {
    transcripts: [{ name: 'captions', source: 'asr', model: ASR_MODEL, cues }],
  };
  return [
    '(function() {',
    `    const data = ${JSON.stringify(data)};`,
    `    window.globalLoadJsAsset('${objectId}_transcripts.js', JSON.stringify(data));`,
    '})();',
    '',
  ].join('\n');
}

function nativeSidecarContent(cues: Array<{ start: number; text: string }>): string {
  const data = { transcripts: [{ name: 'captions', cues }] };
  return [
    '(function() {',
    `    const data = ${JSON.stringify(data)};`,
    `    window.globalLoadJsAsset('native_transcripts.js', JSON.stringify(data));`,
    '})();',
    '',
  ].join('\n');
}

function slidePayload(mediaObjects: Array<Record<string, unknown>>): object {
  return {
    id: 'syntheticSlide',
    slideLayers: [
      {
        kind: 'layer',
        objects: mediaObjects.filter((o) => o['kind'] === 'video'),
        audiolib: mediaObjects.filter((o) => o['kind'] === 'audio'),
      },
    ],
  };
}

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac4-asr-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('AC4: ASR transcript store feeds the D1 consumer without an adapter', () => {
  it('ASR store file round-trips through the EXISTING decoder + text concatenation', () => {
    const decoded = decodeSidecarAsset(
      asrSidecarContent('audObj1', [
        { start_ms: 1056, text: 'Select the ' },
        { start_ms: 2100, text: 'ProC button.' },
      ]),
    );
    const text = JSON.parse(JSON.stringify(decoded)) as { transcripts: Array<{ cues: Array<{ text: string }> }> };
    const out = text.transcripts
      .map((t) => t.cues)
      .reduce<string>((acc, cues) => acc + cues.map((c) => c.text).join(''), '');
    expect(out).toBe('Select the ProC button.');
  });

  it('(a) audio-only slide with an ASR twin resolves asr with the exact cue text', () => {
    const publish = makeTmp();
    const asrDir = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    writeFileSync(join(asrDir, 'audNarr7_transcripts.js'), asrSidecarContent('audNarr7', [
      { start_ms: 0, text: 'Wash hands ' },
      { start_ms: 1500, text: 'before the procedure.' },
    ]));
    const payload = slidePayload([{ kind: 'audio', id: 'audNarr7', assetId: 3 }]);
    const refs = resolveVideoRefs(payload, publish, { asrDir });
    expect(refs.transcriptSource).toBe('asr');
    expect(refs.transcriptText).toBe('Wash hands before the procedure.');
    expect(refs.narrationRef).toBe('audNarr7_transcripts.js');
  });

  it('(b) audio-only slide without an ASR twin (overlay set) is missing', () => {
    const publish = makeTmp();
    const asrDir = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    const payload = slidePayload([{ kind: 'audio', id: 'audNoTwin', assetId: 4 }]);
    const refs = resolveVideoRefs(payload, publish, { asrDir });
    expect(refs.transcriptSource).toBe('missing');
  });

  it('(c) audio+video slide: the native video sidecar wins over the audio ASR twin', () => {
    const publish = makeTmp();
    const asrDir = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    writeFileSync(join(publish, 'story_content', 'vidSide_transcripts.js'), nativeSidecarContent([
      { start: 0, text: 'Native video caption.' },
    ]));
    writeFileSync(join(asrDir, 'audTwin_transcripts.js'), asrSidecarContent('audTwin', [
      { start_ms: 0, text: 'Asr audio text.' },
    ]));
    const payload = slidePayload([
      { kind: 'video', id: 'vidSide', data: { videodata: { assetId: 8 } } },
      { kind: 'audio', id: 'audTwin', assetId: 9 },
    ]);
    const refs = resolveVideoRefs(payload, publish, { asrDir });
    expect(refs.transcriptSource).toBe('sidecar');
    expect(refs.transcriptText).toBe('Native video caption.');
    expect(refs.narrationRef).toBe('story_content/vidSide_transcripts.js');
  });

  it('(d) unsafe audio object id is refused (treated absent), never joined into a path', () => {
    const publish = makeTmp();
    const asrDir = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    const payload = slidePayload([{ kind: 'audio', id: '../escape', assetId: 5 }]);
    const refs = resolveVideoRefs(payload, publish, { asrDir });
    expect(refs.transcriptSource).toBe('missing');
  });

  it('(e) default path (no asrDir) never scans audio objects: audio-only slide is none', () => {
    const publish = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    const payload = slidePayload([{ kind: 'audio', id: 'audQuiet', assetId: 6 }]);
    const refs = resolveVideoRefs(payload, publish);
    expect(refs.transcriptSource).toBe('none');
    expect(refs.narrationRef).toBeUndefined();
  });

  it('(f) video with no sidecar and no ASR twin (overlay set) is missing', () => {
    const publish = makeTmp();
    const asrDir = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    const payload = slidePayload([{ kind: 'video', id: 'vidAlone', data: { videodata: { assetId: 7 } } }]);
    const refs = resolveVideoRefs(payload, publish, { asrDir });
    expect(refs.transcriptSource).toBe('missing');
  });

  it('(g) video with an ASR twin and no native sidecar resolves asr', () => {
    const publish = makeTmp();
    const asrDir = makeTmp();
    mkdirSync(join(publish, 'story_content'), { recursive: true });
    writeFileSync(join(asrDir, 'vidAsr_transcripts.js'), asrSidecarContent('vidAsr', [
      { start_ms: 100, text: 'Asr video narration.' },
    ]));
    const payload = slidePayload([{ kind: 'video', id: 'vidAsr', data: { videodata: { assetId: 10 } } }]);
    const refs = resolveVideoRefs(payload, publish, { asrDir });
    expect(refs.transcriptSource).toBe('asr');
    expect(refs.transcriptText).toBe('Asr video narration.');
    expect(refs.narrationRef).toBe('vidAsr_transcripts.js');
  });
});
