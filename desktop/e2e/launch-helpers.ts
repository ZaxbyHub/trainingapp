/**
 * Shared Electron launch and teardown for the Playwright-under-Electron specs
 * (critic-final-2 D2 and the launchApp cleanup LOW).
 *
 * Hermetic profile: every launch runs on a TEMP Electron profile passed as
 * --user-data-dir, never the developer's real one a plain `electron .` uses.
 * userData holds the renderer's localStorage/IndexedDB and is the key of the
 * single-instance lock, so a dev instance that is already running can no
 * longer make a spec's app quit at once, and nothing a spec does leaks into
 * (or is read from) the real profile. launchElectron checks after load that
 * Electron really reports the temp directory as its userData path.
 *
 * Cleanup: launchElectron tracks every app it starts. A launch that fails
 * AFTER the process started (firstWindow, waitForLoadState, a caller hook or
 * the profile check throws) closes that app before rethrowing, and
 * closeAllApps() (each spec's afterAll) closes any app a failing test left
 * running. Only then can the temp profile be deleted: Electron holds files in
 * it while it runs. Processes are only ever addressed by the PID Playwright
 * launched, never by image name (other Electron apps may be running).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';

/** A fresh directory under the OS temp dir. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create (and return) the Electron profile directory inside a spec's temp workspace. */
export function makeUserDataDir(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, 'electron-userdata');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a temp workspace. Electron can hold profile files for a moment after
 *  exit, so retry, and report a leftover instead of failing the suite in teardown. */
export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.warn(`could not remove the temp workspace ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const live = new Set<ElectronApplication>();

/** True while a process with this PID exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Prefer a graceful close; never let a wedged quit hang the suite (on Windows
 *  the backend's keep-alive sockets can outlive quit). The kill path takes the
 *  WHOLE tree of the launched PID: surviving GPU/renderer children would keep
 *  the single-instance lock and the profile files. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  live.delete(app);
  // Captured BEFORE close(): Playwright disposes the handle during close, after which
  // process() throws and the kill fallback below would be skipped for a lingering tree.
  let child: ReturnType<ElectronApplication['process']> | undefined;
  try {
    child = app.process();
  } catch {
    child = undefined;
  }
  await Promise.race([app.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  try {
    if (child !== undefined && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* process already gone */
  }
}

/** Close every app launchElectron started that is still tracked (afterAll). */
export async function closeAllApps(): Promise<void> {
  for (const app of [...live]) await closeApp(app);
}

export interface LaunchOptions {
  /** The temp Electron profile (see makeUserDataDir). Required: there is no dev-profile launch. */
  userDataDir: string;
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Right after the process starts, before the first window (log taps). */
  onLaunched?: (app: ElectronApplication) => void;
  /** With the first window, before waitForLoadState (console listeners). */
  onWindow?: (page: Page) => void;
}

/** Case- and separator-insensitive path comparison (Windows). */
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Launch the desktop app (`electron .`) on a temp profile and wait for its first window. */
export async function launchElectron(opts: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined) env[key] = value;
  }
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${opts.userDataDir}`],
    cwd: opts.cwd,
    env,
  });
  // Tracked from the first moment it exists, so even a failure below is cleaned up.
  live.add(app);
  try {
    opts.onLaunched?.(app);
    const page = await app.firstWindow();
    opts.onWindow?.(page);
    await page.waitForLoadState('domcontentloaded');
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    if (!samePath(userData, opts.userDataDir)) {
      throw new Error(`Electron is not on the temp profile: userData is ${userData}, expected ${opts.userDataDir}`);
    }
    return { app, page };
  } catch (err) {
    await closeApp(app);
    throw err;
  }
}
