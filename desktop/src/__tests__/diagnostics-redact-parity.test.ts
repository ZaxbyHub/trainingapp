// diagnostics-redact-parity.test.ts — issue #248: both redaction-gate twins
// (web_ui/src/lib/logging/redact.ts and desktop/main/logging-redact.ts)
// produce IDENTICAL persisted bytes over the shared corpus
// contracts/diagnostics-redaction-vectors.json, and the desktop console
// outcomes (clean raw / AC7-pinned raw / other sensitive `[sanitized]`) match
// the corpus's platform-split expectations. A change to either twin or the
// corpus without the others fails here — including the regenerate-and-compare
// proof that ties the committed corpus to
// contracts/tests/gen-diagnostics-redaction-vectors.mjs (PRR-030/068/075).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The web twin lives outside the desktop vitest root, so the repo's usual
// .js-suffix import substitution does not apply; the explicit .ts extension
// is allowed by tsconfig.test.json (allowImportingTsExtensions, noEmit).
import * as webRedact from '../../../web_ui/src/lib/logging/redact.ts';
import * as desktopRedact from '../../main/logging-redact.js';
import { consoleOutcomeFor } from '../../main/logging.js';

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
const CORPUS_PATH = path.join(REPO_ROOT, 'contracts', 'diagnostics-redaction-vectors.json');
const CORPUS_GENERATOR = path.join(REPO_ROOT, 'contracts', 'tests', 'gen-diagnostics-redaction-vectors.mjs');
// PRR-068: the corpus inventory is an exact count, not a floor — a dropped
// vector must fail here, not silently shrink the gate's coverage.
const CORPUS_VECTOR_COUNT = 30;

interface Vector {
  name: string;
  input: string | { args: unknown[] };
  persisted: string;
  console: { desktop: 'raw' | 'sanitized'; renderer: 'raw' | 'sanitized' };
}
interface CorpusDoc {
  _comment: string;
  version: number;
  vectors: Vector[];
}

const corpusDoc = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as CorpusDoc;
const corpus = corpusDoc.vectors;

function lineFor(vector: Vector): string {
  return typeof vector.input === 'string' ? vector.input : webRedact.renderLine(vector.input.args);
}

describe('redaction parity over the shared corpus (AC5 + reconciled console policy)', () => {
  it('the corpus is present, exactly inventoried, and covers every required vector class', () => {
    expect(corpusDoc._comment, 'the corpus carries its provenance wrapper').toContain('gen-diagnostics-redaction-vectors.mjs');
    expect(corpusDoc.version).toBe(1);
    expect(corpus).toHaveLength(CORPUS_VECTOR_COUNT);
    // PRR-030: unique names — a duplicated name would double-cover one class
    // while silently dropping another at the same count.
    expect(new Set(corpus.map((v) => v.name)).size).toBe(CORPUS_VECTOR_COUNT);
    for (const marker of [
      'clean-backend-status-line',
      'long-hex-run',
      'bearer-scheme-token',
      'jwt-token',
      'kv-secret-shapes',
      'kv-bare-value-is-rest-of-line',
      'kv-compound-keys',
      'kv-prose-not-mangled',
      'sk-provider-key',
      'user-home-path',
      'posix-home-path',
      'macos-home-path',
      'email-address',
      'zero-width-split-key',
      'multiline-with-secret',
      'homoglyph-cyrillic-key',
      'homoglyph-cyrillic-o-key',
      'homoglyph-greek-key',
      'non-english-prose-unchanged',
      'secret-straddling-truncation-boundary',
      'pinned-corpus-shape-no-live-chunks',
      'pinned-corpus-shape-manifest-unreadable',
      'classification-failure-guard',
      'split-across-console-args',
      'content-bearing-object-denylist',
      'denylist-prefixed-keys',
    ]) {
      expect(corpus.some((v) => v.name.includes(marker)), `corpus vector ${marker} is missing`).toBe(true);
    }
    // PRR-075: the schema shape — every vector is a well-formed pin.
    for (const vector of corpus) {
      expect(typeof vector.name, `${vector.name}: name is a string`).toBe('string');
      expect(typeof vector.persisted, `${vector.name}: persisted is a string`).toBe('string');
      expect(
        typeof vector.input === 'string' || (typeof vector.input === 'object' && Array.isArray((vector.input as { args: unknown[] }).args)),
        `${vector.name}: input is a line or {args}`,
      ).toBe(true);
      expect(['raw', 'sanitized'], `${vector.name}: console.desktop`).toContain(vector.console.desktop);
      expect(['raw', 'sanitized'], `${vector.name}: console.renderer`).toContain(vector.console.renderer);
    }
  });

  // PRR-030: nothing else ties the committed corpus to its generator. The
  // corpus is fully deterministic, so a regeneration must be byte-identical —
  // the committed file is exactly what the real twins produce today.
  it('matches what contracts/tests/gen-diagnostics-redaction-vectors.mjs regenerates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-vectors-'));
    try {
      const out = path.join(dir, 'regenerated.json');
      const run = spawnSync(process.execPath, [CORPUS_GENERATOR, out], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const regenerated = JSON.parse(fs.readFileSync(out, 'utf8')) as CorpusDoc;
      expect(regenerated.vectors).toHaveLength(CORPUS_VECTOR_COUNT);
      expect(regenerated).toEqual(corpusDoc);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both twins produce the IDENTICAL persisted bytes the corpus pins', () => {
    for (const vector of corpus) {
      const line = lineFor(vector);
      const fromWeb = webRedact.persistedForm(line);
      const fromDesktop = desktopRedact.persistedForm(line);
      expect(fromDesktop, `vector ${vector.name}: desktop twin`).toEqual(vector.persisted);
      expect(fromWeb, `vector ${vector.name}: web twin`).toEqual(vector.persisted);
    }
  });

  it('the desktop console outcome matches the corpus (clean/pinned raw, other sensitive sanitized)', () => {
    for (const vector of corpus) {
      const line = lineFor(vector);
      expect(consoleOutcomeFor(line), `vector ${vector.name}`).toBe(vector.console.desktop);
    }
  });

  it('a secret straddling the truncation boundary never survives as a fragment (redact BEFORE truncate)', () => {
    const vector = corpus.find((v) => v.name === 'secret-straddling-truncation-boundary');
    expect(vector).toBeDefined();
    const line = lineFor(vector as Vector);
    expect(webRedact.persistedForm(line)).not.toMatch(/[0-9a-f]{16,}/);
    expect(desktopRedact.persistedForm(line)).not.toMatch(/[0-9a-f]{16,}/);
    expect(webRedact.persistedForm(line)).toContain('…[truncated]');
  });

  it('the twins agree on serialization too (denylist, caps, errors, own toJSON)', () => {
    const samples: unknown[][] = [
      ['[RAG] gap', { query: 'question text', chunks: ['a', 'b'], n: 3 }],
      ['[err] failed:', new Error('boom')],
      ['arr', { items: new Array(25).fill('x') }, { payload: 'content' }],
    ];
    for (const args of samples) {
      expect(desktopRedact.renderLine(args)).toEqual(webRedact.renderLine(args));
    }
    expect(webRedact.renderLine(samples[1] as unknown[])).toContain('Error: boom');
    const serialized = webRedact.renderLine(samples[0] as unknown[]);
    expect(serialized).toContain('"query":"[redacted-field]"');
    expect(serialized).toContain('"chunks":"[redacted-field]"');
    const capped = webRedact.renderLine(samples[2] as unknown[]);
    expect(capped).toContain('+5 more');
    expect(capped).toContain('"payload":"[redacted-field]"');
    // PRR-007: an own-enumerable toJSON is a function-valued key, dropped in
    // serialization — JSON.stringify must never get to invoke it.
    const sneaky = {
      query: 'the raw question',
      toJSON: () => ({ query: 'the raw question' }),
    };
    expect(webRedact.serializeArg(sneaky)).toBe('{"query":"[redacted-field]"}');
    expect(desktopRedact.serializeArg(sneaky)).toBe(webRedact.serializeArg(sneaky));
    // PRR-086: prefix-tolerant denylist names serialize gated too.
    const prefixed = { userText: 'question', answer: '42', response: 'ok', context: 'web', message: 'note', responseType: 'blob' };
    const prefixedLine = webRedact.serializeArg(prefixed);
    expect(prefixedLine).toContain('"userText":"[redacted-field]"');
    expect(prefixedLine).toContain('"answer":"[redacted-field]"');
    expect(prefixedLine).toContain('"response":"[redacted-field]"');
    expect(prefixedLine).toContain('"context":"[redacted-field]"');
    expect(prefixedLine).toContain('"message":"[redacted-field]"');
    // responseType does NOT end in a denylisted name — it stays data.
    expect(prefixedLine).toContain('"responseType":"blob"');
    expect(desktopRedact.serializeArg(prefixed)).toBe(prefixedLine);
  });

  it('the twins agree on arg-aware classification: split-arg secrets are sensitive, prose is not (PRR-031)', () => {
    const batteries: Array<{ args: unknown[]; sensitive: boolean; why: string }> = [
      { args: ['token', 'gho_synthvalue991'], sensitive: true, why: 'kv key and value in separate args' },
      { args: ['password', 'correct horse battery staple'], sensitive: true, why: 'password phrase as the next arg' },
      { args: ['upload', 'sk-test-AbCdAbCdAbCdAbCdAbCd'], sensitive: true, why: 'provider key alone in an arg' },
      { args: ['the secret of', 'the universe'], sensitive: false, why: 'prose keeps its following word' },
      { args: ['sidecar exited after', 4321, 'ms'], sensitive: false, why: 'ordinary status args' },
    ];
    for (const battery of batteries) {
      expect(webRedact.isSensitiveArgs(battery.args), `web: ${battery.why}`).toBe(battery.sensitive);
      expect(desktopRedact.isSensitiveArgs(battery.args), `desktop: ${battery.why}`).toBe(battery.sensitive);
      // The array form of isSensitiveLine is the same verdict.
      expect(webRedact.isSensitiveLine(battery.args), `web overload: ${battery.why}`).toBe(battery.sensitive);
      expect(desktopRedact.isSensitiveLine(battery.args), `desktop overload: ${battery.why}`).toBe(battery.sensitive);
    }
  });

  it('classification stays linear on pathological input, and nothing past the cap ever persists (PRR-005)', () => {
    const run = 'x'.repeat(50_000);
    const started = Date.now();
    expect(webRedact.isSensitiveLine(run)).toBe(false);
    expect(desktopRedact.isSensitiveLine(run)).toBe(false);
    // Measured before the fix: ~1.9s per 50k call on the console path (paid
    // twice). The bounded email quantifiers + 4,096-char cap keep it small.
    expect(Date.now() - started).toBeLessThan(1_000);
    const marker = '…[truncated]';
    expect(webRedact.persistedForm(run)).toHaveLength(webRedact.LINE_BUDGET + marker.length);
    expect(desktopRedact.persistedForm(run)).toHaveLength(desktopRedact.LINE_BUDGET + marker.length);
    // A hex secret beyond the 4,096-char classification cap is never persisted
    // as a fragment: the 2,000-char budget truncates before it.
    const beyond = `${'x'.repeat(4_100)} ${'deadbeef'.repeat(8)}`;
    for (const twin of [webRedact, desktopRedact]) {
      const persisted = twin.persistedForm(beyond);
      expect(persisted).not.toMatch(/[0-9a-f]{16,}/);
      expect(persisted.endsWith(marker)).toBe(true);
    }
  });
});
