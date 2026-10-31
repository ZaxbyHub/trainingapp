#!/usr/bin/env node
/**
 * Offline / low-RAM validation matrix harness — issue #86 (workstream E, slot E3).
 *
 * Automates the ENVIRONMENT legs of the ten-scenario acceptance matrix in
 * bench/offline-validation-matrix.md on the reference laptop:
 *   * header-strip proxy (scenario 7) — strips COOP/COEP/CORP from every
 *     upstream response class (200/3xx/4xx/5xx, HEAD included) and re-anchors
 *     redirect Locations onto the proxy origin (absolute http(s):// and
 *     scheme-relative //upstream forms alike), so follow-on traffic stays
 *     through the proxy. Hardened (PR review round): loopback-only bind,
 *     origin-form request targets only (absolute-form/scheme-relative are
 *     refused 400 — never an open relay), http/https upstreams only, hop-by-hop
 *     headers stripped in both directions, non-http(s) upstream Locations
 *     answered with a named 502, and a TOTAL upstream budget in addition to
 *     the socket-inactivity timer;
 *   * RAM-pressure filler (scenarios 2/3/9) — supervised chunk workers that
 *     hold memory until the desired system-free floor is reached, behind a
 *     reserve floor that refuses near-zero targets before any allocation;
 *   * network-disconnect toggle (scenarios 1/10) — FAIL-CLOSED: refuses
 *     without --confirm-network-toggle AND an elevated shell, journals
 *     before acting, verifies by read-back, leaves a detached recovery
 *     watchdog, and restores through the idempotent --recover.
 *
 * The harness never claims a scenario's measured PROOF: every scenario stays
 * `BLOCKED: reference laptop` until the operator runs the proof legs there.
 *
 * Hardware-free surface (exit 0 on any machine, no adapter/RAM/prod state):
 *   node bench/run_offline_matrix.mjs --list
 *   node bench/run_offline_matrix.mjs --selftest
 * Operator surface (reference laptop; see the matrix doc for the full steps):
 *   node bench/run_offline_matrix.mjs --scenario S1  --prep --adapter "<name>" --confirm-network-toggle
 *   node bench/run_offline_matrix.mjs --scenario S2  --prep --ram-free-target-mb 9000
 *   node bench/run_offline_matrix.mjs --scenario S3  --prep --ram-free-target-mb 5600
 *   node bench/run_offline_matrix.mjs --scenario S7  --prep --proxy-upstream http://127.0.0.1:<port>
 *   node bench/run_offline_matrix.mjs --scenario S9  --prep --ram-free-target-mb 5600
 *   node bench/run_offline_matrix.mjs --scenario S10 --prep --adapter "<name>" --confirm-network-toggle
 *   node bench/run_offline_matrix.mjs --recover
 *
 * Capture rows land in bench/offline-matrix-results/<S-id>-<machine>-<timestamp>Z.json
 * and merge into bench/RESULTS.md through bench/append_results.py (surface
 * `offline-matrix`; the machine tag must be registered under "## Machine
 * registry" there — BENCH_MACHINE_TAG carries it).
 *
 * Exit codes: 0 success, 2 usage/refusal, 3 selftest failure, 4 capture
 * failure, 5 recovery failure (--recover left a row in restore-failed state;
 * also the watchdog's max-loops/restore-failed verdicts), 130 forced exit
 * (second Ctrl+C while the auto-clean teardown is still running).
 * Node stdlib only; import-safe (the isMain entry guard).
 */
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_SELFTEST = 3;
export const EXIT_CAPTURE = 4;
/** --recover/watchdog recovery failure: a row ended restore-failed (PRR-007). */
export const EXIT_RECOVER = 5;
/** Forced exit: second Ctrl+C while the auto-clean teardown is running (PRR-021). */
export const EXIT_FORCED = 130;

/** Refusal with a named reason and the usage exit code (fail-closed gates). */
export class UsageError extends Error {
  constructor(message, exitCode = EXIT_USAGE) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = exitCode;
  }
}

/** Capture-channel failure (missing machine tag, unwritable capture dir). */
export class CaptureError extends Error {
  constructor(message, exitCode = EXIT_CAPTURE) {
    super(message);
    this.name = 'CaptureError';
    this.exitCode = exitCode;
  }
}

function out(msg) {
  process.stdout.write(`${msg}\n`);
}

function errOut(msg) {
  process.stderr.write(`[offline-matrix] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Scenario registry — the ids, verbatim titles, automated legs, lifecycle and
// blocked state MUST match bench/offline-validation-matrix.md exactly. That
// equality is pinned by (a) the trace-local frozen C4 acceptance check, which
// lives under .agents/issue-traces/ and is git-excluded (NOT a committed
// check), and (b) the in-repo vitest registry test, which pins the mapping as
// literals — no committed check parses the doc (PRR-014 rewording).
// ---------------------------------------------------------------------------

export const BLOCKED_MARKER = 'BLOCKED: reference laptop';

export const SCENARIOS = [
  { id: 'S1', title: 'Cold install, full network disconnect', legs: ['network-toggle'], lifecycle: 'persistent' },
  { id: 'S2', title: '16 GB, ~9 GB free', legs: ['ram-filler'], lifecycle: 'auto-clean' },
  { id: 'S3', title: '16 GB, <6 GB free', legs: ['ram-filler'], lifecycle: 'auto-clean' },
  { id: 'S4', title: 'Cold-start timing', legs: [], lifecycle: 'auto-clean' },
  { id: 'S5', title: 'Thread utilization', legs: [], lifecycle: 'auto-clean' },
  { id: 'S6', title: 'Reranker on clean install', legs: [], lifecycle: 'auto-clean' },
  { id: 'S7', title: 'Cross-origin isolation stripped', legs: ['header-strip-proxy'], lifecycle: 'auto-clean' },
  { id: 'S8', title: 'GPU acceleration default', legs: [], lifecycle: 'auto-clean' },
  { id: 'S9', title: 'Ingestion under low RAM', legs: ['ram-filler'], lifecycle: 'auto-clean' },
  { id: 'S10', title: 'Full offline restart persistence', legs: ['network-toggle'], lifecycle: 'persistent' },
].map((sc) => ({ ...sc, blocked: BLOCKED_MARKER }));

export function scenarioById(id) {
  const found = SCENARIOS.find((sc) => sc.id === id);
  if (!found) {
    throw new UsageError(
      `unknown scenario '${id}' (the harness registry is S1..S10, matching bench/offline-validation-matrix.md)`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// argv parsing (fail-loud, the sibling-driver contract)
// ---------------------------------------------------------------------------

/** A value-requiring flag present without a value fails loud. */
function readValueArgv(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Numeric flags must be positive decimal integers (never a silent NaN). */
function readPositiveInt(argv, i, flag) {
  const raw = readValueArgv(argv, i, flag);
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

export function parseArgs(argv) {
  const args = {
    list: false,
    selftest: false,
    recover: false,
    recoverWatchdog: false,
    prep: false,
    confirmNetworkToggle: false,
    scenario: undefined,
    adapter: undefined,
    recoverLeaseMin: undefined,
    ramFreeTargetMb: undefined,
    ramReserveMb: undefined,
    proxyUpstream: undefined,
    proxyHost: '127.0.0.1',
    proxyPort: 0,
    proxyTimeoutMs: 30_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--list': args.list = true; break;
      case '--selftest': args.selftest = true; break;
      case '--recover': args.recover = true; break;
      case '--recover-watchdog': args.recoverWatchdog = true; break;
      case '--prep': args.prep = true; break;
      case '--confirm-network-toggle': args.confirmNetworkToggle = true; break;
      case '--scenario': args.scenario = readValueArgv(argv, i, '--scenario'); i += 1; break;
      case '--adapter': args.adapter = readValueArgv(argv, i, '--adapter'); i += 1; break;
      case '--recover-lease-min': args.recoverLeaseMin = readPositiveInt(argv, i, '--recover-lease-min'); i += 1; break;
      case '--ram-free-target-mb': args.ramFreeTargetMb = readPositiveInt(argv, i, '--ram-free-target-mb'); i += 1; break;
      case '--ram-reserve-mb': args.ramReserveMb = readPositiveInt(argv, i, '--ram-reserve-mb'); i += 1; break;
      case '--proxy-upstream': args.proxyUpstream = readValueArgv(argv, i, '--proxy-upstream'); i += 1; break;
      case '--proxy-host': args.proxyHost = readValueArgv(argv, i, '--proxy-host'); i += 1; break;
      case '--proxy-port': args.proxyPort = readPositiveInt(argv, i, '--proxy-port'); i += 1; break;
      case '--proxy-timeout-ms': args.proxyTimeoutMs = readPositiveInt(argv, i, '--proxy-timeout-ms'); i += 1; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  const modes = [args.list, args.selftest, args.recover, args.recoverWatchdog, args.scenario !== undefined]
    .filter(Boolean).length;
  if (modes > 1) {
    throw new Error('pass exactly one of --list, --selftest, --recover, --recover-watchdog, --scenario <id>');
  }
  if (modes === 0) {
    throw new Error('nothing to do: pass --list, --selftest, --recover, or --scenario <id> --prep');
  }
  if (args.prep && args.scenario === undefined) {
    throw new Error('--prep requires --scenario <id>');
  }
  if (args.scenario !== undefined && !args.prep) {
    throw new Error(
      "--scenario requires --prep (the harness runs environment prep only; the measured proof is the operator's to run on the reference laptop)",
    );
  }
  // Q2 (implementation-review round 1): the reserve floor is refused at the
  // parse step too, so a too-low --ram-reserve-mb exits 2 before any leg runs.
  if (args.ramReserveMb !== undefined && args.ramReserveMb < RAM_RESERVE_FLOOR_MB) {
    throw new Error(
      `--ram-reserve-mb must be >= ${RAM_RESERVE_FLOOR_MB} MiB (the hard floor that keeps the filler away from a near-zero free system; default ${RAM_DEFAULTS.reserveMb} MiB)`,
    );
  }
  if (args.scenario !== undefined) scenarioById(args.scenario);
  return args;
}

// ---------------------------------------------------------------------------
// Header-strip proxy (scenario 7)
// ---------------------------------------------------------------------------

export const STRIP_HEADERS = [
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
];

/** Remove COOP/COEP/CORP from a header object (case-insensitive names). */
export function stripIsolationHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIP_HEADERS.includes(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

// Hop-by-hop headers (RFC 9110 + the de-facto proxy-connection/te additions):
// they belong to a single transport hop and must never be forwarded by a
// proxy in either direction (PRR-004/SEC-05).
export const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Strip the fixed hop-by-hop set AND every field name the message's own
 * Connection header lists (case-insensitive) — the RFC's dynamic arm.
 */
export function stripHopByHopHeaders(headers) {
  const listed = new Set();
  const conn = headers.connection;
  if (typeof conn === 'string') {
    for (const name of conn.split(',')) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) listed.add(trimmed);
    }
  }
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(lower) || listed.has(lower)) continue;
    kept[name] = value;
  }
  return kept;
}

/** --proxy-host is a loopback-only knob (PRR-005): the strip proxy is a
 * loopback reverse proxy and never binds a non-loopback host. */
export const LOOPBACK_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export function validateProxyHost(host) {
  if (!LOOPBACK_PROXY_HOSTS.includes(host)) {
    throw new UsageError(
      `--proxy-host must be a loopback literal (one of ${LOOPBACK_PROXY_HOSTS.join(', ')}); got '${host}' — the strip proxy is a loopback-only reverse proxy for scenario 7 and never binds a non-loopback host`,
    );
  }
  return host;
}

/** True when a Location value is safe to forward: an http(s) absolute URL, or
 * a value that cannot be parsed as absolute (it resolves against the current,
 * proxy, origin). Non-http(s) absolute URLs are refused (SEC-04). */
export function locationSchemeAllowed(location) {
  try {
    const parsed = new URL(location);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return true;
  }
}

/**
 * Re-anchor a redirect Location onto the proxy origin. EVERY Location is
 * resolved against the upstream base; a resolved reference pointing at the
 * upstream origin — absolute `http(s)://upstream/...` AND scheme-relative
 * `//upstream/...` alike — is rewritten to the proxy origin preserving
 * path/query/fragment, so the next hop stays through the proxy. Locations
 * already on the proxy origin pass untouched; a genuinely different origin
 * is passed through as the resolved absolute URL (the proxy owns only the
 * upstream origin and never claims otherwise).
 */
export function rewriteLocation(location, upstreamBase, proxyBase) {
  if (!location) return location;
  let resolved;
  try {
    resolved = new URL(location, upstreamBase);
  } catch {
    return location;
  }
  let upstreamOrigin;
  let proxyOrigin;
  try {
    upstreamOrigin = new URL(upstreamBase).origin;
    proxyOrigin = new URL(proxyBase).origin;
  } catch {
    return location;
  }
  if (resolved.origin === proxyOrigin) return location;
  if (resolved.origin === upstreamOrigin) {
    return proxyOrigin + resolved.pathname + resolved.search + resolved.hash;
  }
  return resolved.href;
}

/**
 * Loopback reverse proxy that strips the cross-origin isolation headers from
 * every response class and rewrites Locations. Binds host:port (port 0 =
 * OS-assigned; host must be a loopback literal); streaming is preserved
 * (upstream body pipes through). Hardened (PR review round): origin-form
 * request targets only, http/https upstreams only, hop-by-hop headers
 * stripped in both directions, non-http(s) Locations answered with a named
 * 502, and a TOTAL upstream budget on top of the socket-inactivity timer.
 * Upstream failures are named: 502 upstream-refused / upstream-error:<code>,
 * 504 upstream-timeout (the upstream budget is injectable for tests).
 */
export async function createStripProxy(options = {}) {
  const upstreamBase = options.upstreamBase;
  if (!upstreamBase) {
    throw new UsageError('createStripProxy requires upstreamBase (the origin whose isolation headers get stripped)');
  }
  const upstream = new URL(upstreamBase);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new UsageError(
      `createStripProxy requires an http:// or https:// upstreamBase (got '${upstream.protocol}' in '${upstreamBase}'; the proxy only speaks http/https)`,
    );
  }
  const host = validateProxyHost(options.host ?? '127.0.0.1');
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
  const transport = upstream.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    // PRR-004: origin-form only. An absolute-form (`http://host/path`) or
    // scheme-relative (`//host/path`) request target would let any local
    // process relay to an arbitrary host through this proxy — refused 400.
    const rawTarget = req.url || '/';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith('//')) {
      res.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        'x-offline-matrix-error': 'origin-form-required',
      });
      res.end(
        `offline-matrix proxy: 400 origin-form-required (refusing request target '${rawTarget}': absolute-form and scheme-relative targets would turn this loopback strip proxy into an open relay; only origin-form paths are forwarded to the configured upstream)`,
      );
      return;
    }
    let target;
    try {
      target = new URL(rawTarget, upstreamBase);
    } catch {
      res.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        'x-offline-matrix-error': 'bad-request-target',
      });
      res.end(`offline-matrix proxy: 400 bad-request-target (cannot resolve '${rawTarget}' against the upstream base)`);
      return;
    }
    // Hop-by-hop headers are stripped on the way out (PRR-004/F1-7/SEC-05);
    // Host is re-anchored onto the configured upstream.
    const headers = stripHopByHopHeaders({ ...req.headers, host: upstream.host });
    const preq = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: target.pathname + target.search,
        headers,
      },
      (pres) => {
        const stripped = stripHopByHopHeaders(stripIsolationHeaders(pres.headers));
        if (stripped.location !== undefined) {
          const rewritten = rewriteLocation(stripped.location, upstreamBase, proxyBase);
          // SEC-04: a Location that resolves onto a non-http(s) scheme
          // (ftp:, data:, ...) is refused with a named 502, never forwarded.
          if (!locationSchemeAllowed(rewritten)) {
            pres.destroy();
            if (!res.headersSent) {
              res.writeHead(502, {
                'content-type': 'text/plain; charset=utf-8',
                'x-offline-matrix-error': 'unsupported-location-scheme',
              });
              res.end(
                `offline-matrix proxy: 502 unsupported-location-scheme (upstream Location '${stripped.location}' resolves outside http(s); refusing to forward)`,
              );
            } else {
              res.destroy();
            }
            return;
          }
          stripped.location = rewritten;
        }
        res.writeHead(pres.statusCode ?? 502, stripped);
        pres.pipe(res);
        // The TOTAL budget (below) is satisfied once the upstream body ends.
        pres.on('end', () => clearTimeout(totalTimer));
      },
    );
    const respondTimeout = (kind) => {
      if (!res.headersSent) {
        res.writeHead(504, {
          'content-type': 'text/plain; charset=utf-8',
          'x-offline-matrix-error': 'upstream-timeout',
        });
        res.end(`offline-matrix proxy: 504 upstream-timeout (${kind} budget ${upstreamTimeoutMs}ms exhausted)`);
      } else {
        res.destroy();
      }
      preq.destroy();
    };
    // Socket-INACTIVITY timer: fires only when the upstream socket goes quiet.
    preq.setTimeout(upstreamTimeoutMs, () => respondTimeout('inactivity'));
    // PRR-020: TOTAL deadline from request START — a trickling upstream that
    // keeps the socket active (and so the inactivity timer reset) still
    // cannot exceed the advertised budget.
    const totalTimer = setTimeout(() => respondTimeout('total'), upstreamTimeoutMs);
    totalTimer.unref?.();
    res.on('close', () => clearTimeout(totalTimer));
    preq.on('error', (err) => {
      clearTimeout(totalTimer);
      const code = err && err.code ? err.code : 'unknown';
      const named = code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'upstream-refused' : `upstream-error:${code}`;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'x-offline-matrix-error': named });
        res.end(`offline-matrix proxy: 502 ${named} (${err && err.message ? err.message : String(err)})`);
      } else {
        res.destroy();
      }
    });
    req.pipe(preq);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  // PRR-006: the proxy origin used for Location re-anchoring derives from the
  // server's BOUND address — never from the client's Host header, so a
  // requester-chosen Host cannot re-anchor redirects onto its own origin.
  const boundHost = addr && typeof addr === 'object' && addr.address ? addr.address : host;
  const hostForUrl = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  const proxyBase = `http://${hostForUrl}:${port}`;
  return {
    server,
    host: boundHost,
    port,
    base: proxyBase,
    async close() {
      // PRR-021: destroy the live connections BEFORE awaiting server.close —
      // a keep-alive or mid-stream connection would otherwise hang close()
      // indefinitely and the documented Ctrl+C auto-clean with it.
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// RAM-pressure filler (scenarios 2/3/9)
// ---------------------------------------------------------------------------

export const RAM_DEFAULTS = {
  chunkMb: 256,       // allocation step (supervised worker per chunk)
  toleranceMb: 512,   // attainment tolerance, reported with every result
  reserveMb: 2048,    // never allocate a chunk that would take free below this
};

// Hard floor on --ram-reserve-mb (implementation-review round 1, Q2): the
// reserve is what keeps the filler away from a near-zero free system, so a
// caller may lower it only down to this bound — never below.
export const RAM_RESERVE_FLOOR_MB = 512;

/**
 * Fail-closed target check, BEFORE any allocation: a production
 * --ram-free-target-mb value incompatible with the reserve (target below
 * reserve + tolerance) is rejected with a named error — the harness never
 * performs a near-zero host fill. The reserve itself carries a hard floor:
 * values below RAM_RESERVE_FLOOR_MB are refused outright.
 */
export function validateRamTarget(targetFreeMb, reserveMb = RAM_DEFAULTS.reserveMb, toleranceMb = RAM_DEFAULTS.toleranceMb) {
  if (!Number.isInteger(reserveMb) || reserveMb < RAM_RESERVE_FLOOR_MB) {
    throw new UsageError(
      `--ram-reserve-mb must be an integer >= ${RAM_RESERVE_FLOOR_MB} MiB (the hard floor that keeps the filler away ` +
        `from a near-zero free system; default ${RAM_DEFAULTS.reserveMb} MiB)`,
    );
  }
  if (!Number.isInteger(targetFreeMb) || targetFreeMb < 1) {
    throw new UsageError('--ram-free-target-mb must be a positive integer (MiB of desired system-free floor)');
  }
  if (targetFreeMb < reserveMb + toleranceMb) {
    throw new UsageError(
      `--ram-free-target-mb ${targetFreeMb} is below the reserve floor ` +
        `(reserve ${reserveMb} MiB + tolerance ${toleranceMb} MiB = ${reserveMb + toleranceMb} MiB minimum); ` +
        'refusing to fill toward a near-zero free floor',
    );
  }
  return { targetFreeMb, reserveMb, toleranceMb };
}

/**
 * Chunked fill toward the desired system-free floor. Pure with respect to
 * its injections: `freemem` supplies the free-memory reading and
 * `acquireChunk` supplies the holder (a supervised worker in production, a
 * scripted record in tests/selftest). Attainment is
 * freemem() <= target + tolerance; before each chunk the reserve floor is
 * re-checked and the fill aborts (named) when the next chunk would breach
 * it; allocation failures and a stalled free-memory reading abort too.
 */
export async function fillToTarget(opts) {
  const {
    targetFreeMb,
    reserveMb = RAM_DEFAULTS.reserveMb,
    toleranceMb = RAM_DEFAULTS.toleranceMb,
    chunkMb = RAM_DEFAULTS.chunkMb,
    freemem,
    acquireChunk,
    onEvent = () => {},
    settleMs = 0,
    maxChunks = 1024,
    stallLimit = 3,
  } = opts;
  if (typeof freemem !== 'function' || typeof acquireChunk !== 'function') {
    throw new UsageError('fillToTarget requires injectable freemem() and acquireChunk()');
  }
  validateRamTarget(targetFreeMb, reserveMb, toleranceMb);
  const targetFreeBytes = targetFreeMb * 2 ** 20;
  const reserveBytes = reserveMb * 2 ** 20;
  const toleranceBytes = toleranceMb * 2 ** 20;
  const chunkBytes = chunkMb * 2 ** 20;
  const handles = [];
  const freeAtStartBytes = freemem();
  let lastFreeBytes = freeAtStartBytes;
  let stalls = 0;
  let outcome = 'attained';
  let reason = '';
  while (true) {
    const freeBytes = freemem();
    if (freeBytes <= targetFreeBytes + toleranceBytes) {
      outcome = 'attained';
      break;
    }
    if (handles.length >= maxChunks) {
      outcome = 'max-chunks-abort';
      reason = `stopped at the ${maxChunks}-chunk bound with free still above the floor`;
      break;
    }
    if (freeBytes - chunkBytes < reserveBytes) {
      outcome = 'reserve-abort';
      reason = `next ${chunkMb} MiB chunk would take system free below the ${reserveMb} MiB reserve floor`;
      break;
    }
    if (handles.length > 0 && freeBytes > lastFreeBytes - 2 ** 20) {
      stalls += 1;
      if (stalls >= stallLimit) {
        outcome = 'stall-abort';
        reason = `system free did not fall across ${stallLimit} consecutive chunks (stuck around ${Math.round(freeBytes / 2 ** 20)} MiB)`;
        break;
      }
    } else {
      stalls = 0;
    }
    lastFreeBytes = freeBytes;
    let handle;
    try {
      handle = await acquireChunk(chunkBytes);
    } catch (err) {
      outcome = 'alloc-fail';
      reason = err instanceof Error ? err.message : String(err);
      break;
    }
    handles.push(handle);
    onEvent({ type: 'chunk', index: handles.length, freeBeforeBytes: freeBytes, freeAfterBytes: freemem() });
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return {
    outcome,
    reason,
    chunks: handles.length,
    handles,
    freeAtStartBytes,
    targetFreeMb,
    reserveMb,
    toleranceMb,
    chunkMb,
  };
}

/** Kill/await every holder, then re-read free memory (release verification). */
export async function releaseChunks(handles, freemem) {
  for (const handle of handles) {
    await handle.release();
  }
  const freeAfterReleaseBytes = freemem();
  return { released: handles.length, freeAfterReleaseBytes };
}

/** Fill + release + report as one state machine (selftest/tests use this). */
export async function runRamFillerStateMachine(opts) {
  const onEvent = opts.onEvent ?? (() => {});
  const fill = await fillToTarget({ ...opts, onEvent });
  const rel = await releaseChunks(fill.handles, opts.freemem);
  onEvent({ type: 'released', ...rel });
  const { handles, ...rest } = fill;
  return { ...rest, ...rel };
}

/** One supervised worker chunk: a child process holding chunkBytes. */
export async function acquireWorkerChunk(chunkBytes, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const settleMs = opts.settleMs ?? 400;
  let spawnError = null;
  const child = spawnFn(process.execPath, [SCRIPT_PATH, '--ram-worker', String(chunkBytes), String(process.pid)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  // PRR-022: a spawn failure (ENOENT/EMFILE/...) surfaces as a named
  // alloc-fail refusal from fillToTarget's acquireChunk — never as an
  // uncaught 'error' event crash.
  child.on('error', (err) => {
    spawnError = err;
  });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  if (spawnError !== null) {
    throw new UsageError(
      `ram-worker chunk allocation failed (spawn ${process.execPath}: ${spawnError instanceof Error ? spawnError.message : String(spawnError)})`,
    );
  }
  // A late error on an otherwise healthy handle must not crash the supervisor.
  child.on('error', () => {});
  return {
    child,
    async release() {
      if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.on('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    },
  };
}

// Internal ram-worker entry: hold one chunk; self-exit when the parent is
// gone (no chunk is ever held by an orphan). Parsed by ramWorkerEntry below,
// never through parseArgs.
function ramWorkerEntry(rawArgs) {
  const chunkBytes = Number.parseInt(rawArgs[0], 10);
  const parentPid = Number.parseInt(rawArgs[1], 10);
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || !Number.isInteger(parentPid)) {
    errOut('ram-worker requires <chunk-bytes> <parent-pid>');
    process.exit(EXIT_USAGE);
  }
  const held = new ArrayBuffer(chunkBytes);
  new Uint8Array(held).fill(0x77); // commit the pages so the chunk really occupies memory
  // The liveness interval is deliberately REF'D: it is the worker's only
  // handle, so it keeps the process (and the held chunk) alive until the
  // supervisor kills it or the parent is gone. Unref'ing it here let the
  // event loop drain and the worker exit ~immediately after spawn, holding
  // zero pressure (implementation-review round 1, blocker 1).
  const liveness = setInterval(() => {
    if (held.byteLength !== chunkBytes) process.exit(1); // keeps `held` referenced
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0); // parent gone: self-exit, releasing the chunk with us
    }
  }, 5_000);
  process.on('SIGTERM', () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Network toggle (scenarios 1/10) — fail-closed
// ---------------------------------------------------------------------------

export const JOURNAL_FILENAME = '.offline-matrix-journal.json';
export const RECOVER_LEASE_MIN_DEFAULT = 45;
/** The watchdog lease is bounded to one week so a malformed value can never
 * pin an adapter disabled forever (PRR-001 follow-up). */
export const RECOVER_LEASE_MIN_MAX = 10_080;
const COMMAND_TIMEOUT_MS = 30_000;

export function journalPathFor(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, 'bench', JOURNAL_FILENAME);
}

/**
 * Fail-closed journal read (PRR-001): a MISSING journal is the empty journal
 * ([]), but an UNREADABLE or CORRUPT one (bad JSON, non-array, permission
 * error) is a named UsageError — every consumer (toggle, --recover, watchdog)
 * refuses to proceed on a journal whose contents cannot be trusted, so a
 * corrupt file can never masquerade as "nothing to recover" while an adapter
 * sits disabled.
 */
export function readJournal(journalFile) {
  let raw;
  try {
    raw = fs.readFileSync(journalFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new UsageError(
      `recovery journal ${journalFile} is unreadable (${err && err.code ? err.code : err instanceof Error ? err.message : String(err)}) — refusing to proceed on an untrusted journal; restore the adapter manually if needed, then delete or repair the file`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `recovery journal ${journalFile} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to proceed on an untrusted journal; restore the adapter manually if needed, then delete or repair the file`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(
      `recovery journal ${journalFile} is corrupt (top-level value is ${typeof parsed}, not an array) — refusing to proceed on an untrusted journal; restore the adapter manually if needed, then delete or repair the file`,
    );
  }
  return parsed;
}

export function writeJournal(journalFile, rows) {
  const tmp = `${journalFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, journalFile);
}

/**
 * MERGE-ON-WRITE (PRR-002): re-read the journal immediately before every
 * write and merge by row id, so a writer can never drop a row another writer
 * appended since this process last read. `appendJournalRow` adds/replaces one
 * row by id; `mergeJournalRows` rewrites a set of mutated rows into a fresh
 * read (rows not present in the fresh read are kept, never silently deleted).
 */
export function appendJournalRow(journalFile, row, readJournalFn = readJournal, writeJournalFn = writeJournal) {
  const merged = readJournalFn(journalFile).filter((r) => (r && r.id) !== row.id);
  merged.push(row);
  writeJournalFn(journalFile, merged);
}

export function mergeJournalRows(journalFile, mutatedRows, readJournalFn = readJournal, writeJournalFn = writeJournal) {
  const fresh = readJournalFn(journalFile);
  const byId = new Map(mutatedRows.map((r) => [r && r.id, r]));
  const present = new Set(fresh.map((r) => r && r.id));
  const merged = fresh.map((r) => (byId.has(r && r.id) ? byId.get(r && r.id) : r));
  for (const r of mutatedRows) {
    if (!present.has(r && r.id)) merged.push(r);
  }
  writeJournalFn(journalFile, merged);
}

/** Bounded command runner: real exit code, killed at the timeout. A signalled
 * close (exit code null — the process was killed) maps to the synthetic
 * nonzero 125 and carries signalCode, so a killed elevation probe can never
 * read as success (PRR-009). The timeout path kills the child and then
 * AWAITS its exit (bounded by killGraceMs) before resolving (PRR-022). */
export const RUNCOMMAND_SIGNALLED_CODE = 125;

export function runCommand(file, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  const spawnFn = opts.spawnFn ?? spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: 1, signalCode: null, stdout: '', stderr: String(err && err.message ? err.message : err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // Await the killed child's actual exit before resolving, so a killed
      // netsh cannot linger (or fire side effects) past its own timeout.
      const finish = () => {
        clearTimeout(grace);
        resolve({
          code: 124,
          signalCode: null,
          stdout,
          stderr: `${stderr}command timeout after ${timeoutMs}ms: ${file} ${args.join(' ')}`,
        });
      };
      const grace = setTimeout(finish, killGraceMs);
      child.once('close', finish);
      child.once('error', finish);
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, signalCode: null, stdout, stderr: String(err && err.message ? err.message : err) });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? RUNCOMMAND_SIGNALLED_CODE, signalCode: signal ?? null, stdout, stderr });
    });
  });
}

/**
 * PRR-017: resolve Windows system tools by their absolute %SystemRoot% paths,
 * so an elevated shell with a mangled PATH cannot shadow netsh/net (and the
 * manual command printed for the operator keeps the bare name). On other
 * platforms the bare name is returned (documented fallback).
 */
export function windowsSystemExe(name, isWindows = process.platform === 'win32', env = process.env) {
  if (!isWindows) return name;
  const sysRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return path.join(sysRoot, 'System32', `${name}.exe`);
}

/** Elevation probe: Windows `net session`, elsewhere `sudo -n true`. */
export async function probeElevation(opts = {}) {
  const run = opts.runCommand ?? runCommand;
  const isWindows = opts.isWindows ?? process.platform === 'win32';
  const file = isWindows ? windowsSystemExe('net', isWindows) : 'sudo';
  const args = isWindows ? ['session'] : ['-n', 'true'];
  const probeCmd = isWindows ? 'net session' : 'sudo -n true';
  const res = await run(file, args, { timeoutMs: 15_000 });
  return { elevated: res.code === 0, probeCmd };
}

/**
 * Adapter admin state from `netsh interface show interface`, bound to the
 * interface-name column EXACTLY (implementation-review round 1, blocker 2):
 * netsh prints fixed-width columns, so the Interface Name field is sliced by
 * the header's character offsets and must EQUAL the requested adapter — a
 * row for 'Ethernet 2' can never satisfy a query for 'Ethernet' (the old
 * substring binding returned the wrong row's state when the longer name came
 * first). Named refusal when no row matches exactly (the harness never
 * guesses an adapter).
 */
export async function readAdapterState(adapter, run, isWindows = process.platform === 'win32') {
  if (!isWindows) {
    throw new UsageError('the network toggle is Windows-only (netsh); on other platforms disable the adapter with the OS tool and record it in the tuple');
  }
  const res = await run(windowsSystemExe('netsh', isWindows), ['interface', 'show', 'interface'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    throw new UsageError(`'netsh interface show interface' failed (exit ${res.code}): ${String(res.stderr).trim()}`);
  }
  const lines = String(res.stdout).split(/\r?\n/);
  const header = lines.find((ln) => ln.includes('Interface Name'));
  if (!header) {
    throw new UsageError(
      "'netsh interface show interface' output has no 'Interface Name' column header to bind rows by — cannot identify adapters safely",
    );
  }
  const nameStart = header.indexOf('Interface Name');
  const opStart = header.indexOf('Operational State');
  const nameEnd = opStart > nameStart ? opStart : Number.MAX_SAFE_INTEGER;
  for (const line of lines) {
    const m = line.match(/^\s*(Enabled|Disabled)\s/);
    if (!m) continue;
    const bound = line.slice(nameStart, nameEnd).trim();
    if (bound === adapter) return m[1];
  }
  throw new UsageError(
    `adapter '${adapter}' not found in 'netsh interface show interface' output — name the adapter exactly with --adapter (the harness never guesses an adapter)`,
  );
}

export function manualCommandFor(adapter) {
  return `netsh interface set interface "${adapter}" enable`;
}

/** Best-effort enable + read-back verification of one adapter. */
async function restoreAdapter(adapter, run, isWindows) {
  const res = await run(windowsSystemExe('netsh', isWindows), ['interface', 'set', 'interface', adapter, 'enable'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    return { restored: false, reason: `netsh enable exited ${res.code}: ${String(res.stderr).trim()}` };
  }
  let state = null;
  try {
    state = await readAdapterState(adapter, run, isWindows);
  } catch {
    state = null;
  }
  return state === 'Enabled'
    ? { restored: true }
    : { restored: false, reason: `read-back after enable reported '${state ?? 'unparseable'}'` };
}

/**
 * The fail-closed disable. Gate order (no state touched before all gates
 * pass): explicit adapter -> --confirm-network-toggle -> elevation probe.
 * Then: read prior state -> JOURNAL-BEFORE-ACT -> netsh disable -> read-back
 * verify -> detached recovery watchdog. An already-disabled adapter takes no
 * action and journals no active row (the operator's own prior state is never
 * "restored" over). Every refusal is a named UsageError (exit 2).
 */
export async function performNetworkToggle(opts) {
  const {
    adapter,
    mode = 'disable',
    confirm = false,
    run,
    isWindows = process.platform === 'win32',
    journalFile,
    readJournalFn = readJournal,
    writeJournalFn = writeJournal,
    leaseMinutes = RECOVER_LEASE_MIN_DEFAULT,
    elevated,
    spawnRecovery = undefined,
    now = () => new Date(),
    print = (msg) => out(msg),
  } = opts;
  if (!isWindows) {
    throw new UsageError('the network toggle is Windows-only (netsh interface set interface); this machine is not Windows');
  }
  if (!adapter) {
    throw new UsageError('network toggle requires --adapter <name> (explicit adapter selection; the harness never guesses an adapter)');
  }
  if (!confirm) {
    throw new UsageError(
      'network toggle requires --confirm-network-toggle (fail-closed: no network state is touched without the explicit per-run confirmation)',
    );
  }
  if (elevated === false) {
    throw new UsageError('network toggle requires an elevated shell (elevation probe reported not elevated); no network state was touched');
  }
  if (elevated === undefined) {
    const probe = await probeElevation({ runCommand: run, isWindows });
    if (!probe.elevated) {
      throw new UsageError(
        `network toggle requires an elevated shell — the elevation probe '${probe.probeCmd}' failed (run from an administrator PowerShell); no network state was touched`,
      );
    }
  }
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1 || leaseMinutes > RECOVER_LEASE_MIN_MAX) {
    throw new UsageError(
      `--recover-lease-min must be an integer in [1, ${RECOVER_LEASE_MIN_MAX}] (one week); got ${leaseMinutes} — the watchdog lease is bounded so a malformed value can never pin an adapter disabled forever`,
    );
  }
  // PRR-001: a journal that cannot be read trustedly is a refusal — the
  // journal-before-act guarantee is meaningless on top of an unreadable file
  // (readJournalFn throws its named UsageError up through here).
  const priorState = await readAdapterState(adapter, run, isWindows);
  if (priorState === 'Disabled') {
    print(`network: adapter '${adapter}' is already Disabled — no action taken, no recovery row journaled`);
    return { status: 'already-disabled', adapter };
  }
  const row = {
    id: `jr-${now().getTime()}-${process.pid}`,
    mode,
    adapter,
    prior_state: priorState,
    timestamp: now().toISOString(),
    pid: process.pid,
    lease_minutes: leaseMinutes,
    status: 'active',
  };
  appendJournalRow(journalFile, row, readJournalFn, writeJournalFn); // JOURNAL-BEFORE-ACT (merge-on-write): recoverable even if we crash on the next line
  const disableArgs = ['interface', 'set', 'interface', adapter, mode === 'disable' ? 'disable' : 'enable'];
  const disable = await run(windowsSystemExe('netsh', isWindows), disableArgs, { timeoutMs: COMMAND_TIMEOUT_MS });
  const verifyFail = async (why) => {
    const attempt = await restoreAdapter(adapter, run, isWindows);
    row.status = attempt.restored ? 'recovered' : 'restore-failed';
    row.restore_reason = why;
    mergeJournalRows(journalFile, [row], readJournalFn, writeJournalFn);
    if (attempt.restored) {
      throw new UsageError(
        `${why}; adapter '${adapter}' was re-enabled and verified — the scenario window did NOT start`,
      );
    }
    throw new UsageError(
      `${why}; RESTORE FAILED (${attempt.reason}) — run manually: ${manualCommandFor(adapter)}`,
    );
  };
  if (disable.code !== 0) {
    await verifyFail(`netsh ${mode} exited ${disable.code}: ${String(disable.stderr).trim()}`);
  }
  // PRR-008: the post-disable read-back is guarded — a netsh show FAILURE now
  // enters the same verifyFail path (restore attempt + journal restore-failed
  // + manual command) instead of escaping as a bare adapter-lookup error with
  // the adapter left disabled and nothing surfacing it.
  let after = null;
  let readBackError = null;
  try {
    after = await readAdapterState(adapter, run, isWindows);
  } catch (err) {
    readBackError = err;
  }
  if (readBackError !== null) {
    await verifyFail(
      `read-back verification could not run after disable: ${readBackError instanceof Error ? readBackError.message : String(readBackError)}`,
    );
  }
  if (mode === 'disable' && after !== 'Disabled') {
    await verifyFail(`read-back verification failed after disable: 'netsh interface show interface' still reports ${after} for '${adapter}'`);
  }
  if (spawnRecovery === undefined) {
    spawnRecoveryChild({ args: ['--recover-lease-min', String(leaseMinutes)] });
  } else if (spawnRecovery !== false) {
    spawnRecovery({ leaseMinutes });
  }
  print(
    `network: adapter '${adapter}' ${mode === 'disable' ? 'disabled' : 'enabled'} and verified by read-back; ` +
      `persistent lifecycle — the adapter stays ${mode === 'disable' ? 'disabled' : 'enabled'} across the operator window`,
  );
  print(`network: detached recovery watchdog armed (lease ${leaseMinutes} min from the journal timestamp)`);
  print(`network: restore now with: node ${path.relative(REPO_ROOT, SCRIPT_PATH)} --recover`);
  print(`network: manual restore command: ${manualCommandFor(adapter)}`);
  return { status: mode === 'disable' ? 'disabled' : 'enabled', rowId: row.id };
}

/**
 * Idempotent, bounded restore: reads the journal, restores only rows this
 * journal owns (mode=disable, status active or restore-failed), verifies by
 * read-back, rewrites the row status. A restore failure prints the exact
 * manual netsh command.
 */
export async function recoverFromJournal(opts) {
  const {
    journalFile,
    run,
    isWindows = process.platform === 'win32',
    readJournalFn = readJournal,
    writeJournalFn = writeJournal,
    now = () => new Date(),
    print = (msg) => out(msg),
  } = opts;
  const rows = readJournalFn(journalFile);
  const mutated = [];
  let restored = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.mode !== 'disable') continue;
    if (row.status !== 'active' && row.status !== 'restore-failed') continue;
    const attempt = await restoreAdapter(row.adapter, run, isWindows);
    row.status = attempt.restored ? 'recovered' : 'restore-failed';
    row.recovered_at = now().toISOString();
    mutated.push(row);
    if (attempt.restored) {
      restored += 1;
      print(`recover: adapter '${row.adapter}' re-enabled and verified by read-back`);
    } else {
      failed += 1;
      print(
        `recover: RESTORE FAILED for adapter '${row.adapter}' (${attempt.reason}) — run manually: ${manualCommandFor(row.adapter)}`,
      );
    }
  }
  if (mutated.length > 0) mergeJournalRows(journalFile, mutated, readJournalFn, writeJournalFn);
  else print('recover: no active journal rows (nothing to recover)');
  return { restored, failed, rows: rows.length };
}

/**
 * The detached watchdog loop, fully injectable (clock, sleep, state,
 * restore). Exits idle when the journal is gone/has no owned rows; at lease
 * expiry (journal-timestamp based) it restores + verifies and rewrites the
 * row recovered/restore-failed (failed rows retry up to RESTORE_ATTEMPT_MAX
 * attempts, then the manual command is the printed remedy). Verdicts:
 * 'idle' | 'restored' | 'max-loops' | 'restore-failed' (rows exhausted the
 * attempt cap without restoring — a failure, mapped to a nonzero exit by
 * watchdogExitFor; PRR-022). A malformed row timestamp/lease is treated as
 * NEVER due with a named warning (fail-safe direction: the watchdog acts
 * only on journal data it can trust; --recover or the manual command remain
 * the remedy), and the effective lease is clamped to RECOVER_LEASE_MIN_MAX.
 */
export const RESTORE_ATTEMPT_MAX = 3;

export async function recoveryWatchdog(opts) {
  const {
    readJournalState,
    writeJournalState,
    sleep,
    now,
    attemptRestore,
    pollMs = 30_000,
    print = (msg) => out(msg),
    maxLoops = 10_000,
  } = opts;
  let sawCappedRestoreFailure = false;
  for (let loop = 0; loop < maxLoops; loop += 1) {
    const rows = readJournalState();
    if (!Array.isArray(rows) || rows.length === 0) {
      print('recover-watchdog: journal gone or empty; idle');
      return 'idle';
    }
    const owned = rows.filter((r) => r.mode === 'disable');
    const open = owned.filter(
      (r) => r.status === 'active' || (r.status === 'restore-failed' && (r.restore_attempts ?? 0) < RESTORE_ATTEMPT_MAX),
    );
    if (open.length === 0) {
      if (sawCappedRestoreFailure) {
        print('recover-watchdog: restore attempts exhausted without success; idle — the manual netsh command is the remedy');
        return 'restore-failed';
      }
      print('recover-watchdog: no open rows; idle');
      return 'idle';
    }
    let wrote = false;
    let restoredThisPass = 0;
    for (const row of open) {
      const ts = Date.parse(row.timestamp);
      const lease = Number(row.lease_minutes);
      if (!Number.isFinite(ts) || !Number.isInteger(lease) || lease < 1) {
        print(
          `recover-watchdog: row ${String(row.id ?? '<no id>')} carries a malformed timestamp/lease ` +
            `(timestamp ${JSON.stringify(row.timestamp)}, lease_minutes ${JSON.stringify(row.lease_minutes)}) — ` +
            'treated as never due; restore it with --recover or the manual netsh command',
        );
        continue;
      }
      const dueAt = ts + Math.min(lease, RECOVER_LEASE_MIN_MAX) * 60_000;
      if (now() < dueAt) continue;
      const attempt = await attemptRestore(row);
      row.restore_attempts = (row.restore_attempts ?? 0) + 1;
      row.status = attempt.restored ? 'recovered' : 'restore-failed';
      wrote = true;
      if (attempt.restored) {
        restoredThisPass += 1;
        print(`recover-watchdog: lease expired; adapter '${row.adapter}' restored and verified`);
      } else {
        if (row.restore_attempts >= RESTORE_ATTEMPT_MAX) sawCappedRestoreFailure = true;
        print(
          `recover-watchdog: restore FAILED for adapter '${row.adapter}' (attempt ${row.restore_attempts}/${RESTORE_ATTEMPT_MAX}: ${attempt.reason ?? 'unspecified'})` +
            (row.restore_attempts >= RESTORE_ATTEMPT_MAX
              ? ` — run manually: ${manualCommandFor(row.adapter)}`
              : ''),
        );
      }
    }
    if (wrote) writeJournalState(rows);
    if (restoredThisPass > 0) {
      const stillOpen = rows.filter(
        (r) => r.mode === 'disable' && (r.status === 'active' || (r.status === 'restore-failed' && (r.restore_attempts ?? 0) < RESTORE_ATTEMPT_MAX)),
      );
      if (stillOpen.length === 0) return 'restored';
    }
    await sleep(pollMs);
  }
  return 'max-loops';
}

/** Watchdog verdict → exit code: only idle/restored exit 0; max-loops and
 * restore-failed are failures (PRR-022 verdict mapping). */
export function watchdogExitFor(verdict) {
  if (verdict === 'idle' || verdict === 'restored') return EXIT_OK;
  return EXIT_RECOVER;
}

/**
 * Spawn the out-of-process recovery watchdog: detached, no IPC channel
 * (stdio 'ignore'), unref'd — the child outlives the parent and the parent
 * never waits on it. The child re-reads the journal from disk, so it stays
 * correct even when the parent dies between the disable and its first check
 * (the disclosed residual: SIGKILL in that exact window leaves the adapter
 * disabled until --recover or the manual command; the journal row is on
 * disk from before the act).
 */
export function spawnRecoveryChild(opts = {}) {
  const { nodeBin = process.execPath, scriptPath = SCRIPT_PATH, args = [], spawnFn = spawn } = opts;
  const child = spawnFn(nodeBin, [scriptPath, '--recover-watchdog', ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // PRR-022: no console-window flash from the detached watchdog
  });
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// Capture channel (surface offline-matrix, merged via bench/append_results.py)
// ---------------------------------------------------------------------------

export const CAPTURE_SURFACE = 'offline-matrix';
export const CAPTURE_DIR = path.join(REPO_ROOT, 'bench', 'offline-matrix-results');
export const CAPTURE_ROW_KEYS = [
  'surface',
  'machine',
  'scenario_id',
  'scenario',
  'outcome',
  'tuple_ref',
  'automated_legs',
  'blocked_marker',
  'measured',
  'notes',
];

/** ISO-8601 compacted to a colon-free file-safe timestamp: 20261030T213000Z. */
export function captureTimestamp(now = new Date()) {
  return new Date(now).toISOString().replace(/-/g, '').replace(/:/g, '').replace(/\.\d+Z$/, 'Z');
}

export function buildCaptureRow(fields) {
  const scenario = fields.scenario ?? scenarioById(fields.scenarioId);
  const row = {
    surface: CAPTURE_SURFACE,
    // SEC-16: a '|' in the machine tag would break out of the merged markdown
    // row cell — pipes are sanitized in the row body (the filename uses the
    // stricter filesystem sanitizer below).
    machine: String(fields.machine).replace(/\|/g, '_'),
    scenario_id: scenario.id,
    scenario: scenario.title,
    outcome: fields.outcome ?? 'PENDING',
    tuple_ref: fields.tupleRef ?? '{{TUPLE}}',
    automated_legs: fields.automatedLegs ?? 'none',
    blocked_marker: scenario.blocked,
    measured: fields.measured ?? '',
    notes: fields.notes ?? '',
  };
  const missing = ['surface', 'machine', 'scenario_id', 'scenario', 'outcome', 'tuple_ref'].filter(
    (k) => row[k] === undefined || row[k] === null || row[k] === '',
  );
  if (missing.length > 0) {
    throw new CaptureError(`capture row missing required keys: ${missing.join(', ')}`);
  }
  return row;
}

/**
 * Write one capture row: bench/offline-matrix-results/<S-id>-<machine>-<ts>Z.json
 * (colon-free; the real ISO timestamp is inside the JSON). Fail-closed on the
 * machine-tag discipline: BENCH_MACHINE_TAG must be set and must name a
 * machine registered under "## Machine registry" in bench/RESULTS.md
 * (append_results.py refuses unregistered tags at merge time).
 * PRR-019: the write is ATOMIC (tmp file + link, which fails when the target
 * name already exists) — a same-second filename collision gets a `-1`, `-2`,
 * ... suffix instead of silently overwriting, and raw IO failures are mapped
 * onto CaptureError (the documented exit-4 class).
 */
export function writeCaptureRow(opts) {
  const {
    scenarioId,
    machineTag = process.env.BENCH_MACHINE_TAG ?? '',
    measured = '',
    notes = '',
    automatedLegs = 'none',
    outcome = 'PENDING',
    dir = CAPTURE_DIR,
    now = () => new Date(),
    mkdirSync = fs.mkdirSync,
    writeFileSync = fs.writeFileSync,
  } = opts;
  if (!machineTag) {
    throw new CaptureError(
      'BENCH_MACHINE_TAG is not set — capture rows carry a machine tag that must be registered under "## Machine registry" in bench/RESULTS.md (append_results.py refuses unregistered tags at merge time)',
    );
  }
  const scenario = scenarioById(scenarioId);
  const row = buildCaptureRow({ scenario, machine: machineTag, measured, notes, automatedLegs, outcome });
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new CaptureError(
      `capture row write failed (mkdir ${dir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const safeMachine = String(machineTag).replace(/[^A-Za-z0-9._-]/g, '_');
  const payload = `${JSON.stringify(row, null, 2)}\n`;
  const base = `${scenario.id}-${safeMachine}-${captureTimestamp(now())}`;
  let lastErr = null;
  for (let suffix = 0; suffix < 64; suffix += 1) {
    const name = suffix === 0 ? `${base}.json` : `${base}-${suffix}.json`;
    const file = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.tmp-${process.pid}`);
    try {
      writeFileSync(tmp, payload, 'utf8');
      try {
        // link() atomically publishes the tmp file under its final name and
        // FAILS with EEXIST when that name is already taken (rename would
        // silently overwrite a same-second collision).
        fs.linkSync(tmp, file);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best-effort cleanup of our own tmp file */
        }
      }
      return { file, row };
    } catch (err) {
      lastErr = err;
      // EEXIST = name collision → retry with the next -N suffix. Windows may
      // surface the taken-name case as EPERM; treated as a collision too.
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) continue;
      throw new CaptureError(
        `capture row write failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new CaptureError(
    `capture row write failed: no free filename for ${base}.json after 64 collision retries (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  );
}

function prepNotes(extra = '') {
  const bits = [`node ${process.version}`, `${os.platform()}/${os.arch()}`, `pid ${process.pid}`];
  if (extra) bits.push(extra);
  return bits.join('; ');
}

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

function printScenarioList() {
  out('id    scenario                                 automated legs        lifecycle    status');
  for (const sc of SCENARIOS) {
    const legs = sc.legs.length > 0 ? sc.legs.join('+') : 'none';
    out(
      `${sc.id.padEnd(6)}${sc.title.padEnd(41)}${legs.padEnd(22)}${sc.lifecycle.padEnd(13)}${sc.blocked}`,
    );
  }
}

// ---------------------------------------------------------------------------
// --scenario <id> --prep
// ---------------------------------------------------------------------------

/**
 * PRR-022: process.exit can truncate the final `capture row:` stdout line
 * when stdout is a pipe. Flush before exiting: the write callback fires once
 * the data reaches the OS; a bounded grace (2 s) guarantees a stuck pipe
 * still exits.
 */
function flushAndExit(code) {
  let exited = false;
  const exitNow = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  const grace = setTimeout(exitNow, 2_000);
  try {
    process.stdout.on('error', exitNow);
    process.stdout.write('', () => {
      clearTimeout(grace);
      exitNow();
    });
  } catch {
    exitNow();
  }
}

/**
 * Hold the scenario window open with the auto-clean teardown wired to
 * SIGINT/SIGTERM. Fully injectable (PRR-011): `deps.writeCapture` replaces
 * the capture seam and `deps.exit` the exit seam, so the production
 * teardown → capture → exit path is testable end to end. The FIRST interrupt
 * runs the clean teardown (leg teardown → capture row → exit with the
 * capture verdict); a SECOND interrupt while that teardown is still running
 * force-exits 130 instead of hanging forever on a stuck teardown (PRR-021
 * escape hatch — the clean teardown and its capture row are abandoned).
 * Returns a never-resolving promise (the hold IS the scenario window); the
 * promise carries a dispose() that removes the signal listeners (tests).
 */
export function holdLegWithAutoClean(sc, automatedLegs, teardownWork, deps = {}) {
  const writeCaptureFn = deps.writeCapture ?? writeCaptureRow;
  const exitFn = deps.exit ?? ((code) => flushAndExit(code));
  let tearingDown = false;
  const onSignal = (signal) => {
    if (tearingDown) {
      errOut(
        `${signal}: teardown already in progress — second interrupt forces exit (${EXIT_FORCED}; the clean teardown and its capture row are abandoned; run --recover if a network leg is involved)`,
      );
      exitFn(EXIT_FORCED);
      return;
    }
    tearingDown = true;
    (async () => {
      let code = EXIT_OK;
      let measured = '';
      try {
        measured = await teardownWork(signal);
      } catch (err) {
        errOut(`teardown failed: ${err instanceof Error ? err.message : String(err)}`);
        code = EXIT_CAPTURE;
      }
      try {
        const { file } = writeCaptureFn({
          scenarioId: sc.id,
          automatedLegs,
          measured,
          notes: prepNotes(`ended by ${signal}`),
        });
        out(`capture row: ${path.relative(REPO_ROOT, file)}`);
      } catch (err) {
        if (err instanceof CaptureError) {
          errOut(err.message);
          code = err.exitCode;
        } else {
          errOut(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
          code = EXIT_CAPTURE;
        }
      }
      out(`${sc.id} auto-clean complete (received ${signal}); merge the capture row per "Results capture" in the matrix doc`);
      exitFn(code);
    })().catch((err) => {
      errOut(String(err));
      exitFn(EXIT_CAPTURE);
    });
  };
  const sigintListener = () => onSignal('SIGINT');
  const sigtermListener = () => onSignal('SIGTERM');
  process.on('SIGINT', sigintListener);
  process.on('SIGTERM', sigtermListener);
  out(
    `${sc.id}: environment leg active — run the operator steps now; press Ctrl+C to end the scenario window, tear the leg down (auto-clean), and write the capture row (a second Ctrl+C force-exits if the teardown hangs)`,
  );
  const hold = new Promise(() => {});
  hold.dispose = () => {
    process.removeListener('SIGINT', sigintListener);
    process.removeListener('SIGTERM', sigtermListener);
  };
  return hold;
}

export async function runPrep(args, deps = {}) {
  const fillFn = deps.fill ?? fillToTarget;
  const holdFn = deps.hold ?? holdLegWithAutoClean;
  const writeCaptureFn = deps.writeCapture ?? writeCaptureRow;
  const sc = scenarioById(args.scenario);
  out(`scenario ${sc.id} — ${sc.title}`);
  out('tuple: reference {{TUPLE}} — record the run tuple once in bench/offline-validation-matrix.md "Hardware/software tuple"');
  out(
    `status: ${sc.blocked} — every proof leg of this matrix needs the reference laptop; prep arranges the ENVIRONMENT only and never claims the measured proof`,
  );
  const legsText = sc.legs.length > 0 ? sc.legs.join(', ') : 'none (operator-only measurement)';
  out(
    `automated legs: ${legsText}; lifecycle: ${sc.lifecycle} ` +
      (sc.lifecycle === 'persistent'
        ? '(the adapter stays disabled across the operator window; --recover or the watchdog restores it)'
        : '(the harness tears the leg down on exit)'),
  );
  out(`operator steps: bench/offline-validation-matrix.md, "Scenario ${sc.id}" section`);

  const legStates = [];
  const measuredBits = [];
  try {
    for (const leg of sc.legs) {
      if (leg === 'network-toggle') {
        const leaseMinutes = args.recoverLeaseMin ?? RECOVER_LEASE_MIN_DEFAULT;
        const res = await performNetworkToggle({
          adapter: args.adapter,
          confirm: args.confirmNetworkToggle,
          run: runCommand,
          journalFile: journalPathFor(REPO_ROOT),
          leaseMinutes,
        });
        legStates.push(`network-toggle:${res.status}`);
        if (res.status === 'disabled') {
          measuredBits.push(
            `adapter '${args.adapter}' disabled + verified by read-back; recovery lease ${leaseMinutes} min`,
          );
        }
      } else if (leg === 'ram-filler') {
        if (!args.ramFreeTargetMb) {
          throw new UsageError(
            `--ram-free-target-mb is required for the ram-filler leg of ${sc.id} (doc values: 9000 for S2, 5600 for S3 and S9)`,
          );
        }
        const reserveMb = args.ramReserveMb ?? RAM_DEFAULTS.reserveMb;
        validateRamTarget(args.ramFreeTargetMb, reserveMb);
        out(
          `ram-filler: target system-free floor ${args.ramFreeTargetMb} MiB ` +
            `(reserve ${reserveMb} MiB, tolerance ${RAM_DEFAULTS.toleranceMb} MiB, chunk ${RAM_DEFAULTS.chunkMb} MiB, supervised workers)`,
        );
        const fill = await fillFn({
          targetFreeMb: args.ramFreeTargetMb,
          reserveMb,
          freemem: () => os.freemem(),
          acquireChunk: (chunkBytes) => acquireWorkerChunk(chunkBytes),
          onEvent: (e) => {
            if (e.type === 'chunk') {
              out(`ram: chunk ${e.index} held (free now ${Math.round(e.freeAfterBytes / 2 ** 20)} MiB)`);
            }
          },
          settleMs: 400,
        });
        const freeNowMb = Math.round(os.freemem() / 2 ** 20);
        out(
          `ram: ${fill.outcome} after ${fill.chunks} chunk(s) — free ${freeNowMb} MiB vs attainment floor ` +
            `${args.ramFreeTargetMb + RAM_DEFAULTS.toleranceMb} MiB${fill.reason ? ` (${fill.reason})` : ''}`,
        );
        if (fill.outcome !== 'attained') {
          // Q1 (implementation-review round 1): FAIL-CLOSED on a non-attained
          // fill — never enter the scenario hold on partial pressure. Release
          // everything that was allocated, print the named outcome+reason, and
          // exit 3 (no capture row is written for a failed fill).
          const rel = await releaseChunks(fill.handles, () => os.freemem());
          errOut(
            `ram-filler did not attain the ${args.ramFreeTargetMb} MiB floor: ${fill.outcome}` +
              `${fill.reason ? ` (${fill.reason})` : ''}; released ${rel.released} held chunk(s), system free re-read ` +
              `${Math.round(rel.freeAfterReleaseBytes / 2 ** 20)} MiB — NOT entering the scenario hold (no pressure is ` +
              'applied and no capture row is written); exit 3',
          );
          return EXIT_SELFTEST;
        }
        legStates.push(`ram-filler:${fill.outcome}`);
        await holdFn(
          sc,
          legStates.join(';'),
          async () => {
            const rel = await releaseChunks(fill.handles, () => os.freemem());
            out(
              `ram: released ${rel.released} chunk(s); system free re-read at ${Math.round(rel.freeAfterReleaseBytes / 2 ** 20)} MiB`,
            );
            return `ram-filler ${fill.outcome}; chunks ${fill.chunks}; free-after-release ${Math.round(
              rel.freeAfterReleaseBytes / 2 ** 20,
            )} MiB (target ${args.ramFreeTargetMb} MiB, tolerance ${RAM_DEFAULTS.toleranceMb} MiB)`;
          },
          { writeCapture: writeCaptureFn }, // PRR-011: the teardown→capture seam is injectable
        );
      } else if (leg === 'header-strip-proxy') {
        if (!args.proxyUpstream) {
          throw new UsageError(
            '--proxy-upstream is required for the header-strip-proxy leg (the loopback origin the app is served from, e.g. http://127.0.0.1:8710)',
          );
        }
        const proxy = await createStripProxy({
          upstreamBase: args.proxyUpstream,
          host: args.proxyHost,
          port: args.proxyPort,
          upstreamTimeoutMs: args.proxyTimeoutMs,
        });
        out(`proxy:${proxy.host}:${proxy.port} -> ${args.proxyUpstream} (COOP/COEP/CORP stripped on every response class; Locations re-anchored onto the proxy origin)`);
        out(`proxy: point the browser at ${proxy.base} for the scenario window`);
        legStates.push('header-strip-proxy:up');
        await holdFn(
          sc,
          legStates.join(';'),
          async () => {
            await proxy.close();
            return `header-strip proxy ${proxy.base} -> ${args.proxyUpstream} served the window and closed cleanly`;
          },
          { writeCapture: writeCaptureFn }, // PRR-011: the proxy leg goes through the SAME injected hold seam
        );
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      errOut(err.message);
      return err.exitCode;
    }
    throw err;
  }
  if (sc.legs.length === 0) {
    out('automated legs: none — run the operator steps in the doc section, then record the row per "Results capture"');
  }
  try {
    const { file } = writeCaptureFn({
      scenarioId: sc.id,
      automatedLegs: legStates.join(';') || 'none',
      measured: measuredBits.join('; '),
      notes: prepNotes(),
    });
    out(`capture row: ${path.relative(REPO_ROOT, file)}`);
  } catch (err) {
    if (err instanceof CaptureError) {
      errOut(err.message);
      return err.exitCode;
    }
    // PRR-019: the main path maps raw capture IO failures onto the SAME
    // documented exit-4 class as the teardown path (writeCaptureRow wraps its
    // own IO errors; this covers injected seams and any rethrow shape).
    errOut(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_CAPTURE;
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// --recover-watchdog (the detached child's entry)
// ---------------------------------------------------------------------------

/**
 * The live watchdog's journal IO: reads fail-closed (a corrupt journal
 * escapes as a named UsageError instead of idling) and writes MERGE-ON-WRITE
 * — the watchdog's mutated rows are merged into a FRESH read, so a row the
 * parent appended while the watchdog was mid-restore is never dropped.
 */
export function watchdogJournalIo(journalFile) {
  return {
    readJournalState: () => (fs.existsSync(journalFile) ? readJournal(journalFile) : []),
    writeJournalState: (rows) => mergeJournalRows(journalFile, rows),
  };
}

export async function runRecoverWatchdogLive(args) {
  const journalFile = journalPathFor(REPO_ROOT);
  const verdict = await recoveryWatchdog({
    ...watchdogJournalIo(journalFile),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    attemptRestore: (row) => restoreAdapter(row.adapter, runCommand, process.platform === 'win32'),
    pollMs: 30_000,
  });
  out(`recover-watchdog: exit ${verdict}`);
  return watchdogExitFor(verdict);
}

// ---------------------------------------------------------------------------
// --selftest (hardware-free; the three frozen leg markers)
// ---------------------------------------------------------------------------

async function fetchBounded(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

function assertStripped(response, label) {
  for (const header of STRIP_HEADERS) {
    if (response.headers.get(header) !== null) {
      throw new Error(`${label}: '${header}' survived the strip proxy (value: ${response.headers.get(header)})`);
    }
  }
}

async function selftestProxyStrip() {
  let upstreamPort = 0;
  const iso = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const upstream = http.createServer((req, res) => {
    if (req.url === '/emit') {
      res.writeHead(200, { ...iso, 'content-type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'isolation headers live upstream');
    } else if (req.url === '/redirect-absolute') {
      res.writeHead(302, { ...iso, location: `http://127.0.0.1:${upstreamPort}/emit?next=1#frag` });
      res.end();
    } else if (req.url === '/redirect-scheme-relative') {
      res.writeHead(302, { ...iso, location: `//127.0.0.1:${upstreamPort}/emit?next=2` });
      res.end();
    } else if (req.url === '/missing') {
      res.writeHead(404, { ...iso, 'content-type': 'text/plain; charset=utf-8' });
      res.end('missing');
    } else if (req.url === '/boom') {
      res.writeHead(500, { ...iso, 'content-type': 'text/plain; charset=utf-8' });
      res.end('boom');
    } else if (req.url === '/hang') {
      // never responds: the proxy's upstream timeout must produce the named 504
    } else {
      res.writeHead(200, iso);
      res.end('ok');
    }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;
  try {
    const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
    // proof line: the upstream really emits all three headers
    const direct = await fetchBounded(`${upstreamBase}/emit`);
    const proof = STRIP_HEADERS.map((h) => direct.headers.get(h)).join('/');
    if (proof.includes('null')) throw new Error(`upstream-emits-headers proof failed (${proof})`);
    out(`  upstream-emits-headers: ${proof}`);

    const proxy = await createStripProxy({ upstreamBase, upstreamTimeoutMs: 500 });
    try {
      const r200 = await fetchBounded(`${proxy.base}/emit`);
      if (r200.status !== 200) throw new Error(`200 leg got status ${r200.status}`);
      assertStripped(r200, '200');
      await r200.text();

      const rHead = await fetchBounded(`${proxy.base}/emit`, { method: 'HEAD' });
      assertStripped(rHead, 'HEAD');

      const rAbs = await fetchBounded(`${proxy.base}/redirect-absolute`, { redirect: 'manual' });
      if (rAbs.status !== 302) throw new Error(`absolute-redirect leg got status ${rAbs.status}`);
      assertStripped(rAbs, '3xx-absolute');
      const locAbs = rAbs.headers.get('location') ?? '';
      if (!locAbs.startsWith(`${proxy.base}/`) || !locAbs.includes('next=1') || !locAbs.includes('#frag')) {
        throw new Error(`absolute Location not re-anchored onto the proxy origin: ${locAbs}`);
      }

      const rRel = await fetchBounded(`${proxy.base}/redirect-scheme-relative`, { redirect: 'manual' });
      assertStripped(rRel, '3xx-scheme-relative');
      const locRel = rRel.headers.get('location') ?? '';
      if (!locRel.startsWith(`${proxy.base}/`) || !locRel.includes('next=2')) {
        throw new Error(`scheme-relative Location not re-anchored onto the proxy origin: ${locRel}`);
      }

      const r404 = await fetchBounded(`${proxy.base}/missing`);
      if (r404.status !== 404) throw new Error(`404 leg got status ${r404.status}`);
      assertStripped(r404, '404');
      await r404.text();

      const r500 = await fetchBounded(`${proxy.base}/boom`);
      if (r500.status !== 500) throw new Error(`500 leg got status ${r500.status}`);
      assertStripped(r500, '500');
      await r500.text();

      const concurrent = await Promise.all(
        Array.from({ length: 6 }, () => fetchBounded(`${proxy.base}/emit`)),
      );
      concurrent.forEach((r, i) => assertStripped(r, `concurrent-${i}`));
      await Promise.all(concurrent.map((r) => r.text()));

      const r504 = await fetchBounded(`${proxy.base}/hang`);
      if (r504.status !== 504) throw new Error(`timeout leg got status ${r504.status} (expected 504)`);
      if (r504.headers.get('x-offline-matrix-error') !== 'upstream-timeout') {
        throw new Error(`timeout leg lost the named reason: ${r504.headers.get('x-offline-matrix-error')}`);
      }
      assertStripped(r504, '504');
      await r504.text();
    } finally {
      await proxy.close();
    }

    const dead = await createStripProxy({ upstreamBase: 'http://127.0.0.1:9' });
    try {
      const r502 = await fetchBounded(`${dead.base}/emit`);
      if (r502.status !== 502) throw new Error(`unreachable-upstream leg got status ${r502.status} (expected 502)`);
      if (r502.headers.get('x-offline-matrix-error') !== 'upstream-refused') {
        throw new Error(`unreachable-upstream leg lost the named reason: ${r502.headers.get('x-offline-matrix-error')}`);
      }
      assertStripped(r502, '502');
      await r502.text();
    } finally {
      await dead.close();
    }
  } finally {
    await new Promise((resolve) => upstream.close(() => resolve()));
    upstream.closeAllConnections?.();
  }
}

function realAllocSmoke() {
  const MiB = 2 ** 20;
  const freeBefore = os.freemem();
  let checksum = 0;
  {
    const held = new ArrayBuffer(64 * MiB);
    const view = new Uint8Array(held);
    view.fill(0x5a);
    checksum = view[0] + view[view.length - 1] + view.length;
  } // `held` is unreachable here; reclamation timing is the OS's
  const freeAfter = os.freemem();
  if (checksum !== 0x5a + 0x5a + 64 * MiB) throw new Error('64 MiB smoke: touched-buffer checksum mismatch');
  if (!(freeAfter > 0)) throw new Error('64 MiB smoke: os.freemem() re-read was not positive');
  return { freeBeforeMb: Math.round(freeBefore / MiB), freeAfterMb: Math.round(freeAfter / MiB) };
}

async function selftestRamFiller() {
  const MiB = 2 ** 20;
  // (a) injected-freemem attainment + release verification (no real allocation)
  {
    let heldChunks = 0;
    const acquire = async () => {
      heldChunks += 1;
      return {
        release: async () => {
          heldChunks -= 1;
        },
      };
    };
    const freemem = () => (12000 - heldChunks * 256) * MiB;
    const res = await runRamFillerStateMachine({ targetFreeMb: 8192, freemem, acquireChunk: acquire });
    if (res.outcome !== 'attained') throw new Error(`synthetic attainment failed: ${res.outcome} (${res.reason})`);
    if (res.chunks !== 13) throw new Error(`synthetic attainment chunk count ${res.chunks} != 13`);
    if (heldChunks !== 0) throw new Error(`release verification failed: ${heldChunks} chunk(s) still held`);
    if (res.freeAfterReleaseBytes !== 12000 * MiB) {
      throw new Error(`release re-read wrong: ${res.freeAfterReleaseBytes} != ${12000 * MiB}`);
    }
    out(`  ram state machine: attained at ${res.chunks} chunks; released to ${Math.round(res.freeAfterReleaseBytes / MiB)} MiB free`);
  }
  // (b) reserve-abort shape with injected freemem held above the floor
  {
    let heldChunks = 0;
    const acquire = async () => {
      heldChunks += 1;
      return {
        release: async () => {
          heldChunks -= 1;
        },
      };
    };
    const freemem = () => 3500 * MiB; // external pressure holds free flat: one 1600 MiB chunk would breach the reserve
    const res = await runRamFillerStateMachine({
      targetFreeMb: 2600,
      reserveMb: 2048,
      toleranceMb: 512,
      chunkMb: 1600,
      freemem,
      acquireChunk: acquire,
    });
    if (res.outcome !== 'reserve-abort') throw new Error(`reserve-abort leg got ${res.outcome} (${res.reason})`);
    if (res.chunks !== 0) throw new Error(`reserve-abort allocated ${res.chunks} chunk(s) before aborting`);
    if (heldChunks !== 0) throw new Error('reserve-abort leaked a chunk');
    out(`  ram reserve-abort: ${res.reason}`);
  }
  // (c) refusal shape: a production target below reserve + tolerance, refused before any allocation
  {
    let allocations = 0;
    const acquire = async () => {
      allocations += 1;
      return { release: async () => {} };
    };
    let refusal = null;
    try {
      await runRamFillerStateMachine({ targetFreeMb: 2048, freemem: () => 16000 * MiB, acquireChunk: acquire });
    } catch (err) {
      refusal = err;
    }
    if (!(refusal instanceof UsageError) || !refusal.message.includes('below the reserve floor')) {
      throw new Error(`target-below-reserve refusal shape wrong: ${refusal && refusal.message}`);
    }
    if (allocations !== 0) throw new Error(`refusal path allocated ${allocations} chunk(s)`);
    out(`  ram refusal: ${refusal.message}`);
  }
  // (d) small real allocation/release smoke (64 MiB, far above any reserve)
  {
    const smoke = realAllocSmoke();
    out(`  ram smoke: 64 MiB chunk allocated + touched + released; freemem ${smoke.freeBeforeMb} -> ${smoke.freeAfterMb} MiB (re-read)`);
  }
}

async function selftestNetworkRefusal() {
  const commands = [];
  const journalWrites = [];
  const journalFile = path.join(os.tmpdir(), `offline-matrix-selftest-journal-${process.pid}.json`);
  const run = async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`);
    // netsh/net arrive as absolute %SystemRoot% paths on Windows (PRR-017).
    const base = path.basename(String(file)).replace(/\.exe$/i, '').toLowerCase();
    if (base === 'net') return { code: 1, stdout: '', stderr: 'Access is denied.' }; // non-elevated probe shape
    return {
      code: 0,
      stdout: 'Admin State    Type          Interface Name       Operational State',
      stderr: '',
    };
  };
  const writeJournalFn = (file, rows) => {
    journalWrites.push({ file, rows });
  };
  const readJournalFn = () => [];
  let refusal1 = null;
  try {
    await performNetworkToggle({
      adapter: 'Selftest Adapter',
      confirm: false,
      run,
      journalFile,
      writeJournalFn,
      readJournalFn,
      isWindows: true,
    });
  } catch (err) {
    refusal1 = err;
  }
  if (!(refusal1 instanceof UsageError) || !refusal1.message.includes('--confirm-network-toggle')) {
    throw new Error(`no-confirm refusal shape wrong: ${refusal1 && refusal1.message}`);
  }
  if (commands.length !== 0) {
    throw new Error(`no-confirm refusal touched state: ${commands.join(' | ')}`);
  }
  let refusal2 = null;
  try {
    await performNetworkToggle({
      adapter: 'Selftest Adapter',
      confirm: true,
      run,
      journalFile,
      writeJournalFn,
      readJournalFn,
      isWindows: true,
    });
  } catch (err) {
    refusal2 = err;
  }
  if (!(refusal2 instanceof UsageError) || !refusal2.message.includes('elevation')) {
    throw new Error(`no-elevation refusal shape wrong: ${refusal2 && refusal2.message}`);
  }
  const mutating = commands.filter((c) => /[\\/]netsh(\.exe)? interface set /i.test(c));
  if (mutating.length !== 0) throw new Error(`refusal path ran adapter commands: ${mutating.join(' | ')}`);
  if (journalWrites.length !== 0) throw new Error(`refusal path wrote the journal ${journalWrites.length} time(s)`);
  if (fs.existsSync(journalFile)) throw new Error(`refusal path created ${journalFile}`);
  out(
    `  network-refusal: refused without the confirm flag and without elevation; commands run: ${commands.length} (elevation probe only); journal writes: 0`,
  );
}

async function runSelftest() {
  const failures = [];
  try {
    await selftestProxyStrip();
    out(
      'selftest:proxy-strip PASS (200/3xx/4xx/5xx strip, HEAD, concurrency, scheme-relative + absolute Location rewrite, 502 upstream-refused, 504 upstream-timeout, upstream-emits-headers proof)',
    );
  } catch (err) {
    failures.push(`proxy-strip: ${err instanceof Error ? err.message : String(err)}`);
    errOut(`selftest:proxy-strip FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await selftestRamFiller();
    out(
      'selftest:ram-filler PASS (injected-freemem attainment + reserve-abort + release verification, target-below-reserve refusal, 64 MiB real allocation smoke)',
    );
  } catch (err) {
    failures.push(`ram-filler: ${err instanceof Error ? err.message : String(err)}`);
    errOut(`selftest:ram-filler FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await selftestNetworkRefusal();
    out('selftest:network-refusal PASS (refused without --confirm-network-toggle and without elevation; no adapter commands; journal untouched)');
  } catch (err) {
    failures.push(`network-refusal: ${err instanceof Error ? err.message : String(err)}`);
    errOut(`selftest:network-refusal FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (failures.length > 0) {
    errOut(`selftest failed: ${failures.join(' | ')}`);
    return EXIT_SELFTEST;
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// main + entry guard
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    errOut(err instanceof Error ? err.message : String(err));
    return EXIT_USAGE;
  }
  if (args.list) {
    printScenarioList();
    return EXIT_OK;
  }
  if (args.selftest) return runSelftest();
  if (args.recover) {
    try {
      // PRR-007: a row whose restore FAILED is a recovery failure — exit 5,
      // never a silent success (the printed line names the manual command).
      const res = await recoverFromJournal({ journalFile: journalPathFor(REPO_ROOT), run: runCommand });
      return res.failed > 0 ? EXIT_RECOVER : EXIT_OK;
    } catch (err) {
      errOut(err instanceof Error ? err.message : String(err));
      return err instanceof UsageError ? err.exitCode : EXIT_USAGE;
    }
  }
  if (args.recoverWatchdog) {
    try {
      return await runRecoverWatchdogLive(args);
    } catch (err) {
      // A corrupt/unreadable journal fails closed here too (PRR-001).
      errOut(err instanceof Error ? err.message : String(err));
      return err instanceof UsageError ? err.exitCode : EXIT_USAGE;
    }
  }
  if (args.scenario !== undefined) return runPrep(args);
  errOut('nothing to do: pass --list, --selftest, --recover, or --scenario <id> --prep');
  return EXIT_USAGE;
}

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// Entry guard: importing this module (vitest, sibling drivers) must not run
// anything; only direct execution drives the CLI. The ram-worker child mode
// blocks forever by design (it holds one chunk until killed), so it is
// dispatched before main().
if (isMain(import.meta.url)) {
  if (process.argv.includes('--ram-worker')) {
    ramWorkerEntry(process.argv.slice(process.argv.indexOf('--ram-worker') + 1));
  } else {
    main(process.argv.slice(2)).then(
      (code) => {
        if (code !== undefined) flushAndExit(code); // PRR-022: flush stdout before exiting
      },
      (err) => {
        errOut(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        flushAndExit(1);
      },
    );
  }
}
