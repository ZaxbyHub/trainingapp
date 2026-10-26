/**
 * trace-hygiene.mjs — committed guard + wrapper conventions for future
 * issue-tracer traces in this repo (issue #183, PRR-038).
 *
 * During the #131 trace (2026-10-13) frozen check wrappers (a) planted a
 * two-file @playwright/test stub under `$REPO_ROOT/desktop/node_modules`
 * behind an existence-only guard and actually REPLACED the main checkout's
 * real package, and (b) created Windows junctions
 * `<worktree>/desktop/node_modules -> <main>/desktop/node_modules` without
 * removal. The good pattern (git-common-dir root derivation, main-checkout
 * refusal, journaled junction create->remove->verify) existed only as
 * trace-local folklore; this module commits it. The local census at filing
 * time: 133 junction-creating trace scripts, 97 with removal, 36 without, 0
 * with removal verification, 2 stub-planters, one realized incident.
 *
 * Wrapper conventions (see CONTRIBUTING.md "Trace evidence and
 * acceptance-check conventions"):
 *   1. NEVER plant a stub when the wrapper root resolves to the MAIN checkout
 *      and the target package is absent — call
 *      `assertStubPlantAllowed({ repoRoot, packagePath })` first;
 *   2. create junctions ONLY through `createJunction` (journaled) and remove
 *      them ONLY through `removeJournaledJunctions`, which verifies absence
 *      with lstat semantics (existsSync alone lies for dangling links);
 *   3. frozen historical wrappers stay byte-identical — they are counted, not
 *      amended.
 *
 * CLI (both verbs exit nonzero with a named error on any failure):
 *   node scripts/trace-hygiene.mjs selfcheck
 *   node scripts/trace-hygiene.mjs refuse-stub --repo-root <root> --package <path>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'trace-hygiene';

export const ERR_REFUSED_MAIN_CHECKOUT = 'TRACE_HYGIENE_REFUSED_MAIN_CHECKOUT';
export const ERR_REFUSED_STUB_MAIN_CHECKOUT = 'TRACE_HYGIENE_REFUSED_STUB_MAIN_CHECKOUT';
export const ERR_REFUSED_UNRESOLVED_ROOT = 'TRACE_HYGIENE_REFUSED_UNRESOLVED_ROOT';
export const ERR_JUNCTION_LEFT = 'TRACE_HYGIENE_JUNCTION_LEFT';

export class TraceHygieneRefused extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'TraceHygieneRefused';
    this.code = code;
  }
}

/** Canonical comparison form: absolute, forward slashes, case-folded on
 *  Windows (slash direction, drive-letter case, and alias paths must not
 *  defeat the main-checkout refusal). */
export function canonicalPath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
}

/**
 * The MAIN checkout root for the repository containing `repoRoot` (which may
 * be a linked worktree): `git rev-parse --path-format=absolute
 * --git-common-dir` gives the shared .git directory; its parent is the main
 * checkout. The 201-trace idiom (check-c1.sh), committed at last.
 */
export function resolveMainRoot(repoRoot) {
  // Strip git env overrides: GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE would make
  // this lookup resolve an unrelated repository and fail the refusal OPEN
  // (review round: GIT_DIR redirection probe).
  const gitEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) delete gitEnv[key];
  const commonDir = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    env: gitEnv,
  }).trim();
  const stripped = commonDir.replace(/[\\/]+\.git[\\/]*$/i, '');
  return stripped.length > 0 ? stripped : path.dirname(commonDir);
}

/** True when `candidate` is the main checkout itself or anywhere INSIDE it
 *  (git walks up, so a wrapper root resolving to a subdir of the main
 *  checkout still lands in the main tree — the hazard must not slip through
 *  on an exact-equality compare). */
export function isInsideMainCheckout(candidate, mainRoot) {
  const from = canonicalPath(mainRoot);
  const to = canonicalPath(candidate);
  const rel = path.relative(from, to);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Refuse when `repoRoot` is the main checkout itself or inside it (a
 *  disposable worktree — a SIBLING of the main checkout — passes). */
export function assertNotMainCheckout(repoRoot) {
  const mainRoot = resolveMainRoot(repoRoot);
  if (isInsideMainCheckout(repoRoot, mainRoot)) {
    throw new TraceHygieneRefused(
      ERR_REFUSED_MAIN_CHECKOUT,
      `${repoRoot} IS the main checkout (${mainRoot}) — mutating operations (stub planting, junction creation) are only allowed inside disposable worktrees`,
    );
  }
  return mainRoot;
}

/**
 * Gate for stub planting: ALLOWED when the target package already exists
 * (nothing to plant), or when the wrapper root is a disposable worktree.
 * REFUSED (named, nonzero) when the root resolves to the main checkout AND
 * the package is absent — the exact mechanism that replaced the main
 * checkout's real @playwright/test during the #131 trace.
 */
export function assertStubPlantAllowed({ repoRoot, packagePath }) {
  if (fs.existsSync(packagePath)) return 'present';
  let mainRoot;
  try {
    mainRoot = resolveMainRoot(repoRoot);
  } catch (err) {
    // Fail closed: a root with no readable git context cannot be proven to be
    // a disposable worktree.
    throw new TraceHygieneRefused(
      ERR_REFUSED_UNRESOLVED_ROOT,
      `${repoRoot} has no readable git context (${err instanceof Error ? err.message : err}) — cannot prove it is a disposable worktree; refusing to plant`,
    );
  }
  if (isInsideMainCheckout(repoRoot, mainRoot)) {
    throw new TraceHygieneRefused(
      ERR_REFUSED_STUB_MAIN_CHECKOUT,
      `${packagePath} is absent and ${repoRoot} is inside the main checkout (${mainRoot}) — ` +
        'planting a stub here would REPLACE the real package (the #131 incident); run inside a disposable worktree',
    );
  }
  return 'allowed-disposable';
}

function readJournal(journalPath) {
  let text;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return []; // no journal yet
    // An unreadable journal must fail LOUD: a silent [] would let
    // removeJournaledJunctions report success while destroying the record
    // (review round: corrupt-journal probe).
    throw new TraceHygieneRefused('TRACE_HYGIENE_JOURNAL_CORRUPT', journalPath + ' is unreadable: ' + (err instanceof Error ? err.message : String(err)));
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      throw new TraceHygieneRefused(
        'TRACE_HYGIENE_JOURNAL_CORRUPT',
        journalPath + ' has an unparsable line (' + (err instanceof Error ? err.message : String(err)) + ') - fix or delete the journal before continuing; the links it records may still exist',
      );
    }
  }
  return entries;
}

function rewriteJournal(journalPath, entries) {
  if (entries.length === 0) {
    try {
      fs.rmSync(journalPath, { force: true });
    } catch {
      // best-effort cleanup of an already-absent journal
    }
    return;
  }
  fs.writeFileSync(journalPath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

/**
 * Create a directory junction (win32) or symlink (posix) at `link` pointing
 * to `target`, journaled at `journalPath` so `removeJournaledJunctions` can
 * guarantee removal. The journal entry is written BEFORE creation (removal
 * must never miss a created link); if the journal write fails, nothing is
 * created; if the link creation fails, the intent entry is rolled back.
 */
export function createJunction(link, target, journalPath) {
  const intent = { link: path.resolve(link), target: path.resolve(target), pid: process.pid };
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  // Append (never rewrite): concurrent creators cannot lose each other's
  // entries, and an interrupted append cannot corrupt earlier lines.
  fs.appendFileSync(journalPath, JSON.stringify(intent) + '\n', 'utf8');
  try {
    fs.symlinkSync(path.resolve(target), path.resolve(link), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    // Roll the intent back: the link was NOT created, so a lingering entry
    // would make the next removal run report a phantom.
    rewriteJournal(journalPath, readJournal(journalPath).filter((e) => e.link !== intent.link));
    throw err;
  }
  return intent;
}

/**
 * Remove every journaled junction and VERIFY absence with lstat semantics
 * (existsSync follows links and lies for dangling ones). Any survivor —
 * including a NON-link left at a journaled path — throws
 * TRACE_HYGIENE_JUNCTION_LEFT naming the path; the journal is preserved in
 * that case so a retry can finish the job.
 */
export function removeJournaledJunctions(journalPath) {
  const entries = readJournal(journalPath); // throws TRACE_HYGIENE_JOURNAL_CORRUPT on damage
  const survivors = [];
  for (const entry of entries) {
    // lstat (never existsSync — it follows links and lies for dangling ones).
    let st = null;
    try {
      st = fs.lstatSync(entry.link);
    } catch {
      continue; // already gone: verified absence
    }
    // A NON-link at a journaled path is a survivor BY DEFINITION: a wrapper
    // must never recursively delete a real tree that sits where its junction
    // was supposed to be (issue #183 round-4 selfcheck invariant).
    if (!st.isSymbolicLink()) {
      survivors.push(entry.link);
      continue;
    }
    // Link-only removal (unlinkSync removes a junction/symlink link itself,
    // never its target).
    try {
      fs.unlinkSync(entry.link);
    } catch {
      // fall through to verification
    }
    try {
      // eslint-disable-next-line no-new
      fs.lstatSync(entry.link);
      survivors.push(entry.link);
    } catch {
      // verified gone
    }
  }
  if (survivors.length > 0) {
    throw new TraceHygieneRefused(
      ERR_JUNCTION_LEFT,
      `journaled junction(s) still present after removal: ${survivors.join(', ')} — remove them manually before continuing`,
    );
  }
  rewriteJournal(journalPath, []);
  return entries.length;
}

// ---- CLI -------------------------------------------------------------------

function selfcheck() {
  const results = [];
  const tmp = fs.mkdtempSync(path.join(import.meta.dirname, 'selfcheck-'));
  try {
    // 1. Main-checkout stub refusal (the #131 incident mechanism). The root
    // under test is the MAIN checkout of whatever repo we run in - NOT cwd,
    // which in a linked worktree is a disposable root by definition.
    const repoRoot = resolveMainRoot(process.cwd());
    const absentPackage = path.join(tmp, 'absent-package');
    let refused = null;
    try {
      assertStubPlantAllowed({ repoRoot, packagePath: absentPackage });
    } catch (err) {
      refused = err;
    }
    if (refused === null || refused.code !== ERR_REFUSED_STUB_MAIN_CHECKOUT) {
      throw new TraceHygieneRefused(ERR_REFUSED_STUB_MAIN_CHECKOUT, 'selfcheck: the main-checkout stub refusal did NOT fire');
    }
    results.push(`ok: stub planting refused on the main checkout (${ERR_REFUSED_STUB_MAIN_CHECKOUT})`);

    // 2. Disposable-worktree allowance: a LINKED WORKTREE of a seeded main
    //    repo is not the main checkout, so planting is allowed there.
    const mainRepo = path.join(tmp, 'main-repo');
    fs.mkdirSync(mainRepo, { recursive: true });
    const git = (args, cwd) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-b', 'main'], mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'seed.txt'), 'seed\n');
    git(['add', 'seed.txt'], mainRepo);
    git(['-c', 'user.name=selfcheck', '-c', 'user.email=selfcheck@invalid', 'commit', '-m', 'seed'], mainRepo);
    const disposable = path.join(tmp, 'linked-worktree');
    git(['worktree', 'add', disposable, 'HEAD'], mainRepo);
    assertStubPlantAllowed({ repoRoot: disposable, packagePath: absentPackage });
    results.push('ok: stub planting allowed inside a disposable (linked) worktree');

    // 3. Junction lifecycle: create -> present -> remove -> lstat-verified gone.
    const target = path.join(tmp, 'real-node-modules');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'probe.txt'), 'target\n');
    const link = path.join(tmp, 'linked-node_modules');
    const journal = path.join(tmp, 'junctions.jsonl');
    createJunction(link, target, journal);
    // eslint-disable-next-line no-new
    fs.lstatSync(link); // present
    removeJournaledJunctions(journal);
    let survived = false;
    try {
      // eslint-disable-next-line no-new
      fs.lstatSync(link);
      survived = true;
    } catch {
      survived = false;
    }
    if (survived) {
      throw new TraceHygieneRefused(ERR_JUNCTION_LEFT, `selfcheck: ${link} survived removal`);
    }
    results.push('ok: journaled junction created, removed, and lstat-verified gone');

    // 4. Forced leftover: a REAL directory at a journaled path must be caught
    //    (lstat semantics, not existsSync-follows-link).
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(journal, `${JSON.stringify({ link: path.resolve(link), target: path.resolve(target), pid: 0 })}\n`, 'utf8');
    let left = null;
    try {
      removeJournaledJunctions(journal);
    } catch (err) {
      left = err;
    }
    if (left === null || left.code !== ERR_JUNCTION_LEFT) {
      throw new TraceHygieneRefused(ERR_JUNCTION_LEFT, 'selfcheck: the leftover verification did NOT catch a survivor');
    }
    results.push(`ok: leftover verification bites (${ERR_JUNCTION_LEFT})`);
    fs.rmSync(link, { recursive: true, force: true });
    return results;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function refuseStub(args) {
  const get = (name) => {
    const i = args.indexOf(name);
    if (i === -1 || i + 1 >= args.length) throw new Error(`${name} requires a value`);
    return args[i + 1];
  };
  const repoRoot = get('--repo-root');
  const packagePath = get('--package');
  const verdict = assertStubPlantAllowed({ repoRoot, packagePath });
  console.log(`${SCRIPT}: stub planting ${verdict === 'present' ? 'unnecessary (package present)' : 'allowed (disposable worktree)'} — ${packagePath}`);
}

export function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === 'selfcheck') {
    const lines = selfcheck();
    for (const line of lines) console.log(`${SCRIPT}: ${line}`);
    console.log(`${SCRIPT}: selfcheck PASS`);
    return 0;
  }
  if (verb === 'refuse-stub') {
    refuseStub(rest);
    return 0;
  }
  throw new Error(`unknown verb: ${verb ?? '(none)'} — usage: trace-hygiene.mjs {selfcheck|refuse-stub --repo-root <root> --package <path>}`);
}

// Entry guard: importing this module (the committed spec does) must never run
// the CLI.
function isDirectInvocation(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isDirectInvocation(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const code = err instanceof TraceHygieneRefused ? err.code : 'TRACE_HYGIENE_FAILED';
    console.error(`${SCRIPT}: ${code}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}
