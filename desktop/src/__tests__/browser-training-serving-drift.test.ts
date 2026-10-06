// Desktop <-> browser course-serving drift guard (trace browser-training-parity AC3).
//
// The browser app serves pack player assets from its player-origin service
// worker through the app-side relay (web_ui/src/lib/packs/training-relay.ts);
// desktop serves them from app://training (main/protocol.ts). The MIME table
// must be identical, and the browser training CSP must be the desktop
// training CSP with the private `app:` sources dropped plus the web-only
// frame-ancestors pin. Containment parity is pinned separately by
// contracts/training-path-vectors.json (training-path-vectors.test.ts).
import { describe, expect, it } from 'vitest';
import { MIME_TYPES } from '../../main/protocol.js';
import { buildTrainingCspPolicy } from '../../main/security/csp.js';
import { TRAINING_MIME_TYPES, buildBrowserTrainingCsp } from '../../../web_ui/src/lib/packs/training-relay';

describe('browser course serving mirrors desktop app://training', () => {
  it('MIME table is identical', () => {
    expect({ ...TRAINING_MIME_TYPES }).toEqual({ ...MIME_TYPES });
  });

  it('training CSP = desktop training CSP without app: sources + frame-ancestors pinned to self and the app origin; worker-src pinned to the open pack path plus the course service worker script', () => {
    const app = 'http://localhost:4183';
    const player = 'http://127.0.0.1:4183';
    const desktopDirectives = buildTrainingCspPolicy()
      .split(';')
      .map((d) => d.trim().replace(/ app:/g, ''))
      .filter((d) => d.length > 0);
    // Desktop keeps worker-src 'self' blob: (every successful app://training
    // response carries this CSP, so a 'self' worker stays confined; a 4xx
    // carries the renderer CSP but can never be loaded as a worker script);
    // the browser pins blob: + the open pack's relay path (review round 4 F1)
    // + the course service worker script, which Firefox requires the document's
    // worker-src to admit before it starts any SW-controlled dedicated worker.
    expect(desktopDirectives).toContain("worker-src 'self' blob:");
    const expected = desktopDirectives.map((d) => (d.startsWith('worker-src ') ? `worker-src blob: ${player}/training/pack-a/ ${player}/training/sw.js` : d));
    const browserDirectives = buildBrowserTrainingCsp(app, player, 'pack-a')
      .split(';')
      .map((d) => d.trim());
    expect(browserDirectives).toEqual([...expected, `frame-ancestors 'self' ${app}`]);
  });
});
