// diagnostics-console-composition.test.ts — issue #248: the DRIFT PIN for the
// three-way desktop console policy (the reconciled AC5/AC7 contract).
//
// What this spec binds, in order:
//   1. spy-first, then wrapper: the wrapper passes through whatever console
//      methods are current at install (existing spies see the original args);
//   2. EVERY pinned corpus row (the frozen logline-contract-sweep requireLine
//      needles, materialized) passes through the console RAW on desktop;
//   3. per-template NEAR-MISS negatives (same pinned prefix, different
//      required static suffix / hex length / case) fail the template and fall
//      through to `[sanitized]` — widening fails closed;
//   4. the AC7_PINNED_LINE_TEMPLATES inventory is structurally compared with
//      the frozen corpus's requireLine templates in BOTH directions (a change
//      to one without the other fails here);
//   5. a non-pinned sensitive line gets the once-called `[sanitized]` form;
//   6. the same line is RAW on the console while its persisted form in the
//      file sink is redacted (console exception is console-only);
//   7. the classification-failure matrix rows: console suppression, persisted
//      drop, pinned-template-match independence of the redactor, and
//      warn-recursion safety;
//   8. the wrapper is removed BEFORE vi.restoreAllMocks (afterEach order).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub.js';

import {
  AC7_PINNED_LINE_TEMPLATES,
  __resetLoggingForTests,
  activateDiagnosticsLogging,
  installLoggingConsoleWrapper,
  matchesPinnedTemplate,
  type LogEntry,
} from '../../main/logging.js';
import { isSensitiveLine } from '../../main/logging-redact.js';

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
const SWEEP_PATH = path.join(REPO_ROOT, 'desktop', 'src', '__tests__', 'logline-contract-sweep.test.ts');

const SAMPLE_SHA = 'deadbeef'.repeat(8);
// PRR-067: a neutral username — the literal must not name a real account in a
// public repo (the template matches any path, so the swap is contract-neutral).
const SAMPLE_PATH = 'C:\\Users\\sample-user\\AppData\\Roaming\\trainingapp\\packs\\versioned-a\\2.0.0\\pack.json';
/** Materialization table for the corpus needles' `${...}` interpolations. */
const SAMPLES: Record<string, string> = {
  manifestPath: SAMPLE_PATH,
  sha: SAMPLE_SHA,
  warning: 'supersedes entry ghost-pack@9.9.9 names no installed pack version; recorded on the new row only',
  message: 'injected deterministic failure',
};

// ---------------------------------------------------------------------------
// Independent extraction of the frozen corpus's requireLine templates
// ---------------------------------------------------------------------------
interface ExtractedNeedle {
  label: string;
  needle: string;
}

/**
 * Extract every requireLine needle from the frozen sweep source, resolving
 * the one identifier-passed needle (`exact`, a string concatenation). Any NEW
 * shape (an unresolvable identifier, an unknown interpolation) throws — the
 * comparison fails loudly and forces a template review instead of silently
 * widening or rotting the exception.
 */
function extractCorpusNeedles(source: string): ExtractedNeedle[] {
  const out: ExtractedNeedle[] = [];
  const direct = [
    ...source.matchAll(/requireLine\(\s*logMessages\(\w+\)\s*,\s*(`[^`]*`|'[^']*')/g),
  ];
  for (const match of direct) {
    const literal = match[1] ?? '';
    out.push({ label: literal.slice(0, 60), needle: literal.slice(1, -1) });
  }
  const identifiers = [...source.matchAll(/requireLine\(\s*logMessages\(\w+\)\s*,\s*([A-Za-z_$][\w$]*)\s*,/g)];
  for (const match of identifiers) {
    const name = match[1] ?? '';
    const decl = source.match(new RegExp(`const\\s+${name}\\s*=\\s*((?:'[^']*'\\s*\\+\\s*)*'[^']*')\\s*;`));
    if (decl === null) {
      throw new Error(`corpus requireLine passes identifier ${name} whose declaration is not a literal concatenation — update AC7_PINNED_LINE_TEMPLATES and this comparison together`);
    }
    const needle = (decl[1]?.match(/'([^']*)'/g) ?? []).map((part) => part.slice(1, -1)).join('');
    out.push({ label: name, needle });
  }
  // Calls only — the sweep's own `function requireLine(` declaration is
  // excluded via the lookbehind.
  const total = (source.match(/(?<!function )requireLine\(/g) ?? []).length;
  if (total !== out.length) {
    throw new Error(
      `requireLine extraction covered ${out.length} of ${total} calls — a new call shape must be added to the extractor`,
    );
  }
  return out;
}

function materialize(needle: string): string {
  return needle.replace(/\$\{(\w+)\}/g, (_all, name: string) => {
    if (!(name in SAMPLES)) {
      throw new Error(`unknown corpus interpolation ${name} — materialize it and review AC7_PINNED_LINE_TEMPLATES`);
    }
    return SAMPLES[name] as string;
  });
}

const SWEEP_SOURCE = fs.readFileSync(SWEEP_PATH, 'utf8');
const CORPUS_NEEDLES = extractCorpusNeedles(SWEEP_SOURCE).map((entry) => ({
  ...entry,
  line: materialize(entry.needle),
}));
const SENSITIVE_NEEDLES = CORPUS_NEEDLES.filter((entry) => isSensitiveLine(entry.line));

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
let holder: { removeLoggingConsoleWrapper(): void } | null = null;

function silenceConsole() {
  const spies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  return spies;
}

beforeEach(() => {
  __resetElectronStub();
});

afterEach(() => {
  // Ordering contract: the wrapper is removed BEFORE vi.restoreAllMocks so
  // the mocks restore to the true console methods, not to the wrapper.
  __resetLoggingForTests();
  holder?.removeLoggingConsoleWrapper();
  holder = null;
  vi.doUnmock('../../main/logging-redact.js');
  vi.resetModules();
  vi.restoreAllMocks();
  __resetElectronStub();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('console composition: the finite AC7 exception (spy-first)', () => {
  it('every pinned corpus row passes through the console RAW on desktop', () => {
    expect(SENSITIVE_NEEDLES.length).toBeGreaterThanOrEqual(3);
    const spies = silenceConsole();
    installLoggingConsoleWrapper();
    for (const entry of [...SENSITIVE_NEEDLES, ...CORPUS_NEEDLES.filter((n) => !SENSITIVE_NEEDLES.includes(n))]) {
      console.warn(entry.line);
    }
    // Every corpus line — sensitive (the pinned exception) AND clean — is
    // received byte-identically by the console that was current at install.
    for (const entry of CORPUS_NEEDLES) {
      expect(spies.warn, entry.label).toHaveBeenCalledWith(entry.line);
    }
    // And nothing else was emitted (no [sanitized] for any corpus row).
    for (const call of spies.warn.mock.calls) {
      expect(String(call[0])).not.toMatch(/^\[sanitized\]/);
    }
  });

  it('per-template near-miss negatives fail the template and fall through to [sanitized] (widening fails closed)', () => {
    const nearMisses: Array<[string, string]> = [
      ['unreadable suffix', `[pack-manager] nearmiss@1.0.0: managed manifest unreadable at ${SAMPLE_PATH}; treating as docs`],
      ['unparseable suffix', `[pack-manager] nearmiss@1.0.0: managed manifest unparseable at ${SAMPLE_PATH}; treating as docs`],
      ['no-live-chunks suffix', `[pack-manager] nearmiss@1.0.0: no live chunks for doc ${SAMPLE_SHA}; row REACTIVATED`],
      ['no-live-chunks hex length', `[pack-manager] nearmiss@1.0.0: no live chunks for doc ${'f'.repeat(63)}; row deactivated`],
      ['no-live-chunks hex case', `[pack-manager] nearmiss@1.0.0: no live chunks for doc ${'F'.repeat(64)}; row deactivated`],
    ];
    for (const [label, line] of nearMisses) {
      expect(matchesPinnedTemplate(line), `${label}: still sensitive (${isSensitiveLine(line)}) and must not match`).toBe(false);
      expect(isSensitiveLine(line), `${label}: the near-miss must remain sensitive`).toBe(true);
    }
    const spies = silenceConsole();
    installLoggingConsoleWrapper();
    for (const [, line] of nearMisses) console.warn(line);
    expect(spies.warn).toHaveBeenCalledTimes(nearMisses.length);
    for (const call of spies.warn.mock.calls) {
      expect(String(call[0])).toMatch(/^\[sanitized\] /);
    }
  });

  it('the template inventory matches the frozen corpus in BOTH directions (drift pin)', () => {
    // Direction 1 (corpus -> templates): every sensitive materialized corpus
    // needle is protected — otherwise the sweep's console contract would
    // break under the wrapper.
    expect(SENSITIVE_NEEDLES.length).toBeGreaterThan(0);
    for (const entry of SENSITIVE_NEEDLES) {
      expect(matchesPinnedTemplate(entry.line), `unprotected sensitive corpus line: ${entry.label}`).toBe(true);
    }
    // Direction 2 (templates -> corpus): every template protects at least one
    // sensitive corpus line — no dead or widened template can survive.
    for (const template of AC7_PINNED_LINE_TEMPLATES) {
      const protectedRows = SENSITIVE_NEEDLES.filter((entry) => template.test(entry.line));
      expect(protectedRows.length, `template protects nothing (dead or drifted): ${template.source}`).toBeGreaterThan(0);
    }
  });

  it('a non-pinned sensitive line gets the once-called [sanitized] single-string form; its persisted form is redacted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-compose-'));
    tempDirs.push(root);
    const spies = silenceConsole();
    installLoggingConsoleWrapper();
    activateDiagnosticsLogging({
      userDataPath: path.join(root, 'userData'),
      storePath: path.join(root, 'profile', 'store.sqlite'),
    });
    const pinnedLine = `[pack-manager] versioned-a@2.0.0: no live chunks for doc ${SAMPLE_SHA}; row deactivated`;
    const secretLine = '[probe] download failed password=hunter2';
    console.warn(pinnedLine);
    console.error(secretLine);
    // Console: pinned raw (original args), non-pinned sanitized ONCE.
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledWith(pinnedLine);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(String(spies.error.mock.calls[0]?.[0])).toMatch(/^\[sanitized\] \[probe\] download failed password=\[redacted\]$/);
    // Persisted: BOTH forms redacted in the file sink (the exception is
    // console-only).
    const fileLog = fs.readFileSync(path.join(root, 'userData', 'logs', 'main.log'), 'utf8');
    expect(fileLog).toContain('[redacted-hex]; row deactivated');
    expect(fileLog).not.toContain(SAMPLE_SHA);
    expect(fileLog).toContain('password=[redacted]');
    expect(fileLog).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------
// The classification-failure matrix (plan: failure-outcome matrix a/b)
// ---------------------------------------------------------------------------
describe('classification-failure matrix', () => {
  async function importWithRedactOverride(overrides: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock('../../main/logging-redact.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../main/logging-redact.js')>();
      return { ...actual, ...overrides };
    });
    const logging = await import('../../main/logging.js');
    holder = logging as { removeLoggingConsoleWrapper(): void };
    return logging;
  }

  it('console-suppression: a classification failure suppresses the console line, drops the entry, and warns exactly once', async () => {
    const logging = await importWithRedactOverride({
      isSensitiveLine: () => {
        throw new Error('injected classifier failure');
      },
    });
    const spies = silenceConsole();
    logging.installLoggingConsoleWrapper();
    console.log('[probe] safety cannot be established token=abc');
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(String(spies.error.mock.calls[0]?.[0])).toContain('could not be classified safely');
    console.log('[probe] second failure token=abc');
    expect(spies.error, 'the failure warning fires once per session').toHaveBeenCalledTimes(1);
  });

  it('pinned-template-match is independent of the redactor: a pinned line still passes raw while classification fails', async () => {
    const logging = await importWithRedactOverride({
      isSensitiveLine: () => {
        throw new Error('injected classifier failure');
      },
    });
    const spies = silenceConsole();
    logging.installLoggingConsoleWrapper();
    const pinnedLine = `[pack-manager] versioned-a@2.0.0: managed manifest unreadable at ${SAMPLE_PATH}; treating as no docs`;
    console.warn(pinnedLine);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledWith(pinnedLine);
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('persisted-drop: a later persisted-redaction failure keeps the console policy but drops the persisted entry', async () => {
    const logging = await importWithRedactOverride({
      persistedForm: () => {
        throw new Error('injected persistence failure');
      },
    });
    const spies = silenceConsole();
    logging.installLoggingConsoleWrapper();
    console.error('[probe] nonpinned password=hunter2');
    const first = String(spies.error.mock.calls[0]?.[0]);
    const second = String(spies.error.mock.calls[1]?.[0]);
    expect(first).toMatch(/^\[sanitized\] /);
    expect(second).toContain('could not be redacted for persistence');
    expect(spies.error).toHaveBeenCalledTimes(2);
    console.error('[probe] again password=hunter2');
    expect(spies.error, 'no second warn for the same failure class').toHaveBeenCalledTimes(3);
  });

  it('warn-recursion safety: a throwing warn sink is swallowed silently and never recurses', async () => {
    const logging = await importWithRedactOverride({
      isSensitiveLine: () => {
        throw new Error('injected classifier failure');
      },
    });
    const spies = silenceConsole();
    spies.error.mockImplementation(() => {
      throw new Error('the warn path itself failed');
    });
    logging.installLoggingConsoleWrapper();
    expect(() => console.log('[probe] classify fails AND the warn sink throws')).not.toThrow();
    expect(spies.log).not.toHaveBeenCalled();
    // A subsequent line still follows the same fail-closed path without
    // crashing the process (the recursion guard held).
    expect(() => console.log('[probe] next line token=abc')).not.toThrow();
  });

  it('the real (unmocked) module still passes the composition basics after remocking', async () => {
    // Guard against a doMock leak across this describe: a fresh import with
    // NO override must classify normally again.
    const logging = await importWithRedactOverride({});
    const spies = silenceConsole();
    logging.installLoggingConsoleWrapper();
    console.error('[probe] real classifier password=hunter2');
    expect(String(spies.error.mock.calls[0]?.[0])).toMatch(/^\[sanitized\] /);
  });
});

// Compile-time shape helper: the exported entry type stays the shared one.
const entryShape: LogEntry = { ts: 'now', level: 'info', scope: 'x', message: 'y' };
void entryShape;
