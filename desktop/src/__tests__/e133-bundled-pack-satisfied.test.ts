// e133-bundled-pack-satisfied.test.ts — issue #133 round 7 review finding 2/3:
// the bundled-pack satisfaction predicate shared by the wizard's complete
// gate and the boot-time ensure. The strict-equality version check it
// replaces had two real bugs: a store holding a NEWER user-installed pack
// (the Documents-page update flow the UI advertises) made the boot ensure
// attempt a downgrade install pack-manager refuses — a boot-failure log on
// EVERY launch — and the wizard's complete gate could neither complete nor be
// satisfied in the same state.
import { describe, expect, it } from 'vitest';
import { isBundledPackSatisfied } from '../../main/first-run/bundled-packs';

const entry = (id: string, version?: string) => ({ id, ...(version !== undefined ? { version } : {}) });
const record = (id: string, version: string, active: boolean) => ({ id, version, active });

describe('isBundledPackSatisfied (#133 round 7)', () => {
  it('exact version, installed and active -> satisfied', () => {
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [record('p', '1.0.1', true)])).toBe(true);
  });

  it('not installed -> not satisfied', () => {
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [])).toBe(false);
  });

  it('installed but INACTIVE -> not satisfied (the boot ensure must activate it)', () => {
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [record('p', '1.0.1', false)])).toBe(false);
  });

  it('older active version -> NOT satisfied (bundled upgrade installs over it)', () => {
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [record('p', '1.0.0', true)])).toBe(false);
  });

  it('NEWER active version -> satisfied (user updated via zip; never attempt a downgrade install)', () => {
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [record('p', '1.0.2', true)])).toBe(true);
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [record('p', '2.0.0', true)])).toBe(true);
  });

  it('multiple rows for the id (post-upgrade dual state): satisfied is decided by the ACTIVE row', () => {
    const dual = [record('p', '1.0.0', false), record('p', '1.0.1', true)];
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), dual)).toBe(true);
    expect(isBundledPackSatisfied(entry('p', '1.0.2'), dual)).toBe(false);
  });

  it('entry without a version pins only presence+activation', () => {
    expect(isBundledPackSatisfied(entry('p'), [record('p', '9.9.9', true)])).toBe(true);
    expect(isBundledPackSatisfied(entry('p'), [record('other', '1.0.0', true)])).toBe(false);
  });

  it('semver precedence passthrough: pre-release sorts below its release', () => {
    expect(isBundledPackSatisfied(entry('p', '1.0.1'), [record('p', '1.0.1-beta.1', true)])).toBe(false);
    expect(isBundledPackSatisfied(entry('p', '1.0.1-beta.1'), [record('p', '1.0.1', true)])).toBe(true);
    // numeric (not lexicographic) segments: 1.0.9 < 1.0.10
    expect(isBundledPackSatisfied(entry('p', '1.0.10'), [record('p', '1.0.9', true)])).toBe(false);
    expect(isBundledPackSatisfied(entry('p', '1.0.9'), [record('p', '1.0.10', true)])).toBe(true);
  });
});
