// C7 (issue #74): safe server-side extraction of an uploaded .zip knowledge
// pack into a temp folder, so PackManager.install() keeps its folder-only
// contract (the managers refuse zips by design; C8 owns deeper hardening).
//
// Guard set (mirrored by the Python side in api_server.py — keep both
// matrices identical; both are pinned by tests):
//   G1 the archive must contain a root-level `pack.json` manifest (the C1
//      manifest-presence check; the manager's schema validation runs next),
//   G2 every entry path is relative, forward-slash only, and stays inside the
//      extraction dir (no absolute paths, no `..` segments, no backslashes),
//   G3 symlink-attribute entries are refused (attrs & 0x10 on the external
//      attributes in the Node reader; Python uses ZipInfo external_attr),
//   G4 total uncompressed bytes are capped (PACK_ZIP_MAX_UNCOMPRESSED_BYTES).
// Everything else about the pack (schema validity, sha256s, embedding
// compatibility, path safety INSIDE docs[]) remains PackManager.install()'s
// existing validation surface.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PackManagerError } from '../store/pack-manager.js';

export const PACK_ZIP_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export function isZipFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith('.zip');
}

export function isSymlinkEntry(unixPermissions: number | string | undefined): boolean {
  // Unix-style archives carry the file mode: S_IFLNK = 0o120000 marks a
  // symlink. DOS-style archives have no symlink representation (directory
  // entries carry the dosPermissions dir bit and are skipped via entry.dir
  // before this check matters).
  const perms =
    typeof unixPermissions === 'string' ? parseInt(unixPermissions, 8) : unixPermissions;
  return typeof perms === 'number' && perms !== 0 && (perms & 0o170000) === 0o120000;
}

/**
 * Extract a pack zip into a fresh temp directory and return its path. The
 * caller owns cleanup (`fs.rmSync(dir, { recursive: true, force: true })`).
 * Refusals throw PackManagerError with an actionable message.
 */
export async function extractPackZip(zip: Uint8Array, filename: string): Promise<string> {
  if (!isZipFilename(filename)) {
    throw new PackManagerError(`${filename}: pack install accepts .zip archives only`);
  }
  let loaded: JSZip;
  try {
    loaded = await JSZip.loadAsync(zip);
  } catch (error) {
    throw new PackManagerError(
      `${filename}: not a readable zip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = Object.values(loaded.files);

  // Safest-first ordering (mirrors api_server.py _extract_pack_zip): validate
  // every entry path (G2/G3) before the manifest-presence check (G1), so a
  // hostile archive is refused on its path shape regardless of what it packs.
  for (const entry of entries) {
    // G2: normalize and re-verify containment before writing anything.
    const parts = entry.name.split('/');
    if (entry.name.includes('\\') || path.isAbsolute(entry.name) || parts.includes('..')) {
      throw new PackManagerError(`${filename}: unsafe archive entry path ${entry.name}`);
    }
    // G3: unix symlink modes are refused outright.
    const { unixPermissions } = entry as {
      unixPermissions?: number | string;
    };
    if (isSymlinkEntry(unixPermissions)) {
      throw new PackManagerError(`${filename}: symlink archive entry ${entry.name} is not allowed`);
    }
  }

  // G1: the C1 manifest-presence check; the manager's schema validation runs
  // next on the extracted folder.
  const manifest = entries.find(
    (entry) => !entry.dir && (entry.name === 'pack.json' || entry.name === './pack.json'),
  );
  if (manifest === undefined) {
    throw new PackManagerError(`${filename}: no pack.json manifest at the archive root`);
  }

  let totalUncompressed = 0;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-install-'));
  try {
    for (const entry of entries) {
      if (entry.dir) continue;
      const target = path.join(outDir, ...entry.name.split('/'));
      const data = await entry.async('nodebuffer');
      totalUncompressed += data.length;
      if (totalUncompressed > PACK_ZIP_MAX_UNCOMPRESSED_BYTES) {
        throw new PackManagerError(
          `${filename}: archive expands beyond the ${PACK_ZIP_MAX_UNCOMPRESSED_BYTES} byte cap`,
        );
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
  return outDir;
}
