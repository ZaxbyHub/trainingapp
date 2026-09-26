/**
 * Bundled-pack satisfaction predicate (#133 round 7 review finding 2).
 *
 * Shared by the wizard's complete gate and the boot-time ensure
 * (desktop/main/index.ts ensureBundledPacks). A manifest pack entry is
 * satisfied when an INSTALLED+ACTIVE record for the id is at the entry's
 * version OR NEWER — semver 2.0.0 precedence via pack-manager's comparator.
 *
 * "Or newer" is deliberate: the Documents page supports installing a newer
 * pack zip over a bundled one (TrainingPage advertises exactly that), and the
 * boot ensure must then treat the user's newer pack as satisfying the
 * manifest instead of attempting a downgrade install that pack-manager
 * refuses — which would otherwise log a boot failure on EVERY launch for a
 * fully supported flow. The old strict-equality check had exactly that bug.
 */
import { compareVersionKeys, versionKey } from '../backend/store/pack-manager.js';

export interface BundledPackEntry {
  id: string;
  version?: string;
}

export interface InstalledPackRecord {
  id: string;
  version: string;
  active: boolean;
}

export function isBundledPackSatisfied(
  entry: BundledPackEntry,
  installed: InstalledPackRecord[],
): boolean {
  return installed.some(
    (record) =>
      record.id === entry.id &&
      record.active &&
      (entry.version === undefined ||
        compareVersionKeys(versionKey(record.version), versionKey(entry.version)) >= 0),
  );
}

/** Result shape of the boot-ensure run (ensureBundledPacks in main/index.ts). */
export interface EnsureBundledPacksResult {
  ok: boolean;
  detail?: string;
  results: Array<{ id: string; ok: boolean; detail: string }>;
}

/**
 * The boot-time bundled-pack GATE, extracted so the decision is unit-pinnable
 * (review PRR-201/PRR-207: the round-6 ensure shipped with the gate predicate
 * untested — an inverted gate would silently reproduce the empty-Training-tab
 * bug on exactly the existing installs the fix targets).
 *
 * Fires `run()` (the ensure) ONLY when the store has a COMPLETED first run —
 * a not-yet-set-up store installs its packs through the wizard instead, and
 * double-installing from both paths is wasteful churn. Drift/reset reruns keep
 * completed=true, so the ensure still fires there (self-healing). Never
 * throws: run() rejections are routed to `log` as errors.
 *
 * @returns whether the ensure was fired.
 */
export function ensureBundledPacksAtBoot(
  firstRunCompleted: boolean,
  run: () => Promise<EnsureBundledPacksResult>,
  log: (line: string, level: 'info' | 'error') => void,
): boolean {
  if (!firstRunCompleted) return false;
  void run()
    .then((r) => {
      const installedNow = r.results.filter((x) => x.ok && x.detail.startsWith('installed '));
      const failed = r.results.filter((x) => !x.ok);
      if (installedNow.length > 0) {
        log(
          `[trainingapp-desktop] bundled packs ensured at boot: ${installedNow.map((x) => x.detail).join('; ')}`,
          'info',
        );
      }
      if (failed.length > 0) {
        log(
          `[trainingapp-desktop] bundled pack ensure failed: ${failed.map((x) => `${x.id}: ${x.detail}`).join('; ')}`,
          'error',
        );
      }
      // Early exits (no pack lifecycle / no staged manifest) return no
      // results — name the skip instead of failing silently (round-7
      // review note). Dev trees without a manifest hit this every boot.
      if (installedNow.length === 0 && failed.length === 0 && r.detail !== undefined) {
        log(`[trainingapp-desktop] bundled pack ensure skipped: ${r.detail}`, 'info');
      }
    })
    .catch((err: unknown) => {
      log(
        `[trainingapp-desktop] bundled pack ensure crashed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    });
  return true;
}
