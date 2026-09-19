/**
 * c7-packs.spec.ts — E2E acceptance checks for issue #74 (C7: Documents page
 * pack surface), Playwright-under-Electron, same harness as first-run-wizard
 * and renderer-smoke.
 *
 * Frozen check subjects (grep with `npx playwright test e2e/c7-packs.spec.ts -g "<grep>"`):
 *   C1  pack list renders: with 2+ packs installed, the Documents page lists
 *       each pack's name, version, source_class and active/superseded status.
 *   C2  drag-drop pack install: dropping (via the file-input equivalent used
 *       by renderer-smoke.spec.ts) a valid `.zip` pack on the packs panel
 *       installs it through the backend pack-install API and the row appears
 *       WITHOUT a page reload (proven with a pre-drop window marker).
 *   C6-e2e  citation provenance dimension: after a grounded ask against an
 *       installed pack, the citation pill text contains the pack id and
 *       version (`bundled-min v1.0.0`). (The unit-level AC6 check lives in
 *       web_ui/src/components/__tests__/source-citation-pack.test.tsx; no
 *       standalone driver script is assigned to this e2e dimension.)
 *   C7  accessibility: axe scan of the packs panel + keyboard operability of
 *       remove (Tab-reachable, Enter opens the confirm, keyboard Cancel
 *       leaves the pack installed).
 *
 * ---------------------------------------------------------------------------
 * UI SEAMS THE IMPLEMENTATION MUST PROVIDE (frozen contract, mirrors the
 * seams used by web_ui/src/pages/DocumentsPage.packs*.test.tsx):
 *   - Panel heading: a role="heading" element with the accessible name
 *     `Knowledge Packs`, rendered by DocumentsPage in Electron mode.
 *   - Panel container:            data-testid="packs-panel"
 *   - One row per installed pack version:
 *                                 data-testid="pack-row-<packId>-<version>"
 *     The row's visible text contains the pack's display name, its version,
 *     its source_class (e.g. `bundled` / `user`), and a status word.
 *   - Status word per row:        data-testid="pack-status-<packId>-<version>"
 *     visible text exactly `active` or `superseded`.
 *   - Pack install file input:    data-testid="pack-install-input"
 *     (input[type=file] accepting .zip; the plain-document DropZone input
 *     stays a SEPARATE input[type=file] without that testid).
 *   - Remove control per row:     data-testid="pack-remove-<packId>-<version>"
 *     aria-label `Remove <packId> <version>`; keyboard operable.
 *   - Remove confirm button:     data-testid="pack-remove-confirm"
 *   - Remove cancel button:      data-testid="pack-remove-cancel"
 *   - Rollback control per row:   data-testid="pack-rollback-<packId>-<version>"
 *     aria-label `Rollback <packId> to <version>` (rendered for superseded
 *     versions).
 *
 * BACKEND SEAMS (already half-present): the desktop backend pack lifecycle
 * (pack-manager install/rollback/remove/listInstalled) must be exposed over
 * HTTP and the renderer apiClient must grow:
 *   listPacks(): Promise<PackInfo[]>, installPack(file: File),
 *   removePack(packId, version?), rollbackPack(packId, toVersion)
 * with PackInfo =
 *   { packId, version, name, sourceClass, publishedAt, active, supersedes }.
 *
 * Staging mirrors first-run-wizard.spec.ts: a temp store/env per test, the
 * integrity manifest requiring the fixture packs, TRAININGAPP_FIRST_RUN_FORCE=1
 * to open the wizard, and the wizard's activate-packs step installing the
 * required packs. The superseded row in C1 is produced by requiring
 * versioned-a TWICE (1.0.0 with no pinned version, then 2.0.0): activation
 * installs 1.0.0 then 2.0.0 which supersedes it, while the completion gate
 * stays satisfiable because the version-less entry is satisfied by whichever
 * version is active.
 *
 * The C2 zip is built IN-SPEC with jszip (a desktop prod dependency) by
 * zipping the staged contracts/fixtures/packs/bundled-min folder
 * (pack.json + docs/) — no checked-in zip artifact is used.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
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
const FIXTURE_PACKS = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const FIXTURE_BUNDLED_MIN = path.join(FIXTURE_PACKS, 'bundled-min');
const FIXTURE_VERSIONED_A_100 = path.join(FIXTURE_PACKS, 'versioned-a-1.0.0');
const FIXTURE_VERSIONED_A_200 = path.join(FIXTURE_PACKS, 'versioned-a-2.0.0');

const T0 = Date.now();
const t = (): string => `[c7-packs ${Math.round((Date.now() - T0) / 100) / 10}s]`;

interface PacksWorkspace {
  root: string;
  storePath: string;
  manifestPath: string;
  packsRoot: string;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Stage the wizard workspace exactly the way first-run-wizard.spec.ts does:
 * temp store, temp packs dir, a covered model file, and the given fixture
 * packs staged beside the manifest and REQUIRED by it (the wizard's
 * activate-packs step installs them).
 */
function makeWorkspace(prefix: string, requiredPacks: Array<{ id: string; version?: string; name: string; dir: string }>): PacksWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const storePath = path.join(root, 'store', 'profiles', 'default', 'store.sqlite');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const packsRoot = path.join(root, 'packs-root');
  fs.mkdirSync(packsRoot, { recursive: true });

  const coveredFile = path.join(root, 'manifest-root', 'llm', 'gemma-4-e2b-it', 'model.gguf');
  fs.mkdirSync(path.dirname(coveredFile), { recursive: true });
  fs.writeFileSync(coveredFile, 'c7-packs-e2e-model-fixture-bytes');

  const stagedDirs = [FIXTURE_BUNDLED_MIN, FIXTURE_VERSIONED_A_100, FIXTURE_VERSIONED_A_200];
  for (const fixtureDir of stagedDirs) {
    const target = path.join(root, 'manifest-root', 'packs', path.basename(fixtureDir));
    fs.cpSync(fixtureDir, target, { recursive: true });
  }

  const manifestPath = path.join(root, 'manifest-root', 'manifest.json');
  const manifest = {
    version: '1',
    description: 'c7 packs e2e fixture manifest (issue #74)',
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
            sizeBytes: fs.statSync(coveredFile).size,
          },
        ],
      },
    ],
    packs: requiredPacks,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, storePath, manifestPath, packsRoot };
}

async function launchApp(workspace: PacksWorkspace, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
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
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`${t()} [renderer-error] ${msg.text().slice(0, 240)}`);
  });
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

/**
 * Walk the whole wizard (same steps as first-run-wizard C1) so the app lands
 * on the main UI with every manifest-required pack installed and active.
 */
async function completeWizard(page: Page): Promise<void> {
  await expect(page.getByTestId('first-run-wizard')).toBeVisible();
  await page.getByTestId('wizard-next').click(); // -> select-profile
  await page.getByTestId('wizard-next').click(); // -> verify-manifest
  await expect(page.getByTestId('step-verify-manifest')).toContainText('1 required file(s) verified');
  await page.getByTestId('wizard-next').click(); // -> activate-packs
  await page.getByTestId('activate-packs-button').click();
  await expect(page.getByTestId('step-activate-packs')).toContainText('installed');
  await page.getByTestId('wizard-next').click(); // -> licensing-notices
  await page.getByTestId('license-ack').check();
  await page.getByTestId('wizard-complete').click();
  await expect(page.getByTestId('step-complete')).toBeVisible();
  await page.getByTestId('wizard-finish').click();
  await expect(page.getByTestId('first-run-wizard')).toHaveCount(0);
}

/** Navigate to the Documents page via the app's Main navigation. */
async function goToDocuments(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name: 'Documents', exact: true }).click();
  // Give the freshly-mounted page a beat to settle its async loads (same
  // convention as renderer-smoke.spec.ts).
  await page.waitForTimeout(1_000);
}

/**
 * Build an installable pack `.zip` IN-SPEC from a staged fixture pack folder
 * (pack.json + docs/ at the archive root). jszip is a desktop prod dependency.
 */
async function buildPackZip(fixtureDir: string): Promise<Buffer> {
  const zip = new JSZip();
  const addDir = (absDir: string, relDir: string): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        addDir(abs, rel);
      } else {
        zip.file(rel, fs.readFileSync(abs));
      }
    }
  };
  addDir(fixtureDir, '');
  return zip.generateAsync({ type: 'nodebuffer' });
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
  requiredPacks: Array<{ id: string; version?: string; name: string; dir: string }>,
): PacksWorkspace {
  const workspace = makeWorkspace(prefix, requiredPacks);
  workspaces.push(workspace.root);
  return workspace;
}

test.describe.serial('c7 Documents page pack surface (issue #74)', () => {
  test('C1: the pack list renders name, version, source_class and active/superseded status for installed packs', async () => {
    // Three installed versions across two pack ids, one of them superseded:
    //  - bundled-min@1.0.0 (active)
    //  - versioned-a@1.0.0 (superseded by the 2.0.0 install below)
    //  - versioned-a@2.0.0 (active)
    // The version-less 1.0.0 entry keeps the wizard's completion gate
    // satisfiable (it is satisfied by whichever versioned-a is active).
    const workspace = makeTrackedWorkspace('c7-c1-packs-', [
      { id: 'bundled-min', version: '1.0.0', name: 'Bundled Minimum Fixture', dir: 'bundled-min' },
      { id: 'versioned-a', name: 'Versioned A Fixture', dir: 'versioned-a-1.0.0' },
      { id: 'versioned-a', version: '2.0.0', name: 'Versioned A Fixture', dir: 'versioned-a-2.0.0' },
    ]);
    const { app, page } = await launchApp(workspace);
    await completeWizard(page);
    await goToDocuments(page);

    // The packs panel itself is present with its heading.
    await expect(page.getByTestId('packs-panel')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Knowledge Packs' })).toBeVisible();

    // Row identity is <packId>-<version>; every installed version is listed.
    const bundledRow = page.getByTestId('pack-row-bundled-min-1.0.0');
    await expect(bundledRow).toBeVisible();
    await expect(bundledRow).toContainText('Bundled Minimum Fixture');
    await expect(bundledRow).toContainText('1.0.0');
    await expect(bundledRow).toContainText('bundled');
    await expect(page.getByTestId('pack-status-bundled-min-1.0.0')).toHaveText(/active/i);

    const supersededRow = page.getByTestId('pack-row-versioned-a-1.0.0');
    await expect(supersededRow).toBeVisible();
    await expect(supersededRow).toContainText('Versioned A Fixture');
    await expect(supersededRow).toContainText('1.0.0');
    await expect(page.getByTestId('pack-status-versioned-a-1.0.0')).toHaveText(/superseded/i);

    const activeRow = page.getByTestId('pack-row-versioned-a-2.0.0');
    await expect(activeRow).toBeVisible();
    await expect(activeRow).toContainText('Versioned A Fixture');
    await expect(activeRow).toContainText('2.0.0');
    await expect(activeRow).toContainText('bundled');
    await expect(page.getByTestId('pack-status-versioned-a-2.0.0')).toHaveText(/active/i);

    await closeApp(app);
  });

  test('C2: dropping a valid .zip pack installs it and the row appears WITHOUT a page reload', async () => {
    // The workspace requires only versioned-a@1.0.0 so the bundled-min zip
    // built below installs a pack that is NOT yet present.
    const workspace = makeTrackedWorkspace('c7-c2-install-', [
      { id: 'versioned-a', version: '1.0.0', name: 'Versioned A Fixture', dir: 'versioned-a-1.0.0' },
    ]);
    const { app, page } = await launchApp(workspace);
    await completeWizard(page);
    await goToDocuments(page);

    await expect(page.getByTestId('packs-panel')).toBeVisible();
    // The not-yet-installed pack has no row before the drop.
    await expect(page.getByTestId('pack-row-bundled-min-1.0.0')).toHaveCount(0);

    // No-reload proof: a window marker survives only if the page never
    // navigates/reloads. Set it BEFORE the drop, check it AFTER the row lands.
    await page.evaluate(() => {
      (window as unknown as { __c7_no_reload_marker?: string }).__c7_no_reload_marker = 'alive';
    });

    const zipBytes = await buildPackZip(FIXTURE_BUNDLED_MIN);
    // renderer-smoke convention: setInputFiles is the accepted Playwright
    // equivalent of a drag-drop onto the file input.
    await page.setInputFiles('input[data-testid="pack-install-input"]', {
      name: 'bundled-min-1.0.0.zip',
      mimeType: 'application/zip',
      buffer: zipBytes,
    });

    // The pack appears in the list without any reload.
    const newRow = page.getByTestId('pack-row-bundled-min-1.0.0');
    await expect(newRow).toBeVisible();
    await expect(newRow).toContainText('Bundled Minimum Fixture');
    await expect(page.getByTestId('pack-status-bundled-min-1.0.0')).toHaveText(/active/i);

    const marker = await page.evaluate(
      () => (window as unknown as { __c7_no_reload_marker?: string }).__c7_no_reload_marker,
    );
    expect(marker).toBe('alive');

    await closeApp(app);
  });

  test('C6-e2e: a grounded ask against an installed pack cites the pack id and version in the pill text', async () => {
    const workspace = makeTrackedWorkspace('c7-c6-cite-', [
      { id: 'bundled-min', version: '1.0.0', name: 'Bundled Minimum Fixture', dir: 'bundled-min' },
    ]);
    const { app, page } = await launchApp(workspace);
    await completeWizard(page);

    // Go ask in Chat (the pack docs are hash-embedded in the backend store).
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Chat', exact: true }).click();
    const input = page.getByLabel('Message input');
    await expect(input).toBeVisible({ timeout: 30_000 });

    // Bootstrap ask first (issue #118 first-turn state bug drops the terminal
    // citation fields on the very first ask of a conversation — same
    // convention as grounding-badge.spec.ts).
    await input.fill('Bootstrap question for the conversation.');
    await input.press('Enter');
    await expect(page.getByText(/desktop stub answer/i).first()).toBeVisible({ timeout: 45_000 });
    await expect(input).toBeEnabled({ timeout: 30_000 });

    await input.fill('What does the bundled welcome document say?');
    await input.press('Enter');
    await expect(page.getByText(/desktop stub answer/i).first()).toBeVisible({ timeout: 45_000 });
    await expect(input).toBeEnabled({ timeout: 30_000 });

    // The citation pill carries the pack provenance in its visible text.
    await expect(page.getByText('bundled-min v1.0.0').last()).toBeVisible({ timeout: 20_000 });

    await closeApp(app);
  });

  test('C7: the packs panel passes an axe scan and remove is keyboard operable (cancel keeps the pack)', async () => {
    const workspace = makeTrackedWorkspace('c7-c7-a11y-', [
      { id: 'bundled-min', version: '1.0.0', name: 'Bundled Minimum Fixture', dir: 'bundled-min' },
    ]);
    const { app, page } = await launchApp(workspace);
    await completeWizard(page);
    await goToDocuments(page);

    const panel = page.getByTestId('packs-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('pack-row-bundled-min-1.0.0')).toBeVisible();

    // axe scan, scoped to the NEW surface so pre-existing page-wide findings
    // stay owned by their own issues. The axe-core engine is injected into
    // the LIVE page (CHECK_WRONG AMEND, 2026-09-19): @axe-core/playwright's
    // AxeBuilder drives browserContext.newPage(), which Electron's Playwright
    // context refuses ("Protocol error (Target.createTarget): Not supported").
    // The assertion contract is unchanged: zero violations in the packs panel
    // under the same WCAG tag set. On the base tree the panel itself never
    // appears, so this scan is never reached (base signature unchanged).
    const axeSourcePath = path.join(REPO_ROOT, 'desktop', 'node_modules', 'axe-core', 'axe.min.js');
    await page.addScriptTag({ content: fs.readFileSync(axeSourcePath, 'utf8') });
    const axeResults = await page.evaluate(async () => {
      const axeGlobal = (window as unknown as {
        axe: { run: (target: Element | null, options: object) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }> };
      }).axe;
      return axeGlobal.run(document.querySelector('[data-testid="packs-panel"]'), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
    });
    expect(
      axeResults.violations,
      `axe violations in the packs panel: ${JSON.stringify(axeResults.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)}`,
    ).toEqual([]);

    // Keyboard operability: Tab to the remove control (bounded traversal —
    // the control must be reachable by keyboard alone), Enter opens the
    // confirmation dialog.
    const removeButton = page.getByTestId('pack-remove-bundled-min-1.0.0');
    await expect(removeButton).toBeVisible();
    let focused = false;
    for (let i = 0; i < 80 && !focused; i += 1) {
      await page.keyboard.press('Tab');
      focused = await removeButton.evaluate((el) => document.activeElement === el);
    }
    expect(focused, 'the pack remove control must be reachable via keyboard Tab traversal').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pack-remove-confirm')).toBeVisible();

    // Cancel via keyboard: Tab to the cancel button, Enter — the pack stays
    // installed (row still listed, no removal performed).
    const cancelButton = page.getByTestId('pack-remove-cancel');
    let cancelFocused = false;
    for (let i = 0; i < 20 && !cancelFocused; i += 1) {
      await page.keyboard.press('Tab');
      cancelFocused = await cancelButton.evaluate((el) => document.activeElement === el);
    }
    expect(cancelFocused, 'the cancel button must be reachable via keyboard Tab traversal').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pack-remove-confirm')).toHaveCount(0);
    await expect(page.getByTestId('pack-row-bundled-min-1.0.0')).toBeVisible();

    await closeApp(app);
  });
});
