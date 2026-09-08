// Backend host selector — THE import seam for B4-B9 (issue #61).
//
// `createBackendHost(config)` returns ONE of two implementations behind the
// SAME BackendHost interface, chosen only by the resolved backend.mode:
//   - "node" (default while ADR-0003 #57 is open): the guarded listener
//     serves the frozen contract from the local StubEngine.
//   - "sidecar": the SAME guarded listener fronts a transparent proxy to a
//     spawned backend child managed by SidecarManager.
// Flipping the default when ADR-0003 lands is a one-line change in types.ts.
//
// Electron-free: safe to import from the headless dev-server entry and CI.
import net from 'node:net';
import { createLoopbackGuard } from '../security/loopback-guard.js';
import { StubEngine } from './engine.js';
import { SidecarManager } from './sidecar-manager.js';
import { createBackendServer, listenOnRandomPort } from './server.js';
import {
  resolveBackendMode,
  type BackendHandle,
  type BackendHost,
  type BackendHostConfig,
  type BackendMode,
} from './types.js';

export type { BackendHandle, BackendHost, BackendHostConfig, BackendMode };
export { resolveBackendMode };

/**
 * Reserve a free loopback port for a child process: bind port 0, read the
 * assigned port, close. The brief bind-close race is acceptable here because
 * the port is handed to a child we spawn immediately (documented in
 * docs/security/desktop.md).
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address !== 'string' ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('could not reserve a free loopback port'));
      });
    });
  });
}

/** Node-mode host: guarded listener + local stub engine. */
export class NodeBackendHost implements BackendHost {
  readonly mode: BackendMode = 'node';
  private server: ReturnType<typeof createBackendServer> | null = null;
  private handle: BackendHandle | null = null;

  constructor(private readonly config: BackendHostConfig, private readonly engine: StubEngine = new StubEngine()) {}

  async start(): Promise<BackendHandle> {
    if (this.handle) return this.handle;
    this.server = createBackendServer({
      guard: createLoopbackGuard({
        token: this.config.token,
        tokenHeaderName: this.config.tokenHeaderName,
        allowedOrigins: this.config.allowedOrigins,
      }),
      tokenHeaderName: this.config.tokenHeaderName,
      allowedOrigins: this.config.allowedOrigins,
      engine: this.engine,
    });
    const port = await listenOnRandomPort(this.server);
    this.handle = { mode: this.mode, port, url: `http://127.0.0.1:${port}` };
    return this.handle;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.handle = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Sidecar-mode host: guarded listener + proxy fronting the spawned child. */
export class SidecarBackendHost implements BackendHost {
  readonly mode: BackendMode = 'sidecar';
  private server: ReturnType<typeof createBackendServer> | null = null;
  private manager: SidecarManager | null = null;
  private handle: BackendHandle | null = null;

  constructor(private readonly config: BackendHostConfig) {}

  async start(): Promise<BackendHandle> {
    if (this.handle) return this.handle;
    const sidecar = this.config.sidecar ?? {};
    const command = sidecar.command;
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('backend.mode "sidecar" requires sidecar.command (the backend executable to spawn)');
    }
    // Reserve the loopback port the child will bind, then front it.
    const upstreamPort = sidecar.port ?? (await reserveFreePort());
    const args = sidecar.args ?? [];
    const manager = new SidecarManager({
      command,
      args,
      cwd: sidecar.cwd,
      env: sidecar.env,
      port: upstreamPort,
      maxWaitMs: sidecar.healthTimeoutMs ?? 60000,
    });
    manager.on('restart', (attempt, delayMs) => {
      console.error(`[trainingapp-backend] sidecar exited; restarting (attempt ${attempt} after ${delayMs}ms backoff)`);
    });
    manager.on('gave-up', (attempts) => {
      console.error(`[trainingapp-backend] sidecar restart bound exceeded after ${attempts} restarts; giving up`);
    });
    await manager.start();
    this.manager = manager;
    this.server = createBackendServer({
      guard: createLoopbackGuard({
        token: this.config.token,
        tokenHeaderName: this.config.tokenHeaderName,
        allowedOrigins: this.config.allowedOrigins,
      }),
      tokenHeaderName: this.config.tokenHeaderName,
      allowedOrigins: this.config.allowedOrigins,
      upstreamPort,
    });
    const port = await listenOnRandomPort(this.server);
    this.handle = { mode: this.mode, port, url: `http://127.0.0.1:${port}` };
    return this.handle;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const manager = this.manager;
    this.server = null;
    this.manager = null;
    this.handle = null;
    if (manager !== null) await manager.stop();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Resolve the config and build the ONE host interface for B4-B9. */
export function createBackendHost(config: BackendHostConfig): BackendHost {
  const mode = resolveBackendMode({ mode: config.mode, env: config.env });
  if (mode === 'sidecar') return new SidecarBackendHost(config);
  return new NodeBackendHost(config);
}
