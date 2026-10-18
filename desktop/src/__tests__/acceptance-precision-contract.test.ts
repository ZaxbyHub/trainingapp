/**
 * acceptance-precision-contract.test.ts — the precision guards for the
 * packaged-smoke acceptance battery (issue #219 AC6/AC7/AC8, batch AC6-AC8).
 *
 * Three guards, selected by the frozen acceptance filters:
 *   -t pin-comments      (AC6): every third-party `uses:` line is SHA-pinned
 *                        with a version comment that agrees with the committed
 *                        pin record .github/workflows/pins.json.
 *   -t filter-uniqueness (AC7): each frozen battery filter name matches
 *                        EXACTLY ONE test in packaged-smoke-contract.test.ts.
 *   -t inventory         (AC8): the published TEST_INVENTORY equals the actual
 *                        test set and every test is in the closed set or the
 *                        declared extras list.
 *
 * The guards read the packaged-smoke spec as SOURCE text (never import it —
 * importing a test file would register its tests twice).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const SPEC_PATH = path.join(REPO_ROOT, 'desktop', 'src', '__tests__', 'packaged-smoke-contract.test.ts');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const PINS_PATH = path.join(WORKFLOWS_DIR, 'pins.json');

/** The 10 frozen battery filter names (packaged-smoke-cdp batch's closed set).
 *  Uniqueness is asserted WITHIN packaged-smoke-contract.test.ts — the battery's
 *  frozen checks invoke `-t` file-scoped (PR #220 review PRR-003). Suite-wide
 *  `-t kill-guard` also matches the harness-kill-guard contract family by
 *  design (the C1 frozen filter `harness-kill-guard` contains it). */
const FROZEN_FILTERS = [
  'watchdog-exit2',
  'attach-timeout-count',
  'kill-guard',
  'taskkill-status',
  'signal-reap',
  'close-idempotent',
  'graceful-window',
  'endpoint-bind',
  'per-boot-buffers',
  'buffer-cap',
] as const;

/** The declared extras (issue #219 AC8 / batch AC8): 3 renamed duplicates + 3 recorded non-battery probes. */
const DECLARED_EXTRAS = [
  'watchdog-arm-latch: fires when armed, stays off while suspended, and latches after firing',
  'close-survived-verdict: a survived close keeps the assertion-failure verdict and resumes the watchdog',
  'buffer-chunk-lines: chunk-boundary appends keep lines intact',
  'bound-evaluate-rejects: the bound fires when the inner evaluate hangs',
  'parse seams stay pinned (parseDriver / parseDevToolsEndpoint / redact)',
  'spawn-failure-verdict: the dedicated spawn exit honors both verdict poles and cleans up',
] as const;

function readSpecSource(): string {
  return fs.readFileSync(SPEC_PATH, 'utf8');
}

/** Every it()/test() name literal in the spec source (any quote style — PR #220
 *  review PRR-001: single-quote-only scraping let double-quoted/backtick names
 *  evade both guards). A name with an escaped quote still parses loudly wrong
 *  (set inequality fails), never silently invisible. */
function parseTestNames(source: string): string[] {
  const names: string[] = [];
  const re = /\b(?:it|test)(?:\.\w+)?\(\s*(['"`])([^'"`]*)\1/g;
  for (;;) {
    const m = re.exec(source);
    if (m === null) break;
    names.push(m[2]);
  }
  return names;
}

/** The published TEST_INVENTORY string literals in the spec source (any quote style). */
function parsePublishedInventory(source: string): string[] {
  const start = source.indexOf('export const TEST_INVENTORY');
  expect(start, 'packaged-smoke-contract.test.ts must publish export const TEST_INVENTORY').toBeGreaterThanOrEqual(0);
  const block = source.slice(start, source.indexOf('];', start) + 2);
  const names: string[] = [];
  const re = /(['"`])([^'"`]*)\1/g;
  for (;;) {
    const m = re.exec(block);
    if (m === null) break;
    names.push(m[2]);
  }
  return names;
}

interface PinRecordEntry {
  action: string;
  sha: string;
  versions: string[];
}

function readPinRecord(): PinRecordEntry[] {
  const raw = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8')) as { entries: PinRecordEntry[] };
  expect(Array.isArray(raw.entries), 'pins.json must carry an entries array').toBe(true);
  // PR #220 review PRR-009b: the record validates its own shape — well-typed
  // entries, no duplicate action@sha (first-match shadowing), no unused rows.
  const seen = new Set<string>();
  for (const entry of raw.entries) {
    expect(typeof entry.action, 'pin entry action must be a string').toBe('string');
    expect(typeof entry.sha, 'pin entry sha must be a string').toBe('string');
    expect(Array.isArray(entry.versions), `pin entry ${entry.action} versions must be an array`).toBe(true);
    for (const v of entry.versions) expect(typeof v, 'pin version labels must be strings').toBe('string');
    const key = `${entry.action}@${entry.sha}`;
    expect(seen.has(key), `duplicate pin record entry: ${key}`).toBe(false);
    seen.add(key);
  }
  return raw.entries;
}

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
const USES_KEY_SHAPE = /^\s*(?:-\s+)?["']?uses["']?\s*:/;
const SHA_REF = /^([\w-]+\/[\w.-]+)@([0-9a-f]{40})$/;
const COMMENT_LABEL = /^#\s*(\S+)\s*$/;
const LABEL_SHAPE = /^v\d+(?:\.\d+)*$/;

describe('acceptance precision contract (issue #219)', () => {
  it('pin-comments: every third-party uses line is sha-pinned with a pin-record-agreeing version comment', () => {
    const record = readPinRecord();
    const problems: string[] = [];
    const usedPairs = new Set<string>();
    let usesLines = 0;
    for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const source = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      for (const line of source.split(/\r?\n/)) {
        // Fail closed on `uses`-key spellings the strict parser cannot read
        // (PR #220 review PRR-022: `uses : x` and `"uses": x` are the same
        // YAML key and must not silently escape the pin check).
        if (USES_KEY_SHAPE.test(line) && !USES_LINE.test(line)) {
          problems.push(`${file}: unrecognized uses line spelling: ${line.trim()}`);
          continue;
        }
        const m = USES_LINE.exec(line);
        if (m === null) continue;
        const ref = m[1];
        const rest = m[2];
        if (ref.startsWith('./') || ref.startsWith('.\\')) continue; // local action
        usesLines += 1;
        const shaMatch = SHA_REF.exec(ref);
        if (shaMatch === null) {
          problems.push(`${file}: unpinned uses ref: ${line.trim()}`);
          continue;
        }
        const action = shaMatch[1];
        const sha = shaMatch[2];
        const comment = rest.trim();
        const labelMatch = COMMENT_LABEL.exec(comment);
        if (labelMatch === null) {
          problems.push(`${file}: missing or malformed version comment: ${line.trim()}`);
          continue;
        }
        const label = labelMatch[1];
        if (!LABEL_SHAPE.test(label)) {
          problems.push(`${file}: malformed version comment label '${label}': ${line.trim()}`);
          continue;
        }
        const entry = record.find((e) => e.action === action && e.sha === sha);
        if (entry === undefined) {
          problems.push(`${file}: action@sha absent from pins.json: ${ref}`);
          continue;
        }
        usedPairs.add(`${action}@${sha}`);
        if (!entry.versions.includes(label)) {
          problems.push(`${file}: comment '${label}' disagrees with pins.json versions ${JSON.stringify(entry.versions)} for ${ref}`);
        }
      }
    }
    // PRR-009b: a record entry no line uses is stale — flag it.
    for (const entry of record) {
      const key = `${entry.action}@${entry.sha}`;
      if (!usedPairs.has(key)) problems.push(`pins.json entry is unused/stale: ${key}`);
    }
    expect(problems, `pin-comment problems:\n${problems.join('\n')}`).toEqual([]);
    expect(usesLines, 'the workflows must carry third-party uses lines to validate').toBeGreaterThan(0);
  });

  it('filter-uniqueness: each frozen battery filter matches exactly one test name in the battery spec', () => {
    const names = parseTestNames(readSpecSource());
    const problems: string[] = [];
    for (const filter of FROZEN_FILTERS) {
      const matches = names.filter((n) => n.includes(filter));
      if (matches.length !== 1) {
        problems.push(`filter '${filter}' matches ${matches.length} tests: ${JSON.stringify(matches)}`);
      }
    }
    expect(problems, `filter-uniqueness problems:\n${problems.join('\n')}`).toEqual([]);
  });

  it('inventory: the published inventory equals the actual test set and closed set union declared extras', () => {
    const source = readSpecSource();
    const actual = parseTestNames(source);
    const published = parsePublishedInventory(source);

    // inventory == actual (set equality).
    expect([...published].sort()).toEqual([...actual].sort());

    // Every actual test is the unique match of a frozen filter (closed set)
    // or an explicitly declared extra.
    const problems: string[] = [];
    for (const name of actual) {
      const isClosed = FROZEN_FILTERS.some((f) => name.includes(f));
      const isExtra = (DECLARED_EXTRAS as readonly string[]).includes(name);
      if (!isClosed && !isExtra) {
        problems.push(`test outside closed set and declared extras: '${name}'`);
      }
    }
    // The declared extras themselves must all exist (no stale extras rows).
    for (const extra of DECLARED_EXTRAS) {
      if (!actual.includes(extra)) {
        problems.push(`declared extra is not a test in the spec: '${extra}'`);
      }
    }
    expect(problems, `inventory problems:\n${problems.join('\n')}`).toEqual([]);
  });
});
