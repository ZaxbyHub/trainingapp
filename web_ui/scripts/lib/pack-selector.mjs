/**
 * pack-selector.mjs — the bundled-pack source selector for the WEB build
 * (issue #266, prepare-packs.mjs).
 *
 * Side-effect-free: importing this module touches nothing on disk. Every root
 * is injected, so the committed spec can pin every mode without
 * machine-local state.
 *
 * EXACT desktop parity with desktop/scripts/stage-installer-resources.mjs
 * (resolveStagedPacks + checkKnowledgePackSource + checkTrainingPackSource):
 *   - operator root `desktop/knowledge-pack-src/` present  → BOTH packs are
 *     required (the docs pack dir AND the training pack dir below); a missing
 *     pack.json in either is a LOUD failure naming the pack, never a silent
 *     fixture fallback;
 *   - unexpected directory names under the operator root are LOUD failures
 *     (anything that is not the pinned docs dir or an `opmed-cdp-mlc-*`
 *     training dir; and any `opmed-cdp-mlc-*` dir other than the pinned
 *     version);
 *   - operator root wholly ABSENT (CI, weights-less checkouts) → the SILENT
 *     fallback to the `contracts/fixtures/packs/bundled-min` fixture
 *     (maintainer decision, comment 6825526111: same pack set as desktop,
 *     which stages the fixture docs pack alone in that mode);
 *   - the fixture fallback applies ONLY to a wholly absent root — a
 *     half-built operator tree is an error, not an escape hatch.
 *
 * The desktop stager keeps its own copy of these semantics (no desktop/
 * source change in this issue); the two MUST stay in lockstep — the desktop
 * e133 boot-gate floor and the web prepare-packs specs pin each side.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Pinned docs pack directory (desktop parity: stage-installer-resources.mjs). */
export const DOCS_PACK_DIR = 'opmed-initial-1.0.0';

/** Pinned training pack version (desktop parity: opmed-cdp-mlc-1.0.1). */
export const TRAINING_PACK_VERSION = '1.0.1';

/** Pinned training pack directory. */
export const TRAINING_PACK_DIR = `opmed-cdp-mlc-${TRAINING_PACK_VERSION}`;

/**
 * @typedef {Object} SelectedPackSource
 * @property {string} source Absolute directory holding a built pack (pack.json at its root).
 * @property {string} classDir Desktop-parity class label ('bundled-docs' | 'training').
 */

/**
 * Resolve which pack source directories the web build stages.
 *
 * @param {object} opts
 * @param {string} opts.knowledgePackSrcRoot The operator root (desktop/knowledge-pack-src).
 * @param {string} opts.fixturePackSource The bundled-min fixture directory.
 * @param {string} [opts.docsPackDir] Override for the pinned docs dir (tests).
 * @param {string} [opts.trainingPackDir] Override for the pinned training dir (tests).
 * @param {(p: string) => boolean} [opts.existsSync] Existence seam (tests).
 * @param {(dir: string) => string[]} [opts.readDirNames] Directory-name seam (tests).
 * @param {(message: string) => void} [opts.onProblem] Loud-failure collector.
 * @returns {{packs: SelectedPackSource[], source: 'operator'|'fixture'|'empty'}}
 */
export function resolveBundledPackSources(opts) {
  const {
    knowledgePackSrcRoot,
    fixturePackSource,
    docsPackDir = DOCS_PACK_DIR,
    trainingPackDir = TRAINING_PACK_DIR,
    existsSync = (p) => fs.existsSync(p),
    readDirNames = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    onProblem = () => {},
  } = opts;

  if (!existsSync(knowledgePackSrcRoot)) {
    // Wholly absent operator root: the SILENT fixture fallback (the ONLY
    // fallback path — desktop parity).
    return { packs: [{ source: fixturePackSource, classDir: 'bundled-docs' }], source: 'fixture' };
  }

  // Desktop parity: unexpected directory names under the operator root fail
  // loud. opmed-cdp-mlc-* is the training pack (governed by its own pinned
  // version check below); anything else that is not the pinned docs dir is a
  // version-skew/stale-tree error, never a silently staged mismatch.
  for (const name of readDirNames(knowledgePackSrcRoot)) {
    if (name !== docsPackDir && !name.startsWith('opmed-cdp-mlc-')) {
      onProblem(
        `unexpected pack dir ${knowledgePackSrcRoot}/${name} (this stager pins ${docsPackDir}; rebuild with the pinned version or clear the dir — never silently stage a mismatched pack)`,
      );
    }
  }
  for (const name of readDirNames(knowledgePackSrcRoot)) {
    if (name.startsWith('opmed-cdp-mlc') && name !== trainingPackDir) {
      onProblem(
        `unexpected training pack dir ${knowledgePackSrcRoot}/${name} (this stager pins ${trainingPackDir}; rebuild with the pinned version or clear the dir — never silently stage a mismatched course)`,
      );
    }
  }

  const packs = [];
  const docsSource = path.join(knowledgePackSrcRoot, docsPackDir);
  const trainingSource = path.join(knowledgePackSrcRoot, trainingPackDir);
  const docsBuilt = existsSync(path.join(docsSource, 'pack.json'));
  const trainingBuilt = existsSync(path.join(trainingSource, 'pack.json'));
  if (docsBuilt) {
    packs.push({ source: docsSource, classDir: 'bundled-docs' });
  } else {
    onProblem(
      `docs pack missing: ${knowledgePackSrcRoot}/${docsPackDir}/pack.json not found ` +
        `(run node desktop/scripts/build-knowledge-pack.mjs, or remove the operator root to stage the fixture set)`,
    );
  }
  if (trainingBuilt) {
    packs.push({ source: trainingSource, classDir: 'training' });
  } else {
    onProblem(
      `training pack missing: ${knowledgePackSrcRoot}/${trainingPackDir}/pack.json not found ` +
        `(run node desktop/scripts/build-training-pack.mjs — the build must bundle the Articulate course alongside the documents; ` +
        `or remove the operator root to stage the fixture set)`,
    );
  }
  return { packs, source: 'operator' };
}
