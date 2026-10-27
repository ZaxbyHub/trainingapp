// diagnostics-logging.test.ts — issue #248 (collated batch 248-41): the
// desktop logging core's file transport, level toggle, export bundle, and
// capture wiring. This file is the landing target of the frozen acceptance
// checks C1 (default-file-logging), C2 (enhanced-level), C3 (export-bundle)
// and C6 (capture-handlers) — those tokens appear in every group's test
// titles, so `vitest run <this-file> -t <token>` selects exactly one group.
//
// The spec drives the REAL desktop/main/logging.ts against the shared
// in-memory electron stub (dialog/ipcMain/app), a temp userData/profile
// layout, and the real diagnostics-settings sidecar — no reimplementation of
// the module under test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { __resetElectronStub as resetStub } from '../../test/electron-stub.js';

import {
  __diagnosticsStateForTests,
  __resetLoggingForTests,
  activateDiagnosticsLogging,
  attachRendererCapture,
  installLoggingConsoleWrapper,
} from '../../main/logging.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Workspace {
  userDataPath: string;
  profileDir: string;
  storePath: string;
  logPath: string;
}

/** Fresh userData + profile layout and silenced console spies (spy-FIRST). */
function makeWorkspace(prefix: string): Workspace & { spies: ReturnType<typeof silenceConsole> } {
  const root = makeTempDir(prefix);
  tempDirs.push(root);
  const userDataPath = path.join(root, 'userData');
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const storePath = path.join(profileDir, 'store.sqlite');
  const spies = silenceConsole();
  installLoggingConsoleWrapper();
  return { userDataPath, profileDir, storePath, logPath: path.join(userDataPath, 'logs', 'main.log'), spies };
}

/** Attach silencing spies BEFORE the wrapper installs (composition ordering). */
function silenceConsole() {
  const spies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  return spies;
}

function readLog(ws: { logPath: string }): string {
  return fs.readFileSync(ws.logPath, 'utf8');
}

function logLines(ws: { logPath: string }): string[] {
  return readLog(ws).split('\n').filter((line) => line !== '');
}

// The 'electron' import is the vitest alias at runtime; tsc sees the real
// typings, so the stub's vi.fn surfaces are reached through Mock casts.
const ipcMainHandle = ipcMain.handle as unknown as Mock;
const showSaveDialog = dialog.showSaveDialog as unknown as Mock;

/** The handler registered for an IPC channel (the stub records every call). */
function handlerFor(channel: string): (event: unknown, payload?: unknown) => unknown {
  const call = ipcMainHandle.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) throw new Error(`no handler registered for ${channel}`);
  return call[1] as (event: unknown, payload?: unknown) => unknown;
}

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level: 'info',
    scope: 'boot',
    message: 'renderer startup',
    sessionId: 'sess-1',
    seq: 1,
    ...overrides,
  };
}

beforeEach(() => {
  resetStub();
});

afterEach(() => {
  // Ordering contract (composition spec): the wrapper is removed BEFORE
  // vi.restoreAllMocks, so the mocks restore to the true console methods.
  __resetLoggingForTests();
  vi.restoreAllMocks();
  resetStub();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C1 (AC1): default file logging — no user configuration, info level
// ---------------------------------------------------------------------------
describe('diagnostics default-file-logging (AC1: rotated log under <userData>/logs)', () => {
  it('default-file-logging: activation writes buffered pre-activation lines and the main boot entry at info level', () => {
    const ws = makeWorkspace('diag-c1-boot-');
    console.log('[test] clean line before activation');
    // No sidecar exists: the default level is info with no configuration.
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    console.warn('[test] clean line after activation');

    const lines = logLines(ws);
    const lineShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (info|warn|error|debug) \[[^\]]+\] .*$/;
    for (const line of lines) expect(line, `file line shape: ${line}`).toMatch(lineShape);
    const bootIndex = lines.findIndex((line) => line.endsWith('info [boot] main boot'));
    expect(bootIndex, 'the main boot entry is written').toBeGreaterThan(-1);
    const preIndex = lines.findIndex((line) => line.endsWith('[console] [test] clean line before activation'));
    const postIndex = lines.findIndex((line) => line.endsWith('[console] [test] clean line after activation'));
    expect(preIndex, 'phase-1 buffered line flushed in order').toBeGreaterThan(-1);
    expect(preIndex).toBeLessThan(bootIndex);
    expect(postIndex).toBeGreaterThan(bootIndex);
    // AC7 companion: clean console lines pass through RAW (original args).
    expect(ws.spies.log).toHaveBeenCalledWith('[test] clean line before activation');
    expect(ws.spies.warn).toHaveBeenCalledWith('[test] clean line after activation');
  });

  it('default-file-logging: debug console lines are excluded at the default info level (admitted-only ring/file)', () => {
    const ws = makeWorkspace('diag-c1-debug-');
    console.debug('[test] debug line before activation');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    console.debug('[test] debug line after activation');
    const log = readLog(ws);
    expect(log).not.toContain('debug line');
    // Debug still reaches the console (semantics-preserving wrapper).
    expect(ws.spies.debug).toHaveBeenCalledWith('[test] debug line after activation');
  });

  it('default-file-logging: a process that never reaches activation (second instance) writes no log files', () => {
    const root = makeTempDir('diag-c1-second-');
    tempDirs.push(root);
    const spies = silenceConsole();
    installLoggingConsoleWrapper();
    console.error('[second-instance] short-lived line');
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false);
    expect(__diagnosticsStateForTests().active).toBe(false);
    expect(__diagnosticsStateForTests().phase1Buffered).toBe(1);
    expect(spies.error).toHaveBeenCalledWith('[second-instance] short-lived line');
  });

  it('default-file-logging: rotation happens before the exceeding write (5 MiB chain, pre-existing rotations)', () => {
    const ws = makeWorkspace('diag-c1-rotate-');
    fs.mkdirSync(path.dirname(ws.logPath), { recursive: true });
    // Seed main.log close under the cap (the boot entry fits, a large console
    // line crosses) plus pre-existing rotations.
    const justUnder = Buffer.alloc(5 * 1024 * 1024 - 512, 0x61).toString('utf8');
    fs.writeFileSync(ws.logPath, justUnder);
    fs.writeFileSync(path.join(ws.userDataPath, 'logs', 'main.log.1'), 'rotation-one');
    fs.writeFileSync(path.join(ws.userDataPath, 'logs', 'main.log.2'), 'rotation-two');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // The boot entry fit under the cap; the long line crosses it ('z' padding:
    // a hex run would be redacted away before the byte count sees it).
    console.log(`[test] crossing write ${'z'.repeat(1024)}`);
    expect(fs.readFileSync(path.join(ws.userDataPath, 'logs', 'main.log.2'), 'utf8')).toBe('rotation-one');
    const rotated = fs.readFileSync(path.join(ws.userDataPath, 'logs', 'main.log.1'), 'utf8');
    expect(rotated).toContain('main boot');
    expect(fs.readFileSync(ws.logPath, 'utf8')).toContain('crossing write');
  });
});

// ---------------------------------------------------------------------------
// C2 (AC2): the Enhanced logging toggle — live level change, persistence
// ---------------------------------------------------------------------------
describe('diagnostics enhanced-level (AC2: persisted live info->debug toggle)', () => {
  it('enhanced-level: an enhanced-restart sidecar retains a pre-activation debug entry and admits debug afterwards', () => {
    const ws = makeWorkspace('diag-c2-restart-');
    fs.writeFileSync(
      path.join(ws.profileDir, 'diagnostics-settings.json'),
      JSON.stringify({ enhancedLogging: true }, null, 2),
      'utf8',
    );
    console.debug('[test] pre-whenReady debug entry');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    console.debug('[test] post-activation debug entry');
    const log = readLog(ws);
    expect(log).toContain('[test] pre-whenReady debug entry');
    expect(log).toContain('[test] post-activation debug entry');
  });

  it('enhanced-level: set-enhanced-level flips the live level both ways without a restart and persists the sidecar', () => {
    const ws = makeWorkspace('diag-c2-flip-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const setState = handlerFor('desktop:diagnostics:set-enhanced-level');
    const getState = handlerFor('desktop:diagnostics:get-state');
    expect(getState(undefined)).toEqual({ active: true, enhanced: false });

    expect(setState(undefined, true)).toEqual({ ok: true, enhanced: true });
    console.debug('[test] debug while enhanced');
    expect(readLog(ws)).toContain('[test] debug while enhanced');
    expect(JSON.parse(fs.readFileSync(path.join(ws.profileDir, 'diagnostics-settings.json'), 'utf8'))).toEqual({
      enhancedLogging: true,
    });

    expect(setState(undefined, false)).toEqual({ ok: true, enhanced: false });
    console.debug('[test] debug after toggle off');
    expect(readLog(ws)).not.toContain('[test] debug after toggle off');
    expect(getState(undefined)).toEqual({ active: true, enhanced: false });
  });

  it('enhanced-level: a persistence failure reverts to the previous level and answers a typed error', () => {
    const ws = makeWorkspace('diag-c2-revert-');
    // A DIRECTORY at the sidecar path: reads corrupt (defaults), writes fail.
    fs.mkdirSync(path.join(ws.profileDir, 'diagnostics-settings.json'));
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const setState = handlerFor('desktop:diagnostics:set-enhanced-level');
    const reply = setState(undefined, true) as { ok: boolean; detail?: string };
    expect(reply.ok).toBe(false);
    expect(reply.detail ?? '').toContain('could not persist');
    // Reverted: debug entries stay excluded.
    console.debug('[test] debug after failed persist');
    expect(readLog(ws)).not.toContain('[test] debug after failed persist');
  });
});

// ---------------------------------------------------------------------------
// C3 (AC3): the export bundle
// ---------------------------------------------------------------------------
describe('diagnostics export-bundle (AC3: gated bundle to a user-chosen path)', () => {
  it('export-bundle: writes the gated log, sidecars and adapter summary to the chosen destination', () => {
    const ws = makeWorkspace('diag-c3-ok-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // Flip the toggle once so the diagnostics sidecar exists on disk too.
    handlerFor('desktop:diagnostics:set-enhanced-level')(undefined, true);
    console.error('[test] export probe password=hunter2 token=abc123def456');
    const dest = path.join(ws.profileDir, '..', 'bundle.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    const reply = handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; path?: string }>;
    return reply.then((result) => {
      expect(result.ok).toBe(true);
      const bundle = JSON.parse(fs.readFileSync(dest, 'utf8')) as {
        version: number;
        level: string;
        logs: Record<string, string>;
        sidecars: Record<string, string>;
        adapterSummary: Record<string, unknown>;
      };
      expect(bundle.version).toBe(1);
      expect(bundle.level).toBe('debug');
      // Gated: the persisted log line is redacted on BOTH surfaces.
      expect(bundle.logs['main.log']).toContain('main boot');
      expect(bundle.logs['main.log']).toContain('password=[redacted]');
      expect(bundle.logs['main.log']).toContain('token=[redacted]');
      expect(bundle.logs['main.log']).not.toContain('hunter2');
      expect(readLog(ws)).not.toContain('hunter2');
      expect(bundle.sidecars['diagnostics-settings.json']).toContain('"enhancedLogging"');
      expect(bundle.sidecars['settings.json']).toMatch(/<<missing or unreadable: settings\.json>>/);
      expect(bundle.adapterSummary).toMatchObject({ available: false });
    });
  });

  it('export-bundle: a destination canonically equal to a live file is rejected and the file is untouched', () => {
    const ws = makeWorkspace('diag-c3-live-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const before = readLog(ws);
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: ws.logPath } as never);
    return (handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; error?: string }>).then(
      (reply) => {
        expect(reply).toEqual({ ok: false, error: 'live-destination' });
        expect(readLog(ws)).toBe(before);
      },
    );
  });

  it('export-bundle: a dismissed dialog answers {cancelled:true} and writes nothing', () => {
    const ws = makeWorkspace('diag-c3-cancel-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    showSaveDialog.mockResolvedValue({ canceled: true } as never);
    return (handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ cancelled?: boolean }>).then((reply) => {
      expect(reply).toEqual({ cancelled: true });
      expect(fs.readdirSync(path.join(ws.profileDir, '..'))).not.toContain('bundle.json');
    });
  });

  it('export-bundle: a write failure cleans the tmp file, leaves the destination untouched and answers a typed error', () => {
    const ws = makeWorkspace('diag-c3-fail-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // A DIRECTORY as the destination: the tmp write succeeds, the rename onto
    // the directory fails — exercising tmp cleanup with the destination kept.
    const dest = path.join(ws.profileDir, '..', 'dest-dir');
    fs.mkdirSync(dest);
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    return (handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; error?: string }>).then(
      (reply) => {
        expect(reply.ok).toBe(false);
        expect(typeof reply.error).toBe('string');
        expect(fs.statSync(dest).isDirectory()).toBe(true);
        const leftovers = fs.readdirSync(path.dirname(dest)).filter((name) => name.includes('.tmp'));
        expect(leftovers).toEqual([]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// C6 (AC6): automatic capture of crashes, load events and IPC ingest
// ---------------------------------------------------------------------------
describe('diagnostics capture-handlers (AC6: unhandled errors and Electron crash events)', () => {
  it('capture-handlers: uncaughtExceptionMonitor entries reach the file transport', () => {
    const ws = makeWorkspace('diag-c6-monitor-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    process.emit('uncaughtExceptionMonitor', new Error('probe failure'));
    const log = readLog(ws);
    expect(log).toContain('error [process] uncaught exception: Error: probe failure');
  });

  it('capture-handlers: child-process-gone GPU crashes are errors; other child exits are debug-gated', () => {
    const ws = makeWorkspace('diag-c6-child-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
    app.emit('child-process-gone', {}, { type: 'Utility', reason: 'oom' });
    const log = readLog(ws);
    expect(log).toContain('GPU process crashed');
    expect(log).not.toContain('Utility');
  });

  it('capture-handlers: render-process-gone and preload-error are captured once per window; did-fail-load is not double-wired', () => {
    const ws = makeWorkspace('diag-c6-renderer-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // A fresh stub window with recordable webContents handlers.
    const window = new BrowserWindow({});
    attachRendererCapture(window);
    const registered = (window.webContents.on as unknown as Mock).mock.calls as Array<
      [string, (...a: unknown[]) => void]
    >;
    const channels = registered.map(([channel]) => channel).sort();
    expect(channels).toEqual(['preload-error', 'render-process-gone']);
    const gone = registered.find(([channel]) => channel === 'render-process-gone')?.[1];
    const preload = registered.find(([channel]) => channel === 'preload-error')?.[1];
    gone?.({}, { reason: 'oom', exitCode: 3 });
    preload?.({}, path.join(ws.profileDir, 'preload.cjs'), new Error('preload boom'));
    const log = readLog(ws);
    expect(log).toContain('renderer process gone: oom (exitCode 3)');
    expect(log).toContain('preload error at');
    expect(log).toContain('Error: preload boom');
  });

  it('capture-handlers: log-entry ingest validates, gates, appends in order, dedupes and acks', async () => {
    const ws = makeWorkspace('diag-c6-ingest-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const ingest = handlerFor('desktop:diagnostics:log-entry');

    const ack = (await ingest(undefined, validEntry())) as { ok: boolean; dup?: boolean };
    expect(ack).toEqual({ ok: true });
    // Ack lost after write: the duplicate re-acks and never rewrites.
    const dup = (await ingest(undefined, validEntry())) as { ok: boolean; dup?: boolean };
    expect(dup).toEqual({ ok: true, dup: true });
    expect(logLines(ws).filter((line) => line.endsWith('renderer startup'))).toHaveLength(1);

    const seq2 = (await ingest(undefined, validEntry({ seq: 2, message: 'second entry', level: 'warn' }))) as {
      ok: boolean;
    };
    expect(seq2.ok).toBe(true);
    const lines = logLines(ws);
    expect(lines.findIndex((l) => l.endsWith('renderer startup'))).toBeLessThan(
      lines.findIndex((l) => l.endsWith('second entry')),
    );

    // Debug entries are gated at the main sink at the default level.
    const debugAck = (await ingest(undefined, validEntry({ seq: 3, level: 'debug', message: 'dbg' }))) as {
      ok: boolean;
      dropped?: string;
    };
    expect(debugAck).toEqual({ ok: true, dropped: 'level' });
    expect(readLog(ws)).not.toContain('dbg');

    // Malformed entries are dropped and counted, never thrown.
    const malformed = (await ingest(undefined, { level: 'loud', scope: 'x', message: 'y' })) as { ok: boolean };
    expect(malformed.ok).toBe(false);
    const oversized = (await ingest(undefined, validEntry({ seq: 4, message: 'x'.repeat(8001) }))) as { ok: boolean };
    expect(oversized.ok).toBe(false);
    expect(__diagnosticsStateForTests().droppedMalformed).toBe(2);
  });
});
