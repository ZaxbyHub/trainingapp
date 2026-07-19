/**
 * Issue #37 P2: air-gap build flag.
 *
 * The "air-gapped" release profile MUST NOT contain the WebLLM engine's CDN
 * egress path. `VITE_AIRGAP=1` is a BUILD-TIME constant (Vite inlines
 * `import.meta.env.VITE_AIRGAP` at build time), so consumers gated on
 * `IS_AIRGAP` are statically reachable/unreachable and Rollup can tree-shake
 * the heavy `@mlc-ai/web-llm` dependency when the flag is set.
 *
 * Mechanism: the dynamic `import('@mlc-ai/web-llm')` inside
 * `web-llm-service.ts._loadEngineFactory()` is wrapped in `if (!IS_AIRGAP)`.
 * With `IS_AIRGAP === true` that branch is unreachable, so Rollup never emits a
 * `@mlc-ai/web-llm` chunk. The thin `WebLLMService` wrapper module (a few KB of
 * TypeScript, no heavy deps) remains in the bundle but is never executed under
 * airgap: `getLLMService` returns wllama, and even if `initialize()` were
 * reached it throws at the IS_AIRGAP guard before the dynamic import. The
 * `validate-build --airgap` check asserts no `CreateMLCEngine` symbol survives
 * in any emitted chunk, catching any future regression.
 *
 * Usage: `npm run build:airgap` (wraps `build:offline` with `VITE_AIRGAP=1`).
 */
export const IS_AIRGAP: boolean = import.meta.env.VITE_AIRGAP === '1';
