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
    // PRR-014: an EMPTY rendered line passes through to the console but never
    // becomes a file entry (agrees with the IPC validator's rejection).
    const linesBeforeEmpty = logLines(ws).length;
    console.log('');
    console.log();
    expect(logLines(ws).length).toBe(linesBeforeEmpty);

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
    // PRR-001: the quit-flush's `active === false` guard is exactly the
    // second-instance condition, so the flush must additionally require THIS
    // process to own the single-instance lock — a second instance may never
    // append to the primary's log. The real Electron surface is
    // app.hasSingleInstanceLock() (verified against electron.d.ts); the stub
    // does not model it, so the test injects it (and removes the injection
    // in the finally).
    const stubLogsDir = path.join(app.getPath('userData'), 'logs');
    fs.rmSync(stubLogsDir, { recursive: true, force: true });
    const lockSurface = app as { hasSingleInstanceLock?: () => boolean };
    const originalLock = lockSurface.hasSingleInstanceLock;
    lockSurface.hasSingleInstanceLock = () => false;
    const spies = silenceConsole();
    try {
      installLoggingConsoleWrapper();
      console.error('[second-instance] short-lived line');
      expect(__diagnosticsStateForTests().active).toBe(false);
      expect(__diagnosticsStateForTests().phase1Buffered).toBe(1);
      expect(spies.error).toHaveBeenCalledWith('[second-instance] short-lived line');
      // The quit-flush fires on will-quit and must SKIP: this process does
      // not own the primary role (asserted on app.getPath('userData')/logs —
      // the directory the flush actually writes to).
      app.emit('will-quit');
      expect(fs.existsSync(path.join(stubLogsDir, 'main.log'))).toBe(false);
      expect(fs.existsSync(stubLogsDir)).toBe(false);
    } finally {
      if (originalLock === undefined) delete lockSurface.hasSingleInstanceLock;
      else lockSurface.hasSingleInstanceLock = originalLock;
    }
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
    // PRR-003 (fix-review caught): a SUCCESSFUL rotation must restart the byte
    // counter — the counter is stat-consistent with the fresh file, and a
    // second ordinary write must NOT rotate again (a stale counter would churn
    // a generation per write and destroy history).
    expect(__diagnosticsStateForTests().byteCount).toBe(fs.statSync(ws.logPath).size);
    const before = fs.readFileSync(path.join(ws.userDataPath, 'logs', 'main.log.1'), 'utf8');
    console.log('[test] second ordinary write after the rotation');
    expect(fs.readFileSync(path.join(ws.userDataPath, 'logs', 'main.log.1'), 'utf8')).toBe(before);
    expect(fs.readFileSync(ws.logPath, 'utf8')).toContain('second ordinary write');
  });

  it('default-file-logging: a failed rotation keeps the history, resyncs the counter, warns once and retries on the next write', () => {
    const ws = makeWorkspace('diag-c1-rotfail-');
    fs.mkdirSync(path.dirname(ws.logPath), { recursive: true });
    const justUnder = Buffer.alloc(5 * 1024 * 1024 - 512, 0x61).toString('utf8');
    fs.writeFileSync(ws.logPath, justUnder);
    fs.writeFileSync(path.join(ws.userDataPath, 'logs', 'main.log.1'), 'rotation-one');
    // PRR-003: a DIRECTORY at main.log.2 is a rename obstacle — the .1 -> .2
    // step fails and the chain must abort WITHOUT renaming main.log away.
    fs.mkdirSync(path.join(ws.userDataPath, 'logs', 'main.log.2'));
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const rotationWarnCalls = () =>
      ws.spies.error.mock.calls.filter((call) => String(call[0]).includes('log rotation failed')).length;

    // The boot entry fit; the crossing line trips the rotation, which fails.
    console.log(`[test] crossing write ${'z'.repeat(1024)}`);
    // History kept: .1 intact, the obstacle untouched, main.log NOT renamed away.
    expect(fs.readFileSync(path.join(ws.userDataPath, 'logs', 'main.log.1'), 'utf8')).toBe('rotation-one');
    expect(fs.statSync(path.join(ws.userDataPath, 'logs', 'main.log.2')).isDirectory()).toBe(true);
    // The entry still appended (a rotation failure must not lose the write).
    expect(readLog(ws)).toContain('crossing write');
    // The counter RESYNCED to the surviving file instead of deferring another
    // 5 MiB, so the next write retries the rotation.
    expect(__diagnosticsStateForTests().byteCount).toBe(fs.statSync(ws.logPath).size);
    expect(__diagnosticsStateForTests().rotationWarned).toBe(true);
    expect(rotationWarnCalls()).toBe(1);

    // A second crossing write retries the rotation (still failing) — and the
    // one-per-session warn does NOT fire again.
    console.log(`[test] crossing write two ${'z'.repeat(1024)}`);
    expect(readLog(ws)).toContain('crossing write two');
    expect(__diagnosticsStateForTests().byteCount).toBe(fs.statSync(ws.logPath).size);
    expect(rotationWarnCalls()).toBe(1);
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
    expect(getState(undefined)).toEqual({ active: true, enhanced: false, sinkHealthy: true });

    expect(setState(undefined, true)).toEqual({ ok: true, enhanced: true });
    console.debug('[test] debug while enhanced');
    expect(readLog(ws)).toContain('[test] debug while enhanced');
    expect(JSON.parse(fs.readFileSync(path.join(ws.profileDir, 'diagnostics-settings.json'), 'utf8'))).toEqual({
      enhancedLogging: true,
    });

    expect(setState(undefined, false)).toEqual({ ok: true, enhanced: false });
    console.debug('[test] debug after toggle off');
    expect(readLog(ws)).not.toContain('[test] debug after toggle off');
    expect(getState(undefined)).toEqual({ active: true, enhanced: false, sinkHealthy: true });
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
    // PRR-035: the failure detail never carries the absolute profile path.
    expect(reply.detail ?? '').not.toContain(ws.profileDir);
    expect(reply.detail ?? '').toContain('<path>');
    // Reverted: debug entries stay excluded.
    console.debug('[test] debug after failed persist');
    expect(readLog(ws)).not.toContain('[test] debug after failed persist');
  });

  it('enhanced-level: activation sweeps orphaned diagnostics-settings tmp files (own pattern only)', () => {
    const ws = makeWorkspace('diag-c2-sweep-');
    // PRR-044: a hard kill between the tmp write and the rename strands OUR
    // tmp files in the profile dir; activation sweeps exactly that pattern.
    const own1 = path.join(ws.profileDir, 'diagnostics-settings.json.4242.ab12.tmp');
    const own2 = path.join(ws.profileDir, 'diagnostics-settings.json.9900.zz99.tmp');
    fs.writeFileSync(own1, 'orphan');
    fs.writeFileSync(own2, 'orphan');
    const foreignName = path.join(ws.profileDir, 'not-ours.json.123.ab.tmp');
    const noPidName = path.join(ws.profileDir, 'diagnostics-settings.json.tmp');
    fs.writeFileSync(foreignName, 'keep');
    fs.writeFileSync(noPidName, 'keep');
    fs.writeFileSync(
      path.join(ws.profileDir, 'diagnostics-settings.json'),
      JSON.stringify({ enhancedLogging: true }, null, 2),
      'utf8',
    );
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    expect(fs.existsSync(own1)).toBe(false);
    expect(fs.existsSync(own2)).toBe(false);
    expect(fs.readFileSync(foreignName, 'utf8')).toBe('keep');
    expect(fs.readFileSync(noPidName, 'utf8')).toBe('keep');
    // The live sidecar still read: enhanced restart behavior intact.
    expect(__diagnosticsStateForTests().enhanced).toBe(true);
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
    // QUOTED kv values (the corpus-pinned shape where each pair redacts
    // individually; a bare value now redacts the whole remainder, per the
    // coordinated redaction-twin change).
    console.error('[test] export probe password="hunter2" token="abc123def456"');
    const dest = path.join(path.dirname(ws.profileDir), 'bundle.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    const reply = handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; path?: string }>;
    return reply.then((result) => {
      expect(result.ok).toBe(true);
      const bundle = JSON.parse(fs.readFileSync(dest, 'utf8')) as {
        version: number;
        platform: string;
        levelAtExport: string;
        transportDisabled: boolean;
        logs: Record<string, string>;
        sidecars: Record<string, string>;
        adapterSummary: Record<string, unknown>;
      };
      expect(bundle.version).toBe(1);
      // PRR-049: the platform discriminator travels with version:1.
      expect(bundle.platform).toBe('desktop');
      // PRR-036: the level AT EXPORT TIME (renamed from `level`).
      expect(bundle.levelAtExport).toBe('debug');
      expect(bundle.transportDisabled).toBe(false);
      // Gated: the persisted log line is redacted on BOTH surfaces.
      expect(bundle.logs['main.log']).toContain('main boot');
      expect(bundle.logs['main.log']).toContain('password=[redacted]');
      expect(bundle.logs['main.log']).toContain('token=[redacted]');
      expect(bundle.logs['main.log']).not.toContain('hunter2');
      expect(bundle.logs['main.log']).not.toContain('abc123def456');
      expect(readLog(ws)).not.toContain('hunter2');
      expect(readLog(ws)).not.toContain('abc123def456');
      expect(bundle.sidecars['diagnostics-settings.json']).toContain('"enhancedLogging"');
      expect(bundle.sidecars['settings.json']).toMatch(/<<missing or unreadable: settings\.json>>/);
      expect(bundle.adapterSummary).toMatchObject({ available: false });
    });
  });

  it('export-bundle: gpu-probe.json when present gates into the sidecar map and drives the available:true adapter summary', () => {
    const ws = makeWorkspace('diag-c3-gpu-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // A v1 verdict whose reason carries a secret-shaped value: the sidecar
    // text and the adapter summary must both be gated, never raw.
    fs.writeFileSync(
      path.join(ws.profileDir, 'gpu-probe.json'),
      JSON.stringify({ v: 1, backend: 'vulkan', ok: true, reason: 'probe password=hunter2', device: 'RTX TEST' }),
      'utf8',
    );
    const dest = path.join(path.dirname(ws.profileDir), 'bundle-gpu.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    const reply = handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; path?: string }>;
    return reply.then((result) => {
      expect(result.ok).toBe(true);
      const bundle = JSON.parse(fs.readFileSync(dest, 'utf8')) as {
        sidecars: Record<string, string>;
        adapterSummary: Record<string, unknown>;
      };
      expect(bundle.sidecars['gpu-probe.json']).toContain('vulkan');
      expect(bundle.sidecars['gpu-probe.json']).toContain('password=[redacted]');
      expect(bundle.sidecars['gpu-probe.json']).not.toContain('hunter2');
      expect(bundle.adapterSummary).toMatchObject({ available: true, backend: 'vulkan', ok: true });
      expect(JSON.stringify(bundle.adapterSummary)).toContain('password=[redacted]');
      expect(JSON.stringify(bundle.adapterSummary)).not.toContain('hunter2');
    });
  });

  it('export-bundle: external.*-namespaced sidecar values never survive - the gate redacts known secret tails, the belt drops the rest', () => {
    const ws = makeWorkspace('diag-c3-extkey-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // Issue #256: since the kv gate's key union spans dotted namespaces, a
    // secret-tailed namespaced key ("external.apiKey") is REDACTED by the
    // gate itself before the belt runs. The belt (PRR-008) remains the only
    // layer for gate-dodging shapes: an external.* key whose tail is no
    // known secret morpheme ("external.customSetting") is structurally
    // dropped to [dropped-external-key]. Either way no external.* VALUE
    // survives into the bundle.
    fs.writeFileSync(
      path.join(ws.profileDir, 'settings.json'),
      JSON.stringify(
        { theme: 'dark', 'external.apiKey': 'hunter2-value-9f1c', 'external.customSetting': 'hunter2-value-b2d4' },
        null,
        2,
      ),
      'utf8',
    );
    const dest = path.join(path.dirname(ws.profileDir), 'bundle-extkey.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    const reply = handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; path?: string }>;
    return reply.then((result) => {
      expect(result.ok).toBe(true);
      const bundle = JSON.parse(fs.readFileSync(dest, 'utf8')) as { sidecars: Record<string, string> };
      const sidecar = bundle.sidecars['settings.json'] as string;
      // Secret-tailed: redacted by the shared gate (issue #256 AC5).
      expect(sidecar).toContain('"external.apiKey": "[redacted]"');
      // Gate-dodging tail: structurally dropped by the belt (PRR-008).
      expect(sidecar).toContain('"external.customSetting": "[dropped-external-key]"');
      expect(sidecar).not.toContain('hunter2-value-9f1c');
      expect(sidecar).not.toContain('hunter2-value-b2d4');
      expect(sidecar).toContain('"theme": "dark"');
      // The gated sidecar text stays parseable JSON (only the values went).
      expect(() => JSON.parse(sidecar) as unknown).not.toThrow();
    });
  });

  it('export-bundle: a destination canonically equal to a live file is rejected and the file is untouched', () => {
    const ws = makeWorkspace('diag-c3-live-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const before = readLog(ws);
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: ws.logPath } as never);
    const exportNow = () =>
      handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; error?: string }>;
    return exportNow().then((reply) => {
      expect(reply).toEqual({ ok: false, error: 'live-destination' });
      expect(readLog(ws)).toBe(before);
      // PRR-034: the profile sidecars and the sqlite WAL/SHM siblings are
      // live destinations too.
      showSaveDialog.mockResolvedValue({ canceled: false, filePath: `${ws.storePath}-wal` } as never);
      return exportNow().then((walReply) => {
        expect(walReply).toEqual({ ok: false, error: 'live-destination' });
        showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(ws.profileDir, 'secrets.bin') } as never);
        return exportNow().then((sidecarReply) => {
          expect(sidecarReply).toEqual({ ok: false, error: 'live-destination' });
          expect(readLog(ws)).toBe(before);
        });
      });
    });
  });

  it('export-bundle: a dismissed dialog answers {cancelled:true} and writes nothing', () => {
    const ws = makeWorkspace('diag-c3-cancel-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    showSaveDialog.mockResolvedValue({ canceled: true } as never);
    return (handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ cancelled?: boolean }>).then((reply) => {
      expect(reply).toEqual({ cancelled: true });
      expect(fs.readdirSync(path.dirname(ws.profileDir))).not.toContain('bundle.json');
    });
  });

  it('export-bundle: a write failure cleans the tmp file, leaves the destination untouched and answers a typed error', () => {
    const ws = makeWorkspace('diag-c3-fail-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // A DIRECTORY as the destination: the tmp write succeeds, the rename onto
    // the directory fails — exercising tmp cleanup with the destination kept.
    const dest = path.join(path.dirname(ws.profileDir), 'dest-dir');
    fs.mkdirSync(dest);
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    return (handlerFor('desktop:diagnostics:export')(undefined) as Promise<{ ok: boolean; error?: string }>).then(
      (reply) => {
        expect(reply.ok).toBe(false);
        expect(typeof reply.error).toBe('string');
        // PRR-035: the fs error text never carries the absolute path to the
        // renderer — it collapses to the <path> marker + basename.
        expect(reply.error).not.toContain(path.dirname(dest));
        expect(reply.error).toContain('<path>');
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
  it('capture-handlers: unhandled rejections in the main process reach the file transport', () => {
    const ws = makeWorkspace('diag-c6-rejection-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    // Simulate the runtime event (process.emit does not trigger Node's own
    // default rejection machinery — the listener itself is what we test).
    process.emit('unhandledRejection', new Error('probe rejection'), Promise.resolve());
    const log = readLog(ws);
    expect(log).toContain('error [process] unhandled rejection: Error: probe rejection');
  });

  it('capture-handlers: a read-only log file (write failure) disables the sink for the session and the app continues', () => {
    const ws = makeWorkspace('diag-c6-readonly-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const before = readLog(ws);
    // Real transport failure: the read-only attribute makes appendFileSync
    // throw (destructured fs imports cannot be spied).
    const logFile = path.join(ws.userDataPath, 'logs', 'main.log');
    fs.chmodSync(logFile, 0o444);
    // Must not throw: a logging failure never takes the app down.
    expect(() => console.error('[test] readonly probe password=hunter2')).not.toThrow();
    expect(() => console.error('[test] readonly probe two')).not.toThrow();
    fs.chmodSync(logFile, 0o666);
    // The failed writes never reached the file; the transport is disabled
    // FOR THE SESSION (a transient failure must not silently resume).
    expect(readLog(ws)).toBe(before);
    expect(__diagnosticsStateForTests().transportDisabled).toBe(true);
  });

  it('capture-handlers: the quit-flush appends buffered pre-activation errors, gated, on will-quit', () => {
    const ws = makeWorkspace('diag-c6-quitflush-');
    installLoggingConsoleWrapper();
    console.error('[test] quit-flush probe password=hunter2');
    app.emit('will-quit');
    // The quit-flush derives the logs dir from app.getPath('userData') — the
    // stub's temp dir, not the workspace fixture.
    const log = fs.readFileSync(path.join(app.getPath('userData'), 'logs', 'main.log'), 'utf8');
    expect(log).toContain('password=[redacted]');
    expect(log).not.toContain('hunter2');
  });

  it('capture-handlers: an activated process quit-flush never duplicates the pre-activation entries', () => {
    const ws = makeWorkspace('diag-c6-quitactive-');
    // One pre-activation error: activation flushes it to the file exactly once.
    console.error('[test] pre-activation entry for the quit-flush no-op');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const flushed = readLog(ws);
    expect(flushed.match(/pre-activation entry for the quit-flush no-op/g) ?? []).toHaveLength(1);
    // will-quit on an activated process must not append it again. NOTE: the
    // `if (active) return` guard is structurally equivalent here (activation
    // drains phase1, so the flush would early-return on an empty buffer
    // anyway) — this assertion kills a double-flush mutant, and the equivalent
    // guard mutant is recorded in the PR body's Considered table.
    app.emit('will-quit');
    expect(readLog(ws)).toBe(flushed);
  });


  it('capture-handlers: the main-side IPC ingest re-gates renderer entries at the sink', () => {
    const ws = makeWorkspace('diag-c6-ingest-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const reply = handlerFor('desktop:diagnostics:log-entry')(undefined, {
      ts: new Date().toISOString(),
      level: 'warn',
      scope: 'renderer',
      // The renderer sends the persisted form; a bypassing caller sends raw.
      message: 'ingest probe password=hunter2',
      sessionId: 'sess-test',
      seq: 1,
    });
    // The handler answers synchronously under direct invocation.
    const log = fs.readFileSync(path.join(ws.userDataPath, 'logs', 'main.log'), 'utf8');
    expect(log).toContain('password=[redacted]');
    expect(log).not.toContain('hunter2');
    void reply;
  });

  it('capture-handlers: the ingest sanitizes control characters and gates scope/ts (no forged entries)', async () => {
    const ws = makeWorkspace('diag-c6-sanitize-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const ingest = handlerFor('desktop:diagnostics:log-entry');
    const before = logLines(ws).length;

    // PRR-006: newlines in scope/ts/message become LITERAL \n text — every
    // entry stays ONE physical line, so no second entry can be forged (the
    // legitimate window-error shape needs no renderer compromise).
    const nlScope = (await ingest(undefined, validEntry({ seq: 11, scope: 'ren\nderer' }))) as { ok: boolean };
    expect(nlScope.ok).toBe(true);
    const nlTs = (await ingest(undefined, validEntry({ seq: 12, ts: '2026-01-01T00:00:00.000Z\nforged-ts' }))) as {
      ok: boolean;
    };
    expect(nlTs.ok).toBe(true);
    const forged = (await ingest(
      undefined,
      validEntry({ seq: 13, message: 'first line\n2026-01-01T00:00:00.000Z error [fake] forged entry' }),
    )) as { ok: boolean };
    expect(forged.ok).toBe(true);
    // BEL is stripped, lone CR is escaped like any other newline.
    const controls = (await ingest(undefined, validEntry({ seq: 14, message: 'beep\u0007 and \r carriage' }))) as {
      ok: boolean;
    };
    expect(controls.ok).toBe(true);
    // A secret in scope is gated just like a secret in message (scope used to
    // persist RAW while message was gated).
    const secretScope = (await ingest(
      undefined,
      validEntry({ seq: 15, scope: 'renderer password=hunter2' }),
    )) as { ok: boolean };
    expect(secretScope.ok).toBe(true);

    const log = readLog(ws);
    expect(logLines(ws).length, 'no entry grew a second physical line').toBe(before + 5);
    expect(log).toContain('[ren\\nderer]');
    expect(log).toContain('2026-01-01T00:00:00.000Z\\nforged-ts');
    expect(log).toContain('first line\\n2026-01-01T00:00:00.000Z error [fake] forged entry');
    expect(log).toContain('beep and \\n carriage');
    expect(log).not.toContain('\u0007');
    expect(log).not.toContain('\r');
    expect(log).toContain('password=[redacted]');
    expect(log).not.toContain('hunter2');
    // No forged payload ever became its own physical log line.
    for (const line of logLines(ws)) {
      expect(line.startsWith('2026-01-01T00:00:00.000Z error [fake]'), `forged physical line: ${line}`).toBe(false);
    }
  });

  it('capture-handlers: a dead file transport is surfaced (sinkHealthy, unpersisted acks, export marker)', async () => {
    const ws = makeWorkspace('diag-c6-sinkhealth-');
    activateDiagnosticsLogging({ userDataPath: ws.userDataPath, storePath: ws.storePath });
    const getState = handlerFor('desktop:diagnostics:get-state');
    const ingest = handlerFor('desktop:diagnostics:log-entry');
    expect(getState(undefined)).toEqual({ active: true, enhanced: false, sinkHealthy: true });

    // Kill the sink (the read-only attribute makes appendFileSync throw) and
    // drive one entry through it — exactly the session-disable case.
    const logFile = path.join(ws.userDataPath, 'logs', 'main.log');
    const lastGood = readLog(ws);
    fs.chmodSync(logFile, 0o444);
    expect(() => console.error('[test] sink-death probe')).not.toThrow();
    fs.chmodSync(logFile, 0o666);
    expect(__diagnosticsStateForTests().transportDisabled).toBe(true);

    // PRR-002: get-state stops reading as a healthy sink.
    expect(getState(undefined)).toEqual({ active: true, enhanced: false, sinkHealthy: false });
    // The ingest reply names the unpersisted delivery instead of falsely
    // acking; a redelivery re-acks as a duplicate (seen is still marked: the
    // sink never recovers in-session, so no rewrite attempt against it).
    const unpersisted = (await ingest(undefined, validEntry())) as {
      ok: boolean;
      persisted?: boolean;
      detail?: string;
    };
    expect(unpersisted).toEqual({ ok: true, persisted: false, detail: 'file transport disabled' });
    const dup = (await ingest(undefined, validEntry())) as { ok: boolean; dup?: boolean };
    expect(dup).toEqual({ ok: true, dup: true });
    expect(readLog(ws)).toBe(lastGood);

    // The export still answers ok with last-good content, carries the
    // disabled marker, and the reply names it.
    const dest = path.join(path.dirname(ws.profileDir), 'sinkhealth-bundle.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest } as never);
    const exportReply = (await handlerFor('desktop:diagnostics:export')(undefined)) as {
      ok: boolean;
      path?: string;
      transportDisabled?: boolean;
    };
    expect(exportReply).toEqual({ ok: true, path: dest, transportDisabled: true });
    const bundle = JSON.parse(fs.readFileSync(dest, 'utf8')) as { transportDisabled: boolean; logs: Record<string, string> };
    expect(bundle.transportDisabled).toBe(true);
    expect(bundle.logs['main.log']).toContain('main boot');
  });
});
