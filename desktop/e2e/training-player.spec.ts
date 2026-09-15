/**
 * D5 acceptance checks C2 + C3 (issue #81, AC2/AC3): Playwright-under-Electron
 * against the REAL app booted in PRODUCTION mode (app:// protocol registered,
 * no ELECTRON_START_URL), with the committed trimmed Storyline fixture served
 * through the app://training/<packId>/ route.
 *
 * FROZEN SPEC — authored by the independent check author at base d2380bb,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Frozen contracts exercised here:
 *
 *  - Env: TRAININGAPP_DESKTOP_PACKS_DIR (main process) names the packs root.
 *    When this spec's process already has it set (local real-publish runs),
 *    it is passed through untouched; otherwise the spec stages the fixture
 *    desktop/e2e/fixtures/storyline-nav/ into a temp packs root as
 *    <packId>/assets/player/ (fixture layout: FIXTURE_CONTRACT.md).
 *    Frozen packId: opmed-cdp-mlc.
 *
 *  - UI: the app navigation (nav[aria-label="Main navigation"]) contains a
 *    "Training" item, and the training page mounts TrainingPlayer with the
 *    packId taken from the QUERY PARAM `pack` on app://index.html
 *    (frozen: app://index.html?pack=<packId>).
 *
 *  - TrainingPlayer render surface (also frozen by the C5 jsdom spec):
 *      iframe[data-testid="training-player-frame"]
 *        src = app://training/<packId>/story.html
 *      [data-testid="training-player-slide"]      text `${slideId}|${slideTitle}`
 *      [data-testid="training-player-slidechange"] log; one child
 *        [data-trainingapp-entry] (text `${slideId}|${slideTitle}`) per change
 *    and the e2e drive seam window.__trainingappTrainingPlayer.jumpToSlide(id)
 *    (the component's own imperative handle — AC2 drives the COMPONENT, never
 *    Storyline DOM or DS internals).
 *
 *  - Course start: the Storyline player has no window before the course
 *    starts (A8 probe), so the spec clicks the player's own Start (fresh
 *    launch) or Restart (persisted position) button ONCE inside the frame.
 *    This is not an outline/menu interaction (AC4): the outline/menu is
 *    confirmed disabled in this publish.
 *
 *  - AC1 console gate: no console error mentioning COOP/COEP may appear
 *    (favicon 404s and trimmed-fixture media 404s are tolerated).
 *
 * Tags: `@ac2` = C2 (10 jumps across 3 sections), `@ac3` = C3 (slidechange
 * semantics). The drivers run this file once per tag via --grep.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';

const PACK_ID = 'opmed-cdp-mlc';
// ESM-safe __dirname (desktop package.json sets "type": "module").
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(THIS_DIR, 'fixtures', 'storyline-nav');

/** Frozen 12-slide manifest (FIXTURE_CONTRACT.md §3); rows 1-10 are the AC2 jump targets. */
const SLIDE_MANIFEST: ReadonlyArray<{ id: string; title: string; section: string }> = [
  { id: '5rN4PvXJM5d', title: 'Welcome', section: 'Launch Menu' },
  { id: '6RdggQhakWc', title: 'Roles Menu', section: 'Launch Menu' },
  { id: '5WPdDfMu1kK', title: 'Patient Information Disclaimer', section: 'Launch Menu' },
  { id: '6mEtFwFWVpq', title: 'Main Menu', section: 'Launch Menu' },
  { id: '6o652ZiseLC', title: 'Select Ambulatory', section: 'The CDS Library: What you need to know in Ambulatory' },
  { id: '6mZvfaT2voE', title: 'Select Chief Complaint/HPI', section: 'The CDS Library: What you need to know in Ambulatory' },
  { id: '5aekClXIESa', title: 'Select Chief Complaint', section: 'The CDS Library: What you need to know in Ambulatory' },
  { id: '6ZYUMez1qPq', title: 'Select Confusion', section: 'The CDS Library: What you need to know in Ambulatory' },
  { id: '6cdRMINdr9M', title: 'Select New Encounter', section: 'Registering a Patient with a CAC' },
  { id: '5WB9cNnxOlq', title: 'Registering a Patient with a CAC Video', section: 'Registering a Patient with a CAC' },
  { id: '6e9cgBrg3Fe', title: 'Select New Patient', section: 'Registering a Patient with a CAC' },
  { id: '6DFIkaCmtTO', title: 'Select Sex', section: 'Registering a Patient with a CAC' },
];
const JUMP_TARGETS = SLIDE_MANIFEST.slice(0, 10);

declare global {
  interface Window {
    __trainingappTrainingPlayer?: { jumpToSlide(slideId: string): Promise<boolean> };
  }
}

const consoleErrors: string[] = [];

test.beforeAll(() => {
  if (!existsSync(path.join(FIXTURE_DIR, 'story.html'))) {
    throw new Error(
      `storyline-nav fixture missing: ${FIXTURE_DIR}/story.html not found — build it per ${FIXTURE_DIR}/FIXTURE_CONTRACT.md`,
    );
  }
  if (!existsSync(path.join(FIXTURE_DIR, 'story_content', 'trainingapp-bridge.js'))) {
    throw new Error('storyline-nav fixture incomplete: story_content/trainingapp-bridge.js missing (FIXTURE_CONTRACT.md §4)');
  }
});

/** AC1 gate: no COOP/COEP console errors (favicon/media 404s tolerated). */
function assertNoCoopCoepConsoleErrors(): void {
  const offending = consoleErrors.filter((text) => /coop|coep|cross-origin-opener|cross-origin-embedder/i.test(text));
  expect(offending, `COOP/COEP console errors appeared (AC1): ${offending.join(' || ')}`).toEqual([]);
}

/** Teardown helper mirroring renderer-smoke.spec.ts (Windows-safe quit). */
async function closeApp(app: ElectronApplication): Promise<void> {
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  try {
    if (app.process().exitCode === null) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* process already gone */
  }
}

async function launchTrainingApp(): Promise<{ app: ElectronApplication; page: Page; packsDir: string }> {
  // Stage the packs root (fixture -> <packId>/assets/player/) unless the
  // runner already provided TRAININGAPP_DESKTOP_PACKS_DIR (real-publish runs).
  let packsDir = process.env.TRAININGAPP_DESKTOP_PACKS_DIR ?? '';
  if (packsDir === '') {
    const packsRoot = mkdtempSync(path.join(os.tmpdir(), 'd5-packs-'));
    const playerDir = path.join(packsRoot, PACK_ID, 'assets', 'player');
    mkdirSync(playerDir, { recursive: true });
    cpSync(FIXTURE_DIR, playerDir, { recursive: true });
    packsDir = packsRoot;
  }
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'd5-training-e2e-store-'));
  const storePath = path.join(storeDir, 'profiles', 'default', 'store.sqlite');
  mkdirSync(path.dirname(storePath), { recursive: true });

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // PRODUCTION mode: no ELECTRON_START_URL, no --dev — app:// is registered
  // and the window loads app://index.html from desktop/renderer.
  delete env.ELECTRON_START_URL;
  env.TRAININGAPP_DESKTOP_PACKS_DIR = packsDir;
  env.TRAININGAPP_DESKTOP_ENGINE = 'stub';
  env.TRAININGAPP_DESKTOP_EMBEDDER = 'hash';
  env.TRAININGAPP_DESKTOP_STORE_PATH = storePath;

  const app = await _electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.waitForLoadState('domcontentloaded');
  return { app, page, packsDir };
}

/** Navigate with the frozen `pack` query param and open the Training page. */
async function openTrainingPage(page: Page): Promise<void> {
  await page.goto(`app://index.html?pack=${PACK_ID}`);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name: 'Training', exact: true }).click();
  const frame = page.locator('iframe[data-testid="training-player-frame"]');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(frame).toHaveAttribute('src', new RegExp(`^app://training/${PACK_ID}/story\\.html`), {
    timeout: 30_000,
  });
}

/**
 * Start the course: the player has no window before course start (A8 probe).
 * Fresh launch -> Start button; persisted position -> Resume/Restart prompt.
 * One click inside the frame, then readiness = the component's own state read
 * (training-player-slide) reporting an id|title.
 */
async function startCourseAndWaitReady(page: Page): Promise<void> {
  const frame = page.frameLocator('iframe[data-testid="training-player-frame"]');
  const startOrRestart = frame
    .locator('[aria-label="Restart"], [aria-label="Start"], button:has-text("Restart"), button:has-text("Start")')
    .first();
  await startOrRestart.click({ timeout: 20_000 }).catch(() => {
    /* already started (no cover / no prompt) — readiness check below decides */
  });
  await expect(page.getByTestId('training-player-slide')).toHaveText(/^[^|]+\|.+/, { timeout: 90_000 });
}

function slideElement(page: Page) {
  return page.getByTestId('training-player-slide');
}

async function expectSlideState(page: Page, id: string, title: string): Promise<void> {
  await expect(slideElement(page)).toHaveText(`${id}|${title}`, { timeout: 30_000 });
}

async function jumpViaComponent(page: Page, slideId: string): Promise<boolean> {
  return page.evaluate((id) => window.__trainingappTrainingPlayer!.jumpToSlide(id), slideId);
}

test.describe('D5 training player service (production-mode Electron e2e)', () => {
  test('jumpToSlide drives 10 slides across 3 sections @ac2', async () => {
    const { app, page } = await launchTrainingApp();
    try {
      await openTrainingPage(page);
      await startCourseAndWaitReady(page);

      expect(JUMP_TARGETS.length, 'frozen manifest must carry 10 jump targets').toBe(10);
      const sections = new Set<string>();
      const seen = new Set<string>();
      for (const target of JUMP_TARGETS) {
        const ok = await jumpViaComponent(page, target.id);
        expect(ok, `jumpToSlide(${target.id}) must resolve true`).toBe(true);
        // AC2: the PLAYER'S OWN STATE (rendered by the component from
        // getCurrentWindowSlide) must match the target after each jump.
        await expectSlideState(page, target.id, target.title);
        sections.add(target.section);
        seen.add(target.id);
      }
      expect(seen.size, 'the 10 jump targets must be distinct slide ids').toBe(10);
      expect(sections.size, 'jumps must span at least 3 scenes').toBeGreaterThanOrEqual(3);
      assertNoCoopCoepConsoleErrors();
    } finally {
      await closeApp(app);
    }
  });

  test('slidechange fires on change with correct payload, silent on unchanged polls @ac3', async () => {
    const { app, page } = await launchTrainingApp();
    try {
      await openTrainingPage(page);
      await startCourseAndWaitReady(page);

      const log = page.getByTestId('training-player-slidechange');
      await expect(log).toBeVisible();
      const entries = log.locator('[data-trainingapp-entry]');
      const countEntries = async (): Promise<number> => entries.count();

      // Deterministic target: a slide DIFFERENT from the current one (the
      // player persists position, so a fresh boot may resume anywhere).
      const current = (await slideElement(page).textContent()) ?? '';
      const target =
        current.startsWith('6RdggQhakWc|')
          ? { id: '5WPdDfMu1kK', title: 'Patient Information Disclaimer' }
          : { id: '6RdggQhakWc', title: 'Roles Menu' };

      const before = await countEntries();

      // Advance the player via the component's own jumpToSlide (issue AC3
      // allows simulated click or jumpToSlide).
      const ok = await jumpViaComponent(page, target.id);
      expect(ok).toBe(true);
      await expectSlideState(page, target.id, target.title);

      // Exactly one new entry, bearing the new slideId|slideTitle.
      await expect.poll(countEntries, { timeout: 20_000 }).toBe(before + 1);
      const last = await entries.nth((await countEntries()) - 1).textContent();
      expect(last).toBe(`${target.id}|${target.title}`);

      // Repeated polls with NO change (poll cadence ~1000ms; wait 3+ cycles)
      // must NOT add entries — the event fires only on change.
      await page.waitForTimeout(3_200);
      expect(await countEntries()).toBe(before + 1);
      expect(await slideElement(page).textContent()).toBe(`${target.id}|${target.title}`);

      assertNoCoopCoepConsoleErrors();
    } finally {
      await closeApp(app);
    }
  });
});
