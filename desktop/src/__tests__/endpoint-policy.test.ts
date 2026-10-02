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
    const cases = load(file);
    // PR #142 review F-017: non-vacuity guard (the web twin has the same) —
    // an empty or truncated vector file must fail, not pass with zero rows.
    it('vector file is non-trivial', () => {
      expect(cases.length).toBeGreaterThan(30);
    });
    for (const c of cases) {
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

// Review round 3 (R3-N3): refusal reasons are specific and read as one sentence.
describe('refusal reasons (local-use NAT64, Teredo, unspecified)', () => {
  const msg = (url: string) => validateEndpointUrl(url, { airgap: false }).message;
  const MESSAGES: Array<[string, string]> = [
    [
      'https://[64:ff9b:1:808:8:808:800:0]',
      'Endpoint refused (invalid-url): a local-use NAT64 address (64:ff9b:1::/48) outside the /96 layout (its embedded IPv4 address cannot be determined) cannot be used as a model endpoint',
    ],
    [
      'http://[64:ff9b:1:a9fe:a9:fe00::]/',
      'Endpoint refused (metadata): a local-use NAT64 address (64:ff9b:1::/48) that may embed the cloud metadata service address 169.254.169.254 cannot be used as a model endpoint',
    ],
    [
      'http://[2001:0:4136:e378:8000:63bf:5601:5601]',
      'Endpoint refused (metadata): a Teredo address (2001::/32) whose client is the cloud metadata service address 169.254.169.254 cannot be used as a model endpoint',
    ],
    [
      'http://[2001:0:a9fe:a9fe::3fff:fdd2]',
      'Endpoint refused (metadata): a Teredo address (2001::/32) whose server is the cloud metadata service address 169.254.169.254 cannot be used as a model endpoint',
    ],
    [
      'http://0.0.0.0:8080',
      'Endpoint refused (invalid-url): the unspecified address 0.0.0.0/8 (not a server address) cannot be used as a model endpoint',
    ],
    [
      'https://[64:ff9b:1:abcd::1]',
      'Endpoint refused (invalid-url): a local-use NAT64 address (64:ff9b:1::/48) that may embed the unspecified address 0.0.0.0/8 (not a server address) cannot be used as a model endpoint',
    ],
    ['http://[::]:8080', 'Endpoint refused (invalid-url): the unspecified address :: (not a server address) cannot be used as a model endpoint'],
  ];
  for (const [url, expected] of MESSAGES) {
    it(url, () => {
      expect(msg(url)).toBe(expected);
    });
  }
});
