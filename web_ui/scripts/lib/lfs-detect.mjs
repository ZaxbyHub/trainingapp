/**
 * Git-LFS pointer detection helper, shared between prepare-models.mjs and tests.
 *
 * An LFS pointer file is a tiny text stub that begins with the spec header
 * `version https://git-lfs.github.com/spec/v1` (≈134 bytes total). Real model
 * binaries never start with that ASCII prefix, so reading the first N bytes is
 * a reliable, cheap discriminator.
 */

import { openSync, readSync, closeSync } from 'node:fs';

/** The exact ASCII prefix of every Git-LFS pointer file. */
export const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/**
 * Detect whether a file is a Git-LFS pointer stub by reading its first bytes.
 *
 * @param {string} filePath Absolute or relative path to the file to inspect.
 * @returns {boolean} true when the file begins with the LFS pointer header.
 */
export function isLfsPointer(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(LFS_POINTER_PREFIX.length);
    const bytesRead = readSync(fd, buf, 0, LFS_POINTER_PREFIX.length, 0);
    if (bytesRead < LFS_POINTER_PREFIX.length) return false;
    return buf.toString('utf8') === LFS_POINTER_PREFIX;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
