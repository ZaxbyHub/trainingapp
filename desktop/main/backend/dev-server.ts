// Headless backend host entry (issue #61).
//
// Runs the guarded backend host under PLAIN NODE — no Electron, no window —
// for CI conformance and the frozen acceptance checks. Frozen CLI shape:
//
//   node desktop/dist/main/backend/dev-server.js \
//     --port-file <path> --mode <node|sidecar> --token <value>
//     [--sidecar-command <cmd>] [--sidecar-arg <a>]... [--sidecar-cwd <dir>]
//
// Binds 127.0.0.1 on an OS-assigned random free port, writes the decimal
// port to --port-file after the listener is up, and exits (stopping the
// host) when stdin closes — the checks' orphan-prevention backstop.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackendHost, resolveBackendMode } from './index.js';
import { resolveNodeEngine } from './inference/llama-engine.js';
import { resolvePacksSecurity } from './packs/pack-extract.js';
import { createMemorySecretStore } from '../security/secret-store.js';
import type { BackendMode } from './types.js';

interface DevServerArgs {
  portFile: string;
  mode?: BackendMode;
  token: string;
  sidecar?: { command?: string; args: string[]; cwd?: string; port?: number };
  /** B4 (issue #62): 'auto' (default) honors TRAININGAPP_* env; 'stub' forces the B3 fixture. */
  engine?: 'auto' | 'stub';
  /** B4 (issue #62): override TRAININGAPP_INFERENCE_MODEL_DIR for this run. */
  modelDir?: string;
  /** B5 (issue #63): open the per-profile SQLite store at this path. Falls
   *  back to TRAININGAPP_DESKTOP_STORE_PATH; when neither is set no store is
   *  opened (node mode only). */
  storePath?: string;
}

/** issue #100 item 5a: exported so the arg contract is directly testable. */
export function parseArgs(argv: string[]): DevServerArgs {
  const args: DevServerArgs = { portFile: '', token: '', sidecar: { args: [] } };
  for (let i = 0; i < argv.length; i += 1) {
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${argv[i]} requires a value`);
      i += 1;
      return v;
    };
    switch (argv[i]) {
      case '--port-file':
        args.portFile = value();
        break;
      case '--mode':
        args.mode = value() as BackendMode;
        break;
      case '--token':
        args.token = value();
        break;
      case '--sidecar-command':
        args.sidecar = { ...(args.sidecar ?? { args: [] }), command: value() };
        break;
      case '--sidecar-arg':
        args.sidecar = { ...(args.sidecar ?? { args: [] }), args: [...(args.sidecar?.args ?? []), value()] };
        break;
      case '--sidecar-cwd':
        args.sidecar = { ...(args.sidecar ?? { args: [] }), cwd: value() };
        break;
      case '--sidecar-port':
        // The port the child will bind. Pass this INSTEAD of letting the
        // selector reserve one, and mirror it in the child's own args (e.g.
        // `--sidecar-arg --port --sidecar-arg <n>` for uvicorn launchers) —
        // otherwise the manager probes a port the child never binds.
        args.sidecar = { ...(args.sidecar ?? { args: [] }), port: Number.parseInt(value(), 10) };
        break;
      case '--engine':
        args.engine = value() === 'stub' ? 'stub' : 'auto';
        break;
      case '--model-dir':
        args.modelDir = value();
        break;
      case '--store-path':
        args.storePath = value();
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (args.portFile.length === 0) throw new Error('--port-file is required');
  if (args.token.length === 0) throw new Error('--token is required');
  return args;
}

/**
 * issue #100 item 5a: the one store-path resolution — CLI flag wins over the
 * TRAININGAPP_DESKTOP_STORE_PATH env fallback, undefined when neither is set.
 * A present-but-EMPTY value counts as unset at BOTH levels (swarm-pr-review
 * PRR-013): `??` alone let `--store-path ""` beat a valid env value, and the
 * emptiness check alone still let it shadow the env — an empty flag is an
 * empty-variable accident, so fall through rather than derive cwd-relative
 * dirs from "". Every consumer in this file (engine sidecar dir, host
 * storePath, backups dir) resolves through here so the precedence cannot
 * drift per site.
 */
export function resolveStorePath(
  args: Pick<DevServerArgs, 'storePath'>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const candidate of [args.storePath, env.TRAININGAPP_DESKTOP_STORE_PATH]) {
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * issue #100 item 5a / swarm-pr-review PRR-033: wire the three shutdown
 * triggers (stdin end, SIGINT, SIGTERM) to ONE callback. Exported so the
 * registration itself is unit-testable with fake emitters; the issue's item-5
 * coverage claim explicitly names signal handling. The callback must stop the
 * host BEFORE exiting (no-orphan rule): a bare Ctrl+C used to exit without
 * stopping the host, orphaning a sidecar child.
 */
export function installShutdownHandlers(
  stdin: { on(event: 'end', cb: () => void): unknown },
  proc: { on(event: 'SIGINT' | 'SIGTERM', cb: () => void): unknown },
  stopAndExit: () => void,
): void {
  // Keep running until stdin closes (checks/CI hold it open; killing the
  // parent closes it). Signals get the same no-orphan treatment.
  stdin.on('end', stopAndExit);
  proc.on('SIGINT', stopAndExit);
  proc.on('SIGTERM', stopAndExit);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sidecar = args.sidecar;
  const storePath = resolveStorePath(args, process.env);
  // B4 (issue #62): node-mode engine selection. 'auto' (the default) resolves
  // through resolveNodeEngine(env) — TRAININGAPP_DESKTOP_ENGINE /
  // TRAININGAPP_INFERENCE_MODEL_DIR / TRAININGAPP_DESKTOP_INFERENCE_* — so the
  // conformance harness can run REAL inference purely via inherited env.
  const engineEnv = { ...process.env };
  if (args.modelDir !== undefined) engineEnv.TRAININGAPP_INFERENCE_MODEL_DIR = args.modelDir;
  // universal-provider-settings-overhaul: the headless host has no Electron
  // safeStorage, so an external model API key lives in process memory only
  // (never on disk); the airgap flag comes from TRAININGAPP_AIRGAP alone.
  const engineStorePath = storePath;
  const engine = resolveNodeEngine(
    args.engine === 'stub' ? { ...engineEnv, TRAININGAPP_DESKTOP_ENGINE: 'stub' } : engineEnv,
    {
      externalProvider: { secretStore: createMemorySecretStore() },
      // issue #155 review PRR-003: same sidecar convention as the Electron host
      // (path.dirname(storePath)). No storePath leaves the downgrade in memory
      // only, which is correct for a throwaway process.
      ...(engineStorePath !== undefined ? { gpuVerdictDir: path.dirname(engineStorePath) } : {}),
    },
  );
  const host = createBackendHost({
    token: args.token,
    mode: resolveBackendMode({ mode: args.mode }),
    engine,
    storePath,
    // Issue #75 (C8): headless hosts resolve the pack-installation security
    // limits from the TRAININGAPP_PACKS_* env seam (same resolution the
    // Electron host performs from its config + env).
    packsSecurity: resolvePacksSecurity(engineEnv),
    // B6 (issue #64): backups default next to the store; corruption without a
    // prompt seam auto-recovers (restore from the latest backup, else fresh).
    // issue #100 item 5a: resolved through the same single helper as the
    // storePath above (the former third inline fallback is gone).
    storeBackupsDir: storePath !== undefined ? path.join(path.dirname(storePath), 'backups') : undefined,
    sidecar: sidecar?.command
      ? { command: sidecar.command, args: sidecar.args, cwd: sidecar.cwd, port: sidecar.port }
      : undefined,
  });
  const handle = await host.start();
  try {
    writeFileSync(args.portFile, String(handle.port), 'utf8');
  } catch (err) {
    // No orphan: if the port file is unwritable (sidecar mode has a spawned
    // child running), stop the host BEFORE the error exits the process.
    await host.stop();
    throw err;
  }
  const stopAndExit = (): void => {
    void host.stop().finally(() => process.exit(0));
  };
  installShutdownHandlers(process.stdin, process, stopAndExit);
  process.stdin.resume();
}

// issue #100 item 5a: run main() only when THIS module is the process entry
// (executed directly, e.g. the compiled dist entry spawned by
// scripts/run-conformance-host.mjs), never on import — so tests can import
// parseArgs/resolveStorePath without starting a server. path.resolve keeps the
// relative invocation documented in the header working; argv[1] is checked
// first for bare `node -e`-style contexts.
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    console.error('[trainingapp-backend] dev-server failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
