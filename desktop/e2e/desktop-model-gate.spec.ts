/**
 * desktop-model-gate.spec.ts: the desktop model gate on the Electron shipping
 * surface (PR #151 review PRR-151-028, plus the PRR-151-018 residual and
 * PRR-151-017 precedence). Same Playwright-under-Electron harness as
 * renderer-smoke / first-run-wizard.
 *
 * Every other desktop spec runs the stub engine, and
 * `modelsAbsentForRealEngine` (web_ui/src/lib/desktop-session.tsx) never gates
 * the stub, so none of them renders DesktopModelBlockedOverlay. This spec boots
 * the REAL engine resolution (no TRAININGAPP_DESKTOP_ENGINE) against an EMPTY
 * model directory, so /status/models reports engine 'llama.cpp' with neither
 * profile present: the state an installed app without weights is in. The
 * llama engine loads lazily, so no weights and no native load are needed; the
 * embedder stays the deterministic hash fixture.
 *
 * First-run wizard: a non-stub engine opens it on a fresh profile
 * (desktop/main/index.ts `needed && engineName !== 'stub'`). The spec seeds a
 * COMPLETED first-run sidecar through the real store module, with no manifest
 * staged, so the drift check has nothing to compare and the wizard stays shut.
 *
 * Checked here:
 *  - the gate renders as a non-modal alertdialog, named, focused on open, with
 *    exactly its two actions (Open Settings; Use a local server or cloud model);
 *  - the covered chat content is `inert`: the composer cannot take focus even
 *    programmatically, and full forward AND backward Tab cycles never land in it;
 *  - Shift+Tab reaches the shell navigation; Tab cycles leave the gate (no trap)
 *    and wrap back to it;
 *  - Open Settings and "Use a local server or cloud model" navigate to Settings;
 *  - with "In this window" (browser-local) selected the browser readiness gate
 *    condition is live (the composer is disabled by it) and still only ONE gate,
 *    the desktop one, is shown.
 *
 * Document-end behaviour: with no browser chrome in an Electron window, a Tab
 * past the last element may leave focus where it is (as in Playwright's Firefox)
 * or park it on the document. pressKey stands in for the one wrap stop by
 * blurring, and ONLY when the press provably hit the document edge: focus did
 * not move, it sits on the first/last tabbable element, and the keydown was not
 * default-prevented (a page trap swallowing Tab is still caught).
 *
 * Side effect: the PRR-151-017 test switches the inference mode in this Electron
 * profile's localStorage; it switches back at the end, and the desktop seed
 * forces 'api' on every boot regardless.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { saveFirstRunState } from '../main/first-run/first-run-store.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATE_NAME = 'AI models are not installed yet';
const GATE_ACTIONS = ['Open Settings', 'Use a local server or cloud model'];
const NAV_ITEMS = ['Chat', 'Documents', 'Training', 'Settings'];

/** Repo-root discovery via the established contracts marker. */
function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);

const T0 = Date.now();
const t = (): string => `[model-gate ${Math.round((Date.now() - T0) / 100) / 10}s]`;

interface GateWorkspace {
  root: string;
  storePath: string;
  modelDir: string;
  packsRoot: string;
  manifestPath: string;
}

/** Temp profile: completed first-run sidecar, EMPTY model dir, no manifest. */
function makeWorkspace(): GateWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prr151-028-model-gate-'));
  const storePath = path.join(root, 'store', 'profiles', 'default', 'store.sqlite');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const modelDir = path.join(root, 'models-empty');
  fs.mkdirSync(modelDir, { recursive: true });
  const packsRoot = path.join(root, 'packs-root');
  fs.mkdirSync(packsRoot, { recursive: true });
  // Deliberately never created: the wizard's manifest resolves to "not staged".
  const manifestPath = path.join(root, 'no-manifest', 'manifest.json');
  saveFirstRunState(storePath, {
    firstRun: {
      completed: true,
      selectedProfile: 'fast',
      completedAt: new Date().toISOString(),
      acknowledgedLicenses: true,
      manifestDigests: {},
    },
  });
  return { root, storePath, modelDir, packsRoot, manifestPath };
}

async function launchApp(ws: GateWorkspace): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // The real engine resolution: an inherited stub/force/model-dir seam would
  // silently turn this into the stub path (no gate) or point at real weights.
  for (const key of ['TRAININGAPP_DESKTOP_ENGINE', 'TRAININGAPP_FIRST_RUN_FORCE', 'TRAININGAPP_INFERENCE_MODEL_DIR']) {
    delete env[key];
  }
  Object.assign(env, {
    ELECTRON_START_URL: 'http://127.0.0.1:4173',
    TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
    TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
    TRAININGAPP_DESKTOP_STORE_PATH: ws.storePath,
    TRAININGAPP_DESKTOP_PACKS_DIR: ws.packsRoot,
    TRAININGAPP_DESKTOP_MANIFEST: ws.manifestPath,
    TRAININGAPP_INFERENCE_MODEL_DIR: ws.modelDir,
  });
  const app = await _electron.launch({ args: ['.'], cwd: path.join(REPO_ROOT, 'desktop'), env });
  app.process().stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (line.includes('[trainingapp-desktop]') || line.includes('[trainingapp-backend]')) {
        console.log(`${t()} [main] ${line.trim().slice(0, 200)}`);
      }
    }
  });
  const page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`${t()} [renderer-error] ${msg.text().slice(0, 240)}`);
  });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Prefer graceful close; never let a wedged quit hang the suite (same
 *  teardown as renderer-smoke / first-run-wizard). */
async function closeApp(app: ElectronApplication): Promise<void> {
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  try {
    if (app.process().exitCode === null) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* already gone */
  }
}

interface Focused {
  label: string;
  inContent: boolean;
  inGate: boolean;
  inShellNav: boolean;
}

/** What has focus (null for the document/body), and where it is. */
const focused = (page: Page): Promise<Focused | null> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    return {
      label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      inContent: el.closest('.chat-page__content') !== null,
      inGate: el.closest('[role="alertdialog"]') !== null,
      inShellNav: el.closest('.ui-shell__sidebar, .ui-shell__topbar') !== null,
    };
  });

interface TabProbeWindow {
  /** Keyboard-reachable elements (outside inert subtrees), in document order. */
  __tabbables(): HTMLElement[];
  /** The last Tab keydown seen by a window capture listener. */
  __lastTab?: KeyboardEvent;
  __tabProbe?: true;
}

/** Installed after boot (the page is already loaded when firstWindow resolves).
 *  A window CAPTURE listener runs before every app listener whatever the
 *  registration order, so it sees each Tab keydown before anything can stop it. */
async function installTabProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as TabProbeWindow;
    if (w.__tabProbe) return;
    w.__tabProbe = true;
    w.__tabbables = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')
      ).filter(
        (el) =>
          el.closest('[inert]') === null &&
          el.tabIndex >= 0 &&
          !(el as HTMLButtonElement).disabled &&
          el.getClientRects().length > 0
      );
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Tab') w.__lastTab = event;
      },
      true
    );
  });
}

const tabbableCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as TabProbeWindow).__tabbables().length);

/**
 * Press Tab or Shift+Tab once. When the press provably hit the document edge
 * (focus unchanged, on the last tabbable for Tab / the first for Shift+Tab, keydown
 * not default-prevented), blur so the next press re-enters the document at the
 * other end, as a browser with chrome does. Returns true when it did so.
 */
async function pressKey(page: Page, key: 'Tab' | 'Shift+Tab'): Promise<boolean> {
  const before = await page.evaluateHandle(() => document.activeElement);
  await page.evaluate(() => {
    delete (window as unknown as TabProbeWindow).__lastTab;
  });
  await page.keyboard.press(key);
  const atEdge = await page.evaluate(
    ({ prev, backward }) => {
      const w = window as unknown as TabProbeWindow;
      const el = document.activeElement;
      const list = w.__tabbables();
      const edge = backward ? list[0] : list[list.length - 1];
      return (
        el === prev &&
        el !== null &&
        el !== document.body &&
        list.length > 0 &&
        edge === el &&
        w.__lastTab !== undefined &&
        !w.__lastTab.defaultPrevented
      );
    },
    { prev: before, backward: key === 'Shift+Tab' }
  );
  await before.dispose();
  if (atEdge) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return atEdge;
}

/**
 * Walk a full keyboard cycle from `startLabel` (bounded by the page's own tabbable
 * count + 2: one possible document stop per wrap). Fails the moment any press
 * lands in the covered chat content; returns what was visited.
 */
async function cycle(page: Page, key: 'Tab' | 'Shift+Tab', startLabel: string): Promise<Array<Focused | null>> {
  const gate = page.getByRole('alertdialog', { name: GATE_NAME });
  await gate.getByRole('button', { name: startLabel, exact: true }).focus();
  const bound = (await tabbableCount(page)) + 2;
  const seen: Array<Focused | null> = [];
  let edgeStops = 0;
  for (let i = 0; i < bound; i += 1) {
    if (await pressKey(page, key)) edgeStops += 1;
    const where = await focused(page);
    seen.push(where);
    expect(where?.inContent ?? false, `${key} #${i + 1} landed in the covered chat content: ${JSON.stringify(where)}`).toBe(false);
  }
  console.log(`${t()} ${key} cycle (${bound} presses, ${edgeStops} document-edge stand-ins): ${JSON.stringify(seen.map((w) => w?.label ?? '<body>'))}`);
  return seen;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

/** The chat-page tests start here: the gate is up (the first boot can take a while)
 *  and the Tab probe is installed, so any single test also runs on its own (-g). */
async function gateReady(page: Page): Promise<void> {
  await expect(page.getByRole('alertdialog', { name: GATE_NAME })).toBeVisible({ timeout: 60_000 });
  await installTabProbe(page);
}

async function goToChat(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: GATE_NAME })).toBeVisible();
}

let workspace: GateWorkspace;
let app: ElectronApplication;
let page: Page;

test.describe.serial('desktop model gate on Electron (PRR-151-028 / 018 / 017)', () => {
  test.beforeAll(async () => {
    workspace = makeWorkspace();
    ({ app, page } = await launchApp(workspace));
  });

  test.afterAll(async () => {
    if (app !== undefined) await closeApp(app);
    try {
      fs.rmSync(workspace.root, { recursive: true, force: true });
    } catch {
      /* windows tmp cleanup race is fine in teardown */
    }
  });

  test('the desktop gate renders: named non-modal alertdialog with its two actions, focused, chat content inert', async () => {
    await gateReady(page);
    const gate = page.getByRole('alertdialog', { name: GATE_NAME });
    // Exactly one dialog on the page: no wizard (seeded completion) and no second gate.
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('first-run-wizard')).toHaveCount(0);
    // Non-modal: the shell stays usable, so aria-modal must not be claimed.
    expect(await gate.getAttribute('aria-modal')).toBeNull();
    await expect(gate).toContainText('Neither the Quality nor the Fast language model was found');
    // initialFocus="panel": focus is on the dialog itself so AT reads title + body first.
    await expect(gate).toBeFocused();
    // Exactly the two actions (the desktop gate has no Retry; Retry is the browser gate's).
    const actions = (await gate.getByRole('button').allInnerTexts()).map((s) => s.trim());
    expect(actions).toEqual(GATE_ACTIONS);

    // The covered chat content exists, holds the composer, and is inert.
    const content = page.locator('.chat-page__content');
    await expect(content).toHaveCount(1);
    await expect(content).toHaveAttribute('inert', '');
    const composer = content.getByLabel('Message input');
    await expect(composer).toHaveCount(1);
    // api mode: the composer itself is NOT disabled (the desktop gate does not
    // disable it), so inert is the only thing keeping it out of reach.
    await expect(composer).toBeEnabled();
    // Native inert: even a programmatic focus() is refused.
    const tookFocus = await composer.evaluate((el) => {
      (el as HTMLElement).focus();
      return document.activeElement === el;
    });
    expect(tookFocus, 'the composer under the gate accepted focus').toBe(false);
    expect(await composer.evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
  });

  test('Shift+Tab from the gate lands in the shell navigation', async () => {
    await gateReady(page);
    const gate = page.getByRole('alertdialog', { name: GATE_NAME });
    for (const start of ['panel', GATE_ACTIONS[0]]) {
      if (start === 'panel') await gate.focus();
      else await gate.getByRole('button', { name: start, exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      const where = await focused(page);
      // Positive: ON a shell control, not merely "not in the gate" (the body would satisfy that).
      expect(where, `Shift+Tab from ${start} left focus on the document body`).not.toBeNull();
      expect(where?.inShellNav, `Shift+Tab from ${start} landed on ${JSON.stringify(where)}`).toBe(true);
      expect(where?.inGate).toBe(false);
      expect(where?.inContent).toBe(false);
    }
  });

  test('full Tab and Shift+Tab cycles leave the gate, reach the shell nav, wrap back, never enter the chat content', async () => {
    await gateReady(page);
    const forward = await cycle(page, 'Tab', GATE_ACTIONS[1]);
    const fwdSeq = JSON.stringify(forward.map((w) => w?.label ?? '<body>'));
    // Tab from the LAST gate action leaves the gate (a trap would wrap to its first action).
    expect(forward[0]?.inGate ?? false, `Tab from the last gate action stayed in the gate: ${fwdSeq}`).toBe(false);
    const fwdLabels = forward.map((w) => w?.label);
    for (const target of NAV_ITEMS) {
      expect(fwdLabels, `the Tab cycle never reached the "${target}" nav item: ${fwdSeq}`).toContain(target);
    }
    expect(fwdLabels, `the Tab cycle never wrapped back to the gate: ${fwdSeq}`).toContain(GATE_ACTIONS[0]);

    const backward = await cycle(page, 'Shift+Tab', GATE_ACTIONS[0]);
    const bwdSeq = JSON.stringify(backward.map((w) => w?.label ?? '<body>'));
    expect(backward[0]?.inGate ?? false, `Shift+Tab from the first gate action stayed in the gate: ${bwdSeq}`).toBe(false);
    const bwdLabels = backward.map((w) => w?.label);
    for (const target of NAV_ITEMS) {
      expect(bwdLabels, `the Shift+Tab cycle never reached the "${target}" nav item: ${bwdSeq}`).toContain(target);
    }
    expect(bwdLabels, `the Shift+Tab cycle never wrapped back to the gate: ${bwdSeq}`).toContain(GATE_ACTIONS[1]);
  });

  test('Open Settings navigates to Settings; the gate goes with the chat page', async () => {
    await gateReady(page);
    const gate = page.getByRole('alertdialog', { name: GATE_NAME });
    await gate.getByRole('button', { name: 'Open Settings', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await goToChat(page);
    await gate.getByRole('button', { name: 'Use a local server or cloud model', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.locator('#model-connection')).toBeInViewport();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('with "In this window" selected, the browser gate condition is live and still only the desktop gate shows', async () => {
    // Starts wherever the previous test left off (Settings); goToChat waits for the gate.
    // The chat header's mode toggle is inert under the gate: switch through Settings,
    // the path a user actually has.
    await nav(page).getByRole('button', { name: 'Settings', exact: true }).click();
    const inWindow = page.getByRole('radio', { name: 'In this window' });
    await inWindow.check();
    await expect(inWindow).toBeChecked();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('inference-mode') ?? '{}').mode as unknown);
    expect(stored).toBe('browser-local');

    await goToChat(page);
    const content = page.locator('.chat-page__content');
    // Positive: the browser readiness gate condition (isModelBlocked) is TRUE here:
    // it disables the composer, which the desktop gate alone never does.
    await expect(content.getByLabel('Message input')).toBeDisabled();
    // PRR-151-017: exactly ONE gate, and it is the desktop one.
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await expect(page.getByRole('alertdialog', { name: GATE_NAME })).toBeVisible();
    await expect(page.getByRole('alertdialog', { name: 'Model not ready' })).toHaveCount(0);
    await expect(content).toHaveAttribute('inert', '');

    // Restore the profile's mode (the desktop seed would on the next boot anyway).
    await nav(page).getByRole('button', { name: 'Settings', exact: true }).click();
    const backend = page.getByRole('radio', { name: 'Desktop backend' });
    await backend.check();
    await expect(backend).toBeChecked();
  });
});
