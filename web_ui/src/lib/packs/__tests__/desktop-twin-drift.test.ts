// @vitest-environment node
/**
 * Desktop twin drift guard, run in the REQUIRED web-ui job (trace
 * browser-training-parity, final-critic FC4).
 *
 * The desktop job already pins these pairs (desktop/src/__tests__/
 * pack-archive-rules-drift.test.ts and browser-training-serving-drift.test.ts),
 * but a web_ui-only change would not run it. This file reads the desktop
 * sources as TEXT (desktop/main imports Electron, so it is not importable
 * here) and pins:
 *   - pack-archive-rules.ts: byte-identical in desktop/main/backend/packs/ and
 *     web_ui/src/lib/packs/ (both pinned `text eol=lf` in .gitattributes);
 *   - the course MIME table: TRAINING_MIME_TYPES === desktop protocol.ts
 *     MIME_TYPES;
 *   - the course CSP: buildBrowserTrainingCsp(app) === desktop
 *     buildTrainingCspPolicy() (parsed from desktop/main/security/csp.ts, NOT
 *     protocol.ts, which TD2 parses for the MIME table) directives without the private `app:` sources,
 *     plus `frame-ancestors 'self' <app>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAINING_MIME_TYPES, buildBrowserTrainingCsp } from '../training-relay';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** The source text between `start` and the first `end` after it. */
function block(source: string, start: RegExp, end: string): string {
  const m = start.exec(source);
  if (m === null) throw new Error(`block start ${String(start)} not found`);
  const from = m.index + m[0].length;
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`block end ${end} not found`);
  return source.slice(from, to);
}

function desktopMimeTable(): Record<string, string> {
  const body = block(read('desktop/main/protocol.ts'), /export const MIME_TYPES\b[^=]*=\s*\{/, '};');
  const table: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const m = /^'([^']+)':\s*'([^']+)',?$/.exec(trimmed);
    if (m === null) throw new Error(`unparsed MIME_TYPES line: ${trimmed}`);
    table[m[1]] = m[2];
  }
  return table;
}

function desktopTrainingCspDirectives(): string[] {
  const body = block(
    read('desktop/main/security/csp.ts'),
    /export function buildTrainingCspPolicy\(\)[^{]*\{\s*return \[/,
    "].join('; ')",
  );
  const directives: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const m = /^"([^"]+)",?$/.exec(trimmed);
    if (m === null) throw new Error(`unparsed buildTrainingCspPolicy line: ${trimmed}`);
    directives.push(m[1]);
  }
  return directives;
}

describe('desktop twin drift (required web-ui job)', () => {
  it('TD1 pack-archive-rules.ts is byte-identical in desktop and web_ui', () => {
    const desktop = fs.readFileSync(path.join(REPO, 'desktop/main/backend/packs/pack-archive-rules.ts'));
    const web = fs.readFileSync(path.join(REPO, 'web_ui/src/lib/packs/pack-archive-rules.ts'));
    expect(desktop.length).toBeGreaterThan(0);
    expect(web.equals(desktop)).toBe(true);
  });

  it('TD2 the course MIME table equals desktop protocol.ts MIME_TYPES', () => {
    const desktop = desktopMimeTable();
    expect(Object.keys(desktop).length).toBeGreaterThan(20);
    expect({ ...TRAINING_MIME_TYPES }).toEqual(desktop);
  });

  it('TD3 the course CSP is the desktop training CSP without app: plus the frame-ancestors pin; worker-src pinned to the pack path', () => {
    const app = 'http://localhost:4183';
    const player = 'http://127.0.0.1:4183';
    const desktop = desktopTrainingCspDirectives().map((d) => d.replace(/ app:/g, ''));
    expect(desktop.length).toBeGreaterThan(5);
    // The one deliberate divergence (review round 4 F1): desktop keeps
    // worker-src 'self' blob: because every successful app://training
    // response carries the training CSP (a 4xx carries the renderer CSP but
    // can never be a worker script); on the player origin 'self' would admit app assets
    // served without it, so the browser pins blob: + the open pack's path
    // (+ the exact course worker script URL Firefox requires of a controlled
    // document that starts a worker; that URL never runs as one).
    expect(desktop).toContain("worker-src 'self' blob:");
    const expected = desktop.map((d) => (d.startsWith('worker-src ') ? `worker-src blob: ${player}/training/pack-a/ ${player}/training/sw.js` : d));
    const browser = buildBrowserTrainingCsp(app, player, 'pack-a')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    expect(browser).toEqual([...expected, `frame-ancestors 'self' ${app}`]);
  });
});
