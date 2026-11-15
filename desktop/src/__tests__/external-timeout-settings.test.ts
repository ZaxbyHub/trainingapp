// external-timeout-settings.test.ts — issue #351 (AC4, desktop leg): the
// external-request first-byte/idle timeouts become SETTINGS, not constants.
//
// FROZEN ACCEPTANCE SURFACE (trace 350-351-packaged-gpu-fuse-external-timeouts,
// check C4's desktop leg; authored arm's-length from the fix):
//   keys        — external.firstByteTimeoutMs / external.idleTimeoutMs,
//                 integers in [1000, 2147483647] inclusive;
//   validate()  — accepts in-range integers (no errors); non-integer /
//                 out-of-range / wrong-type values get PER-KEY error strings
//                 that are NOT the "unknown setting" default;
//   responseFields() — discloses the EFFECTIVE numbers, 600000/120000 when
//                 unset (the guarded-request defaults), the committed value
//                 after commit();
//   commit()/reset() — the values are settable and reset restores the
//                 defaults; EXTERNAL_SETTING_KEYS carries both keys so
//                 engine.resetSettings() accepts them;
//   snapshot()  — persists the committed values (external.json replay);
//   call time   — an engine-level patch with a tiny firstByteTimeoutMs (and a
//                 second row with a tiny idleTimeoutMs) is accepted by
//                 applySettingsPatch (base: 422 "unknown setting") and drives
//                 guardedRequest AT CALL TIME: a stub endpoint that never
//                 sends a byte (or goes silent mid-stream) aborts with the
//                 configured value's ms in the surfaced timeout error.
//
// RED at base (every subject row fails: the keys are 422-rejected, the fields
// are absent from responseFields/snapshot, and the engine rows die on the
// applySettingsPatch 422 before any request is made), GREEN after the fix.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_SETTING_KEYS,
  ExternalProviderState,
} from '../../main/backend/inference/external-provider';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import { createMemorySecretStore } from '../../main/security/secret-store';

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** An endpoint that accepts the request and NEVER answers (first-byte stall). */
async function silentEndpoint(): Promise<string> {
  const s = http.createServer(() => {
    // Intentionally never responds.
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/**
 * A streaming endpoint that answers ONE SSE delta and then goes silent
 * forever (the idle-stall shape: first byte arrives, so only the idle timer
 * can fire).
 */
async function stallingStreamEndpoint(): Promise<string> {
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
      // Intentionally never ends the response.
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function newEngine() {
  const llamaFactory = vi.fn(async () => {
    throw new Error('local model must not load');
  });
  const engine = new LlamaEngine({
    modelDir: tmp('ext-timeout-models-'),
    llamaFactory,
    externalProvider: { secretStore: createMemorySecretStore() },
  });
  return { engine, llamaFactory };
}

describe('#351 external timeout settings: the external.* keyspace (state level)', () => {
  it('validate() accepts in-range integers for both keys (no errors)', () => {
    const state = new ExternalProviderState();
    expect(state.validate({ 'external.firstByteTimeoutMs': 900_000 })).toEqual([]);
    expect(state.validate({ 'external.idleTimeoutMs': 130_000 })).toEqual([]);
    expect(state.validate({ 'external.firstByteTimeoutMs': 1_000, 'external.idleTimeoutMs': 2_147_483_647 })).toEqual([]);
  });

  it('validate() rejects out-of-range, non-integer and wrong-typed values with per-key errors (not "unknown setting")', () => {
    const state = new ExternalProviderState();
    for (const bad of [999, 2_147_483_648, 500.5, '900000', null, Number.NaN]) {
      const errors = state.validate({ 'external.firstByteTimeoutMs': bad }).join('\n');
      expect(errors, `firstByteTimeoutMs=${String(bad)} must get a per-key error`).toMatch(/external\.firstByteTimeoutMs/);
      expect(errors, `firstByteTimeoutMs=${String(bad)} must be a KNOWN key at fix time`).not.toMatch(/unknown setting/);
    }
    for (const bad of [999, 2_147_483_648, 500.5, '130000', null]) {
      const errors = state.validate({ 'external.idleTimeoutMs': bad }).join('\n');
      expect(errors, `idleTimeoutMs=${String(bad)} must get a per-key error`).toMatch(/external\.idleTimeoutMs/);
      expect(errors, `idleTimeoutMs=${String(bad)} must be a KNOWN key at fix time`).not.toMatch(/unknown setting/);
    }
  });

  it('responseFields() discloses the EFFECTIVE timeouts (defaults 600000/120000 when unset)', () => {
    const fields = new ExternalProviderState().responseFields();
    expect(fields['external.firstByteTimeoutMs']).toBe(600_000);
    expect(fields['external.idleTimeoutMs']).toBe(120_000);
  });

  it('commit() makes the values settable; responseFields() reflects them; reset() restores the defaults', () => {
    const state = new ExternalProviderState();
    const patch = { 'external.firstByteTimeoutMs': 900_000, 'external.idleTimeoutMs': 130_000 };
    expect(state.validate(patch)).toEqual([]);
    state.commit(patch);
    expect(state.responseFields()['external.firstByteTimeoutMs']).toBe(900_000);
    expect(state.responseFields()['external.idleTimeoutMs']).toBe(130_000);
    state.reset(['external.firstByteTimeoutMs', 'external.idleTimeoutMs']);
    expect(state.responseFields()['external.firstByteTimeoutMs']).toBe(600_000);
    expect(state.responseFields()['external.idleTimeoutMs']).toBe(120_000);
  });

  it('EXTERNAL_SETTING_KEYS carries both keys (engine resetSettings accepts them)', () => {
    expect(EXTERNAL_SETTING_KEYS).toContain('external.firstByteTimeoutMs');
    expect(EXTERNAL_SETTING_KEYS).toContain('external.idleTimeoutMs');
  });

  it('snapshot() persists the committed timeouts (external.json replay)', () => {
    const state = new ExternalProviderState();
    state.commit({ 'external.firstByteTimeoutMs': 900_000, 'external.idleTimeoutMs': 130_000 });
    expect(state.snapshot()['external.firstByteTimeoutMs']).toBe(900_000);
    expect(state.snapshot()['external.idleTimeoutMs']).toBe(130_000);
  });
});

describe('#351 external timeout settings: the engine path (call time)', () => {
  it('applySettingsPatch accepts the new keys (base answers 422 "unknown setting")', () => {
    const { engine } = newEngine();
    const result = engine.applySettingsPatch({ 'external.firstByteTimeoutMs': 5_000, 'external.idleTimeoutMs': 6_000 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(engine.responseSettings()['external.firstByteTimeoutMs']).toBe(5_000);
    expect(engine.responseSettings()['external.idleTimeoutMs']).toBe(6_000);
  });

  it('a configured firstByteTimeoutMs of 1000 aborts a silent endpoint at call time with the configured value in the error', async () => {
    const base = await silentEndpoint();
    const { engine } = newEngine();
    const patchResult = engine.applySettingsPatch({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': base,
      'external.model': 'm1',
      'external.firstByteTimeoutMs': 1000,
    });
    expect(patchResult.ok, JSON.stringify(patchResult)).toBe(true);
    const started = Date.now();
    await expect(engine.query('hello')).rejects.toMatchObject({ kind: 'timeout' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    await expect(engine.query('hello')).rejects.toMatchObject({ message: expect.stringMatching(/1000ms/) as string });
  });

  it('a configured idleTimeoutMs of 1000 aborts a stream that goes silent after its first delta', async () => {
    const base = await stallingStreamEndpoint();
    const { engine } = newEngine();
    const patchResult = engine.applySettingsPatch({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': base,
      'external.model': 'm1',
      'external.idleTimeoutMs': 1000,
    });
    expect(patchResult.ok, JSON.stringify(patchResult)).toBe(true);
    const started = Date.now();
    await expect(engine.query('hello')).rejects.toMatchObject({ kind: 'timeout' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    await expect(engine.query('hello')).rejects.toMatchObject({ message: expect.stringMatching(/1000ms/) as string });
  });

  it('with no timeout keys set, responseSettings still discloses the 600000/120000 defaults (AC5 default behavior)', () => {
    const { engine } = newEngine();
    expect(engine.responseSettings()['external.firstByteTimeoutMs']).toBe(600_000);
    expect(engine.responseSettings()['external.idleTimeoutMs']).toBe(120_000);
  });
});
