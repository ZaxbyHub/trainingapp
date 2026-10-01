// Twin drift guard (trace browser-training-parity AC1): the pack archive rules
// are twinned between the desktop and browser packages (no workspace root, so
// no cross-package import at runtime). Any byte difference fails CI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const DESKTOP = path.join(repo, 'desktop', 'main', 'backend', 'packs', 'pack-archive-rules.ts');
const BROWSER = path.join(repo, 'web_ui', 'src', 'lib', 'packs', 'pack-archive-rules.ts');

describe('pack-archive-rules twin', () => {
  it('desktop and browser copies are byte-identical', () => {
    const desktop = fs.readFileSync(DESKTOP);
    const browser = fs.readFileSync(BROWSER);
    expect(browser.equals(desktop), `${BROWSER} drifted from ${DESKTOP}; edit both twins together`).toBe(true);
  });

  it('the desktop extractor routes its guards through the shared rules', () => {
    const extractor = fs.readFileSync(path.join(repo, 'desktop', 'main', 'backend', 'packs', 'pack-extract.ts'), 'utf8');
    for (const symbol of ['checkEntryName', 'parseCentralDirectory', 'sharedEnforceDeclaredLimits', 'notZipMessage', 'symlinkEntryMessage', 'missingManifestMessage']) {
      expect(extractor, `pack-extract.ts must use ${symbol} from pack-archive-rules`).toContain(symbol);
    }
  });
});
