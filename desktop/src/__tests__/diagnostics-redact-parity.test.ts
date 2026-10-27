// diagnostics-redact-parity.test.ts — issue #248: both redaction-gate twins
// (web_ui/src/lib/logging/redact.ts and desktop/main/logging-redact.ts)
// produce IDENTICAL persisted bytes over the shared corpus
// contracts/diagnostics-redaction-vectors.json, and the desktop console
// outcomes (clean raw / AC7-pinned raw / other sensitive `[sanitized]`) match
// the corpus's platform-split expectations. A change to either twin or the
// corpus without the others fails here.
import fs from 'node:fs';
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
const CORPUS_PATH = path.join(findRepoRoot(THIS_DIR), 'contracts', 'diagnostics-redaction-vectors.json');

interface Vector {
  name: string;
  input: string | { args: unknown[] };
  persisted: string;
  console: { desktop: 'raw' | 'sanitized'; renderer: 'raw' | 'sanitized' };
}

const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as Vector[];

function lineFor(vector: Vector): string {
  return typeof vector.input === 'string' ? vector.input : webRedact.renderLine(vector.input.args);
}

describe('redaction parity over the shared corpus (AC5 + reconciled console policy)', () => {
  it('the corpus is present and covers every required vector class', () => {
    const names = corpus.map((v) => v.name).join('\n');
    expect(corpus.length).toBeGreaterThanOrEqual(15);
    for (const marker of [
      'clean-backend-status-line',
      'long-hex-run',
      'bearer-scheme-token',
      'jwt-token',
      'kv-secret-shapes',
      'sk-provider-key',
      'user-home-path',
      'email-address',
      'multiline-with-secret',
      'secret-straddling-truncation-boundary',
      'pinned-corpus-shape-no-live-chunks',
      'pinned-corpus-shape-manifest-unreadable',
      'classification-failure-guard',
      'content-bearing-object-denylist',
    ]) {
      expect(names, `corpus vector ${marker} is missing`).toContain(marker);
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

  it('the twins agree on serialization too (denylist, caps, errors)', () => {
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
  });
});
