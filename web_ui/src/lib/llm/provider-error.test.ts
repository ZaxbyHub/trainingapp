/**
 * F-018 (PR #142 review): scrubSecrets must catch every form an upstream can
 * echo the key in, not only the verbatim key. The keys below deliberately do
 * NOT start with `sk-`: the generic `sk-` token mask would otherwise hide a
 * missed echo and make these tests pass with the fix removed.
 */
import { describe, expect, test } from 'vitest';

import { SCRUB_MIN_ECHO_CHARS, scrubSecrets } from './provider-error';

// Mixed case + characters encodeURIComponent and HTML escaping both rewrite.
const KEY = 'Gw7/Qe+Rt9&Lp2=Zx4<Mn6>Vb8"Kc3';
const ABSENT = /Gw7|Qe\+?Rt9|Lp2|Zx4|Mn6|Vb8|Kc3/i;

function htmlDecimal(s: string): string {
  return Array.from(s, (c) => `&#${c.codePointAt(0)};`).join('');
}
function htmlHex(s: string): string {
  return Array.from(s, (c) => `&#x${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()};`).join('');
}
function htmlNamed(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

describe('scrubSecrets (F-018)', () => {
  test('the verbatim key is redacted', () => {
    const out = scrubSecrets(`bad key ${KEY} rejected`, KEY);
    expect(out).toBe('bad key [redacted] rejected');
  });

  test('the encodeURIComponent form is redacted (upper- and lower-case hex)', () => {
    const encoded = encodeURIComponent(KEY);
    expect(encoded).not.toBe(KEY); // the fixture really is rewritten by encoding
    const out = scrubSecrets(`GET /v1/models?key=${encoded} 401`, KEY);
    expect(out).not.toContain(encoded);
    expect(out).toContain('[redacted]');
    const lower = encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(scrubSecrets(`key=${lower}`, KEY)).toBe('key=[redacted]');
  });

  test('the HTML-escaped form is redacted (named entities)', () => {
    const escaped = htmlNamed(KEY);
    expect(escaped).not.toBe(KEY);
    expect(scrubSecrets(`<p>invalid key ${escaped}</p>`, KEY)).toBe('<p>invalid key [redacted]</p>');
  });

  test('numeric HTML entities (decimal and hex) are redacted', () => {
    expect(scrubSecrets(`echo ${htmlDecimal(KEY)} end`, KEY)).toBe('echo [redacted] end');
    expect(scrubSecrets(`echo ${htmlHex(KEY)} end`, KEY)).toBe('echo [redacted] end');
  });

  test('a mixed encoding inside one echo is redacted', () => {
    const mixed = `${KEY.slice(0, 10)}${encodeURIComponent(KEY.slice(10, 20))}${htmlDecimal(KEY.slice(20))}`;
    expect(scrubSecrets(`x ${mixed} y`, KEY)).toBe('x [redacted] y');
  });

  test('case variants are redacted', () => {
    expect(scrubSecrets(`upper ${KEY.toUpperCase()} lower ${KEY.toLowerCase()}`, KEY)).toBe(
      'upper [redacted] lower [redacted]',
    );
  });

  test(`any run of ${SCRUB_MIN_ECHO_CHARS}+ consecutive key characters (mid-key echo) is redacted`, () => {
    expect(SCRUB_MIN_ECHO_CHARS).toBe(12);
    const middle = KEY.slice(9, 9 + SCRUB_MIN_ECHO_CHARS); // touches neither the first nor the last 8
    const out = scrubSecrets(`provider said: ...${middle}...`, KEY);
    expect(out).toBe('provider said: ...[redacted]...');
    expect(out).not.toMatch(ABSENT);
  });

  test(`a run shorter than ${SCRUB_MIN_ECHO_CHARS} characters from the middle is left alone (no over-redaction)`, () => {
    const short = KEY.slice(9, 9 + SCRUB_MIN_ECHO_CHARS - 1);
    expect(scrubSecrets(`id ${short}`, KEY)).toBe(`id ${short}`);
  });

  test('ordinary text without the key is unchanged', () => {
    const text = 'The endpoint returned an error: model not loaded (HTTP 500) &amp; 50% done';
    expect(scrubSecrets(text, KEY)).toBe(text);
  });

  test('a short key (< 12 chars) is redacted whole, case-insensitively and encoded', () => {
    const short = 'Ab/9z';
    expect(scrubSecrets(`k=${short} K=${short.toUpperCase()} e=${encodeURIComponent(short)}`, short)).toBe(
      'k=[redacted] K=[redacted] e=[redacted]',
    );
  });

  test('the 2-byte UTF-8 percent form of a Latin-1 key character is redacted', () => {
    const key = 'Zlatin-é-0123456789';
    const encoded = encodeURIComponent(key);
    expect(encoded).toContain('%C3%A9');
    expect(scrubSecrets(`q=${encoded}&x=1`, key)).toBe('q=[redacted]&x=1');
  });

  test('a key containing a literal %XX sequence still matches verbatim', () => {
    const key = 'abc%41def%42ghijk-literal';
    expect(scrubSecrets(`echo ${key.toUpperCase()}`, key)).toBe('echo [redacted]');
  });

  test('the first/last 8 characters are still scrubbed and sk- tokens still masked', () => {
    expect(scrubSecrets(`prefix ${KEY.slice(0, 8)}`, KEY)).toBe('prefix [redacted]');
    expect(scrubSecrets(`suffix ${KEY.slice(-8)}`, KEY)).toBe('suffix [redacted]');
    expect(scrubSecrets('token sk-unrelated1234', KEY)).toBe('token sk-[redacted]');
  });
});
