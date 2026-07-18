/**
 * Issue #37 P5 (+ PR-A seam): shared duplicate-upload guard.
 *
 * Extracted from DocumentsPage.tsx so both the ingestion path and any future
 * Replace-affordance (PR-A) share one definition of "is this upload a
 * duplicate." A file is a duplicate when an existing or already-accepted entry
 * has the same fileName + fileSize — UNLESS that entry has zero chunks, in
 * which case the upload is allowed through (it's a re-index after a
 * VECTOR_INDEX_VERSION bump that wiped vectors while the doc record survived;
 * the re-add banner instructs the user to re-upload, and the legacy guard
 * would have blocked exactly that flow).
 */

import type { DocumentEntry } from '../../types/document';

/** A minimal entry shape the guard needs (works with DocumentEntry or an
 *  in-progress accepted entry that hasn't been promoted yet). */
export interface DuplicateGuardEntry {
  fileName: string;
  fileSize: number;
  /** Optional chunk count. Entries with chunkCount === 0 are treated as
   *  vector-less and bypass the duplicate check (see file header). */
  chunkCount?: number;
}

/**
 * Returns true if `file` duplicates an existing or already-accepted entry by
 * fileName + fileSize. The bypass for vector-less docs applies ONLY when
 * `chunkCount === 0` EXPLICITLY (the re-index-after-version-bump case where
 * the doc record survived but its vectors were wiped). An entry with
 * `chunkCount === undefined` (legacy records that never carried the field, or
 * a doc mid-processing) is still treated as a duplicate — matching the
 * pre-R8 behavior the F5 test asserts.
 */
export function isDuplicateUpload(
  fileName: string,
  fileSize: number,
  existing: ReadonlyArray<DuplicateGuardEntry | DocumentEntry>,
  accepted: ReadonlyArray<DuplicateGuardEntry | DocumentEntry> = []
): boolean {
  const matches = (e: DuplicateGuardEntry | DocumentEntry): boolean => {
    if (e.fileName !== fileName || e.fileSize !== fileSize) return false;
    // Only bypass when chunkCount is EXPLICITLY zero (re-index case). Undefined
    // or positive → duplicate as before.
    if (e.chunkCount === 0) return false;
    return true;
  };
  return existing.some(matches) || accepted.some(matches);
}
