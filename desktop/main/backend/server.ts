// The guarded loopback backend listener (issue #61, Workstream B3).
//
// Composition contract (docs/security/desktop.md, "B3 integration contract"):
//   1. Bind 127.0.0.1 on a RANDOM FREE PORT (the OS assigns; caller listens).
//   2. The B2 loopback guard is mounted in front of EVERY route — including
//      /health and /auth/* — via a single guard call site before any routing.
//   3. The adapter builds the ABSOLUTE url the guard requires and folds
//      header case through the fetch Headers implementation. OPTIONS
//      (CORS preflight) is answered only AFTER the guard's gates.
//   4. The token header name comes from the caller (resolveSecurityConfig()),
//      never hard-coded, and the transport never uses Authorization: Bearer.
//   5. Rejections are static; nothing echoes the token or request material,
//      and nothing logs the token or full URLs at info level.
//
// Two backends sit behind this one listener: the local StubEngine (node
// mode) or a transparent HTTP proxy to the spawned sidecar (sidecar mode).
// Electron-free: runs under plain node (CI conformance + acceptance checks).
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { originAllowed, type LoopbackGuard } from '../security/loopback-guard.js';
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_TOKEN_HEADER_NAME } from '../security/defaults.js';
import { RESERVED_PROFILE_HEADER_NAME, ModelNotConfiguredError, type EngineSurface, type IngestFileInput, type ModelStatus } from './types.js';

const JSON_BODY_CAP_BYTES = 1024 * 1024; // 1 MB for JSON routes
const MULTIPART_BODY_CAP_BYTES = 60 * 1024 * 1024; // 60 MB (contract cap is 50 MB)

export interface BackendServerOptions {
  guard: LoopbackGuard;
  tokenHeaderName?: string;
  allowedOrigins?: string[];
  /** Node mode: the local engine answering the routes. */
  engine?: EngineSurface;
  /** Sidecar mode: forward every request to this loopback upstream port. */
  upstreamPort?: number;
  /**
   * B8 (issue #66): generation/ingestion serialization. When wired, /ask and
   * /ask/stream execute under the scheduler's FIFO mutex (max
   * maxConcurrentGenerations) and its observability feeds the host's
   * upgrade predicate. Optional: old constructions keep working unwired.
   */
  scheduler?: {
    runGeneration<T>(fn: () => Promise<T>): Promise<T>;
  };
  /**
   * B8 (issue #66): the telemetry snapshot provider for GET /telemetry/memory.
   * Provider FUNCTION shape (host wires `() => ({ snapshot, downgrade })`).
   * When absent the known route degrades to a contract-safe 503 — never 404.
   */
  telemetry?: () => {
    snapshot: Record<string, number>;
    downgrade: { effectiveProfile: 'quality' | 'fast'; downgraded: boolean };
  };
  /**
   * B9 (issue #67): the model-presence provider for GET /status/models.
   * Host wires `() => engine.modelStatus()`. When absent the known route
   * degrades to a contract-safe 503 — never 404 (same shape as telemetry).
   */
  modelStatus?: () => ModelStatus;
  /**
   * B9 (issue #67): persistence sink for accepted PUT /settings snapshots.
   * Host wires an atomic writer (settings.json beside the profile store).
   * Called ONLY after the engine accepted the patch; when absent, settings
   * stay engine-memory-only (CI stub runs without a store path).
   */
  persistSettings?: (settings: Record<string, unknown>) => void;
}

// The 16 contract operations (contracts/api.openapi.yaml). Unknown paths get
// 404, known paths with a wrong method get 405 — the route TABLE is the
// conformance surface. (/telemetry/memory arrives with B8, issue #66: it is
// token-guarded like every route — it reveals process memory — and degrades
// to a contract-safe 503 when no telemetry provider is wired. /status/models
// arrives with B9, issue #67: model presence for the renderer's first-run
// gate — same known-route/503 degradation when no provider is wired.)
export const CONTRACT_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['/health', new Set(['GET'])],
  ['/auth/status', new Set(['GET'])],
  ['/auth/token', new Set(['POST'])],
  ['/ask', new Set(['POST'])],
  ['/ask/stream', new Set(['POST'])],
  ['/ingest', new Set(['POST'])],
  ['/ingest/file', new Set(['POST'])],
  ['/ingest/batch', new Set(['POST'])],
  ['/documents', new Set(['GET', 'DELETE'])],
  ['/search', new Set(['POST'])],
  ['/settings', new Set(['GET', 'PUT'])],
  ['/stats', new Set(['GET'])],
  ['/telemetry/memory', new Set(['GET'])],
  ['/status/models', new Set(['GET'])],
]);

function sendJson(res: ServerResponse, status: number, body: unknown, cors?: CorsContext): void {
  const headers: Record<string, string | string[]> = { 'content-type': 'application/json' };
  applyCorsHeaders(headers, cors);
  if (process.env.TRAININGAPP_CORS_DEBUG) {
    console.error(`[cors-debug] respond ${status} acao=${String(headers['access-control-allow-origin'])} corp=${String(headers['cross-origin-resource-policy'])}`);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

interface CorsContext {
  origin: string | null;
  allowedOrigins: string[];
  allowHeaders: string;
}

function corsContext(req: IncomingMessage, allowedOrigins: string[], tokenHeaderName: string): CorsContext {
  const origin = req.headers.origin ?? null;
  const requested = req.headers['access-control-request-headers'];
  return {
    origin: typeof origin === 'string' ? origin : null,
    allowedOrigins,
    allowHeaders:
      typeof requested === 'string' && requested.length > 0
        ? requested
        : [tokenHeaderName, RESERVED_PROFILE_HEADER_NAME, 'content-type', 'authorization'].join(', '),
  };
}

function applyCorsHeaders(headers: Record<string, string | string[]>, cors?: CorsContext): void {
  if (!cors) return;
  // The guard already rejected disallowed origins before we get here, so
  // echoing the request origin is safe.
  if (cors.origin && originAllowed(cors.origin, cors.allowedOrigins)) {
    headers['access-control-allow-origin'] = cors.origin;
    headers['vary'] = 'Origin';
    // Cross-origin requests from an allowed origin may opt into credentials
    // (e.g. the renderer's connectivity probe sends credentials: 'include'
    // against the Python surface's cookie convention); CORS requires the
    // explicit flag whenever that happens. Loopback + token still gate all
    // data access, so credentialed reads of a 204/JSON status stay safe.
    headers['access-control-allow-credentials'] = 'true';
  }
  headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  headers['access-control-allow-headers'] = cors.allowHeaders;
  // Chromium's Private Network Access preflight (local page -> loopback
  // backend across ports) requires this affirmative answer or the request
  // fails with net::ERR_FAILED even when ACAO is present.
  headers['access-control-allow-private-network'] = 'true';
  // B9 (issue #67): the dev/preview renderer runs under COEP require-corp
  // (vite preview headers for SharedArrayBuffer), and the packaged app://
  // renderer sets the same header (B2 security headers). Under COEP, every
  // cross-origin response needs CORP or it is blocked BEFORE CORS applies —
  // which made every backend fetch fail from the renderer. The backend is
  // loopback-only and token-guarded, so declaring the resource loadable
  // cross-origin changes nothing about data authorization.
  headers['cross-origin-resource-policy'] = 'cross-origin';
}

/** Read a request body with a hard cap. Rejects null when over the cap. */
function readBody(req: IncomingMessage, capBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        // Stop buffering and resolve — do NOT destroy() the request here.
        // Killing the socket before the route's 413 flushed made the
        // documented 413 response unobservable (clients saw a connection
        // reset). The route replies 413; Node then closes the connection
        // because the request was never fully read.
        if (!capped) {
          capped = true;
          chunks.length = 0;
          resolve(null);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!capped) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!capped) resolve(null);
    });
    req.on('close', () => {
      if (!capped && !req.complete) resolve(null);
    });
  });
}

function parseQuestionRequest(body: Buffer | null): { ok: true; value: { question: string; n_results?: number; history?: unknown[] } } | { ok: false; errors: string[] } {
  if (body === null || body.length === 0) return { ok: false, errors: ['body: request body is required'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, errors: ['body: invalid JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, errors: ['body: expected a JSON object'] };
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const question = typeof obj.question === 'string' ? obj.question.trim() : '';
  if (question.length === 0) errors.push('question: required, must be a non-empty string');
  if (question.length > 2000) errors.push('question: must be at most 2000 characters');
  let n_results: number | undefined;
  if (obj.n_results !== undefined) {
    if (!Number.isInteger(obj.n_results) || Number(obj.n_results) < 1 || Number(obj.n_results) > 10) {
      errors.push('n_results: must be an integer between 1 and 10');
    } else {
      n_results = Number(obj.n_results);
    }
  }
  if (obj.history !== undefined) {
    if (!Array.isArray(obj.history)) {
      errors.push('history: must be an array of {role, content} turns');
    } else if (obj.history.length > 20) {
      errors.push('history: must contain at most 20 turns');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { question, n_results, history: Array.isArray(obj.history) ? obj.history : undefined } };
}

function parseSearchRequest(body: Buffer | null): { ok: true; value: { query: string; n_results: number } } | { ok: false; errors: string[] } {
  if (body === null || body.length === 0) return { ok: false, errors: ['body: request body is required'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, errors: ['body: invalid JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, errors: ['body: expected a JSON object'] };
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const query = typeof obj.query === 'string' ? obj.query.trim() : '';
  if (query.length === 0) errors.push('query: required, must be a non-empty string');
  if (query.length > 500) errors.push('query: must be at most 500 characters');
  let n_results = 5;
  if (obj.n_results !== undefined) {
    if (!Number.isInteger(obj.n_results) || Number(obj.n_results) < 1 || Number(obj.n_results) > 20) {
      errors.push('n_results: must be an integer between 1 and 20');
    } else {
      n_results = Number(obj.n_results);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { query, n_results } };
}

function validationError(res: ServerResponse, errors: string[], cors?: CorsContext): void {
  sendJson(res, 422, { detail: 'Request validation failed', errors }, cors);
}

/**
 * Drive one /ask/stream request: token events, then EXACTLY ONE terminal
 * (done — with cancelled:true when the client went away — or error), then
 * close. Client disconnect sets the cancellation flag before the terminal.
 * Exported for the cancellation-semantics spec (b3-server.test.ts), which
 * drives it with a recording response double.
 */
export async function runAskStream(
  res: ServerResponse,
  engine: EngineSurface,
  question: string,
  opts: { n_results?: number; history?: unknown[] },
  cors?: CorsContext,
): Promise<void> {
  let streamOpen = true;
  let clientGone = false;
  const cancellation = {
    isSet: () => clientGone,
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    ...(cors?.origin && originAllowed(cors.origin, cors.allowedOrigins)
      ? { 'access-control-allow-origin': cors.origin, 'vary': 'Origin' }
      : {}),
  });
  const emit = (payload: Record<string, unknown>): void => {
    if (!streamOpen) return;
    // Frozen SSE frame shape: `data: {json}\r\n\r\n` (payload-discriminated).
    res.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  };
  const finish = (): void => {
    if (!streamOpen) return;
    streamOpen = false;
    res.end();
  };
  // Client disconnect: mark cancelled so the engine stops, then terminate the
  // stream with the single cancelled-done terminal (frozen semantics).
  res.on('close', () => {
    clientGone = true;
    if (streamOpen) {
      emit({ done: true, cancelled: true, sources: [], context_length: 0 });
      finish();
    }
  });
  try {
    const result = await engine.query(question, {
      nResults: opts.n_results,
      history: opts.history,
      cancellationEvent: cancellation,
      streamCallback: (token) => emit({ token }),
    });
    if (result.cancelled || clientGone) {
      emit({
        done: true,
        cancelled: true,
        sources: result.sources,
        context_length: result.context_length,
        inference_time: result.inference_time,
      });
    } else {
      emit({
        done: true,
        sources: result.sources,
        context_length: result.context_length,
        inference_time: result.inference_time,
      });
    }
  } catch {
    emit({ error: 'An error occurred processing your question' });
  } finally {
    finish();
  }
}

/** Proxy a request to the sidecar upstream (sidecar mode). SSE-safe. */
function proxyToUpstream(req: IncomingMessage, res: ServerResponse, upstreamPort: number, tokenHeaderName: string, cors?: CorsContext): void {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  // The sidecar never sees the transport token; the profile slot survives
  // (B6 will read it end-to-end). node:http already lowercases header names.
  delete headers[tokenHeaderName.toLowerCase()];
  delete headers.host;
  delete headers.connection;
  const upstream = http.request(
    { host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers },
    (upRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value !== undefined) outHeaders[name] = value;
      }
      applyCorsHeaders(outHeaders, cors);
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
      // Half-open stream discipline: if the upstream dies mid-response,
      // tear the client socket down after a best-effort terminal write —
      // never hang a half-open stream.
      upRes.on('error', () => {
        res.destroy();
      });
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 502, { detail: 'Backend sidecar is not responding' }, cors);
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
  req.on('error', () => upstream.destroy());
}

/**
 * Create the guarded backend listener. Callers own the lifecycle:
 * `listenOnRandomPort(server)` binds it; `server.close()` stops it.
 */
export function createBackendServer(opts: BackendServerOptions): http.Server {
  const tokenHeaderName = opts.tokenHeaderName ?? DEFAULT_TOKEN_HEADER_NAME;
  const allowedOrigins = opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;

  return http.createServer((req, res) => {
    // Guard adapter: the guard REQUIRES an absolute url (a bare path fails
    // closed) and case-insensitive header lookup (Headers folds case).
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1';
    const absoluteUrl = `http://${hostHeader}${req.url ?? '/'}`;
    const headers = new Headers(req.headers as Record<string, string>);
    const cors = corsContext(req, allowedOrigins, tokenHeaderName);
    if (process.env.TRAININGAPP_CORS_DEBUG) {
      console.error(`[cors-debug] ${req.method} ${req.url} origin=${String(req.headers.origin)} acrm=${String(req.headers['access-control-request-method'])} acrh=${String(req.headers['access-control-request-headers'])} allowlist=${JSON.stringify(allowedOrigins)}`);
    }

    // SINGLE guard call site: every request — no exceptions — traverses the
    // gate before any routing or backend logic (B3 contract item 2).
    const verdict = opts.guard({ url: absoluteUrl, headers, method: req.method });
    if (verdict !== null) {
      if (process.env.TRAININGAPP_CORS_DEBUG) {
        console.error(`[cors-debug] guard REJECT ${verdict.status} for ${req.method} ${req.url} hdr=${JSON.stringify((req.headers as Record<string, unknown>)['x-desktop-token'] ?? null)} acrm=${String(req.headers['access-control-request-method'])} len=${JSON.stringify(req.headers['content-length'] ?? null)}`);
      }
      res.writeHead(verdict.status, { 'content-type': 'text/plain' });
      res.end(verdict.status === 401 ? 'Unauthorized' : 'Forbidden');
      return;
    }

    // OPTIONS (CORS preflight): answered only AFTER the guard's gates.
    if (req.method === 'OPTIONS') {
      const preflight: Record<string, string | string[]> = {
        'access-control-max-age': '600',
      };
      applyCorsHeaders(preflight, cors);
      res.writeHead(204, preflight);
      res.end();
      return;
    }

    // Sidecar mode: the guarded listener fronts the spawned backend; forward
    // everything (the upstream owns contract conformance).
    if (opts.upstreamPort !== undefined) {
      proxyToUpstream(req, res, opts.upstreamPort, tokenHeaderName, cors);
      return;
    }

    // Node mode: route the frozen contract against the local engine.
    const engine = opts.engine;
    if (!engine) {
      sendJson(res, 500, { detail: 'Backend host misconfigured: neither engine nor upstream' }, cors);
      return;
    }
    // B8 (issue #66): when the host wired the scheduler, /ask + /ask/stream
    // execute under the FIFO generation mutex. Unwired constructions keep the
    // old unwrapped semantics (the transport cannot serialize what it was
    // never handed).
    const runGeneration = opts.scheduler
      ? <T,>(fn: () => Promise<T>): Promise<T> => opts.scheduler!.runGeneration(fn)
      : <T,>(fn: () => Promise<T>): Promise<T> => fn();
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const methods = CONTRACT_ROUTES.get(path);
    if (methods === undefined) {
      sendJson(res, 404, { detail: 'Not found' }, cors);
      return;
    }
    if (!methods.has(req.method ?? '')) {
      sendJson(res, 405, { detail: 'Method not allowed' }, cors);
      return;
    }

    void (async () => {
      try {
        switch (`${req.method} ${path}`) {
          case 'GET /health':
            sendJson(res, 200, { status: 'ok', engine_ready: true }, cors);
            return;
          case 'GET /auth/status':
            // Desktop backend auth mirrors the Python default (auth disabled):
            // docs/security/desktop.md pins transport security to the B2 guard
            // precisely so it does not depend on backend auth settings.
            sendJson(res, 200, { enabled: false, jwt_available: false, methods: [] }, cors);
            return;
          case 'POST /auth/token':
            sendJson(
              res,
              503,
              { detail: 'Authentication is not enabled on this server. Check /auth/status for current configuration.' },
              cors,
            );
            return;
          case 'POST /ask':
          case 'POST /ask/stream': {
            const body = await readBody(req, JSON_BODY_CAP_BYTES);
            if (body === null) {
              sendJson(res, 413, { detail: 'Request body too large' }, cors);
              return;
            }
            const parsed = parseQuestionRequest(body);
            if (!parsed.ok) {
              validationError(res, parsed.errors, cors);
              return;
            }
            if (path === '/ask') {
              let result;
              try {
                result = await runGeneration(() =>
                  engine.query(parsed.value.question, {
                    nResults: parsed.value.n_results,
                    history: parsed.value.history,
                  }),
                );
              } catch (err) {
                // B4 (issue #62): no staged model is the contract's 503
                // "engine not initialized" response with a load diagnostic.
                if (err instanceof ModelNotConfiguredError) {
                  sendJson(res, 503, { detail: err.detail }, cors);
                  return;
                }
                throw err;
              }
              sendJson(
                res,
                200,
                {
                  question: parsed.value.question,
                  answer: result.answer,
                  sources: result.sources,
                  context_length: result.context_length,
                  inference_time: result.inference_time,
                },
                cors,
              );
            } else {
              // B8 (issue #66): preflight stays OUTSIDE the generation mutex —
              // a missing model must answer its 503 immediately, never queue
              // behind an in-flight generation. Only the actual
              // generation-carrying stream runs under the scheduler.
              try {
                await engine.preflight?.();
              } catch (err) {
                if (err instanceof ModelNotConfiguredError) {
                  sendJson(res, 503, { detail: err.detail }, cors);
                  return;
                }
                throw err;
              }
              await runGeneration(() =>
                runAskStream(res, engine, parsed.value.question, {
                  n_results: parsed.value.n_results,
                  history: parsed.value.history,
                }, cors),
              );
            }
            return;
          }
          case 'POST /ingest': {
            const body = await readBody(req, JSON_BODY_CAP_BYTES);
            if (body === null) {
              sendJson(res, 413, { detail: 'Request body too large' }, cors);
              return;
            }
            let directory = '';
            try {
              const obj = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
              directory = typeof obj.directory === 'string' ? obj.directory : '';
            } catch {
              validationError(res, ['body: invalid JSON'], cors);
              return;
            }
            if (directory.length === 0) {
              sendJson(res, 400, { detail: 'Invalid directory path' }, cors);
              return;
            }
            sendJson(res, 200, await engine.ingestDirectory(directory), cors);
            return;
          }
          case 'POST /ingest/file': {
            // B6 (issue #64): real multipart parsing via the fetch Request
            // implementation (undici formData()). Contract: field `file`,
            // 50MB cap enforced by the body reader above.
            const body = await readBody(req, MULTIPART_BODY_CAP_BYTES);
            if (body === null) {
              sendJson(res, 413, { detail: 'File too large. Maximum size is 50MB.' }, cors);
              return;
            }
            let input: IngestFileInput | undefined;
            try {
              const form = await new Request('http://127.0.0.1/', {
                method: 'POST',
                headers: { 'content-type': req.headers['content-type'] ?? 'multipart/form-data' },
                body: new Uint8Array(body),
              }).formData();
              const file = form.get('file');
              if (file instanceof File && file.size > 0) {
                input = { name: file.name || 'upload', data: new Uint8Array(await file.arrayBuffer()) };
              }
            } catch {
              // Malformed multipart falls through to the 400 below.
            }
            if (input === undefined) {
              sendJson(res, 400, { detail: 'Missing/invalid file part (multipart field "file")' }, cors);
              return;
            }
            sendJson(res, 200, await engine.ingestFile(input), cors);
            return;
          }
          case 'POST /ingest/batch': {
            // B6 (issue #64): real multipart batch parsing. Contract: field
            // `files` (array, max 20 — over is a 400).
            const body = await readBody(req, MULTIPART_BODY_CAP_BYTES);
            if (body === null) {
              sendJson(res, 413, { detail: 'Request body too large' }, cors);
              return;
            }
            let inputs: IngestFileInput[] = [];
            try {
              const form = await new Request('http://127.0.0.1/', {
                method: 'POST',
                headers: { 'content-type': req.headers['content-type'] ?? 'multipart/form-data' },
                body: new Uint8Array(body),
              }).formData();
              const entries = form.getAll('files');
              for (const entry of entries) {
                if (entry instanceof File && entry.size > 0) {
                  inputs.push({
                    name: entry.name || 'upload',
                    data: new Uint8Array(await entry.arrayBuffer()),
                  });
                }
              }
            } catch {
              // Malformed multipart falls through to the 400 below.
            }
            if (inputs.length === 0) {
              sendJson(res, 400, { detail: 'Missing/invalid files part (multipart field "files")' }, cors);
              return;
            }
            if (inputs.length > 20) {
              sendJson(res, 400, { detail: 'Too many files: batch ingest accepts at most 20 files' }, cors);
              return;
            }
            sendJson(res, 200, await engine.ingestBatch(inputs), cors);
            return;
          }
          case 'GET /documents':
            sendJson(res, 200, await engine.listDocuments(), cors);
            return;
          case 'DELETE /documents':
            await engine.clearDocuments();
            sendJson(res, 200, { status: 'cleared' }, cors);
            return;
          case 'POST /search': {
            const body = await readBody(req, JSON_BODY_CAP_BYTES);
            if (body === null) {
              sendJson(res, 413, { detail: 'Request body too large' }, cors);
              return;
            }
            const parsed = parseSearchRequest(body);
            if (!parsed.ok) {
              validationError(res, parsed.errors, cors);
              return;
            }
            sendJson(res, 200, await engine.search(parsed.value.query, parsed.value.n_results), cors);
            return;
          }
          case 'GET /settings':
            sendJson(res, 200, engine.responseSettings(), cors);
            return;
          case 'PUT /settings': {
            const body = await readBody(req, JSON_BODY_CAP_BYTES);
            if (body === null) {
              sendJson(res, 413, { detail: 'Request body too large' }, cors);
              return;
            }
            let patch: Record<string, unknown>;
            try {
              const parsedBody = JSON.parse(body.toString('utf8')) as unknown;
              if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
                validationError(res, ['body: expected a JSON object'], cors);
                return;
              }
              patch = parsedBody as Record<string, unknown>;
            } catch {
              validationError(res, ['body: invalid JSON'], cors);
              return;
            }
            const result = engine.applySettingsPatch(patch);
            if (!result.ok) {
              if (result.status === 400) sendJson(res, 400, { detail: result.detail }, cors);
              else validationError(res, result.errors ?? [result.detail], cors);
              return;
            }
            const responseSettings = engine.responseSettings();
            // B9 (issue #67): persistence is a post-validation side effect —
            // only a patch the engine ACCEPTED is snapshotted (in PATCH form,
            // i.e. the same key names applySettingsPatch validates), so the
            // sidecar round-trips through the boot-time apply exactly. Hosts
            // without a profile dir pass no sink and keep engine-memory only.
            if (opts.persistSettings) {
              try {
                opts.persistSettings(patch);
              } catch (err) {
                sendJson(res, 500, {
                  detail: `Settings were applied but could not be persisted: ${err instanceof Error ? err.message : String(err)}`,
                }, cors);
                return;
              }
            }
            sendJson(res, 200, responseSettings, cors);
            return;
          }
          case 'GET /stats':
            sendJson(res, 200, await engine.getStats(), cors);
            return;
          case 'GET /telemetry/memory': {
            // B8 (issue #66): token-guarded above (every route traverses the
            // guard), so this reveals process memory only to the host's own
            // renderer. Unwired hosts degrade to a contract-safe 503 — the
            // path is KNOWN (405 semantics apply), never silently 404.
            if (!opts.telemetry) {
              sendJson(res, 503, { detail: 'Memory telemetry is not wired on this host' }, cors);
              return;
            }
            sendJson(res, 200, opts.telemetry(), cors);
            return;
          }
          case 'GET /status/models': {
            // B9 (issue #67): per-profile GGUF presence for the renderer's
            // first-run gate. Token-guarded above like every route. Unwired
            // hosts degrade to a contract-safe 503 — the path is KNOWN,
            // never silently 404 (mirrors /telemetry/memory).
            if (!opts.modelStatus) {
              sendJson(res, 503, { detail: 'Model status is not wired on this host' }, cors);
              return;
            }
            sendJson(res, 200, opts.modelStatus(), cors);
            return;
          }
          default:
            sendJson(res, 404, { detail: 'Not found' }, cors);
            return;
        }
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { detail: 'An internal error occurred' }, cors);
        } else {
          res.destroy();
        }
      }
    })();
  });
}

/** Bind a server to 127.0.0.1 on an OS-assigned random free port. */
export function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('backend listener did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}
