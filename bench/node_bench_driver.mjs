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
// Machine tag: BENCH_MACHINE_TAG env (default devstation).
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { 'max-tokens': 128, threads: 8, 'prompt-tokens': 64 };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--model': args.model = argv[++i]; break;
      case '--gguf': args.gguf = argv[++i]; break;
      case '--quant': args.quant = argv[++i]; break;
      case '--threads': args.threads = Number.parseInt(argv[++i], 10); break;
      case '--max-tokens': args['max-tokens'] = Number.parseInt(argv[++i], 10); break;
      case '--prompt-tokens': args['prompt-tokens'] = Number.parseInt(argv[++i], 10); break;
      case '--json': args.json = argv[++i]; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  for (const key of ['model', 'gguf']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { LlamaEngine } = await import(
    pathToFileURL(path.join(repoRoot, 'desktop', 'dist', 'main', 'backend', 'inference', 'llama-engine.js')).href
  );
  const engine = new LlamaEngine({
    profile: 'fast',
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

main().catch((err) => {
  console.error(`[node_bench_driver] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
