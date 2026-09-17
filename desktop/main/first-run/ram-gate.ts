// E2 first-run wizard (issue #85): install-time RAM gate.
//
// Desktop port of the A3 formula (issue #53, llm_interface.py:42-44):
//   required = file_size + kv_estimate(n_ctx) + GGUF_LOAD_OVERHEAD_BYTES
// with the same 1 GiB constants (llm_interface.py:28-29). The wizard uses it
// to recommend a profile at first run; the RUNTIME authority stays B4's
// selectProfile/DEFAULT_PROFILE_THRESHOLD_GB (inference/profile-select.ts) —
// this module composes with that decision, it never overrides it.
import os from 'node:os';

export const KV_CACHE_ESTIMATE_BYTES = 1024 ** 3; // 1 GiB conservative KV-cache allowance
export const GGUF_LOAD_OVERHEAD_BYTES = 1024 ** 3; // 1 GiB allocator/runtime overhead

/** Free-RAM dev/test seam (documented env ingress, same discipline as
 *  memory/budget.ts's positiveInt): TRAININGAPP_DESKTOP_FREE_RAM_BYTES. */
export function resolveFreeRamBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRAININGAPP_DESKTOP_FREE_RAM_BYTES;
  if (raw !== undefined && raw !== '' && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return os.freemem();
}

/** Conservative KV-cache estimate; n_ctx stays in the signature so a
 *  per-architecture formula can replace the constant without changing
 *  callers (verbatim llm_interface.py:32-39 rationale). */
export function kvEstimate(_nCtx: number): number {
  return KV_CACHE_ESTIMATE_BYTES;
}

/** Free RAM needed to load a GGUF of the given file size (llm_interface.py:42-44 parity). */
export function estimateRequiredMemory(fileSize: number, nCtx: number): number {
  return fileSize + kvEstimate(nCtx) + GGUF_LOAD_OVERHEAD_BYTES;
}

export interface ProfileRecommendation {
  profile: 'quality' | 'fast';
  /** Present iff quality did NOT fit and the wizard is downgrading. */
  warning?: { detail: string; requiredBytes: number; freeBytes: number };
}

/**
 * Auto-select the first-run profile: quality iff its model fits in free RAM
 * under the A3 estimate; otherwise fast with an explicit downgrade warning
 * that names the numbers (never a generic message — the defect class this
 * wizard exists to close). An explicit operator choice always wins; this only
 * computes the DEFAULT selection.
 */
export function autoSelectProfile(options: {
  freeBytes: number;
  nCtx: number;
  qualityFileBytes?: number;
  fastFileBytes?: number;
}): ProfileRecommendation {
  const { freeBytes, nCtx, qualityFileBytes, fastFileBytes } = options;
  if (qualityFileBytes !== undefined) {
    const requiredBytes = estimateRequiredMemory(qualityFileBytes, nCtx);
    if (freeBytes >= requiredBytes) return { profile: 'quality' };
    const detail =
      `The quality model needs ~${requiredBytes} bytes free (file + KV cache + load overhead) ` +
      `but only ${freeBytes} bytes are available; defaulting to the fast profile.`;
    return { profile: 'fast', warning: { detail, requiredBytes, freeBytes } };
  }
  // Quality model size unknown (not staged yet): fall back to fast with the
  // same honest-diagnostic rule rather than pretending quality fits.
  const requiredBytes = fastFileBytes !== undefined ? estimateRequiredMemory(fastFileBytes, nCtx) : 0;
  const detail =
    'The quality model file was not found, so its RAM requirement cannot be measured; ' +
    'defaulting to the fast profile.';
  return { profile: 'fast', warning: { detail, requiredBytes, freeBytes } };
}
