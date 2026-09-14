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
//     desktop/src/__tests__/b2-csp-pin.test.ts pins this constant to the
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
    // Explicit (rather than inherited from default-src) to pin the framing
    // posture independently of future default-src edits. PRR96-008.
    "frame-src 'self' app:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The training-pack policy (issue #81, D5) applied to responses served from
 * the app://training/<packId>/ route — i.e. to FIRST-PARTY documents shipped
 * inside an installed knowledge pack (assets/player/**), never to renderer
 * documents. Deltas from buildCspPolicy(), each proven necessary by the live
 * player probe captured in the #81 trace (evidence/csp-profile-*.log):
 *   - script-src 'unsafe-inline': the pack's story.html boots from an inline
 *     <script> (window.globals + the dynamic bootstrapper loader). Without
 *     'unsafe-inline' the player never starts. No 'unsafe-eval' is needed:
 *     the probe recorded zero script-src violations beyond inline content.
 *   - style-src 'unsafe-inline': the player runtime writes inline style
 *     attributes/elements constantly (72 violations in the probe run).
 *   - font-src data: + media-src 'self' app: data:: the publish inlines its
 *     fonts and narration audio as data: URIs (28 + 79 violations).
 *   - connect-src tightened to 'self' app:: pack content has no business
 *     calling the loopback backend, and the probe confirmed the player makes
 *     no loopback requests. (Dropping the loopback sources also avoids
 *     carrying Chromium's 'http://[::1]:*' source-list parse warning into a
 *     document class that never needed it.)
 *   - frame-ancestors omitted entirely: on the PACK document frame-ancestors
 *     governs who may embed the pack; the only embedder is our own renderer
 *     (whose embedding decision is made by the RENDERER policy's frame-src,
 *     already 'self' app:). A pack-side frame-ancestors 'none' would forbid
 *     the app's own player iframe; omitting it is harmless because app:// is
 *     a private scheme unreachable from the web. The renderer document keeps
 *     the strict 'none'.
 * Everything else (COOP/COEP/CORP attachment, nosniff, no-cache) is applied
 * by protocol.ts exactly as for renderer responses.
 */
export function buildTrainingCspPolicy(): string {
  return [
    "default-src 'self' app:",
    "script-src 'self' app: 'wasm-unsafe-eval' 'unsafe-inline'",
    "style-src 'self' app: 'unsafe-inline'",
    "img-src 'self' app: data:",
    "font-src 'self' app: data:",
    "connect-src 'self' app:",
    "worker-src 'self' app: blob:",
    "frame-src 'self' app:",
    "media-src 'self' app: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
