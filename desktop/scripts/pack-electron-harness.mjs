// pack-electron-harness.mjs — issue #320 AC3 real-Electron leg (trace
// 320-269-parse-isolation-chat-integrity, final-critic round-1 finding 1).
// Mirrors doc-electron-harness.mjs (issue #320 AC1/AC2) and
// xlsx-electron-harness.mjs (issue #319).
//
// An Electron MAIN-process harness (no BrowserWindow). It drives the
// PRODUCTION pack-extraction child through the REAL Electron utilityProcess
// transport (fork, parentPort report, exit, kill) — the leg vitest cannot
// reach, since the vitest specs stub `electron` (C3 P10 runs the Electron
// stub). It:
//   1. imports the COMPILED desktop/dist/main/backend/packs modules
//      (pack-worker.js, zip-install.js — the exact production import seam
//      surface.ts uses — and store/pack-manager.js for PackManagerError;
//      needs `npm --prefix desktop run compile` first);
//   2. checks the runner REFUSES inside Electron with nothing registered,
//      then registers setPackWorkerForkFn with a utilityProcess launcher
//      EXACTLY like desktop/main/index.ts registers it in app.whenReady()
//      (serviceName 'TrainingApp pack extractor'), recording every child's
//      OS pid and the per-call workspace the launcher argv names;
//   3. (a) PARITY: extracts contracts/fixtures/pack-extract-parity/
//      parity-pack.zip through the PUBLIC extractPackZip(bytes,
//      'parity-pack.zip') production API and requires the returned fresh
//      dir's tree (relative paths + sha256 per file) to equal
//      golden.manifest.json, the dir to differ from the per-call
//      pack-extract-* workspace (it must be a pack-install-* dir), and the
//       workspace itself to be gone — prints HARNESS-PACK-PARITY-OK;
//      (b) CRASH / POISON: a fixture .cjs child that exits 2 with no report
//      (forked through the registered launcher via childPath, the
//      extractPackZipWithOptions test-control surface) must reject as a
//      plain `pack worker: ` Error naming exit 2, and a poisoned zip
//      (garbage bytes) parsed by the REAL child must reject as a
//      PackManagerError carrying the exact not-zip message; after every
//      failure a healthy real-child extraction still succeeds — prints
//      HARNESS-PACK-POISON-CONTAINED;
//      (c) HANG: a fixture .cjs child that never reports, timeoutMs 400,
//      must time out and its OS process must disappear; a healthy
//      extraction succeeds afterwards — prints HARNESS-PACK-HANG-KILLED;
//   4. asserts every recorded child pid differs from the parent (main
//      process) pid and prints HARNESS-PACK-PIDS parent=<pid>
//      children=[<pids>];
//   5. app.exit(0) when every marker printed, else app.exit(1).
// Every failure prints `HARNESS-FAIL:<reason>` and exits non-zero; a
// watchdog bounds the whole run.
//
// Residual (disclosed, the #319/#320 precedent): this runs the compiled
// child OUTSIDE app.asar; packaged asar module resolution is not exercised
// (the packaged smoke exercises pack directory installs, not the extract
// upload path).
//
// Run (from the repo root; electron is a desktop devDependency):
//   npm --prefix desktop run compile && env -u ELECTRON_RUN_AS_NODE \
//     npm --prefix desktop exec --no -- electron desktop/scripts/pack-electron-harness.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, utilityProcess } from 'electron';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..');
const DIST_BACKEND = path.join(DESKTOP_ROOT, 'dist', 'main', 'backend');
const PARITY_DIR = path.join(REPO_ROOT, 'contracts', 'fixtures', 'pack-extract-parity');
const PARITY_ZIP = path.join(PARITY_DIR, 'parity-pack.zip');
const PARITY_GOLDEN = path.join(PARITY_DIR, 'golden.manifest.json');
const PARITY_FILENAME = 'parity-pack.zip';
const WATCHDOG_MS = 240_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const SERVICE_NAME = 'TrainingApp pack extractor';

function say(line) {
  process.stdout.write(`${line}\n`);
}

let finished = false;
function finish(code, failReason) {
  if (finished) return;
  finished = true;
  if (failReason !== undefined) say(`HARNESS-FAIL:${failReason}`);
  // PRR-008 (review round 1): watchdog/uncaught paths bypass run()'s finally,
  // so reap live children and the temp dir here too (best-effort).
  try {
    if (typeof worker !== 'undefined' && worker?.terminatePackWorkers) worker.terminatePackWorkers();
    if (typeof tmp !== 'undefined' && tmp) fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* best-effort */ }
  app.exit(code);
}

const watchdog = setTimeout(() => finish(1, `watchdog: no verdict within ${WATCHDOG_MS} ms`), WATCHDOG_MS);
watchdog.unref?.();

process.on('uncaughtException', (err) => finish(1, `uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (err) => finish(1, `unhandledRejection: ${err?.stack ?? err}`));

// No window is ever opened; keep the app alive until finish().
app.on('window-all-closed', () => {});

async function importDist(rel) {
  const file = path.join(DIST_BACKEND, rel);
  if (!fs.existsSync(file)) {
    throw new Error(`compiled module missing: ${file} (run \`npm --prefix desktop run compile\`)`);
  }
  return import(pathToFileURL(file).href);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Relative posix path -> sha256 for every FILE under dir (recursive, sorted) —
 * the exact golden.manifest.json files[] shape. */
function treeManifest(dir) {
  const files = [];
  const walk = (rel) => {
    const abs = rel === '' ? dir : path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile()) files.push({ path: relPath, sha256: sha256(fs.readFileSync(path.join(dir, relPath))) });
    }
  };
  walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(pid, what) {
  const goneBy = Date.now() + 5_000;
  while (Date.now() < goneBy && isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  if (isAlive(pid)) throw new Error(`${what} (pid ${pid}) is still alive`);
}

async function run() {
  if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('ELECTRON_RUN_AS_NODE is set: this must run as an Electron main process');
  if (typeof process.versions.electron !== 'string') throw new Error('not running under Electron');

  const worker = await importDist(path.join('packs', 'pack-worker.js'));
  const zipInstall = await importDist(path.join('packs', 'zip-install.js'));
  const packManager = await importDist(path.join('store', 'pack-manager.js'));
  for (const name of [
    'setPackWorkerForkFn',
    'resolvePackWorkerForkFn',
    'extractPackZipOutOfProcess',
    'extractPackZipWithOptions',
    'terminatePackWorkers',
    'packWorkerChildPath',
  ]) {
    if (typeof worker[name] !== 'function') throw new Error(`pack-worker.js does not export ${name}`);
  }
  if (typeof zipInstall.extractPackZip !== 'function') throw new Error('zip-install.js does not export extractPackZip');
  if (typeof packManager.PackManagerError !== 'function') throw new Error('pack-manager.js does not export PackManagerError');
  if (!worker.packWorkerChildPath().endsWith('pack-extract-child.js')) {
    throw new Error(`the default child is not the compiled sibling: ${worker.packWorkerChildPath()}`);
  }
  const extractPackZip = zipInstall.extractPackZip; // the PUBLIC production API (surface.ts's import seam)

  const parityBytes = new Uint8Array(fs.readFileSync(PARITY_ZIP));
  const golden = JSON.parse(fs.readFileSync(PARITY_GOLDEN, 'utf8'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack electron harness '));
  try {
    // Inside Electron with nothing registered the runner must REFUSE — never
    // decompress in-process.
    if (worker.resolvePackWorkerForkFn(true) !== null) throw new Error('a launcher resolved inside Electron before registration');
    let refusal;
    try {
      await extractPackZip(parityBytes, PARITY_FILENAME);
    } catch (err) {
      refusal = err;
    }
    if (!(refusal instanceof Error) || !/^pack worker: /.test(refusal.message) || !/refus/i.test(refusal.message)) {
      throw new Error(`the unregistered runner did not refuse with the pack worker prefix: ${String(refusal?.message ?? refusal)}`);
    }

    // The launcher, exactly as desktop/main/index.ts registers it: stdout
    // discarded (the report rides parentPort), stderr piped for the detail.
    // Every launch records the child's OS pid and the per-call workspace the
    // launcher argv names (args[0] = <work>/input.zip, args[1] = <work>/out).
    const launches = [];
    worker.setPackWorkerForkFn((modulePath, args) => {
      const child = utilityProcess.fork(modulePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        serviceName: SERVICE_NAME,
      });
      const record = { modulePath, args: [...args], pid: undefined };
      launches.push(record);
      // pid is undefined until the child has spawned.
      if (typeof child.pid === 'number') record.pid = child.pid;
      else child.once('spawn', () => {
        if (typeof child.pid === 'number') record.pid = child.pid;
      });
      return child;
    });
    if (worker.resolvePackWorkerForkFn(true) === null) throw new Error('registration did not take effect');
    const forks = () => launches.length;
    const lastLaunch = () => launches[launches.length - 1];
    const workspaceOf = (record) => path.dirname(record.args[0]);

    // The committed fixture must be the golden's own bytes.
    if (sha256(parityBytes) !== golden.fixtureZipSha256) {
      throw new Error('parity-pack.zip does not hash to golden.manifest.json fixtureZipSha256');
    }
    const goldenFilesJson = JSON.stringify(golden.files);
    const assertGoldenTree = (dir, label) => {
      if (!path.isAbsolute(dir)) throw new Error(`${label}: the returned dir is not absolute: ${dir}`);
      if (!path.basename(dir).startsWith('pack-install-')) {
        throw new Error(`${label}: the returned dir is not a fresh pack-install-* dir: ${dir}`);
      }
      const got = treeManifest(dir);
      if (JSON.stringify(got) !== goldenFilesJson) {
        throw new Error(`${label}: the extracted tree differs from the golden: ${JSON.stringify(got).slice(0, 300)}`);
      }
      return got.length;
    };

    // (a) PARITY through the PUBLIC production API and the real
    // utilityProcess transport.
    const parityBefore = forks();
    const adopted = await extractPackZip(parityBytes, PARITY_FILENAME);
    if (forks() !== parityBefore + 1) throw new Error('parity extraction did not fork exactly once through the registered launcher');
    const parityLaunch = lastLaunch();
    if (parityLaunch.modulePath !== worker.packWorkerChildPath()) {
      throw new Error(`the parity launch did not use the production child: ${parityLaunch.modulePath}`);
    }
    if (parityLaunch.args[2] !== PARITY_FILENAME) throw new Error(`the child argv filename is not ${PARITY_FILENAME}: ${parityLaunch.args[2]}`);
    const fileCount = assertGoldenTree(adopted, 'parity');
    const parityWorkspace = workspaceOf(parityLaunch);
    if (adopted === parityWorkspace || adopted.startsWith(`${parityWorkspace}${path.sep}`)) {
      throw new Error(`the returned dir is the workspace itself: ${adopted}`);
    }
    if (fs.existsSync(parityWorkspace)) throw new Error(`the parity workspace survived: ${parityWorkspace}`);
    fs.rmSync(adopted, { recursive: true, force: true });
    say(
      `HARNESS-PACK-PARITY-OK (tree == golden.manifest.json ${fileCount} files; fixture sha256 ${golden.fixtureZipSha256.slice(0, 12)}…; ` +
        `returned ${path.basename(adopted)} != workspace ${path.basename(parityWorkspace)}; workspace removed)`,
    );

    // A healthy REAL-child extraction: the parent-survival witness each
    // failure case below is followed by.
    const healthyExtraction = async (label) => {
      const before = forks();
      const dir = await extractPackZip(parityBytes, PARITY_FILENAME);
      if (forks() !== before + 1) throw new Error(`${label}: the healthy extraction did not fork the production child`);
      assertGoldenTree(dir, `${label} healthy`);
      if (fs.existsSync(workspaceOf(lastLaunch()))) throw new Error(`${label}: the healthy extraction's workspace survived`);
      fs.rmSync(dir, { recursive: true, force: true });
    };

    // (b) CRASH: a fixture .cjs child that exits 2 WITHOUT any report,
    // forked through the registered launcher via childPath (the sanctioned
    // extractPackZipWithOptions test-control surface; the production API has
    // no childPath/timeout options).
    const crashChild = path.join(tmp, 'crash-fixture-child.cjs');
    fs.writeFileSync(crashChild, "'use strict';\nprocess.exit(2);\n", 'utf8');
    const crashBefore = forks();
    let crashFailure;
    try {
      await worker.extractPackZipWithOptions(parityBytes, 'crash-pack.zip', undefined, {
        childPath: crashChild,
        timeoutMs: EXTRACT_TIMEOUT_MS,
      });
    } catch (err) {
      crashFailure = err;
    }
    if (forks() !== crashBefore + 1) throw new Error('the crash case did not fork through the registered launcher');
    if (!(crashFailure instanceof Error)) throw new Error(`crash child did not reject as an Error (got ${String(crashFailure)})`);
    if (crashFailure instanceof packManager.PackManagerError) {
      throw new Error(`the runner-fabricated crash rejection must be a plain Error, not PackManagerError: ${crashFailure.message}`);
    }
    if (!/^pack worker: /.test(crashFailure.message) || !/exit/i.test(crashFailure.message) || !/\b2\b/.test(crashFailure.message)) {
      throw new Error(`the crash rejection must be a pack-worker Error naming exit code 2: ${JSON.stringify(crashFailure.message)}`);
    }
    await healthyExtraction('crash');

    // POISON: garbage bytes parsed by the REAL production child. The child's
    // report-derived failure rejects as PackManagerError with the exact
    // not-zip message (the central-directory pre-filter never finds an EOCD).
    const poisonBytes = Buffer.from('PK\x03\x04 poisoned: not a real zip container \x00\xff\xfe', 'latin1');
    const poisonBefore = forks();
    let poisonFailure;
    try {
      await extractPackZip(new Uint8Array(poisonBytes), 'poisoned-pack.zip');
    } catch (err) {
      poisonFailure = err;
    }
    if (forks() !== poisonBefore + 1) throw new Error('the poisoned extraction did not fork a child');
    if (!(poisonFailure instanceof packManager.PackManagerError)) {
      throw new Error(`the poisoned zip did not reject as a PackManagerError (got ${String(poisonFailure)})`);
    }
    if (poisonFailure.message !== 'poisoned-pack.zip: not a readable zip archive (no end-of-central-directory record)') {
      throw new Error(`the poison rejection does not carry the exact not-zip message: ${JSON.stringify(poisonFailure.message)}`);
    }
    await healthyExtraction('poison');
    say(
      `HARNESS-PACK-POISON-CONTAINED (crash: ${crashFailure.message.slice(0, 100)}; ` +
        `poison: ${poisonFailure.message.slice(0, 100)}; a healthy extraction succeeded after each)`,
    );

    // (c) HANG: a fixture .cjs child that NEVER reports and NEVER exits.
    const hungChild = path.join(tmp, 'hung-fixture-child.cjs');
    fs.writeFileSync(hungChild, "'use strict';\nsetInterval(() => {}, 1000);\n", 'utf8');
    const hangBefore = forks();
    const startedAt = Date.now();
    let killFailure;
    try {
      await worker.extractPackZipWithOptions(parityBytes, 'hung-pack.zip', undefined, {
        childPath: hungChild,
        timeoutMs: 400,
      });
    } catch (err) {
      killFailure = err;
    }
    const elapsedMs = Date.now() - startedAt;
    if (forks() !== hangBefore + 1) throw new Error('the hang case did not fork through the registered launcher');
    if (!(killFailure instanceof Error)) throw new Error(`the hung child did not reject as an Error (got ${String(killFailure)})`);
    if (!/^pack worker: /.test(killFailure.message) || !/timed out/i.test(killFailure.message)) {
      throw new Error(`the hung-child rejection must be a pack-worker Error naming the timeout: ${JSON.stringify(killFailure.message)}`);
    }
    if (elapsedMs > 5_000) throw new Error(`the deadline took ${elapsedMs} ms to settle`);
    const hungRecord = lastLaunch();
    if (typeof hungRecord.pid !== 'number') throw new Error('the hung utilityProcess child exposed no pid');
    await waitForGone(hungRecord.pid, 'the killed hung child');
    await healthyExtraction('hang');
    say(
      `HARNESS-PACK-HANG-KILLED (${killFailure.message.slice(0, 120)}; settled in ${elapsedMs} ms; pid ${hungRecord.pid} gone)`,
    );

    // (d) PROCESS BOUNDARY: every child ran in its own OS process.
    const parentPid = process.pid;
    // pids arrive on 'spawn'; give late spawn events a moment.
    const settledBy = Date.now() + 2_000;
    while (Date.now() < settledBy && launches.some((record) => record.pid === undefined)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const childPids = launches.map((record) => record.pid).filter((pid) => typeof pid === 'number');
    if (childPids.length === 0) throw new Error('no child pid was recorded');
    const unique = [...new Set(childPids)];
    if (unique.includes(parentPid)) throw new Error(`a pack child ran in the parent PID ${parentPid}`);
    say(`HARNESS-PACK-PIDS parent=${parentPid} children=[${unique.join(',')}] (forks=${launches.length}; all differ from the parent)`);
  } finally {
    worker.terminatePackWorkers();
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
