// e133-bundled-pack-boot-gate.test.ts — review PRR-201/PRR-207: the boot-time
// bundled-pack gate (ensureBundledPacksAtBoot) must fire ONLY for a completed
// first run — an inverted gate silently reproduces the empty-Training-tab bug
// on exactly the existing installs the round-6 fix targets, and no e2e path
// observes the gate itself (the wizard-activate path is separate).
import { describe, expect, it, vi } from 'vitest';
import { ensureBundledPacksAtBoot, type EnsureBundledPacksResult } from '../../main/first-run/bundled-packs';

const result = (overrides: Partial<EnsureBundledPacksResult> = {}): EnsureBundledPacksResult => ({
  ok: true,
  results: [{ id: 'opmed-cdp-mlc', ok: true, detail: 'installed opmed-cdp-mlc@1.0.1' }],
  ...overrides,
});

describe('ensureBundledPacksAtBoot gate (#133 feedback: PRR-201/207)', () => {
  it('FIRES for a completed first run and logs the install', async () => {
    const run = vi.fn().mockResolvedValue(result());
    const log = vi.fn();
    const fired = ensureBundledPacksAtBoot(true, run, log);
    expect(fired).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('bundled packs ensured at boot: installed opmed-cdp-mlc@1.0.1'),
        'info',
      );
    });
  });

  it('DOES NOT fire for a not-yet-completed first run (wizard owns installs)', () => {
    const run = vi.fn();
    const fired = ensureBundledPacksAtBoot(false, run, vi.fn());
    expect(fired).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('fires on drift/reset reruns too (completed stays true; self-healing)', () => {
    // evaluateStatus 'drift'/'reset' keep firstRun.completed true by design —
    // the gate must not treat a rerun as "wizard will handle it".
    const run = vi.fn().mockResolvedValue(result());
    expect(ensureBundledPacksAtBoot(true, run, vi.fn())).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('routes per-pack failures to the error channel', async () => {
    const run = vi.fn().mockResolvedValue(
      result({
        ok: false,
        results: [{ id: 'opmed-cdp-mlc', ok: false, detail: 'staged pack folder is missing: X' }],
      }),
    );
    const log = vi.fn();
    ensureBundledPacksAtBoot(true, run, log);
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('bundled pack ensure failed'), 'error');
    });
  });

  it('names early-exit skips (no pack lifecycle / no manifest) on the info channel', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, detail: 'no integrity manifest is staged, so no packs are required (dev tree?)', results: [] });
    const log = vi.fn();
    ensureBundledPacksAtBoot(true, run, log);
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('bundled pack ensure skipped: no integrity manifest'),
        'info',
      );
    });
  });

  it('never throws out of the fire-and-forget: run() rejection lands on the error channel', async () => {
    const run = vi.fn().mockRejectedValue(new Error('store closed'));
    const log = vi.fn();
    expect(() => ensureBundledPacksAtBoot(true, run, log)).not.toThrow();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('bundled pack ensure crashed: store closed'), 'error');
    });
  });
});
