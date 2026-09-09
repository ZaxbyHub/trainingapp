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
 * Full-context lookback depth mirroring the browser's `penalty_last_n: -1`
 * intent at the shared DEFAULT_N_CTX (web_ui/src/lib/llm/wllama-service.ts:39).
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
