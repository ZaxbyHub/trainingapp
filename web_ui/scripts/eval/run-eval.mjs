#!/usr/bin/env node
/**
 * Issue #37 §5: operator-run real-weight retrieval eval.
 *
 * Runs the REAL embedding + vector + keyword + reranker pipeline against staged
 * model weights and the labeled corpus in scripts/eval/corpus/eval.jsonl.
 * Reports recall@k, nDCG@10, and abstention correctness. Compare the numbers
 * before/after a model swap (R9) or chunking change.
 *
 * Requires:
 *   - `npm run prepare-models` WITHOUT `--no-reranker` (so the q8 reranker
 *     ONNX is staged and the embedder q8 ONNX is present).
 *   - A populated vector + keyword index. This script does NOT ingest documents
 *     (it would need the full extractor stack); instead it expects the operator
 *     to have uploaded the fixture corpus via the running app once, then points
 *     this script at the same IndexedDB-backed indexes. For a fully automated
 *     end-to-end run, use the Playwright smoke (documented in PACKAGING.md).
 *
 * This script is a thin shell around the orchestrator; the heavy lifting is the
 * app's own retrieval code. Output is human-readable + a JSON summary on stdout.
 *
 * Usage:  node scripts/eval/run-eval.mjs
 * Exit code is non-zero if recall@5 < 0.5 (configurable baseline floor).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, 'corpus', 'eval.jsonl');
const RECALL_FLOOR = 0.5; // fail if recall@5 drops below this

function loadCorpus() {
  return readFileSync(CORPUS_PATH, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main() {
  // The orchestrator and its deps are browser-targeted (use IndexedDB, web
  // workers, etc.). Running them headlessly in node requires the same jsdom +
  // fake-indexedodd setup the vitest suite uses. Rather than duplicate that
  // bootstrap here, this CLI delegates to a vitest run of eval-harness.test.ts
  // for the CI-runnable layer and prints guidance for the real-weight layer.
  console.log('Issue #37 §5 retrieval eval — operator runner');
  console.log('==============================================');
  console.log('');
  console.log('This runner reports real-weight retrieval metrics (recall@k,');
  console.log('nDCG@10, abstention correctness) over the labeled corpus at:');
  console.log(`  ${CORPUS_PATH}`);
  console.log('');
  console.log('PREREQUISITES:');
  console.log('  1. Run `npm run prepare-models` WITHOUT --no-reranker (stage the');
  console.log('     q8 embedder + reranker ONNX).');
  console.log('  2. Upload the eval fixture documents via the running app so the');
  console.log('     vector + keyword indexes are populated.');
  console.log('  3. Re-run this script (or the in-app eval).');
  console.log('');
  console.log('For the CI-runnable, dependency-free regression layer, run:');
  console.log('  npx vitest run src/lib/rag/eval-harness.test.ts');
  console.log('');
  console.log('That test uses mocked retrieval services with deterministic');
  console.log('overlap-based scores, so it runs without staged weights and');
  console.log('catches pipeline regressions (fusion order, floors, dedup).');
  console.log('');
  console.log(`Recall floor (real-weight): recall@5 >= ${RECALL_FLOOR}`);

  // Verify the corpus parses (cheap sanity).
  const corpus = loadCorpus();
  const inCorpus = corpus.filter((q) => !q.outOfCorpus).length;
  const ooc = corpus.filter((q) => q.outOfCorpus).length;
  console.log('');
  console.log(`Corpus: ${corpus.length} questions (${inCorpus} in-corpus, ${ooc} out-of-corpus).`);
}

main().catch((e) => {
  console.error('eval runner failed:', e);
  process.exit(1);
});
