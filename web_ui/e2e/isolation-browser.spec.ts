/**
 * isolation-browser.spec.ts — defensive isolation assertions for the browser
 * course player (browser-training-parity AC11, ADR-0012; review round 1
 * F1/F2). A fixture course whose own script ATTEMPTS each forbidden action is
 * installed and played; the test asserts every attempt FAILS:
 *
 *   - the app origin's localStorage / sessionStorage / IndexedDB (including
 *     the external-model key entries the test seeds) are not readable or
 *     writable from course content;
 *   - window.parent / window.top property access throws SecurityError;
 *   - forged slide-state, relay-request and handshake messages posted to the
 *     app change nothing;
 *   - files of another installed pack, of an inactive version, of the app
 *     shell and of the app origin are refused through the relay/worker;
 *   - window.open returns null and top navigation is blocked (course frame
 *     sandbox without allow-popups / allow-top-navigation).
 *
 * The course script only records outcomes; it carries no payload beyond what
 * the assertions need. Run under web_ui/playwright.config.ts (vite preview of
 * the production build on 127.0.0.1:4174; player origin http://localhost:4174).
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

const PROBE_PACK = 'isolation-probe-course';
const OTHER_PACK = 'isolation-other-course';
const SLIDE_DOC_PATH = 'docs/slide-001-5rN4PvXJM5d.json';
const SLIDE_DOC = Buffer.from(
  JSON.stringify({ slide_id: '5rN4PvXJM5d', slide_title: 'Welcome', section_title: 'Launch Menu', on_screen_text: 'Start' }),
  'utf8',
);
/** Sentinels seeded into the APP origin's storage (T1 external-model key entries). */
const SENTINEL_KEY = 'sk-isolation-sentinel-not-a-real-key';
const SEEDED = {
  local: { 'external-provider-apikey': SENTINEL_KEY, 'external-provider-config': '{"enabled":true,"baseUrl":"http://127.0.0.1:9"}', 'openai-provider-apikey': SENTINEL_KEY },
  session: { 'external-provider-apikey': SENTINEL_KEY },
};

/** The course page: runs each probe and records the outcome in <pre id="probe">. */
function probeStoryHtml(): string {
  const script = `
(async function () {
  var r = {};
  function errName(fn) { try { fn(); return 'no-error'; } catch (e) { return (e && e.name) || String(e); } }
  r.localRead = ['external-provider-apikey', 'external-provider-config', 'openai-provider-apikey'].map(function (k) { return localStorage.getItem(k); });
  r.sessionRead = sessionStorage.getItem('external-provider-apikey');
  localStorage.setItem('isolation-probe-written', '1');
  try {
    var dbs = await indexedDB.databases();
    r.idbNames = dbs.map(function (d) { return d.name || ''; });
  } catch (e) { r.idbNames = ['error:' + e.name]; }
  r.parentStorage = errName(function () { return window.parent.localStorage.length; });
  r.topDocument = errName(function () { return window.top.document.title; });
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  r.appOrigin = appOrigin;
  window.parent.postMessage({ __trainingapp: true, kind: 'state-result', reqId: 1, state: { slideId: 'FORGED', slideTitle: 'Forged' } }, '*');
  window.parent.postMessage({ type: 'trainingapp-relay-request' }, '*');
  window.parent.postMessage({ type: 'trainingapp-relay-handshake' }, '*');
  async function status(url) { try { var res = await fetch(url); return res.status; } catch (e) { return 'network-error'; } }
  r.otherPack = await status('/training/${OTHER_PACK}/story.html');
  r.inactiveVersion = await status('/training/${PROBE_PACK}/v1-only.txt');
  r.ownActive = await status('/training/${PROBE_PACK}/v2-only.txt');
  r.appShellOnPlayerOrigin = await status('/index.html');
  r.appOrigin_root = appOrigin ? await status(appOrigin + '/') : 'no-app-origin';
  var popup = null;
  try { popup = window.open('about:blank', '_blank'); } catch (e) { popup = 'threw:' + e.name; }
  r.popup = popup === null ? 'null' : typeof popup === 'string' ? popup : 'window';
  r.topNavigation = errName(function () { window.top.location.href = appOrigin + '/#isolation-hijacked'; });
  document.getElementById('probe').textContent = JSON.stringify(r);
})();`;
  return `<!doctype html><html><head><title>isolation probe</title></head><body><pre id="probe"></pre><script>${script}</script></body></html>`;
}

function manifest(id: string, version: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version,
    published_at: '2026-10-01T00:00:00Z',
    source_class: 'training',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
    docs: [{ path: SLIDE_DOC_PATH, sha256: createHash('sha256').update(SLIDE_DOC).digest('hex'), title: 'Welcome', mime: 'application/json' }],
  };
}

async function packZip(id: string, version: string, files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('pack.json', JSON.stringify(manifest(id, version)));
  zip.file(SLIDE_DOC_PATH, SLIDE_DOC);
  for (const [name, body] of Object.entries(files)) zip.file(`assets/player/${name}`, body);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

async function install(page: Page, bytes: Buffer, name: string, id: string, version: string): Promise<void> {
  await page.getByTestId('pack-install-input').setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
  await expect(page.getByTestId(`pack-row-${id}-${version}`)).toBeVisible({ timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.fallback() : route.abort();
  });
});

test('course content cannot reach app storage, app windows, other packs, popups or top navigation', async ({ page }) => {
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  await page.evaluate((seed) => {
    for (const [k, v] of Object.entries(seed.local)) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(seed.session)) sessionStorage.setItem(k, v);
  }, SEEDED);
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });

  await install(page, await packZip(OTHER_PACK, '1.0.0', { 'story.html': '<html><body>OTHER</body></html>' }), 'other.zip', OTHER_PACK, '1.0.0');
  await install(page, await packZip(PROBE_PACK, '1.0.0', { 'story.html': probeStoryHtml(), 'v1-only.txt': 'v1' }), 'probe-1.zip', PROBE_PACK, '1.0.0');
  await install(page, await packZip(PROBE_PACK, '2.0.0', { 'story.html': probeStoryHtml(), 'v2-only.txt': 'v2' }), 'probe-2.zip', PROBE_PACK, '2.0.0');
  await expect(page.getByTestId(`pack-status-${PROBE_PACK}-2.0.0`)).toHaveText(/active/i);

  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: PROBE_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const frame = page.locator('iframe[data-testid="training-player-frame"]');
  const probe = page.frameLocator('iframe[data-testid="training-player-frame"]').locator('#probe');
  await expect(probe).not.toHaveText('', { timeout: 60_000 });
  const r = JSON.parse((await probe.textContent()) ?? '{}') as Record<string, unknown>;

  // App storage is unreachable: course reads see its own (empty) origin.
  expect(r.localRead).toEqual([null, null, null]);
  expect(r.sessionRead).toBeNull();
  expect((r.idbNames as string[]).filter((n) => /doc-qa|packs/.test(n))).toEqual([]);
  // Course writes land in the player origin, never the app's.
  const app = await page.evaluate(() => ({
    written: localStorage.getItem('isolation-probe-written'),
    key: localStorage.getItem('external-provider-apikey'),
    sessionKey: sessionStorage.getItem('external-provider-apikey'),
  }));
  expect(app).toEqual({ written: null, key: SENTINEL_KEY, sessionKey: SENTINEL_KEY });
  // Cross-origin window access throws.
  expect(r.parentStorage).toBe('SecurityError');
  expect(r.topDocument).toBe('SecurityError');
  expect(r.appOrigin).toBe(appOrigin);
  // Relay / worker scoping.
  expect(r.ownActive).toBe(200);
  expect(r.otherPack).toBe(404);
  expect(r.inactiveVersion).toBe(404);
  expect(r.appShellOnPlayerOrigin).toBe(404);
  expect(r.appOrigin_root).not.toBe(200);
  // Sandbox: no popup, no top navigation.
  expect(r.popup).toBe('null');
  expect(r.topNavigation).not.toBe('no-error');
  await page.waitForTimeout(1000);
  expect(page.url()).not.toContain('isolation-hijacked');
  expect(new URL(page.url()).origin).toBe(appOrigin);
  // Forged messages changed nothing the app shows.
  await expect(page.getByTestId('training-player-slide')).not.toContainText('FORGED');
  // Checked last so the behavioral rows above decide a sandbox regression.
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
});
