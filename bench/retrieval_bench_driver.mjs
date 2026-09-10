#!/usr/bin/env node
// B7 bench driver (issue #65): measure the SHIPPING desktop hybrid retrieval
// pipeline end-to-end — boot the compiled desktop host (real bge-small embed +
// ettin-reranker-32m-v1 rerank in the worker thread), ingest eval/corpus over
// /ingest, then time sequential POST /search round trips over the in-corpus
// eval questions and emit one JSON row compatible with
// `bench/append_results.py` (surface=desktop-retrieval). Timings are full
// round trips over loopback HTTP, so they include the whole stack: query
// embed -> vec0 KNN + FTS5 legs -> RRF fuse -> rerank top-30 -> floor/slice.
// The first (cold) query — reranker worker spawn + model load — is part of
// the measured distribution, matching real interactive usage.
//
// Requires: `npm --prefix desktop run compile` and staged weights
// (models/bge-small-en-v1.5 required; models/ettin-reranker-32m-v1 optional —
// without it the row records reranker=none and the budget still applies).
//
// Usage (from repo root):
//   node bench/retrieval_bench_driver.mjs --queries 20 [--json row.json]
// Machine tag: BENCH_MACHINE_TAG env (default devstation).
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const P95_BUDGET_MS = 1500;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--queries': args.queries = Number.parseInt(argv[++i], 10); break;
      case '--json': args.json = argv[++i]; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isInteger(args.queries) || args.queries < 1) {
    throw new Error('--queries is required and must be a positive integer');
  }
  return args;
}

function percentile(values, pct) {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 1) return ordered[0];
  const pos = ((ordered.length - 1) * pct) / 100;
  const low = Math.floor(pos);
  const high = Math.min(low + 1, ordered.length - 1);
  const frac = pos - low;
  return ordered[low] * (1 - frac) + ordered[high] * frac;
}

function loadInCorpusQuestions() {
  const raw = fs.readFileSync(path.join(repoRoot, 'eval', 'questions.jsonl'), 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const row = JSON.parse(trimmed);
    if (row.expected_doc_id !== null && row.expected_doc_id !== undefined) rows.push(row);
  }
  return rows;
}

const children = [];
function killChildren() {
  for (const child of children.splice(0).reverse()) {
    try { child.kill(); } catch { /* gone */ }
    if (IS_WIN && child.pid && child.exitCode === null) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
    }
  }
}

function waitForPortFile(portFile, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(portFile)) {
      const port = Number.parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`host did not write its port within ${timeoutMs}ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve weights the same way the host's resolvers do: explicit env first,
  // then the repo's staged models/ dir. The embedder is REQUIRED (no staged
  // weights means nothing to measure); the reranker is optional (row records
  // reranker=none, retrieval degrades to RRF-only in the host under test).
  const embedderDir =
    process.env.TRAININGAPP_EMBEDDING_MODEL_DIR ?? path.join(repoRoot, 'models', 'bge-small-en-v1.5');
  if (!fs.existsSync(path.join(embedderDir, 'onnx', 'model.onnx'))) {
    throw new Error(`embedder weights not staged: ${embedderDir} (run scripts/prepare-models.mjs)`);
  }
  let rerankerDir = process.env.TRAININGAPP_RERANKER_MODEL_DIR ?? null;
  if (rerankerDir === null) {
    const candidate = path.join(repoRoot, 'models', 'ettin-reranker-32m-v1');
    if (fs.existsSync(path.join(candidate, 'onnx', 'model.onnx'))) rerankerDir = candidate;
  }

  // The exact retrieval config the host under test will resolve (defaults or
  // the operator's TRAININGAPP_RETRIEVAL_* overrides) — recorded in the row.
  const configUrl = pathToFileURL(
    path.join(repoRoot, 'desktop', 'dist', 'main', 'backend', 'retrieval', 'config.js'),
  ).href;
  const { resolveRetrievalConfig } = await import(configUrl);
  const retrievalConfig = resolveRetrievalConfig(process.env);

  const work = fs.mkdtempSync(path.join(process.env.TEMP ?? repoRoot, 'retrieval-bench-'));
  try {
    const token = `bench-${process.pid}-${Date.now()}`;
    const portFile = path.join(work, 'port.txt');
    const storePath = path.join(work, 'store.sqlite');
    const env = { ...process.env };
    env.TRAININGAPP_EMBEDDING_MODEL_DIR = embedderDir;
    if (rerankerDir !== null) env.TRAININGAPP_RERANKER_MODEL_DIR = rerankerDir;
    delete env.TRAININGAPP_DESKTOP_EMBEDDER;
    delete env.TRAININGAPP_DESKTOP_ENGINE;
    const host = spawn(
      process.execPath,
      [
        path.join(repoRoot, 'desktop', 'dist', 'main', 'backend', 'dev-server.js'),
        '--port-file', portFile,
        '--mode', 'node',
        '--token', token,
        '--store-path', storePath,
      ],
      { cwd: repoRoot, env, stdio: ['pipe', 'inherit', 'inherit'] },
    );
    children.push(host);
    const hostPort = waitForPortFile(portFile, 30000);
    const headers = { 'content-type': 'application/json', 'x-desktop-token': token };
    const base = `http://127.0.0.1:${hostPort}`;
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const res = await fetch(`${base}/health`, { headers });
        if (res.status === 200) break;
      } catch { /* not accepting yet */ }
      if (Date.now() > deadline) throw new Error('host did not become healthy within 30s');
      await new Promise((r) => setTimeout(r, 100));
    }

    const ingest = await fetchJson(`${base}/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ directory: path.join(repoRoot, 'eval', 'corpus') }),
    });
    if (ingest.status !== 200 || !ingest.body || ingest.body.documents !== 8) {
      throw new Error(`ingest failed status=${ingest.status} body=${JSON.stringify(ingest.body)}`);
    }
    console.log(
      `[retrieval_bench_driver] ingested ${ingest.body.documents} docs / ${ingest.body.chunks_added} chunks`,
    );

    const corpusBasenames = new Set(
      fs.readdirSync(path.join(repoRoot, 'eval', 'corpus')).filter((name) => name.endsWith('.md')),
    );
    const questions = loadInCorpusQuestions().slice(0, args.queries);
    if (questions.length < args.queries) {
      throw new Error(`only ${questions.length} in-corpus eval questions available, need ${args.queries}`);
    }

    const latencies = [];
    for (const question of questions) {
      const started = performance.now();
      const res = await fetchJson(`${base}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: question.question, n_results: 5 }),
      });
      const ms = performance.now() - started;
      latencies.push(ms);
      if (res.status !== 200 || !Array.isArray(res.body) || res.body.length < 1) {
        throw new Error(`search failed query="${question.id}" status=${res.status}`);
      }
      for (const row of res.body) {
        const source = typeof row.source === 'string' ? row.source.replace(/\\/g, '/').split('/').pop() : null;
        if (!source || !corpusBasenames.has(source)) {
          throw new Error(`non store-backed row query="${question.id}" source=${JSON.stringify(row.source)}`);
        }
      }
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = Math.max(...latencies);
    console.log(
      `[retrieval_bench_driver] ${latencies.length} /search round trips; ` +
        `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );
    const outcome = p95 <= P95_BUDGET_MS ? 'pass' : 'fail';
    const row = {
      surface: 'desktop-retrieval',
      machine: process.env.BENCH_MACHINE_TAG ?? 'devstation',
      embedder: path.basename(embedderDir),
      reranker: rerankerDir === null ? 'none' : path.basename(rerankerDir),
      topk: retrievalConfig.topK,
      multiplier: retrievalConfig.candidateMultiplier,
      p50_ms: Math.round(p50),
      p95_ms: Math.round(p95),
      max_ms: Math.round(max),
      outcome,
    };
    const rendered = JSON.stringify(row, null, 2);
    if (args.json) fs.writeFileSync(args.json, rendered);
    console.log(rendered);
    process.exitCode = outcome === 'pass' ? 0 : 1;
  } finally {
    killChildren();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().then(
  () => {
    // onnxruntime-node may keep the child's worker threads alive past kill;
    // the child is force-killed above, so just make sure WE exit.
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  },
  (err) => {
    console.error(`[retrieval_bench_driver] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 250).unref();
  },
);
