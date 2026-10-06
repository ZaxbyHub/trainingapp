/**
 * frame-input.repro.ts — minimal, app-free repro (lane I, PRR-151-030 follow-up):
 * does Playwright deliver mouse and keyboard input into a cross-origin iframe of a
 * cross-origin-isolated (COOP same-origin + COEP require-corp) page, per engine?
 *
 * NOT part of the e2e suite: the default config only matches *.spec.ts. Run it with
 * a config whose testMatch picks it up, e.g. (from web_ui/):
 *
 *   npx playwright test --config e2e/frame-input/repro.config.ts
 *
 * The spec starts its own tiny HTTP server (no app code). Origins: the page on
 * http://127.0.0.1:<port>, the "cross-origin" child on http://localhost:<port>
 * (the same loopback trick the app uses for its player origin). Port: REPRO_PORT,
 * default 4405.
 *
 * Each variant mounts one iframe whose document reports every pointer/mouse/key/
 * input event it sees to the parent with postMessage (so nothing needs Playwright
 * to attach to the frame), then the test drives it with:
 *   1. page.mouse.click at the child's button (coordinates from the iframe box plus
 *      the rect the child reported),
 *   2. page.mouse.click on the child's text input, then page.keyboard.type('ab'),
 *   3. page.frameLocator(...).locator('#b').click() (Playwright's frame route).
 * It records, per variant: whether the top page is crossOriginIsolated, the frame
 * URLs Playwright sees (page.frames()), document.elementFromPoint at the click point,
 * the events that arrived, and the frameLocator outcome. Results are printed as
 * `FRAME-INPUT <json>` lines and attached to the test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.REPRO_PORT ?? 4405);
const TOP = `http://127.0.0.1:${PORT}`;
const CROSS = `http://localhost:${PORT}`;
const SANDBOX = 'allow-scripts allow-same-origin allow-forms';

interface Variant {
  name: string;
  /** top page headers */
  coop: boolean;
  coep: boolean;
  /** child origin */
  child: 'same' | 'cross';
  sandbox: boolean;
}

export const VARIANTS: Variant[] = [
  { name: 'plain/cross', coop: false, coep: false, child: 'cross', sandbox: false },
  { name: 'plain/cross/sandbox', coop: false, coep: false, child: 'cross', sandbox: true },
  { name: 'coop-only/cross', coop: true, coep: false, child: 'cross', sandbox: false },
  { name: 'coep-only/cross', coop: false, coep: true, child: 'cross', sandbox: false },
  { name: 'coi/same', coop: true, coep: true, child: 'same', sandbox: false },
  { name: 'coi/cross', coop: true, coep: true, child: 'cross', sandbox: false },
  { name: 'coi/cross/sandbox', coop: true, coep: true, child: 'cross', sandbox: true },
];

const CHILD_HTML = `<!doctype html><html><head><title>child</title><style>
body{margin:0;font:16px sans-serif}#b{position:absolute;left:20px;top:20px;width:160px;height:60px}#t{position:absolute;left:20px;top:120px;width:160px;height:30px}
</style></head><body><button id="b">button</button><input id="t" aria-label="text"><script>
(function () {
  function post(msg) { msg.repro = true; window.parent.postMessage(msg, '*'); }
  ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'input', 'focus'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var ua = navigator.userActivation;
      post({ type: type, trusted: e.isTrusted, target: (e.target && e.target.id) || String(e.target && e.target.nodeName), active: ua ? ua.isActive : null, value: type === 'input' ? document.getElementById('t').value : undefined });
    }, true);
  });
  function rect(id) { var r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
  post({ type: 'ready', origin: location.origin, coi: self.crossOriginIsolated, button: rect('b'), input: rect('t') });
})();
</script></body></html>`;

function topHtml(v: Variant): string {
  const origin = v.child === 'cross' ? CROSS : TOP;
  const childUrl = `${origin}/child?coep=${v.coep ? 1 : 0}`;
  const sandbox = v.sandbox ? ` sandbox="${SANDBOX}"` : '';
  return `<!doctype html><html><head><title>top</title></head><body style="margin:0">
<iframe id="f" src="${childUrl}"${sandbox} style="position:absolute;left:50px;top:50px;width:400px;height:300px;border:0"></iframe>
<script>
window.__events = [];
window.addEventListener('message', function (e) { if (e.data && e.data.repro) window.__events.push(Object.assign({ from: e.origin }, e.data)); });
</script></body></html>`;
}

let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', TOP);
    const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (url.pathname === '/top') {
      const v = VARIANTS.find((x) => x.name === url.searchParams.get('v'));
      if (!v) { res.writeHead(404); res.end(); return; }
      if (v.coop) headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      if (v.coep) headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      res.writeHead(200, headers);
      res.end(topHtml(v));
      return;
    }
    if (url.pathname === '/child') {
      // A COEP parent may only embed a document that opts in with COEP itself and,
      // when cross-origin, CORP cross-origin.
      if (url.searchParams.get('coep') === '1') headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
      res.writeHead(200, headers);
      res.end(CHILD_HTML);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
  expect((server.address() as AddressInfo).port).toBe(PORT);
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ReproEvent { type: string; trusted?: boolean; target?: string; active?: boolean | null; value?: string; from: string; button?: { x: number; y: number; w: number; h: number }; input?: { x: number; y: number; w: number; h: number }; coi?: boolean }

async function events(page: Page): Promise<ReproEvent[]> {
  return page.evaluate(() => (window as unknown as { __events: ReproEvent[] }).__events.slice());
}

export interface VariantResult {
  variant: string;
  topCrossOriginIsolated: boolean;
  childCrossOriginIsolated: boolean | undefined;
  framesSeen: string[];
  elementFromPoint: string;
  mouse: string[];
  keyboard: string[];
  typedValue: string | undefined;
  frameLocatorClick: string;
}

async function runVariant(page: Page, v: Variant): Promise<VariantResult> {
  await page.goto(`${TOP}/top?v=${encodeURIComponent(v.name)}`);
  await expect.poll(async () => (await events(page)).filter((e) => e.type === 'ready').length, { timeout: 15_000, message: `${v.name}: child ready report` }).toBe(1);
  const ready = (await events(page)).find((e) => e.type === 'ready') as ReproEvent;
  const box = await page.locator('#f').boundingBox();
  if (box === null || !ready.button || !ready.input) throw new Error('no geometry');
  const bx = box.x + ready.button.x + ready.button.w / 2;
  const by = box.y + ready.button.y + ready.button.h / 2;
  const elementFromPoint = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.nodeName}${el.id ? '#' + el.id : ''}` : 'null';
  }, [bx, by] as const);
  const topCrossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated);
  const framesSeen = page.frames().map((f) => f.url());

  const before = (await events(page)).length;
  await page.mouse.click(bx, by);
  await page.waitForTimeout(500);
  const afterMouse = await events(page);
  const mouse = afterMouse.slice(before).map((e) => `${e.type}:${e.target}:trusted=${e.trusted}:active=${e.active}`);

  const ix = box.x + ready.input.x + ready.input.w / 2;
  const iy = box.y + ready.input.y + ready.input.h / 2;
  await page.mouse.click(ix, iy);
  await page.keyboard.type('ab');
  await page.waitForTimeout(500);
  const afterKeys = await events(page);
  const keyEvents = afterKeys.slice(afterMouse.length);
  const keyboard = keyEvents.filter((e) => e.type === 'keydown' || e.type === 'input').map((e) => `${e.type}:${e.target}:trusted=${e.trusted}`);
  const typedValue = [...keyEvents].reverse().find((e) => e.type === 'input')?.value;

  let frameLocatorClick: string;
  const beforeFl = (await events(page)).length;
  try {
    await page.frameLocator('#f').locator('#b').click({ timeout: 5_000 });
    await page.waitForTimeout(300);
    const got = (await events(page)).slice(beforeFl).filter((e) => e.type === 'click').length;
    frameLocatorClick = `resolved; click events delivered=${got}`;
  } catch (e) {
    frameLocatorClick = `threw: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`;
  }

  return { variant: v.name, topCrossOriginIsolated, childCrossOriginIsolated: ready.coi, framesSeen, elementFromPoint, mouse, keyboard, typedValue, frameLocatorClick };
}

/**
 * What each harness project delivers (measured 2026-10-06, Playwright 1.63, bundled
 * Firefox 155, stock Firefox 157). A cross-SITE iframe that Firefox puts in its own
 * content process (Fission) receives no injected input; MOZ_FORCE_DISABLE_FISSION
 * keeps it in-process and input arrives. Bundled (Juggler) Firefox ships
 * fission.webContentIsolationStrategy=0, which keeps ordinary cross-site iframes
 * in-process, but a cross-origin-isolated page still isolates them. Stock Firefox
 * isolates every cross-site iframe, so over BiDi every cross-origin variant fails.
 */
function expectDelivered(project: string, v: Variant): boolean {
  switch (project) {
    case 'firefox':
      return !(v.coop && v.coep && v.child === 'cross');
    case 'moz-firefox':
      return v.child === 'same';
    default: // chromium, firefox-no-fission, moz-firefox-no-fission
      return true;
  }
}

for (const v of VARIANTS) {
  test(`frame input: ${v.name}`, async ({ page, browserName }, info) => {
    const result = await runVariant(page, v);
    console.log(`FRAME-INPUT ${info.project.name} ${JSON.stringify(result)}`);
    await info.attach(`frame-input-${v.name.replace(/\//g, '_')}.json`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    // The geometry is honest on every engine: the top page's hit test lands on the iframe.
    expect(result.elementFromPoint).toBe('IFRAME#f');
    const clicked = result.mouse.some((e) => e.startsWith('click:b:trusted=true'));
    const pointer = result.mouse.filter((e) => /^(pointerdown|mousedown|mouseup|click):/.test(e));
    if (expectDelivered(info.project.name, v)) {
      expect(clicked, `${browserName}: trusted click reaches the frame`).toBe(true);
      expect(result.typedValue, `${browserName}: typed text reaches the frame`).toBe('ab');
    } else {
      expect(pointer, `${browserName}: no pointer event reaches the out-of-process frame`).toEqual([]);
      expect(result.keyboard, `${browserName}: no key event reaches the out-of-process frame`).toEqual([]);
    }
  });
}
