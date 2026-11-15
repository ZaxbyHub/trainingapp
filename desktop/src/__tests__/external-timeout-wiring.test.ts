// external-timeout-wiring.test.ts — issue #351 Phase 4.2 guardrail (class B:
// transport limits encoded as constants with no settings/disclosure/contract
// path). The two settings keys must stay enumerated across EVERY surface they
// wire: EXTERNAL_SETTING_KEYS, validate(), commit(), reset(), snapshot(),
// responseFields(), the OpenAPI SettingsResponse AND SettingsUpdateRequest
// schemas, the web_ui ExternalConfig persistence, and the Settings-panel UI.
// Each surface is asserted with a distinguishing predicate; the Phase-4.2
// mutation battery drops the key from each surface and requires RED.
//
// The spec also pins the replay tolerance behavior (r2 Critical #5A): an
// out-of-range stored timeout is dropped WHOLE-BATCH-ATOMically while its
// valid siblings still apply — and the rollback symmetry (captureState/
// restoreState) carries the timeout mirrors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(desktopRoot, '..');

const KEYS = ['external.firstByteTimeoutMs', 'external.idleTimeoutMs'] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

import os from 'node:os';
import {
  EXTERNAL_SETTING_KEYS,
  ExternalProviderState,
} from '../../main/backend/inference/external-provider';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';
import { createMemorySecretStore } from '../../main/security/secret-store';

function mapStore() {
  const data = new Map<string, string>();
  return {
    get: (n: string) => data.get(n) ?? null,
    set: (n: string, v: string) => { data.set(n, v); },
    delete: (n: string) => { data.delete(n); },
    dump: () => Object.fromEntries(data),
  };
}

describe('#351 class B guardrail: the timeout keys are wired on every surface', () => {
  it('EXTERNAL_SETTING_KEYS carries both keys', () => {
    for (const key of KEYS) expect(EXTERNAL_SETTING_KEYS).toContain(key);
  });

  for (const [surface, sourceRel, pattern] of [
    ['validate()', 'desktop/main/backend/inference/external-provider.ts', /case 'external\.firstByteTimeoutMs':\s*\r?\n\s*case 'external\.idleTimeoutMs':/],
    ['commit()', 'desktop/main/backend/inference/external-provider.ts', /if \(typeof patch\['external\.firstByteTimeoutMs'\] === 'number'\)/],
    ['reset()', 'desktop/main/backend/inference/external-provider.ts', /case 'external\.firstByteTimeoutMs':\s*\r?\n\s*this\.values\.firstByteTimeoutMs = undefined/],
    ['snapshot()', 'desktop/main/backend/inference/external-provider.ts', /snapshot\['external\.firstByteTimeoutMs'\] = this\.values\.firstByteTimeoutMs/],
    ['responseFields()', 'desktop/main/backend/inference/external-provider.ts', /'external\.firstByteTimeoutMs': this\.firstByteTimeoutValueMs\(\)/],
    ['engine call-time read', 'desktop/main/backend/inference/llama-engine.ts', /firstByteTimeoutMs: this\.external\.firstByteTimeoutValueMs\(\)/],
  ] as const) {
    it(`surface "${surface}" wires the first-byte key (source predicate)`, () => {
      expect(read(sourceRel)).toMatch(pattern);
    });
  }

  it('the OpenAPI contract declares both keys in BOTH schemas with the bounds', () => {
    const spec = read('contracts/api.openapi.yaml');
    for (const section of ['SettingsResponse', 'SettingsUpdateRequest']) {
      const start = spec.indexOf(`${section}:`);
      expect(start, `${section} present`).toBeGreaterThanOrEqual(0);
      // Bound the slice at the NEXT 4-space-indented schema key so the window
      // covers the whole section (SettingsResponse is > 4000 chars).
      const rel = spec.slice(start + 1).search(/\n    [A-Za-z]/);
      const window = rel === -1 ? spec.slice(start) : spec.slice(start, start + 1 + rel + 1);
      for (const key of KEYS) {
        expect(
          window,
          `${section} declares ${key} with the exact bounds`,
        ).toContain(`${key}": { type: integer, minimum: 1000, maximum: 2147483647`);
      }
    }
  });

  it('the web_ui lane persists + forwards the fields (source predicates)', () => {
    const provider = read('web_ui/src/lib/llm/external-provider.ts');
    for (const pattern of [/firstByteTimeoutMs\?: number/, /timeoutOrNull\(parsed\.firstByteTimeoutMs\)/, /cfg\.firstByteTimeoutMs !== undefined \? \{ firstByteTimeoutMs: cfg\.firstByteTimeoutMs \}/]) {
      expect(provider).toMatch(pattern);
    }
    const ui = read('web_ui/src/components/ExternalModelSection.tsx');
    for (const marker of ['external-timeout-first-byte', 'external-first-byte-input', "body['external.firstByteTimeoutMs'] = patch.firstByteTimeoutMs"]) {
      expect(ui, `UI surface carries ${marker}`).toContain(marker);
    }
    const streaming = read('web_ui/src/lib/api/streaming.ts');
    expect(streaming).toMatch(/export function desktopFirstByteBudgetMs/);
  });

  it('an out-of-range stored timeout is dropped whole-batch while valid siblings still apply (replay tolerance)', async () => {
    vi.resetModules();
    const { replayExternalSnapshot } = await import('../../main/backend/external-store');
    const applied: Array<Record<string, unknown>> = [];
    const results = [false, true]; // first attempt refused, retry accepted
    const apply = (patch: Record<string, unknown>) => {
      applied.push(patch);
      const ok = results[applied.length - 1] === true;
      return ok
        ? { ok: true as const }
        : { ok: false as const, detail: 'Invalid external model settings', errors: ['external.firstByteTimeoutMs: expected an integer between 1000 and 2147483647'] };
    };
    const snapshot = {
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:9',
      'external.model': 'm1',
      'external.firstByteTimeoutMs': 5,
    };
    expect(() => replayExternalSnapshot(snapshot, apply)).not.toThrow();
    expect(applied.length, 'a retry must happen').toBe(2);
    expect(applied[1], 'the retry must be the survivors AS ONE BATCH (sibling enabled preserved)').toEqual({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:9',
      'external.model': 'm1',
    });
  });

  it('a failed save rolls the timeout mirrors back (capture/restore symmetry)', () => {
    const engine = new LlamaEngine({
      modelDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-rb-')),
      llamaFactory: vi.fn(async () => { throw new Error('local model must not load'); }),
      externalProvider: { secretStore: createMemorySecretStore() },
    } as never);
    const capture = engine.external.captureState();
    expect(capture.firstByteTimeoutSetting).toBeUndefined();
    const restore = engine.external.captureState();
    engine.external.commit({ 'external.firstByteTimeoutMs': 900_000 });
    expect(engine.external.responseFields()['external.firstByteTimeoutMs']).toBe(900_000);
    engine.external.restoreState(restore);
    expect(engine.external.responseFields()['external.firstByteTimeoutMs'], 'restore reverts the timeout').toBe(600_000);
    void capture;
  });
});
