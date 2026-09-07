#!/usr/bin/env node
/**
 * wllama (browser WASM) benchmark driver — issue #52 bench harness.
 *
 * Runs the SAME wllama stack the web_ui ships (@wllama/wllama 3.5.1) in a real
 * headless Chromium browser, in two modes:
 *   * threaded  - served WITH Cross-Origin-Opener-Policy/Embedder-Policy so
 *     SharedArrayBuffer is available (crossOriginIsolated === true) and wllama
 *     runs multi-threaded with n_threads = min(hardwareConcurrency, 4),
 *     mirroring web_ui/src/lib/llm/wllama-service.ts threadCount().
 *   * single    - served WITHOUT the headers (the corporate-proxy simulation):
 *     crossOriginIsolated === false, SAB unavailable, n_threads forced to 1 —
 *     the deterministic path the browser takes when the headers are stripped.
 *
 * Zero new npm dependencies: requires Node >= 22.5 (built-in WebSocket
 * global for the CDP connection); node:http static server (Range-capable for
 * wllama's byte-range fetches), Node's built-in WebSocket for CDP, headless
 * Edge/Chrome. wllama assets resolve from web_ui/node_modules when present,
 * else from the pinned jsdelivr CDN (network required in that case).
 *
 * Usage:
 *   node bench/wllama_bench_driver.mjs --list-modes
 *   node bench/wllama_bench_driver.mjs --run --model models/lfm2.5-vl-450m/model.gguf \
 *     --browser "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
 *     --prompt-tokens 256 --max-tokens 16 --json
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WLLAMA_VERSION = '3.5.1';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/esm`;
const LOCAL_ESM = path.join(REPO_ROOT, 'web_ui', 'node_modules', '@wllama', 'wllama', 'esm');
const RUN_BUDGET_MS = 190_000;

const MODES = [
  { mode: 'threaded', coop_coep: true, threads: Math.min(os.availableParallelism?.() || os.cpus().length, 4) },
  { mode: 'single', coop_coep: false, threads: 1 },
];

function machineTag() {
  return process.env.BENCH_MACHINE_TAG || 'devstation';
}

function machineTuple() {
  return {
    machine: machineTag(),
    node: process.version,
    wllama: WLLAMA_VERSION,
  };
}

function log(msg) {
  process.stderr.write(`[wllama-bench] ${msg}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Static server (Range-capable; COOP/COEP only when enabled for the leg)
// ---------------------------------------------------------------------------

function modelNameFor(modelPath) {
  const stem = path.basename(modelPath).replace(/\.gguf$/i, '');
  const dir = path.basename(path.dirname(modelPath));
  return stem === 'model' || stem === 'gguf' ? dir : stem;
}

function startServer({ port, coopCoep, modelPath, localEsm }) {
  const state = { server: null, port };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, headers);
      res.end(body);
    };
    const cors = coopCoep
      ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
        }
      : {};

    if (url.pathname === '/bench.html') {
      return send(200, benchPage(), { 'Content-Type': 'text/html; charset=utf-8', ...cors });
    }
    if (url.pathname.startsWith('/wllama/')) {
      if (!localEsm) return send(404, 'local wllama assets unavailable');
      const rel = url.pathname.slice('/wllama/'.length);
      const fp = path.join(localEsm, rel);
      if (!fp.startsWith(localEsm) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        return send(404, 'not found');
      }
      const type = fp.endsWith('.wasm') ? 'application/wasm'
        : fp.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      return send(200, fs.readFileSync(fp), { 'Content-Type': type, ...cors });
    }
    if (url.pathname === '/model.gguf') {
      const size = fs.statSync(modelPath).size;
      const range = req.headers.range;
      const base = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', ...cors };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        end = Math.min(end, size - 1);
        if (Number.isNaN(start) || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, {
          ...base,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(modelPath, { start, end })
          .on('error', (err) => {
            log(`model stream error: ${err.message}`);
            res.destroy(err);
          })
          .pipe(res);
      } else {
        res.writeHead(200, { ...base, 'Content-Length': size });
        fs.createReadStream(modelPath)
          .on('error', (err) => {
            log(`model stream error: ${err.message}`);
            res.destroy(err);
          })
          .pipe(res);
      }
      return undefined;
    }
    return send(404, 'not found');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      state.port = server.address().port;
      resolve({ server, port: state.port });
    });
  });
}

// ---------------------------------------------------------------------------
// Bench page (served as /bench.html). Mirrors wllama-service.ts: in-memory
// CacheManager (no OPFS), AssetsPathConfig { default: <wasm url> } verbatim.
// ---------------------------------------------------------------------------

function benchPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>wllama bench</title></head>
<body><div id="status">booting</div>
<script type="module">
const q = new URLSearchParams(location.search);
const modelName = q.get('modelName') || 'unknown';
const statusEl = document.getElementById('status');
const setStage = (s) => { statusEl.textContent = s; };

// Duck-typed in-memory backend, mirroring web_ui InMemoryStorageBackend:
// write() must fully drain the stream into a Blob or the model bytes are lost.
class InMemoryStorageBackend {
  constructor() { this.store = new Map(); }
  isSupported() { return true; }
  async read(key) { return this.store.get(key) ?? null; }
  async write(key, stream) {
    const reader = stream.getReader();
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      this.store.set(key, new Blob(chunks));
    } finally {
      reader.releaseLock();
    }
  }
  async getSize(key) { const b = this.store.get(key); return b ? b.size : -1; }
  async list() { return Array.from(this.store.entries()).map(([key, blob]) => ({ key, size: blob.size })); }
  async delete(key) { this.store.delete(key); }
}

async function run() {
  const modelUrl = q.get('modelUrl');
  const indexUrl = q.get('indexUrl');
  const wasmUrl = q.get('wasmUrl');
  const nThreads = parseInt(q.get('nThreads') || '1', 10);
  const promptTokens = parseInt(q.get('promptTokens') || '256', 10);
  const maxTokens = parseInt(q.get('maxTokens') || '16', 10);
  const mode = q.get('mode') || 'single';
  const machine = q.get('machine') || 'devstation';
  const row = {
    surface: 'wllama',
    model: modelName,
    mode,
    threads: nThreads,
    prompt_tokens: promptTokens,
    machine,
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
  try {
    setStage('importing wllama');
    const { Wllama, CacheManager } = await import(indexUrl);
    setStage('constructing');
    const wllama = new Wllama(
      { default: wasmUrl },
      { suppressNativeLog: true, cacheManager: new CacheManager([new InMemoryStorageBackend()]) },
    );
    setStage('loading model');
    const t0 = performance.now();
    await wllama.loadModelFromUrl(modelUrl, {
      n_ctx: promptTokens + maxTokens + 64,
      n_threads: nThreads,
      useCache: false,
      progressCallback: ({ loaded, total }) => {
        if (total > 0) setStage('loading model ' + Math.round((loaded / total) * 100) + '%');
      },
    });
    const loadS = (performance.now() - t0) / 1000;

    setStage('generating');
    const sentence = 'Training documentation explains how the on-device assistant answers questions. ';
    let prompt = '';
    while (prompt.length < promptTokens * 4) prompt += sentence;
    prompt = prompt.slice(0, promptTokens * 4);

    let firstTokenAt = null;
    let nTokens = 0;
    let lastAt = null;
    const tGen = performance.now();
    // v3 createCompletion takes OAI-compatible params: max_tokens + stream/onData
    // (NOT nPredict/onNewToken — those names are silently ignored).
    await wllama.createCompletion({
      prompt,
      max_tokens: maxTokens,
      temperature: 0.0,
      stream: true,
      onData: (chunk) => {
        const now = performance.now();
        if (firstTokenAt === null) firstTokenAt = now;
        nTokens += 1;
        lastAt = now;
        void chunk;
      },
    });

    const decodeS = firstTokenAt !== null && lastAt !== null && lastAt > firstTokenAt && nTokens > 1
      ? (lastAt - firstTokenAt) / 1000
      : 0;
    row.load_s = Math.round(loadS * 1000) / 1000;
    row.first_token_ms = firstTokenAt !== null ? Math.round((firstTokenAt - tGen) * 10) / 10 : null;
    row.tokens_generated = nTokens;
    row.decode_tokens_per_second = decodeS > 0 ? Math.round(((nTokens - 1) / decodeS) * 100) / 100 : null;
    row.outcome = nTokens > 0 ? 'pass' : 'fail';
    try { await wllama.exit(); } catch { /* already gone */ }
    window.__benchResult = row;
    setStage('done');
  } catch (err) {
    row.outcome = 'fail';
    row.error = String(err && (err.stack || err.message || err)).slice(0, 600);
    window.__benchResult = row;
    setStage('error: ' + row.error.slice(0, 120));
  }
}
run();
</script></body></html>`;
}

// ---------------------------------------------------------------------------
// CDP over the built-in WebSocket (no puppeteer dependency)
// ---------------------------------------------------------------------------

function launchBrowser(browserExe, tmpDir) {
  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${tmpDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    'about:blank',
  ];
  const child = spawn(browserExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser did not expose a DevTools endpoint')), 30_000);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (m) {
        clearTimeout(timer);
        resolve({ child, wsUrl: m[1] });
      }
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited early (${code})`)); });
  });
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP websocket error'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async waitForEvent(method, timeoutMs, predicate) {
    const t0 = Date.now();
    for (;;) {
      const idx = this.events.findIndex((e) => e.method === method && (!predicate || predicate(e)));
      if (idx >= 0) return this.events.splice(idx, 1)[0];
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${method}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

function killBrowser(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function runLeg({ browserExe, modelPath, coopCoep, nThreads, promptTokens, maxTokens, mode }) {
  const localEsm = fs.existsSync(path.join(LOCAL_ESM, 'index.js')) ? LOCAL_ESM : null;
  const indexUrl = localEsm ? '/wllama/index.js' : `${CDN_BASE}/index.js`;
  const wasmUrl = localEsm ? '/wllama/wasm/wllama.wasm' : `${CDN_BASE}/wasm/wllama.wasm`;
  const { server, port } = await startServer({ port: 0, coopCoep, modelPath, localEsm });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wllama-bench-'));
  let browserChild = null;
  try {
    const url = `http://127.0.0.1:${port}/bench.html?` + new URLSearchParams({
      modelUrl: '/model.gguf',
      modelName: modelNameFor(modelPath),
      indexUrl,
      wasmUrl,
      nThreads: String(nThreads),
      promptTokens: String(promptTokens),
      maxTokens: String(maxTokens),
      mode,
      machine: machineTag(),
    }).toString();
    log(`mode=${mode} COOP/COEP=${coopCoep} port=${port} threads=${nThreads} index=${indexUrl}`);
    const { child, wsUrl } = await launchBrowser(browserExe, tmpDir);
    browserChild = child;
    const cdp = new Cdp(wsUrl);
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await cdp.waitForEvent('Page.loadEventFired', 30_000, (e) => e.sessionId === sessionId);
    // The page sets window.__benchResult when done (or on error). The
    // timeout fallback carries the same provenance keys a leg-failure row
    // would, so append_results can record it.
    const pageTimeoutRow = JSON.stringify({
      surface: 'wllama',
      model: modelNameFor(modelPath),
      mode,
      threads: nThreads,
      prompt_tokens: promptTokens,
      machine: machineTag(),
      outcome: 'fail',
      error: 'bench page timeout',
    });
    const expr = 'new Promise((resolve) => { const t0 = Date.now(); const poll = () => { if (window.__benchResult) return resolve(JSON.stringify(window.__benchResult)); if (Date.now() - t0 > ' + (RUN_BUDGET_MS - 20_000) + ') return resolve(' + JSON.stringify(pageTimeoutRow) + '); setTimeout(poll, 250); }; poll(); })';
    const result = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const row = JSON.parse(result.result.value);
    await killBrowser(browserChild);
    browserChild = null;
    cdp.close();
    return row;
  } finally {
    await killBrowser(browserChild);
    server.close();
    // Best-effort: the browser may still briefly hold the profile dir on
    // Windows; a leftover temp dir is acceptable, a crash is not.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* locked */ }
  }
}

async function runBothModes(opts) {
  const rows = [];
  for (const m of MODES) {
    let row;
    try {
      row = await runLeg({
        browserExe: opts.browser,
        modelPath: opts.model,
        coopCoep: m.coop_coep,
        nThreads: m.threads,
        promptTokens: opts.promptTokens,
        maxTokens: opts.maxTokens,
        mode: m.mode,
      });
    } catch (err) {
      // Isolate per-leg failures so one broken mode cannot discard the
      // other mode's already-recorded row.
      row = { surface: 'wllama', model: modelNameFor(opts.model), mode: m.mode,
              threads: m.threads, machine: machineTag(),
              outcome: 'fail', error: String(err && err.message || err).slice(0, 400) };
    }
    if (row.outcome !== 'pass') log(`mode=${m.mode} FAILED: ${row.error || 'unknown'}`);
    rows.push(row);
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['list-modes']) {
    process.stdout.write(JSON.stringify({ modes: MODES }, null, 2) + '\n');
    return 0;
  }
  if (args.run) {
    const model = path.resolve(String(args.model || path.join(REPO_ROOT, 'models', 'lfm2.5-vl-450m', 'model.gguf')));
    if (!fs.existsSync(model)) {
      process.stderr.write(`model file not found: ${model}\n`);
      process.stdout.write(JSON.stringify({ outcome: 'fail', error: `model file not found: ${model}` }) + '\n');
      return 1;
    }
    const browser = String(args.browser
      || process.env.BENCH_BROWSER_BIN
      || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
    if (!fs.existsSync(browser)) {
      process.stderr.write(`browser binary not found: ${browser}\n`);
      process.stdout.write(JSON.stringify({ outcome: 'fail', error: `browser binary not found: ${browser}` }) + '\n');
      return 1;
    }
    const opts = {
      model,
      browser,
      promptTokens: parseInt(args['prompt-tokens'] || '256', 10),
      maxTokens: parseInt(args['max-tokens'] || '16', 10),
    };
    const budget = setTimeout(() => {
      log(`exceeded the ${RUN_BUDGET_MS / 1000}s budget; exiting`);
      process.exit(3);
    }, RUN_BUDGET_MS);
    runBothModes(opts)
      .then((rows) => {
        clearTimeout(budget);
        for (const row of rows) process.stdout.write(JSON.stringify(row) + '\n');
        const allPass = rows.every((r) => r.outcome === 'pass');
        return allPass ? 0 : 1;
      })
      .then((code) => process.exit(code))
      .catch((err) => {
        clearTimeout(budget);
        log(`fatal: ${err.message}`);
        process.stdout.write(JSON.stringify({ outcome: 'fail', error: err.message }) + '\n');
        process.exit(1);
      });
    return undefined;
  }
  process.stdout.write('usage: wllama_bench_driver.mjs --list-modes | --run --model <gguf> --browser <exe> [--prompt-tokens N] [--max-tokens N] [--json]\n');
  return 2;
}

// entry
const code = main();
if (code !== undefined) process.exit(code);
void crypto; void machineTuple;
