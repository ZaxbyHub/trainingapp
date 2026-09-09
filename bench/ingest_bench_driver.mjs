#!/usr/bin/env node
// B6 bench driver (issue #64): measure the SHIPPING desktop ingest pipeline
// (pdf extract -> chunk -> ONNX embed -> sqlite-vec store write) over a
// deterministic N-page synthetic PDF generated in-process — no staged
// fixtures, no network — and emit one JSON row compatible with
// `bench/append_results.py` (surface=desktop-ingest). The `engine` column
// records `transformers.js+onnxruntime-node` so the row names the real
// embedder stack it measured.
//
// Usage (from repo root, after `npm --prefix desktop run compile`):
//   node bench/ingest_bench_driver.mjs --pages 200 [--json row.json]
// Machine tag: BENCH_MACHINE_TAG env (default devstation).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distModule = (...segments) =>
  pathToFileURL(path.join(repoRoot, 'desktop', 'dist', ...segments)).href;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--pages': args.pages = Number.parseInt(argv[++i], 10); break;
      case '--json': args.json = argv[++i]; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isInteger(args.pages) || args.pages < 1) {
    throw new Error('--pages is required and must be a positive integer');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Deterministic synthetic PDF (minimal, valid, zero dependencies): one /Page
// per requested page, each with a content stream of 15 text lines x 12 words.
// The page number is IN the text, so extraction is verifiable from the store.
// All bytes are ASCII, so string length == byte length for xref offsets.
// ---------------------------------------------------------------------------

const PDF_WORDS = Object.freeze([
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango',
  'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu',
]);

function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** The 15 deterministic text lines for a 1-based page number. */
function pageLines(pageNumber) {
  const lines = [];
  for (let line = 1; line <= 15; line += 1) {
    const words = ['page', String(pageNumber), 'line', String(line)];
    for (let w = 0; w < 8; w += 1) {
      words.push(PDF_WORDS[(pageNumber * 31 + line * 17 + w * 7) % PDF_WORDS.length]);
    }
    lines.push(words.join(' '));
  }
  return lines;
}

/** Content stream: BT /F1 10 Tf 72 720 Td 12 TL (l1) Tj T* (l2) Tj ... ET */
function pageContentStream(pageNumber) {
  const lines = pageLines(pageNumber);
  const parts = ['BT', '/F1 10 Tf', '72 720 Td', '12 TL'];
  for (let i = 0; i < lines.length; i += 1) {
    parts.push(`(${pdfEscape(lines[i])}) Tj`);
    if (i < lines.length - 1) parts.push('T*');
  }
  parts.push('ET');
  return parts.join(' ');
}

/**
 * Build the complete PDF as a string with a correct xref table.
 * Object layout: 1 Catalog, 2 Pages, 3 Font, 4..N+3 Page objects,
 * N+4..2N+3 content streams.
 */
function buildBenchPdf(pageCount) {
  const totalObjects = 2 * pageCount + 3;
  const bodies = new Array(totalObjects);
  const kids = [];
  for (let p = 0; p < pageCount; p += 1) kids.push(`${4 + p} 0 R`);
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  bodies[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let p = 0; p < pageCount; p += 1) {
    bodies[3 + p] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageCount + 4 + p} 0 R >>`;
  }
  for (let p = 0; p < pageCount; p += 1) {
    const stream = pageContentStream(p + 1);
    bodies[pageCount + 3 + p] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const parts = ['%PDF-1.4\n'];
  const offsets = new Array(totalObjects + 1);
  let pos = parts[0].length;
  for (let num = 1; num <= totalObjects; num += 1) {
    offsets[num] = pos;
    const chunk = `${num} 0 obj\n${bodies[num - 1]}\nendobj\n`;
    parts.push(chunk);
    pos += chunk.length;
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= totalObjects; num += 1) {
    xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  }
  return parts.join('') + xref + `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const machine = process.env.BENCH_MACHINE_TAG ?? 'devstation';

  // The COMPILED production modules (same pattern as node_bench_driver.mjs).
  const { IngestPipeline } = await import(distModule('main', 'backend', 'ingest', 'pipeline.js'));
  const embedderMod = await import(distModule('main', 'backend', 'ingest', 'embedder.js'));
  const { resolveIngestConfig } = await import(distModule('main', 'backend', 'ingest', 'config.js'));
  const { openStore } = await import(distModule('main', 'backend', 'store', 'sqlite-store.js'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-ingest-bench-'));
  let store = null;
  let embedder = null;
  try {
    const pdfPath = path.join(tmpDir, `bench-${args.pages}p.pdf`);
    fs.writeFileSync(pdfPath, buildBenchPdf(args.pages), 'utf8');
    if (fs.statSync(pdfPath).size < 1024) throw new Error('synthetic PDF is suspiciously small');

    store = openStore({ dbPath: path.join(tmpDir, 'store.sqlite'), repoRoot });
    try {
      embedder = embedderMod.resolveEmbedder({ dims: store.dims, repoRoot });
    } catch {
      // resolveEmbedder's repo-walk discovery can miss exotic dist layouts;
      // the staged models/ dir is this bench's contract, so fall back to an
      // explicit OnnxEmbedder over it.
      embedder = new embedderMod.OnnxEmbedder(
        path.join(repoRoot, 'models', embedderMod.DEFAULT_EMBEDDING_MODEL_SUBPATH),
      );
    }
    const config = resolveIngestConfig({}); // frozen defaults
    let progressEvents = 0;
    const pipeline = new IngestPipeline({
      store,
      embedder,
      config,
      onProgress: () => {
        progressEvents += 1;
      },
    });

    // Measured region: the ingest ONLY (PDF synthesis, store init, embedder
    // resolution, and model load on first embed are part of the pipeline's
    // own first-ingest cost; process setup is not).
    const started = performance.now();
    const result = await pipeline.ingestFile({
      name: pdfPath,
      data: new Uint8Array(fs.readFileSync(pdfPath)),
    });
    const totalSeconds = (performance.now() - started) / 1000;

    if (!result.success) {
      console.error(`[ingest_bench_driver] ingest failed: ${result.message ?? 'unknown error'}`);
      process.exitCode = 1;
      return;
    }
    if (result.chunks_added <= 0) {
      console.error('[ingest_bench_driver] ingest succeeded but added 0 chunks');
      process.exitCode = 1;
      return;
    }
    if (progressEvents < 5) {
      console.error(`[ingest_bench_driver] expected >= 5 progress events, saw ${progressEvents}`);
      process.exitCode = 1;
      return;
    }
    if (totalSeconds >= 60) {
      console.error(`B6-BENCH: FAIL ${totalSeconds.toFixed(1)}s >= 60s budget`);
      process.exitCode = 1;
      return;
    }

    const row = {
      surface: 'desktop-ingest',
      machine,
      model: embedderMod.DEFAULT_EMBEDDING_MODEL_SUBPATH,
      pages: args.pages,
      chunks: result.chunks_added,
      total_s: Number(totalSeconds.toFixed(2)),
      embeddings_per_second: Number((result.chunks_added / totalSeconds).toFixed(1)),
      outcome: 'pass',
      engine: 'transformers.js+onnxruntime-node',
    };
    const line = JSON.stringify(row);
    if (args.json) fs.writeFileSync(args.json, `${line}\n`, 'utf8');
    console.log(line);
    console.log(
      `B6-BENCH: PASS ${args.pages} pages in ${totalSeconds.toFixed(1)}s (${result.chunks_added} chunks)`,
    );
  } finally {
    try {
      await embedder?.dispose?.();
    } catch {
      // Best-effort teardown; the forced exit below never lets it hang us.
    }
    try {
      store?.close();
    } catch {
      // Best-effort teardown.
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort teardown (temp dir under os.tmpdir()).
    }
  }
}

function scheduleForcedExit() {
  // onnxruntime-node may keep worker threads alive past dispose; exit once
  // stdout/stderr have drained. The timer is unref'd, so a process whose
  // event loop drained naturally still exits on its own with process.exitCode.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
}

main().then(
  () => scheduleForcedExit(),
  (err) => {
    console.error(`[ingest_bench_driver] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    scheduleForcedExit();
  },
);
