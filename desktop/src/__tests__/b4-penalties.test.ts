// B4 acceptance checks (issue #62, AC7): sampler penalty mapping. Pins
// desktop/main/backend/inference/penalties.ts to the INTENT of the browser's
// buildWllamaPenalties (web_ui/src/lib/llm/wllama-service.ts:152-171):
//   - no penalty options set -> NO penalty params at all ({} — library
//     defaults apply unchanged; no lookback window is imposed);
//   - any penalty option set -> all four native fields are materialized,
//     with full-context lookback (the browser's penalty_last_n: -1 at
//     DEFAULT_N_CTX, mirrored here as lastTokens = PENALTY_FULL_CONTEXT_TOKENS
//     = 8192 unless an explicit contextTokens is given);
//   - a repeat penalty is never INVENTED when the caller did not set one.
// Fails at import (Cannot find module) on the pre-fix tree — expected RED.
import { describe, expect, it } from 'vitest';
import {
  buildPenalties,
  PENALTY_FULL_CONTEXT_TOKENS,
} from '../../main/backend/inference/penalties';

describe('b4-penalties: AC7 sampler mapping parity with buildWllamaPenalties', () => {
  it('no options at all -> {} so library defaults apply (browser parity: empty object)', () => {
    expect(buildPenalties()).toEqual({});
    expect(buildPenalties(undefined)).toEqual({});
    expect(buildPenalties(undefined, 4096)).toEqual({});
  });

  it('an empty options object (all three undefined) -> {} too', () => {
    expect(buildPenalties({})).toEqual({});
    expect(buildPenalties({ repeatPenalty: undefined, frequencyPenalty: undefined, presencePenalty: undefined })).toEqual({});
  });

  it('PENALTY_FULL_CONTEXT_TOKENS is 8192 (the DEFAULT_N_CTX full-lookback mirror of penalty_last_n: -1)', () => {
    // web_ui/src/lib/llm/wllama-service.ts:152-171 sets penalty_last_n: -1
    // (full-context lookback) whenever any penalty is set. The native path
    // cannot express -1, so it mirrors the intent with the fixed lookback
    // depth equal to the default context window.
    expect(PENALTY_FULL_CONTEXT_TOKENS).toBe(8192);
  });

  it('only repeatPenalty set -> penalty forwarded, neutral frequency/presence, full-context lookback', () => {
    const result = buildPenalties({ repeatPenalty: 1.15 }) as Record<string, number>;
    expect(result.penalty).toBe(1.15);
    expect(result.frequencyPenalty).toBe(0);
    expect(result.presencePenalty).toBe(0);
    expect(result.lastTokens).toBe(PENALTY_FULL_CONTEXT_TOKENS);
  });

  it('explicit contextTokens overrides the full-context default lookback', () => {
    const result = buildPenalties({ repeatPenalty: 1.1 }, 512) as Record<string, number>;
    expect(result.lastTokens).toBe(512);
    expect(result.penalty).toBe(1.1);
  });

  it('no contextTokens -> lastTokens is exactly PENALTY_FULL_CONTEXT_TOKENS (8192)', () => {
    const result = buildPenalties({ repeatPenalty: 1.05, frequencyPenalty: 0.1 }) as Record<string, number>;
    expect(result.lastTokens).toBe(8192);
    expect(result.lastTokens).toBe(PENALTY_FULL_CONTEXT_TOKENS);
  });

  it('frequencyPenalty only -> forwarded, but NO repeat penalty is invented (field absent-or-undefined)', () => {
    const result = buildPenalties({ frequencyPenalty: 0.5 }) as Record<string, number | undefined>;
    expect(result.frequencyPenalty).toBe(0.5);
    expect(result.presencePenalty).toBe(0);
    expect(result.lastTokens).toBe(PENALTY_FULL_CONTEXT_TOKENS);
    // Deliberately NOT over-pinned: the contract returns `penalty:
    // repeatPenalty` (undefined here). What matters is that no non-neutral
    // repeat penalty materializes from a frequency-only request.
    expect('penalty' in result === false || result.penalty === undefined).toBe(true);
    expect(result.penalty).not.toEqual(expect.any(Number));
  });

  it('presencePenalty only -> forwarded, no invented repeat penalty, neutral frequency', () => {
    const result = buildPenalties({ presencePenalty: 0.25 }) as Record<string, number | undefined>;
    expect(result.presencePenalty).toBe(0.25);
    expect(result.frequencyPenalty).toBe(0);
    expect(result.lastTokens).toBe(PENALTY_FULL_CONTEXT_TOKENS);
    expect('penalty' in result === false || result.penalty === undefined).toBe(true);
  });

  it('all three set -> the complete native params shape with explicit values', () => {
    const result = buildPenalties({ repeatPenalty: 1.2, frequencyPenalty: 0.3, presencePenalty: 0.4 }, 2048);
    expect(result).toEqual({
      penalty: 1.2,
      lastTokens: 2048,
      frequencyPenalty: 0.3,
      presencePenalty: 0.4,
    });
  });

  it('penalty of exactly 0 (a set value) still materializes the full shape — only undefined means unset', () => {
    const result = buildPenalties({ repeatPenalty: 0 }) as Record<string, number>;
    expect(result.penalty).toBe(0);
    expect(result.lastTokens).toBe(PENALTY_FULL_CONTEXT_TOKENS);
    expect(result.frequencyPenalty).toBe(0);
    expect(result.presencePenalty).toBe(0);
  });
});
