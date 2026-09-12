// AC8 — Negative-path coverage for the CLI and decode layer, issue #77.
//
// PRR feedback fixes:
// - PRR-010: CLI exits 2 on missing/incorrect arguments and exits 1 on a
//   missing publishDir; we exercise both via direct imports (cli.ts's argv guard
//   at the bottom of the file prevents main() from running when imported).
// - PRR-011: decodeGlobalProvideData throws a clear "unterminated" error when
//   the payload's closing quote is missing; the only AC3 case covers the
//   absent-wrapper case.
// - PRR-014: outline.scene_count must use the non-message scene count from
//   data.js, NOT a Set of walked scene numbers (which silently drops empty
//   content-scene payloads).
//
// Frozen contract under test:
//   import { main as cliMain } from '../../cli'  — guarded against module-scope
//     exit; we wrap process.exit / console.error to capture behavior.
//   import { decodeGlobalProvideData } from '../decode'
//     decodeGlobalProvideData(payloadName: string, text: string): unknown
//   import { extractPublishDir } from '../extract' (for AC14)

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
        `window.globalProvideData('slide', '${JSON.stringify({ id: 'X1', slideLayers: [] }).replace(/'/g, "\\'")}');`,
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
});
