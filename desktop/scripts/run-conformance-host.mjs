// CI/local harness: run the frozen API contract conformance suite against the
// Electron-hosted backend (issue #61).
//
// Usage:  node desktop/scripts/run-conformance-host.mjs [--mode node] [--keep]
//
// Steps:
//   1. Start the compiled headless host (desktop/dist/main/backend/dev-server.js)
//      on 127.0.0.1:<random free port> with a fresh random run token.
//   2. Start a HARNESS-ONLY loopback proxy that injects the X-Desktop-Token
//      header into every forwarded request, so the B2 guard stays mounted in
//      front of EVERY route while the header-less conformance suite traverses
//      it (docs/security/desktop.md B3 contract; never done in production).
//   3. Measure cold-start to the first 200 GET /health.
//   4. Run: python contracts/tests/run_conformance.py --base-url <proxy> --destructive
//   5. Clean up both children; exit with the suite's exit code.
//
// Requires the desktop package to be compiled first:
//   npm --prefix desktop ci && npm --prefix desktop run compile
// Requires python with httpx on PATH (override with --python / PYTHON env).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostEntry = path.join(repoRoot, 'desktop', 'dist', 'main', 'backend', 'dev-server.js');
const IS_WIN = process.platform === 'win32';

function parseArgs(argv) {
  const args = { mode: 'node', keep: false, python: process.env.PYTHON ?? 'python' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--python') args.python = argv[++i];
    else if (argv[i] === '--keep') args.keep = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const children = [];
const sockets = new Set();

function cleanup() {
  for (const child of children.splice(0).reverse()) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    if (IS_WIN && child.pid && child.exitCode === null) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* best effort */
      }
    }
  }
  for (const socket of sockets) {
    try {
      socket.destroy();
    } catch {
      /* gone */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function waitForPortFile(portFile, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(portFile)) {
      const port = Number.parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`host did not write its port to ${portFile} within ${timeoutMs}ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function startTokenProxy(hostPort, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const headers = { ...req.headers };
      headers['x-desktop-token'] = token;
      delete headers.host;
      const upstream = http.request(
        { host: '127.0.0.1', port: hostPort, path: req.url, method: req.method, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        try {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`conformance proxy upstream error: ${err.code ?? err.message}`);
        } catch {
          /* late */
        }
      });
      req.pipe(upstream);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function fetchStatus(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(hostEntry)) {
    console.error(`run-conformance-host: missing ${hostEntry}`);
    console.error('  compile first:  npm --prefix desktop run compile');
    process.exit(2);
  }
  const token = crypto.randomBytes(24).toString('hex');
  const portFile = path.join(os.tmpdir(), `conformance-host-port-${process.pid}.txt`);
  const host = spawn(
    process.execPath,
    [hostEntry, '--port-file', portFile, '--mode', args.mode, '--token', token],
    { cwd: repoRoot, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  children.push(host);
  const t0 = Date.now();
  const hostPort = waitForPortFile(portFile, 15000);

  // Cold start: first 200 from GET /health (direct, with the token header).
  let coldStartMs = -1;
  for (;;) {
    try {
      const status = await fetchStatus(hostPort, '/health', { 'x-desktop-token': token });
      if (status === 200) {
        coldStartMs = Date.now() - t0;
        break;
      }
    } catch {
      /* not accepting yet */
    }
    if (Date.now() - t0 > 15000) throw new Error('host never answered GET /health with 200');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  console.log(`run-conformance-host: host up on 127.0.0.1:${hostPort} (mode: ${args.mode})`);
  console.log(`run-conformance-host: cold start to 200 GET /health = ${coldStartMs}ms (target bound: 15000ms)`);
  if (coldStartMs > 15000) throw new Error(`cold start ${coldStartMs}ms exceeds the 15000ms bound`);

  const { port: proxyPort } = await startTokenProxy(hostPort, token);
  console.log(`run-conformance-host: token-injecting proxy on 127.0.0.1:${proxyPort} (guard stays mounted)`);

  // IMPORTANT: run the suite with ASYNC spawn. The proxy lives in THIS
  // process's event loop; a synchronous spawnSync would block the loop and
  // the proxy could never forward the suite's requests (httpx ReadTimeout).
  const suite = spawn(
    args.python,
    ['contracts/tests/run_conformance.py', '--base-url', `http://127.0.0.1:${proxyPort}`, '--destructive'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let suiteStdout = '';
  suite.stdout.on('data', (chunk) => {
    suiteStdout += chunk.toString();
    process.stdout.write(chunk);
  });
  suite.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const suiteCode = await new Promise((resolve, reject) => {
    suite.on('error', reject);
    suite.on('close', (code) => resolve(code ?? 1));
  });

  if (!args.keep) {
    try {
      host.kill();
    } catch {
      /* cleanup handles */
    }
  }
  if (suiteCode !== 0 || !suiteStdout.includes('CONFORMANCE: PASS')) {
    console.error(`run-conformance-host: FAILED (suite exit ${suiteCode})`);
    // Exit NON-ZERO even when the suite exited 0 without the sentinel: a bare
    // process.exit(suiteCode) reported a sentinel-less failure as green.
    process.exit(suiteCode !== 0 ? suiteCode : 1);
  }
  console.log(`run-conformance-host: OK — conformance PASS against the Electron-hosted backend; cold start ${coldStartMs}ms (machine tag for bench/RESULTS.md: devstation)`);
  // The in-process proxy listen handle keeps the event loop alive; exit
  // explicitly (cleanup's 'exit' handler still runs).
  process.exit(0);
}

main().catch((err) => {
  console.error(`run-conformance-host: ${err.message}`);
  // Exit NOW: process.exitCode = 1 alone left the in-process proxy listen
  // handle and the piped host child holding the event loop open, hanging the
  // CI job until the runner timeout instead of failing fast. (The synchronous
  // 'exit' cleanup handler still runs on this path.)
  process.exit(1);
});
