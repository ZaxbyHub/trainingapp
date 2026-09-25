/**
 * e133-stager-both-packs.test.ts — #133 round 4: when the operator built BOTH
 * the documents pack and the Articulate training pack, the stager stages BOTH
 * (classDirs bundled-docs + training) and the installer manifest lists both;
 * without the training source the docs-only/fixture set applies. Pins the
 * staged manifest — environment-adaptive by construction (the staging itself
 * is a build-time step, not importable with overrides).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('bundled docs + training staging (#133 round 4)', () => {
  it('manifest reflects both packs when both sources were built; docs-only otherwise', () => {
    const manifestPath = path.join(REPO_ROOT, 'desktop', 'installer-resources', 'manifest.json');
    expect(fs.existsSync(manifestPath), 'a staged manifest must exist (run the stager once)').toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      packs: Array<{ id: string; dir: string; source_class: string }>;
    };
    const ids = manifest.packs.map((entry) => entry.id).sort();
    const trainingBuilt = fs.existsSync(
      path.join(REPO_ROOT, 'desktop', 'knowledge-pack-src', 'opmed-cdp-mlc-1.0.0', 'pack.json'),
    );
    if (trainingBuilt) {
      expect(ids).toEqual(['opmed-cdp-mlc', 'opmed-initial']);
      const training = manifest.packs.find((entry) => entry.id === 'opmed-cdp-mlc');
      expect(training?.source_class).toBe('training');
      expect(training?.dir).toBe('training/opmed-cdp-mlc-1.0.0');
    } else {
      // Docs-only or fixture mode: the training pack must NEVER silently
      // appear from anywhere else.
      expect(ids).not.toContain('opmed-cdp-mlc');
    }
  });
});
