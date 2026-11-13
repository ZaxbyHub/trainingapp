/**
 * Engine visibility policy (#265, decision comment 6825525627).
 *
 * ONE shared gate for every WebLLM surface. The recorded maintainer decision
 * is HIDE-by-default: WebLLM's engine path downloads Llama 3.2 (~1.9 GB) from
 * the WebLLM CDN, which contradicts the offline guarantee of every packaged
 * build, so the option is visible only in plain dev builds. A plain
 * production web build has no offline marker beyond DEV, so `DEV && !IS_AIRGAP`
 * implements exactly the recorded HIDE/HIDE defaults:
 *
 *   - `vite` dev server            → visible (developer builds keep the engine
 *                                     for engine-comparison work).
 *   - `build` / `build:offline`    → hidden (packaged builds).
 *   - `build:airgap` (VITE_AIRGAP) → hidden (the air-gap profile additionally
 *                                     tree-shakes the engine, issue #37 P2).
 *
 * `import.meta.env.DEV` is a build-time literal, so consumers gated on this
 * constant are statically reachable/unreachable and Rollup can prune the
 * WebLLM UI surface out of packaged builds the same way IS_AIRGAP prunes the
 * engine import.
 *
 * Consumers (issue #265 AC3, plan A3):
 *   i.   SettingsPage — the WebLLM radio option, its Download panel and every
 *        recommendation surface render it only when WEBLLM_VISIBLE;
 *   ii.  InferenceModeContext — a persisted 'webllm' preference normalizes to
 *        'wllama' when hidden;
 *   iii. llm-factory — the factory boundary returns wllama for 'webllm' when
 *        hidden, so a stale preference can never reach the Llama download;
 *   iv.  engine-capability — the recommendation is computed among visible
 *        engines only (the raw WebGPU hardware result is retained either way).
 */
import { IS_AIRGAP } from './airgap';

/** True only in plain dev builds: the WebLLM engine is a selectable option. */
export const WEBLLM_VISIBLE: boolean = import.meta.env.DEV && !IS_AIRGAP;
