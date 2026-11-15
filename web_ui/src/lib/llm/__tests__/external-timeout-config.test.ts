// external-timeout-config.test.ts — issue #351 (AC4, browser leg): the
// browser app's ExternalConfig gains optional firstByteTimeoutMs /
// idleTimeoutMs (integers in [1000, 2147483647], validated on save),
// persisted in the localStorage 'external-provider-config' blob, and
// forwarded by createExternalLLMService into BOTH provider classes.
//
// FROZEN ACCEPTANCE SURFACE (trace 350-351-packaged-gpu-fuse-external-timeouts,
// check C4's browser leg; authored arm's-length from the fix):
//   - saveExternalConfig/loadExternalConfig round-trip the two values and the
//     persisted blob JSON carries them;
//   - a save carrying an out-of-range or non-integer value never persists
//     that value (the loaded config does not report it);
//   - createExternalLLMService forwards cfg.firstByteTimeoutMs and
//     cfg.idleTimeoutMs into OpenAICompatChatService AND
//     AnthropicCompatChatService (read through the classes' own readonly
//     fields, the same seam the constructors already accept).
//
// RED at base (loadExternalConfig() drops the unknown fields, so the
// round-trip rows read undefined, and createExternalLLMService passes no
// timeouts so the providers hold their 600000 default), GREEN after the fix.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createExternalLLMService,
  loadExternalConfig,
  saveExternalConfig,
  type ExternalConfig,
} from '../external-provider';
import { EXTERNAL_CONFIG_KEY } from '../../storage/persisted-keys';
import { OpenAICompatChatService } from '../openai-provider';
import { AnthropicCompatChatService } from '../anthropic-provider';

const ACTIVE: ExternalConfig = {
  enabled: true,
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:9',
  model: 'm1',
  apiKey: '',
  rememberKey: false,
  grounded: true,
  firstByteTimeoutMs: 900_000,
  idleTimeoutMs: 130_000,
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('#351 browser ExternalConfig timeout fields', () => {
  test('saveExternalConfig persists firstByteTimeoutMs/idleTimeoutMs and loadExternalConfig returns them', () => {
    saveExternalConfig({ firstByteTimeoutMs: 900_000, idleTimeoutMs: 130_000 });
    const cfg = loadExternalConfig();
    expect(cfg.firstByteTimeoutMs).toBe(900_000);
    expect(cfg.idleTimeoutMs).toBe(130_000);
    const blob = JSON.parse(localStorage.getItem(EXTERNAL_CONFIG_KEY) ?? '{}') as Record<string, unknown>;
    expect(blob.firstByteTimeoutMs).toBe(900_000);
    expect(blob.idleTimeoutMs).toBe(130_000);
  });

  test('an out-of-range or non-integer timeout never persists', () => {
    for (const bad of [999, 2_147_483_648, 500.5, '900000']) {
      localStorage.clear();
      saveExternalConfig({ firstByteTimeoutMs: bad as number, idleTimeoutMs: bad as number });
      const cfg = loadExternalConfig();
      expect(cfg.firstByteTimeoutMs, `firstByteTimeoutMs=${String(bad)} must not persist`).not.toBe(bad);
      expect(cfg.idleTimeoutMs, `idleTimeoutMs=${String(bad)} must not persist`).not.toBe(bad);
    }
  });
});

describe('#351 createExternalLLMService forwards the timeouts into both providers', () => {
  test('openai lane', () => {
    const svc = createExternalLLMService(ACTIVE);
    expect(svc).toBeInstanceOf(OpenAICompatChatService);
    const fields = svc as unknown as { firstByteTimeoutMs?: number; idleTimeoutMs?: number | undefined };
    expect(fields.firstByteTimeoutMs).toBe(900_000);
    expect(fields.idleTimeoutMs).toBe(130_000);
  });

  test('anthropic lane', () => {
    const svc = createExternalLLMService({ ...ACTIVE, protocol: 'anthropic' });
    expect(svc).toBeInstanceOf(AnthropicCompatChatService);
    const fields = svc as unknown as { firstByteTimeoutMs?: number; idleTimeoutMs?: number | undefined };
    expect(fields.firstByteTimeoutMs).toBe(900_000);
    expect(fields.idleTimeoutMs).toBe(130_000);
  });

  test('a config without the fields still constructs the service (unset stays unset)', () => {
    const { firstByteTimeoutMs: _f, idleTimeoutMs: _i, ...unset } = ACTIVE;
    const svc = createExternalLLMService(unset);
    expect(svc).not.toBeNull();
    const fields = svc as unknown as { firstByteTimeoutMs?: number };
    expect(fields.firstByteTimeoutMs).toBe(600_000);
  });
});
