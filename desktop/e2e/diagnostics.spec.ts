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
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { closeApp, closeAllApps, launchElectron, makeTempDir, makeUserDataDir, removeTempDir } from './launch-helpers.js';

let storeDir: string;
let storePath: string;
/** Temp Electron profile shared by the primary and the second-instance launch. */
let userDataDir: string;

test.beforeAll(() => {
  storeDir = makeTempDir('i248-diag-e2e-');
  storePath = path.join(storeDir, 'profiles', 'default', 'store.sqlite');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  userDataDir = makeUserDataDir(storeDir);
});

test.afterAll(async () => {
  await closeAllApps();
  removeTempDir(storeDir);
});

function mainLogPath(): string {
  return path.join(userDataDir, 'logs', 'main.log');
}

function readMainLog(): string {
  return fs.readFileSync(mainLogPath(), 'utf8');
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  return launchElectron({
    userDataDir,
    env: {
      ...process.env,
      ELECTRON_START_URL: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_ENGINE: 'stub',
      TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      TRAININGAPP_DESKTOP_STORE_PATH: storePath,
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
    const { app, page } = await launchApp();
    try {
      await expect
        .poll(() => (fs.existsSync(mainLogPath()) ? readMainLog() : ''), { timeout: 30_000 })
        .toContain('info [boot] main boot');
      // The renderer's startup entry arrives over IPC after getState()
      // resolves (the install module forwards it from the pre-gate buffer).
      await expect
        .poll(() => readMainLog(), { timeout: 30_000 })
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
    const { app, page } = await launchApp();
    try {
      await expect
        .poll(() => (fs.existsSync(mainLogPath()) ? readMainLog() : ''), { timeout: 30_000 })
        .toContain('main boot');
      await walkWizard(page);
      // A renderer debug line at the DEFAULT level is excluded everywhere.
      await page.evaluate(() => {
        console.debug('[e2e] renderer debug before toggle');
      });
      await page.waitForTimeout(1_200);
      expect(readMainLog()).not.toContain('renderer debug before toggle');

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
      // The sidecar persisted under the profile dir.
      const sidecar = path.join(path.dirname(storePath), 'diagnostics-settings.json');
      await expect
        .poll(() => (fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8') : ''), { timeout: 10_000 })
        .toContain('"enhancedLogging": true');

      // The renderer applied its own level from the same call: a debug line
      // now forwards and lands in the file — no restart anywhere.
      await page.evaluate(() => {
        console.debug('[e2e] renderer debug after toggle');
      });
      await expect
        .poll(() => readMainLog(), { timeout: 15_000 })
        .toContain('[e2e] renderer debug after toggle');
    } finally {
      await closeApp(app);
    }
  });

  test('a second-instance start does not append to the primary log', async ({ }, testInfo) => {
    testInfo.setTimeout(180_000);
    const { app } = await launchApp();
    try {
      await expect
        .poll(() => (fs.existsSync(mainLogPath()) ? readMainLog() : ''), { timeout: 30_000 })
        .toContain('main boot');
      // The serial suite shares this profile, so the boot count is asserted
      // RELATIVE to this test's own running app (the log persists across tests).
      const before = readMainLog();
      const bootsBefore = (before.match(/info \[boot\] main boot/g) ?? []).length;
      // A second app on the SAME profile: the single-instance lock refuses it
      // before its file sink ever activates (launch may even fail waiting for
      // a window — both outcomes are acceptable, the log is what matters).
      await launchElectron({ userDataDir, env: { ...process.env } }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const after = readMainLog();
      expect((after.match(/info \[boot\] main boot/g) ?? []).length).toBe(bootsBefore);
      expect(after.startsWith(before)).toBe(true);
    } finally {
      await closeApp(app);
    }
  });
});
