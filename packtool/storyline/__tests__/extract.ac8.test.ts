// AC8 — Negative-path coverage for the CLI and decode layer, issue #77.
//
// PRR feedback fixes:
// - PRR-001: path-traversal rejection at slideId, html5url, and video object
//   id (all three are untrusted fields from the third-party publish). The
//   extraction refuses unsafe values rather than silently escaping.
// - PRR-008: outline-absent slides emit section_title "<unassigned>" and
//   provenance "<unassigned> > Slide N" rather than a bare empty-string shape.
// - PRR-010: CLI exits 2 on missing/incorrect arguments and exits 1 on a
//   missing publishDir.
// - PRR-011: decodeGlobalProvideData throws a clear "unterminated" error when
//   the payload's closing quote is missing.
// - PRR-014: outline.scene_count must use the non-message scene count from
//   data.js, NOT a Set of walked scene numbers.
//
// Frozen contract under test:
//   import { decodeGlobalProvideData } from '../decode'
//     decodeGlobalProvideData(payloadName, text, sourcePath?): unknown
//   import { extractPublishDir } from '../extract' (PRR-001/002/003/008/014)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeGlobalProvideData } from '../decode';
import { extractPublishDir } from '../extract';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI = join(REPO_ROOT, 'packtool', 'dist', 'cli.js');

describe('AC8: CLI negative paths and decode unterminated-payload', () => {
  beforeAll(() => {
    // AC8 spawns cli.js in the bad-args test; ensure the build is current.
    const res = spawnSync('npm', ['run', 'build', '--prefix', 'packtool'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(
      res.status,
      `packtool build failed: ${res.stderr ?? res.stdout}`,
    ).toBe(0);
  });

  it('CLI exits 2 with usage on bad arguments (missing --out)', () => {
    const res = spawnSync(process.execPath, [CLI, 'storyline', 'extract', 'tests/fixtures/storyline-mini'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr ?? '').toContain('usage');
  });

  it('CLI exits 1 when publishDir does not exist', () => {
    const res = spawnSync(
      process.execPath,
      [CLI, 'storyline', 'extract', 'tests/fixtures/__does_not_exist__', '--out', mkdtempSync(join(tmpdir(), 'packtool-ac8-'))],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(res.status).toBe(1);
    expect(res.stderr ?? '').toMatch(/fail|enoent|not exist|missing/i);
  });

  it('PRR-011: decodeGlobalProvideData throws on UNTERMINATED payload', () => {
    // Window opened but the closing quote never appears.
    const malformed = `window.globalProvideData('slide', 'this never closes`;
    expect(() => decodeGlobalProvideData('slide', malformed)).toThrow(/unterminated/);
  });

  it('PRR-014: scene_count reflects non-message scene count, not walked Set', () => {
    // Synthetic publish with 1 message scene + 1 empty content scene + 1
    // populated content scene (2 non-message). Walked Set-based count would
    // return 1 (only the populated scene's sceneNumber enters the Set); the
    // fix walks the scene array and counts non-message scenes (returns 2).
    const tmpPublish = mkdtempSync(join(tmpdir(), 'packtool-ac8-pub-'));
    const tmpOut = mkdtempSync(join(tmpdir(), 'packtool-ac8-out-'));
    try {
      mkdirSync(join(tmpPublish, 'html5', 'data', 'js'), { recursive: true });
      mkdirSync(join(tmpPublish, 'html5', 'data', 'js'), { recursive: true });
      writeFileSync(join(tmpPublish, 'meta.xml'), `<?xml version="1.0" encoding="utf-8"?><meta title="SYN" duration="1m" viewslides="2"></meta>`, 'utf-8');
      // Minimal data.js with the empty-slides content scene
      const dataPayload = {
        slideCount: 2,
        scenes: [
          { isMessageScene: true, kind: 'scene', sceneNumber: 0, slides: [{ id: 'MSG', title: 'Msg' }] },
          { isMessageScene: false, kind: 'scene', sceneNumber: 1, slides: [] },
          { isMessageScene: false, kind: 'scene', sceneNumber: 2, slides: [{ id: 'X1', title: 'X1', lmsId: 'S1', html5url: 'html5/data/js/X1.js', slideNumberInScene: 1 }] },
        ],
      };
      const dataJson = JSON.stringify(dataPayload);
      writeFileSync(
        join(tmpPublish, 'html5', 'data', 'js', 'data.js'),
        `window.globalProvideData('data', '${dataJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      // Empty frame.js (no outline entries — sectionTitle falls back to <unassigned>)
      const framePayload = { navData: { outline: { links: [] } } };
      const frameJson = JSON.stringify(framePayload);
      writeFileSync(
        join(tmpPublish, 'html5', 'data', 'js', 'frame.js'),
        `window.globalProvideData('frame', '${frameJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      // Minimal slide file for X1
      writeFileSync(
        join(tmpPublish, 'html5', 'data', 'js', 'X1.js'),
        `window.globalProvideData('slide', '${JSON.stringify({ id: 'X1', slideLayers: [] }).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );

      extractPublishDir(tmpPublish, tmpOut);
      const outline = JSON.parse(
        require('node:fs').readFileSync(join(tmpOut, 'outline.json'), 'utf-8'),
      ) as { scene_count: number; sections: Array<{ title: string; slide_count: number }> };
      expect(outline.scene_count).toBe(2); // non-message scene count, not walked Set
    } finally {
      rmSync(tmpPublish, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('PRR-008: outline-absent slide emits section_title "<unassigned>" and provenance "<unassigned> > Slide N"', () => {
    const tmpPublish = mkdtempSync(join(tmpdir(), 'packtool-ac8-unassigned-'));
    const tmpOut = mkdtempSync(join(tmpdir(), 'packtool-ac8-unassigned-out-'));
    try {
      mkdirSync(join(tmpPublish, 'html5', 'data', 'js'), { recursive: true });
      writeFileSync(
        join(tmpPublish, 'meta.xml'),
        '<?xml version="1.0" encoding="utf-8"?><meta title="SYN" duration="1m" viewslides="1"></meta>',
        'utf-8',
      );
      // Single content slide whose id is absent from any frame.js outline.
      const dataPayload = {
        slideCount: 1,
        scenes: [
          {
            isMessageScene: false, kind: 'scene', lmsId: '', sceneNumber: 1,
            startingSlide: 'S',
            slides: [{ id: 'UNASSIGNED_SLIDE', title: 'T', lmsId: 'S', html5url: 'html5/data/js/S.js', slideNumberInScene: 1 }],
          },
        ],
      };
      const dataJson = JSON.stringify(dataPayload);
      writeFileSync(
        join(tmpPublish, 'html5', 'data', 'js', 'data.js'),
        `window.globalProvideData('data', '${dataJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      // Empty frame.js outline.
      writeFileSync(
        join(tmpPublish, 'html5', 'data', 'js', 'frame.js'),
        `window.globalProvideData('frame', '${JSON.stringify({ navData: { outline: { links: [] } } }).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      writeFileSync(
        join(tmpPublish, 'html5', 'data', 'js', 'S.js'),
        `window.globalProvideData('slide', '${JSON.stringify({ id: 'S', slideLayers: [] }).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );

      extractPublishDir(tmpPublish, tmpOut);
      const doc = JSON.parse(
        require('node:fs').readFileSync(
          join(tmpOut, 'slides', 'slide-001-UNASSIGNED_SLIDE.json'),
          'utf-8',
        ),
      ) as { section_title: string; provenance: string };
      expect(doc.section_title).toBe('<unassigned>');
      expect(doc.provenance).toBe('<unassigned> > Slide 1');
    } finally {
      rmSync(tmpPublish, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('PRR-001: extractPublishDir refuses unsafe slideId, unsafe html5url, and unsafe video id', () => {
    // Helper: build a minimal publish with one content slide whose id and
    // html5url and video object id are individually configured by the caller.
    function buildPublish(slideId: string, html5url: string, videoId: string | null): string {
      const tmp = mkdtempSync(join(tmpdir(), 'packtool-ac8-evil-'));
      mkdirSync(join(tmp, 'html5', 'data', 'js'), { recursive: true });
      writeFileSync(
        join(tmp, 'meta.xml'),
        '<?xml version="1.0" encoding="utf-8"?><meta title="SYN" duration="1m" viewslides="1"></meta>',
        'utf-8',
      );
      const slideObjects: object[] = [];
      if (videoId !== null) {
        slideObjects.push({
          kind: 'video', id: videoId, referenceName: videoId,
          data: { videodata: { altText: 'video.mp4', lmstext: '', transcriptAssetId: 1 } },
        });
      }
      // html5url must start with 'html5/' for extractPublishDir's check;
      // the test payloads various malicious values in the html5url field —
      // the slide file itself is written to a safe location under html5/.
      const safeHtml5url = 'html5/data/js/S.js';
      const dataPayload = {
        slideCount: 1,
        scenes: [
          {
            isMessageScene: false, kind: 'scene', lmsId: '', sceneNumber: 1,
            startingSlide: slideId,
            slides: [{ id: slideId, title: 'T', lmsId: 'S', html5url, slideNumberInScene: 1 }],
          },
        ],
      };
      const dataJson = JSON.stringify(dataPayload);
      writeFileSync(
        join(tmp, 'html5', 'data', 'js', 'data.js'),
        `window.globalProvideData('data', '${dataJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      writeFileSync(
        join(tmp, 'html5', 'data', 'js', 'frame.js'),
        `window.globalProvideData('frame', '${JSON.stringify({ navData: { outline: { links: [] } } }).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      writeFileSync(
        join(tmp, safeHtml5url),
        `window.globalProvideData('slide', '${JSON.stringify({ id: slideId, slideLayers: [{ isBaseLayer: true, kind: 'layer', objects: slideObjects }] }).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`,
        'utf-8',
      );
      return tmp;
    }
    function expectRefused(slideId: string, html5url: string, videoId: string | null): void {
      const tmpPublish = buildPublish(slideId, html5url, videoId);
      const tmpOut = mkdtempSync(join(tmpdir(), 'packtool-ac8-evil-out-'));
      try {
        expect(
          () => extractPublishDir(tmpPublish, tmpOut),
          `expected refuse: slideId=${slideId} html5url=${html5url} videoId=${videoId ?? 'none'}`,
        ).toThrow();
      } finally {
        rmSync(tmpPublish, { recursive: true, force: true });
        rmSync(tmpOut, { recursive: true, force: true });
      }
    }

    // slideId escapes
    expectRefused('../../../tmp/evil', 'html5/data/js/S.js', null);
    expectRefused('S/x', 'html5/data/js/S.js', null);
    // html5url escapes
    expectRefused('S', '../../../etc/passwd', null);
    expectRefused('S', 'html5/../../etc/passwd', null);
    expectRefused('S', 'html5/data/js/.././../tmp/x.js', null);
    // video object id escapes — refused via the same path-safety check
    // (the slide ITSELF still emits, but transcriptSource is 'missing').
    const tmpPub = buildPublish('S', 'html5/data/js/S.js', '../../../outside/evil');
    const tmpOut = mkdtempSync(join(tmpdir(), 'packtool-ac8-vid-evil-out-'));
    try {
      expect(() => extractPublishDir(tmpPub, tmpOut)).not.toThrow();
      const doc = JSON.parse(
        require('node:fs').readFileSync(join(tmpOut, 'slides', 'slide-001-S.json'), 'utf-8'),
      ) as { transcript_source: string; narration_ref?: string };
      expect(doc.transcript_source).toBe('missing');
      expect(doc.narration_ref).toBeUndefined();
    } finally {
      rmSync(tmpPub, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('PRR-006: decode errors carry the source file path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'packtool-ac8-path-'));
    try {
      const badPath = join(tmp, 'malformed.js');
      writeFileSync(badPath, '// no globalProvideData wrapper here\n', 'utf-8');
      let captured: unknown;
      try {
        decodeGlobalProvideData('slide', require('node:fs').readFileSync(badPath, 'utf8'), badPath);
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toContain(badPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
