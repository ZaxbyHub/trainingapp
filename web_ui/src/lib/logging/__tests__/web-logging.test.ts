/**
 * web-logging.test.ts — issue #248 (AC4/AC5): the renderer/browser logging
 * core's ADMITTED-entry ring (bounded, oldest-drop, level-gated), the export
 * paths (picker / download fallback / cancel / write failure), and the
 * redaction gate over the shared corpus
 * (contracts/diagnostics-redaction-vectors.json) with the RENDERER console
 * outcomes and the platform-independent persisted bytes.
 *
 * Frozen check landing target: C4 (this whole file) and C5 (`-t redaction`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __deliveryStateForTests,
  __resetLoggingCoreForTests,
  admittedEntries,
  createLogger,
  RING_LIMIT,
  setConsoleSinks,
  setEnhancedLogging,
  type LogEntry,
} from '../index';
import { isSensitiveArgs, renderLine } from '../redact';
import { buildDiagnosticsBundle, exportDiagnostics } from '../export';

vi.mock('../../export/conversation-export', () => ({
  downloadTextFile: vi.fn(),
}));

import { downloadTextFile } from '../../export/conversation-export';

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
// The corpus carries a {_comment, version, vectors} provenance wrapper
// (PRR-030/075); the vectors are the pins this spec drives.
const CORPUS = (
  JSON.parse(
    fs.readFileSync(path.join(findRepoRoot(THIS_DIR), 'contracts', 'diagnostics-redaction-vectors.json'), 'utf8'),
  ) as {
    _comment: string;
    version: number;
    vectors: Array<{
      name: string;
      input: string | { args: unknown[] };
      persisted: string;
      console: { desktop: 'raw' | 'sanitized'; renderer: 'raw' | 'sanitized' };
    }>;
  }
).vectors;

/** Recording console sinks (silenced) injected into the core. */
function recordingSinks() {
  const calls: Record<string, unknown[][]> = { debug: [], info: [], warn: [], error: [] };
  setConsoleSinks({
    debug: (...a: unknown[]) => void calls.debug.push(a),
    info: (...a: unknown[]) => void calls.info.push(a),
    warn: (...a: unknown[]) => void calls.warn.push(a),
    error: (...a: unknown[]) => void calls.error.push(a),
  });
  return calls;
}

beforeEach(() => {
  __resetLoggingCoreForTests();
  localStorage.clear();
});

afterEach(() => {
  __resetLoggingCoreForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('ring buffer (AC4: bounded, admitted-only)', () => {
  it('the ring holds exactly 5,000 admitted entries and drops the oldest beyond it', () => {
    recordingSinks();
    const log = createLogger('ring');
    for (let i = 0; i < RING_LIMIT + 2; i += 1) log.info(`entry-${i}`);
    const entries = admittedEntries();
    // Literal 5000, not the constant: the bound is a plan-pinned contract, so a
    // mutated RING_LIMIT must fail here rather than stay self-consistent.
    expect(entries).toHaveLength(5000);
    expect(entries[0]?.message).toBe('entry-2');
    expect(entries[entries.length - 1]?.message).toBe(`entry-${RING_LIMIT + 1}`);
  });

  it('entries carry the {ts, level, scope, message, sessionId, seq} shape with monotonic seq', () => {
    recordingSinks();
    const log = createLogger('shape');
    log.info('one');
    log.warn('two');
    const [first, second] = admittedEntries() as LogEntry[];
    expect(first.level).toBe('info');
    expect(first.scope).toBe('shape');
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof first.sessionId).toBe('string');
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('debug entries are excluded at the default info level (admitted-only ring)', () => {
    recordingSinks();
    const log = createLogger('gate');
    log.debug('debug-dropped');
    log.info('info-admitted');
    expect(admittedEntries().map((e) => e.message)).toEqual(['info-admitted']);
  });

  it('debug entries are admitted while enhanced is on and excluded again after a toggle off', () => {
    recordingSinks();
    setEnhancedLogging(true);
    const log = createLogger('gate');
    log.debug('debug-while-enhanced');
    expect(admittedEntries().map((e) => e.message)).toEqual(['debug-while-enhanced']);
    setEnhancedLogging(false);
    log.debug('debug-after-toggle-off');
    expect(admittedEntries().map((e) => e.message)).toEqual(['debug-while-enhanced']);
  });
});

describe('export (AC4: picker, fallback, cancel, write failure)', () => {
  function stubPicker(impl: () => Promise<unknown>): void {
    vi.stubGlobal('showSaveFilePicker', vi.fn(impl));
  }

  it('writes the bundle through showSaveFilePicker when available', async () => {
    recordingSinks();
    createLogger('export').info('pickered entry');
    const writable = { write: vi.fn(async (_data: unknown) => undefined), close: vi.fn(async () => undefined) };
    stubPicker(async () => ({ createWritable: async () => writable }));
    const outcome = await exportDiagnostics();
    expect(outcome).toEqual({ outcome: 'saved' });
    expect(writable.write).toHaveBeenCalledTimes(1);
    const blob = writable.write.mock.calls[0]?.[0] as unknown as Blob;
    // jsdom's Blob has no .text(); read it through a FileReader.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsText(blob);
    });
    const bundle = JSON.parse(text) as { version: number; entries: LogEntry[] };
    expect(bundle.version).toBe(1);
    expect(bundle.entries[bundle.entries.length - 1]?.message).toBe('pickered entry');
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it('falls back to a download when the picker is unavailable', async () => {
    recordingSinks();
    const outcome = await exportDiagnostics();
    expect(outcome.outcome).toBe('fallback');
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [content, filename, mime] = vi.mocked(downloadTextFile).mock.calls[0] as unknown as [string, string, string];
    expect(filename).toMatch(/^trainingapp-diagnostics-\d{4}-\d{2}-\d{2}T.*\.json$/);
    expect(mime).toBe('application/json');
    expect(JSON.parse(content).version).toBe(1);
  });

  it('a picker-open failure (non-abort) also falls back to the download', async () => {
    recordingSinks();
    stubPicker(async () => {
      throw new TypeError('picker crashed');
    });
    const outcome = await exportDiagnostics();
    expect(outcome.outcome).toBe('fallback');
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
  });

  it('a user AbortError is reported as cancelled, with no download', async () => {
    recordingSinks();
    stubPicker(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const outcome = await exportDiagnostics();
    expect(outcome).toEqual({ outcome: 'cancelled' });
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it('a picker WRITE/close failure is surfaced as an error, never a silent download fallback', async () => {
    recordingSinks();
    stubPicker(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw new Error('disk full');
        },
        close: async () => undefined,
      }),
    }));
    const outcome = await exportDiagnostics();
    expect(outcome.outcome).toBe('error');
    expect(outcome.detail).toContain('disk full');
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it('the bundle re-gates every persisted field', async () => {
    recordingSinks();
    createLogger('gate').error('export probe password=hunter2');
    // The ring already stores the redacted form; the builder re-applies the
    // gate so the exported bytes can never regress to raw content.
    const bundle = JSON.parse(buildDiagnosticsBundle()) as { entries: LogEntry[] };
    expect(bundle.entries[bundle.entries.length - 1]?.message).toBe('export probe password=[redacted]');
  });
});

describe('redaction (AC5: shared corpus, renderer outcomes + persisted parity)', () => {
  it('every corpus vector takes its pinned renderer console outcome and persisted form', () => {
    for (const vector of CORPUS) {
      __resetLoggingCoreForTests();
      const calls = recordingSinks();
      const log = createLogger('corpus');
      if (typeof vector.input === 'string') log.info(vector.input);
      else log.info(vector.input.args[0], ...vector.input.args.slice(1));
      const consoleArg = calls.info[calls.info.length - 1] as unknown[];
      if (vector.console.renderer === 'raw') {
        // Raw passthrough keeps the ORIGINAL arguments, however many there were.
        expect(consoleArg.length, `${vector.name}: original argument count`).toBe(
          typeof vector.input === 'string' ? 1 : vector.input.args.length,
        );
        expect(String(consoleArg[0])).toBe(
          typeof vector.input === 'string' ? vector.input : String(vector.input.args[0]),
        );
      } else {
        expect(String(consoleArg[0]), `${vector.name}: sanitized single-string form`).toMatch(/^\[sanitized\] /);
      }
      const entries = admittedEntries();
      expect(entries[entries.length - 1]?.message, `${vector.name}: persisted form`).toBe(vector.persisted);
    }
  });

  it('persisted bytes are identical on both platforms (desktop twin parity)', async () => {
    const desktopRedact = await import('../../../../../desktop/main/logging-redact.ts');
    for (const vector of CORPUS) {
      const line = typeof vector.input === 'string' ? vector.input : renderLine(vector.input.args);
      expect(desktopRedact.persistedForm(line), `${vector.name}: desktop twin persisted parity`).toBe(vector.persisted);
    }
    // PRR-031: arg-aware classification is part of the twin contract — a
    // secret split across console args is sensitive, prose is not.
    for (const args of [
      ['token', 'gho_synthvalue991'],
      ['password', 'correct horse battery staple'],
      ['the secret of', 'the universe'],
      ['sidecar exited after', 4321, 'ms'],
    ] as unknown[][]) {
      expect(desktopRedact.isSensitiveArgs(args), `${args.join(' ')}: desktop twin arg parity`).toBe(isSensitiveArgs(args));
    }
  });

  it('a desktop-pinned-shaped line is [sanitized] on the renderer console (empty exception set)', () => {
    const calls = recordingSinks();
    const sha = 'deadbeef'.repeat(8);
    createLogger('leak').warn(
      `[pack-manager] versioned-a@2.0.0: no live chunks for doc ${sha}; row deactivated`,
    );
    expect(String(calls.warn[0]?.[0])).toMatch(/^\[sanitized\] \[pack-manager\] versioned-a@2\.0\.0: no live chunks for doc \[redacted-hex\]; row deactivated$/);
    expect(admittedEntries()[0]?.message).not.toContain(sha);
  });
});
