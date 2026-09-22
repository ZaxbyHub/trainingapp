// Issue #57 spike: drives the INSTALLED slice exes and measures the ADR-0003
// comparison matrix on the dev station. Writes raw per-slice result JSONs;
// write-evidence.mjs distills them into the committed eval/ artifacts.
//
// Usage (per slice):
//   node spike/measure/measure.mjs --slice node \
//     --exe "<installDir>/SpikeNodeBackend.exe" \
//     --install-dir "<installDir>" \
//     --out spike/measure/results/node.json \
//     [--port 8791] [--models <dir>]
//
// Metrics per slice: install_size_mb, cold_start_s (median of 3 spawns,
// spawn -> /health 200), first_token_latency_s + decode_tok_s + token_count
// on a ~2k-token prompt, peak_rss_mb (Working Set - Peak over the process
// tree after generation), cancellation latency (client disconnect -> server
// [metrics] status=cancelled stdout line, plus CPU-idle confirmation).
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = undefined) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const slice = arg('--slice');
const exePath = arg('--exe');
const installDir = arg('--install-dir');
const outPath = arg('--out');
const port = Number(arg('--port', '8791'));
const modelsDir = arg('--models') ?? path.join(os.homedir(), '.trainingapp', 'models');

if (!slice || !exePath || !installDir || !outPath) {
  console.error('usage: measure.mjs --slice node|python --exe <exe> --install-dir <dir> --out <json> [--port N] [--models dir]');
  process.exit(2);
}

const PROMPT_TARGET_TOKENS = 2048;
const CHARS_PER_TOKEN = 4;
const FILLER = 'The monitoring rotation policy assigns reviewers weekly and requires written handoff notes. ';
const QUESTION_TAIL = ' Ignore the filler notes above and answer in one short paragraph: what two desktop backend shapes does ADR-0003 compare, and which model is the Quality profile? ';

function buildQuestion() {
  // Instruction-first: pad to ~2k tokens with quoted filler, then ask the
  // real question LAST so the model is primed to answer at generation length.
  const fixed = FILLER.length + QUESTION_TAIL.length + 40;
  const units = Math.max(1, Math.ceil((PROMPT_TARGET_TOKENS * CHARS_PER_TOKEN - fixed) / FILLER.length));
  return (
    'Answer the question after the notes. NOTES BEGIN: ' +
    FILLER.repeat(units) +
    ' NOTES END. ' +
    QUESTION_TAIL
  );
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function waitReady(url, deadlineMs, stdout) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await get(url);
        if (r.status === 200) return resolve(Date.now() - start);
      } catch {
        /* not ready yet */
      }
      if (Date.now() > start + deadlineMs) {
        reject(new Error(`not ready in ${deadlineMs}ms; stdout tail: ${stdout.slice(-800)}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function postStream(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = '';
      let firstTokenMs = null;
      let tokens = 0;
      let terminal = null;
      const started = Date.now();
      if (res.statusCode !== 200) {
        // Non-SSE error response (e.g. JSON 400/503): capture body, no stream.
        let errBody = '';
        res.on('data', (c) => (errBody += c));
        res.on('end', () => resolve({ status: res.statusCode, error: errBody.slice(0, 300), tokens: 0, terminal: null, totalMs: 0, firstTokenMs: null }));
        return;
      }
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (;;) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 4);
          if (!frame.startsWith('data: ')) continue;
          let evt;
          try {
            evt = JSON.parse(frame.slice(6));
          } catch {
            continue;
          }
          if (evt.token) {
            // count only non-empty chunks (empty frames are protocol noise)
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            tokens += 1;
          }
          if (evt.done || evt.error) terminal = evt;
        }
      });
      res.on('end', () => resolve({ firstTokenMs, tokens, terminal, totalMs: Date.now() - started }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function descendantPids(rootPid) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference='SilentlyContinue'; $all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $frontier=@(${rootPid}); $seen=@{}; while($frontier.Count){ $next=@(); foreach($p in $all){ if(-not $seen.ContainsKey([int]$p.ProcessId) -and $frontier -contains [int]$p.ParentProcessId){ $seen[[int]$p.ProcessId]=$true; $next+=[int]$p.ProcessId; } }; $frontier=$next; }; ($seen.Keys | ForEach-Object { "$_" }) -join ','`,
      ],
      { timeout: 30000 },
      (err, stdout) => resolve(err ? [] : stdout.toString().trim().split(',').filter(Boolean).map(Number))
    );
  });
}

function peakWorkingSetMB(pids) {
  return new Promise((resolve) => {
    if (!pids.length) return resolve(0);
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference='SilentlyContinue'; $ps=Get-Process | Where-Object { @(${pids.join(',')}) -contains $_.Id }; ($ps | Measure-Object -Property PeakWorkingSet64 -Maximum).Maximum / 1MB`,
      ],
      { timeout: 30000 },
      (err, stdout) => resolve(err ? 0 : Number(stdout.toString().trim()) || 0)
    );
  });
}

async function stageModels() {
  if (fs.existsSync(path.join(modelsDir, 'gemma-4-e2b-it', 'model.gguf')) && fs.existsSync(path.join(modelsDir, 'bge-small-en-v1.5', 'onnx', 'model.onnx'))) {
    return 'pre-staged';
  }
  const repoModels = path.resolve('models');
  fs.mkdirSync(path.join(modelsDir, 'gemma-4-e2b-it'), { recursive: true });
  fs.mkdirSync(path.join(modelsDir, 'bge-small-en-v1.5'), { recursive: true });
  fs.copyFileSync(path.join(repoModels, 'gemma-4-e2b-it', 'model.gguf'), path.join(modelsDir, 'gemma-4-e2b-it', 'model.gguf'));
  fs.cpSync(path.join(repoModels, 'bge-small-en-v1.5'), path.join(modelsDir, 'bge-small-en-v1.5'), { recursive: true });
  return 'copied-from-repo';
}

async function main() {
  console.log(`measure[${slice}]: staging models at ${modelsDir}`);
  const staging = await stageModels();
  const installSizeMb = dirSizeBytes(installDir) / (1024 * 1024);
  const results = { slice, models_staging: staging, install_size_mb: Number(installSizeMb.toFixed(1)), cold_starts_ms: [], runs: {} };

  // Cold start: median of 3 spawn->ready cycles.
  for (let i = 0; i < 3; i++) {
    const proc = spawn(exePath, [], {
      env: { ...process.env, TRAININGAPP_SPIKE_PORT: String(port), TRAININGAPP_SPIKE_MODELS: modelsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stdout += d));
    const readyMs = await waitReady(`http://127.0.0.1:${port}/health`, 180000, stdout);
    results.cold_starts_ms.push(readyMs);
    console.log(`measure[${slice}]: cold start ${i + 1}/3 = ${readyMs} ms`);
    proc.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }
  results.cold_start_s = Number((results.cold_starts_ms.sort((a, b) => a - b)[1] / 1000).toFixed(3));

  // Full run: fresh spawn, RSS capture, 2k-prompt stream, cancellation probe.
  const proc = spawn(exePath, [], {
    env: { ...process.env, TRAININGAPP_SPIKE_PORT: String(port), TRAININGAPP_SPIKE_MODELS: modelsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  proc.stdout.on('data', (d) => {
    stdout += d;
    process.stdout.write(`[app] ${d}`);
  });
  proc.stderr.on('data', (d) => {
    stdout += d;
    process.stderr.write(`[app!] ${d}`);
  });
  await waitReady(`http://127.0.0.1:${port}/health`, 180000, stdout);
  const rootPid = proc.pid;
  const pids = [rootPid, ...(await descendantPids(rootPid))];
  console.log(`measure[${slice}]: process tree pids=${pids.join(',')}`);

  // Warm-up ask (LLM load) excluded from first-token metric; then the measured run.
  const warm = await postStream(`http://127.0.0.1:${port}/ask/stream`, { question: 'warmup: reply with the word ready.' });
  if (warm.error || warm.terminal?.error || warm.terminal?.cancelled) {
    // Slice cannot stream (documented packaging failure): record and measure
    // only the non-generation metrics. Honesty over completeness.
    console.log(`measure[${slice}]: LLM FAILED: ${JSON.stringify(warm.error ?? warm.terminal).slice(0, 300)}`);
    results.runs.ask_2k = { failed: true, error: String(warm.error ?? warm.terminal?.error ?? 'llm unavailable').slice(0, 300) };
    results.runs.cancellation = { failed: true, reason: 'LLM unavailable' };
    results.peak_rss_mb = Number((await peakWorkingSetMB([rootPid, ...(await descendantPids(rootPid))])).toFixed(1));
    results.measured_at_utc = new Date().toISOString();
    results.models_dir = modelsDir;
    results.port = port;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`measure[${slice}]: wrote ${outPath} (LLM-failed mode)`);
    proc.kill();
    return;
  }

  const question = buildQuestion();
  const ask = await postStream(`http://127.0.0.1:${port}/ask/stream`, { question });
  // The server's own [metrics] line is the authoritative metric source.
  const serverLine = (() => {
    const matches = stdout.match(/\[metrics\] status=done[^\n]*/g);
    return matches ? matches[matches.length - 1] : null;
  })();
  const num = (re) => {
    if (!serverLine) return null;
    const m = serverLine.match(re);
    return m ? Number(m[1]) : null;
  };
  const sTokens = num(/tokens=(\d+)/);
  const sFirstMs = num(/first_token_ms=(\d+)/);
  const sInferenceMs = num(/inference_ms=(\d+)/);
  const genTokens = sTokens ?? ask.tokens;
  const genSpanMs = sInferenceMs ?? ask.totalMs;
  results.runs.ask_2k = {
    prompt_chars: question.length,
    prompt_tokens_estimate: Math.round(question.length / CHARS_PER_TOKEN),
    first_token_latency_s: Number(((sFirstMs ?? ask.firstTokenMs ?? 0) / 1000).toFixed(3)),
    decode_tok_s: Number((genTokens / (genSpanMs / 1000)).toFixed(2)),
    token_count: genTokens,
    done_terminal: Boolean(ask.terminal?.done),
    cancelled: Boolean(ask.terminal?.cancelled),
    grounding: ask.terminal?.grounding ?? null,
    total_ms: ask.totalMs,
    server_metrics_line: serverLine,
  };
  console.log(`measure[${slice}]: ask_2k = ${JSON.stringify(results.runs.ask_2k)}`);

  // Cancellation: destroy the socket mid-generation; watch stdout for the
  // server-side cancelled metrics line.
  const cancelStart = Date.now();
  const cancelResult = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/ask/stream`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    req.end(JSON.stringify({ question: 'count slowly: explain the full RAG pipeline in detail.' }));
    let got = 0;
    req.on('response', (res) => {
      res.on('data', () => {
        got += 1;
        if (got >= 10) {
          req.destroy();
          resolve({ disconnectedAt: Date.now() });
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => resolve({ disconnectedAt: Date.now(), note: 'never reached 10 tokens' }), 120000);
  });
  const metricsLine = await new Promise((resolve) => {
    const deadline = Date.now() + 30000;
    const tick = () => {
      const m = stdout.match(/\[metrics\] status=cancelled[^\n]*/);
      if (m) return resolve({ line: m[0], observedAt: Date.now() });
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
  let cpuIdleConfirmS = null;
  if (metricsLine) {
    // Confirm CPU work stopped: total CPU seconds of the tree must plateau.
    const c1 = await treeCpuSeconds(pids);
    await new Promise((r) => setTimeout(r, 2000));
    const c2 = await treeCpuSeconds(pids);
    cpuIdleConfirmS = Number((c2 - c1).toFixed(3));
  }
  results.runs.cancellation = {
    disconnect_to_server_stop_ms: metricsLine ? metricsLine.observedAt - cancelResult.disconnectedAt : null,
    metrics_line: metricsLine?.line ?? null,
    cpu_delta_after_2s: cpuIdleConfirmS,
    stopped_within_5s: cpuIdleConfirmS !== null && cpuIdleConfirmS < 0.5,
  };
  console.log(`measure[${slice}]: cancellation = ${JSON.stringify(results.runs.cancellation)}`);

  results.peak_rss_mb = Number((await peakWorkingSetMB(pids)).toFixed(1));
  console.log(`measure[${slice}]: peak_rss_mb = ${results.peak_rss_mb}`);
  proc.kill();
  await new Promise((r) => setTimeout(r, 1000));

  results.measured_at_utc = new Date().toISOString();
  results.models_dir = modelsDir;
  results.port = port;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`measure[${slice}]: wrote ${outPath}`);
}

function treeCpuSeconds(pids) {
  return new Promise((resolve) => {
    if (!pids.length) return resolve(0);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `$ErrorActionPreference='SilentlyContinue'; $ps=Get-Process | Where-Object { @(${pids.join(',')}) -contains $_.Id }; ($ps | Measure-Object -Property CPU -Sum).Sum`],
      { timeout: 30000 },
      (err, stdout) => resolve(err ? 0 : Number(stdout.toString().trim()) || 0)
    );
  });
}

main().catch((err) => {
  console.error(`measure[${slice}]: FAILED`, err);
  process.exit(1);
});
