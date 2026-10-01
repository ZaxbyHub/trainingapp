/**
 * universal-provider-settings-overhaul (AC1/AC14): the desktop endpoint policy
 * agrees row-for-row with BOTH committed vector files, and stays a byte-for-byte
 * twin of the browser module (web_ui/src/lib/llm/endpoint-policy.ts) apart from
 * the airgap-default source and the cross-reference comment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyAddress, validateEndpointUrl } from '../../main/security/endpoint-policy';

interface Vec {
  url: string;
  airgap?: boolean;
  ok: boolean;
  kind?: string;
  rules?: string[];
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const load = (name: string): Vec[] =>
  (JSON.parse(fs.readFileSync(path.join(REPO, 'contracts', name), 'utf8')) as { cases: Vec[] }).cases;

afterEach(() => {
  delete process.env.TRAININGAPP_AIRGAP;
});

for (const file of ['endpoint-policy-vectors.json', 'endpoint-policy-vectors.supplemental.json']) {
  describe(`desktop endpoint policy vs ${file}`, () => {
    for (const c of load(file)) {
      it(`${c.airgap ? '[airgap] ' : ''}${JSON.stringify(c.url)}`, () => {
        const v = validateEndpointUrl(c.url, { airgap: c.airgap === true });
        if (c.ok) {
          expect(v, JSON.stringify(v)).toMatchObject({ ok: true, kind: c.kind });
        } else {
          expect(v.ok, JSON.stringify(v)).toBe(false);
          expect(c.rules).toContain(v.rule);
          expect(v.message).toContain(v.rule as string);
        }
      });
    }
  });
}

describe('desktop policy specifics', () => {
  it('reads TRAININGAPP_AIRGAP at call time, and an explicit option wins', () => {
    process.env.TRAININGAPP_AIRGAP = '1';
    expect(validateEndpointUrl('https://api.openai.com').rule).toBe('airgap-public');
    expect(validateEndpointUrl('https://api.openai.com', { airgap: false }).ok).toBe(true);
    delete process.env.TRAININGAPP_AIRGAP;
    expect(validateEndpointUrl('https://api.openai.com').ok).toBe(true);
  });

  it('classifies DNS answers in both IPv4-mapped spellings', () => {
    expect(classifyAddress('::ffff:169.254.169.254')).toMatchObject({ ok: false, rule: 'metadata' });
    expect(classifyAddress('::ffff:a9fe:a9fe')).toMatchObject({ ok: false, rule: 'metadata' });
    expect(classifyAddress('fd00:ec2::254')).toMatchObject({ ok: false, rule: 'metadata' });
  });

  it('is the twin of the browser module (only the airgap source and cross-reference differ)', () => {
    const web = fs.readFileSync(path.join(REPO, 'web_ui', 'src', 'lib', 'llm', 'endpoint-policy.ts'), 'utf8');
    const desk = fs.readFileSync(path.join(REPO, 'desktop', 'main', 'security', 'endpoint-policy.ts'), 'utf8');
    const normalize = (s: string) =>
      s
        .replace(/\r\n/g, '\n')
        .replace("import { IS_AIRGAP } from './airgap';\n", '')
        .replace("opts?.airgap ?? IS_AIRGAP", 'AIRGAP_DEFAULT')
        .replace("opts?.airgap ?? process.env.TRAININGAPP_AIRGAP === '1'", 'AIRGAP_DEFAULT')
        .replace(' * desktop/main/security/endpoint-policy.ts', ' * TWIN')
        .replace(' * web_ui/src/lib/llm/endpoint-policy.ts', ' * TWIN');
    expect(normalize(desk)).toBe(normalize(web));
  });
});
