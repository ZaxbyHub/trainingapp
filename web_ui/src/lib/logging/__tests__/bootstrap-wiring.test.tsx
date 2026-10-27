/**
 * bootstrap-wiring.test.tsx — issue #248: the side-effect install module's
 * contract. The install runs at MODULE EVALUATION (main.tsx imports it
 * first), wraps the console, captures window errors/rejections, resolves the
 * level (browser: synchronous persisted-key read; Electron: getState() with a
 * pending pre-gate buffer admitted per the resolved level), and emits the
 * renderer startup entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DIAGNOSTICS_ENHANCED_KEY } from '../../storage/persisted-keys';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Fresh module instances with a console snapshot captured before install. */
async function importFresh() {
  vi.resetModules();
  const core = await import('../index');
  const install = await import('../install');
  return { core, install };
}

let savedConsole: Record<string, (typeof console)['log']> = {};

beforeEach(() => {
  // Snapshot the console so every test can remove the wrapper afterwards —
  // each fresh module instance wraps the CURRENT methods at ITS install.
  savedConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  localStorage.clear();
  delete (window as { desktopApi?: unknown }).desktopApi;
});

afterEach(() => {
  console.log = savedConsole.log as typeof console.log;
  console.info = savedConsole.info as typeof console.info;
  console.debug = savedConsole.debug as typeof console.debug;
  console.warn = savedConsole.warn as typeof console.warn;
  console.error = savedConsole.error as typeof console.error;
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
  delete (window as { desktopApi?: unknown }).desktopApi;
});

function silenceConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

describe('renderer bootstrap wiring', () => {
  it('main.tsx imports the install module as its FIRST import (side-effect ordering)', () => {
    const source = fs.readFileSync(path.join(THIS_DIR, '..', '..', '..', 'main.tsx'), 'utf8');
    const imports = source.match(/^import[^\n]*;/gm) ?? [];
    expect(imports[0], 'the diagnostics install must evaluate before every runtime import').toMatch(
      /['"]\.\/lib\/logging\/install['"]/,
    );
  });

  it('importing the module installs the console wrapper and emits the renderer startup entry', async () => {
    const spies = silenceConsole();
    const { core } = await importFresh();
    // Spy-first: the wrapper captured the SPIES, so raw passthrough is visible
    // to them and silent in the test output.
    console.log('[boot] dependency-evaluation line');
    expect(spies.log).toHaveBeenCalledWith('[boot] dependency-evaluation line');
    const messages = core.admittedEntries().map((e) => e.message);
    expect(messages).toContain('renderer startup');
    expect(messages).toContain('[boot] dependency-evaluation line');
  });

  it('a second install call is a no-op (StrictMode/module-evaluation idempotency)', async () => {
    silenceConsole();
    const { install } = await importFresh();
    const afterImport = console.log;
    install.installDiagnosticsLogging();
    expect(console.log).toBe(afterImport);
  });

  it('browser: the persisted key is read synchronously before the first gated entry', async () => {
    silenceConsole();
    localStorage.setItem(DIAGNOSTICS_ENHANCED_KEY, '1');
    const { core } = await importFresh();
    expect(core.enhancedLoggingEnabled()).toBe(true);
    console.debug('[boot] enhanced debug entry');
    const messages = core.admittedEntries().map((e) => e.message);
    expect(messages).toContain('[boot] enhanced debug entry');
    // '0' and absent both mean the default level.
    localStorage.setItem(DIAGNOSTICS_ENHANCED_KEY, '0');
    const second = await importFresh();
    expect(second.core.enhancedLoggingEnabled()).toBe(false);
  });

  it('electron: pre-state entries buffer and admit per the resolved level (enhanced restart retains debug)', async () => {
    const spies = silenceConsole();
    let resolveState: (value: { active: boolean; enhanced: boolean }) => void = () => undefined;
    const bridge = {
      getState: vi.fn(
        () =>
          new Promise<{ active: boolean; enhanced: boolean }>((resolve) => {
            resolveState = resolve;
          }),
      ),
      setEnhancedLevel: vi.fn(async () => ({ ok: true })),
      logEntry: vi.fn(async (_entry: unknown) => ({ ok: true })),
      exportDiagnostics: vi.fn(async () => ({ ok: true, path: 'x' })),
    };
    (window as { desktopApi?: unknown }).desktopApi = { diagnostics: bridge };
    const { core } = await importFresh();
    expect(bridge.getState).toHaveBeenCalledTimes(1);
    console.debug('[boot] early debug entry');
    console.info('[boot] early info entry');
    expect(core.admittedEntries()).toEqual([]);
    resolveState({ active: true, enhanced: true });
    await vi.waitFor(() => expect(core.admittedEntries().length).toBeGreaterThan(0));
    const messages = core.admittedEntries().map((e) => e.message);
    expect(messages).toContain('[boot] early debug entry');
    expect(messages).toContain('[boot] early info entry');
    expect(messages).toContain('renderer startup');
    // The forwarder became active: the startup entry flows to main.
    await vi.waitFor(() => expect(bridge.logEntry).toHaveBeenCalled());
    expect((bridge.logEntry.mock.calls[0]?.[0] as unknown as { message: string }).message).toBe('renderer startup');
    void spies;
  });

  it('electron: a default restart drops buffered debug entries (default-restart drop)', async () => {
    silenceConsole();
    const bridge = {
      getState: vi.fn(async () => ({ active: true, enhanced: false })),
      setEnhancedLevel: vi.fn(async () => ({ ok: true })),
      logEntry: vi.fn(async (_entry: unknown) => ({ ok: true })),
      exportDiagnostics: vi.fn(async () => ({ ok: true, path: 'x' })),
    };
    (window as { desktopApi?: unknown }).desktopApi = { diagnostics: bridge };
    const { core } = await importFresh();
    console.debug('[boot] early debug entry');
    console.info('[boot] early info entry');
    await vi.waitFor(() => expect(core.admittedEntries().length).toBeGreaterThan(0));
    const messages = core.admittedEntries().map((e) => e.message);
    expect(messages).not.toContain('[boot] early debug entry');
    expect(messages).toContain('[boot] early info entry');
  });

  it('electron: a failed getState falls back to the default level and still admits the buffer', async () => {
    silenceConsole();
    const bridge = {
      getState: vi.fn(async () => {
        throw new Error('ipc not ready');
      }),
      setEnhancedLevel: vi.fn(async () => ({ ok: true })),
      logEntry: vi.fn(async (_entry: unknown) => ({ ok: true })),
      exportDiagnostics: vi.fn(async () => ({ ok: true, path: 'x' })),
    };
    (window as { desktopApi?: unknown }).desktopApi = { diagnostics: bridge };
    const { core } = await importFresh();
    console.info('[boot] info entry during pre-state');
    await vi.waitFor(() => expect(core.admittedEntries().length).toBeGreaterThan(0));
    expect(core.admittedEntries().map((e) => e.message)).toContain('[boot] info entry during pre-state');
    expect(core.enhancedLoggingEnabled()).toBe(false);
  });

  it('window error and unhandledrejection listeners route through the logger (semantics-preserving)', async () => {
    const spies = silenceConsole();
    await importFresh();
    const errorEvent = new ErrorEvent('error', { message: 'renderer exploded', filename: 'app://index.html', lineno: 7 });
    window.dispatchEvent(errorEvent);
    // jsdom has no PromiseRejectionEvent constructor; the listener only reads
    // `reason`, so a plain event carrying the field exercises it.
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('unhandled boom');
    window.dispatchEvent(rejection);
    expect(spies.error).toHaveBeenCalledWith(
      'window error:',
      'renderer exploded',
      'at app://index.html:7',
    );
    expect(spies.error).toHaveBeenCalledWith('unhandled rejection:', 'Error: unhandled boom');
  });

  it('cross-platform leakage negative: a desktop-pinned-shaped line is [sanitized] on the renderer console', async () => {
    const spies = silenceConsole();
    await importFresh();
    const sha = 'deadbeef'.repeat(8);
    console.warn(`[pack-manager] versioned-a@2.0.0: no live chunks for doc ${sha}; row deactivated`);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(String(spies.warn.mock.calls[0]?.[0])).toMatch(/^\[sanitized\] /);
    expect(String(spies.warn.mock.calls[0]?.[0])).not.toContain(sha);
  });
});
