// diagnostics-redact-namespaced-key.test.ts — issue #256 AC5: a log line
// carrying a namespaced secret key in the JSON/quoted-key shape
// (`"external.apiKey": "<value>"`) must redact through the shared gate on
// BOTH twins, and a namespaced non-secret must stay clean. The corpus
// (contracts/diagnostics-redaction-vectors.json) carries the same vectors —
// the corpus is the single source, this spec pins the literals directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as desktopRedact from '../../main/logging-redact.js';
// The web twin lives outside the desktop vitest root; the explicit .ts
// extension is allowed by tsconfig.test.json (allowImportingTsExtensions).
import * as webRedact from '../../../web_ui/src/lib/logging/redact.ts';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(THIS_DIR, '..', '..', '..', 'contracts', 'diagnostics-redaction-vectors.json');

const EXTERNAL_JSON_LINE = '"external.apiKey": "synth-external-value-seven"';
const OTHER_NAMESPACE_LINE = '"db.password": "synth-db-value-eight"';
const DOTTED_CLEAN_LINE = 'loaded {"release.version": "1.2.3"} from config';
const BARE_CONTROL_LINE = 'external.apiKey=synth-external-value-seven';
// Issue #256 round 2: the hyphenated morphemes CONFIGURATION.md documents and
// the SecretStore's own entry names use. MUST match the generator's input line
// byte-for-byte (the corpus persisted form is computed from the same line).
const HYPHENATED_LINE =
  'store {"external-api-key": "synth-store-value-eleven"} external-api-key-origin=binding; api-key=synth-api-value-twelve; session-id=synth-session-value-thirteen';

interface Twins {
  persistedForm(line: string): string;
  isSensitiveLine(line: string): boolean;
}

const twins: Array<[string, Twins]> = [
  ['desktop/main/logging-redact.ts', desktopRedact as unknown as Twins],
  ['web_ui/src/lib/logging/redact.ts', webRedact as unknown as Twins],
];

describe('namespaced secret keys redact through the shared gate on both twins (AC5)', () => {
  it.each(twins)('external.apiKey JSON shape redacts via %s', (_name, twin) => {
    expect(twin.isSensitiveLine(EXTERNAL_JSON_LINE)).toBe(true);
    expect(twin.persistedForm(EXTERNAL_JSON_LINE)).toBe('"external.apiKey": "[redacted]"');
  });

  it.each(twins)('a non-external namespaced secret redacts via %s (Candidate-F guard)', (_name, twin) => {
    expect(twin.isSensitiveLine(OTHER_NAMESPACE_LINE)).toBe(true);
    expect(twin.persistedForm(OTHER_NAMESPACE_LINE)).toBe('"db.password": "[redacted]"');
  });

  it.each(twins)('a dotted non-secret stays clean via %s', (_name, twin) => {
    expect(twin.isSensitiveLine(DOTTED_CLEAN_LINE)).toBe(false);
    expect(twin.persistedForm(DOTTED_CLEAN_LINE)).toBe(DOTTED_CLEAN_LINE);
  });

  it.each(twins)('the bare namespaced shape was already gated (control) via %s', (_name, twin) => {
    expect(twin.isSensitiveLine(BARE_CONTROL_LINE)).toBe(true);
    expect(twin.persistedForm(BARE_CONTROL_LINE)).toBe('external.apiKey=[redacted]');
  });

  it.each(twins)('hyphenated secret keys redact via %s (round-2 PRR-003)', (_name, twin) => {
    expect(twin.isSensitiveLine(HYPHENATED_LINE)).toBe(true);
    const persisted = twin.persistedForm(HYPHENATED_LINE);
    expect(persisted).toContain('"external-api-key": "[redacted]"');
    expect(persisted).not.toContain('synth-store-value-eleven');
    expect(persisted).not.toContain('synth-api-value-twelve');
    expect(persisted).not.toContain('synth-session-value-thirteen');
  });

  it('the corpus carries the namespaced vectors with the twins\' current bytes', () => {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as {
      vectors: Array<{ name: string; input: string; persisted: string; console: { desktop: string; renderer: string } }>;
    };
    const expected = [
      ['namespaced-json-external-key', EXTERNAL_JSON_LINE, '"external.apiKey": "[redacted]"', 'sanitized'],
      ['namespaced-json-other-namespace-key', OTHER_NAMESPACE_LINE, '"db.password": "[redacted]"', 'sanitized'],
      ['dotted-non-secret-clean', DOTTED_CLEAN_LINE, DOTTED_CLEAN_LINE, 'raw'],
    ] as const;
    const hyphenVector = corpus.vectors.find((v) => v.name === 'hyphenated-secret-keys');
    expect(hyphenVector, 'corpus vector hyphenated-secret-keys missing').toBeDefined();
    expect(desktopRedact.persistedForm(HYPHENATED_LINE)).toBe(hyphenVector?.persisted);
    expect(webRedact.persistedForm(HYPHENATED_LINE)).toBe(hyphenVector?.persisted);
    for (const [name, input, persisted, outcome] of expected) {
      const vector = corpus.vectors.find((v) => v.name === name);
      expect(vector, `corpus vector ${name} missing`).toBeDefined();
      expect(vector?.input).toBe(input);
      expect(vector?.persisted).toBe(persisted);
      expect(vector?.console.desktop).toBe(outcome);
      expect(vector?.console.renderer).toBe(outcome);
      // The corpus bytes equal what the CURRENT twins produce (the corpus is
      // the single source, not a hand-written oracle).
      expect(desktopRedact.persistedForm(input)).toBe(vector?.persisted);
      expect(webRedact.persistedForm(input)).toBe(vector?.persisted);
    }
  });
});
