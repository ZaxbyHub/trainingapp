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
