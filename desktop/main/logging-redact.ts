// Redaction gate for the desktop diagnostics logging core (issue #248, AC5).
//
// SEMANTIC TWIN CONTRACT: web_ui/src/lib/logging/redact.ts implements the
// exact same classifier for the renderer/browser. Both twins are pinned to
// the shared corpus contracts/diagnostics-redaction-vectors.json by
// desktop/src/__tests__/diagnostics-redact-parity.test.ts: the persisted
// redacted bytes must be IDENTICAL on both platforms. Change this file only
// together with its twin and the corpus.
//
// Classification model (05-fix-plan.md, transport policy): a line is
// SENSITIVE when any redaction class matches it; `redactLine` is the single
// source of that verdict (`isSensitiveLine` is redactLine !== identity).
// Console policy (three-way: clean raw / pinned-sensitive raw per the finite
// AC7 exception in logging.ts / other sensitive `[sanitized]`) and the
// persisted form (always gated) both derive from these functions.
// Classification failures fail CLOSED: callers drop the entry and warn once
// per session (never re-entering this module).
//
// Redaction classes, applied in this fixed order:
//   1. `bearer <token>` (auth-scheme prefix)          -> `[redacted]`
//   2. JWT (`eyJ…` two/three base64url segments)        -> `[redacted]`
//   3. kv secrets (password|passwd|token|secret|api[-_]?key|apikey|
//      authorization|cookie|session[-_]?id|sessionid) in `key=value`,
//      `key: value` and JSON `"key": "value"` shapes  -> `[redacted]`
//   4. `sk-…` provider keys                            -> `[redacted]`
//   5. hex runs of 16+ characters                      -> `[redacted-hex]`
//   6. user-home paths (Windows `%USERPROFILE%`, unix /home|/Users)
//      including the username                          -> `<user-dir>`
//   7. email addresses                                 -> `[redacted-email]`
// Truncation (2,000-char budget, `…[truncated]`) applies AFTER redaction, so
// a secret straddling the cut can never survive as a fragment.
//
// This module deliberately imports nothing: it is the leaf the logging core
// and the export bundle depend on.

/** Per-line character budget for persisted/sanitized forms. */
export const LINE_BUDGET = 2000;

/** Object-serialization depth cap (plan: depth cap 2). */
const DEPTH_CAP = 2;
/** Object-serialization array member cap (plan: array cap 20). */
const ARRAY_CAP = 20;

/** Key names whose values are never emitted in serialized objects. */
const DENYLIST_FIELD = /^(?:text|content|prompt|query|chunks|documents|body|payload)$/i;

/** Sensitive key union for the kv-secret class. */
const KV_SECRET_KEYS =
  'password|passwd|token|secret|api[-_]?key|apikey|authorization|cookie|session[-_]?id|sessionid';

const BEARER_RE = /\bbearer\s+[^"'\s]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const HEX_RUN_RE = /[0-9a-fA-F]{16,}/g;
const USER_HOME_RE =
  /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/:*?"<>|\r\n]+|\/(?:home|Users)\/[^/\s:]+)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** JSON shape `"key": "value"` (key quoted). */
const KV_JSON_RE = new RegExp(
  `("(?:${KV_SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\\\n]|\\\\.)*"`,
  'gi',
);
/** `key=value` / `key: value`, value optionally quoted. */
const KV_BARE_RE = new RegExp(
  `(\\b(?:${KV_SECRET_KEYS})\\b\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;}"']+)`,
  'gi',
);

/** Apply every redaction class, in the fixed order above. */
export function redactLine(line: string): string {
  return line
    .replace(BEARER_RE, '[redacted]')
    .replace(JWT_RE, '[redacted]')
    .replace(KV_JSON_RE, '$1"[redacted]"')
    .replace(KV_BARE_RE, '$1[redacted]')
    .replace(SK_KEY_RE, '[redacted]')
    .replace(HEX_RUN_RE, '[redacted-hex]')
    .replace(USER_HOME_RE, '<user-dir>')
    .replace(EMAIL_RE, '[redacted-email]');
}

/** Redact, then enforce the per-line budget. */
export function persistedForm(line: string): string {
  const redacted = redactLine(line);
  return redacted.length <= LINE_BUDGET ? redacted : `${redacted.slice(0, LINE_BUDGET)}…[truncated]`;
}

/** A line is sensitive exactly when any redaction class would change it. */
export function isSensitiveLine(line: string): boolean {
  return redactLine(line) !== line;
}

/** The marked single-string console form for a non-pinned sensitive line. */
export function sanitizedConsoleForm(line: string): string {
  return `[sanitized] ${persistedForm(line)}`;
}

type Seen = WeakSet<object>;

/** Cap depth/arrays and strip denylisted fields, then JSON.stringify. */
function toJsonIsh(value: unknown, depth: number, seen: Seen): unknown {
  if (Array.isArray(value)) {
    if (depth >= DEPTH_CAP) return '[depth-capped]';
    const head = value.slice(0, ARRAY_CAP).map((item) => toJsonIsh(item, depth + 1, seen));
    if (value.length > ARRAY_CAP) head.push(`+${value.length - ARRAY_CAP} more`);
    return head;
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (depth >= DEPTH_CAP) return '[depth-capped]';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = DENYLIST_FIELD.test(key) ? '[redacted-field]' : toJsonIsh(item, depth + 1, seen);
    }
    return out;
  }
  if (value === undefined) return null;
  return value;
}

/**
 * Serialize one console argument for rendering: strings as-is, errors as
 * `name: message`, objects/arrays as capped denylisted JSON.
 */
export function serializeArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || value === undefined) return String(value);
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
  if (t === 'symbol' || t === 'function') return `[${t}]`;
  try {
    return JSON.stringify(toJsonIsh(value, 0, new WeakSet()));
  } catch {
    // Unserializable (exotic getter, proxy): a stable opaque token, and the
    // caller's fail-closed policy still applies to the rendered line.
    return '[unserializable]';
  }
}

/** Render a console-style argument list to the single line that is classified. */
export function renderLine(args: unknown[]): string {
  return args.map(serializeArg).join(' ');
}
