/**
 * Redaction gate for the diagnostics logging core (issue #248, AC5).
 *
 * SEMANTIC TWIN CONTRACT: desktop/main/logging-redact.ts implements the exact
 * same classifier for the Electron main process. Both twins are pinned to the
 * shared corpus contracts/diagnostics-redaction-vectors.json by
 * diagnostics-redact-parity.test.ts (desktop) and web-logging.test.ts (web):
 * the persisted redacted bytes must be IDENTICAL on both platforms. Change
 * this file only together with its twin and the corpus (regenerate it with
 * contracts/tests/gen-diagnostics-redaction-vectors.mjs).
 *
 * Classification model (05-fix-plan.md, transport policy): a line is
 * SENSITIVE when any redaction class matches it; `redactLine` is the single
 * source of that verdict (`isSensitiveLine` is redactLine !== identity).
 * Console policy (three-way: clean raw / pinned-sensitive raw on desktop /
 * other sensitive `[sanitized]`) and the persisted form (always gated) both
 * derive from these functions. Classification failures fail CLOSED: callers
 * drop the entry and warn once per session (never re-entering this module).
 *
 * Redaction classes, applied in this fixed order:
 *   1. `bearer <token>` (auth-scheme prefix)          -> `[redacted]`
 *   2. JWT (`eyJ…` two/three base64url segments)        -> `[redacted]`
 *   3. kv secrets (any compound/plural of secret|token|password|passwd|
 *      api[-_]key|apikey|authorization|cookie|session[-_]?id|sessionid|
 *      credential — client_secret, refresh_token, openai_api_key, secrets)
 *      in `key=value`, `key: value` and JSON `"key": "value"` shapes; a
 *      QUOTED value redacts the quoted span, a BARE value the rest of the
 *      line (a password phrase is the whole remainder) -> `[redacted]`
 *   4. `sk-…` provider keys                            -> `[redacted]`
 *   5. hex runs of 16+ characters                      -> `[redacted-hex]`
 *   6. user-home paths (Windows `%USERPROFILE%`, unix /home|/Users)
 *      including the username                          -> `<user-dir>`
 *   7. email addresses (bounded quantifiers)           -> `[redacted-email]`
 * Before classification, zero-width/BOM characters are stripped (PRR-029:
 * a key split by an invisible character must not dodge the gate), and only
 * the first CLASSIFY_CAP characters are classified/redacted (PRR-005: the
 * persisted budget is 2,000, so nothing beyond the cap is ever persisted,
 * and the bounded input keeps every class's cost linear).
 * Truncation (2,000-char budget, `…[truncated]`) applies AFTER redaction, so
 * a secret straddling the cut can never survive as a fragment.
 *
 * This module deliberately imports nothing: it is the leaf the logging core,
 * the desktop twin, and the export bundle all depend on.
 */

/** Per-line character budget for persisted/sanitized forms. */
export const LINE_BUDGET = 2000;

/**
 * Classification/redaction input cap (PRR-005). Only the first 4,096 chars of
 * a (zero-width-stripped) line are classified/redacted; the 2,000-char
 * persisted budget means nothing beyond the cap can ever be persisted.
 */
export const CLASSIFY_CAP = 4096;

/** Object-serialization depth cap (plan: depth cap 2). */
const DEPTH_CAP = 2;
/** Object-serialization array member cap (plan: array cap 20). */
const ARRAY_CAP = 20;

/**
 * Key names whose values are never emitted in serialized objects. The
 * optional `[A-Za-z0-9_-]` prefix keeps exact-name dodges (userText,
 * queryText, documentText, …) inside the gate, and answer/response/context/
 * message close the docx-extractor `{type,message}` shape (PRR-086, also the
 * PRR-039 mechanism).
 */
const DENYLIST_FIELD =
  /^(?:[A-Za-z0-9_-]*)(?:text|content|prompt|query|chunks|documents|body|payload|answer|response|context|message)$/i;

/**
 * Sensitive key union for the kv-secret class: a key is any
 * separator/alphanumeric-prefixed compound of a sensitive morpheme plus an
 * optional plural `s` (PRR-012: client_secret, refresh_token,
 * openai_api_key, secrets). Ordinary prose keeps its following word — the kv
 * shapes below still require a `:`/`=` separator directly after the key, so
 * "the secret of" never matches.
 */
const KV_SECRET_KEYS =
  '[A-Za-z0-9_-]*(?:secret|token|password|passwd|api_key|apikey|authorization|cookie|session_id|sessionid|credential)s?';

/**
 * Zero-width/BOM characters stripped before classification (PRR-029's cheap
 * defense: `tok\u200ben=` must not dodge the key union).
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/**
 * PRR-029 (homoglyph half): the key union is ASCII-only, so `passwоrd=` with a
 * Cyrillic о classifies CLEAN and persists verbatim. A curated confusables map
 * (the Cyrillic/Greek letters that collide with the Latin ones in the key
 * union) is applied as a LEAK-AVOIDANCE OVERRIDE in redactLine: the folded
 * form is used ONLY when the un-folded line would otherwise pass as clean, so
 * an ordinary non-English log line keeps its original characters.
 */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'п': 'p', 'с': 'c',
  'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'т': 't',
  'н': 'h', 'ј': 'j', 'к': 'k', 'м': 'm', 'в': 'b',
  'ԁ': 'd', 'ɼ': 'r', 'ᴀ': 'a', 'ᴅ': 'd', 'ᴇ': 'e',
  'ᴋ': 'k', 'ʟ': 'l', 'ᴏ': 'o', 'ᴘ': 'p', 'ᴛ': 't',
  'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ᴢ': 'z',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'ο': 'o', 'υ': 'u',
  'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'χ': 'c',
  'μ': 'm', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z',
  'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N',
  'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};
const CONFUSABLE_RE = new RegExp('[' + Object.keys(CONFUSABLES).join('') + ']', 'g');

/** Fold script-confusable letters to their Latin lookalikes (1:1, length-preserving). */
function foldConfusables(line: string): string {
  return line.replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] as string);
}

const BEARER_RE = /\bbearer\s+[^"'\s]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const HEX_RUN_RE = /[0-9a-fA-F]{16,}/g;
const USER_HOME_RE =
  /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/:*?"<>|\r\n]+|\/(?:home|Users)\/[^/\s:]+)/g;
/**
 * Bounded email pattern (PRR-005): local part ≤64 and domain ≤255 (RFC 5321),
 * so a long non-matching run backtracks a bounded amount per start position
 * instead of quadratically.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g;
/** JSON shape `"key": "value"` (key quoted). */
const KV_JSON_RE = new RegExp(
  `("(?:${KV_SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\\\n]|\\\\.)*"`,
  'gi',
);
/**
 * `key=value` / `key: value`. A QUOTED value redacts exactly the quoted span;
 * a BARE value is the rest of the line — a password phrase is the whole
 * remainder, not its first whitespace-delimited token (PRR-011).
 */
const KV_BARE_RE = new RegExp(
  `(\\b(?:${KV_SECRET_KEYS})\\b\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\r\\n]*)`,
  'gi',
);

/** Apply every redaction class, in the fixed order above, to one string. */
function applyClasses(line: string): string {
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

/** Apply every redaction class, in the fixed order above. */
export function redactLine(line: string): string {
  // PRR-029/PRR-005: strip invisible characters, then gate only the first
  // CLASSIFY_CAP chars. The tail is returned as-is: it is beyond every
  // persisted surface (LINE_BUDGET truncates to 2,000 first).
  const stripped = line.replace(ZERO_WIDTH_RE, '');
  const head = stripped.length > CLASSIFY_CAP ? stripped.slice(0, CLASSIFY_CAP) : stripped;
  const direct = applyClasses(head);
  // PRR-029 (homoglyph half): only when the direct pass redacts nothing do we
  // fall back to the confusables-folded form, so a secret spelled with
  // lookalike letters is still gated while an ordinary non-English line keeps
  // its original characters.
  const folded = foldConfusables(head);
  const foldedRedacted = applyClasses(folded);
  const redactedHead = direct !== head ? direct : foldedRedacted !== folded ? foldedRedacted : direct;
  return head.length === stripped.length ? redactedHead : redactedHead + stripped.slice(CLASSIFY_CAP);
}

/** Redact, then enforce the per-line budget. */
export function persistedForm(line: string): string {
  const redacted = redactLine(line);
  return redacted.length <= LINE_BUDGET ? redacted : `${redacted.slice(0, LINE_BUDGET)}…[truncated]`;
}

/** A line is sensitive exactly when any redaction class would change it. */
export function isSensitiveLine(line: string | unknown[]): boolean {
  // PRR-031: the console path classifies arg lists, not just joined lines —
  // a secret split across console arguments never matches the joined form,
  // because the joining space replaces the `:`/`=` the kv shapes require.
  if (Array.isArray(line)) return isSensitiveArgs(line);
  return redactLine(line) !== line;
}

/**
 * Arg-aware sensitivity (PRR-031): the joined line, each rendered argument
 * alone, and each ADJACENT PAIR of rendered arguments (`key` argument
 * followed by its value argument) are all classified; any sensitive form
 * makes the whole call sensitive. The persisted form stays the joined
 * redaction.
 */
export function isSensitiveArgs(args: unknown[]): boolean {
  const rendered = args.map(serializeArg);
  if (isSensitiveLine(rendered.join(' '))) return true;
  for (let i = 0; i < rendered.length; i += 1) {
    const form = rendered[i] ?? '';
    if (isSensitiveLine(form)) return true;
    const next = rendered[i + 1];
    if (next !== undefined && isSensitiveLine(`${form}: ${next}`)) return true;
  }
  return false;
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
      // PRR-007: a function is not serializable data. Copying an own-
      // enumerable toJSON onto the fresh object would let JSON.stringify
      // invoke it and emit the raw value, defeating the denylist — dropped.
      if (typeof item === 'function') continue;
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
