#!/usr/bin/env node
// B4 bench driver (issue #62): measure the SHIPPING desktop node engine
// (LlamaEngine over node-llama-cpp) against a staged GGUF and emit one JSON
// row compatible with `bench/append_results.py` (surface=native). The `engine`
// column records `node-llama-cpp` so the rows coexist with the
// llama-cpp-python / llama-bench rows (identity cells differ on engine).
//
// Usage (from repo root):
//   node bench/node_bench_driver.mjs --model gemma-4-e2b-it \
//     --gguf models/gemma-4-e2b-it/model.gguf --threads 8 \
//     [--quant Q4_K_M] [--max-tokens 128] [--json row.json]
// Numeric flags (--threads, --max-tokens, --prompt-tokens) require
// positive decimal integers; a bare or invalid value fails loud and
// the CLI exits 2 (parse errors) vs 1 (runtime failures).
// Machine tag: BENCH_MACHINE_TAG env (default devstation).
import { writeFileSync, realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Issue #221: a value-requiring flag present without a value fails loud. */
function readValueArgv(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Issue #221: numeric bench flags must be positive decimal integers — a
 *  bare or non-numeric value used to flow NaN into the row and prompt sizing
 *  (PR #220 review PRR-010). */
function readPositiveInt(argv, i, flag) {
  const raw = readValueArgv(argv, i, flag);
  // Decimal digits only (issue #221 Design: mirror the sibling parseInt
  // contracts): hex, exponent, and padded spellings must never be silently
  // reinterpreted into a different measurement value.
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
  const args = { 'max-tokens': 128, threads: 8, 'prompt-tokens': 64 };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--model': args.model = argv[++i]; break;
      case '--gguf': args.gguf = argv[++i]; break;
      case '--quant': args.quant = argv[++i]; break;
      case '--threads': args.threads = readPositiveInt(argv, i, '--threads'); i += 1; break;
      case '--max-tokens': args['max-tokens'] = readPositiveInt(argv, i, '--max-tokens'); i += 1; break;
      case '--prompt-tokens': args['prompt-tokens'] = readPositiveInt(argv, i, '--prompt-tokens'); i += 1; break;
      case '--json': args.json = argv[++i]; break;
      case '--profile': args.profile = argv[++i]; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  for (const key of ['model', 'gguf']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

export async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // Issue #221: CLI parse errors fail loud with exit 2 (the batch
    // convention); runtime failures keep the exit-1 path below.
    console.error(`[node_bench_driver] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { LlamaEngine } = await import(
    pathToFileURL(path.join(repoRoot, 'desktop', 'dist', 'main', 'backend', 'inference', 'llama-engine.js')).href
  );
  // PRR-115: reject unknown profile values instead of silently fast-falling —
  // a typo would otherwise record a different configuration into the same
  // registered identity cell.
  if (args.profile !== undefined && args.profile !== 'quality' && args.profile !== 'fast') {
    throw new Error(`--profile must be 'quality' or 'fast' (got: ${args.profile})`);
  }
  const engine = new LlamaEngine({
    // #156: the profile carries the tier's chat policy (the quality tier's
    // reasoning suppression is part of its shipping configuration), so a row
    // measured for the quality model must run under the quality profile.
    // The measured policy is recorded on stdout as profile=... in the engine
    // metrics line; append_results has no profile column (disclosed).
    profile: args.profile === 'quality' ? 'quality' : 'fast',
    models: {
      fast: path.resolve(repoRoot, args.gguf),
      quality: path.resolve(repoRoot, args.gguf),
    },
    threads: args.threads,
  });

  // Warmup: loads the resident model and primes the sampler path.
  const warm = await engine.query('Reply with exactly: OK');
  if (!warm.answer || warm.answer.trim().length === 0) {
    throw new Error('warmup generation produced no answer');
  }

  // Measured run: stream tokens; decode tok/s counts tokens after the first
  // (first-token latency is reported separately).
  const tokens = [];
  let firstTokenAt = 0;
  const started = performance.now();
  const sentences = Math.max(4, Math.floor(args['max-tokens'] / 12));
  const measured = await engine.query(
    `Write a ${sentences}-sentence story about a maintenance technician fixing a conveyor belt. Do not stop early.`,
    {
      streamCallback: (token) => {
        if (firstTokenAt === 0) firstTokenAt = performance.now();
        tokens.push(token);
      },
    },
  );
  const doneAt = performance.now();
  await engine.dispose();

  if (!measured.answer || measured.answer.trim().length === 0 || tokens.length === 0) {
    throw new Error('measured generation produced no output');
  }
  const decodeSeconds = (doneAt - firstTokenAt) / 1000;
  const decodeTokS = tokens.length > 1 ? (tokens.length - 1) / decodeSeconds : tokens.length;
  const firstTokenMs = Math.max(0, firstTokenAt - started);
  const machine = process.env.BENCH_MACHINE_TAG ?? 'devstation';

  const row = {
    surface: 'native',
    model: args.model,
    quant: args.quant ?? 'Q4_K_M',
    threads: args.threads,
    prompt_tokens: args['prompt-tokens'],
    decode_tokens_per_second: Number(decodeTokS.toFixed(2)),
    first_token_ms: Number(firstTokenMs.toFixed(1)),
    peak_rss_mb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
    machine,
    outcome: 'pass',
    engine: 'node-llama-cpp',
    engine_version: require(
      path.join(repoRoot, 'desktop', 'node_modules', 'node-llama-cpp', 'package.json'),
    ).version,
  };
  const line = JSON.stringify(row);
  if (args.json) writeFileSync(args.json, `${line}\n`, 'utf8');
  console.log(line);
}

// Entry guard (issue #216 AC5): importing this module must not run the
// benchmark; only direct execution drives the CLI.
if (isMain(import.meta.url)) {
  main().then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (err) => {
      console.error(`[node_bench_driver] FAILED: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
}
