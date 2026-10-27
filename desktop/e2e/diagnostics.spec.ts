/**
 * Diagnostics logging e2e (issue #248) — the REAL Electron app (dev-mode
 * renderer via vite preview, in-process stub backend, hermetic profile):
 *
 *   1. after launch, <userData>/logs/main.log exists and contains BOTH the
 *      main boot entry AND a forwarded renderer startup entry (AC1);
 *   2. the Enhanced logging toggle syncs the level main<->renderer without a
 *      restart — a renderer debug console line is excluded at the default
 *      level and lands in the file after the toggle (AC2);
 *   3. a second-instance launch never appends to the primary's log (its file
 *      sink never activates).
 *
 * Hermetic per-leg workspaces (review PRR-023, pr255): every leg owns its OWN
 * temp workspace — store, profile and userDataDir — so the legs cannot race
 * on the single-instance lock (the key lives in userData) or leak sidecar
 * state into each other. Only leg 3's second-instance launch deliberately
 * reuses that leg's OWN userDataDir, which is the containment under test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { closeApp, closeAllApps, launchElectron, makeTempDir, makeUserDataDir, removeTempDir } from './launch-helpers.js';

/** One hermetic leg workspace: isolated store + Electron profile. */
interface LegWorkspace {
  root: string;
  storePath: string;
  userDataDir: string;
}

const workspaces: LegWorkspace[] = [];

/** A fresh store+profile workspace for one serial leg (removed in afterAll). */
function makeLegWorkspace(leg: string): LegWorkspace {
  const root = makeTempDir(`i248-diag-e2e-${leg}-`);
  const storePath = path.join(root, 'profiles', 'default', 'store.sqlite');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // makeUserDataDir's fixed name is unique per workspace ROOT, so each leg
  // gets its own profile directory (PRR-023).
  const userDataDir = makeUserDataDir(root);
  const ws = { root, storePath, userDataDir };
  workspaces.push(ws);
  return ws;
}

test.afterAll(async () => {
  await closeAllApps();
  for (const ws of workspaces) {
    removeTempDir(ws.root);
  }
});

function mainLogPath(userDataDir: string): string {
  return path.join(userDataDir, 'logs', 'main.log');
}

function readMainLog(userDataDir: string): string {
  return fs.readFileSync(mainLogPath(userDataDir), 'utf8');
}

/** Physical log entries (non-empty lines), the append-blind-safe count unit. */
function logEntryCount(userDataDir: string): number {
  if (!fs.existsSync(mainLogPath(userDataDir))) return 0;
  return readMainLog(userDataDir).split('\n').filter((line) => line !== '').length;
}

/**
 * Poll until the log has settled: two consecutive reads (>=1s apart) carry
 * the SAME content. Resolves with the settled content, so a caller can hold
 * the exact pre-condition bytes and require them to survive unchanged — an
 * append by ANYONE (the second instance under test, a straggler flush) then
 * fails the assertion instead of hiding behind a prefix/substring match
 * (review PRR-023: the old startsWith + boot-count assertions were both
 * satisfied by a plain append).
 */
async function settledLog(userDataDir: string, timeoutMs = 20_000): Promise<string> {
  let previous = '';
  let stable = false;
  await expect
    .poll(
      async () => {
        const now = fs.existsSync(mainLogPath(userDataDir)) ? readMainLog(userDataDir) : '';
        stable = now === previous && now !== '';
        previous = now;
        return stable;
      },
      { timeout: timeoutMs, intervals: [1_000, 1_000] },
    )
    .toBe(true);
  return previous;
}

async function launchApp(ws: LegWorkspace): Promise<{ app: ElectronApplication; page: Page }> {
  return launchElectron({
    userDataDir: ws.userDataDir,
    env: {
      ...process.env,
      ELECTRON_START_URL: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_ENGINE: 'stub',
      TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      TRAININGAPP_DESKTOP_STORE_PATH: ws.storePath,
    },
  });
}

/** Dismiss the first-run wizard if it overlays a fresh profile. */
async function walkWizard(page: Page): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const next = page.getByTestId('wizard-next');
    if ((await next.count()) && (await next.first().isVisible().catch(() => false))) {
      await next.first().click();
      await page.waitForTimeout(350);
      continue;
    }
    const activate = page.getByTestId('activate-packs-button');
    if ((await activate.count()) && (await activate.first().isVisible().catch(() => false))) {
      await activate.first().click();
      await page.waitForTimeout(1_200);
      continue;
    }
    const complete = page.getByTestId('wizard-complete');
    if ((await complete.count()) && (await complete.first().isVisible().catch(() => false))) {
      await complete.first().click();
      await page.waitForTimeout(700);
      continue;
    }
    const finish = page.getByTestId('wizard-finish');
    if ((await finish.count()) && (await finish.first().isVisible().catch(() => false))) {
      await finish.first().click();
      await page.waitForTimeout(500);
      continue;
    }
    return;
  }
}

test.describe.serial('diagnostics logging (issue #248)', () => {
  test('after launch the log file holds the main boot entry and the forwarded renderer startup entry', async ({ }, testInfo) => {
    testInfo.setTimeout(150_000);
    const ws = makeLegWorkspace('leg1');
    const { app, page } = await launchApp(ws);
    try {
      await expect
        .poll(() => (fs.existsSync(mainLogPath(ws.userDataDir)) ? readMainLog(ws.userDataDir) : ''), { timeout: 30_000 })
        .toContain('info [boot] main boot');
      // The renderer's startup entry arrives over IPC after getState()
      // resolves (the install module forwards it from the pre-gate buffer).
      await expect
        .poll(() => readMainLog(ws.userDataDir), { timeout: 30_000 })
        .toContain('renderer startup');
      // Non-vacuous: the same page is live and its bridge answers.
      const state = await page.evaluate(() =>
        (window as unknown as { desktopApi?: { diagnostics?: { getState?: () => Promise<{ active: boolean; enhanced: boolean }> } } })
          .desktopApi?.diagnostics?.getState?.(),
      );
      expect(state).toMatchObject({ active: true });
    } finally {
      await closeApp(app);
    }
  });

  test('the Enhanced logging toggle syncs the level main<->renderer without a restart', async ({ }, testInfo) => {
    testInfo.setTimeout(180_000);
    const ws = makeLegWorkspace('leg2');
    const { app, page } = await launchApp(ws);
    try {
      await expect
        .poll(() => (fs.existsSync(mainLogPath(ws.userDataDir)) ? readMainLog(ws.userDataDir) : ''), { timeout: 30_000 })
        .toContain('main boot');
      await walkWizard(page);
      // A renderer debug line at the DEFAULT level is excluded everywhere.
      await page.evaluate(() => {
        console.debug('[e2e] renderer debug before toggle');
      });
      await page.waitForTimeout(1_200);
      expect(readMainLog(ws.userDataDir)).not.toContain('renderer debug before toggle');

      // The real Settings UI toggle (Storage & privacy).
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
      const toggle = page.getByTestId('diagnostics-enhanced-toggle');
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await toggle.click();

      // Main applied + persisted: getState reflects the new level.
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (window as unknown as { desktopApi?: { diagnostics?: { getState?: () => Promise<{ active: boolean; enhanced: boolean }> } } })
                .desktopApi?.diagnostics?.getState?.(),
            ),
          { timeout: 15_000 },
        )
        .toMatchObject({ enhanced: true });
      // The sidecar persisted under this leg's profile dir.
      const sidecar = path.join(path.dirname(ws.storePath), 'diagnostics-settings.json');
      await expect
        .poll(() => (fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8') : ''), { timeout: 10_000 })
        .toContain('"enhancedLogging": true');

      // The renderer applied its own level from the same call: a debug line
      // now forwards and lands in the file — no restart anywhere.
      await page.evaluate(() => {
        console.debug('[e2e] renderer debug after toggle');
      });
      await expect
        .poll(() => readMainLog(ws.userDataDir), { timeout: 15_000 })
        .toContain('[e2e] renderer debug after toggle');
    } finally {
      await closeApp(app);
    }
  });

  test('a second-instance start does not append to the primary log', async ({ }, testInfo) => {
    testInfo.setTimeout(180_000);
    const ws = makeLegWorkspace('leg3');
    const { app } = await launchApp(ws);
    try {
      await expect
        .poll(() => (fs.existsSync(mainLogPath(ws.userDataDir)) ? readMainLog(ws.userDataDir) : ''), { timeout: 30_000 })
        .toContain('main boot');
      // Snapshot the log only once it has SETTLED (the renderer startup entry
      // arrives asynchronously) — otherwise the primary's own late entry
      // would be indistinguishable from a second-instance append.
      const before = await settledLog(ws.userDataDir);
      const entriesBefore = logEntryCount(ws.userDataDir);
      // A second app on the SAME profile: the single-instance lock refuses it
      // before its file sink ever activates (launch may even fail waiting for
      // a window — both outcomes are acceptable, the log is what matters).
      const second = await launchElectron({ userDataDir: ws.userDataDir, env: { ...process.env } }).catch(() => null);
      // The refused instance quits on its own; if the launch resolved anyway
      // (window appeared), close it so no instance outlives the assertion.
      if (second !== null) await closeApp(second.app);
      // PRR-024 (pr255): poll for the log to settle again instead of a fixed
      // 4s sleep, then require the EXACT pre-launch bytes — byte equality
      // subsumes the old boot-count and startsWith checks and dies on ANY
      // append (a second-instance boot line, a quit-flush, anything).
      const after = await settledLog(ws.userDataDir);
      expect(logEntryCount(ws.userDataDir), 'no entry may be appended by the refused second instance').toBe(entriesBefore);
      expect(after, 'the primary log must be byte-identical across the second-instance launch').toBe(before);
    } finally {
      await closeApp(app);
    }
  });
});
