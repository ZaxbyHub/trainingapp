// Issue #57 spike slice 1: Electron main-process Node backend.
// Throwaway comparison slice - deleted after ADR-0003 merges.
// In-process loopback HTTP server (node:http) implementing the frozen
// /ask/stream shape from contracts/api.openapi.yaml v2.6.0 (single endpoint).
import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackend, type Backend } from './backend';
import { resolveModelsDir } from './models';

let backend: Backend | null = null;

// Packaged Windows GUI apps lose stdout; log to a file for measurement runs.
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

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    spikeLog('[spike-node] another instance holds the lock - exiting');
    app.quit();
    return;
  }
  const modelsDir = resolveModelsDir();
  spikeLog(`[spike-node] starting model_dir=${modelsDir}`);
  backend = await createBackend({ modelsDir, log: spikeLog });
  spikeLog(`[spike-node] ready model_dir=${modelsDir} port=${backend.port}`);

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const rendererPath = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'index.html')
    : path.join(__dirname, '..', 'renderer', 'index.html');
  void win.loadFile(rendererPath, {
    query: { port: String(backend.port) },
  });
}

app.whenReady().then(main).catch((err: unknown) => {
  spikeLog(`[spike-node] fatal ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  app.quit();
});

app.on('window-all-closed', () => {
  backend?.stop();
  app.quit();
});
