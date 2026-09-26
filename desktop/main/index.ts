// Electron main-process bootstrap for the TrainingApp desktop shell (issue #59).
//
// Scope guard (Workstream B1): this module is ONLY the window shell — single
// instance, secure defaults, app:// renderer hosting. Backend hosting arrives
// with Workstream B3 (#61) and MUST live in its own module (ADR-0003, issue
// #57, decided: the Node main-process backend; the module abstraction stays so
// the sidecar mode remains reachable without touching this bootstrap). Baseline transport hardening beyond the flags
// below is Workstream B2 / issue #60.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { registerAppProtocol, registerAppSchemePrivileges } from './protocol.js';
import {
  createBackendHost,
  NodeBackendHost,
  resolveBackendMode,
  resolveNodeEngine,
  type BackendHandle,
  type BackendHost,
} from './backend/index.js';
import { CONTEXT_SIZE } from './backend/inference/llama-engine.js';
import { autoSelectProfile, resolveFreeRamBytes } from './first-run/ram-gate.js';
import {
  containedJoin,
  loadManifest,
  manifestGroupBytes,
  resolveManifestPath,
  verifyManifest,
  type ManifestFailure,
} from './first-run/manifest-verifier.js';
import {
  EMPTY_FIRST_RUN_STATE,
  evaluateStatus,
  loadFirstRunState,
  saveFirstRunState,
} from './first-run/first-run-store.js';
import { assertCanComplete, manifestCompletionState, WizardBlockError } from './first-run/wizard.js';
import { isBundledPackSatisfied } from './first-run/bundled-packs.js';
import { formatFailure, runStartupIntegrityCheck } from './integrity-check.js';
import { migrateLegacyStoreLayout, resolveProfileLayout } from './backend/store/profiles.js';
import {
  getLoopbackGuard,
  getLaunchToken,
  initializeLaunchToken,
  initializeTransportSecurity,
  resolveSecurityConfig,
} from './security/index.js';

const DEV_URL = 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function isDevArgv(): boolean {
  return process.argv.includes('--dev');
}

function devStartUrl(): string | undefined {
  const envUrl = process.env.ELECTRON_START_URL;
  return envUrl !== undefined && envUrl.length > 0 ? envUrl : isDevArgv() ? DEV_URL : undefined;
}

/**
 * Navigation allow-list (issue #60): the renderer may only navigate itself to
 * app:// targets; in dev mode the dev server origin is additionally allowed
 * so vite's full-page reloads keep working. Everything else — remote http(s),
 * file://, even loopback http in production — is denied.
 */
function isAllowedNavigationTarget(url: string): boolean {
  if (url.startsWith('app://')) return true;
  const dev = devStartUrl();
  if (dev === undefined) return false;
  try {
    return new URL(url).origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

/** Directory of the compiled module (dist/main), valid under ESM. */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Renderer root packaged by electron-builder extraResources (renderer -> web_ui). */
function resolveRendererRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web_ui');
  }
  // Unpackaged run (electron . without packaging): the desktop:build staging
  // dir, two levels above the compiled dist/main module.
  return path.join(moduleDir(), '..', '..', 'renderer');
}

/**
 * Packs root for the app://training/<packId>/ player route (issue #81).
 * Operator override via TRAININGAPP_DESKTOP_PACKS_DIR (mirrors
 * TRAININGAPP_DESKTOP_STORE_PATH); installs default to <userData>/packs.
 * A future pack lifecycle extracts built pack zips into exactly this layout:
 * <packsRoot>/<packId>/{pack.json,index.sqlite,docs/,assets/player/}.
 */
function resolvePacksRoot(): string {
  const override = process.env.TRAININGAPP_DESKTOP_PACKS_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(app.getPath('userData'), 'packs');
}

/**
 * Create the one and only application window.
 *
 * Secure defaults are contractual (frozen spec, AC3):
 * contextIsolation/sandbox on, nodeIntegration/webviewTag off. Production
 * loads the packaged renderer via app://; dev mode (--dev argv or
 * ELECTRON_START_URL) loads the vite dev server instead.
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      // .cjs: sandboxed renderers only load CommonJS preloads (ESM preloads
      // require sandbox:false), and the .cjs extension is unambiguous under
      // this package's "type": "module".
      preload: path.join(moduleDir(), '..', 'preload', 'index.cjs'),
    },
  });
  win.once('ready-to-show', () => win.show());
  // Navigation lockdown (issue #60, AC4): the only renderer-initiated
  // navigations are app:// targets (plus the dev server origin in dev mode);
  // window.open is denied outright — no popups, no new windows, ever.
  // NOTE: the window-open handler lives on webContents (the only surface that
  // exists in Electron >= 44 typings AND at runtime — verified by probe:
  // win.setWindowOpenHandler is undefined); will-navigate is webContents-native.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationTarget(url)) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler((): { action: 'deny' } => ({ action: 'deny' }));
  // Surface load failures instead of leaving a silent blank/hidden window
  // (e.g. dev server down, renderer resources incomplete).
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[trainingapp-desktop] failed to load ${validatedURL || '(no url)'}: ${errorDescription} (${errorCode})`);
    win.show();
  });
  const url = devStartUrl() ?? 'app://index.html';
  win.loadURL(url).catch(() => { /* failure surfaced via did-fail-load above */ });
  mainWindow = win;
  return win;
}

/**
 * Claim the single-instance lock. Returns false when another instance owns
 * it; that other instance is already focused by its second-instance handler,
 * so this process quits immediately.
 */
export function acquireSingleInstanceLock(): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    app.quit();
  }
  return acquired;
}

/** Focus/restore the existing window when a second launch is attempted. */
export function registerSecondInstanceHandler(): void {
  app.on('second-instance', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) {
      win.restore();
    }
    win.focus();
  });
}

/** Application entry point. Idempotent per process. */
export function bootstrap(): void {
  // Must precede the ready event.
  registerAppSchemePrivileges();
  if (!acquireSingleInstanceLock()) return;
  registerSecondInstanceHandler();

  app.whenReady().then(async () => {
    // Transport security (issue #60, B2): resolve config, mint the per-launch
    // token (main-process memory only), serve it to the renderer ONLY through
    // this IPC handler, and construct the loopback gate that B3's backend
    // host MUST mount in front of every route (docs/security/desktop.md).
    const securityConfig = resolveSecurityConfig();
    initializeLaunchToken();
    ipcMain.handle('desktop:get-token', () => getLaunchToken());
    initializeTransportSecurity({
      token: getLaunchToken(),
      tokenHeaderName: securityConfig.tokenHeaderName,
      allowedOrigins: securityConfig.allowedOrigins,
    });
    if (getLoopbackGuard() === null) {
      // Fail fast and audibly rather than booting an unguarded transport.
      console.error('[trainingapp-desktop] transport security failed to initialize; refusing to start');
      app.quit();
      return;
    }
    // Backend host (issue #61, B3): start the guarded loopback listener behind
    // the B2 guard, selected by backend.mode (node default per ADR-0003).
    // B4-B9 import ONLY desktop/main/backend/index.js — never this wiring.
    let backendHost: BackendHost | null = null;
    let backendHandle: BackendHandle | null = null;
    // B6 (issue #64): profile-scoped store layout per ADR-0006 —
    // <userData>/profiles/default/store.sqlite by default; legacy B5 stores
    // under <userData>/store/store.db are migrated (atomic rename) on first
    // B6 launch. Backups live under <userData>/backups.
    const userDataPath = app.getPath('userData');
    let storePath: string;
    try {
      migrateLegacyStoreLayout(userDataPath);
      // TRAININGAPP_DESKTOP_STORE_PATH: the same seam the headless dev-server
      // honors (dev-server.ts) and the Playwright-under-Electron suite relies
      // on for per-test store isolation; absent, the ADR-0006 profile layout
      // applies (<userData>/profiles/default/store.sqlite).
      const explicitStorePath = process.env.TRAININGAPP_DESKTOP_STORE_PATH;
      storePath =
        explicitStorePath !== undefined && explicitStorePath.length > 0
          ? path.resolve(explicitStorePath)
          : resolveProfileLayout({ userDataPath }).storePath;
    } catch (err) {
      console.error('[trainingapp-desktop] profile resolution failed:', err instanceof Error ? err.message : err);
      app.quit();
      return;
    }
    const backupsDir = path.join(userDataPath, 'backups');
    // E1 (issue #84): startup integrity gate. Runs BEFORE engine construction
    // (the per-profile model overrides it derives are constructor-only seams)
    // and refuses backend start on any packaged verification failure, naming
    // the specific file with expected/actual. Dev builds without a staged
    // manifest skip by design; a dev-present manifest (e.g.
    // TRAININGAPP_DESKTOP_MANIFEST) is verified and REPORTED, never fatal.
    const integrity = runStartupIntegrityCheck({
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      repoRoot: process.env.TRAININGAPP_DESKTOP_REPO_ROOT ?? path.join(moduleDir(), '..', '..', '..'),
      env: process.env,
    });
    if (integrity.decision === 'report' && integrity.failures.length > 0) {
      console.error('[trainingapp-desktop] integrity (dev, non-fatal):');
      for (const failure of integrity.failures) console.error(`  ${formatFailure(failure)}`);
    } else if (integrity.decision === 'report') {
      // Clean dev-present verification: say so AND that the bridge stayed
      // unarmed (review PRR-127 — silent no-output read as "honored").
      console.log('[trainingapp-desktop] integrity (dev): manifest verified clean; packaged bridge NOT armed (packaged-only)');
    }
    if (integrity.decision === 'block') {
      console.error('[trainingapp-desktop] installed resources failed integrity verification; refusing to start the backend:');
      for (const failure of integrity.failures) console.error(`  ${formatFailure(failure)}`);
      // console.error alone is invisible in a packaged Electron app (the
      // onGiveUp precedent below): surface the named failures audibly too.
      const lines = integrity.failures
        .slice(0, 5)
        .map((failure) => `${failure.path}\n  ${failure.reason}\n  expected: ${failure.expected}\n  actual: ${failure.actual}`)
        .join('\n\n');
      const more =
        integrity.failures.length > 5 ? `\n\n…and ${integrity.failures.length - 5} more (see logs)` : '';
      dialog.showErrorBox(
        'TrainingApp cannot start',
        `Installed resource files failed integrity verification.\n\n${lines}${more}\n\nReinstall the application.`,
      );
      app.quit();
      return;
    }
    if (integrity.decision === 'pass') {
      // Packaged→runtime bridge (fail-closed precedence: in packaged builds
      // the VERIFIED manifest locations win over any pre-set env override).
      const seamValues: [string, string | undefined][] = [
        ['TRAININGAPP_EMBEDDING_MODEL_DIR', integrity.modelDirs.embedder],
        ['TRAININGAPP_RERANKER_MODEL_DIR', integrity.modelDirs.reranker],
      ];
      for (const [name, value] of seamValues) {
        if (value === undefined) continue;
        const existing = process.env[name];
        if (existing !== undefined && existing.length > 0 && path.resolve(existing) !== path.resolve(value)) {
          console.warn(`[trainingapp-desktop] integrity: packaged manifest overrides ${name} (was ${existing})`);
        }
        process.env[name] = value;
      }
    }
    // E2 (issue #85): the engine reference is kept so the wizard can read
    // per-profile model paths (modelStatus) for the RAM-gate estimate.
    const engineOverrides: { userDataPath: string; models?: { quality?: string; fast?: string } } = {
      userDataPath,
    };
    if (integrity.decision === 'pass') {
      const models: { quality?: string; fast?: string } = {};
      if (integrity.modelDirs.engineQuality !== undefined) models.quality = integrity.modelDirs.engineQuality;
      if (integrity.modelDirs.engineFast !== undefined) models.fast = integrity.modelDirs.engineFast;
      if (models.quality !== undefined || models.fast !== undefined) engineOverrides.models = models;
    }
    const engine = resolveNodeEngine(process.env, engineOverrides);
    try {
      backendHost = createBackendHost({
        token: getLaunchToken(),
        tokenHeaderName: securityConfig.tokenHeaderName,
        allowedOrigins: securityConfig.allowedOrigins,
        mode: resolveBackendMode({ env: process.env }),
        // B4 (issue #62): when backend.mode is "node", serve real llama.cpp
        // inference with the model dir defaulting to <userData>/models.
        engine,
        // B6 (issue #64): open the per-profile SQLite store (ADR-0006 layout).
        storePath,
        // D6 (issue #82): packs root for learn-result slide metadata.
        packsRoot: resolvePacksRoot(),
        storeBackupsDir: backupsDir,
        // B6: forward ingest progress to the renderer (B9 owns the bar UI).
        onIngestProgress: (event) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ingest:progress', event);
          }
        },
        // B8 (issue #66): forward memory telemetry/downgrade events to the
        // renderer as `memory:event` (B9 owns the UI; the channel name is the
        // B9 contract, documented in docs/adr/0008-memory-budget.md).
        onMemoryEvent: (event) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('memory:event', event);
          }
        },
        // B6: corruption prompt — modal by design (ADR-0006): a store failing
        // integrity cannot be served, so startup blocks on the user's choice.
        onStoreCorruption: async (info) => {
          const choice = await dialog.showMessageBox({
            type: 'error',
            title: 'TrainingApp store corrupted',
            message: 'Your local knowledge store is corrupted.',
            detail: info.message,
            buttons: ['Restore from backup', 'Start fresh'],
            defaultId: 0,
            cancelId: 1,
          });
          return choice.response === 0 ? 'restore' : 'fresh';
        },
        // Fail-loud surfacing when the sidecar exhausts its restart budget
        // (console.error alone is invisible in a packaged Electron app).
        onGiveUp: (attempts) => {
          console.error(`[trainingapp-desktop] backend sidecar exhausted its restart budget (${attempts}); requests will fail until restart`);
          dialog.showErrorBox(
            'TrainingApp backend stopped',
            `The local answer engine exited repeatedly (${attempts} restarts) and gave up. Restart the app to try again.`,
          );
        },
      });
      backendHandle = await backendHost.start();
    } catch (err) {
      console.error('[trainingapp-desktop] backend host failed to start:', err instanceof Error ? err.message : err);
      app.quit();
      return;
    }
    // Port discovery for B9 (renderer integration): the ONLY channel the
    // backend address takes to the renderer — never web storage, never a URL.
    ipcMain.handle('desktop:get-backend', () => backendHandle);
    // B6 (issue #64): manual backup entry point (renderer-reachable; B9 adds
    // UI). Uses the same validated backup path as automatic recovery.
    ipcMain.handle('desktop:store-backup', async () => {
      const nodeHost = backendHost as NodeBackendHost | null;
      if (nodeHost === null || typeof nodeHost.createStoreBackup !== 'function') {
        return { ok: false as const, detail: 'backend host is not the node backend' };
      }
      return nodeHost.createStoreBackup(backupsDir);
    });
    // ---- E2 (issue #85): first-run validation wizard -----------------------
    // Same registration discipline as desktop:get-backend: the handlers exist
    // only after the backend host started; the renderer client treats a
    // missing handler as "backend not ready yet".
    const devRepoRoot = (): string =>
      process.env.TRAININGAPP_DESKTOP_REPO_ROOT ?? path.join(moduleDir(), '..', '..', '..');
    const licensesPath = (): string | null => {
      if (app.isPackaged) return path.join(process.resourcesPath, 'docs', 'licenses.md');
      const root = devRepoRoot();
      return path.join(root, 'docs', 'licenses.md');
    };
    /** Load + verify the integrity manifest (E1 contract, #84). `staged:false`
     *  is NOT an error — dev/CI trees and pre-E1 packaged builds have none;
     *  the fail-closed decision belongs to the caller. */
    const wizardManifest = () => {
      const manifestPath = resolveManifestPath({
        env: process.env,
        isPackaged: app.isPackaged,
        resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
        repoRoot: devRepoRoot(),
      });
      if (manifestPath === null || !existsSync(manifestPath)) {
        return { staged: false, manifestPath, manifest: null, verify: null, loadError: null };
      }
      const manifestDir = path.dirname(manifestPath);
      try {
        const { manifest } = loadManifest(manifestPath);
        const verify =
          manifest === null
            ? null
            : verifyManifest(manifest, [manifestDir, path.join(userDataPath, 'models')]);
        return { staged: manifest !== null, manifestPath, manifest, verify, loadError: null };
      } catch (err) {
        return {
          staged: true,
          manifestPath,
          manifest: null,
          verify: null,
          loadError: err instanceof Error ? err.message : String(err),
        };
      }
    };
    // Manifest-controlled dir (PRR-001): containment-checked join; null when
    // the entry tries to escape the manifest's packs directory.
    const packEntryDir = (
      manifestDir: string,
      entry: { id: string; version?: string; dir?: string },
    ): string | null =>
      containedJoin(path.join(manifestDir, 'packs'), entry.dir ?? `${entry.id}-${entry.version ?? ''}`);
    const buildFirstRunStatus = async () => {
      const freeBytes = resolveFreeRamBytes(process.env);
      const modelStatus =
        typeof engine.modelStatus === 'function' ? engine.modelStatus() : null;
      const engineName = modelStatus?.engine ?? 'unknown';
      const modelBytesFor = (profile: 'quality' | 'fast'): { path: string; bytes: number } | null => {
        const entry = modelStatus?.models?.[profile];
        if (entry === undefined || !entry.present || typeof entry.path !== 'string') return null;
        try {
          return { path: entry.path, bytes: statSync(entry.path).size };
        } catch {
          return null;
        }
      };
      const qualityBytes = modelBytesFor('quality');
      const fastBytes = modelBytesFor('fast');
      // One load+verify per status invocation: each wizardManifest() runs a
      // full sha256 pass over every required file, so callers share the result
      // (PRR-002) instead of hashing the manifest tree twice.
      const wm = wizardManifest();
      // RAM-gate sizes: the staged file's real size when present, otherwise
      // the manifest's declared size for the group (a quality model that has
      // not been staged yet still gets an honest gate at first run).
      const gateSizes = {
        qualityFileBytes:
          qualityBytes?.bytes ?? (wm.manifest !== null ? manifestGroupBytes(wm.manifest, 'llm-quality') : undefined),
        fastFileBytes:
          fastBytes?.bytes ?? (wm.manifest !== null ? manifestGroupBytes(wm.manifest, 'llm-fast') : undefined),
      };
      const recommendation = autoSelectProfile({
        freeBytes,
        nCtx: CONTEXT_SIZE,
        ...gateSizes,
      });
      const failures: ManifestFailure[] =
        wm.loadError !== null
          ? [
              {
                path: wm.manifestPath ?? 'resources/manifest.json',
                reason: 'manifest-unreadable',
                expected: 'a valid JSON resources manifest',
                actual: wm.loadError,
              },
            ]
          : (wm.verify?.failures ?? []);
      const packTools = (backendHost as NodeBackendHost | null | undefined)?.getFirstRunPackTools?.() ?? null;
      // #133: name WHY the pack lifecycle is down so the wizard's Complete
      // gate can say so instead of silently disabling the button.
      const packUnavailableReason =
        packTools === null
          ? ((backendHost as NodeBackendHost | null | undefined)?.getPackLifecycleStatus?.() ?? 'unavailable')
          : null;
      let installed: Array<{ id: string; version: string; active: boolean }> = [];
      if (packTools !== null) {
        try {
          installed = await packTools.listInstalled();
        } catch (err) {
          console.error(
            `[trainingapp-desktop] first-run pack snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const required = (wm.manifest?.packs ?? []).map((entry) => ({
        id: entry.id,
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        ...(entry.dir !== undefined ? { dir: entry.dir } : {}),
        resolvedDir:
          wm.manifest !== null && wm.manifestPath !== null
            ? packEntryDir(path.dirname(wm.manifestPath), entry)
            : null,
        // #133 round 8: the backend is the single source of truth for pack
        // satisfaction (installed+active at this version OR NEWER — semver via
        // isBundledPackSatisfied). The renderer's Complete gate consumes this
        // instead of re-deriving with a strict-equality check that soft-locked
        // the wizard when the operator's installed pack was newer than the
        // manifest's (the Documents-page update flow the UI itself advertises).
        satisfied: isBundledPackSatisfied(entry, installed),
      }));
      const licensesFile = licensesPath();
      const licensesAvailable = licensesFile !== null && existsSync(licensesFile);
      const licensesContent = licensesAvailable
        ? (() => {
            try {
              return readFileSync(licensesFile as string, 'utf8');
            } catch {
              return null;
            }
          })()
        : null;
      const state = loadFirstRunState(storePath);
      const force = process.env.TRAININGAPP_FIRST_RUN_FORCE === '1';
      const evaluation = evaluateStatus(state, {
        forced: force,
        manifestDigests: wm.staged && wm.verify !== null ? wm.verify.digests : null,
      });
      // Stub exemption (B9 precedent, desktop-session.tsx modelsAbsentForRealEngine):
      // the CI/dev stub must boot ungated unless the test force-seam is set.
      const needed = evaluation.needed && (engineName !== 'stub' || force);
      return {
        needed,
        reason: evaluation.reason,
        rerun: evaluation.reason === 'reset' || evaluation.reason === 'drift',
        engine: engineName,
        hardware: { freeBytes },
        profile: {
          recommended: recommendation.profile,
          warning: recommendation.warning ?? null,
          stored: state.firstRun.selectedProfile,
          contextSize: CONTEXT_SIZE,
          models: { quality: qualityBytes, fast: fastBytes },
        },
        manifest: {
          staged: wm.staged,
          packaged: app.isPackaged,
          failures,
          verifiedCount: wm.verify?.verifiedCount ?? 0,
        },
        packs: { toolsAvailable: packTools !== null, unavailableReason: packUnavailableReason, required, installed },
        licenses: {
          available: licensesAvailable,
          path: licensesAvailable ? licensesFile : null,
          content: licensesContent,
        },
        state: {
          completed: state.firstRun.completed,
          selectedProfile: state.firstRun.selectedProfile,
          completedAt: state.firstRun.completedAt,
          acknowledgedLicenses: state.firstRun.acknowledgedLicenses,
        },
      };
    };
    /**
     * Install every manifest-declared bundled pack that is not already
     * installed+active at the manifest version. Idempotent, safe to run on
     * every boot. Shared by the wizard's activate step (#85) and — #133
     * round 6 — by a boot-time ensure: a store that completed the wizard
     * BEFORE a pack was bundled never re-runs the wizard, so the wizard was
     * the only path that ever installed bundled content into existing
     * installs (the operator's Training tab stayed empty on the real store).
     */
    const ensureBundledPacks = async (): Promise<{
      ok: boolean;
      detail?: string;
      results: Array<{ id: string; ok: boolean; detail: string }>;
    }> => {
      const packTools = (backendHost as NodeBackendHost | null | undefined)?.getFirstRunPackTools?.() ?? null;
      if (packTools === null) {
        return { ok: false as const, detail: 'pack lifecycle unavailable (no store or embedder)', results: [] };
      }
      const wm = wizardManifest();
      if (wm.manifest === null || wm.manifestPath === null) {
        return {
          ok: false as const,
          detail: 'no integrity manifest is staged, so no packs are required (dev tree?)',
          results: [],
        };
      }
      const manifestDir = path.dirname(wm.manifestPath);
      const results: Array<{ id: string; ok: boolean; detail: string }> = [];
      for (const entry of wm.manifest.packs ?? []) {
        const dir = packEntryDir(manifestDir, entry);
        try {
          const installedNow = await packTools.listInstalled();
          const satisfied = isBundledPackSatisfied(entry, installedNow);
          if (satisfied) {
            results.push({ id: entry.id, ok: true, detail: 'already installed and active' });
            continue;
          }
          if (dir === null) {
            results.push({
              id: entry.id,
              ok: false,
              detail: `pack dir for ${entry.id} escapes the manifest packs directory (traversal refused)`,
            });
            continue;
          }
          if (!existsSync(dir)) {
            results.push({ id: entry.id, ok: false, detail: `staged pack folder is missing: ${dir}` });
            continue;
          }
          const installed = await packTools.install(dir);
          results.push({ id: installed.id, ok: true, detail: `installed ${installed.id}@${installed.version}` });
        } catch (err) {
          results.push({
            id: entry.id,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { ok: results.every((r) => r.ok), results };
    };
    const pushFirstRunRequired = (): void => {
      void buildFirstRunStatus()
        .then((status) => {
          if (!status.needed) return;
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('first-run:required', status);
          }
        })
        .catch((err: unknown) => {
          console.error(
            `[trainingapp-desktop] first-run status push failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    };
    ipcMain.handle('desktop:first-run:status', () => buildFirstRunStatus());
    ipcMain.handle(
      'desktop:first-run:activate-packs',
      async () => ensureBundledPacks(),
    );
    ipcMain.handle(
      'desktop:first-run:complete',
      async (_event, payload: unknown) => {
        try {
          const request = (typeof payload === 'object' && payload !== null ? payload : {}) as {
            selectedProfile?: unknown;
            acknowledgedLicenses?: unknown;
          };
          const acknowledgedLicenses = request.acknowledgedLicenses === true;
          const selectedProfile =
            request.selectedProfile === 'quality' || request.selectedProfile === 'fast'
              ? request.selectedProfile
              : null;
          if (selectedProfile === null) {
            return {
              ok: false as const,
              detail: 'select-profile: no profile was selected',
              reason: 'profile-not-selected' as const,
            };
          }
          // Fresh verification (TOCTOU guard): the operator may have completed
          // the wizard long after the status they saw was rendered.
          const status = await buildFirstRunStatus();
          const manifestOk = manifestCompletionState({
            packaged: status.manifest.packaged,
            staged: status.manifest.staged,
            failureCount: status.manifest.failures.length,
          });
          const inactiveRequiredPacks = status.packs.required
            .filter((entry) => !isBundledPackSatisfied(entry, status.packs.installed))
            .map((entry) => entry.id);
          assertCanComplete({
            selectedProfile,
            acknowledgedLicenses,
            manifestOk,
            inactiveRequiredPacks,
          });
          const wm = wizardManifest();
          saveFirstRunState(storePath, {
            firstRun: {
              completed: true,
              selectedProfile: selectedProfile as 'quality' | 'fast',
              completedAt: new Date().toISOString(),
              acknowledgedLicenses,
              manifestDigests: wm.verify?.digests ?? {},
            },
          });
          // #133: the operator's profile choice must reach the ENGINE, not
          // just first-run state — apply it through the validated settings
          // seam (live reconfigure + sidecar persistence) so the first /ask
          // loads the chosen model. Non-fatal on refusal (completion stands;
          // Settings can still change it) but logged loudly by name.
          const profileApplied = (backendHost as NodeBackendHost | null | undefined)?.applyEngineSettings?.({
            'inference.profile': selectedProfile,
          });
          if (profileApplied !== undefined && !profileApplied.ok) {
            console.error(
              `[trainingapp-desktop] first-run profile could not be applied to the engine: ${profileApplied.detail}`,
            );
          }
          return { ok: true as const };
        } catch (err) {
          if (err instanceof WizardBlockError) return { ok: false as const, detail: err.message, reason: err.reason };
          return { ok: false as const, detail: err instanceof Error ? err.message : String(err) };
        }
      },
    );
    ipcMain.handle('desktop:first-run:reset', () => {
      saveFirstRunState(storePath, EMPTY_FIRST_RUN_STATE());
      pushFirstRunRequired();
      return { ok: true as const };
    });
    // Fire the push once so a needed first run surfaces without renderer polling.
    pushFirstRunRequired();
    // #133 round 6: a store that completed the wizard before a pack was
    // bundled never sees that pack (the wizard was the only installer) —
    // ensure the manifest's bundled packs on every completed boot. Idempotent
    // (skips packs already installed+active); fire-and-forget with named logs,
    // same discipline as the engine boot warmup.
    if (loadFirstRunState(storePath).firstRun.completed) {
      void ensureBundledPacks()
        .then((r) => {
          const installedNow = r.results.filter((x) => x.ok && x.detail.startsWith('installed '));
          const failed = r.results.filter((x) => !x.ok);
          if (installedNow.length > 0) {
            console.log(
              `[trainingapp-desktop] bundled packs ensured at boot: ${installedNow.map((x) => x.detail).join('; ')}`,
            );
          }
          if (failed.length > 0) {
            console.error(
              `[trainingapp-desktop] bundled pack ensure failed: ${failed.map((x) => `${x.id}: ${x.detail}`).join('; ')}`,
            );
          }
          // Early exits (no pack lifecycle / no staged manifest) return no
          // results — name the skip instead of failing silently (round-7
          // review note). Dev trees without a manifest hit this every boot.
          if (installedNow.length === 0 && failed.length === 0 && r.detail !== undefined) {
            console.log(`[trainingapp-desktop] bundled pack ensure skipped: ${r.detail}`);
          }
        })
        .catch((err) => {
          console.error(
            `[trainingapp-desktop] bundled pack ensure crashed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    let quitting = false;
    app.on('will-quit', (event) => {
      if (quitting || backendHost === null) return;
      // HOLD the quit until backend shutdown completes: stop() runs the
      // sidecar graceful-then-kill sequence (grace windows are real time),
      // and an unawaited stop let Electron exit mid-cleanup, orphaning the
      // child. preventDefault + app.quit() after stop() resumes the quit;
      // the re-entrant will-quit passes through via `quitting`.
      quitting = true;
      event?.preventDefault();
      void backendHost.stop().finally(() => app.quit());
    });
    // NOTE: in dev mode the app:// handler is intentionally NOT registered
    // (the vite dev server serves the renderer), so an app:// target allowed
    // by the navigation policy below would fail to load in dev. Production
    // mode registers both, so policy and handler are always consistent there.
    // Dev mode loads the vite dev server and needs no packaged renderer.
    if (devStartUrl() === undefined) {
      const root = resolveRendererRoot();
      if (!existsSync(root)) {
        // Fail fast and audibly rather than booting a half-broken window.
        console.error(`[trainingapp-desktop] renderer resources missing at ${root}; reinstall the app`);
        app.quit();
        return;
      }
      registerAppProtocol({ root, packsDir: resolvePacksRoot() });
    }
    createMainWindow();
  }).catch((err: unknown) => {
    console.error('[trainingapp-desktop] startup failure:', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// Self-start only inside a real Electron main process ("browser"). Under
// vitest (node) or ELECTRON_RUN_AS_NODE, process.type is undefined and
// importing this module stays side-effect free for the specs.
if (process.type === 'browser') {
  bootstrap();
}
