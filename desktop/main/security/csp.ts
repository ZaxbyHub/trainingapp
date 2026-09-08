// Content-Security-Policy for app:// renderer responses (issue #60, B2).
//
// Applied to EVERY app:// response (including 403/404) by
// desktop/main/protocol.ts — the same "every response, including errors"
// header discipline the airgapped server sets in web_ui/scripts/start.ps1.
//
// Documented relaxations, each named for its concrete consumer (everything not
// listed inherits the strict default-src):
//   - script-src 'wasm-unsafe-eval': ONNX Runtime Web and wllama compile WASM
//     in the packaged renderer (web_ui/src/lib/models/offline-env.ts,
//     web_ui/src/lib/llm/wllama-service.ts). Without this the embedding/LLM
//     runtimes cannot instantiate their .wasm. This is NOT 'unsafe-eval':
//     plain JS eval() stays blocked.
//   - script-src 'sha256-<PIN>': the ONE legitimate inline script, the theme
//     pre-paint bootstrap in web_ui/index.html (vited verbatim into dist).
//     web_ui/src/__tests__/ b2-csp-pin.test.ts pins this constant to the
//     actual hash of that script so a renderer change that adds or edits an
//     inline script fails CI until the pin is consciously updated. Any other
//     inline script — i.e. every injected one — is blocked.
//   - worker-src blob:: onnxruntime-web constructs its threaded workers from
//     blob: URLs when wasm.numThreads > 1 (offline-env.ts gates numThreads on
//     crossOriginIsolated, which protocol.ts's COOP/COEP headers enable).
//     The embedding worker itself is a same-origin module worker ('self').
//   - img-src/font-src data:: the offline data:-URI favicon and inline font
//     fallbacks in web_ui/index.html.
//   - connect-src http://127.0.0.1:* + http://[::1]:*: the B3 loopback
//     backend on its random free port (both literal loopback forms, symmetric
//     with the loopback-guard Host gate). app: stays allowed for app://-URL
//     fetches (the scheme registers supportFetchAPI).
// Deliberately absent (blocked by default or explicitly):
//   - 'unsafe-inline' / 'unsafe-eval' — never, in any directive.
//   - object-src 'none', base-uri 'none', form-action 'none',
//     frame-ancestors 'none' — no plugins, no base hijack, no form posting
//     out, no framing.

/**
 * The SHA-256 pin (base64, CSP 'sha256-' form) of the single legitimate
 * inline <script> in web_ui/index.html — the theme pre-paint bootstrap.
 * Verified against the tracked file by desktop/src/__tests__/b2-csp-pin.test.ts.
 */
export const INLINE_THEME_BOOTSTRAP_SHA256 = 'sha256-ePnZCi9JqiNJ5DC63H11BebwlVC43EKrYDz+F362Zi8=';

/** The strict policy applied to every app:// response. */
export function buildCspPolicy(): string {
  return [
    "default-src 'self' app:",
    `script-src 'self' app: 'wasm-unsafe-eval' '${INLINE_THEME_BOOTSTRAP_SHA256}'`,
    "style-src 'self' app:",
    "img-src 'self' app: data:",
    "font-src 'self' app:",
    "connect-src 'self' app: http://127.0.0.1:* http://[::1]:*",
    "worker-src 'self' app: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
