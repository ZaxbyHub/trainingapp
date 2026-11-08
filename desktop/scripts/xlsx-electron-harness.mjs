// xlsx-electron-harness.mjs — issue #319 AC1 real-Electron leg (trace
// 319-dependency-gate-follow-through, revision 3; maintainer-accepted Q2).
//
// An Electron MAIN-process harness (no BrowserWindow). It drives the
// PRODUCTION xlsx child through the REAL Electron utilityProcess transport
// (fork, parentPort report, exit, kill) — the leg vitest cannot reach, since
// the vitest specs stub `electron`. It:
//   1. imports the COMPILED desktop/dist/main/backend/ingest/xlsx-worker.js
//      and extractors.js (needs `npm --prefix desktop run compile` first);
//   2. registers setXlsxWorkerForkFn with a utilityProcess launcher EXACTLY
//      like desktop/main/index.ts registers it in app.whenReady();
//   3. (a) extracts contracts/fixtures/xlsx-parity/parity.xlsx through
//      extractDocumentFromFile and prints HARNESS-PARITY-OK iff the text
//      equals parity.expected.txt;
//      (b) CRASH: a fixture .cjs child that exits 2 with no report, forked
//      through the registered launcher (childPath) — prints
//      HARNESS-CRASH-CONTAINED iff it rejects naming exit 2 AND a following
//      healthy real-child extraction still succeeds;
//      (c) KILL: a fixture .cjs child that never exits, timeoutMs 400 —
//      prints HARNESS-KILL-CONTAINED iff the extraction times out, the child
//      process is gone (pid polled when observable), and a following healthy
//      real-child extraction still succeeds;
//      (d) extracts a poisoned workbook it writes to a temp dir and prints
//      HARNESS-POISON-CONTAINED iff that rejects as a normal Error AND a
//      following good extraction still succeeds (the parent stayed healthy);
//   4. app.exit(0) when all four markers printed, else app.exit(1).
// Every failure prints `HARNESS-FAIL:<reason>` and exits non-zero; a
// watchdog bounds the whole run.
//
// Residual (disclosed, 06c-swarm-critic-decisions.md): this runs the compiled
// child OUTSIDE app.asar; packaged asar module resolution is not exercised.
//
// Run (from the repo root; electron is a desktop devDependency):
//   npx electron desktop/scripts/xlsx-electron-harness.mjs      (electron on PATH/root)
//   desktop/node_modules/.bin/electron desktop/scripts/xlsx-electron-harness.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, utilityProcess } from 'electron';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..');
const DIST_INGEST = path.join(DESKTOP_ROOT, 'dist', 'main', 'backend', 'ingest');
const PARITY_DIR = path.join(REPO_ROOT, 'contracts', 'fixtures', 'xlsx-parity');
const PARITY_XLSX = path.join(PARITY_DIR, 'parity.xlsx');
const PARITY_GOLDEN = path.join(PARITY_DIR, 'parity.expected.txt');
const WATCHDOG_MS = 180_000;
const EXTRACT_TIMEOUT_MS = 60_000;

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

async function run() {
  if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('ELECTRON_RUN_AS_NODE is set: this must run as an Electron main process');
  if (typeof process.versions.electron !== 'string') throw new Error('not running under Electron');

  const worker = await importDist('xlsx-worker.js');
  const extractors = await importDist('extractors.js');
  if (typeof worker.setXlsxWorkerForkFn !== 'function') throw new Error('xlsx-worker.js does not export setXlsxWorkerForkFn');
  if (typeof worker.resolveXlsxWorkerForkFn !== 'function') throw new Error('xlsx-worker.js does not export resolveXlsxWorkerForkFn');
  if (typeof extractors.extractDocumentFromFile !== 'function') throw new Error('extractors.js does not export extractDocumentFromFile');

  // Inside Electron with nothing registered the runner must REFUSE (null).
  if (worker.resolveXlsxWorkerForkFn(true) !== null) throw new Error('a launcher resolved inside Electron before registration');

  // The launcher, exactly as desktop/main/index.ts registers the GPU-probe one
  // (and, per the #319 plan, the xlsx one): stdout discarded (the report rides
  // parentPort), stderr piped for the failure detail.
  let forks = 0;
  let lastPid; // pid of the most recent utilityProcess child (liveness polls)
  worker.setXlsxWorkerForkFn((modulePath, args) => {
    forks += 1;
    const child = utilityProcess.fork(modulePath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      serviceName: 'TrainingApp workbook parser',
    });
    lastPid = child.pid;
    return child;
  });
  if (worker.resolveXlsxWorkerForkFn(true) === null) throw new Error('registration did not take effect');

  const golden = fs.readFileSync(PARITY_GOLDEN, 'utf8');

  // (a) parity through the real utilityProcess transport.
  const parity = await extractors.extractDocumentFromFile(PARITY_XLSX, { timeoutMs: EXTRACT_TIMEOUT_MS });
  if (forks < 1) throw new Error('parity extraction did not fork through the registered utilityProcess launcher');
  if (parity?.text !== golden) {
    throw new Error(`parity text differs from golden: ${JSON.stringify(parity?.text).slice(0, 200)}`);
  }
  say('HARNESS-PARITY-OK');

  // A healthy REAL-child extraction (the registered launcher + the default
  // childPath = the production child): the parent-survival witness each
  // failure case below is followed by.
  let healthySerial = 0;
  const healthyExtraction = async () => {
    healthySerial += 1;
    const file = path.join(tmp, `healthy ${healthySerial}.xlsx`);
    fs.copyFileSync(PARITY_XLSX, file);
    const forksBefore = forks;
    const result = await extractors.extractDocumentFromFile(file, { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (forks <= forksBefore) throw new Error('the healthy extraction did not fork the production child');
    if (result?.text !== golden) throw new Error('a healthy extraction returned text that differs from the golden');
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx electron harness '));
  try {
    // (b) CRASH: a controlled real-utilityProcess failure — a fixture .cjs
    //     child that exits 2 WITHOUT any report, forked through the
    //     registered launcher via childPath. Must reject naming exit 2; the
    //     parent stays healthy.
    const crashChild = path.join(tmp, 'crash-fixture-child.cjs');
    fs.writeFileSync(crashChild, "'use strict';\nprocess.exit(2);\n", 'utf8');
    const crashInput = path.join(tmp, 'crash input.xlsx');
    fs.copyFileSync(PARITY_XLSX, crashInput);
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
    say(`HARNESS-CRASH-CONTAINED (${crashFailure.message.slice(0, 160)})`);

    // (c) KILL: a controlled real-utilityProcess failure — a fixture .cjs
    //     child that NEVER exits (a bare setInterval), forked through the
    //     registered launcher. A short deadline must time the extraction out
    //     and kill the child; if its pid is observable, poll until the OS
    //     process is gone; the parent stays healthy either way.
    const hungChild = path.join(tmp, 'hung-fixture-child.cjs');
    fs.writeFileSync(hungChild, "'use strict';\nsetInterval(() => {}, 1000);\n", 'utf8');
    const hungInput = path.join(tmp, 'hung input.xlsx');
    fs.copyFileSync(PARITY_XLSX, hungInput);
    let hungPid;
    let killFailure;
    try {
      await extractors.extractDocumentFromFile(hungInput, { childPath: hungChild, timeoutMs: 400 });
    } catch (err) {
      killFailure = err;
    }
    hungPid = lastPid; // the launcher already forked (and the runner killed) it
    if (!(killFailure instanceof Error)) throw new Error(`the hung child did not reject as an Error (got ${String(killFailure)})`);
    if (!/timeout|timed out|deadline/i.test(killFailure.message)) {
      throw new Error(`the hung-child rejection must mention the timeout: ${JSON.stringify(killFailure.message)}`);
    }
    // pid liveness, best effort: the utilityProcess child object exposes pid;
    // if this Electron build hides it, the rejection + the healthy extraction
    // below still bound the case.
    if (typeof hungPid === 'number') {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        let alive = true;
        try {
          process.kill(hungPid, 0);
        } catch {
          alive = false;
        }
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      let stillAlive = true;
      try {
        process.kill(hungPid, 0);
      } catch {
        stillAlive = false;
      }
      if (stillAlive) throw new Error(`the killed hung child (pid ${hungPid}) is still alive`);
    }
    await healthyExtraction();
    say(`HARNESS-KILL-CONTAINED (${killFailure.message.slice(0, 160)}${typeof hungPid === 'number' ? `; pid ${hungPid} gone` : '; pid not observable'})`);

    // (d) poisoned workbook: an isolated, catchable failure; the parent stays healthy.
    const poisoned = path.join(tmp, 'poisoned.xlsx');
    fs.writeFileSync(poisoned, Buffer.from('PK\x03\x04 poisoned: not a real zip container \x00\xff\xfe', 'latin1'));
    const forksBefore = forks;
    let failure;
    try {
      await extractors.extractDocumentFromFile(poisoned, { timeoutMs: EXTRACT_TIMEOUT_MS });
    } catch (err) {
      failure = err;
    }
    if (forks <= forksBefore) throw new Error('poisoned extraction did not fork a child');
    if (!(failure instanceof Error)) throw new Error(`poisoned workbook did not reject as an Error (got ${String(failure)})`);

    const healthy = path.join(tmp, 'healthy copy.xlsx');
    fs.copyFileSync(PARITY_XLSX, healthy);
    const after = await extractors.extractDocumentFromFile(healthy, { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (after?.text !== golden) throw new Error('the extraction after the poisoned file did not succeed with the golden text');
    say(`HARNESS-POISON-CONTAINED (${failure.message.slice(0, 160)})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (typeof worker.terminateXlsxWorkers === 'function') worker.terminateXlsxWorkers();
}

app
  .whenReady()
  .then(run)
  .then(
    () => finish(0),
    (err) => finish(1, err instanceof Error ? err.message : String(err)),
  );
