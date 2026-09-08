// Loopback transport guard (issue #60, Workstream B2).
//
// A backend-agnostic request gate that sits in FRONT of whatever backend
// Workstream B3 (#61) hosts, per ADR-0003 (still open — Node main vs Electron-
// hosted Python sidecar; this guard must sit in front of the sidecar too).
// It is a pure (request) => Response | null gate so any server surface can
// compose it: `const verdict = guard(req); if (verdict) return verdict; /* backend */`.
//
// Frozen decision rules (desktop/src/__tests__/b2-loopback-guard.test.ts and
// b2-loopback-origin.test.ts):
//   R1 TOKEN: request token header must EQUAL the launch token; missing/wrong
//      -> 401, and the rejection body never echoes the token.
//   R2 ORIGIN: when an Origin header is present it must match an
//      allowedOrigins pattern ('app://*' matches every app:// origin).
//      Mismatch (evil.example, 'null', subdomain tricks) -> 403 REGARDLESS of
//      token validity. A present-but-EMPTY Origin header is anomalous and is
//      rejected the same way (fail closed).
//   R3 HOST: for requests whose URL scheme is http(s) (i.e. bound for the
//      loopback backend rather than the app:// renderer surface), the
//      effective host (Host header when present, else the URL host) must be
//      the LITERAL loopback address 127.0.0.1 or [::1] on any port. The NAME
//      'localhost' is NOT accepted (DNS-rebinding hardening) and LAN/private
//      IPs are NOT accepted -> 403 even with a valid token.
//   R4 PASS: every check passes -> null (caller proceeds to its backend).
//   R5 ISOLATION: the guard never touches the network and never calls a
//      backend; composition is the caller's job.
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_TOKEN_HEADER_NAME } from './config.js';

export interface LoopbackGuardRequest {
  // MUST be an ABSOLUTE URL (e.g. 'http://127.0.0.1:<port>/api' or
  // 'app://index.html'). A Node http server's req.url is a BARE path and will
  // fail closed here (403) — B3 adapters must build the absolute form, e.g.
  // `http://127.0.0.1:${port}${req.url}`.
  url: string;
  headers: { get(name: string): string | null };
  // Reserved for B3 CORS-preflight handling (issue #61): if provided, an
  // adapter MAY exempt OPTIONS — but only AFTER the origin/host gates below,
  // never before them. Unset requests are treated as non-preflight.
  method?: string;
}

export type LoopbackGuard = (request: LoopbackGuardRequest) => Response | null;

export interface CreateLoopbackGuardOptions {
  token: string;
  tokenHeaderName?: string;
  allowedOrigins?: string[];
}

/** Match an Origin header value against a pattern list ('x://*' wildcards the remainder). */
export function originAllowed(origin: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (origin.startsWith(pattern.slice(0, -1))) return true;
    } else if (origin === pattern) {
      return true;
    }
  }
  return false;
}

/** The literal loopback hosts the transport accepts for http(s) requests. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(hostWithPort: string): boolean {
  let host = hostWithPort.toLowerCase().trim();
  if (host.startsWith('[')) {
    // IPv6 literal: strip the port but keep the closing bracket ('[::1]:8765' -> '[::1]').
    const end = host.indexOf(']');
    if (end === -1) return false; // unterminated bracket: malformed, fail closed
    host = host.slice(0, end + 1);
  } else {
    // IPv4/hostname: drop the port ('127.0.0.1:8765' -> '127.0.0.1').
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(host);
}

function fail(status: 401 | 403, body: string): Response {
  // Bodies are static on purpose: no request material (least of all the
  // token) is ever echoed back on a rejection path.
  return new Response(body, { status });
}

/**
 * Create the request gate. Evaluation order: origin (R2), then host (R3),
 * then token (R1) — wrong-origin/host requests are rejected before the token
 * is even looked at, so token validity can never launder a bad origin.
 */
export function createLoopbackGuard(opts: CreateLoopbackGuardOptions): LoopbackGuard {
  const tokenHeaderName = (opts.tokenHeaderName ?? DEFAULT_TOKEN_HEADER_NAME).toLowerCase();
  const allowedOrigins = opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;

  return (request: LoopbackGuardRequest): Response | null => {
    // Case-insensitive lookup wrapper: real fetch/Headers implementations fold
    // case, but the type contract cannot force a custom B3 adapter to — so the
    // guard folds the lookup itself and adapters stay safe by construction.
    const getHeader = (name: string): string | null => request.headers.get(name.toLowerCase());

    // R2 ORIGIN (fail closed on present-but-empty).
    const origin = getHeader('origin');
    if (origin !== null && !originAllowed(origin, allowedOrigins)) {
      return fail(403, 'Forbidden');
    }

    // R3 HOST for http(s) requests (app:// requests are governed by R2).
    let scheme = '';
    let urlHost: string | null = null;
    try {
      const parsed = new URL(request.url);
      scheme = parsed.protocol.replace(':', '');
      urlHost = parsed.host;
    } catch {
      return fail(403, 'Forbidden'); // unparseable/bare-path URL: fail closed
    }
    if (scheme === 'http' || scheme === 'https') {
      const effectiveHost = getHeader('host') ?? urlHost ?? '';
      if (!isLoopbackHost(effectiveHost)) {
        return fail(403, 'Forbidden');
      }
    }

    // R1 TOKEN. Plain string equality: NOT constant-time, but the token is a
    // 256-bit per-launch CSPRNG secret served only over loopback and rotated
    // every launch, so timing sampling of a never-reused secret is not a
    // practical attack here. Revisit only if the transport ever leaves
    // loopback.
    const supplied = getHeader(tokenHeaderName);
    if (supplied !== opts.token) {
      return fail(401, 'Unauthorized');
    }

    // R4 PASS.
    return null;
  };
}
