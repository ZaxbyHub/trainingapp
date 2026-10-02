// Guarded outbound HTTP client for external model endpoints
// (universal-provider-settings-overhaul, AC10/AC14). The ONLY path by which
// the desktop backend talks to an external endpoint.
//
// Guarantees (each pinned by tests):
//   1. Policy first: the URL passes the shared endpoint policy
//      (security/endpoint-policy.ts) with the host's airgap setting, or no
//      DNS query and no connection happen.
//   2. Connect-time validation (DNS-rebinding resistance): the host name is
//      resolved through the injectable `lookup` (default node:dns, all
//      answers); EVERY answer must be an allowed address (no metadata,
//      link-local, unspecified, multicast) AND consistent with the name's
//      class (a loopback name -> loopback answers only; a private name ->
//      private/loopback answers only). Any violation refuses the request with
//      zero bytes sent.
//   3. Pinned connect: the socket connects to the validated address (custom
//      `lookup` handed to node:http/https, both the single-address and the
//      `{all:true}` callback shapes) while the Host header and the TLS server
//      name stay the original host name.
//   4. No redirects: any 3xx fails the request; nothing is sent to the
//      redirect target (node:http never follows redirects by itself).
//   5. Trust store: Node's bundled CAs plus the operating system's store
//      (tls.getCACertificates('system'), available in Electron 44's Node 24;
//      NODE_EXTRA_CA_CERTS is part of the 'default' set). No proxy support in
//      this release; loopback/private endpoints are never proxied.
//   6. Timeouts: DNS resolution (default 30 s), first byte (default 600 s),
//      idle gaps between body chunks (default 120 s) and a non-2xx error
//      body (its own 15 s bound, PR #142 review F-015) -> kind 'timeout';
//      cancellation (isCancelled or an AbortSignal) is honoured during the
//      DNS lookup (no socket is ever opened afterwards) and aborts the socket
//      once connected.
//   7. A header value node:http refuses (e.g. a key with characters outside
//      Latin-1) fails as a classified, key-free ExternalProviderError, never
//      an untyped TypeError.
//   8. Memory bounds (PR #142 review F-003/F-009): a non-2xx error body is
//      read up to ERROR_BODY_LIMIT_BYTES, then the request is aborted;
//      text(maxBytes) aborts with a classified 'server' error past its cap;
//      the 2xx chunk queue pauses the socket above
//      RESPONSE_QUEUE_HIGH_WATER_BYTES and resumes once the consumer drains.
//      The streamed answer as a whole is capped at MAX_STREAMED_ANSWER_BYTES
//      by its consumer (inference/external-generator.ts).
// node:http / node:https only — no new dependency, no electron import.
import { promises as dnsPromises } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import tls from 'node:tls';
import { classifyAddress, hostKind, validateEndpointUrl } from '../../security/endpoint-policy.js';
import {
  ExternalProviderError,
  errorForStatus,
  networkError,
  oversizeError,
  refusedError,
  timeoutError,
  upstreamMessage,
  type FailureContext,
} from './provider-error.js';

/** Injectable DNS seam: every address a host name resolves to. */
export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export const FIRST_BYTE_TIMEOUT_MS = 600_000;
/** Bound on one DNS resolution (an OS resolver can otherwise stall Stop). */
export const DNS_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 120_000;
/** Bound on reading a non-2xx error body (separate from the first-byte timer). */
export const ERROR_BODY_TIMEOUT_MS = 15_000;
/** PR #142 review F-003 byte caps (the browser app uses the same values). */
export const ERROR_BODY_LIMIT_BYTES = 64 * 1024;
export const MAX_SSE_LINE_BYTES = 1024 * 1024;
export const MAX_COMPLETION_BODY_BYTES = 8 * 1024 * 1024;
/**
 * The whole streamed answer, in UTF-8 bytes (PR #142 closeout F-003). The idle
 * timer bounds only the gap between chunks and a server may ignore
 * max_tokens, so the accumulated answer text needs its own cap.
 */
export const MAX_STREAMED_ANSWER_BYTES = 8 * 1024 * 1024;
export const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024;
/** PR #142 review F-009: the 2xx chunk queue pauses the socket above this. */
export const RESPONSE_QUEUE_HIGH_WATER_BYTES = 1024 * 1024;
const RESPONSE_QUEUE_LOW_WATER_BYTES = 256 * 1024;
const CANCEL_POLL_MS = 20;

/** Thrown when the caller cancelled before a response arrived. */
export class RequestCancelledError extends Error {
  constructor() {
    super('request cancelled');
    this.name = 'RequestCancelledError';
  }
}

export const defaultLookup: DnsLookup = async (hostname) => {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

let caBundle: string[] | undefined | null = null;
/** Node's default CAs + the OS store, de-duplicated (undefined = Node defaults). */
export function trustedCertificateAuthorities(): string[] | undefined {
  if (caBundle !== null) return caBundle;
  const get = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof get !== 'function') {
    caBundle = undefined;
    return caBundle;
  }
  const all = new Set<string>();
  for (const type of ['default', 'system']) {
    try {
      for (const cert of get(type)) all.add(cert);
    } catch {
      /* a store that cannot be read is skipped; 'default' always exists */
    }
  }
  caBundle = all.size > 0 ? [...all] : undefined;
  return caBundle;
}

/** Bounds and cancellation for the DNS step of resolveTarget. */
export interface ResolveOptions {
  /** Default DNS_TIMEOUT_MS. */
  timeoutMs?: number;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}

type LookupOutcome = { ok: true; answers: unknown } | { ok: false; err: unknown };

/**
 * Wait for the lookup, but never longer than `timeoutMs` and never past a
 * cancellation. A lookup that settles late is ignored (its answers are never
 * used, so no socket is opened for them).
 */
function awaitLookup(
  pending: Promise<LookupOutcome>,
  ctx: FailureContext,
  hostname: string,
  opts: ResolveOptions,
): Promise<LookupOutcome> {
  const ms = opts.timeoutMs ?? DNS_TIMEOUT_MS;
  return new Promise<LookupOutcome>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const onAbort = (): void => finish(() => reject(new RequestCancelledError()));
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      opts.signal?.removeEventListener('abort', onAbort);
      settle();
    };
    if (opts.signal?.aborted === true || opts.isCancelled?.() === true) {
      finish(() => reject(new RequestCancelledError()));
      return;
    }
    opts.signal?.addEventListener('abort', onAbort);
    timer = setTimeout(() => finish(() => reject(timeoutError(ctx, ms, 'dns', undefined, hostname))), ms);
    if (opts.isCancelled !== undefined) {
      const isCancelled = opts.isCancelled;
      poll = setInterval(() => {
        if (isCancelled()) finish(() => reject(new RequestCancelledError()));
      }, CANCEL_POLL_MS);
    }
    void pending.then((outcome) => finish(() => resolve(outcome)));
  });
}

/**
 * Resolve and validate the target address for `hostname` (no brackets).
 * Returns the address to connect to; throws a refusal with zero bytes sent,
 * a 'timeout' ExternalProviderError when DNS exceeds the bound, or
 * RequestCancelledError when cancelled during the lookup.
 */
export async function resolveTarget(
  hostname: string,
  lookup: DnsLookup,
  ctx: FailureContext,
  airgap: boolean,
  opts: ResolveOptions = {},
): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    const cls = classifyAddress(hostname);
    if (cls === null || !cls.ok) {
      throw refusedError(ctx, cls === null ? `${hostname} is not a usable address` : `${cls.reason} (${cls.rule})`);
    }
    return { address: hostname, family: literalFamily === 6 ? 6 : 4 };
  }
  const nameKind = hostKind(hostname);
  if (nameKind === null) throw refusedError(ctx, `${hostname} is not an allowed host name`);
  const pending: Promise<LookupOutcome> = Promise.resolve()
    .then(() => lookup(hostname))
    .then(
      (found): LookupOutcome => ({ ok: true, answers: found }),
      (err: unknown): LookupOutcome => ({ ok: false, err }),
    );
  const outcome = await awaitLookup(pending, ctx, hostname, opts);
  if (!outcome.ok) {
    const err = outcome.err;
    throw networkError(ctx, `DNS lookup for ${hostname} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const answers = outcome.answers as Array<{ address: string; family: 4 | 6 }>;
  if (!Array.isArray(answers) || answers.length === 0) {
    throw networkError(ctx, `DNS lookup for ${hostname} returned no addresses`);
  }
  for (const answer of answers) {
    const address = String(answer?.address ?? '');
    const cls = classifyAddress(address);
    if (cls === null) throw refusedError(ctx, `${hostname} resolved to an unusable address "${address}"`);
    if (!cls.ok) throw refusedError(ctx, `${hostname} resolves to ${address}, ${cls.reason} (${cls.rule})`);
    const consistent =
      nameKind === 'loopback'
        ? cls.kind === 'loopback'
        : nameKind === 'private'
          ? cls.kind === 'loopback' || cls.kind === 'private'
          : true;
    if (!consistent) {
      throw refusedError(
        ctx,
        `${hostname} is a ${nameKind} name but resolves to the ${cls.kind} address ${address} (DNS answers must match the name's network class)`,
      );
    }
    if (airgap && cls.kind === 'public') {
      throw refusedError(ctx, `${hostname} resolves to the public address ${address}, which this air-gapped build does not allow (airgap-public)`);
    }
  }
  const firstAddress = String(answers[0]?.address ?? '');
  return { address: firstAddress, family: net.isIP(firstAddress) === 6 ? 6 : 4 };
}

export interface GuardedRequestInit {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  ctx: FailureContext;
  airgap: boolean;
  lookup?: DnsLookup;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Bound on the DNS lookup (default DNS_TIMEOUT_MS). */
  dnsTimeoutMs?: number;
  /** Bound on reading a non-2xx error body (default ERROR_BODY_TIMEOUT_MS). */
  errorBodyTimeoutMs?: number;
  isCancelled?: () => boolean;
  /** Optional AbortSignal; equivalent to isCancelled() turning true. */
  signal?: AbortSignal;
}

export interface GuardedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Body as decoded text chunks; ends quietly on cancellation; throws on timeout/reset. */
  chunks(): AsyncGenerator<string>;
  /**
   * Whole body (bounded by the same timers). With `maxBytes`, a body larger
   * than that aborts the request and rejects with a 'server'
   * ExternalProviderError naming `what` and `reportLimit` (default
   * `maxBytes`; a caller spending one budget across several responses
   * passes the remaining bytes as `maxBytes` and the whole budget here)
   * (PR #142 review F-003).
   */
  text(maxBytes?: number, what?: string, reportLimit?: number): Promise<string>;
  abort(): void;
}

/** Issue one guarded request; resolves once a 2xx response's headers arrive. */
export async function guardedRequest(init: GuardedRequestInit): Promise<GuardedResponse> {
  const verdict = validateEndpointUrl(init.url, { airgap: init.airgap });
  if (!verdict.ok) throw new ExternalProviderError('other', verdict.message);
  const url = new URL(init.url);
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const signal = init.signal;
  const callerCancelled = init.isCancelled;
  const isCancelled =
    signal === undefined && callerCancelled === undefined
      ? undefined
      : (): boolean => signal?.aborted === true || callerCancelled?.() === true;
  const target = await resolveTarget(hostname, init.lookup ?? defaultLookup, init.ctx, init.airgap, {
    timeoutMs: init.dnsTimeoutMs,
    isCancelled,
    signal,
  });
  if (isCancelled?.()) throw new RequestCancelledError();
  return send(url, hostname, target, { ...init, isCancelled });
}

/**
 * Pinned lookup: the socket connects ONLY to the validated address. Handles
 * every callback shape net.connect / tls.connect use: `(host, {all:true}, cb)`
 * (autoSelectFamily, an address list), `(host, options, cb)` and `(host, cb)`
 * (one address + family).
 */
export function pinnedLookupFor(target: { address: string; family: 4 | 6 }): net.LookupFunction {
  return ((_host: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    const cb = typeof options === 'function' ? (options as (...args: unknown[]) => void) : callback;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  }) as unknown as net.LookupFunction;
}

function send(
  url: URL,
  hostname: string,
  target: { address: string; family: 4 | 6 },
  init: GuardedRequestInit,
): Promise<GuardedResponse> {
  const firstByteMs = init.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const idleMs = init.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const errorBodyMs = init.errorBodyTimeoutMs ?? ERROR_BODY_TIMEOUT_MS;
  const isHttps = url.protocol === 'https:';
  const ctx = init.ctx;

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let response: http.IncomingMessage | null = null;
    const queue: Buffer[] = [];
    /** Bytes waiting in `queue`; above the high-water mark the socket is paused. */
    let queuedBytes = 0;
    let paused = false;
    /** Body bytes handed to the consumer so far (text() caps on it). */
    let consumedBytes = 0;
    let ended = false;
    let streamError: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const clearTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const cleanup = (): void => {
      clearTimer();
      if (poll !== null) clearInterval(poll);
      poll = null;
    };
    // eslint-disable-next-line prefer-const -- assigned once the request object exists
    let req: http.ClientRequest;
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
        req.destroy();
        return;
      }
      if (streamError === null && !ended) streamError = err;
      cleanup();
      req.destroy();
      response?.destroy();
      notify();
    };
    const arm = (ms: number, phase: 'first-byte' | 'idle' | 'error-body', status?: number): void => {
      clearTimer();
      timer = setTimeout(() => fail(timeoutError(ctx, ms, phase, status)), ms);
    };

    const pinnedLookup = pinnedLookupFor(target);

    const headers: Record<string, string> = { ...init.headers, host: url.host };
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers,
      lookup: pinnedLookup,
      agent: false,
    };
    if (isHttps) {
      if (net.isIP(hostname) === 0) options.servername = hostname;
      const ca = trustedCertificateAuthorities();
      if (ca !== undefined) options.ca = ca;
    }
    const transport = isHttps ? https : http;
    try {
      req = transport.request(options, onResponse);
    } catch (err) {
      // node:http validates header values synchronously (ERR_INVALID_CHAR for
      // CR/LF/control characters or anything outside Latin-1). Classify it;
      // the message names the rule, never the value.
      settled = true;
      const code = (err as NodeJS.ErrnoException | null)?.code;
      reject(
        code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN'
          ? new ExternalProviderError(
              'auth',
              `The request to ${ctx.origin} was not sent: the API key (or another header value) contains a character that cannot be sent in an HTTP header. Paste the key again in Settings → External model.`,
            )
          : networkError(ctx, 'the request could not be created'),
      );
      return;
    }
    function onResponse(res: http.IncomingMessage): void {
      response = res;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        fail(
          new ExternalProviderError(
            'network',
            `${ctx.origin} answered with a redirect (HTTP ${status}); redirects are not followed, so nothing was sent to the redirect target. Use the endpoint's final URL as the base URL.`,
            status,
          ),
        );
        return;
      }
      if (status < 200 || status >= 300) {
        // The error body is bounded by its OWN short timer (not the
        // first-byte budget, PR #142 review F-015) and by
        // ERROR_BODY_LIMIT_BYTES: once the cap is reached the request is
        // aborted and the error is built from what was read (F-003).
        arm(errorBodyMs, 'error-body', status);
        const parts: Buffer[] = [];
        let size = 0;
        const finishError = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(errorForStatus(ctx, status, upstreamMessage(Buffer.concat(parts).toString('utf8'))));
        };
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = ERROR_BODY_LIMIT_BYTES - size;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          parts.push(part);
          size += part.length;
          if (size >= ERROR_BODY_LIMIT_BYTES) {
            finishError();
            req.destroy();
            res.destroy();
          }
        });
        res.on('end', finishError);
        res.on('error', (err) => fail(networkError(ctx, err.message)));
        return;
      }
      settled = true;
      res.on('data', (chunk: Buffer) => {
        queue.push(chunk);
        queuedBytes += chunk.length;
        if (!paused && queuedBytes >= RESPONSE_QUEUE_HIGH_WATER_BYTES) {
          // Backpressure (PR #142 review F-009): stop reading until the
          // consumer drains. The idle timer is off while WE are the slow
          // side; it re-arms on resume.
          paused = true;
          clearTimer();
          res.pause();
        } else if (!paused) {
          arm(idleMs, 'idle');
        }
        notify();
      });
      res.on('end', () => {
        ended = true;
        cleanup();
        notify();
      });
      res.on('error', (err) => fail(networkError(ctx, err.message)));
      res.on('aborted', () => fail(networkError(ctx, 'the connection was closed before the response finished')));
      const decoder = new StringDecoder('utf8');
      const chunks = async function* (): AsyncGenerator<string> {
        for (;;) {
          while (queue.length > 0) {
            const buf = queue.shift() as Buffer;
            queuedBytes -= buf.length;
            consumedBytes += buf.length;
            if (paused && queuedBytes <= RESPONSE_QUEUE_LOW_WATER_BYTES && !ended && streamError === null) {
              paused = false;
              arm(idleMs, 'idle');
              res.resume();
            }
            const text = decoder.write(buf);
            if (text !== '') yield text;
          }
          if (streamError !== null) throw streamError;
          if (ended) {
            const tail = decoder.end();
            if (tail !== '') yield tail;
            return;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      };
      const abort = (): void => {
        ended = true;
        cleanup();
        req.destroy();
        res.destroy();
        notify();
      };
      resolve({
        status,
        headers: res.headers,
        chunks,
        text: async (maxBytes?: number, what = 'a response body', reportLimit?: number) => {
          let out = '';
          for await (const part of chunks()) {
            if (maxBytes !== undefined && consumedBytes > maxBytes) {
              abort();
              throw oversizeError(ctx, what, reportLimit ?? maxBytes);
            }
            out += part;
          }
          return out;
        },
        abort,
      });
    }
    req.on('error', (err) => {
      if (err instanceof ExternalProviderError) fail(err);
      else fail(networkError(ctx, (err as NodeJS.ErrnoException).code ?? err.message));
    });
    arm(firstByteMs, 'first-byte');
    if (init.isCancelled !== undefined) {
      const isCancelled = init.isCancelled;
      poll = setInterval(() => {
        if (!isCancelled()) return;
        if (!settled) {
          settled = true;
          cleanup();
          reject(new RequestCancelledError());
          req.destroy();
          return;
        }
        ended = true;
        cleanup();
        req.destroy();
        response?.destroy();
        notify();
      }, CANCEL_POLL_MS);
    }
    req.end(init.body);
  });
}
