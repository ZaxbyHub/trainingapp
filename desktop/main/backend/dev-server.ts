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
import { createBackendHost, resolveBackendMode } from './index.js';
import { resolveNodeEngine } from './inference/llama-engine.js';
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

function parseArgs(argv: string[]): DevServerArgs {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sidecar = args.sidecar;
  // B4 (issue #62): node-mode engine selection. 'auto' (the default) resolves
  // through resolveNodeEngine(env) — TRAININGAPP_DESKTOP_ENGINE /
  // TRAININGAPP_INFERENCE_MODEL_DIR / TRAININGAPP_DESKTOP_INFERENCE_* — so the
  // conformance harness can run REAL inference purely via inherited env.
  const engineEnv = { ...process.env };
  if (args.modelDir !== undefined) engineEnv.TRAININGAPP_INFERENCE_MODEL_DIR = args.modelDir;
  const engine = resolveNodeEngine(args.engine === 'stub' ? { ...engineEnv, TRAININGAPP_DESKTOP_ENGINE: 'stub' } : engineEnv);
  const host = createBackendHost({
    token: args.token,
    mode: resolveBackendMode({ mode: args.mode }),
    engine,
    storePath: args.storePath ?? process.env.TRAININGAPP_DESKTOP_STORE_PATH,
    // B6 (issue #64): backups default next to the store; corruption without a
    // prompt seam auto-recovers (restore from the latest backup, else fresh).
    storeBackupsDir:
      args.storePath !== undefined || process.env.TRAININGAPP_DESKTOP_STORE_PATH !== undefined
        ? path.join(
            path.dirname(args.storePath ?? process.env.TRAININGAPP_DESKTOP_STORE_PATH ?? '.'),
            'backups',
          )
        : undefined,
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
  // Keep running until stdin closes (checks/CI hold it open; killing the
  // parent closes it). Signals get the same no-orphan treatment — a bare
  // Ctrl+C used to exit without stopping the host, orphaning a sidecar child.
  process.stdin.on('end', stopAndExit);
  process.on('SIGINT', stopAndExit);
  process.on('SIGTERM', stopAndExit);
  process.stdin.resume();
}

main().catch((err: unknown) => {
  console.error('[trainingapp-backend] dev-server failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
