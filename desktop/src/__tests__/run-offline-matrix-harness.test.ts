/**
 * run-offline-matrix-harness.test.ts — issue #86 (E3) hardware-free prep:
 * the offline/low-RAM validation matrix harness `bench/run_offline_matrix.mjs`.
 *
 * Pins every named leg of the reviewed plan:
 *  - CLI parse failures (unknown scenario/flag, bare value flags) exit 2;
 *  - the header-strip proxy: 200/3xx/4xx/5xx COOP/COEP/CORP strip, HEAD,
 *    concurrency, upstream-emits-headers proof, Location rewriting for the
 *    ABSOLUTE and SCHEME-RELATIVE upstream forms (proxy-origin Locations
 *    untouched), 502 upstream-refused, 504 upstream-timeout via a short
 *    injected timeout;
 *  - the RAM filler: oversize refusal, reserve abort, chunked fill + release
 *    with an injected os.freemem;
 *  - the fail-closed network toggle gate matrix via an injected command
 *    runner (refusal without the flag, refusal without elevation, happy-path
 *    journal-before-act ordering with read-back verification, read-back
 *    failure, restore failure, already-disabled, watchdog arming);
 *  - the recovery watchdog with an injected clock (lease expiry restores,
 *    journal removal exits idle, restore failure prints the manual netsh
 *    command) and the idempotent --recover;
 *  - the spawn contract of the detached recovery child (detached +
 *    stdio 'ignore' + unref, no IPC);
 *  - the persistent-vs-auto-clean scenario lifecycle matrix;
 *  - the exact S1..S10 title→id→status mapping (the frozen C4 consistency);
 *  - the capture row schema and the BENCH_MACHINE_TAG fail-closed rule;
 *  - the .ps1 wrapper's fail-closed launcher shape and the .mjs LF shebang.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  SCENARIOS,
  parseArgs,
  main,
  runPrep,
  rewriteLocation,
  createStripProxy,
  stripHopByHopHeaders,
  validateRamTarget,
  RAM_RESERVE_FLOOR_MB,
  runRamFillerStateMachine,
  performNetworkToggle,
  readAdapterState,
  recoverFromJournal,
  recoveryWatchdog,
  watchdogExitFor,
  watchdogJournalIo,
  spawnRecoveryChild,
  writeJournal,
  readJournal,
  appendJournalRow,
  mergeJournalRows,
  writeCaptureRow,
  CAPTURE_ROW_KEYS,
  CaptureError,
  runCommand,
  probeElevation,
  holdLegWithAutoClean,
  EXIT_FORCED,
  RUNCOMMAND_SIGNALLED_CODE,
} from '../../../bench/run_offline_matrix.mjs';

const MiB = 2 ** 20;

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Bounded wait for a child's exit; resolves false when the budget expires. */
function waitForExit(child: ChildProcess, budgetMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeAllListeners('exit');
      resolve(false);
    }, budgetMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Bounded fetch (the repo harness convention: every fetch carries a bound). */
function f(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

/** Normalize an absolute %SystemRoot% tool path (PRR-017) to its bare name
 * so command-sequence assertions stay readable. */
const brief = (cmd: string): string =>
  cmd.replace(/^.*[\\/]netsh(\.exe)? /i, 'netsh ').replace(/^.*[\\/]net(\.exe)? /i, 'net ');

/** Bare binary name of a (possibly absolute Windows) tool path. */
const binOf = (file: string): string =>
  path.basename(String(file)).replace(/\.exe$/i, '').toLowerCase();

const REAL_STRIP_TARGETS = [
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
] as const;

function assertStripped(response: Response, label: string): void {
  // Literal-name assertions: the probe targets are pinned by name here, NOT
  // read from the harness's own STRIP_HEADERS list - a constant mutation
  // (rename/unstrip) must fail this assertion, not silently retarget it.
  for (const header of REAL_STRIP_TARGETS) {
    expect(
      response.headers.get(header),
      `${label}: '${header}' survived the strip proxy`,
    ).toBeNull();
  }
}

const upstreamEmittedHeaders = new Map<number, Set<string>>();

interface UpstreamHandle {
  port: number;
  close(): Promise<void>;
}

/** A loopback upstream that emits all three isolation headers everywhere. */
async function startUpstream(): Promise<UpstreamHandle> {
  let port = 0;
  const iso = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const server = http.createServer((req, res) => {
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((code, headers, ...rest) => {
      if (headers && typeof headers === 'object') {
        const emitted = upstreamEmittedHeaders.get(port) ?? new Set<string>();
        for (const name of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy']) {
          if (headers[name] !== undefined) emitted.add(name);
        }
        upstreamEmittedHeaders.set(port, emitted);
      }
      return origWriteHead(code, headers, ...rest);
    }) as typeof res.writeHead;
    if (req.url === '/emit') {
      res.writeHead(200, { ...iso, 'content-type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'up');
    } else if (req.url === '/redirect-abs') {
      res.writeHead(307, { ...iso, location: `http://127.0.0.1:${port}/emit?n=1` });
      res.end();
    } else if (req.url === '/redirect-rel') {
      res.writeHead(302, { ...iso, location: `//127.0.0.1:${port}/emit?n=2` });
      res.end();
    } else if (req.url === '/missing') {
      res.writeHead(404, { ...iso, 'content-type': 'text/plain; charset=utf-8' });
      res.end('missing');
    } else if (req.url === '/boom') {
      res.writeHead(503, { ...iso, 'content-type': 'text/plain; charset=utf-8' });
      res.end('boom');
    } else if (req.url === '/hang') {
      // deliberately never responds: the proxy's upstream timeout must fire
    } else {
      res.writeHead(200, iso);
      res.end('ok');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      // F1-04: the module-level emitted-headers record is per-server state —
      // clear it on close so a reused port cannot inherit stale proof data.
      upstreamEmittedHeaders.delete(port);
    },
  };
}

/** Upstream-emits-headers proof: the fixture really emits every strip target
 * before the strip assertions may pass on their absence (dead-fixture guard). */
describe('upstream fixture emits every strip target', () => {
  it('records all three isolation headers on /emit', async () => {
    const upstream = await startUpstream();
    try {
      const res = await f(`http://127.0.0.1:${upstream.port}/emit`);
      expect(res.status).toBe(200);
      const emitted = upstreamEmittedHeaders.get(upstream.port) ?? new Set<string>();
      for (const name of REAL_STRIP_TARGETS) {
        expect(emitted.has(name), `fixture did not emit '${name}'`).toBe(true);
        // TC-11: the guard additionally reads the ACTUAL response headers —
        // the writeHead interception alone could record a header the socket
        // never carried.
        expect(res.headers.get(name), `response did not carry '${name}'`).not.toBeNull();
      }
    } finally {
      await upstream.close();
    }
  });
});

// netsh prints fixed-width columns; the fixture rows must be column-aligned
// to the real header offsets or the exact interface-name binding would read
// the wrong slice (the very defect class the collision fixture pins).
const NETSH_HEADER = 'Admin State    Type          Interface Name       Operational State';
const NETSH_SEPARATOR = '-'.repeat(77);

function netshRow(admin: string, name: string, op = 'Disconnected'): string {
  return (
    (admin + ' '.repeat(15)).slice(0, 15) + // Admin State column (0-14)
    ('Dedicated' + ' '.repeat(14)).slice(0, 14) + // Type column (15-28)
    (name + ' '.repeat(21)).slice(0, 21) + // Interface Name column (29-49)
    op
  );
}

interface NetshRunnerOpts {
  ops: string[];
  initial: 'Enabled' | 'Disabled';
  netSessionCode?: number;
  failDisable?: boolean;
  failEnable?: boolean;
  keepEnabledAfterDisable?: boolean;
  /** Runs when the disable command arrives — the seam for simulating a
   * concurrent journal writer inside the disable→verifyFail window. */
  onDisable?: () => void;
}

/** Stateful fake netsh/net runner recording every command into opts.ops.
 * Commands arrive as absolute %SystemRoot% paths on Windows (PRR-017), so
 * matching is on the bare binary name. */
function netshRunner(opts: NetshRunnerOpts) {
  let state: 'Enabled' | 'Disabled' = opts.initial;
  return async (file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    opts.ops.push(`${file} ${args.join(' ')}`);
    const bin = binOf(file);
    if (bin === 'net') {
      return { code: opts.netSessionCode ?? 1, stdout: '', stderr: 'Access is denied.' };
    }
    if (bin === 'netsh' && args[1] === 'show') {
      const admin = state === 'Enabled' ? 'Enabled' : 'Disabled';
      return {
        code: 0,
        stdout: `${NETSH_HEADER}\n${NETSH_SEPARATOR}\n${netshRow(admin, 'Test Adapter')}\n`,
        stderr: '',
      };
    }
    if (bin === 'netsh' && args[1] === 'set' && args[4] === 'disable') {
      opts.onDisable?.();
      if (opts.failDisable) return { code: 1, stdout: '', stderr: 'disable failed' };
      if (!opts.keepEnabledAfterDisable) state = 'Disabled';
      return { code: 0, stdout: '', stderr: '' };
    }
    if (bin === 'netsh' && args[1] === 'set' && args[4] === 'enable') {
      if (opts.failEnable) return { code: 1, stdout: '', stderr: 'enable failed' };
      state = 'Enabled';
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** A one-shot netsh show runner over explicit rows (collision fixtures). */
function netshShowRunner(rows: string[]) {
  return async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
    code: 0,
    stdout: `${NETSH_HEADER}\n${NETSH_SEPARATOR}\n${rows.join('\n')}\n`,
    stderr: '',
  });
}

function activeJournalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'jr-test-1',
    mode: 'disable',
    adapter: 'Test Adapter',
    prior_state: 'Enabled',
    timestamp: new Date('2026-10-30T12:00:00Z').toISOString(),
    pid: 4242,
    lease_minutes: 45,
    status: 'active',
    ...overrides,
  };
}

describe('offline-matrix harness (issue #86 prep)', () => {
  // ------------------------------------------------------------------ CLI
  it('cli-parse: unknown scenario, unknown flag, bare value flags, and missing --prep fail loud (exit 2 shape)', async () => {
    expect(() => parseArgs(['--scenario', 'S11', '--prep'])).toThrow(/unknown scenario 'S11'/);
    expect(() => parseArgs(['--scenario', 'S0', '--prep'])).toThrow(/unknown scenario 'S0'/);
    expect(() => parseArgs(['--bogus'])).toThrow('unknown argument: --bogus');
    expect(() => parseArgs(['--scenario'])).toThrow('--scenario requires a value');
    expect(() => parseArgs(['--scenario', '--prep'])).toThrow('--scenario requires a value');
    expect(() => parseArgs(['--ram-free-target-mb', 'abc', '--scenario', 'S2', '--prep'])).toThrow(
      '--ram-free-target-mb must be a positive integer',
    );
    // Q2 (implementation-review round 1): the reserve floor is refused at the
    // parse step, so a too-low --ram-reserve-mb exits 2 before any leg runs.
    expect(RAM_RESERVE_FLOOR_MB).toBe(512);
    expect(() => parseArgs(['--scenario', 'S2', '--prep', '--ram-reserve-mb', '100'])).toThrow(
      /--ram-reserve-mb must be >= 512 MiB/,
    );
    expect(() => parseArgs(['--scenario', 'S2', '--prep', '--ram-reserve-mb', '511'])).toThrow(
      /--ram-reserve-mb must be >= 512 MiB/,
    );
    expect(parseArgs(['--scenario', 'S2', '--prep', '--ram-reserve-mb', '512']).ramReserveMb).toBe(512);
    // ...and the fill-time check refuses the same shape with a named error.
    expect(() => validateRamTarget(8192, 256)).toThrow(/--ram-reserve-mb must be an integer >= 512 MiB/);
    expect(() => validateRamTarget(8192, 511)).toThrow(/--ram-reserve-mb must be an integer >= 512 MiB/);
    expect(validateRamTarget(8192, 512).reserveMb).toBe(512);
    expect(() => parseArgs(['--scenario', 'S7'])).toThrow('--scenario requires --prep');
    expect(() => parseArgs([])).toThrow(/nothing to do/);
    // main() maps the parse class onto exit code 2 without throwing.
    await expect(main(['--scenario', 'S11', '--prep'])).resolves.toBe(2);
    await expect(main(['--bogus'])).resolves.toBe(2);
    // The registry parse accepts the real ids and rejects S11 forever.
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--scenario', 'S10', '--prep']).scenario).toBe('S10');
  });

  // --------------------------------------------------------------- proxy
  it('proxy-strip: 200/4xx/5xx classes stripped, HEAD stripped, concurrency stripped, upstream-emits-headers proof', async () => {
    const upstream = await startUpstream();
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${upstream.port}` });
    try {
      // proof: the upstream really emits all three headers (direct fetch)
      const direct = await f(`http://127.0.0.1:${upstream.port}/emit`);
      for (const header of REAL_STRIP_TARGETS) {
        expect(direct.headers.get(header), `proof: upstream must emit ${header}`).not.toBeNull();
      }
      const r200 = await f(`${proxy.base}/emit`);
      expect(r200.status).toBe(200);
      assertStripped(r200, '200');
      await r200.text();
      const rHead = await f(`${proxy.base}/emit`, { method: 'HEAD' });
      assertStripped(rHead, 'HEAD');
      const r404 = await f(`${proxy.base}/missing`);
      expect(r404.status).toBe(404);
      assertStripped(r404, '404');
      await r404.text();
      const r503 = await f(`${proxy.base}/boom`);
      expect(r503.status).toBe(503);
      assertStripped(r503, '503');
      await r503.text();
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => f(`${proxy.base}/emit`)));
      for (let i = 0; i < concurrent.length; i += 1) {
        expect(concurrent[i]!.status, `concurrent-${i}`).toBe(200);
        assertStripped(concurrent[i]!, `concurrent-${i}`);
      }
      await Promise.all(concurrent.map((r) => r.text()));
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('proxy-strip: Location rewrite — absolute upstream re-anchored, scheme-relative re-anchored, proxy-origin untouched (unit + live 3xx)', async () => {
    // unit cases (deterministic, including the shapes the live upstream cannot know)
    expect(rewriteLocation('http://up.example:81/p?a=1#f', 'http://up.example:81', 'http://127.0.0.1:9')).toBe(
      'http://127.0.0.1:9/p?a=1#f',
    );
    expect(rewriteLocation('//up.example:81/p', 'http://up.example:81', 'http://127.0.0.1:9')).toBe(
      'http://127.0.0.1:9/p',
    );
    expect(rewriteLocation('/rel/path', 'http://up.example:81', 'http://127.0.0.1:9')).toBe(
      'http://127.0.0.1:9/rel/path',
    );
    expect(rewriteLocation('http://127.0.0.1:9/already-proxy', 'http://up.example:81', 'http://127.0.0.1:9')).toBe(
      'http://127.0.0.1:9/already-proxy',
    );
    expect(rewriteLocation('https://else.example/z', 'http://up.example:81', 'http://127.0.0.1:9')).toBe(
      'https://else.example/z',
    );
    // live 3xx legs
    const upstream = await startUpstream();
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${upstream.port}` });
    try {
      const abs = await f(`${proxy.base}/redirect-abs`, { redirect: 'manual' });
      expect(abs.status).toBe(307);
      assertStripped(abs, '3xx-absolute');
      expect(abs.headers.get('location')).toBe(`${proxy.base}/emit?n=1`);
      const rel = await f(`${proxy.base}/redirect-rel`, { redirect: 'manual' });
      expect(rel.status).toBe(302);
      assertStripped(rel, '3xx-scheme-relative');
      expect(rel.headers.get('location')).toBe(`${proxy.base}/emit?n=2`);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('proxy-strip: upstream unreachable → 502 upstream-refused; hanging upstream → 504 upstream-timeout (short injected timeout)', async () => {
    const refused = await createStripProxy({ upstreamBase: 'http://127.0.0.1:9' });
    try {
      const r502 = await f(`${refused.base}/emit`);
      expect(r502.status).toBe(502);
      expect(r502.headers.get('x-offline-matrix-error')).toBe('upstream-refused');
      assertStripped(r502, '502');
      await r502.text();
    } finally {
      await refused.close();
    }
    const upstream = await startUpstream();
    const slow = await createStripProxy({
      upstreamBase: `http://127.0.0.1:${upstream.port}`,
      upstreamTimeoutMs: 150,
    });
    try {
      const r504 = await f(`${slow.base}/hang`);
      expect(r504.status).toBe(504);
      expect(r504.headers.get('x-offline-matrix-error')).toBe('upstream-timeout');
      assertStripped(r504, '504');
      await r504.text();
    } finally {
      await slow.close();
      await upstream.close();
    }
  });

  // ------------------------------------------------------------ ram filler
  it('ram-filler: oversize refusal before allocation, reserve abort, chunked fill + release with injected freemem', async () => {
    // oversize refusal: a target below reserve + tolerance, refused before any allocation
    let allocated = 0;
    await expect(
      runRamFillerStateMachine({
        targetFreeMb: 2000,
        freemem: () => 16000 * MiB,
        acquireChunk: async () => {
          allocated += 1;
          return { release: async () => {} };
        },
      }),
    ).rejects.toThrow(/below the reserve floor/);
    expect(allocated).toBe(0);
    expect(() => validateRamTarget(0)).toThrow(/positive integer/);
    expect(() => validateRamTarget(100, 2048, 512)).toThrow(/below the reserve floor/);
    // chunked fill + release verification against a scripted freemem
    let held = 0;
    const releasedEvents: number[] = [];
    const res = await runRamFillerStateMachine({
      targetFreeMb: 8192,
      freemem: () => (12000 - held * 256) * MiB,
      acquireChunk: async () => {
        held += 1;
        return {
          release: async () => {
            held -= 1;
          },
        };
      },
      onEvent: (e: { type: string; freeAfterReleaseBytes?: number }) => {
        if (e.type === 'released') releasedEvents.push(e.freeAfterReleaseBytes ?? -1);
      },
    });
    expect(res.outcome).toBe('attained');
    expect(res.chunks).toBe(13);
    expect(held).toBe(0);
    expect(res.freeAfterReleaseBytes).toBe(12000 * MiB);
    expect(releasedEvents).toEqual([12000 * MiB]);
    // reserve abort: external pressure holds free flat where one chunk would breach the floor
    let held2 = 0;
    const res2 = await runRamFillerStateMachine({
      targetFreeMb: 2600,
      reserveMb: 2048,
      toleranceMb: 512,
      chunkMb: 1600,
      freemem: () => 3500 * MiB,
      acquireChunk: async () => {
        held2 += 1;
        return {
          release: async () => {
            held2 -= 1;
          },
        };
      },
    });
    expect(res2.outcome).toBe('reserve-abort');
    expect(res2.chunks).toBe(0);
    expect(held2).toBe(0);
  });

  // --------------------------------------------- Q1: fail-closed non-attained fill
  it('ram-filler: --prep is fail-closed on a non-attained fill — releases, never holds, exits 3', async () => {
    // Q1 (implementation-review round 1): a fill that cannot attain the
    // target floor must NOT enter the scenario hold on partial pressure. The
    // fill is injected as a stall-abort carrying two fake held chunks; prep
    // must release BOTH, print the named outcome+reason, and resolve 3 — the
    // hold and the capture write are never reached.
    const released: number[] = [];
    let held = false;
    const verdict = await runPrep(parseArgs(['--scenario', 'S3', '--prep', '--ram-free-target-mb', '5600']), {
      fill: async () => ({
        outcome: 'stall-abort',
        reason: 'system free did not fall across 3 consecutive chunks (stuck around 6400 MiB)',
        chunks: 2,
        handles: [
          {
            release: async () => {
              released.push(1);
              held = false;
            },
          },
          {
            release: async () => {
              released.push(2);
            },
          },
        ],
        freeAtStartBytes: 8 * MiB,
        targetFreeMb: 5600,
        reserveMb: 2048,
        toleranceMb: 512,
        chunkMb: 256,
      }),
      hold: () => {
        held = true;
        throw new Error('must not enter the hold on a non-attained fill');
      },
      writeCapture: () => {
        throw new Error('must not write a capture row on a non-attained fill');
      },
    });
    expect(verdict).toBe(3); // exit 3, per the review decision
    expect(released).toEqual([1, 2]); // every held chunk was torn down
    expect(held).toBe(false); // the hold was never entered
  });

  // ------------------------------- B1: real ram-worker spawn-hold-release pin
  it('ram-worker: holds its chunk (alive at 2s) and exits after SIGTERM', async () => {
    // Implementation-review round 1 (blocker 1): the worker's liveness
    // interval used to be unref'd, so the child exited ~immediately after
    // spawn and the RAM legs held zero pressure. This pin spawns the REAL
    // worker binary and holds it to account: alive well past spawn (the bug
    // exits within ~50ms), then released by SIGTERM.
    const harness = path.join(REPO_ROOT, 'bench', 'run_offline_matrix.mjs');
    const child = spawn(
      process.execPath,
      [harness, '--ram-worker', String(32 * MiB), String(process.pid)],
      { stdio: 'ignore' },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(
        child.exitCode,
        'worker must still be alive at 2s (the unref’d-interval defect exits immediately)',
      ).toBeNull();
      expect(child.signalCode).toBeNull();
      child.kill('SIGTERM');
      const exited = await waitForExit(child, 5_000);
      expect(exited, 'worker must exit after SIGTERM').toBe(true);
      // On POSIX the registered SIGTERM handler exits 0; on Windows
      // child.kill is a force-termination, so only the exit itself is pinned.
      if (process.platform !== 'win32') expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('ram-worker: self-exits when its parent is gone (parent-liveness pin)', async () => {
    // Spawn a sacrificial process, wait for its death, then spawn the real
    // worker pointed at that dead pid: the 5s liveness tick must self-exit
    // the worker (exit 0) within the bounded wait.
    const harness = path.join(REPO_ROOT, 'bench', 'run_offline_matrix.mjs');
    const sacrificial = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => sacrificial.on('exit', () => resolve()));
    const deadPid = sacrificial.pid;
    expect(deadPid).toBeTruthy();
    const worker = spawn(
      process.execPath,
      [harness, '--ram-worker', String(8 * MiB), String(deadPid)],
      { stdio: 'ignore' },
    );
    const exited = await waitForExit(worker, 9_000);
    if (!exited) worker.kill('SIGKILL');
    expect(exited, 'worker must self-exit within the liveness interval after its parent dies').toBe(true);
    expect(worker.exitCode).toBe(0); // the parent-gone self-exit path exits cleanly
  });

  // -------------------------------------------------------- network gates
  it('network-gate: refuses without the flag and without elevation; zero adapter commands; journal untouched', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-refusal-'), 'journal.json');
    const ops: string[] = [];
    const journalWrites: unknown[][] = [];
    const run = async (file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      ops.push(`${file} ${args.join(' ')}`);
      if (binOf(file) === 'net') return { code: 1, stdout: '', stderr: 'Access is denied.' };
      return { code: 0, stdout: 'Enabled        Dedicated     Test Adapter', stderr: '' };
    };
    const common = {
      adapter: 'Test Adapter',
      run,
      journalFile,
      isWindows: true,
      writeJournalFn: (_file: string, rows: unknown[]) => {
        journalWrites.push(rows);
      },
      readJournalFn: () => [],
      spawnRecovery: false,
    } as const;
    await expect(performNetworkToggle({ ...common, confirm: false })).rejects.toThrow(/--confirm-network-toggle/);
    expect(ops).toHaveLength(0); // the confirm gate fires before even the elevation probe
    await expect(performNetworkToggle({ ...common, confirm: true })).rejects.toThrow(/elevation/);
    expect(ops.map(brief)).toEqual(['net session']); // probe only, never netsh
    // PRR-017: the probe runs the absolute %SystemRoot% path on Windows
    expect(ops[0]!.toLowerCase()).toContain('system32');
    expect(ops[0]!.toLowerCase()).toContain('net.exe');
    expect(journalWrites).toHaveLength(0);
    expect(fs.existsSync(journalFile)).toBe(false);
    // explicit elevated:false injection refuses with no commands at all
    await expect(performNetworkToggle({ ...common, confirm: true, elevated: false })).rejects.toThrow(/elevation/);
    expect(ops.map(brief)).toEqual(['net session']);
    // missing adapter names the flag (never a guessed adapter)
    await expect(
      performNetworkToggle({ ...common, adapter: '', confirm: true, elevated: true }),
    ).rejects.toThrow(/--adapter/);
  });

  it('network-gate: happy path journals BEFORE the act, disables, verifies read-back, arms the watchdog', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-happy-'), 'journal.json');
    const ops: string[] = [];
    const run = netshRunner({ initial: 'Enabled', ops });
    const recoveries: Array<{ leaseMinutes?: number }> = [];
    const res = await performNetworkToggle({
      adapter: 'Test Adapter',
      confirm: true,
      elevated: true,
      run,
      journalFile,
      isWindows: true,
      writeJournalFn: (file: string, rows: unknown[]) => {
        ops.push('journal-write');
        writeJournal(file, rows as Array<Record<string, unknown>>);
      },
      readJournalFn: () => [],
      spawnRecovery: (o: { leaseMinutes?: number }) => {
        recoveries.push(o);
      },
    });
    expect(res.status).toBe('disabled');
    const showIdx = ops.findIndex((c) => c.includes('show interface'));
    const journalIdx = ops.indexOf('journal-write');
    const disableIdx = ops.findIndex((c) => c.includes('set') && c.includes(' disable'));
    expect(showIdx).toBeGreaterThan(-1);
    expect(journalIdx).toBeGreaterThan(-1);
    expect(disableIdx).toBeGreaterThan(-1);
    expect(showIdx).toBeLessThan(journalIdx); // prior state is read first
    expect(journalIdx).toBeLessThan(disableIdx); // JOURNAL-BEFORE-ACT
    expect(brief(ops[disableIdx]!)).toBe('netsh interface set interface Test Adapter disable');
    // PRR-017: netsh runs via its absolute %SystemRoot%\System32 path
    expect(ops[disableIdx]!.toLowerCase()).toContain('system32');
    expect(ops[disableIdx]!.toLowerCase()).toContain('netsh.exe');
    const rows = readJournal(journalFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mode: 'disable',
      adapter: 'Test Adapter',
      prior_state: 'Enabled',
      status: 'active',
    });
    expect(recoveries).toHaveLength(1); // detached watchdog armed
  });

  it('network-gate: readAdapterState binds the interface-name column exactly (Ethernet vs Ethernet 2, both orders)', async () => {
    // Implementation-review round 1 (blocker 2): the old substring binding
    // returned the wrong row's state when 'Ethernet 2' preceded 'Ethernet'
    // in the netsh table. The exact column binding must return each adapter's
    // OWN state in either row order, and refuse a name that is only a prefix
    // of another adapter's name.
    const orders = [
      [netshRow('Enabled', 'Ethernet 2'), netshRow('Disabled', 'Ethernet')],
      [netshRow('Disabled', 'Ethernet'), netshRow('Enabled', 'Ethernet 2')],
    ];
    for (const rows of orders) {
      const run = netshShowRunner(rows);
      await expect(readAdapterState('Ethernet', run, true)).resolves.toBe('Disabled');
      await expect(readAdapterState('Ethernet 2', run, true)).resolves.toBe('Enabled');
    }
    // Only the longer name exists: a query for the shorter (prefix) name is a
    // named refusal, never the other row's state.
    const runPrefixOnly = netshShowRunner([netshRow('Enabled', 'Ethernet 2')]);
    await expect(readAdapterState('Ethernet', runPrefixOnly, true)).rejects.toThrow(
      /adapter 'Ethernet' not found in 'netsh interface show interface' output/,
    );
    // No header to bind by: named refusal rather than guessing.
    const runNoHeader = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
      code: 0,
      stdout: 'Enabled        Dedicated     Ethernet\n',
      stderr: '',
    });
    await expect(readAdapterState('Ethernet', runNoHeader, true)).rejects.toThrow(/no 'Interface Name' column header/);
  });

  it('network-gate: read-back failure after disable restores (row recovered) or marks restore-failed with the manual command', async () => {
    // variant A: read-back shows still Enabled; the restore attempt succeeds
    const dirA = tmpDir('offline-matrix-readback-a-');
    const journalA = path.join(dirA, 'journal.json');
    const opsA: string[] = [];
    const runA = netshRunner({ initial: 'Enabled', keepEnabledAfterDisable: true, ops: opsA });
    let errA: Error | null = null;
    try {
      await performNetworkToggle({
        adapter: 'Test Adapter',
        confirm: true,
        elevated: true,
        run: runA,
        journalFile: journalA,
        isWindows: true,
        writeJournalFn: (file: string, rows: unknown[]) => writeJournal(file, rows as Array<Record<string, unknown>>),
        readJournalFn: () => [],
        spawnRecovery: false,
      });
    } catch (e) {
      errA = e as Error;
    }
    expect(errA).not.toBeNull();
    expect(String(errA!.message)).toMatch(/read-back verification failed/);
    expect(readJournal(journalA)[0]).toMatchObject({ status: 'recovered' });
    // variant B: the restore fails too — the row is restore-failed and the
    // exact manual netsh command is printed in the error
    const dirB = tmpDir('offline-matrix-readback-b-');
    const journalB = path.join(dirB, 'journal.json');
    const opsB: string[] = [];
    const runB = netshRunner({ initial: 'Enabled', keepEnabledAfterDisable: true, failEnable: true, ops: opsB });
    let errB: Error | null = null;
    try {
      await performNetworkToggle({
        adapter: 'Test Adapter',
        confirm: true,
        elevated: true,
        run: runB,
        journalFile: journalB,
        isWindows: true,
        writeJournalFn: (file: string, rows: unknown[]) => writeJournal(file, rows as Array<Record<string, unknown>>),
        readJournalFn: () => [],
        spawnRecovery: false,
      });
    } catch (e) {
      errB = e as Error;
    }
    expect(errB).not.toBeNull();
    expect(String(errB!.message)).toContain('netsh interface set interface "Test Adapter" enable');
    expect(readJournal(journalB)[0]).toMatchObject({ status: 'restore-failed' });
  });

  it('network-gate: an already-disabled adapter takes no mutating action and journals no active row', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-already-'), 'journal.json');
    const ops: string[] = [];
    const run = netshRunner({ initial: 'Disabled', ops });
    const res = await performNetworkToggle({
      adapter: 'Test Adapter',
      confirm: true,
      elevated: true,
      run,
      journalFile,
      isWindows: true,
      writeJournalFn: (file: string, rows: unknown[]) => writeJournal(file, rows as Array<Record<string, unknown>>),
      readJournalFn: () => [],
      spawnRecovery: false,
    });
    expect(res.status).toBe('already-disabled');
    expect(ops.some((c) => c.includes('set interface'))).toBe(false); // no mutating call
    expect(readJournal(journalFile)).toHaveLength(0); // no active recovery row
  });

  // -------------------------------------------------------------- recover
  it('recover: restores + rewrites recovered, is idempotent on repeat, and a restore failure prints the manual command', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-recover-'), 'journal.json');
    writeJournal(journalFile, [activeJournalRow()]);
    const ops: string[] = [];
    const run = netshRunner({ initial: 'Disabled', ops });
    const prints: string[] = [];
    const first = await recoverFromJournal({
      journalFile,
      run,
      isWindows: true,
      print: (m: string) => prints.push(m),
    });
    expect(first.restored).toBe(1);
    expect(readJournal(journalFile)[0]).toMatchObject({ status: 'recovered' });
    const opsBeforeRepeat = ops.length;
    const second = await recoverFromJournal({
      journalFile,
      run,
      isWindows: true,
      print: (m: string) => prints.push(m),
    });
    expect(second.restored).toBe(0);
    expect(ops.length).toBe(opsBeforeRepeat); // idempotent: no further commands
    // restore failure: enable fails, the exact manual command is printed
    const journalFile2 = path.join(tmpDir('offline-matrix-recover-fail-'), 'journal.json');
    writeJournal(journalFile2, [activeJournalRow()]);
    const ops2: string[] = [];
    const run2 = netshRunner({ initial: 'Disabled', failEnable: true, ops: ops2 });
    const prints2: string[] = [];
    const third = await recoverFromJournal({
      journalFile: journalFile2,
      run: run2,
      isWindows: true,
      print: (m: string) => prints2.push(m),
    });
    expect(third.failed).toBe(1);
    expect(prints2.some((m) => m.includes('netsh interface set interface "Test Adapter" enable'))).toBe(true);
    expect(readJournal(journalFile2)[0]).toMatchObject({ status: 'restore-failed' });
  });

  it('recover-watchdog: lease expiry restores (injected clock), journal removal exits idle, restore failure prints the manual command', async () => {
    const base = Date.parse('2026-10-30T12:00:00Z');
    // Implementation-review round 1 (blocker 4): readJournalState must return
    // a FRESH deep copy every call. Returning the live aliased array let the
    // watchdog's in-place mutations show up through the alias, so the
    // status assertions stayed green even if writeJournalState never ran.
    // Every sub-case below counts writes so the rewrite is load-bearing.
    const deepCopy = (rows: Array<Record<string, unknown>>) =>
      JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;
    // 1) already past lease: restores without sleeping, and the journal
    //    rewrite is what persists the recovery (writes: exactly one)
    let state: Array<Record<string, unknown>> = [activeJournalRow()];
    let writes = 0;
    const restores: string[] = [];
    const verdict = await recoveryWatchdog({
      readJournalState: () => deepCopy(state),
      writeJournalState: (rows: Array<Record<string, unknown>>) => {
        writes += 1;
        state = deepCopy(rows);
      },
      sleep: async () => {
        throw new Error('must not sleep when the lease is already expired');
      },
      now: () => base + 46 * 60_000,
      attemptRestore: async (row: Record<string, unknown>) => {
        restores.push(String(row.adapter));
        return { restored: true };
      },
      print: () => {},
    });
    expect(verdict).toBe('restored');
    expect(restores).toEqual(['Test Adapter']);
    expect(writes).toBeGreaterThanOrEqual(1); // the pass rewrote the journal
    expect(state[0]).toMatchObject({ status: 'recovered' }); // only reachable via the write
    // 2) not yet due: sleeps (clock advances inside sleep), then restores
    let state2: Array<Record<string, unknown>> = [activeJournalRow()];
    let writes2 = 0;
    let clock = base + 10 * 60_000;
    const sleeps: number[] = [];
    const verdict2 = await recoveryWatchdog({
      readJournalState: () => deepCopy(state2),
      writeJournalState: (rows: Array<Record<string, unknown>>) => {
        writes2 += 1;
        state2 = deepCopy(rows);
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      attemptRestore: async () => ({ restored: true }),
      print: () => {},
      pollMs: 60_000,
    });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(writes2).toBeGreaterThanOrEqual(1);
    expect(state2[0]).toMatchObject({ status: 'recovered' });
    expect(verdict2).toBe('restored');
    // 3) journal removed between passes (operator ran --recover): the fresh
    //    deep-copy read observes the removal and the watchdog exits idle
    //    WITHOUT restoring or writing. The clock sits BEFORE the lease so the
    //    first pass only sleeps; the removal then lands on the second read.
    let reads = 0;
    let writes3 = 0;
    const verdict3 = await recoveryWatchdog({
      readJournalState: () => {
        reads += 1;
        return reads === 1 ? deepCopy([activeJournalRow()]) : [];
      },
      writeJournalState: () => {
        writes3 += 1;
      },
      sleep: async () => {},
      now: () => base,
      attemptRestore: async () => {
        throw new Error('must not restore after journal removal');
      },
      print: () => {},
      pollMs: 60_000,
    });
    expect(verdict3).toBe('idle');
    expect(reads).toBeGreaterThanOrEqual(2); // the removal was observed on a later pass
    expect(writes3).toBe(0); // nothing rewritten once the journal is gone
    // 3b) journal gone from the very first read: idle immediately
    const verdict3b = await recoveryWatchdog({
      readJournalState: () => [],
      writeJournalState: () => {
        throw new Error('must not write when the journal is gone');
      },
      sleep: async () => {},
      now: () => base,
      attemptRestore: async () => {
        throw new Error('must not restore when the journal is gone');
      },
      print: () => {},
    });
    expect(verdict3b).toBe('idle');
    // 4) restore keeps failing: attempts cap at the bound, each pass rewrites
    //    the row, and the manual command is printed loudly
    let state4: Array<Record<string, unknown>> = [activeJournalRow()];
    let writes4 = 0;
    let clock4 = base + 46 * 60_000;
    let attempts = 0;
    const prints4: string[] = [];
    const verdict4 = await recoveryWatchdog({
      readJournalState: () => deepCopy(state4),
      writeJournalState: (rows: Array<Record<string, unknown>>) => {
        writes4 += 1;
        state4 = deepCopy(rows);
      },
      sleep: async (ms: number) => {
        clock4 += ms;
      },
      now: () => clock4,
      attemptRestore: async () => {
        attempts += 1;
        return { restored: false, reason: 'netsh enable exited 1' };
      },
      print: (m: string) => prints4.push(m),
      pollMs: 60_000,
    });
    expect(verdict4).toBe('restore-failed'); // capped: PRR-022 — a failure verdict, never a quiet idle
    expect(watchdogExitFor(verdict4)).toBe(5); // and it maps to the nonzero recovery-failure exit
    expect(attempts).toBe(3);
    expect(writes4).toBeGreaterThanOrEqual(3); // one rewrite per failed attempt
    expect(state4[0]).toMatchObject({ status: 'restore-failed', restore_attempts: 3 });
    expect(prints4.some((m) => m.includes('netsh interface set interface "Test Adapter" enable'))).toBe(true);
    // PRR-022 verdict→exit mapping: only idle/restored exit 0
    expect(watchdogExitFor('idle')).toBe(0);
    expect(watchdogExitFor('restored')).toBe(0);
    expect(watchdogExitFor('max-loops')).toBe(5);
    expect(watchdogExitFor('restore-failed')).toBe(5);
  });

  // -------------------------------------------------------- spawn contract
  it('spawn-contract: the recovery child is detached, stdio-ignore, unref’d, with no IPC channel', () => {
    const spawns: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const children: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const fakeSpawn = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      spawns.push({ file, args, options });
      const child = { unref: vi.fn(), kill: vi.fn() };
      children.push(child);
      return child;
    });
    spawnRecoveryChild({
      nodeBin: 'node-bin',
      scriptPath: 'harness.mjs',
      args: ['--recover-lease-min', '45'],
      spawnFn: fakeSpawn as unknown as typeof import('node:child_process').spawn,
    });
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const call = spawns[0]!;
    expect(call.file).toBe('node-bin');
    expect(call.args[0]).toBe('harness.mjs');
    expect(call.args[1]).toBe('--recover-watchdog');
    expect(call.args).toContain('--recover-lease-min');
    expect(call.options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(JSON.stringify(call.options)).not.toContain('ipc');
    expect(children[0]!.unref).toHaveBeenCalledTimes(1);
    // source pin: the shipped spawn options are the pinned literals
    const source = fs.readFileSync(path.join(REPO_ROOT, 'bench', 'run_offline_matrix.mjs'), 'utf8');
    expect(source).toContain('detached: true');
    expect(source).toContain("stdio: 'ignore'");
    expect(source).toMatch(/child\.unref\(\)/);
  });

  // ------------------------------------------------------ registry mapping
  it('registry: exact S1..S10 title→id→status mapping and the persistent-vs-auto-clean lifecycle matrix', () => {
    expect(
      SCENARIOS.map((s: { id: string; title: string; blocked: string }) => [s.id, s.title, s.blocked]),
    ).toEqual([
      ['S1', 'Cold install, full network disconnect', 'BLOCKED: reference laptop'],
      ['S2', '16 GB, ~9 GB free', 'BLOCKED: reference laptop'],
      ['S3', '16 GB, <6 GB free', 'BLOCKED: reference laptop'],
      ['S4', 'Cold-start timing', 'BLOCKED: reference laptop'],
      ['S5', 'Thread utilization', 'BLOCKED: reference laptop'],
      ['S6', 'Reranker on clean install', 'BLOCKED: reference laptop'],
      ['S7', 'Cross-origin isolation stripped', 'BLOCKED: reference laptop'],
      ['S8', 'GPU acceleration default', 'BLOCKED: reference laptop'],
      ['S9', 'Ingestion under low RAM', 'BLOCKED: reference laptop'],
      ['S10', 'Full offline restart persistence', 'BLOCKED: reference laptop'],
    ]);
    // lifecycle matrix: only the network scenarios are persistent; every RAM
    // / proxy scenario is auto-clean (harness tears the leg down on exit)
    const persistent = SCENARIOS.filter((s: { lifecycle: string }) => s.lifecycle === 'persistent').map(
      (s: { id: string }) => s.id,
    );
    expect(persistent).toEqual(['S1', 'S10']);
    const autoClean = SCENARIOS.filter((s: { lifecycle: string }) => s.lifecycle === 'auto-clean').map(
      (s: { id: string }) => s.id,
    );
    expect(autoClean).toEqual(['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
    expect(
      SCENARIOS.filter((s: { legs: string[] }) => s.legs.includes('ram-filler')).map((s: { id: string }) => s.id),
    ).toEqual(['S2', 'S3', 'S9']);
    expect(
      SCENARIOS.filter((s: { legs: string[] }) => s.legs.includes('header-strip-proxy')).map((s: { id: string }) => s.id),
    ).toEqual(['S7']);
    expect(
      SCENARIOS.filter((s: { legs: string[] }) => s.legs.includes('network-toggle')).map((s: { id: string }) => s.id),
    ).toEqual(['S1', 'S10']);
  });

  // ---------------------------------------------------------------- capture
  it('capture: colon-free filename, exact schema keys, PENDING outcome default, machine-tag fail-closed', () => {
    const dir = tmpDir('offline-matrix-capture-');
    const { file, row } = writeCaptureRow({
      scenarioId: 'S7',
      machineTag: 'celltest',
      measured: 'proxy up',
      automatedLegs: 'header-strip-proxy:up',
      notes: 'unit',
      dir,
      now: () => new Date('2026-10-30T21:30:00.123Z'),
    });
    const name = path.basename(file);
    expect(name).toBe('S7-celltest-20261030T213000Z.json');
    expect(name).not.toContain(':');
    expect(Object.keys(row)).toEqual(CAPTURE_ROW_KEYS);
    expect(row.surface).toBe('offline-matrix');
    expect(row.scenario_id).toBe('S7');
    expect(row.scenario).toBe('Cross-origin isolation stripped');
    expect(row.outcome).toBe('PENDING'); // the harness never records the proof verdict
    expect(row.tuple_ref).toBe('{{TUPLE}}');
    expect(row.blocked_marker).toBe('BLOCKED: reference laptop');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(CAPTURE_ROW_KEYS);
    // fail-closed on the machine-tag discipline (exit-4 shape)
    const savedTag = process.env.BENCH_MACHINE_TAG;
    delete process.env.BENCH_MACHINE_TAG;
    try {
      let refused: unknown = null;
      try {
        writeCaptureRow({ scenarioId: 'S1', dir });
      } catch (e) {
        refused = e;
      }
      expect(refused).toBeInstanceOf(CaptureError);
      expect(String((refused as Error).message)).toMatch(/BENCH_MACHINE_TAG/);
      expect(fs.readdirSync(dir).length).toBe(1); // the refusal wrote nothing
    } finally {
      if (savedTag !== undefined) process.env.BENCH_MACHINE_TAG = savedTag;
    }
  });

  // ---------------------------------------------------------------- wrapper
  it('wrapper: run_offline_matrix.ps1 is a fail-closed launcher and the .mjs keeps an LF shebang', () => {
    const mjs = fs.readFileSync(path.join(REPO_ROOT, 'bench', 'run_offline_matrix.mjs'));
    const mjsText = mjs.toString('utf8');
    expect(mjsText.split('\n')[0]).toBe('#!/usr/bin/env node');
    expect(mjs.includes('\r')).toBe(false); // the vitest CRLF-shebang trap
    const ps1 = fs.readFileSync(path.join(REPO_ROOT, 'bench', 'run_offline_matrix.ps1'), 'utf8');
    expect(ps1).toContain('Get-Command node'); // node lookup on PATH
    expect(ps1).toMatch(/node was not found on PATH/); // named no-node message
    // PRR-024: the exit-2 pin is ANCHORED to real statement lines, so it can
    // never be satisfied by the header comment mentioning "exit 2".
    expect(ps1).toMatch(/^\s*exit 2$/m); // fail-closed without node / without an exit code
    expect(ps1).not.toMatch(/^\s*#\s*.*exit 2$/m);
    expect(ps1).toContain('$PSScriptRoot'); // harness resolved next to the launcher
    expect(ps1).toContain('run_offline_matrix.mjs');
    expect(ps1).toContain('@args'); // verbatim argument forwarding
    expect(ps1).toContain('$LASTEXITCODE'); // node's exit code forwarded (0/2/3/4/5)
    expect(ps1).toContain('-CommandType Application'); // PRR-016: resolve the node APPLICATION, not an alias/function
    expect(ps1).not.toContain("$ErrorActionPreference = 'Stop'"); // PRR-016: EAP stays at the PS default
    expect(ps1).toMatch(/null -ne \$LASTEXITCODE/); // PRR-016: a null exit code exits 2, never 0
    // import-safety source pin: the entry guard pattern of the sibling drivers
    expect(mjsText).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
  });
});

// ---------------------------------------------------------------------------
// PR #262 feedback round: hardening pins (journal robustness, merge-on-write,
// the guarded read-back, signal mapping, proxy hardening, capture integrity,
// and the injectable teardown->capture->exit seam).
// ---------------------------------------------------------------------------
describe('offline-matrix harness review-round hardening (PR #262)', () => {
  function fakeChild(): any {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    return child;
  }

  /** A raw http.request round trip (request-target / hop-by-hop legs undici hides). */
  function rawReq(opts: http.RequestOptions): Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** An upstream that streams a chunk every intervalMs forever (trickle). */
  function startTrickleUpstream(intervalMs = 100): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.write('chunk0\n');
      let i = 1;
      const iv = setInterval(() => {
        res.write(`chunk${i++}\n`);
      }, intervalMs);
      res.on('close', () => clearInterval(iv));
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          port,
          close: async () => {
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
          },
        });
      });
    });
  }

  /** Spawn a driver child that imports the REAL harness module and drives the
   * real hold/teardown path in a fresh process (SIGINT via process.emit —
   * listener-level, so the leg is portable to Windows runners). */
  function holdDriver(holdBody: string, extra: string): ChildProcess {
    const harnessUrl = pathToFileURL(path.join(REPO_ROOT, 'bench', 'run_offline_matrix.mjs')).href;
    const script = [
      `const m = await import(${JSON.stringify(harnessUrl)});`,
      holdBody.replaceAll('__HOLD__', 'm.holdLegWithAutoClean').replaceAll('__SCENARIOS__', 'm.SCENARIOS'),
      extra,
    ].join('\n');
    return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // ------------------------------------------------ journal fail-closed (PRR-001)
  it('journal: ENOENT reads as [], corrupt/unreadable journals fail closed with a named UsageError', () => {
    const dir = tmpDir('offline-matrix-journal-');
    expect(readJournal(path.join(dir, 'absent.json'))).toEqual([]);
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json', 'utf8');
    let err: any = null;
    try {
      readJournal(corrupt);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.name).toBe('UsageError');
    expect(err.exitCode).toBe(2);
    expect(String(err.message)).toMatch(/corrupt/);
    expect(String(err.message)).toMatch(/untrusted journal/);
    const notArray = path.join(dir, 'not-array.json');
    fs.writeFileSync(notArray, '{"rows":1}', 'utf8');
    expect(() => readJournal(notArray)).toThrow(/corrupt/);
  });

  it('network-gate: the toggle REFUSES when the journal is unreadable — journal-before-act cannot be trusted on a corrupt file', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-corrupt-journal-'), 'journal.json');
    fs.writeFileSync(journalFile, 'definitely not json', 'utf8');
    const ops: string[] = [];
    const run = netshRunner({ initial: 'Enabled', ops });
    let refused: any = null;
    try {
      await performNetworkToggle({
        adapter: 'Test Adapter',
        confirm: true,
        elevated: true,
        run,
        journalFile,
        isWindows: true,
        readJournalFn: readJournal, // the REAL fail-closed reader
        writeJournalFn: (file: string, rows: unknown[]) => writeJournal(file, rows as Array<Record<string, unknown>>),
        spawnRecovery: false,
      });
    } catch (e) {
      refused = e;
    }
    expect(refused?.name).toBe('UsageError');
    expect(String(refused?.message)).toMatch(/corrupt/);
    // gates passed, prior state was read — but NO disable and NO journal write
    expect(ops.some((c) => brief(c).startsWith('netsh interface set interface'))).toBe(false);
    expect(fs.readFileSync(journalFile, 'utf8')).toBe('definitely not json');
  });

  // -------------------------------------------------- merge-on-write (PRR-002)
  it('journal merge-on-write: appendJournalRow adds by id and replaces its own id; mergeJournalRows preserves foreign rows', () => {
    const journalFile = path.join(tmpDir('offline-matrix-merge-unit-'), 'journal.json');
    const rowA = activeJournalRow({ id: 'jr-a' });
    const rowB = activeJournalRow({ id: 'jr-b' });
    appendJournalRow(journalFile, rowA);
    appendJournalRow(journalFile, rowB);
    expect(readJournal(journalFile).map((r: any) => r.id)).toEqual(['jr-a', 'jr-b']);
    const rowB2 = { ...rowB, status: 'recovered' };
    appendJournalRow(journalFile, rowB2); // same id → replaced, not duplicated
    const rows = readJournal(journalFile);
    expect(rows.map((r: any) => r.id)).toEqual(['jr-a', 'jr-b']);
    expect(rows[1]).toMatchObject({ status: 'recovered' });
    // a foreign row appended AFTER the reader captured its snapshot survives a merge write
    const foreign = activeJournalRow({ id: 'jr-foreign' });
    writeJournal(journalFile, [...readJournal(journalFile), foreign]);
    mergeJournalRows(journalFile, [{ ...rowA, status: 'recovered' }]);
    const after = readJournal(journalFile);
    expect(after.map((r: any) => r.id)).toEqual(['jr-a', 'jr-b', 'jr-foreign']);
    expect(after[0]).toMatchObject({ status: 'recovered' });
  });

  it('network-gate: a concurrent journal row appended mid-disable survives the verifyFail rewrite', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-merge-verifyfail-'), 'journal.json');
    const ops: string[] = [];
    const foreign = activeJournalRow({ id: 'jr-foreign', adapter: 'Other Adapter' });
    const run = netshRunner({
      initial: 'Enabled',
      keepEnabledAfterDisable: true, // forces the verifyFail path after the disable
      ops,
      onDisable: () => {
        // a concurrent writer lands a second active row inside the disable-to-rewrite window
        writeJournal(journalFile, [...readJournal(journalFile), foreign]);
      },
    });
    let err: any = null;
    try {
      await performNetworkToggle({
        adapter: 'Test Adapter',
        confirm: true,
        elevated: true,
        run,
        journalFile,
        isWindows: true,
        readJournalFn: readJournal, // REAL journal IO: the merge must re-read
        writeJournalFn: writeJournal,
        spawnRecovery: false,
      });
    } catch (e) {
      err = e;
    }
    expect(String(err?.message)).toMatch(/read-back verification failed/);
    const rows = readJournal(journalFile);
    expect(rows.some((r: any) => r.id === 'jr-foreign')).toBe(true); // NOT dropped
    expect(rows.some((r: any) => r.status === 'recovered' && r.restore_reason)).toBe(true);
  });

  it('recover: a row appended by a concurrent writer while --recover runs is not dropped', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-merge-recover-'), 'journal.json');
    writeJournal(journalFile, [activeJournalRow()]);
    const foreign = activeJournalRow({ id: 'jr-foreign-2', adapter: 'Other Adapter' });
    const run = async (file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const bin = binOf(file);
      if (bin === 'netsh' && args[1] === 'set' && args[4] === 'enable') {
        // the concurrent append lands while the restore command is in flight
        writeJournal(journalFile, [...readJournal(journalFile), foreign]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (bin === 'netsh' && args[1] === 'show') {
        return {
          code: 0,
          stdout: `${NETSH_HEADER}\n${NETSH_SEPARATOR}\n${netshRow('Enabled', 'Test Adapter')}\n`,
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await recoverFromJournal({ journalFile, run, isWindows: true, print: () => {} });
    expect(res.restored).toBe(1);
    const rows = readJournal(journalFile);
    expect(rows.some((r: any) => r.id === 'jr-foreign-2')).toBe(true); // NOT dropped by the rewrite
    expect(rows.some((r: any) => r.status === 'recovered')).toBe(true);
  });

  it('watchdog journal io: the LIVE writeJournalState merges into a fresh read (no dropped concurrent row)', () => {
    const journalFile = path.join(tmpDir('offline-matrix-merge-watchdog-'), 'journal.json');
    writeJournal(journalFile, [activeJournalRow()]);
    const io = watchdogJournalIo(journalFile);
    const rows = io.readJournalState();
    // a concurrent parent append lands after the watchdog's read, before its rewrite
    writeJournal(journalFile, [...readJournal(journalFile), activeJournalRow({ id: 'jr-foreign-3', adapter: 'Other Adapter' })]);
    (rows[0] as Record<string, unknown>).status = 'recovered';
    io.writeJournalState(rows);
    const after = readJournal(journalFile);
    expect(after.some((r: any) => r.id === 'jr-foreign-3')).toBe(true);
    expect(after.some((r: any) => r.status === 'recovered')).toBe(true);
  });

  // --------------------------------------------- guarded read-back (PRR-008)
  it('network-gate: a read-back that THROWS (netsh show failure) enters the restore path, not a bare escape', async () => {
    const journalFile = path.join(tmpDir('offline-matrix-readback-throw-'), 'journal.json');
    const ops: string[] = [];
    let state: 'Enabled' | 'Disabled' = 'Enabled';
    let showCalls = 0;
    const run = async (file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      ops.push(`${file} ${args.join(' ')}`);
      const bin = binOf(file);
      if (bin === 'netsh' && args[1] === 'show') {
        showCalls += 1;
        if (showCalls === 2) return { code: 1, stdout: '', stderr: 'show failed mid-verify' }; // the post-disable read-back explodes
        return {
          code: 0,
          stdout: `${NETSH_HEADER}\n${NETSH_SEPARATOR}\n${netshRow(state, 'Test Adapter')}\n`,
          stderr: '',
        };
      }
      if (bin === 'netsh' && args[1] === 'set' && args[4] === 'disable') {
        state = 'Disabled';
        return { code: 0, stdout: '', stderr: '' };
      }
      if (bin === 'netsh' && args[1] === 'set' && args[4] === 'enable') {
        state = 'Enabled';
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    let err: any = null;
    try {
      await performNetworkToggle({
        adapter: 'Test Adapter',
        confirm: true,
        elevated: true,
        run,
        journalFile,
        isWindows: true,
        writeJournalFn: (file: string, rows: unknown[]) => writeJournal(file, rows as Array<Record<string, unknown>>),
        readJournalFn: () => [],
        spawnRecovery: false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/read-back verification could not run after disable/);
    // the adapter was RESTORED (enable ran + verified) and the journal row records it
    expect(ops.some((c) => brief(c) === 'netsh interface set interface Test Adapter enable')).toBe(true);
    expect(readJournal(journalFile)[0]).toMatchObject({ status: 'recovered' });
  });

  // ---------------------------- signalled close mapping (PRR-009) + timeout-await (PRR-022)
  it('runCommand: signalled close maps to synthetic 125 + signalCode; a timeout awaits the killed child exit; probes fail closed', async () => {
    let child1: any = null;
    const res = await runCommand('netsh', ['probe'], {
      spawnFn: (() => {
        child1 = fakeChild();
        queueMicrotask(() => child1.emit('close', null, 'SIGTERM'));
        return child1;
      }) as never,
    });
    expect(res.code).toBe(RUNCOMMAND_SIGNALLED_CODE);
    expect(res.code).toBe(125);
    expect(res.signalCode).toBe('SIGTERM');
    // a normal close keeps its real code and a null signal
    let child2: any = null;
    const res2 = await runCommand('netsh', ['ok'], {
      spawnFn: (() => {
        child2 = fakeChild();
        queueMicrotask(() => child2.emit('close', 0, null));
        return child2;
      }) as never,
    });
    expect(res2.code).toBe(0);
    expect(res2.signalCode).toBeNull();
    // timeout: kill fires, and the resolution WAITS for the child's actual exit
    let child3: any = null;
    let closed = false;
    const res3 = await runCommand('netsh', ['slow'], {
      timeoutMs: 40,
      spawnFn: (() => {
        child3 = fakeChild();
        child3.kill = () => {
          setTimeout(() => {
            closed = true;
            child3.emit('close', null, 'SIGKILL');
          }, 60);
        };
        return child3;
      }) as never,
    });
    expect(res3.code).toBe(124);
    expect(closed).toBe(true); // resolve happened AFTER the killed child exited
    // a killed elevation probe reads NOT elevated → the gate fails closed
    await expect(
      probeElevation({ runCommand: async () => ({ code: 125, signalCode: 'SIGTERM', stdout: '', stderr: 'killed' }), isWindows: true }),
    ).resolves.toMatchObject({ elevated: false });
    const ops: string[] = [];
    const signalledRun = async (file: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      ops.push(file);
      if (binOf(file) === 'net') return { code: 125, signalCode: 'SIGTERM', stdout: '', stderr: 'killed' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(
      performNetworkToggle({
        adapter: 'Test Adapter',
        confirm: true,
        run: signalledRun,
        journalFile: path.join(tmpDir('offline-matrix-signal-'), 'journal.json'),
        isWindows: true,
        readJournalFn: () => [],
        writeJournalFn: () => {},
        spawnRecovery: false,
      }),
    ).rejects.toThrow(/elevation/);
    expect(ops.some((c) => binOf(c) === 'netsh')).toBe(false);
  });

  // ------------------------------------------ proxy hardening (PRR-004/005/006)
  it('proxy: absolute-form and scheme-relative request targets are refused 400 — origin-form still proxies', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${port}` });
    try {
      const abs = await rawReq({ host: '127.0.0.1', port: proxy.port, path: 'http://127.0.0.1:9/exfil' });
      expect(abs.status).toBe(400);
      expect(abs.headers['x-offline-matrix-error']).toBe('origin-form-required');
      const rel = await rawReq({ host: '127.0.0.1', port: proxy.port, path: '//127.0.0.1:9/exfil' });
      expect(rel.status).toBe(400);
      expect(rel.headers['x-offline-matrix-error']).toBe('origin-form-required');
      expect(hits).toEqual([]); // nothing reached any upstream
      const ok = await rawReq({ host: '127.0.0.1', port: proxy.port, path: '/legit' });
      expect(ok.status).toBe(200);
      expect(hits).toEqual(['/legit']);
    } finally {
      await proxy.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('proxy: --proxy-host accepts loopback literals only; non-http(s) upstream schemes are refused', async () => {
    await expect(createStripProxy({ upstreamBase: 'http://127.0.0.1:9', host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    await expect(createStripProxy({ upstreamBase: 'http://127.0.0.1:9', host: '10.0.0.5' })).rejects.toThrow(/loopback/);
    await expect(createStripProxy({ upstreamBase: 'ftp://127.0.0.1:21' })).rejects.toThrow(/http/);
    const p = await createStripProxy({ upstreamBase: 'http://127.0.0.1:9', host: 'localhost' });
    await p.close();
  });

  it('proxy: proxyBase derives from the BOUND address, not the client Host header (no self-open-redirect)', async () => {
    const upstream = await startUpstream();
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${upstream.port}` });
    try {
      const res = await rawReq({ host: '127.0.0.1', port: proxy.port, path: '/redirect-abs', headers: { Host: 'evil.example:1234' } });
      expect(res.status).toBe(307);
      expect(res.headers.location).toBe(`${proxy.base}/emit?n=1`); // re-anchored onto the BOUND origin
      expect(String(res.headers.location)).not.toContain('evil.example');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('proxy: hop-by-hop headers are stripped in both directions (fixed list + Connection-listed names)', async () => {
    // unit: the fixed list and the Connection-listed dynamic arm both go
    const kept = stripHopByHopHeaders({
      connection: 'x-listed',
      'x-listed': 'v',
      'transfer-encoding': 'chunked',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      'x-keep': 'yes',
    });
    expect(kept).toEqual({ 'x-keep': 'yes' });
    // request-direction integration: a Connection-listed request header never reaches the upstream
    const seen: Record<string, unknown> = {};
    const server = http.createServer((req, res) => {
      Object.assign(seen, req.headers);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${port}` });
    try {
      await rawReq({
        host: '127.0.0.1',
        port: proxy.port,
        path: '/hop',
        headers: { Connection: 'x-req-hop', 'x-req-hop': 'secret' },
      });
      expect(seen['x-req-hop']).toBeUndefined(); // stripped before the upstream saw it
    } finally {
      await proxy.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('proxy: a non-http(s) upstream Location is answered with a named 502, never forwarded', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(302, { location: 'ftp://evil.example/payload' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${port}` });
    try {
      const r = await f(`${proxy.base}/redir`, { redirect: 'manual' });
      expect(r.status).toBe(502);
      expect(r.headers.get('x-offline-matrix-error')).toBe('unsupported-location-scheme');
      await r.text();
    } finally {
      await proxy.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('proxy: the TOTAL upstream deadline cuts a trickling upstream at the budget (inactivity alone cannot)', async () => {
    const upstream = await startTrickleUpstream(100); // a write every 100ms keeps the socket forever active
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${upstream.port}`, upstreamTimeoutMs: 700 });
    try {
      const t0 = Date.now();
      const r = await f(`${proxy.base}/trickle`);
      expect(r.status).toBe(200);
      let readFailure: unknown = null;
      try {
        await r.text();
      } catch (e) {
        readFailure = e;
      }
      const elapsed = Date.now() - t0;
      expect(readFailure).toBeTruthy(); // the stream was cut at the total budget
      expect(elapsed).toBeLessThan(4_000); // ...and not by the 10s fetch bound either
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('proxy: close() completes promptly with an in-flight streaming connection (closeAllConnections BEFORE close)', async () => {
    const upstream = await startTrickleUpstream(100);
    const proxy = await createStripProxy({ upstreamBase: `http://127.0.0.1:${upstream.port}` });
    const req = http.get({ host: '127.0.0.1', port: proxy.port, path: '/trickle' }, (res) => {
      res.on('data', () => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // stream established and flowing
    const t0 = Date.now();
    await proxy.close(); // must not hang on the live connection
    expect(Date.now() - t0).toBeLessThan(2_500);
    req.destroy();
    await upstream.close();
  });

  // ---------------------------------------- capture integrity (PRR-019/SEC-16)
  it('capture: atomic exclusive-create with a -1 collision suffix, no tmp leftovers, and a pipe-sanitized machine tag', () => {
    const dir = tmpDir('offline-matrix-capture2-');
    const now = () => new Date('2026-10-30T22:00:00.000Z');
    const a = writeCaptureRow({ scenarioId: 'S2', machineTag: 'cell|test', dir, now });
    const b = writeCaptureRow({ scenarioId: 'S2', machineTag: 'cell|test', dir, now });
    expect(path.basename(a.file!)).toBe('S2-cell_test-20261030T220000Z.json');
    expect(path.basename(b.file!)).toBe('S2-cell_test-20261030T220000Z-1.json'); // collision → suffix, never overwrite
    expect(a.row!.machine).toBe('cell_test'); // SEC-16: no pipe can break the merged markdown row
    const parsedA = JSON.parse(fs.readFileSync(a.file!, 'utf8')) as Record<string, unknown>;
    const parsedB = JSON.parse(fs.readFileSync(b.file!, 'utf8')) as Record<string, unknown>;
    expect(parsedA.scenario_id).toBe('S2');
    expect(parsedB.scenario_id).toBe('S2'); // the first row was NOT clobbered
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]); // no tmp litter
  });

  it('capture: a raw capture IO failure on the MAIN path maps to exit 4 (consistent with the teardown path)', async () => {
    const verdict = await runPrep(parseArgs(['--scenario', 'S4', '--prep']), {
      writeCapture: () => {
        throw new Error("EACCES: permission denied, open 'x.json'");
      },
    } as never);
    expect(verdict).toBe(4);
  });

  // -------------------------------------- injectable hold seam (PRR-011)
  it('prep: S7 routes the proxy leg through the injected hold seam; teardown closes the real proxy', async () => {
    const upstream = await startUpstream();
    const captured: Array<Record<string, unknown>> = [];
    const injectedWriteCapture = (o: Record<string, unknown>) => {
      captured.push(o);
      return { file: path.join(os.tmpdir(), 'offline-matrix-S7-fake.json'), row: {} };
    };
    let holdDeps: { writeCapture?: unknown } | null = null;
    let legsSeen = '';
    const verdict = await runPrep(
      parseArgs(['--scenario', 'S7', '--prep', '--proxy-upstream', `http://127.0.0.1:${upstream.port}`]),
      {
        hold: async (_sc: unknown, legs: string, teardown: () => Promise<string>, deps: { writeCapture?: unknown }) => {
          legsSeen = legs;
          holdDeps = deps;
          const measured = await teardown(); // runs the REAL proxy.close()
          expect(String(measured)).toContain('closed cleanly');
        },
        writeCapture: injectedWriteCapture,
      } as never,
    );
    expect(verdict).toBe(0);
    expect(legsSeen).toBe('header-strip-proxy:up');
    expect(holdDeps?.writeCapture).toBe(injectedWriteCapture); // the seam carries the injected capture fn
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ scenarioId: 'S7', automatedLegs: 'header-strip-proxy:up' });
    await upstream.close();
  });

  it('prep: zero-leg scenario (S4) writes the capture row and exits 0', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const verdict = await runPrep(parseArgs(['--scenario', 'S4', '--prep']), {
      writeCapture: (o: Record<string, unknown>) => {
        captured.push(o);
        return { file: path.join(os.tmpdir(), 'offline-matrix-S4-fake.json'), row: {} };
      },
    } as never);
    expect(verdict).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ scenarioId: 'S4', automatedLegs: 'none', measured: '' });
    expect(String(captured[0].notes)).toMatch(/pid \d+/);
  });

  // ----- the REAL SIGINT teardown->capture->exit path, in a spawned process (PRR-011/021/022)
  it('teardown: SIGINT tears the held leg down, writes the capture row through the seam, and the final stdout line survives the exit', async () => {
    const child = holdDriver(
      `
      __HOLD__(
        __SCENARIOS__.find((s) => s.id === 'S4'),
        'none',
        async (signal) => { await new Promise((r) => setTimeout(r, 150)); return 'torn-down by ' + signal; },
        { writeCapture: (o) => ({ file: 'bench/offline-matrix-results/S4-driver-fake.json', row: {} }) },
      );
      `,
      "setTimeout(() => process.emit('SIGINT'), 120);",
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d;
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d;
    });
    const exited = await waitForExit(child, 15_000);
    expect(exited, `driver did not exit (stderr: ${stderr})`).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(stdout).toContain('environment leg active');
    // the capture row pointer AND the completion line survive process.exit (stdout flushed)
    expect(stdout).toContain('capture row: ');
    expect(stdout).toContain('S4-driver-fake.json');
    expect(stdout).toContain('S4 auto-clean complete (received SIGINT)');
    expect(stderr).toBe('');
  });

  it('teardown: a SECOND Ctrl+C while the teardown hangs force-exits 130 (the escape hatch)', async () => {
    const child = holdDriver(
      `
      __HOLD__(
        __SCENARIOS__.find((s) => s.id === 'S2'),
        'ram-filler:attained',
        () => new Promise(() => {}), // a hung teardown
        { writeCapture: () => ({ file: 'x.json', row: {} }) },
      );
      `,
      "setTimeout(() => process.emit('SIGINT'), 100); setTimeout(() => process.emit('SIGINT'), 450);",
    );
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d;
    });
    const exited = await waitForExit(child, 15_000);
    expect(exited, `driver did not exit (stderr: ${stderr})`).toBe(true);
    expect(child.exitCode).toBe(EXIT_FORCED);
    expect(child.exitCode).toBe(130);
    expect(stderr).toMatch(/second interrupt forces exit/);
  });
});
