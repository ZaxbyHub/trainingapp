// Sidecar lifecycle manager for the Electron backend host (issue #61).
//
// Owns the spawned backend child process (per ADR-0003's Python-sidecar
// option: a PyInstaller-built api_server, or in dev/CI a uvicorn launcher):
//   - spawn with loopback bind config (API_HOST=127.0.0.1, API_PORT=<port>;
//     uvicorn-style launchers get --host/--port via args from the caller),
//     a configurable working directory, and merged env;
//   - readiness = GET /health polled with retry/backoff under a BOUNDED
//     timeout;
//   - unexpected exit -> bounded-retry restart with backoff; exceeding the
//     bound gives up LOUDLY (no infinite restart loop);
//   - stop() = graceful signal first (SIGTERM; on Windows both signals map
//     to TerminateProcess, so the grace window is POSIX-meaningful and
//     Windows-harmless), then kill after the grace period; all timers
//     cleared so an app quit leaves NO ORPHAN child.
//
// Electron-free: runs under plain node. `spawnFn` and `pingFn` are injectable
// so the lifecycle is unit-testable without real processes (acceptance specs
// b3-sidecar-manager.test.ts / b3-sidecar-lifecycle.test.ts).
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface SidecarManagerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** The loopback port the sidecar should bind (reserved by the caller). */
  port: number;
  /** Injectable spawn (defaults to child_process.spawn). */
  spawnFn?: (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;
  /** Injectable health probe; resolves true when /health answers 200. */
  pingFn?: (healthUrl: string) => Promise<boolean>;
  /** Bounded readiness wait (ms). */
  maxWaitMs?: number;
  /** Base interval between readiness probes (ms). */
  retryIntervalMs?: number;
  /** Multiplier applied per failed probe (backoff). */
  retryBackoffMultiplier?: number;
  /** Max restarts after unexpected exits within the window. */
  maxRestarts?: number;
  /** Base delay before a restart attempt (ms; grows exponentially). */
  restartBackoffMs?: number;
  /** Grace period between the graceful signal and the kill (ms). */
  stopGraceMs?: number;
}

type MinimalChild = Pick<ChildProcess, 'pid' | 'killed' | 'kill' | 'on'> & {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void) : void } | null;
  exitCode: number | null;
};

export class SidecarManager extends EventEmitter {
  readonly healthUrl: string;
  private readonly options: Required<Pick<SidecarManagerOptions, 'maxWaitMs' | 'retryIntervalMs' | 'retryBackoffMultiplier' | 'maxRestarts' | 'restartBackoffMs' | 'stopGraceMs'>>;
  private readonly launch: Pick<SidecarManagerOptions, 'command' | 'args' | 'cwd' | 'env' | 'port' | 'spawnFn' | 'pingFn'>;
  private child: MinimalChild | null = null;
  private restarts = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private lastKillSignals: string[] = [];

  constructor(options: SidecarManagerOptions) {
    super();
    this.launch = options;
    this.healthUrl = `http://127.0.0.1:${options.port}/health`;
    this.options = {
      maxWaitMs: options.maxWaitMs ?? 15000,
      retryIntervalMs: options.retryIntervalMs ?? 250,
      retryBackoffMultiplier: options.retryBackoffMultiplier ?? 1.5,
      maxRestarts: options.maxRestarts ?? 5,
      restartBackoffMs: options.restartBackoffMs ?? 500,
      stopGraceMs: options.stopGraceMs ?? 1000,
    };
  }

  /** Signals passed to the child by the most recent stop() (test hook). */
  get killSignalsForTest(): string[] {
    return [...this.lastKillSignals];
  }

  get runningPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Spawn the child and wait (bounded) for GET /health to answer. */
  async start(): Promise<void> {
    this.stopping = false;
    this.spawnChild();
    const ready = await this.waitUntilHealthy();
    if (!ready) {
      await this.stopChildOnly();
      throw new Error(`sidecar did not become healthy at ${this.healthUrl} within ${this.options.maxWaitMs}ms`);
    }
  }

  /**
   * Stop the child and ALL lifecycle timers: graceful signal first, kill
   * after the grace window. App-quit safe — leaves no orphan and no pending
   * restart timer can resurrect the child.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.stopChildOnly();
  }

  private spawnChild(): void {
    const spawnFn =
      this.launch.spawnFn ??
      ((command, args, opts) => nodeSpawn(command, args, opts));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Loopback bind configuration for api_server-style launchers; the
      // caller passes --host/--port args itself for uvicorn-style launchers.
      API_HOST: '127.0.0.1',
      API_PORT: String(this.launch.port),
      ...this.launch.env,
    };
    const child = spawnFn(this.launch.command, this.launch.args ?? [], {
      cwd: this.launch.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // DRAIN the child's pipes: unread pipes fill their ~64KB buffer and BLOCK
    // the child mid-boot (a chatty backend printing model-load logs would
    // never finish binding). Forward to the manager's own console at debug
    // volume; never echo the child's env/args.
    child.stdout?.on('data', () => { /* drained */ });
    child.stderr?.on('data', () => { /* drained */ });
    this.child = child as MinimalChild;
    child.on?.('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', code, signal);
      if (!this.stopping) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    if (this.restarts >= this.options.maxRestarts) {
      this.emit('gave-up', this.restarts);
      return;
    }
    const delay = this.options.restartBackoffMs * 2 ** this.restarts;
    this.restarts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.emit('restart', this.restarts, delay);
      this.spawnChild();
    }, delay);
  }

  private waitUntilHealthy(): Promise<boolean> {
    const ping = this.launch.pingFn ?? this.defaultPing;
    const started = Date.now();
    let interval = this.options.retryIntervalMs;
    return new Promise((resolve) => {
      const attempt = (): void => {
        void ping(this.healthUrl).then((ok) => {
          if (ok) {
            resolve(true);
            return;
          }
          if (Date.now() - started >= this.options.maxWaitMs) {
            resolve(false);
            return;
          }
          setTimeout(attempt, interval).unref();
          interval *= this.options.retryBackoffMultiplier;
        });
      };
      attempt();
    });
  }

  private defaultPing = async (healthUrl: string): Promise<boolean> => {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      return response.status === 200;
    } catch {
      return false;
    }
  };

  private async stopChildOnly(): Promise<void> {
    const child = this.child;
    this.lastKillSignals = [];
    if (child === null) return;
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    const exited = new Promise<void>((resolve) => {
      // Only an ACTUAL exit settles this — `killed` merely means kill() was
      // called; a child that ignores the graceful signal must still receive
      // the escalated kill below.
      if (child.exitCode !== null) resolve();
      child.on?.('exit', () => resolve());
    });
    // Graceful signal first; on Windows both signals map to TerminateProcess
    // (documented honestly in docs/security/desktop.md) — the sequence is
    // POSIX-meaningful and Windows-harmless.
    child.kill('SIGTERM');
    this.lastKillSignals.push('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        this.lastKillSignals.push('SIGKILL');
      }
    }, this.options.stopGraceMs);
    this.killTimer.unref();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, this.options.stopGraceMs * 3).unref())]);
    this.child = null;
  }
}
