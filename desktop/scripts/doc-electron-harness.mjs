// doc-electron-harness.mjs — issue #320 AC1/AC2 real-Electron leg (trace
// 320-269-parse-isolation-chat-integrity, plan Revision 2 R8). Mirrors
// xlsx-electron-harness.mjs (issue #319).
//
// An Electron MAIN-process harness (no BrowserWindow). It drives the
// PRODUCTION doc child (.docx / .pptx / .pdf) through the REAL Electron
// utilityProcess transport (fork, parentPort report, exit, kill) — the leg
// vitest cannot reach, since the vitest specs stub `electron`. It:
//   1. imports the COMPILED desktop/dist/main/backend/ingest/doc-worker.js and
//      extractors.js (needs `npm --prefix desktop run compile` first);
//   2. checks the runner REFUSES inside Electron with nothing registered, then
//      registers setDocWorkerForkFn with a utilityProcess launcher EXACTLY like
//      desktop/main/index.ts registers it in app.whenReady() (serviceName
//      'TrainingApp document parser'), recording every child's OS pid;
//   3. (a) PARITY: extracts contracts/fixtures/pdf-parity/parity.pdf through
//      extractDocumentFromFile and requires the FULL {text, pages} result to
//      equal parity.expected.json; extracts a generated .docx and .pptx (the
//      frozen C1 spec's entry sets) and requires the pre-migration texts (and
//      the per-slide pages) — prints HARNESS-DOC-PARITY-OK;
//      (b) CRASH / POISON: a fixture .cjs child that exits 2 with no report
//      (forked through the registered launcher via childPath) must reject
//      naming exit 2, and a poisoned .docx / .pptx / .pdf parsed by the REAL
//      child must each reject as a normal Error; after every failure a
//      healthy real-child extraction still succeeds — prints
//      HARNESS-DOC-POISON-CONTAINED;
//      (c) HANG: a fixture .cjs child that never exits, timeoutMs 400, must
//      time out and its OS process must disappear; the parent stays healthy —
//      prints HARNESS-DOC-HANG-KILLED;
//   4. asserts every recorded child pid differs from the parent (main
//      process) pid and prints HARNESS-DOC-PIDS parent=<pid> children=<pids>;
//   5. app.exit(0) when every marker printed, else app.exit(1).
// Every failure prints `HARNESS-FAIL:<reason>` and exits non-zero; a
// watchdog bounds the whole run.
//
// Residual (disclosed, the #319 precedent): this runs the compiled child
// OUTSIDE app.asar; packaged asar module resolution is not exercised.
//
// Run (from the repo root; electron is a desktop devDependency):
//   desktop/node_modules/.bin/electron desktop/scripts/doc-electron-harness.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, utilityProcess } from 'electron';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..');
const DIST_INGEST = path.join(DESKTOP_ROOT, 'dist', 'main', 'backend', 'ingest');
const PARITY_DIR = path.join(REPO_ROOT, 'contracts', 'fixtures', 'pdf-parity');
const PARITY_PDF = path.join(PARITY_DIR, 'parity.pdf');
const PARITY_GOLDEN = path.join(PARITY_DIR, 'parity.expected.json');
const WATCHDOG_MS = 240_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const SERVICE_NAME = 'TrainingApp document parser';

// The harness (not desktop/main) builds its office fixtures with the desktop
// devDependency jszip — the same library the frozen C1 spec writes them with.
const requireFromDesktop = createRequire(path.join(DESKTOP_ROOT, 'package.json'));
const JSZip = requireFromDesktop('jszip');

// The frozen C1 spec's office entry sets and their pre-migration outputs
// (i320-doc-parsers-out-of-main.test.ts DOCX_ENTRIES / PPTX_ENTRIES /
// DOCX_TEXT / PPTX_TEXT / PPTX_PAGES).
const DOCX_ENTRIES = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>',
  'word/document.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Hello from the docx child</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:t>paragraph &amp; more</w:t></w:r></w:p>' +
    '</w:body></w:document>',
};
function slideXml(runs) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    runs.map((r) => `<p:sp><p:txBody><a:p><a:r><a:t>${r}</a:t></a:r></a:p></p:txBody></p:sp>`).join('') +
    '</p:spTree></p:cSld></p:sld>'
  );
}
const PPTX_ENTRIES = {
  'ppt/slides/slide10.xml': slideXml(['Tenth slide']),
  'ppt/slides/slide1.xml': slideXml(['Slide one title', 'Fish &amp; chips', ' ']),
  'ppt/slides/slide2.xml': slideXml(['Second slide']),
};
const DOCX_TEXT = 'Hello from the docx child\n\nSecond paragraph & more\n\n';
const PPTX_TEXT = 'Slide one title\nFish & chips\n\nSecond slide\n\nTenth slide';
const PPTX_PAGES = [
  { pageNumber: 1, text: 'Slide one title\nFish & chips' },
  { pageNumber: 2, text: 'Second slide' },
  { pageNumber: 3, text: 'Tenth slide' },
];

function say(line) {
  process.stdout.write(`${line}\n`);
}

let finished = false;
function finish(code, failReason) {
  if (finished) return;
  finished = true;
  if (failReason !== undefined) say(`HARNESS-FAIL:${failReason}`);
  app.exit(code);
}

const watchdog = setTimeout(() => finish(1, `watchdog: no verdict within ${WATCHDOG_MS} ms`), WATCHDOG_MS);
watchdog.unref?.();

process.on('uncaughtException', (err) => finish(1, `uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (err) => finish(1, `unhandledRejection: ${err?.stack ?? err}`));

// No window is ever opened; keep the app alive until finish().
app.on('window-all-closed', () => {});

async function importDist(name) {
  const file = path.join(DIST_INGEST, name);
  if (!fs.existsSync(file)) {
    throw new Error(`compiled module missing: ${file} (run \`npm --prefix desktop run compile\`)`);
  }
  return import(pathToFileURL(file).href);
}

async function writeZip(file, entries) {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('ELECTRON_RUN_AS_NODE is set: this must run as an Electron main process');
  if (typeof process.versions.electron !== 'string') throw new Error('not running under Electron');

  const worker = await importDist('doc-worker.js');
  const extractors = await importDist('extractors.js');
  for (const name of ['setDocWorkerForkFn', 'resolveDocWorkerForkFn', 'extractDocOutOfProcess', 'terminateDocWorkers', 'docWorkerChildPath']) {
    if (typeof worker[name] !== 'function') throw new Error(`doc-worker.js does not export ${name}`);
  }
  if (typeof extractors.extractDocumentFromFile !== 'function') throw new Error('extractors.js does not export extractDocumentFromFile');
  if (!worker.docWorkerChildPath().endsWith('doc-worker-child.js')) {
    throw new Error(`the default child is not the compiled sibling: ${worker.docWorkerChildPath()}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc electron harness '));
  try {
    // Inside Electron with nothing registered the runner must REFUSE — never
    // parse in-process.
    if (worker.resolveDocWorkerForkFn(true) !== null) throw new Error('a launcher resolved inside Electron before registration');
    const refusalDocx = await writeZip(path.join(tmp, 'refusal.docx'), DOCX_ENTRIES);
    let refusal;
    try {
      await extractors.extractDocumentFromFile(refusalDocx, { timeoutMs: EXTRACT_TIMEOUT_MS });
    } catch (err) {
      refusal = err;
    }
    if (!(refusal instanceof Error) || !/^doc worker:/.test(refusal.message) || !/refus/i.test(refusal.message)) {
      throw new Error(`the unregistered runner did not refuse with the doc worker prefix: ${String(refusal?.message ?? refusal)}`);
    }

    // The launcher, exactly as desktop/main/index.ts registers it: stdout
    // discarded (the report rides parentPort), stderr piped for the detail.
    let forks = 0;
    const childPids = [];
    let lastChild;
    worker.setDocWorkerForkFn((modulePath, args) => {
      forks += 1;
      const child = utilityProcess.fork(modulePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        serviceName: SERVICE_NAME,
      });
      lastChild = child;
      // pid is undefined until the child has spawned.
      if (typeof child.pid === 'number') childPids.push(child.pid);
      else child.once('spawn', () => typeof child.pid === 'number' && childPids.push(child.pid));
      return child;
    });
    if (worker.resolveDocWorkerForkFn(true) === null) throw new Error('registration did not take effect');

    const golden = JSON.parse(fs.readFileSync(PARITY_GOLDEN, 'utf8'));
    const goldenJson = JSON.stringify(golden);

    // (a) PARITY through the real utilityProcess transport (paths with spaces).
    const pdfCopy = path.join(tmp, 'parity copy.pdf');
    fs.copyFileSync(PARITY_PDF, pdfCopy);
    const pdf = await extractors.extractDocumentFromFile(pdfCopy, { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (forks < 1) throw new Error('parity extraction did not fork through the registered utilityProcess launcher');
    if (JSON.stringify(pdf) !== goldenJson) throw new Error(`pdf result differs from the golden: ${JSON.stringify(pdf).slice(0, 300)}`);
    const pdfCapped = await extractors.extractDocumentFromFile(pdfCopy, { maxZipBytes: 100, timeoutMs: EXTRACT_TIMEOUT_MS });
    if (JSON.stringify(pdfCapped) !== goldenJson) throw new Error('a zip cap changed the pdf result');

    const docxFile = await writeZip(path.join(tmp, 'real copy.docx'), DOCX_ENTRIES);
    const docx = await extractors.extractDocumentFromFile(docxFile, { maxZipBytes: 10 * 1024 * 1024, timeoutMs: EXTRACT_TIMEOUT_MS });
    if (docx?.text !== DOCX_TEXT) throw new Error(`docx text differs: ${JSON.stringify(docx?.text)}`);
    if (docx.pages !== undefined) throw new Error('docx unexpectedly carried pages');

    const pptxFile = await writeZip(path.join(tmp, 'real copy.pptx'), PPTX_ENTRIES);
    const pptx = await extractors.extractDocumentFromFile(pptxFile, { maxZipBytes: 10 * 1024 * 1024, timeoutMs: EXTRACT_TIMEOUT_MS });
    if (pptx?.text !== PPTX_TEXT) throw new Error(`pptx text differs: ${JSON.stringify(pptx?.text)}`);
    if (JSON.stringify(pptx.pages) !== JSON.stringify(PPTX_PAGES)) throw new Error(`pptx pages differ: ${JSON.stringify(pptx.pages)}`);

    // The cap is enforced by the CHILD and reported with the child prefix.
    let capFailure;
    try {
      await extractors.extractDocumentFromFile(docxFile, { maxZipBytes: 100, timeoutMs: EXTRACT_TIMEOUT_MS });
    } catch (err) {
      capFailure = err;
    }
    if (!(capFailure instanceof Error) || !/^doc worker:/.test(capFailure.message) || !/cap/i.test(capFailure.message)) {
      throw new Error(`the child-side zip cap did not reject with the doc worker prefix: ${String(capFailure?.message ?? capFailure)}`);
    }
    say(`HARNESS-DOC-PARITY-OK (pdf == golden ${golden.pages.length} pages; docx; pptx ${PPTX_PAGES.length} slides; child cap: ${capFailure.message.slice(0, 120)})`);

    // A healthy REAL-child extraction: the parent-survival witness each
    // failure case below is followed by.
    let healthySerial = 0;
    const healthyExtraction = async () => {
      healthySerial += 1;
      const file = path.join(tmp, `healthy ${healthySerial}.pdf`);
      fs.copyFileSync(PARITY_PDF, file);
      const forksBefore = forks;
      const result = await extractors.extractDocumentFromFile(file, { timeoutMs: EXTRACT_TIMEOUT_MS });
      if (forks <= forksBefore) throw new Error('the healthy extraction did not fork the production child');
      if (JSON.stringify(result) !== goldenJson) throw new Error('a healthy extraction returned a result that differs from the golden');
    };

    // (b) CRASH: a fixture .cjs child that exits 2 WITHOUT any report.
    const crashChild = path.join(tmp, 'crash-fixture-child.cjs');
    fs.writeFileSync(crashChild, "'use strict';\nprocess.exit(2);\n", 'utf8');
    const crashInput = path.join(tmp, 'crash input.docx');
    fs.copyFileSync(docxFile, crashInput);
    const forksBeforeCrash = forks;
    let crashFailure;
    try {
      await extractors.extractDocumentFromFile(crashInput, { childPath: crashChild, timeoutMs: EXTRACT_TIMEOUT_MS });
    } catch (err) {
      crashFailure = err;
    }
    if (forks <= forksBeforeCrash) throw new Error('the crash case did not fork through the registered launcher');
    if (!(crashFailure instanceof Error)) throw new Error(`crash child did not reject as an Error (got ${String(crashFailure)})`);
    if (!/exit/i.test(crashFailure.message) || !/\b2\b/.test(crashFailure.message)) {
      throw new Error(`the crash rejection must name exit code 2: ${JSON.stringify(crashFailure.message)}`);
    }
    await healthyExtraction();

    // POISON: corrupt bytes parsed by the REAL production child, per format.
    const poisonMessages = [];
    const poisons = [
      ['poisoned.docx', Buffer.from('PK\x03\x04 poisoned: not a real zip container \x00\xff\xfe', 'latin1')],
      ['poisoned.pptx', Buffer.from('PK\x03\x04 poisoned slides \x00\xff', 'latin1')],
      ['poisoned.pdf', Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\n\x00\xff garbage xref', 'latin1')],
    ];
    for (const [name, bytes] of poisons) {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, bytes);
      const forksBefore = forks;
      let failure;
      try {
        await extractors.extractDocumentFromFile(file, { maxZipBytes: 10 * 1024 * 1024, timeoutMs: EXTRACT_TIMEOUT_MS });
      } catch (err) {
        failure = err;
      }
      if (forks <= forksBefore) throw new Error(`${name}: the poisoned extraction did not fork a child`);
      if (!(failure instanceof Error)) throw new Error(`${name}: the poisoned document did not reject as an Error (got ${String(failure)})`);
      poisonMessages.push(`${name}: ${failure.message.slice(0, 80)}`);
      await healthyExtraction();
    }
    say(`HARNESS-DOC-POISON-CONTAINED (crash: ${crashFailure.message.slice(0, 100)}; ${poisonMessages.join('; ')})`);

    // (c) HANG: a fixture .cjs child that NEVER exits.
    const hungChild = path.join(tmp, 'hung-fixture-child.cjs');
    fs.writeFileSync(hungChild, "'use strict';\nsetInterval(() => {}, 1000);\n", 'utf8');
    const hungInput = path.join(tmp, 'hung input.pdf');
    fs.copyFileSync(PARITY_PDF, hungInput);
    const startedAt = Date.now();
    let killFailure;
    try {
      await extractors.extractDocumentFromFile(hungInput, { childPath: hungChild, timeoutMs: 400 });
    } catch (err) {
      killFailure = err;
    }
    const elapsedMs = Date.now() - startedAt;
    const hungPid = lastChild?.pid ?? childPids[childPids.length - 1];
    if (!(killFailure instanceof Error)) throw new Error(`the hung child did not reject as an Error (got ${String(killFailure)})`);
    if (!/timeout|timed out|deadline/i.test(killFailure.message)) {
      throw new Error(`the hung-child rejection must mention the timeout: ${JSON.stringify(killFailure.message)}`);
    }
    if (elapsedMs > 5_000) throw new Error(`the deadline took ${elapsedMs} ms to settle`);
    if (typeof hungPid !== 'number') throw new Error('the hung utilityProcess child exposed no pid');
    const goneBy = Date.now() + 5_000;
    while (Date.now() < goneBy && isAlive(hungPid)) await new Promise((resolve) => setTimeout(resolve, 50));
    if (isAlive(hungPid)) throw new Error(`the killed hung child (pid ${hungPid}) is still alive`);
    await healthyExtraction();
    say(`HARNESS-DOC-HANG-KILLED (${killFailure.message.slice(0, 120)}; settled in ${elapsedMs} ms; pid ${hungPid} gone)`);

    // (d) PROCESS BOUNDARY: every child ran in its own OS process.
    const parentPid = process.pid;
    if (childPids.length < forks) {
      // pids arrive on 'spawn'; give late spawn events a moment.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (childPids.length === 0) throw new Error('no child pid was recorded');
    const unique = [...new Set(childPids)];
    if (unique.includes(parentPid)) throw new Error(`a document child ran in the parent PID ${parentPid}`);
    say(`HARNESS-DOC-PIDS parent=${parentPid} children=${unique.join(',')} (forks=${forks}; all differ from the parent)`);
  } finally {
    worker.terminateDocWorkers();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

app
  .whenReady()
  .then(run)
  .then(
    () => finish(0),
    (err) => finish(1, err instanceof Error ? err.message : String(err)),
  );
