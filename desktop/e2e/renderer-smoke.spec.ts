/**
 * Playwright-under-Electron renderer smoke (issue #67, AC1).
 *
 * Full chain against the REAL Electron app + REAL in-process backend:
 *   ingest -> ask -> cited answer -> cancel -> app restart -> ask again,
 * with NO manual reload anywhere. The backend runs the deterministic stub
 * engine + hash embedder (modelless), so "cited answer" asserts sources
 * retrieved from the hash-embedded real upload, and the restart leg proves
 * the renderer re-discovers the backend's fresh random port + launch token
 * at every boot (both rotate per launch).
 *
 * The stub engine also exercises AC5's gate semantics: /status/models
 * reports engine 'stub', so the first-run gate must NOT block sending.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';

const DOC_TEXT = [
  'Training module 1: workplace safety overview.',
  'Always secure loose cables before operating the conveyor.',
  'Emergency stops are located at both ends of the line.',
].join('\n');

let storeDir: string;
let storePath: string;
const T0 = Date.now();
const t = (): string => `[smoke ${Math.round((Date.now() - T0) / 100) / 10}s]`;

test.beforeAll(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'issue67-e2e-store-'));
  storePath = path.join(storeDir, 'profiles', 'default', 'store.sqlite');
  mkdirSync(path.dirname(storePath), { recursive: true });
});

test.afterAll(() => {
  try {
    rmSync(storeDir, { recursive: true, force: true });
  } catch {
    /* windows tmp cleanup race is fine in teardown */
  }
});

/**
 * Teardown helper: prefer graceful close, but never let a wedged quit hang
 * the suite — on Windows the backend's keep-alive sockets can outlive quit.
 * The kill path is last-resort teardown after all assertions have passed.
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, 8_000)),
  ]);
  try {
    if (app.process().exitCode === null) {
      // Kill the WHOLE tree: surviving GPU/renderer children keep the
      // single-instance lock and block the relaunched instance.
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* process already gone */
  }
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ELECTRON_START_URL: 'http://127.0.0.1:4173',
      // Dev-origin widening (B2 config): the guard's CORS allowlist is
      // ['app://*'] by default; the vite preview origin must be allowed so
      // the dev renderer can pass the CORS preflight for cross-origin
      // fetches to the loopback backend. Token + loopback-host gates still
      // apply to every request. Mirrors the navigation lockdown, which
      // already allows the dev-start origin.
      TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_ENGINE: 'stub',
      TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      // Widen the stub's inter-token gap so Cancel lands mid-stream (the
      // default 1ms finishes a stub answer before a click can land).
      TRAININGAPP_STUB_TOKEN_DELAY_MS: '600',
      TRAININGAPP_DESKTOP_STORE_PATH: storePath,
    } as Record<string, string>,
  });
  app.process().stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (line.includes('[stop-debug]') || line.includes('[cors-debug]')) console.log(`[backend] ${line.trim().slice(0, 160)}`);
    }
  });
  app.process().stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (line.includes('[stop-debug]') || line.includes('[cors-debug]') || line.includes('[trainingapp-backend]')) {
        console.log(`[backend-err] ${line.trim().slice(0, 160)}`);
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

test.describe.serial('renderer smoke (AC1)', () => {
  test('ingest -> ask -> cited answer -> cancel -> restart -> ask again', async () => {
    // ---------- Launch #1 ----------
    console.log(`${t()} launch1`);
    const { app, page } = await launchApp();
    const input = page.getByLabel('Message input');
    await expect(input).toBeVisible({ timeout: 30_000 });

    // ---------- Ingest through the Documents page ----------
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Documents', exact: true }).click();
    // Give the freshly-mounted page a beat to settle its async load.
    await page.waitForTimeout(1_000);
    const upload = async (): Promise<void> => {
      await page.setInputFiles('input[type="file"]', {
        name: 'training-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(DOC_TEXT, 'utf8'),
      });
      await expect(page.getByText('training-notes.txt').first()).toBeVisible({ timeout: 15_000 });
      // The optimistic row appears immediately; wait until the row reaches
      // its terminal READY badge — that only renders after the server
      // returned 200, so the ingest has committed and the document is
      // retrievable before the ask proceeds. (A hidden-'Uploading...' check
      // is vacuous here: on a cold CI app React may not have flushed the
      // optimistic row yet, so the badge is absent before it ever exists.)
      await expect(page.getByText('Ready').first()).toBeVisible({ timeout: 30_000 });
    };
    try {
      await upload();
    } catch {
      // One retry: a boot-time race must not sink the whole AC1 chain.
      console.log(`${t()} upload retry`);
      await upload();
    }
    console.log(`${t()} ingest ok`);

    // ---------- Ask -> cited answer ----------
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Chat', exact: true })
      .click();
    // ChatPage remounts on navigation — re-query the fresh input.
    const chatInput = page.getByLabel('Message input');
    await chatInput.fill('What does the training document say about safety?');
    await chatInput.press('Enter');
    // The stub streams its fixed answer tokens; the cited source is the REAL
    // uploaded document retrieved through the hash-embedded store.
    await expect(page.getByText(/desktop stub answer/i).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('training-notes.txt').first()).toBeVisible({ timeout: 45_000 });
    console.log(`${t()} answer1 ok (cited)`);

    // ---------- Cancel a second ask mid-stream ----------
    await chatInput.fill('Second question to cancel.');
    await chatInput.press('Enter');
    const stop = page.getByLabel('Stop generation');
    await stop.click({ timeout: 15_000 });
    await expect(page.getByLabel('Send message')).toBeVisible({ timeout: 20_000 });
    console.log(`${t()} cancel ok`);

    // ---------- Restart: fresh port + token, no manual reload ----------
    await closeApp(app);
    console.log(`${t()} app closed; relaunching`);
    const second = await launchApp();
    const inputAfterRestart = second.page.getByLabel('Message input');
    await expect(inputAfterRestart).toBeVisible({ timeout: 30_000 });
    await inputAfterRestart.fill('Asking again after restart.');
    await inputAfterRestart.press('Enter');
    await expect(second.page.getByText(/desktop stub answer/i).first()).toBeVisible({ timeout: 45_000 });
    console.log(`${t()} answer after restart ok`);

    await closeApp(second.app);
  });
});
