// training-relay.ts — the APP-side byte relay that feeds the player-origin
// service worker, trace browser-training-parity AC3/AC11 (ADR-0012).
//
// Threat model: NOTHING on the player origin is trusted (course JS can read
// the boot frame's DOM, hijack its port, send the service worker its own
// handshake). All enforcement therefore lives here, in the app page:
//   * requests arrive ONLY on a MessagePort the app created and transferred
//     (never through window message events);
//   * only `/training/<openPackId>/<rest>` is answered, where openPackId is
//     the pack the app's Training page currently has open (app state, not
//     request data), mapped to that pack's ACTIVE version by the app-origin
//     registry; any other pack or path is refused;
//   * path containment uses the same decode / segment / pack-id rules as
//     desktop resolveTrainingRequest (desktop/main/protocol.ts), pinned by
//     the shared vectors in contracts/training-path-vectors.json;
//   * reads are size-bounded (<= 16 MiB per message) and rate-bounded (one
//     window shared by every port, so a fresh handshake earns no fresh budget).
// The relay answers with the status, headers and bytes the service worker
// turns into a Response (Range 206/416, MIME, CORP, nosniff, training CSP).

/** Mirror of desktop PACK_ID_PATTERN (desktop/main/protocol.ts). */
export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;

/** Largest byte range one relay message may carry. */
export const MAX_RELAY_READ_BYTES = 16 * 1024 * 1024;
/** Requests allowed per rate window (shared across ports). */
export const RELAY_RATE_LIMIT = 2000;
export const RELAY_RATE_WINDOW_MS = 10_000;
/** Open file handles allowed per relay (bounds memory held for the worker). */
export const MAX_OPEN_HANDLES = 64;
/**
 * Reads materialized at once, across every port (review round 1, F3): a
 * course that takes the relay port could otherwise queue thousands of 16 MiB
 * reads inside the rate window and exhaust the app tab's memory. Excess
 * reads are refused with code 'busy'; the player-origin worker retries them.
 */
export const MAX_INFLIGHT_READS = 32;
export const MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;

/** Mirror of desktop protocol.ts MIME_TYPES (drift-tested). */
export const TRAINING_MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.gguf': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function mimeTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return TRAINING_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** The course service worker's script path on the player origin (public/training/sw.js). */
export const TRAINING_SW_SCRIPT_PATH = '/training/sw.js';

/**
 * The course worker sources (review round 4, F1): `blob:` plus the OPEN
 * pack's own relay path, never `'self'`. On the player origin `'self'`
 * would admit every app asset (`/assets/*.js`, `/training-boot.js`,
 * `/training/sw.js`), which the host serves with only frame-ancestors
 * 'none'. A worker takes its policy from its own script response, so a
 * worker built from one of them would run unconfined. Pack scripts are
 * answered by the relay with this course CSP, so a worker built from one
 * stays confined, and a `blob:` worker inherits its creator's policy (HTML
 * Standard, "run a worker": a local-scheme worker URL gets a clone of the
 * owner's policy container). Without a valid open pack: `blob:` only.
 *
 * With an open pack the list also names the course service worker's own
 * script URL, exactly (`<player>/training/sw.js`, no directory, no `'self'`).
 * Firefox lets a document controlled by a service worker start a dedicated
 * worker from a URL only if the document's worker-src admits the CONTROLLING
 * service worker's script URL; without it every pack-script worker fails with
 * a worker-src violation naming `/training/sw.js?app=...` (measured, Firefox
 * and Playwright's Firefox; `blob:` workers are exempt; the worker response's
 * own CSP makes no difference). That source grants course content nothing it
 * lacked: a dedicated or shared worker on `/training/sw.js` is answered 404 by
 * the service worker (sw.js fetch handler), so it never runs, and registering
 * `/training/sw.js` was already possible through the boot frame, whose header
 * CSP admits exactly this URL (vite.config.ts bootPageCsp).
 */
export function courseWorkerSources(playerOrigin: string, packId: string | null): string {
  return packId !== null && PACK_ID_PATTERN.test(packId) ? `blob: ${playerOrigin}/training/${packId}/ ${playerOrigin}${TRAINING_SW_SCRIPT_PATH}` : 'blob:';
}

/**
 * The training-pack CSP for an http(s) player origin: the desktop
 * buildTrainingCspPolicy (desktop/main/security/csp.ts) with the private
 * `app:` scheme sources dropped, plus frame-ancestors pinned to the player
 * origin itself and the app origin (desktop omits frame-ancestors because
 * app: is unreachable from the web; a web origin is not). One deliberate
 * divergence: worker-src is courseWorkerSources, not `'self' blob:` — on
 * desktop every successful app://training response carries this training
 * CSP, so a `'self'` worker stays confined there (its 403/404 responses
 * carry the renderer CSP with frame-ancestors 'none', but a 4xx can never be
 * loaded as a worker script); on the player origin it would not.
 */
export function buildBrowserTrainingCsp(appOrigin: string, playerOrigin: string, packId: string | null): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `worker-src ${courseWorkerSources(playerOrigin, packId)}`,
    "frame-src 'self'",
    "media-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors 'self' ${appOrigin}`,
  ].join('; ');
}

export type ResolvedTrainingPath =
  | { kind: 'file'; packId: string; segments: string[] }
  | { kind: 'refuse'; status: 403 | 404 };

/**
 * Resolve a raw request pathname ('/training/<packId>/<rest>') exactly like
 * desktop resolveTrainingRequest: query/fragment stripped, percent-decoded
 * (malformed -> 404), empty segments dropped, fewer than three segments ->
 * 404, pack id must match PACK_ID_PATTERN (403), '.'/'..' segments (403),
 * backslash or NUL anywhere in the decoded path (403).
 */
export function resolveTrainingPath(rawPath: string): ResolvedTrainingPath {
  let rest = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  const suffix = rest.search(/[?#]/);
  if (suffix >= 0) rest = rest.slice(0, suffix);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return { kind: 'refuse', status: 404 };
  }
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0] !== 'training') return { kind: 'refuse', status: 404 };
  if (segments.length < 3) return { kind: 'refuse', status: 404 };
  const packId = segments[1]!;
  if (!PACK_ID_PATTERN.test(packId)) return { kind: 'refuse', status: 403 };
  const restSegments = segments.slice(2);
  if (restSegments.some((segment) => segment === '.' || segment === '..')) return { kind: 'refuse', status: 403 };
  if (decoded.includes('\\') || decoded.includes('\0')) return { kind: 'refuse', status: 403 };
  return { kind: 'file', packId, segments: restSegments };
}

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Desktop serveUnderRoot Range semantics: `bytes=a-b`, `bytes=a-`, suffix
 * `bytes=-n`; anything else is ignored (full body); an unsatisfiable range is
 * 'unsatisfiable' (416).
 */
export function parseRange(header: string | null, total: number): ParsedRange | 'unsatisfiable' | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, total - Number(match[2]));
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
  }
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && start < total) {
    return { start, end };
  }
  return 'unsatisfiable';
}

// --------------------------------------------------------------------- //
// relay protocol (structured-clone messages over the app-created port)
// --------------------------------------------------------------------- //

export interface RelayOpenRequest {
  type: 'open';
  id: number;
  path: string;
  method: 'GET' | 'HEAD';
  range: string | null;
}
export interface RelayReadRequest {
  type: 'read';
  id: number;
  handle: number;
  offset: number;
  length: number;
}
export interface RelayCloseRequest {
  type: 'close';
  handle: number;
}
export type RelayRequest = RelayOpenRequest | RelayReadRequest | RelayCloseRequest;

export interface RelayOpenResponse {
  type: 'open-result';
  id: number;
  status: number;
  headers: Record<string, string>;
  /** Short plain-text body for refusals (403/404/416/...). */
  body?: string;
  /** For 200/206 GET: a handle whose bytes [start, end] the worker reads in slices. */
  handle?: number;
  start?: number;
  end?: number;
}
export interface RelayReadResponse {
  type: 'read-result';
  id: number;
  bytes?: ArrayBuffer;
  error?: string;
  /** 'busy': refused by the in-flight bound; retry later. */
  code?: 'busy';
}
export type RelayResponse = RelayOpenResponse | RelayReadResponse;

export interface TrainingRelayOptions {
  /** Read `assets/player/<segments>` of the pack's ACTIVE version from app storage. */
  readActiveFile(packId: string, segments: readonly string[]): Promise<Blob | null>;
  /** The app origin (for the training CSP's frame-ancestors). */
  appOrigin: string;
  /** The player origin (for the training CSP's pinned worker-src). */
  playerOrigin: string;
  now?: () => number;
}

interface OpenHandle {
  blob: Blob;
  start: number;
  end: number;
  packId: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function baseHeaders(appOrigin: string, playerOrigin: string, packId: string | null): Record<string, string> {
  return {
    'content-security-policy': buildBrowserTrainingCsp(appOrigin, playerOrigin, packId),
    'cross-origin-resource-policy': 'cross-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  };
}

export interface RelayControlMessage {
  type: string;
  hadActiveWorker?: boolean;
}

export class TrainingRelay {
  /** Worker control messages on the relay port (e.g. `relay-ready`); never relay requests. */
  onControl: ((message: RelayControlMessage) => void) | null = null;
  private openPackId: string | null = null;
  /** Requests answered for the open pack since it was opened (first-load detection). */
  private served = 0;
  private nextHandle = 1;
  private readonly handles = new Map<number, OpenHandle>();
  private port: MessagePort | null = null;
  private windowStart = 0;
  private windowCount = 0;
  private inFlightReads = 0;
  private inFlightBytes = 0;

  constructor(private readonly opts: TrainingRelayOptions) {}

  /** The pack the Training page has open (app state); null serves nothing. */
  setOpenPack(packId: string | null): void {
    if (packId !== this.openPackId) this.handles.clear();
    this.openPackId = packId;
    this.served = 0;
  }

  /** How many requests for the open pack reached the relay since it was opened. */
  servedCount(): number {
    return this.served;
  }

  getOpenPack(): string | null {
    return this.openPackId;
  }

  /** Bind the relay to the app-created port; any previous port is closed. */
  attachPort(port: MessagePort): void {
    if (this.port !== null && this.port !== port) {
      this.port.onmessage = null;
      this.port.close();
    }
    this.port = port;
    // Handles stay valid across port changes (a worker request answered on
    // the previous port continues on the new one); they are scoped to the
    // open pack and dropped when it changes.
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (data !== null && typeof data === 'object' && data.type === 'relay-ready') {
        this.onControl?.(data as RelayControlMessage);
        return;
      }
      void this.handleRequest(event.data).then((reply) => {
        if (reply === null || this.port !== port) return;
        if (reply.type === 'read-result' && reply.bytes !== undefined) port.postMessage(reply, [reply.bytes]);
        else port.postMessage(reply);
      });
    };
    port.start();
  }

  detach(): void {
    if (this.port !== null) {
      this.port.onmessage = null;
      this.port.close();
      this.port = null;
    }
    this.handles.clear();
  }

  private rateLimited(): boolean {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.windowStart > RELAY_RATE_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount > RELAY_RATE_LIMIT;
  }

  private status(id: number, status: number, extra: Record<string, string> = {}): RelayOpenResponse {
    const body =
      status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 416 ? 'Range Not Satisfiable' : status === 429 ? 'Too Many Requests' : 'Refused';
    return {
      type: 'open-result',
      id,
      status,
      // Refusals pin workers to the open pack too: course JS can frame a
      // relay refusal and script it.
      headers: { ...baseHeaders(this.opts.appOrigin, this.opts.playerOrigin, this.openPackId), 'content-type': 'text/plain; charset=utf-8', ...extra },
      body,
    };
  }

  /** Validate and answer one request (pure; the port wiring calls this). */
  async handleRequest(raw: unknown): Promise<RelayResponse | null> {
    if (typeof raw !== 'object' || raw === null) return null;
    const msg = raw as Partial<RelayRequest> & { type?: unknown };
    if (msg.type === 'close') {
      if (isInt((msg as RelayCloseRequest).handle)) this.handles.delete((msg as RelayCloseRequest).handle);
      return null;
    }
    const id = (msg as { id?: unknown }).id;
    if (!isInt(id)) return null;
    if (this.rateLimited()) {
      return msg.type === 'read' ? { type: 'read-result', id, error: 'rate limited' } : this.status(id, 429);
    }
    if (msg.type === 'open') return this.open(msg as RelayOpenRequest);
    if (msg.type === 'read') return this.read(msg as RelayReadRequest);
    return null;
  }

  private async open(msg: RelayOpenRequest): Promise<RelayOpenResponse> {
    const { id } = msg;
    if (typeof msg.path !== 'string' || msg.path.length > 4096) return this.status(id, 404);
    if (msg.method !== 'GET' && msg.method !== 'HEAD') return this.status(id, 405);
    if (msg.range !== null && (typeof msg.range !== 'string' || msg.range.length > 200)) return this.status(id, 416);
    const resolved = resolveTrainingPath(msg.path);
    if (resolved.kind === 'refuse') return this.status(id, resolved.status);
    // App-state scoping: only the pack the Training page has open is served.
    if (this.openPackId === null || resolved.packId !== this.openPackId) return this.status(id, 404);
    this.served += 1;
    let blob: Blob | null;
    try {
      blob = await this.opts.readActiveFile(resolved.packId, resolved.segments);
    } catch {
      blob = null;
    }
    if (blob === null) return this.status(id, 404);
    // The pack may have been closed or switched while the read was pending.
    if (this.openPackId !== resolved.packId) return this.status(id, 404);
    const total = blob.size;
    const headers: Record<string, string> = {
      ...baseHeaders(this.opts.appOrigin, this.opts.playerOrigin, resolved.packId),
      'content-type': mimeTypeFor(resolved.segments[resolved.segments.length - 1] ?? ''),
      'accept-ranges': 'bytes',
    };
    const range = parseRange(msg.range, total);
    if (range === 'unsatisfiable') {
      return { type: 'open-result', id, status: 416, headers: { ...headers, 'content-range': `bytes */${total}` }, body: 'Range Not Satisfiable' };
    }
    const start = range === null ? 0 : range.start;
    const end = range === null ? total - 1 : range.end;
    const length = total === 0 ? 0 : end - start + 1;
    headers['content-length'] = String(length);
    const status = range === null ? 200 : 206;
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    if (msg.method === 'HEAD' || length === 0) return { type: 'open-result', id, status, headers };
    if (this.handles.size >= MAX_OPEN_HANDLES) {
      // Drop the oldest handle (the worker re-opens if it still needs it).
      const oldest = this.handles.keys().next().value;
      if (oldest !== undefined) this.handles.delete(oldest);
    }
    const handle = this.nextHandle++;
    this.handles.set(handle, { blob, start, end, packId: resolved.packId });
    return { type: 'open-result', id, status, headers, handle, start, end };
  }

  private async read(msg: RelayReadRequest): Promise<RelayReadResponse> {
    const { id } = msg;
    const entry = isInt(msg.handle) ? this.handles.get(msg.handle) : undefined;
    if (entry === undefined || entry.packId !== this.openPackId) return { type: 'read-result', id, error: 'unknown handle' };
    if (!isInt(msg.offset) || !isInt(msg.length) || msg.length === 0 || msg.length > MAX_RELAY_READ_BYTES) {
      return { type: 'read-result', id, error: 'invalid read' };
    }
    if (msg.offset < entry.start || msg.offset + msg.length - 1 > entry.end) return { type: 'read-result', id, error: 'read outside range' };
    // In-flight bound, shared across ports like the rate window.
    if (this.inFlightReads >= MAX_INFLIGHT_READS || this.inFlightBytes + msg.length > MAX_INFLIGHT_BYTES) {
      return { type: 'read-result', id, error: 'busy', code: 'busy' };
    }
    this.inFlightReads += 1;
    this.inFlightBytes += msg.length;
    try {
      const bytes = await entry.blob.slice(msg.offset, msg.offset + msg.length).arrayBuffer();
      return { type: 'read-result', id, bytes };
    } catch (error) {
      return { type: 'read-result', id, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.inFlightReads -= 1;
      this.inFlightBytes -= msg.length;
    }
  }
}
