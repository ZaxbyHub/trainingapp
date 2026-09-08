// CSP pin-drift guard (issue #60, B2 — implementation-quality test, not a
// frozen acceptance check): the 'sha256-' pin in desktop/main/security/csp.ts
// must equal the SHA-256 of the ONE legitimate inline <script> in the tracked
// web_ui/index.html (vited verbatim into the packaged dist). If this test
// fails, the renderer's inline scripts changed — update the pin CONSCIOUSLY
// (and re-verify no new inline script needs its own pin) rather than letting
// the theme bootstrap silently break or an injected script slip through.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INLINE_THEME_BOOTSTRAP_SHA256, buildCspPolicy } from '../../main/security/csp';

const here = path.dirname(fileURLToPath(import.meta.url));
// desktop/src/__tests__ -> desktop -> repo root -> web_ui/index.html
const INDEX_HTML = path.resolve(here, '..', '..', '..', 'web_ui', 'index.html');
// Built artifact (exists after a desktop:build / web_ui build) — the bytes the
// packaged app actually serves. Checked whenever present so a Vite config
// change that alters the inline script cannot silently desync the CSP pin.
const DIST_HTML = path.resolve(here, '..', '..', '..', 'web_ui', 'dist', 'index.html');

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe('CSP inline-script pin (issue #60)', () => {
  it('pins exactly the inline theme-bootstrap script of web_ui/index.html', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    // .gitattributes pins this file to LF; if a CRLF ever creeps in, the hash
    // below would drift from the browser's view of the served bytes — fail
    // loudly here instead of silently shipping a broken theme bootstrap.
    expect(html.includes('\r'), 'web_ui/index.html must stay LF (.gitattributes eol=lf)').toBe(false);
    const scripts = inlineScripts(html);
    expect(scripts.length, 'expected exactly ONE inline script in web_ui/index.html').toBe(1);
    const digest = createHash('sha256').update(scripts[0], 'utf8').digest('base64');
    expect(INLINE_THEME_BOOTSTRAP_SHA256).toBe(`sha256-${digest}`);
  });

  it('the pinned policy never contains unsafe-inline or unsafe-eval', () => {
    const policy = buildCspPolicy();
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('when a built dist exists, its inline script hash matches the pin too', () => {
    if (!existsSync(DIST_HTML)) {
      // dist/ is produced by the web_ui build; absent on a fresh checkout.
      return;
    }
    const html = readFileSync(DIST_HTML, 'utf8');
    const scripts = inlineScripts(html);
    expect(scripts.length, 'built dist/index.html must keep exactly ONE inline script').toBe(1);
    const digest = createHash('sha256').update(scripts[0], 'utf8').digest('base64');
    expect(INLINE_THEME_BOOTSTRAP_SHA256).toBe(`sha256-${digest}`);
  });
});
