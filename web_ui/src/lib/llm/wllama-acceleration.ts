/**
 * wllama acceleration state (#265, AC4).
 *
 * SYNCHRONOUS by design: `LLMService.getInferenceMode()` is a sync member of
 * the shared contract (types/llm.ts), so the wllama backend it reports must be
 * derivable without an await. The probe therefore mirrors the checks the
 * INSTALLED wllama makes before it will use WebGPU — presence + one browser
 * carve-out — and deliberately does NOT call `navigator.gpu.requestAdapter()`
 * (an async adapter probe would need an async cached resolution redesigned
 * into `initialize()`; not taken, plan A2).
 *
 * wllama 3.5.1 semantics (node_modules/@wllama/wllama/esm/index.js):
 *   - `isSupportWebGPU = () => !!navigator.gpu` (presence only, no adapter
 *     request — index.js:1194-1196);
 *   - `isSupportJSPI = () => !!WebAssembly.Suspending` (index.js:1191-1193);
 *   - `isFirefox = () => !!navigator.userAgent.match(/Firefox\/([0-9\.]+)(?:\s|$)/)`
 *     (index.js:1217-1219);
 *   - getWorkerResources (index.js:3358-3367): on Firefox WITHOUT JSPI and
 *     without compat mode, wllama logs 'WebGPU is disabled on Firefox due to
 *     missing JSPI support' — i.e. navigator.gpu presence alone does not make
 *     WebGPU usable there.
 *
 * So wllama is WebGPU-eligible exactly when navigator.gpu is present AND the
 * browser is not Firefox-without-JSPI. Everything else — no WebGPU API at all
 * (jsdom included), or Firefox without JSPI — runs on the CPU/WASM backend.
 */

/** Derived, user-presentable acceleration state (never a raw backend name). */
export type WllamaAccelerationState = 'cpu' | 'webgpu-eligible';

const FIREFOX_UA = /Firefox\/([0-9.]+)(?:\s|$)/;

/** @wllama/wllama 3.5.1 isFirefox (esm/index.js:1217-1219). */
export function isFirefoxUserAgent(userAgent: string): boolean {
  return FIREFOX_UA.test(userAgent);
}

/** @wllama/wllama 3.5.1 isSupportJSPI (esm/index.js:1191-1193). */
function supportsJSPI(): boolean {
  return typeof WebAssembly !== 'undefined' && !!(WebAssembly as { Suspending?: unknown }).Suspending;
}

/** @wllama/wllama 3.5.1 isSupportWebGPU (esm/index.js:1194-1196): presence. */
function hasWebGPUInterface(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu;
}

/**
 * Whether the installed wllama can run its WebGPU backend here: navigator.gpu
 * present, and not Firefox without JSPI (wllama disables WebGPU there).
 */
export function isWllamaWebGPUAccelerated(): boolean {
  if (!hasWebGPUInterface()) return false;
  if (typeof navigator === 'undefined') return false;
  if (isFirefoxUserAgent(navigator.userAgent) && !supportsJSPI()) return false;
  return true;
}

/** The derived acceleration state for the wllama engine on this browser. */
export function getWllamaAccelerationState(): WllamaAccelerationState {
  return isWllamaWebGPUAccelerated() ? 'webgpu-eligible' : 'cpu';
}
