// Issue #57 spike slice 2: minimal Electron shell for the Python sidecar.
// Spawns the PyInstaller-built api_server.exe (packaged under resources/
// sidecar/), waits for GET /health readiness with bounded retry, and proxies
// /health + /ask/stream bytes to it over loopback so the renderer talks only
// to the shell (SSE frames pass through untouched; a client abort destroys
// the upstream socket, which is what cancels generation per the post-#51
// contract). Throwaway - deleted after ADR-0003 merges.
import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SIDECAR_READY_TIMEOUT_MS = 120_000;

export function spikeLog(line: string): void {
  const target = process.env.TRAININGAPP_SPIKE_LOG;
  const stamped = `${new Date().toISOString()} ${line}`;
  // eslint-disable-next-line no-console
  console.log(stamped);
  if (target) {
    try {
      fs.appendFileSync(target, stamped + '\n');
    } catch {
      /* logging must never crash the app */
    }
  }
}
const SIDECAR_RESTART_BUDGET = 1;

let sidecar: ChildProcess | null = null;
let sidecarPort = 0;
let proxyPort = 0;
let proxyServer: http.Server | null = null;
let restarts = 0;

function resourcesDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath) : path.join(__dirname, '..', 'local');
}

function sidecarExe(): string {
  return path.join(resourcesDir(), 'sidecar', 'spike-sidecar', 'spike-api-server.exe');
}

function modelsDir(): string {
  return (
    process.env.TRAININGAPP_SPIKE_MODELS ??
    path.join(app.getPath('home'), '.trainingapp', 'models')
  );
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnSidecar(): Promise<void> {
    const port = await findFreePort();
    sidecarPort = port;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      ENABLE_AUTH: 'false',
      RAG_GGUF_PATH: path.join(modelsDir(), 'gemma-4-e2b-it', 'model.gguf'),
      RAG_DB_PATH: path.join(app.getPath('userData'), 'spike-db'),
      RAG_EMBEDDING_MODEL: 'BAAI/bge-small-en-v1.5',
      HF_HOME: path.join(app.getPath('userData'), 'hf-home'),
      PYTHONUNBUFFERED: '1',
    };
    // eslint-disable-next-line no-console
    console.log(`[spike-sidecar-shell] spawning ${sidecarExe()} port=${port}`);
    spikeLog(`[spike-sidecar-shell] spawning ${sidecarExe()} port=${port} models=${env.RAG_GGUF_PATH}`);
    sidecar = spawn(sidecarExe(), [], {
      cwd: path.dirname(sidecarExe()),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    sidecar.stdout?.on('data', (d: Buffer) => process.stdout.write(`[sidecar] ${d}`));
    sidecar.stderr?.on('data', (d: Buffer) => process.stderr.write(`[sidecar!err] ${d}`));
    sidecar.on('exit', (code) => {
      spikeLog(`[spike-sidecar-shell] sidecar exit code=${code} restarts=${restarts}`);
      if (restarts < SIDECAR_RESTART_BUDGET) {
        restarts += 1;
        void spawnSidecar();
      } else {
        spikeLog('[spike-sidecar-shell] restart budget exhausted - giving up LOUDLY');
      }
    });
}

function pingSidecar(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: sidecarPort, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once('error', () => resolve(false));
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS;
  for (;;) {
    if (await pingSidecar()) return;
    if (Date.now() > deadline) throw new Error('sidecar not ready within bounded timeout');
    await new Promise((r) => setTimeout(r, 400));
  }
}

function startProxy(): Promise<number> {
  const server = http.createServer((req, res) => {    const upstream = http.request(
      { host: '127.0.0.1', port: sidecarPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${sidecarPort}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `sidecar upstream error: ${String(err).slice(0, 120)}` }));
    });
    req.pipe(upstream);
    // A client abort destroys the request; destroy the upstream socket too so
    // uvicorn sees the disconnect and cancels generation (contract 2.6.0).
    res.on('close', () => upstream.destroy());
  });
  const requested = Number(process.env.TRAININGAPP_SPIKE_PORT ?? '0');
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      proxyServer = server;
      resolve(port);
    });
  });
}

async function main(): Promise<void> {
  await spawnSidecar();
  await waitReady();
  proxyPort = await startProxy();
  // eslint-disable-next-line no-console
  spikeLog(`[spike-sidecar-shell] ready proxy_port=${proxyPort} sidecar_port=${sidecarPort}`);
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const rendererPath = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'index.html')
    : path.join(__dirname, '..', 'renderer', 'index.html');
  void win.loadFile(rendererPath, {
    query: { port: String(proxyPort) },
  });
}

app.whenReady().then(main).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[spike-sidecar-shell] fatal', err);
  app.quit();
});

app.on('window-all-closed', () => {
  sidecar?.kill();
  proxyServer?.close();
  app.quit();
});
