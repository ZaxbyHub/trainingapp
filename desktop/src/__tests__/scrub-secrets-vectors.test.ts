/**
 * PR #142 review F-018 follow-up: the desktop scrubSecrets agrees row-for-row
 * with contracts/scrub-secrets-vectors.json. The browser twin
 * (web_ui/src/lib/llm/scrub-secrets-vectors.test.ts) asserts the same file, so
 * the two implementations cannot drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../../main/backend/net/provider-error';

interface Vec {
  name: string;
  key: string;
  input: string;
  expected: string;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cases = (JSON.parse(fs.readFileSync(path.join(REPO, 'contracts', 'scrub-secrets-vectors.json'), 'utf8')) as { cases: Vec[] }).cases;

describe('desktop scrubSecrets vs contracts/scrub-secrets-vectors.json', () => {
  it('vector file is non-trivial', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });
  for (const c of cases) {
    it(c.name, () => {
      expect(scrubSecrets(c.input, c.key)).toBe(c.expected);
    });
  }
});
