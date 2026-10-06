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
 *     ADR-0012 threat model item 6);
 *   - course content cannot create a same-origin child iframe and steer it
 *     off-origin through child.contentWindow.location.href (the course's own
 *     frame-src: a child's immediate embedder is the course document, PR 144
 *     review R1.1).
 *
 * The course script only records outcomes; it carries no payload beyond what
 * the assertions need. Run under web_ui/playwright.config.ts (vite preview of
 * the production build on 127.0.0.1:4174; player origin http://localhost:4174).
 *
 * Observation channel (PRR-151-030, Chromium AND Firefox): each course REPORTS
 * its observations to the app page with postMessage (targetOrigin = the app
 * origin), and the test reads them from a collector it installs in the TOP page.
 * The app is served with COOP same-origin + COEP require-corp, which makes Firefox
 * run the cross-origin course frame in its own process (Fission), and Playwright's
 * Firefox cannot attach to an out-of-process iframe (frame DOM, frame evaluate)
 * nor deliver input into one, so nothing here may depend on reaching into a frame.
 * The one exception is the click-activation spec, which launches its browser with
 * Fission off (see NO_FISSION_ENV) and so can click and read inside the frame.
 * A report counts only when its event.origin is the player origin
 * and its event.source is the course frame's window. On Chromium the in-frame
 * record is also read and must equal the report. The app origin is baked into
 * each fixture (it is known when the zip is built); the fixture also reports
 * location.ancestorOrigins[0], which must name the same origin. Nothing about the
 * app's headers, CSPs or sandboxes is relaxed for either engine.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

/**
 * Spec 6 (a REAL click inside the course frame) on Firefox, PRR-151-030 lane I.
 *
 * Firefox puts a cross-site iframe of a cross-origin-isolated page in its own
 * content process (Fission), and Playwright's Firefox cannot deliver input into an
 * out-of-process iframe: mouse and keyboard events never reach it and frame
 * locators never resolve. Proven WITHOUT app code by e2e/frame-input/
 * frame-input.repro.ts (a static COOP+COEP page with a cross-origin iframe gets no
 * events on Firefox; Chromium, and the same Firefox with Fission disabled, get
 * them all; stock Firefox over WebDriver BiDi fails the same way for ANY
 * cross-site iframe, so it is the driver, not these headers). Upstream:
 * microsoft/playwright#21780 (closed, not planned). Real user input is routed by
 * Firefox's parent process and is not expected to be affected (not measured by
 * automation; see the lane I report for PRR-151-030).
 *
 * So spec 6 launches its OWN browser with Fission disabled
 * (MOZ_FORCE_DISABLE_FISSION=1; ignored by Chromium, which runs the same path).
 * Only the process model changes: the app keeps COOP same-origin + COEP
 * require-corp (the test asserts crossOriginIsolated), the course frame keeps its
 * sandbox, CSP and player origin, and the click must be trusted and carry user
 * activation (asserted inside the course), so the sandbox refusal is exercised
 * by the Gecko DOM exactly as a user's click would. The other specs keep the
 * default (Fission on) browser and observe through out-of-band reports.
 */
const NO_FISSION_ENV = { MOZ_FORCE_DISABLE_FISSION: '1' };

/**
 * How a sandboxed window.open (no allow-popups) is refused differs by engine:
 * Chromium returns null, Firefox throws InvalidAccessError. Either way no window
 * is obtained; any other outcome (a window) fails. The test also counts popup
 * pages, so a popup that opened despite the return value is still caught.
 */
function expectNoPopupWindow(outcome: unknown, browserName: string, label: string): void {
  if (browserName === 'firefox') expect(outcome, label).toBe('threw:InvalidAccessError');
  else expect(outcome, label).toBe('null');
}

/** Reports the course fixtures post to the app page (see the header). */
interface CourseReport {
  origin: string;
  fromCourse: boolean;
  kind: string;
  payload: unknown;
}

/** The player origin for an app origin: the other loopback name of the same server. */
function playerOriginOf(appOrigin: string): string {
  const u = new URL(appOrigin);
  u.hostname = u.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  return u.origin;
}

/**
 * Installed in the TOP page only (page.evaluate after goto, never an init
 * script: an init script would also run inside the course frame).
 */
async function installReportCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __isolationReports: CourseReport[] };
    w.__isolationReports = [];
    window.addEventListener('message', (event) => {
      const data = event.data as { __isolationProbe?: unknown; payload?: unknown } | null;
      if (data === null || typeof data !== 'object' || typeof data.__isolationProbe !== 'string') return;
      const course = document.querySelector<HTMLIFrameElement>('iframe[data-testid="training-player-frame"]');
      w.__isolationReports.push({
        origin: event.origin,
        fromCourse: course !== null && event.source === course.contentWindow,
        kind: data.__isolationProbe,
        payload: data.payload,
      });
    });
  });
}

async function reportsOf(page: Page, kind: string): Promise<CourseReport[]> {
  return page.evaluate((k) => (window as unknown as { __isolationReports: CourseReport[] }).__isolationReports.filter((r) => r.kind === k), kind);
}

/** Every report of `kind` came from the course frame's window on the player origin. */
function expectFromCourse(reports: CourseReport[], appOrigin: string): void {
  for (const r of reports) {
    expect(r.origin, `report ${r.kind} origin`).toBe(playerOriginOf(appOrigin));
    expect(r.fromCourse, `report ${r.kind} came from the course frame's window`).toBe(true);
  }
}

/** Wait for the first report of `kind` and return its (JSON) payload, parsed. */
async function courseReport<T>(page: Page, kind: string, appOrigin: string, timeout: number): Promise<T> {
  await expect.poll(async () => (await reportsOf(page, kind)).length, { timeout, message: `course report "${kind}"` }).toBeGreaterThan(0);
  const reports = await reportsOf(page, kind);
  expectFromCourse(reports, appOrigin);
  return JSON.parse(String(reports[0].payload)) as T;
}

/** Chromium can still read the frame: its in-frame record must equal the report. */
async function expectFrameRecordMatches(page: Page, browserName: string, selector: string, reported: unknown): Promise<void> {
  if (browserName !== 'chromium') return;
  const text = await page.frameLocator('iframe[data-testid="training-player-frame"]').locator(selector).textContent();
  expect(JSON.parse(text ?? 'null'), `in-frame ${selector} record equals the posted report`).toEqual(reported);
}

/**
 * Course-side prelude: the app origin (baked, see the header), the
 * ancestorOrigins cross-check and the report() channel. Plain ES5.
 */
function coursePrelude(appOrigin: string): string {
  return `var appOrigin = ${JSON.stringify(appOrigin)};
  var ancestorOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || null;
  function report(kind, payload) { try { window.parent.postMessage({ __isolationProbe: kind, payload: payload }, appOrigin); } catch (e) { /* parent gone */ } }`;
}

const PROBE_PACK = 'isolation-probe-course';
const CLICK_PACK = 'isolation-click-course';
const OTHER_PACK = 'isolation-other-course';
const ESCAPE_PACK = 'isolation-escape-course';
const NAV_PACK = 'isolation-nav-egress-course';
const CHILD_NAV_PACK = 'isolation-child-nav-course';
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
 * (their fetch to the sink is refused). The course service worker's script is
 * the one non-pack script the course worker-src admits (Firefox requires it of
 * a controlled document that starts a worker, PRR-151-030 R1); the course
 * service worker answers it 404 (swScript), so a worker on it still never runs.
 */
function workerEscapeStoryHtml(appOrigin: string, assets: { classic: string; module: string; shared: string }): string {
  const script = `
(async function () {
  ${coursePrelude(appOrigin)}
  var SINK = appOrigin + '/__worker-sink/';
  var r = { violations: [], attempts: {}, controls: {}, register: {}, ancestorOrigin: ancestorOrigin };
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
  // The course service worker's answer for its own script URL (the host would answer 200).
  try { r.swScript = (await fetch('/training/sw.js')).status; } catch (e) { r.swScript = 'threw:' + name(e); }
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
  // Bounded: a registration that never settles still yields a report ('pending').
  async function tryRegister(label, url, scope) {
    r.register[label] = 'pending';
    var attempt = navigator.serviceWorker.register(url, { scope: scope }).then(
      function () { r.register[label] = 'registered'; },
      function (e) { r.register[label] = 'rejected:' + name(e); }
    );
    await Promise.race([attempt, wait(5000)]);
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
  report('worker-probe', JSON.stringify(r));
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

/**
 * The course page: runs each probe and records the outcome in <pre id="probe">
 * (and reports it). It also answers the app's GENUINE bridge state poll (the
 * pack-local bridge protocol: a request carrying a MessagePort, answered on that
 * port) with slide GENUINE, so the forged-message row below is not vacuous: the
 * readout demonstrably works, and only the genuine channel feeds it.
 */
function probeStoryHtml(appOrigin: string): string {
  const script = `
window.addEventListener('message', function (e) {
  var d = e.data;
  if (e.source !== window.parent || !d || d.__trainingapp !== true || d.kind !== 'state' || !e.ports || !e.ports[0]) return;
  e.ports[0].postMessage({ __trainingapp: true, kind: 'state-result', reqId: d.reqId, state: { slideId: 'GENUINE', slideTitle: 'Genuine bridge' } });
});
(async function () {
  ${coursePrelude(appOrigin)}
  var r = { ancestorOrigin: ancestorOrigin };
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
  report('probe', JSON.stringify(r));
})();`;
  return `<!doctype html><html><head><title>isolation probe</title></head><body><pre id="probe"></pre><script>${script}</script></body></html>`;
}

/**
 * The click-probe course (FC5): does nothing on load (a script-initiated top
 * navigation in the probe course above would already move an unsandboxed app
 * away); its buttons attempt a popup and a top navigation from a real click.
 */
function clickStoryHtml(appOrigin: string): string {
  const script = `
(function () {
  ${coursePrelude(appOrigin)}
  function record(key, value) {
    var out = document.getElementById('click-probe');
    var r = out.textContent ? JSON.parse(out.textContent) : {};
    r[key] = value;
    out.textContent = JSON.stringify(r);
  }
  function activation(e) {
    var ua = navigator.userActivation;
    return { trusted: e.isTrusted, active: ua ? ua.isActive : 'unsupported' };
  }
  document.getElementById('escape-popup').addEventListener('click', function (e) {
    record('popupClick', activation(e));
    var popup = null;
    try { popup = window.open('about:blank#isolation-click-popup', '_blank'); } catch (e) { popup = 'threw:' + e.name; }
    record('popup', popup === null ? 'null' : typeof popup === 'string' ? popup : 'window');
  });
  document.getElementById('escape-top').addEventListener('click', function (e) {
    record('topClick', activation(e));
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
function escapeStoryHtml(appOrigin: string): string {
  const script = `
(async function () {
  ${coursePrelude(appOrigin)}
  var SINK = appOrigin + '/__fc6-sink/';
  var r = { ancestorOrigin: ancestorOrigin };
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
  async function nested(label, src, probeEgress) {
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
    if (probeEgress === false) return { framed: 'same-origin-document' };
    return { framed: 'same-origin-document', egress: await egress(w, label) };
  }
  r.nestedBoot = await nested('nested-boot', '/training-boot.html');
  r.nestedBootScript = await nested('nested-boot-js', '/training-boot.js');
  r.nestedTraining404 = await nested('nested-training-404', '/training');
  r.nestedWorkerRefusal = await nested('nested-sw-refusal', '/training/sw.js');
  // Positive control: an allowed same-origin pack document IS framed and readable,
  // so a blocked row cannot pass merely because this engine hides every frame.
  r.nestedControl = await nested('nested-control', '/training/${ESCAPE_PACK}/control.html', false);
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
  report('escape-probe', JSON.stringify(r));
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

test('course content cannot reach app storage, app windows, other packs, popups or top navigation', async ({ page, browserName }) => {
  const popups: string[] = [];
  page.on('popup', (p) => popups.push(p.url()));
  page.context().on('page', (p) => popups.push(p.url()));
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  await installReportCollector(page);
  await page.evaluate((seed) => {
    for (const [k, v] of Object.entries(seed.local)) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(seed.session)) sessionStorage.setItem(k, v);
  }, SEEDED);
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });

  await install(page, await packZip(OTHER_PACK, '1.0.0', { 'story.html': '<html><body>OTHER</body></html>' }), 'other.zip', OTHER_PACK, '1.0.0');
  await install(page, await packZip(PROBE_PACK, '1.0.0', { 'story.html': probeStoryHtml(appOrigin), 'v1-only.txt': 'v1' }), 'probe-1.zip', PROBE_PACK, '1.0.0');
  await install(page, await packZip(PROBE_PACK, '2.0.0', { 'story.html': probeStoryHtml(appOrigin), 'v2-only.txt': 'v2' }), 'probe-2.zip', PROBE_PACK, '2.0.0');
  await expect(page.getByTestId(`pack-status-${PROBE_PACK}-2.0.0`)).toHaveText(/active/i);

  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: PROBE_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const frame = page.locator('iframe[data-testid="training-player-frame"]');
  const r = await courseReport<Record<string, unknown>>(page, 'probe', appOrigin, 60_000);
  await expectFrameRecordMatches(page, browserName, '#probe', r);

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
  // Fixture fidelity: the browser names the same embedder the fixture was built for.
  expect(r.ancestorOrigin).toBe(appOrigin);
  // Relay / worker scoping.
  expect(r.ownActive).toBe(200);
  expect(r.otherPack).toBe(404);
  expect(r.inactiveVersion).toBe(404);
  expect(r.appShellOnPlayerOrigin).toBe(404);
  expect(r.appOrigin_root).not.toBe(200);
  // Sandbox, script-initiated attempts (no user activation): window.open
  // yields no window (see expectNoPopupWindow) and top navigation throws.
  // Click-initiated attempts are the last test.
  expectNoPopupWindow(r.popup, browserName, 'script-initiated window.open from the course');
  expect(r.topNavigation).not.toBe('no-error');
  await page.waitForTimeout(1000);
  expect(page.url()).not.toContain('isolation-hijacked');
  expect(new URL(page.url()).origin).toBe(appOrigin);
  expect(popups, 'popup opened from the course').toEqual([]);
  // Forged messages changed nothing the app shows, while the GENUINE bridge
  // reply (on the request's own port) does feed the readout: non-vacuous. The
  // change log keeps every reported slide, so a forged slide that a later
  // genuine poll overwrote would still be caught.
  await expect(page.getByTestId('training-player-slide')).toHaveText('GENUINE|Genuine bridge', { timeout: 15_000 });
  await expect(page.getByTestId('training-player-slidechange')).not.toContainText('FORGED');
  await expect(page.getByTestId('training-player-slide')).not.toContainText('FORGED');
  // Checked last so the behavioral rows above decide a sandbox regression.
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
});

test('course content cannot escape its CSP through a same-origin player-origin document (FC6)', async ({ page, browserName }) => {
  // The course probe alone waits up to 90 s for its report; the default 30 s budget would cut it short.
  test.setTimeout(150_000);
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  await installReportCollector(page);
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
  await install(
    page,
    await packZip(ESCAPE_PACK, '1.0.0', { 'story.html': escapeStoryHtml(appOrigin), 'control.html': '<!doctype html><title>control</title><p>same-origin control</p>' }),
    'escape.zip',
    ESCAPE_PACK,
    '1.0.0',
  );
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: ESCAPE_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const r = await courseReport<Record<
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
  >>(page, 'escape-probe', appOrigin, 90_000);
  await expectFrameRecordMatches(page, browserName, '#escape-probe', r);
  expect((r as Record<string, unknown>).ancestorOrigin, 'fixture fidelity: embedder origin').toBe(appOrigin);
  await page.waitForTimeout(1000);
  test.info().annotations.push({ type: 'fc6-probe', description: `${JSON.stringify(r)} sink hits: ${JSON.stringify(hits)}` });

  // Nested: every same-origin player document refuses to be framed by course
  // content (frame-ancestors), so the course never gets a window under a
  // weaker policy. Positive control first: an allowed same-origin pack document
  // IS framed and readable, so the blocked rows are not an engine blind spot.
  expect(r.nestedControl?.framed, 'FC6 control: an allowed same-origin pack document is framed').toBe('same-origin-document');
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
  const playerOrigin = playerOriginOf(appOrigin);
  expect(r.sibling?.code?.violations ?? [], 'FC6 sibling boot worker refused by worker-src').toContain(`worker-src ${playerOrigin}/training-boot.js`);
  expect(r.sibling?.code?.worker, 'FC6 sibling boot starts a worker from another same-origin script').not.toBe('constructed');
  expect(r.sibling?.code?.script, 'FC6 sibling boot loads another same-origin script').toBe('error');
  expect(r.sibling?.code?.register ?? '', 'FC6 sibling boot registers another service worker').toMatch(/^rejected:/);
  expect(r.sibling?.code?.violations ?? [], 'FC6 sibling boot script refused by script-src').toContain(`script-src-elem ${playerOrigin}/training/sw.js`);
  // ...and is sandboxed like the course frame: no popup, no top navigation.
  expect(popups, 'FC6 popup opened from the sibling boot frame').toEqual([]);
  expectNoPopupWindow(r.sibling?.code?.openPopup, browserName, 'FC6 sibling boot window.open');
  expect(r.sibling?.code?.topNavigation, 'FC6 sibling boot top navigation').not.toBe('no-error');
  expect(page.url()).not.toContain('fc6-boot-hijacked');
  await expect(page.locator('iframe[data-testid="training-player-boot"]')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  // Nothing reached the sink from any document.
  expect(hits, 'FC6 cross-origin egress from a same-origin player document').toEqual([]);
});

/**
 * The navigation-egress course (ADR-0012 threat model item 6): CSP on a
 * course document does not govern navigation of the course's own frame or the
 * boot frame (a course-created frame is governed by the course CSP's
 * frame-src, see the child-nav row), so the course tries to carry
 * data out in a URL by (ii) inserting and clicking a link in the app's boot
 * frame and then (i) navigating its own frame. The app shell's runtime
 * `frame-src <player origin>` must refuse both before any request is sent.
 * Each attempt is announced on the console so the row is not vacuous.
 */
function navEgressStoryHtml(appOrigin: string): string {
  const script = `
(function () {
  ${coursePrelude(appOrigin)}
  function step(text) { console.log('NAV-EGRESS ' + text); report('nav-egress', text); }
  var SINK = appOrigin + '/__nav-egress-sink/';
  setTimeout(function () {
    var boot = null;
    for (var i = 0; i < window.parent.frames.length; i++) {
      try { if (window.parent.frames[i].location.pathname === '/training-boot.html') boot = window.parent.frames[i]; } catch (e) { /* cross-origin */ }
    }
    step('boot-frame ' + (boot ? 'found' : 'missing'));
    if (boot) {
      var a = boot.document.createElement('a');
      a.href = SINK + 'boot-link?data=course-secret';
      boot.document.body.appendChild(a);
      a.click();
      step('boot-link clicked');
    }
    setTimeout(function () {
      step('self-navigation attempted');
      location.href = SINK + 'self?data=course-secret';
    }, 1000);
  }, 1500);
})();`;
  return `<!doctype html><html><head><title>nav egress probe</title></head><body><pre id="nav-probe">running</pre><script>${script}</script></body></html>`;
}

test('a course cannot navigate its own frame or the boot frame off the player origin (navigation egress)', async ({ page }) => {
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  await installReportCollector(page);
  const steps = async (): Promise<string[]> => (await reportsOf(page, 'nav-egress')).map((r) => `NAV-EGRESS ${String(r.payload)}`);
  const hits: string[] = [];
  await page.route(`${appOrigin}/__nav-egress-sink/**`, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(page, await packZip(NAV_PACK, '1.0.0', { 'story.html': navEgressStoryHtml(appOrigin) }), 'nav.zip', NAV_PACK, '1.0.0');
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: NAV_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');

  await expect.poll(async () => (await steps()).includes('NAV-EGRESS self-navigation attempted'), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(2000);
  // Non-vacuous: the course reached the boot frame and attempted both navigations.
  expectFromCourse(await reportsOf(page, 'nav-egress'), appOrigin);
  expect(await steps()).toEqual(expect.arrayContaining(['NAV-EGRESS boot-frame found', 'NAV-EGRESS boot-link clicked', 'NAV-EGRESS self-navigation attempted']));
  expect(hits, 'navigation egress from a player frame').toEqual([]);
  expect(new URL(page.url()).origin).toBe(appOrigin);
  // The control that refused them: the app shell's runtime frame policy for
  // the resolved player origin.
  await expect(page.locator('head meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', `frame-src ${playerOriginOf(appOrigin)}`);
});

/**
 * The child-iframe navigation course (PR 144 review R1.1): `frame-src` governs
 * which documents a frame may LOAD, and the app page's runtime frame-src only
 * covers frames the app embeds. A frame the COURSE creates has the course
 * document as its immediate embedder, so the course's own CSP `frame-src
 * 'self'` must refuse a navigation of that child to another origin. The course
 * creates a same-origin child (a relay-served pack document), waits for it to
 * load, then assigns `child.contentWindow.location.href` to the local sink.
 * Each step is announced on the console so the row is not vacuous. Loopback
 * sink only; nothing leaves the machine.
 *
 * Mutation note: the row pins the EFFECTIVE frame policy, not the spelling of
 * the directive. Deleting `frame-src 'self'` from the course CSP alone leaves
 * the row green because frame-src falls back to `default-src 'self'`; setting
 * it to `frame-src *` (in training-relay.ts and sw.js courseCsp) turns the row
 * red with one sink hit.
 */
function childNavStoryHtml(appOrigin: string): string {
  const script = `
(function () {
  ${coursePrelude(appOrigin)}
  function step(text) { console.log('CHILD-NAV ' + text); report('child-nav', text); }
  var SINK = appOrigin + '/__child-nav-sink/';
  var child = document.createElement('iframe');
  child.onload = function () {
    if (child.dataset.navigated) return;
    child.dataset.navigated = '1';
    step('child-loaded ' + child.contentWindow.location.pathname);
    setTimeout(function () {
      try {
        child.contentWindow.location.href = SINK + 'child?data=course-secret';
        step('navigation-attempted');
      } catch (e) {
        step('navigation-threw ' + ((e && e.name) || e));
      }
    }, 500);
  };
  child.src = '/training/${CHILD_NAV_PACK}/child.html';
  document.body.appendChild(child);
  step('child-created');
})();`;
  return `<!doctype html><html><head><title>child nav probe</title></head><body><pre id="child-nav-probe">running</pre><script>${script}</script></body></html>`;
}

test('a course cannot steer a child iframe it created off-origin (grandchild navigation egress)', async ({ page }) => {
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  await installReportCollector(page);
  const steps = async (): Promise<string[]> => (await reportsOf(page, 'child-nav')).map((r) => `CHILD-NAV ${String(r.payload)}`);
  const hits: string[] = [];
  await page.route(`${appOrigin}/__child-nav-sink/**`, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(
    page,
    await packZip(CHILD_NAV_PACK, '1.0.0', { 'story.html': childNavStoryHtml(appOrigin), 'child.html': '<!doctype html><title>child</title><p>same-origin child</p>' }),
    'child-nav.zip',
    CHILD_NAV_PACK,
    '1.0.0',
  );
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: CHILD_NAV_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');

  const attempted = (l: string): boolean => l === 'CHILD-NAV navigation-attempted' || l.startsWith('CHILD-NAV navigation-threw');
  await expect.poll(async () => (await steps()).some(attempted), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(2000);
  // Non-vacuous: the course created a same-origin child, it loaded the pack
  // document, and the course then attempted the off-origin navigation.
  expectFromCourse(await reportsOf(page, 'child-nav'), appOrigin);
  const logs = await steps();
  expect(logs).toEqual(expect.arrayContaining(['CHILD-NAV child-created', `CHILD-NAV child-loaded /training/${CHILD_NAV_PACK}/child.html`]));
  expect(logs.some((l) => l === 'CHILD-NAV navigation-attempted' || l.startsWith('CHILD-NAV navigation-threw'))).toBe(true);
  expect(hits, 'grandchild navigation egress from a course-created frame').toEqual([]);
  expect(new URL(page.url()).origin).toBe(appOrigin);
});

test('course content cannot run a same-origin app asset as an unconfined worker (review round 4 F1)', async ({ page, browserName }) => {
  // The course probe alone waits up to 90 s for its report; the default 30 s budget would cut it short.
  test.setTimeout(150_000);
  const assets = builtWorkerAssets();
  await page.goto('/');
  const appOrigin = new URL(page.url()).origin;
  await installReportCollector(page);
  const player = new URL(playerOriginOf(appOrigin));
  const hits: string[] = [];
  await page.route(`${appOrigin}/__worker-sink/**`, (route) => {
    hits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 204, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
  });
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await install(
    page,
    await packZip(WORKER_PACK, '1.0.0', { 'story.html': workerEscapeStoryHtml(appOrigin, assets), 'ok-worker.js': OK_WORKER_JS }),
    'worker.zip',
    WORKER_PACK,
    '1.0.0',
  );
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const option = page.getByTestId('training-pack-select').locator('option', { hasText: WORKER_PACK });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
  const r = await courseReport<{
    violations: string[];
    attempts: Record<string, string>;
    controls: Record<string, { state?: string; fetch?: string }>;
    register: Record<string, string>;
    swScript: number | string;
    ancestorOrigin: string | null;
  }>(page, 'worker-probe', appOrigin, 90_000);
  await expectFrameRecordMatches(page, browserName, '#worker-probe', r);
  expect(r.ancestorOrigin, 'fixture fidelity: embedder origin').toBe(appOrigin);
  test.info().annotations.push({ type: 'worker-probe', description: `${JSON.stringify(r)} sink hits: ${JSON.stringify(hits)}` });

  // Every same-origin script outside the open pack (except the course service
  // worker's own script, below) is refused by worker-src before it runs: a
  // violation per target, and none of them ever messages.
  for (const [label, target] of [
    ['appClassic', assets.classic],
    ['appModule', assets.module],
    ['bootScript', '/training-boot.js'],
    ['appShared', assets.shared],
  ] as const) {
    // Soft: every refused target is reported, not only the first.
    expect.soft(r.violations, `F1 ${label}: worker-src violation for ${target}`).toContain(`worker-src ${player.origin}${target}`);
    expect.soft(r.attempts[label], `F1 ${label}: a worker that runs`).not.toBe('running');
  }
  // The course service worker's script is admitted by the course worker-src
  // (Firefox starts a worker in a controlled document only if the document's
  // worker-src admits the controlling worker's script URL, PRR-151-030 R1), so
  // it is refused one step later: the course service worker answers its own
  // script URL 404, and a worker on it fails to start. No violation names it
  // (the policy admits it; the refusal is the worker's). Soft, so the pack
  // worker row below still reports when the admission regresses.
  expect.soft(r.swScript, 'F1 courseServiceWorker: the course service worker refuses its own script URL').toBe(404);
  expect.soft(r.attempts.courseServiceWorker, 'F1 courseServiceWorker: a worker on the course service worker script').toBe('error');
  expect.soft(r.violations.filter((v) => v.includes('/training/sw.js')), 'F1 courseServiceWorker: admitted by worker-src').toEqual([]);
  // Service workers: an app asset is refused by worker-src; a pack-path
  // script is fetched past the relay and gets the host's reserved 404.
  expect(r.register.appAsset ?? '').toMatch(/^rejected:/);
  expect(r.violations).toContain(`worker-src ${player.origin}${assets.classic}`);
  expect(r.register.packPath ?? '').toMatch(/^rejected:/);
  // Controls (non-vacuous): workers run, and stay confined by the course CSP
  // (a pack script carries it; a blob: worker inherits it).
  expect(r.controls.blobWorker).toEqual({ state: 'running', fetch: 'TypeError' });
  // The pack-script control is NOT refused by worker-src on either engine.
  expect(r.violations.filter((v) => v.includes(`/training/${WORKER_PACK}/`)), 'F1 pack worker refused by worker-src').toEqual([]);
  // Both engines: a worker on the pack's own script runs (Firefox too, since
  // the course worker-src admits the controlling service worker's script URL,
  // PRR-151-030 R1) and its fetch to the sink is refused by the course CSP.
  expect(r.controls.packWorker, 'F1 pack worker runs, confined').toEqual({ state: 'running', fetch: 'TypeError' });
  expect(hits, 'F1 worker egress').toEqual([]);
});

test('a click inside the course frame cannot open a popup or navigate the top page', async ({
  browserName,
  playwright,
  launchOptions,
  headless,
  baseURL,
  viewport,
}) => {
  test.setTimeout(150_000);
  // Own browser, Fission off (see NO_FISSION_ENV). Same loopback-only network rule
  // as the beforeEach hook, which only covers the fixture page.
  const browser = await playwright[browserName].launch({ ...launchOptions, headless, env: { ...process.env, ...launchOptions.env, ...NO_FISSION_ENV } });
  try {
    const context = await browser.newContext({ baseURL, viewport });
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      return host === '127.0.0.1' || host === 'localhost' ? route.fallback() : route.abort();
    });
    const page = await context.newPage();
    await page.goto('/');
    const appOrigin = new URL(page.url()).origin;
    // The app's isolation is unchanged by the process-model switch.
    expect(await page.evaluate(() => self.crossOriginIsolated), 'app page crossOriginIsolated').toBe(true);
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
    await install(page, await packZip(CLICK_PACK, '1.0.0', { 'story.html': clickStoryHtml(appOrigin) }), 'click.zip', CLICK_PACK, '1.0.0');
    await page.getByRole('button', { name: 'Training', exact: true }).click();
    const option = page.getByTestId('training-pack-select').locator('option', { hasText: CLICK_PACK });
    await expect(option).toHaveCount(1, { timeout: 30_000 });
    await page.getByTestId('training-pack-select').selectOption((await option.getAttribute('value')) ?? '');
    const course = page.frameLocator('iframe[data-testid="training-player-frame"]');
    await expect(course.locator('#escape-popup')).toBeVisible({ timeout: 60_000 });

    // Nothing in the app covers the course: the top page's hit test at the
    // button's centre lands on the course iframe, and no ancestor of the iframe
    // is inert, aria-hidden or pointer-events: none.
    const button = await course.locator('#escape-popup').boundingBox();
    if (button === null) throw new Error('course button has no box');
    const cover = await page.evaluate(([x, y]) => {
      const frame = document.querySelector('iframe[data-testid="training-player-frame"]');
      const blocked: string[] = [];
      for (let el = frame; el !== null; el = el.parentElement) {
        if (el.hasAttribute('inert')) blocked.push(`${el.nodeName} inert`);
        if (el.getAttribute('aria-hidden') === 'true') blocked.push(`${el.nodeName} aria-hidden`);
        if (getComputedStyle(el).pointerEvents === 'none') blocked.push(`${el.nodeName} pointer-events:none`);
      }
      return { hitIsFrame: frame !== null && document.elementFromPoint(x, y) === frame, blocked };
    }, [button.x + button.width / 2, button.y + button.height / 2] as const);
    expect(cover, 'nothing covers or disables the course frame').toEqual({ hitIsFrame: true, blocked: [] });

    // A real click grants the course frame transient activation, which would
    // let an unsandboxed cross-origin frame open a popup and navigate the top
    // page. The sandbox (no allow-popups, no allow-top-navigation[-by-user-
    // activation]) refuses both: no popup event, top URL unchanged (FC5).
    const popups: string[] = [];
    page.on('popup', (p) => popups.push(p.url()));
    context.on('page', (p) => popups.push(p.url()));
    const topBefore = page.url();
    await course.locator('#escape-popup').click();
    await expect(course.locator('#click-probe')).toContainText('"popup"', { timeout: 10_000 });
    await page.waitForTimeout(500);
    expect(popups, 'FC5 click-initiated popup').toEqual([]);
    await course.locator('#escape-top').click();
    await page.waitForTimeout(1000);
    expect(page.url(), 'FC5 click-initiated top navigation').toBe(topBefore);
    // The handler ran (a top navigation that went through would have removed the course).
    await expect(course.locator('#click-probe')).toContainText('"topNavigation"', { timeout: 10_000 });
    const clicked = JSON.parse((await course.locator('#click-probe').textContent()) ?? '{}') as Record<string, unknown>;
    // Each attempt really ran inside a trusted, user-activated click.
    expect(clicked.popupClick, 'FC5 popup click is trusted and user-activated').toEqual({ trusted: true, active: true });
    expect(clicked.topClick, 'FC5 top-navigation click is trusted and user-activated').toEqual({ trusted: true, active: true });
    expectNoPopupWindow(clicked.popup, browserName, 'FC5 click-initiated window.open');
    expect(typeof clicked.topNavigation, 'FC5 click-initiated top navigation recorded').toBe('string');
    expect(clicked.topNavigation, 'FC5 click-initiated top navigation throws').not.toBe('no-error');
  } finally {
    await browser.close();
  }
});
