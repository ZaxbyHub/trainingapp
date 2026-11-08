#!/usr/bin/env node
// verify-xlsx-parity.mjs — issue #319 AC1 packtool parity check (trace
// 319-dependency-gate-follow-through, revision 3, critic F7).
//
// The desktop xlsx extractor (now an isolated child process) and the packtool
// extractor are twins: a workbook must yield byte-identical text on both
// sides. This script pins the PACKTOOL half against the committed fixture
// contracts/fixtures/xlsx-parity/ (the golden parity.expected.txt was captured
// at base from the unmigrated desktop extractor):
//
//   - it imports the BUILT packtool/dist/docs/extract.js (run
//     `npm --prefix packtool run build` first) and calls extractSourceDocs
//     over the fixture directory;
//   - the FULL inventory must be exactly two docs: docs/parity.expected.txt
//     (a text/plain doc — the golden is itself an ingested file and sorts
//     first) and docs/parity.xlsx; nothing skipped;
//   - parity.xlsx's extracted text must equal the golden's utf8 bytes.
//
// Exit 0 with one summary line on success; exit 1 with the mismatch on any
// failure. The logic is exported (verifyXlsxParity) so a spec or CI step can
// reuse it; invoked directly it runs as main. Run from anywhere:
//   node packtool/scripts/verify-xlsx-parity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKTOOL_ROOT = path.resolve(SCRIPT_DIR, '..');
export const REPO_ROOT = path.resolve(PACKTOOL_ROOT, '..');
export const EXTRACT_DIST = path.join(PACKTOOL_ROOT, 'dist', 'docs', 'extract.js');
export const PARITY_DIR = path.join(REPO_ROOT, 'contracts', 'fixtures', 'xlsx-parity');

const EXPECTED_TEXT_PACK_PATH = 'docs/parity.expected.txt';
const EXPECTED_XLSX_PACK_PATH = 'docs/parity.xlsx';

/**
 * Run the parity check. Resolves { ok: true, summary } or
 * { ok: false, errors: string[] }; never throws for a check failure (an
 * unexpected extractor throw is reported as an error entry).
 */
export async function verifyXlsxParity(options = {}) {
  const extractPath = options.extractPath ?? EXTRACT_DIST;
  const parityDir = options.parityDir ?? PARITY_DIR;
  const errors = [];

  if (!fs.existsSync(extractPath)) {
    return {
      ok: false,
      errors: [
        `packtool build output missing: ${extractPath} — run \`npm --prefix packtool run build\` first`,
      ],
    };
  }
  const goldenPath = path.join(parityDir, 'parity.expected.txt');
  if (!fs.existsSync(goldenPath) || !fs.existsSync(path.join(parityDir, 'parity.xlsx'))) {
    return { ok: false, errors: [`parity fixture incomplete under ${parityDir}`] };
  }
  const golden = fs.readFileSync(goldenPath, 'utf8');

  let result;
  try {
    const mod = await import(pathToFileURL(extractPath).href);
    if (typeof mod.extractSourceDocs !== 'function') {
      return { ok: false, errors: [`${extractPath} does not export extractSourceDocs`] };
    }
    result = await mod.extractSourceDocs(parityDir);
  } catch (err) {
    return { ok: false, errors: [`extractSourceDocs threw: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const docs = Array.isArray(result?.docs) ? result.docs : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const packPaths = docs.map((doc) => doc.packPath);
  const expectedPaths = [EXPECTED_TEXT_PACK_PATH, EXPECTED_XLSX_PACK_PATH];
  if (docs.length !== 2 || JSON.stringify([...packPaths].sort()) !== JSON.stringify(expectedPaths)) {
    errors.push(`inventory must be exactly ${JSON.stringify(expectedPaths)}; got ${JSON.stringify(packPaths)}`);
  }
  if (skipped.length !== 0) errors.push(`no fixture file may be skipped; skipped ${JSON.stringify(skipped)}`);

  const textDoc = docs.find((doc) => doc.packPath === EXPECTED_TEXT_PACK_PATH);
  if (textDoc !== undefined && textDoc.mime !== 'text/plain') {
    errors.push(`${EXPECTED_TEXT_PACK_PATH} must be a text/plain doc; got ${JSON.stringify(textDoc.mime)}`);
  }
  const xlsxDoc = docs.find((doc) => doc.packPath === EXPECTED_XLSX_PACK_PATH);
  if (xlsxDoc === undefined) {
    errors.push(`${EXPECTED_XLSX_PACK_PATH} missing from the extracted docs`);
  } else if (xlsxDoc.text !== golden) {
    errors.push(
      `parity.xlsx text differs from the golden (${JSON.stringify(xlsxDoc.text).slice(0, 200)} vs ` +
        `${JSON.stringify(golden).slice(0, 200)})`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    summary: `xlsx parity OK: ${docs.length} docs [${packPaths.join(', ')}]; parity.xlsx text === golden (${Buffer.byteLength(golden, 'utf8')} bytes)`,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const outcome = await verifyXlsxParity();
  if (outcome.ok) {
    console.log(outcome.summary);
    process.exit(0);
  }
  for (const error of outcome.errors) console.error(`xlsx parity FAIL: ${error}`);
  process.exit(1);
}
