/**
 * settings-wiring-honesty (AC8): Settings → About shows the version imported
 * from web_ui/package.json — the single version source. The desktop app ships
 * the same renderer, so desktop/package.json must stay in lockstep or the
 * desktop About would show a version the installer does not carry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import webPkg from '../package.json';

const DESKTOP_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'desktop', 'package.json');

describe('app version lockstep', () => {
  it('desktop/package.json version equals web_ui/package.json version', () => {
    const desktopPkg = JSON.parse(fs.readFileSync(DESKTOP_PKG, 'utf8')) as { version: string };
    expect(webPkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(desktopPkg.version).toBe(webPkg.version);
  });
});
