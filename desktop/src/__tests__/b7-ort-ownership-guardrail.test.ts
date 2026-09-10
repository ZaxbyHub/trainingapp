/**
 * B7 guardrail (issue #65): SINGLE-THREAD ORT OWNERSHIP.
 *
 * onnxruntime-node 1.21 aborts the whole process (exit 134) when the same
 * module is used from the main thread AND a user worker thread. The B7 fix
 * concentrates ALL native ONNX work (embedding + reranking) inside the one
 * rerank worker (`retrieval/rerank-worker.ts`); the main thread only talks to
 * it through the WorkerEmbedder/WorkerReranker proxies, and the ingest
 * embedder (`ingest/embedder.ts`) remains the only other allowed ONNX owner
 * (it is not used concurrently with the worker — see index.ts wiring).
 *
 * This source scan fails when the transformers.js / onnxruntime-node stack is
 * imported or its model APIs are called OUTSIDE those owner files, or when a
 * second worker thread appears outside the WorkerReranker spawn site.
 * Discovered empirically via repro/mix-probe.mjs (main embed -> worker rerank
 * -> main embed == deterministic OnFatalError abort).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const backendDir = path.resolve(__dirname, '..', '..', 'main', 'backend');

// Files allowed to import/run the native ONNX stack (see module header).
// Forward slashes: compared against rel paths normalized via split(sep).join('/').
const ONNX_OWNER_FILES = new Set(['ingest/embedder.ts', 'retrieval/rerank-worker.ts']);
// The only permitted worker-thread spawn site (owns all ONNX work).
const WORKER_SPAWN_OWNER = 'retrieval/reranker.ts';

const ONNX_API_PATTERN =
  /from_pretrained|pipeline\(|AutoModelForSequenceClassification|AutoTokenizer|InferenceSession|session\.run/;
const ONNX_IMPORT_PATTERN = /import\('@huggingface\/transformers'\)|from 'onnxruntime-node'|require\('onnxruntime-node'\)/;
const WORKER_SPAWN_PATTERN = /new Worker\(/;

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relativeSource(file: string): { rel: string; lines: string[] } {
  return {
    rel: path.relative(backendDir, file).split(path.sep).join('/'),
    lines: readFileSync(file, 'utf8').split(/\r?\n/),
  };
}

describe('B7 single-thread ORT ownership guardrail (issue #65)', () => {
  it('keeps every ONNX model API call inside the owner files', () => {
    const violations: string[] = [];
    for (const file of listTypeScriptFiles(backendDir)) {
      const { rel, lines } = relativeSource(file);
      if (ONNX_OWNER_FILES.has(rel)) continue;
      lines.forEach((line, index) => {
        if (ONNX_API_PATTERN.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, `ONNX API calls outside owner files:\n${violations.join('\n')}`).toEqual([]);
  });

  it('keeps every transformers.js / onnxruntime-node import inside the owner files', () => {
    const violations: string[] = [];
    for (const file of listTypeScriptFiles(backendDir)) {
      const { rel, lines } = relativeSource(file);
      if (ONNX_OWNER_FILES.has(rel)) continue;
      lines.forEach((line, index) => {
        if (ONNX_IMPORT_PATTERN.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, `ONNX stack imports outside owner files:\n${violations.join('\n')}`).toEqual([]);
  });

  it('allows worker threads only at the reranker spawn site', () => {
    const violations: string[] = [];
    for (const file of listTypeScriptFiles(backendDir)) {
      const { rel, lines } = relativeSource(file);
      lines.forEach((line, index) => {
        if (WORKER_SPAWN_PATTERN.test(line) && rel !== WORKER_SPAWN_OWNER) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, `worker spawns outside ${WORKER_SPAWN_OWNER}:\n${violations.join('\n')}`).toEqual([]);
  });
});
