/**
 * Phase 4.2 class guardrail (trace 35-residuals-chat-ux): user-visible copy
 * must not reference developer-facing repo documents that installed builds do
 * not ship. #35 C10's defect class surfaced 7 user-visible src/ sites, all
 * reworded to existing affordances, plus two SHIPPED packaging files
 * (public/models/README.md + manifest.json are copied to dist/ and into the
 * installer) whose dead-doc references this PR also removed. This spec pins
 * those surfaces clean of the class; it is a ratchet over the known sites,
 * not a repo-wide class scan (a new file with the same defect would not be
 * caught — review round PRR-012). Paths resolve from web_ui (CI's vitest
 * working directory); a different cwd fails closed with ENOENT rather than
 * passing silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** User-visible sources that previously referenced PACKAGING.md / packaging
 *  guide — pinned clean, including the AC4 pair (belt over the frozen c4/c4b
 *  checks, which pin the rendered overlay and the readiness source). */
const GUARDED_SOURCES = [
  'src/components/ModelBlockedOverlay.tsx',
  'src/lib/llm/model-readiness.ts',
  'src/pages/SettingsPage.tsx',
  'src/lib/inference/InferenceModeContext.tsx',
  'src/lib/llm/wllama-service.ts',
  'src/components/IsolationBanner.tsx',
  'public/models/README.md',
  'public/models/manifest.json',
];

describe('dead-doc reference guardrail (#35 C10 class)', () => {
  it('user-visible copy names no unshipped developer documents', () => {
    const offenders: string[] = [];
    for (const rel of GUARDED_SOURCES) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      // Only non-comment lines are user-visible copy: dev-facing code
      // comments legitimately cite repo-tree docs (RECORD disposition).
      const visible = src
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (/PACKAGING\.md|packaging guide|Packaging guide/i.test(visible)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `user-visible copy still references unshipped docs: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
