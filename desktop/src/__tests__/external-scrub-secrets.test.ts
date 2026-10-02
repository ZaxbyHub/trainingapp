// PR #142 review F-018: scrubSecrets redacts every echo form of the key an
// upstream error may carry — verbatim, encodeURIComponent, HTML-escaped
// (named and numeric references), case variants, and any run of 12+
// consecutive key characters (mid-key echo). The browser twin
// (web_ui/src/lib/llm/provider-error.ts) implements the same rules.
import { describe, expect, it } from 'vitest';
import { SCRUB_MIN_ECHO_CHARS, scrubSecrets } from '../../main/backend/net/provider-error';

// Not sk- shaped, so the generic sk- mask can never be what redacts it.
const KEY = `Zq9_Live<&>"'Key/+=MidSection-0123456789xyz`;
const MID = KEY.slice(14, 14 + SCRUB_MIN_ECHO_CHARS); // a 12-char run from the middle

const htmlNamed = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const htmlDecimal = (s: string): string => [...s].map((c) => `&#${c.charCodeAt(0)};`).join('');
const htmlHex = (s: string): string => [...s].map((c) => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`).join('');

/** No 12-char window of the key (case-insensitively) survives in `out`. */
function leaksKey(out: string): boolean {
  const lower = out.toLowerCase();
  for (let i = 0; i + SCRUB_MIN_ECHO_CHARS <= KEY.length; i += 1) {
    if (lower.includes(KEY.slice(i, i + SCRUB_MIN_ECHO_CHARS).toLowerCase())) return true;
  }
  return false;
}

describe('F-018: scrubSecrets redacts encoded, escaped, case-variant and mid-key echoes', () => {
  it('verbatim key (regression)', () => {
    const out = scrubSecrets(`bad key ${KEY} here`, KEY);
    expect(out).toBe('bad key [redacted] here');
  });

  it('encodeURIComponent form', () => {
    const encoded = encodeURIComponent(KEY);
    expect(encoded).not.toBe(KEY);
    const out = scrubSecrets(`GET /v1/models?key=${encoded}&x=1`, KEY);
    expect(out).toBe('GET /v1/models?key=[redacted]&x=1');
  });

  it('lower-case percent hex is matched too', () => {
    const encoded = encodeURIComponent(KEY).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(scrubSecrets(`k=${encoded}`, KEY)).toBe('k=[redacted]');
  });

  it('HTML-escaped form with named references (&amp; &lt; &gt; &quot; &#39;)', () => {
    const escaped = htmlNamed(KEY);
    expect(escaped).not.toBe(KEY);
    expect(scrubSecrets(`<p>key ${escaped}</p>`, KEY)).toBe('<p>key [redacted]</p>');
  });

  it('&apos; and &#x27; spellings', () => {
    expect(scrubSecrets(htmlNamed(KEY).replace(/&#39;/g, '&apos;'), KEY)).toBe('[redacted]');
    expect(scrubSecrets(htmlNamed(KEY).replace(/&#39;/g, '&#x27;'), KEY)).toBe('[redacted]');
  });

  it('fully numeric character references (decimal and hex)', () => {
    expect(scrubSecrets(`a ${htmlDecimal(KEY)} b`, KEY)).toBe('a [redacted] b');
    expect(scrubSecrets(`a ${htmlHex(KEY)} b`, KEY)).toBe('a [redacted] b');
  });

  it('case-insensitive matches', () => {
    expect(scrubSecrets(`upper ${KEY.toUpperCase()}`, KEY)).toBe('upper [redacted]');
    expect(scrubSecrets(`lower ${KEY.toLowerCase()}`, KEY)).toBe('lower [redacted]');
  });

  it(`a mid-key echo of ${SCRUB_MIN_ECHO_CHARS}+ consecutive characters`, () => {
    expect(KEY.startsWith(MID)).toBe(false);
    expect(KEY.endsWith(MID)).toBe(false);
    const out = scrubSecrets(`provider said: ...${MID}...`, KEY);
    expect(out).toBe('provider said: ...[redacted]...');
    const longer = KEY.slice(10, 31);
    expect(scrubSecrets(`[${longer}]`, KEY)).toBe('[[redacted]]');
  });

  it(`a mid-key run shorter than ${SCRUB_MIN_ECHO_CHARS} characters is left alone (boundary)`, () => {
    const short = KEY.slice(20, 20 + SCRUB_MIN_ECHO_CHARS - 1);
    expect(scrubSecrets(`x ${short} y`, KEY)).toBe(`x ${short} y`);
  });

  it('a mid-key echo in encoded / escaped / upper-case form', () => {
    expect(leaksKey(scrubSecrets(`q=${encodeURIComponent(KEY.slice(5, 25))}`, KEY))).toBe(false);
    expect(scrubSecrets(`q=${encodeURIComponent(KEY.slice(5, 25))}`, KEY)).toBe('q=[redacted]');
    expect(scrubSecrets(htmlNamed(KEY.slice(3, 20)), KEY)).toBe('[redacted]');
    expect(scrubSecrets(MID.toUpperCase(), KEY)).toBe('[redacted]');
  });

  it('a key that literally contains an escape-looking sequence is still matched verbatim', () => {
    const odd = 'abc%41def&amp;ghi-0123456789';
    expect(scrubSecrets(`x ${odd} y`, odd)).toBe('x [redacted] y');
  });

  it('leaves unrelated text untouched and still masks sk- shaped tokens', () => {
    expect(scrubSecrets('model m1 not found', KEY)).toBe('model m1 not found');
    expect(scrubSecrets('other sk-abcdef123456 token', KEY)).toBe('other sk-[redacted] token');
  });
});
