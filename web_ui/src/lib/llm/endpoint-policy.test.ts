/**
 * universal-provider-settings-overhaul (AC1/AC14): the browser endpoint policy
 * agrees row-for-row with BOTH committed vector files (the frozen 78-row table
 * and the supplemental numeric / IPv4-embedding / unspecified rows). The
 * desktop twin asserts the same two files (desktop/src/__tests__/endpoint-policy.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { classifyAddress, hostKind, validateEndpointUrl } from './endpoint-policy';

interface Vec {
  url: string;
  airgap?: boolean;
  ok: boolean;
  kind?: string;
  rules?: string[];
}

const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'contracts');
const load = (name: string): Vec[] =>
  (JSON.parse(fs.readFileSync(path.join(CONTRACTS, name), 'utf8')) as { cases: Vec[] }).cases;

for (const file of ['endpoint-policy-vectors.json', 'endpoint-policy-vectors.supplemental.json']) {
  describe(`web endpoint policy vs ${file}`, () => {
    const cases = load(file);
    test('vector file is non-trivial', () => {
      expect(cases.length).toBeGreaterThan(30);
    });
    for (const c of cases) {
      test(`${c.airgap ? '[airgap] ' : ''}${JSON.stringify(c.url)}`, () => {
        const v = validateEndpointUrl(c.url, { airgap: c.airgap === true });
        expect(v.message.length).toBeGreaterThan(0);
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

describe('address classification used for connect-time checks', () => {
  test('resolved answers classify like URL literals', () => {
    expect(classifyAddress('127.0.0.1')).toEqual({ ok: true, kind: 'loopback' });
    expect(classifyAddress('::1')).toEqual({ ok: true, kind: 'loopback' });
    expect(classifyAddress('::ffff:a9fe:a9fe')).toMatchObject({ ok: false, rule: 'metadata' });
    expect(classifyAddress('fe80::1')).toMatchObject({ ok: false, rule: 'link-local' });
    expect(classifyAddress('0.0.0.0')).toMatchObject({ ok: false, rule: 'invalid-url' });
    expect(classifyAddress('not-an-ip')).toBeNull();
  });
  test('hostKind reports the class a name claims', () => {
    expect(hostKind('gpu-box.lan')).toBe('private');
    expect(hostKind('localhost')).toBe('loopback');
    expect(hostKind('api.openai.com')).toBe('public');
    expect(hostKind('metadata.google.internal')).toBeNull();
  });
  test('never throws for hostile input', () => {
    for (const raw of [undefined, null, 42, {}, '\u0000http://x', 'http://[', 'https://a'.repeat(5000)]) {
      expect(() => validateEndpointUrl(raw as unknown as string, { airgap: false })).not.toThrow();
    }
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
    test(url, () => {
      expect(msg(url)).toBe(expected);
    });
  }
});
