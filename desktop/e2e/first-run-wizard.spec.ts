/**
 * first-run-wizard.spec.ts — E2 acceptance checks for issue #85 (Playwright-
 * under-Electron, same harness as renderer-smoke).
 *
 * Frozen check subjects:
 *   C1  happy path: all six wizard states complete; the manifest-required
 *       pack ends active.
 *   C2  RAM-gate downgrade: simulated low free RAM auto-selects Fast with a
 *       warning; the Quality override stays available.
 *   C5  license gate: completion impossible without explicit acknowledgment.
 *   C6  drift re-run: completed, then a covered file mutates -> the wizard
 *       re-triggers on relaunch.
 *
 * The backend runs the deterministic stub engine + hash embedder; the wizard
 * is force-opened via TRAININGAPP_FIRST_RUN_FORCE=1 (the stub exemption that
 * keeps the modelless smoke suite ungated works the other way here). The
 * integrity manifest + staged pack are fixtures staged per-test in a temp dir.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

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
const FIXTURE_PACK = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs', 'bundled-min');

const T0 = Date.now();
const t = (): string => `[first-run ${Math.round((Date.now() - T0) / 100) / 10}s]`;

interface WizardWorkspace {
  root: string;
  storePath: string;
  manifestPath: string;
  packsRoot: string;
  coveredFile: string;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Stage the manifest workspace: one covered model file + the bundled-min
 *  fixture pack as the manifest-required pack. */
function makeWorkspace(
  prefix: string,
  options: { declareOnlyQuality?: boolean; withPacks?: boolean } = {},
): WizardWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const storePath = path.join(root, 'store', 'profiles', 'default', 'store.sqlite');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const packsRoot = path.join(root, 'packs-root');
  fs.mkdirSync(packsRoot, { recursive: true });

  const coveredFile = path.join(root, 'manifest-root', 'llm', 'gemma-4-e2b-it', 'model.gguf');
  fs.mkdirSync(path.dirname(coveredFile), { recursive: true });
  fs.writeFileSync(coveredFile, 'e2e-quality-model-fixture-bytes');

  const stagedPack = path.join(root, 'manifest-root', 'packs', 'bundled-min-1.0.0');
  fs.cpSync(FIXTURE_PACK, stagedPack, { recursive: true });

  const manifestPath = path.join(root, 'manifest-root', 'manifest.json');
  const manifest = {
    version: '1',
    description: 'e2e fixture manifest (issue #85)',
    models: [
      {
        id: 'gemma-4-e2b-it',
        label: 'Quality LLM fixture',
        kind: 'llm',
        group: 'llm-quality',
        files: [
          {
            path: path.join('llm', 'gemma-4-e2b-it', 'model.gguf'),
            required: true,
            sha256: sha256File(coveredFile),
            // declareOnlyQuality (C2): the DECLARED real-world size (~3.85 GiB)
            // drives the RAM gate before the file is staged — the actual
            // fixture bytes stay tiny and verify-manifest is never reached.
            sizeBytes:
              options.declareOnlyQuality === true
                ? Math.round(3.85 * 1024 ** 3)
                : fs.statSync(coveredFile).size,
          },
        ],
      },
    ],
    // withPacks:false (C5) isolates the license gate: with no required packs
    // the ONLY remaining Complete gate is the acknowledgment itself.
    packs: options.withPacks === false ? [] : [{ id: 'bundled-min', version: '1.0.0', name: 'Bundled Minimum Fixture', dir: 'bundled-min-1.0.0' }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, storePath, manifestPath, packsRoot, coveredFile };
}

async function launchApp(workspace: WizardWorkspace, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    cwd: path.join(REPO_ROOT, 'desktop'),
    env: {
      ...process.env,
      ELECTRON_START_URL: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_ENGINE: 'stub',
      TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      TRAININGAPP_DESKTOP_STORE_PATH: workspace.storePath,
      TRAININGAPP_DESKTOP_PACKS_DIR: workspace.packsRoot,
      TRAININGAPP_DESKTOP_MANIFEST: workspace.manifestPath,
      // The wizard E2E runs on the stub engine, so the stub exemption must be
      // overridden for these runs only (documented dev/test seam).
      TRAININGAPP_FIRST_RUN_FORCE: '1',
      ...extraEnv,
    } as Record<string, string>,
  });
  app.process().stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (line.includes('[trainingapp-desktop]') || line.includes('[trainingapp-backend]')) {
        console.log(`${t()} [main] ${line.trim().slice(0, 200)}`);
      }
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Prefer graceful close; never let a wedged quit hang the suite (Windows
 *  keep-alive sockets — same teardown as renderer-smoke). */
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

/** Walk the wizard to the licensing step (4 Next clicks). */
async function walkToLicensing(page: Page): Promise<void> {
  await expect(page.getByTestId('first-run-wizard')).toBeVisible();
  for (let i = 0; i < 4; i += 1) {
    await page.getByTestId('wizard-next').click();
  }
  await expect(page.getByTestId('step-licensing-notices')).toBeVisible();
}

/** Complete the whole wizard on the happy path and finish. */
async function completeWizard(page: Page): Promise<void> {
  await walkToLicensing(page);
  // activate-packs is step index 3 — walk back once if its button is present;
  // instead of backtracking, complete the activation from the licensing step
  // is NOT possible by design, so this helper is only used on happy paths that
  // activated during C1. Kept for C6's abbreviated re-run: activation already
  // satisfied (pack active), the step shows "All required packs are active".
  await expect(page.getByTestId('wizard-complete')).toBeDisabled();
  await page.getByTestId('license-ack').check();
  await expect(page.getByTestId('wizard-complete')).toBeEnabled();
  await page.getByTestId('wizard-complete').click();
  await expect(page.getByTestId('step-complete')).toBeVisible();
  await page.getByTestId('wizard-finish').click();
  await expect(page.getByTestId('first-run-wizard')).toHaveCount(0);
}

const workspaces: string[] = [];

test.afterAll(() => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows tmp cleanup race is fine in teardown */
      }
    }
  }
});

function makeTrackedWorkspace(
  prefix: string,
  options: { declareOnlyQuality?: boolean; withPacks?: boolean } = {},
): WizardWorkspace {
  const workspace = makeWorkspace(prefix, options);
  workspaces.push(workspace.root);
  return workspace;
}

test.describe.serial('first-run wizard (issue #85 E2E rows)', () => {
  test('C1: happy path completes all six wizard states and activates the pack', async () => {
    const workspace = makeTrackedWorkspace('e2-c1-first-run-');
    const { app, page } = await launchApp(workspace);

    await expect(page.getByTestId('first-run-wizard')).toBeVisible();
    await expect(page.getByTestId('step-detect-hardware')).toBeVisible();
    // detect-hardware shows the measured free RAM (a real number, not a stub).
    await expect(page.getByTestId('step-detect-hardware')).toContainText('Free RAM measured');

    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('step-select-profile')).toBeVisible();
    // 16-GiB-class machine (no low-RAM override): quality is recommended.
    await expect(page.getByTestId('profile-quality')).toBeChecked();

    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('step-verify-manifest')).toContainText('1 required file(s) verified');

    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('step-activate-packs')).toBeVisible();
    await expect(page.getByTestId('step-activate-packs')).toContainText('bundled-min');
    await page.getByTestId('activate-packs-button').click();
    await expect(page.getByTestId('step-activate-packs')).toContainText('installed bundled-min@1.0.0');

    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('step-licensing-notices')).toBeVisible();
    await page.getByTestId('license-ack').check();
    await page.getByTestId('wizard-complete').click();
    await expect(page.getByTestId('step-complete')).toContainText('quality');
    await page.getByTestId('wizard-finish').click();
    await expect(page.getByTestId('first-run-wizard')).toHaveCount(0);

    await closeApp(app);
  });

  test('C2: simulated low free RAM auto-selects Fast with a warning; Quality override available', async () => {
    // No staged quality file + a declared ~3.85 GiB size: the honest
    // first-run scenario the RAM gate must handle (declared-size gate).
    const workspace = makeTrackedWorkspace('e2-c2-lowram-', { declareOnlyQuality: true });
    const { app, page } = await launchApp(workspace, {
      TRAININGAPP_DESKTOP_FREE_RAM_BYTES: String(4 * 1024 ** 3),
    });

    await expect(page.getByTestId('first-run-wizard')).toBeVisible();
    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('step-select-profile')).toBeVisible();
    // Downgraded: Fast pre-selected, warning names the numbers, Quality
    // remains selectable as the explicit operator override.
    await expect(page.getByTestId('profile-fast')).toBeChecked();
    await expect(page.getByTestId('profile-warning')).toBeVisible();
    await expect(page.getByTestId('profile-warning')).toContainText('bytes');
    await expect(page.getByTestId('profile-quality')).toBeEnabled();
    await expect(page.getByTestId('step-select-profile')).toContainText('override');

    await closeApp(app);
  });

  test('C5: the license gate cannot be skipped without explicit acknowledgment', async () => {
    const workspace = makeTrackedWorkspace('e2-c5-license-', { withPacks: false });
    const { app, page } = await launchApp(workspace);

    await walkToLicensing(page);
    // Unskippable: Complete stays disabled until the acknowledgment checkbox.
    await expect(page.getByTestId('wizard-complete')).toBeDisabled();
    await expect(page.getByTestId('step-licensing-notices')).toContainText('licensing notices');
    await page.getByTestId('license-ack').check();
    await expect(page.getByTestId('wizard-complete')).toBeEnabled();

    await closeApp(app);
  });

  test('C6: mutating a covered file after completion re-triggers the wizard on relaunch', async () => {
    const workspace = makeTrackedWorkspace('e2-c6-drift-');
    const { app, page } = await launchApp(workspace);

    // Complete once (activates the pack on the way).
    await expect(page.getByTestId('first-run-wizard')).toBeVisible();
    await page.getByTestId('wizard-next').click(); // select-profile
    await page.getByTestId('wizard-next').click(); // verify-manifest
    await page.getByTestId('wizard-next').click(); // activate-packs
    await page.getByTestId('activate-packs-button').click();
    await expect(page.getByTestId('step-activate-packs')).toContainText('installed bundled-min@1.0.0');
    await page.getByTestId('wizard-next').click(); // licensing-notices
    await page.getByTestId('license-ack').check();
    await page.getByTestId('wizard-complete').click();
    await expect(page.getByTestId('step-complete')).toBeVisible();
    await page.getByTestId('wizard-finish').click();
    await expect(page.getByTestId('first-run-wizard')).toHaveCount(0);

    await closeApp(app);

    // Drift: corrupt the covered file AFTER completion.
    fs.appendFileSync(workspace.coveredFile, '-CORRUPTED-AFTER-COMPLETION');

    // Relaunch: the wizard must re-trigger with the drift copy.
    const second = await launchApp(workspace);
    await expect(second.page.getByTestId('first-run-wizard')).toBeVisible();
    await expect(second.page.getByTestId('first-run-wizard')).toContainText('Re-run setup');
    await expect(second.page.getByTestId('first-run-wizard')).toContainText('changed since setup');
    await closeApp(second.app);
  });
});
