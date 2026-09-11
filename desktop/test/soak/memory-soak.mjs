#!/usr/bin/env node
// memory-soak.mjs — B8 soak/measurement harness (issue #66, S9 / AC1).
//
// Boots the REAL desktop backend host (node mode: NodeBackendHost with the
// B8 memory governance stack, real B4 inference when weights are staged,
// real B6/B7 ingest + retrieval otherwise) and runs a sustained
// ingest+query workload while sampling GET /telemetry/memory every cycle.
//
// What it proves (exit code):
//   0 — the host survived the whole sustained workload (no OOM/crash) and
//       every telemetry sample had the documented shape;
//   1 — the host crashed, an error path fired, or a sample was malformed.
// Whether the pressure downgrade TRIGGERED is workload-dependent (it needs
// free RAM below memory.pressureThresholdGb for memory.pressureSustainedMs)
// and is REPORTED, not asserted — the harness reports what it observed.
//
// Memory constraint (AC1's "~6 GB free"): --target-free-gb ballast-allocates
// anonymous buffers until os.freemem() is at/below the target so the
// downgrade path can be exercised on machines with headroom. SAFETY: the
// harness refuses to ballast when the machine's TOTAL RAM is below
// --min-total-gb (default 12 GB), and never allocates on behalf of a machine
// it might starve. Reference-laptop runs need no ballast at ~6 GB free.
//
// Usage (from the repo root; compile first):
//   npm --prefix desktop run compile
//   node desktop/test/soak/memory-soak.mjs [--duration-s 60] [--target-free-gb 6]
//        [--model-dir <dir>] [--docs 12] [--queries-per-cycle 1] [--report <file>]
//
// Flags:
//   --duration-s <n>        sustained workload seconds (default 60)
//   --target-free-gb <gb>   ballast until os.freemem() <= this (0 = no ballast)
//   --min-total-gb <gb>     refuse to ballast below this total RAM (default 12)
//   --docs <n>              number of generated documents to ingest (default 12)
//   --queries-per-cycle <n> concurrent /ask calls per cycle (default 1)
//   --model-dir <dir>       TRAININGAPP_INFERENCE_MODEL_DIR override
//   --embedder hash         force the deterministic hash embedder (no weights)
//   --report <file>         write the telemetry log + verdict JSON here
//
// Reference-laptop procedure (AC1): see desktop/test/soak/README.md.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const REPO_ROOT = (() => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('repo root not found (contracts/api.openapi.yaml marker missing)');
})();

function parseArgs(argv) {
  const args = {
    durationS: 60,
    targetFreeGb: 0,
    minTotalGb: 12,
    docs: 12,
    queriesPerCycle: 1,
    modelDir: undefined,
    embedderHash: false,
    report: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === '--duration-s') args.durationS = Number(next());
    else if (flag === '--target-free-gb') args.targetFreeGb = Number(next());
    else if (flag === '--min-total-gb') args.minTotalGb = Number(next());
    else if (flag === '--docs') args.docs = Number(next());
    else if (flag === '--queries-per-cycle') args.queriesPerCycle = Number(next());
    else if (flag === '--model-dir') args.modelDir = next();
    else if (flag === '--embedder' && next() === 'hash') args.embedderHash = true;
    else if (flag === '--report') args.report = next();
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

const logLines = [];
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  logLines.push(stamped);
}

const GIB = 1024 ** 3;
const ballast = [];

function applyBallast(targetFreeBytes) {
  let guard = 0;
  while (os.freemem() > targetFreeBytes && guard < 4096) {
    guard += 1;
    // 256 MiB chunks: anonymous, untouched (never written) — the OS counts
    // them against free RAM only as they are committed by touch-free
    // reservation on Windows; write one byte per chunk to force commit.
    const chunk = Buffer.alloc(256 * 1024 * 1024);
    chunk[0] = 1;
    ballast.push(chunk);
    if (os.freemem() <= targetFreeBytes) break;
  }
  log(`ballast: ${ballast.length} chunks, free now ${(os.freemem() / GIB).toFixed(2)} GiB`);
}

function request(port, token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: apiPath,
        method,
        headers: {
          'X-Desktop-Token': token,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(300_000, () => {
      req.destroy(new Error('request timed out after 300s'));
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`soak start: duration=${args.durationS}s docs=${args.docs} queriesPerCycle=${args.queriesPerCycle} targetFreeGb=${args.targetFreeGb}`);

  // ---- memory constraint (AC1) ------------------------------------------
  const totalGb = os.totalmem() / GIB;
  if (args.targetFreeGb > 0) {
    if (totalGb < args.minTotalGb) {
      log(`SAFETY: total RAM ${totalGb.toFixed(1)} GB < min-total-gb ${args.minTotalGb}; refusing to ballast`);
    } else {
      applyBallast(args.targetFreeGb * GIB);
    }
  }

  // ---- real host (node mode) --------------------------------------------
  // Windows: absolute-path dynamic imports must be file:// URLs.
  const dist = path.join(REPO_ROOT, 'desktop', 'dist', 'main', 'backend');
  const { createBackendHost, resolveNodeEngine } = await import(
    pathToFileURL(path.join(dist, 'index.js')).href
  );

  const token = crypto.randomBytes(24).toString('hex');
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-soak-store-'));
  const events = [];
  const env = { ...process.env };
  if (args.embedderHash) env.TRAININGAPP_DESKTOP_EMBEDDER = 'hash';
  if (args.modelDir !== undefined) env.TRAININGAPP_INFERENCE_MODEL_DIR = args.modelDir;

  const host = createBackendHost({
    token,
    tokenHeaderName: 'X-Desktop-Token',
    allowedOrigins: ['app://*'],
    mode: 'node',
    env,
    engine: resolveNodeEngine(env),
    storePath: path.join(storeDir, 'store.sqlite'),
    onIngestProgress: () => {},
    onMemoryEvent: (event) => {
      events.push(event);
      log(`memory event: ${JSON.stringify(event)}`);
    },
  });
  const handle = await host.start();
  log(`host up: mode=${handle.mode} port=${handle.port} (free RAM at boot ${(os.freemem() / GIB).toFixed(2)} GiB)`);

  // Generated corpus: unique per-run content (content-hash identity would
  // dedupe identical docs) with enough text for many chunks per doc.
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-soak-docs-'));
  for (let d = 0; d < args.docs; d += 1) {
    const words = [];
    for (let w = 0; w < 4000; w += 1) {
      words.push(`${crypto.randomBytes(4).toString('hex')}`);
    }
    fs.writeFileSync(path.join(docsDir, `soak-doc-${d}.txt`), words.join(' '), 'utf8');
  }

  let sawDowngrade = false;
  let cycles = 0;
  let errors = 0;
  const startedAt = Date.now();
  const deadline = startedAt + args.durationS * 1000;
  let docIndex = 0;

  try {
    while (Date.now() < deadline) {
      cycles += 1;
      // Ingest: one fresh directory pass per few cycles (new content each
      // pass keeps the embed-heavy work real instead of a dedupe no-op).
      if (cycles % 3 === 1 && docIndex < args.docs * 2) {
        const passDir = path.join(docsDir, `pass-${docIndex}`);
        fs.mkdirSync(passDir, { recursive: true });
        for (let k = 0; k < Math.min(4, args.docs); k += 1) {
          const words = [];
          for (let w = 0; w < 3000; w += 1) words.push(crypto.randomBytes(4).toString('hex'));
          fs.writeFileSync(path.join(passDir, `doc-${docIndex}-${k}.txt`), words.join(' '), 'utf8');
        }
        docIndex += 1;
        const ingestStart = Date.now();
        const ingest = await request(handle.port, token, 'POST', '/ingest', { directory: passDir });
        log(`cycle ${cycles}: ingest pass-${docIndex - 1} -> ${ingest.status} (${Date.now() - ingestStart} ms)`);
        if (ingest.status !== 200) errors += 1;
      }

      // Queries: sustained generation load alongside ingestion.
      const queryStart = Date.now();
      const queries = Array.from({ length: args.queriesPerCycle }, (_, q) =>
        request(handle.port, token, 'POST', '/ask', { question: `soak cycle ${cycles} query ${q}: summarize the ingested documents` })
          .then((r) => {
            if (r.status !== 200) log(`cycle ${cycles}: /ask -> ${r.status}: ${r.body.slice(0, 140)}`);
            return r.status;
          })
          .catch((err) => {
            errors += 1;
            log(`cycle ${cycles}: /ask error: ${err.message}`);
            return 0;
          }),
      );
      await Promise.all(queries);
      log(`cycle ${cycles}: queries done (${Date.now() - queryStart} ms)`);

      // Telemetry sample: shape-assert every snapshot (the AC1 "no OOM +
      // documented telemetry shape" evidence).
      const telemetry = await request(handle.port, token, 'GET', '/telemetry/memory');
      if (telemetry.status !== 200) {
        errors += 1;
        log(`cycle ${cycles}: TELEMETRY ERROR ${telemetry.status}`);
      } else {
        const body = JSON.parse(telemetry.body);
        const s = body.snapshot ?? {};
        const fields = [
          'chromiumRssMb', 'llmRssMb', 'embeddingSessionRssMb',
          'rerankerSessionRssMb', 'sqliteRssMb', 'systemFreeMb', 'systemTotalMb',
        ];
        const malformed = fields.some((f) => typeof s[f] !== 'number' || !Number.isFinite(s[f]) || s[f] < 0);
        if (malformed || typeof body.downgrade?.downgraded !== 'boolean') {
          errors += 1;
          log(`cycle ${cycles}: MALFORMED TELEMETRY ${telemetry.body.slice(0, 200)}`);
        } else {
          log(
            `cycle ${cycles}: telemetry rss {chromium:${s.chromiumRssMb.toFixed(0)} llm:${s.llmRssMb.toFixed(0)} ` +
              `embed:${s.embeddingSessionRssMb.toFixed(1)} rerank:${s.rerankerSessionRssMb.toFixed(1)} ` +
              `sqlite:${s.sqliteRssMb.toFixed(1)}} free:${s.systemFreeMb.toFixed(0)}MB ` +
              `total:${s.systemTotalMb.toFixed(0)}MB profile:${body.downgrade.effectiveProfile} downgraded:${body.downgrade.downgraded}`,
          );
          if (body.downgrade.downgraded) sawDowngrade = true;
        }
      }
    }
  } finally {
    const finalTelemetry = await request(handle.port, token, 'GET', '/telemetry/memory').catch(() => null);
    if (finalTelemetry?.status === 200) {
      log(`final telemetry: ${finalTelemetry.body}`);
    }
    await host.stop().catch((err) => log(`host.stop error: ${err.message}`));
  }

  const verdict = {
    cycles,
    errors,
    sawDowngrade,
    survived: errors === 0,
    durationS: args.durationS,
    freeRssAtEndMb: (os.freemem() / (1024 * 1024)).toFixed(0),
    events,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      totalRamGb: +(os.totalmem() / GIB).toFixed(1),
      platform: `${os.platform()} ${os.release()}`,
    },
  };
  log(`soak end: cycles=${cycles} errors=${errors} sawDowngrade=${sawDowngrade} -> ${errors === 0 ? 'PASS' : 'FAIL'}`);
  if (args.report !== undefined) {
    fs.writeFileSync(args.report, `${logLines.join('\n')}\n\n${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
    log(`report written: ${args.report}`);
  }
  process.exitCode = errors === 0 ? 0 : 1;
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
