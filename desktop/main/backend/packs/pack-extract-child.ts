// pack-extract-child.ts — the pack-archive EXTRACTION CHILD (issue #320 AC3).
//
// This module is the ONLY place in desktop/main where an untrusted pack zip
// is decompressed. It runs as a separate OS process (an Electron
// utilityProcess in the packaged app, a node child_process fork outside it),
// so a poisoned pack archive can crash or wedge only this child — never the
// privileged main process that holds the store, the launch token and the
// filesystem. The runner is pack-worker.ts; the public entry is still
// pack-extract.ts's extractPackZip, which now only bridges to the runner.
//
// The extraction pipeline is MOVED here from the former in-process
// extractPackZip, step for step and message for message (the c8-pack-security
// and browser-pack-extract-parity suites pin the refusal texts byte-for-byte):
//   1. .zip filename gate,
//   2. ZIP32 central-directory pre-filter (parseCentralDirectory: ZIP64 and
//      duplicate-name refusal) + declared entry/byte/ratio caps,
//   3. raw entry-name validation + symlink refusal on the AUTHORITATIVE raw
//      names (JSZip normalizes hostile names away on load),
//   4. JSZip load, parsed entry-count cap, per-entry name/symlink
//      re-validation, root pack.json presence,
//   5. per-entry resolved-path containment and writes into the PARENT-GIVEN
//      out dir under the written-bytes backstop.
//
// Argv (frozen; positional, all four ALWAYS present):
//   [absZipPath, absOutDir, filename, limitsJson]
// The parent owns the per-call workspace (<work>/input.zip, <work>/out) and
// its cleanup; this child never chooses a temp directory of its own.
//
// Report protocol (exactly one report over IPC, then exit):
//   { ok: true, dir: <absOutDir exactly as received> }
//   { ok: false, code: <diagnostic string>, error: <final message> }
// `error` is the FINAL refusal text, UNPREFIXED (the parent rethrows it as
// PackManagerError verbatim); `code` is diagnostic-only and never surfaced.
// Only argv misuse and a crash of the child itself carry the `pack worker: `
// prefix.
//
// Import graph (frozen by the C3 spec): node built-ins, jszip, and the pure
// shared rules ONLY. In particular this module never imports pack-manager.ts
// (whose import graph drags in sqlite-store.ts and the better-sqlite3 /
// sqlite-vec native addons), so it has no PackManagerError: refusals are a
// local Error subclass carrying the same message text. The shared rules are
// imported with an explicit '.ts' specifier so the SAME spelling loads under
// a `node pack-extract-child.ts` source-tree spawn (Node type stripping) and
// in the compiled dist (tsc rewrites it to '.js' via
// rewriteRelativeImportExtensions).
//
// This module must stay electron-free: under vitest it is imported directly;
// its self-run entry fires only when the module IS the process entry, exactly
// like xlsx-worker-child.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type JSZipType from 'jszip';
import {
  checkEntryName,
  enforceDeclaredLimits,
  expandsBeyondCapMessage,
  isSymlinkMode,
  isZipFilename,
  missingManifestMessage,
  notZipMessage,
  parseCentralDirectory,
  symlinkEntryMessage,
  type FailFactory,
  type PackSecurityLimits,
} from './pack-archive-rules.ts';

/** Prefix carried by child-origin protocol failures (argv misuse, crash). */
export const PACK_WORKER_ERROR_PREFIX = 'pack worker: ';

/** A refusal raised by the extraction pipeline: the message is the final
 *  user-facing text; the code is a diagnostic label only. */
class PackRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PackRefusal';
    this.code = code;
  }
}

/** A FailFactory for the shared rules that tags the refusal with `code`. */
function failWith(code: string): FailFactory {
  return (message: string): Error => new PackRefusal(code, message);
}

/** The S2 raw-name guard (pack-extract.ts's safeEntryName, child-side). */
function safeEntryName(name: string): string {
  return checkEntryName(name, failWith('entry-name'));
}

/** The S4 symlink test on the decompressor's parsed view. */
function isSymlinkEntry(unixPermissions: number | string | undefined): boolean {
  return isSymlinkMode(unixPermissions);
}

/** True when `target` resolves strictly INSIDE `root` (not the root itself);
 *  the same rule as pack-extract.ts's exported ensureContained. */
function ensureContained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Parse + validate the limits argument (the parent's resolved limits). */
function parseLimits(limitsJson: string): PackSecurityLimits | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(limitsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const { maxUncompressedBytes, maxEntries, maxCompressionRatio } = record;
  if (!positive(maxUncompressedBytes) || !positive(maxEntries) || !positive(maxCompressionRatio)) return null;
  return { maxUncompressedBytes, maxEntries, maxCompressionRatio };
}

/**
 * The moved extraction pipeline: extract the archive at `zipPath` into the
 * existing (parent-created) `outDir`. Throws PackRefusal with the frozen
 * message on every refusal; on a failure after writing began, the partial
 * output is removed (belt and braces — the parent workspace cleanup is the
 * owner).
 */
async function extractInto(
  zipPath: string,
  outDir: string,
  filename: string,
  limits: PackSecurityLimits,
): Promise<void> {
  if (!isZipFilename(filename)) {
    throw new PackRefusal('not-zip', notZipMessage(filename));
  }

  // S3 first: the declared-metadata pre-filter over the raw central
  // directory, plus S2 name validation and S4 symlink refusal on the
  // AUTHORITATIVE raw names. All of this runs before any decompression.
  const raw = fs.readFileSync(zipPath);
  const declared = parseCentralDirectory(raw, filename, failWith('central-directory')).entries;
  enforceDeclaredLimits(declared, limits, filename, failWith('declared-limits'));
  for (const entry of declared) {
    safeEntryName(entry.name);
    if (entry.isSymlink) {
      throw new PackRefusal('symlink', symlinkEntryMessage(filename, entry.name));
    }
  }

  const JSZip = (await import('jszip')).default;
  let loaded: JSZipType;
  try {
    loaded = await JSZip.loadAsync(raw);
  } catch (error) {
    throw new PackRefusal(
      'unreadable-zip',
      `${filename}: not a readable zip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = Object.values(loaded.files);
  if (entries.length > limits.maxEntries) {
    throw new PackRefusal(
      'entry-cap',
      `${filename}: archive has ${entries.length} entries, over the ${limits.maxEntries} entry cap`,
    );
  }

  // Safest-first ordering (mirrors api_server.py _extract_pack_zip): validate
  // every entry path (S2/S4 on the decompressor's own view) before the
  // manifest-presence check.
  for (const entry of entries) {
    try {
      safeEntryName(entry.name);
    } catch (error) {
      throw new PackRefusal('entry-name', `${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { unixPermissions } = entry as { unixPermissions?: number | string };
    // G3: unix symlink modes are refused outright.
    if (isSymlinkEntry(unixPermissions)) {
      throw new PackRefusal('symlink', symlinkEntryMessage(filename, entry.name));
    }
  }

  // G1: the manifest-presence check; the manager's schema validation runs
  // next on the extracted folder (in the parent).
  const manifest = entries.find(
    (entry) => !entry.dir && (entry.name === 'pack.json' || entry.name === './pack.json'),
  );
  if (manifest === undefined) {
    throw new PackRefusal('missing-manifest', missingManifestMessage(filename));
  }

  let totalUncompressed = 0;
  fs.mkdirSync(outDir, { recursive: true });
  try {
    for (const entry of entries) {
      if (entry.dir) continue;
      // Resolved-path containment BEFORE any bytes are written (S2).
      const target = path.join(outDir, ...entry.name.split('/'));
      if (!ensureContained(outDir, target)) {
        throw new PackRefusal(
          'containment',
          `${filename}: unsafe archive entry path ${JSON.stringify(entry.name)} escapes the extraction root`,
        );
      }
      const data = await entry.async('nodebuffer');
      // S5: the unspoofable backstop — declared metadata lies, written bytes
      // do not.
      totalUncompressed += data.length;
      if (totalUncompressed > limits.maxUncompressedBytes) {
        throw new PackRefusal('written-bytes-cap', expandsBeyondCapMessage(filename, limits.maxUncompressedBytes));
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  } catch (error) {
    removePartialOutput(outDir);
    if (error instanceof PackRefusal) throw error;
    throw new PackRefusal(
      'extraction-failed',
      `${filename}: extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Empty the out dir after a failed extraction (best effort; the parent
 *  removes the whole workspace regardless). */
function removePartialOutput(outDir: string): void {
  try {
    for (const name of fs.readdirSync(outDir)) {
      fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    }
  } catch {
    // the parent's workspace cleanup owns the rest
  }
}

/** The utility-process parent port (Electron), when this is a utility process. */
function parentPort(): { postMessage(message: unknown): void } | null {
  const port = (process as unknown as { parentPort?: { postMessage(message: unknown): void } | null }).parentPort;
  return port !== undefined && port !== null && typeof port.postMessage === 'function' ? port : null;
}

/**
 * Deliver the ONE report over the IPC channel and resolve once it is handed
 * off (parentPort.postMessage is synchronous; Node's process.send is
 * asynchronous, so its callback gates the caller's exit). With no IPC
 * channel at all (a manual run) the report goes to stdout.
 */
function emit(report: Record<string, unknown>, channel?: { postMessage(message: unknown): void }): Promise<void> {
  if (channel !== undefined) {
    channel.postMessage(report);
    return Promise.resolve();
  }
  const port = parentPort();
  if (port !== null) {
    port.postMessage(report);
    return Promise.resolve();
  }
  if (typeof process.send === 'function') {
    return new Promise((resolve) => {
      process.send?.(report, undefined, undefined, () => resolve());
    });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return Promise.resolve();
}

/**
 * The child entry. argv is exactly [absZipPath, absOutDir, filename,
 * limitsJson]; any other shape is a prefixed protocol failure (exit 1).
 * Returns the process exit code (0 success, 1 failure) after the report has
 * been handed off.
 */
export async function runPackChildMain(
  argv: string[],
  channel?: { postMessage(message: unknown): void },
): Promise<number> {
  if (argv.length !== 4 || argv.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
    await emit(
      {
        ok: false,
        code: 'bad-argv',
        error: `${PACK_WORKER_ERROR_PREFIX}expected argv [absZipPath, absOutDir, filename, limitsJson], got ${argv.length} argument(s)`,
      },
      channel,
    );
    return 1;
  }
  const [zipPath, outDir, filename, limitsJson] = argv as [string, string, string, string];
  if (!path.isAbsolute(zipPath) || !path.isAbsolute(outDir)) {
    await emit(
      { ok: false, code: 'bad-argv', error: `${PACK_WORKER_ERROR_PREFIX}the archive and output paths must be absolute` },
      channel,
    );
    return 1;
  }
  const limits = parseLimits(limitsJson);
  if (limits === null) {
    await emit(
      { ok: false, code: 'bad-argv', error: `${PACK_WORKER_ERROR_PREFIX}the limits argument is not a valid limits object` },
      channel,
    );
    return 1;
  }
  try {
    await extractInto(zipPath, outDir, filename, limits);
    // The success report names EXACTLY the out dir the parent passed.
    await emit({ ok: true, dir: outDir }, channel);
    return 0;
  } catch (error) {
    if (error instanceof PackRefusal) {
      await emit({ ok: false, code: error.code, error: error.message }, channel);
      return 1;
    }
    await emit(
      {
        ok: false,
        code: 'internal',
        error: `${PACK_WORKER_ERROR_PREFIX}pack extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      channel,
    );
    return 1;
  }
}

/**
 * Self-run ONLY as the process entry (importing this module from a spec must
 * be side-effect-free). Two entry shapes: an Electron utility process
 * (process.parentPort is present only there) or a forked/spawned node child
 * (argv[1] is this script) — the xlsx-worker-child rule.
 */
function isProcessEntry(): boolean {
  if (parentPort() !== null) return true;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

/**
 * The argv handed to this child by the parent, minus this script's own entry:
 * a forked node child sees [execPath, thisScript, ...args]; an Electron
 * utility process may or may not carry the module path in argv. Mirrors
 * xlsx-worker-child's childArgs.
 */
function childArgs(): string[] {
  let self: string;
  try {
    self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return process.argv.slice(1);
  }
  const idx = process.argv.findIndex((arg, i) => {
    if (i === 0) return false;
    try {
      return path.resolve(arg).toLowerCase() === self;
    } catch {
      return false;
    }
  });
  return idx >= 0 ? process.argv.slice(idx + 1) : process.argv.slice(1);
}

if (isProcessEntry()) {
  // Exit explicitly once the report is handed off: an Electron utility
  // process's parentPort keeps the event loop alive, and the parent settles
  // ON EXIT.
  void runPackChildMain(childArgs())
    .then((code) => process.exit(code))
    .catch(async (err: unknown) => {
      await emit({
        ok: false,
        code: 'crash',
        error: `${PACK_WORKER_ERROR_PREFIX}child crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
      process.exit(1);
    });
}
