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
