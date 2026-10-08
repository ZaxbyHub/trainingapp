// B4 sampler penalty mapping (issue #62).
//
// Ports the INTENT of the browser's buildWllamaPenalties
// (web_ui/src/lib/llm/wllama-service.ts:152-171) to node-llama-cpp's own
// sampler shape. Field names are NOT portable across engines — the browser
// maps LLMGenerateOptions to wllama's penalty_repeat/penalty_freq/
// penalty_present with penalty_last_n: -1; node-llama-cpp instead takes
// repeatPenalty: {penalty, lastTokens, frequencyPenalty, presencePenalty} on
// session.prompt. The browser's -1 (full-context lookback) is mirrored here
// as lastTokens = the default context window (PENALTY_FULL_CONTEXT_TOKENS)
// unless the caller passes an explicit context size.
//
// SCOPE, verified against the pinned library (#154): lastTokens does NOT cover
// the prompt. LlamaChat.res (LlamaChat.js:811) holds only generated tokens —
// its sole writer is pushAll(this.res, this.pendingTokens) (:2283) fed from
// popFreeChunkTokens() — while the prompt path injectTokens (:1348-1356) routes
// into prefixTriggerTokens, and getPenaltyTokens (:1077) slices only res. So
// this constant is a GENERATED-token lookback, not a context-wide one, and no
// value of it can stop retrieved evidence from being penalised. 8192 exceeds
// both shipped generation caps (1024/384), so in practice it penalises every
// generated token. Do not "bound" it expecting a grounding effect.

export interface PenaltyOptions {
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface NativePenaltyParams {
  penalty: number;
  lastTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

/**
 * Lookback depth for the generated-token repeat penalty, mirroring the
 * browser's `penalty_last_n: -1` value at the shared DEFAULT_N_CTX
 * (web_ui/src/lib/llm/wllama-service.ts:39). See the scope note above: this
 * window covers generated tokens only and never the prompt.
 */
export const PENALTY_FULL_CONTEXT_TOKENS = 8192;

/**
 * Build the native sampler penalty params. When NO penalty option is set the
 * returned object is empty so the library's own defaults apply unchanged
 * (browser parity: buildWllamaPenalties returns {} too). When ANY option is
 * set, the penalty-bearing fields materialize — unset penalties default to
 * their neutral values (0), and a repeat penalty is never invented (the
 * `penalty` key is omitted when repeatPenalty was not provided).
 */
export function buildPenalties(
  options?: PenaltyOptions,
  contextTokens?: number,
): NativePenaltyParams | Record<string, never> {
  const rp = options?.repeatPenalty;
  const fp = options?.frequencyPenalty;
  const pp = options?.presencePenalty;
  if (rp === undefined && fp === undefined && pp === undefined) {
    return {};
  }
  if (rp === undefined) {
    // Frequency/presence-only: no repeat penalty is invented.
    return {
      lastTokens: contextTokens ?? PENALTY_FULL_CONTEXT_TOKENS,
      frequencyPenalty: fp ?? 0,
      presencePenalty: pp ?? 0,
    } as NativePenaltyParams;
  }
  return {
    penalty: rp,
    lastTokens: contextTokens ?? PENALTY_FULL_CONTEXT_TOKENS,
    frequencyPenalty: fp ?? 0,
    presencePenalty: pp ?? 0,
  };
}
