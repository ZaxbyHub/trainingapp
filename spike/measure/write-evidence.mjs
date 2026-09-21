// Issue #57 spike: distills the raw measurement JSONs + CI run info into the
// committed eval/ artifacts. MACHINE-WRITTEN - never hand-edited (the frozen
// acceptance checks pin ADR numbers to these files byte-for-byte).
//
// Usage:
//   node spike/measure/write-evidence.mjs \
//     --node spike/measure/results/node.json \
//     --python spike/measure/results/python.json \
//     --probe spike/measure/results/probe.json \
//     --ci-node <run-url> --ci-python <run-url> \
//     --installer-node <exe> --installer-python <exe> \
//     --ci-runs-node "<P>/<T> runs green (run ids ...)" \
//     --ci-runs-python "<P>/<T> runs green (run ids ...)" \
//     --commit <git-sha> [--script-sha <sha256>]
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const req = (name) => {
  const v = arg(name);
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return v;
};

const node = JSON.parse(fs.readFileSync(req('--node'), 'utf8'));
const py = JSON.parse(fs.readFileSync(req('--python'), 'utf8'));
const probe = JSON.parse(fs.readFileSync(req('--probe'), 'utf8'));
const ciNodeUrl = req('--ci-node');
const ciPyUrl = req('--ci-python');
const exeNode = req('--installer-node');
const exePy = req('--installer-python');
const ciRunsNode = req('--ci-runs-node');
const ciRunsPy = req('--ci-runs-python');
const commit = req('--commit');
const scriptSha = arg('--script-sha') ?? sha256(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const reproduced = /outcome=REPRODUCED/.test(probe.leg_a ?? '');

const matrix = {
  schema: 'adr0003-matrix/1',
  metrics: {
    install_size_mb: { node: node.install_size_mb, 'python-sidecar': py.install_size_mb },
    cold_start_s: { node: node.cold_start_s, 'python-sidecar': py.cold_start_s },
    first_token_latency_s: {
      node: node.runs.ask_2k.first_token_latency_s,
      'python-sidecar': py.runs.ask_2k.first_token_latency_s,
    },
    decode_tok_s: { node: node.runs.ask_2k.decode_tok_s, 'python-sidecar': py.runs.ask_2k.decode_tok_s },
    peak_rss_mb: { node: node.peak_rss_mb, 'python-sidecar': py.peak_rss_mb },
    ci_build_reliability: { node: ciRunsNode, 'python-sidecar': ciRunsPy },
    cancellation_stop: {
      node: `${node.runs.cancellation.disconnect_to_server_stop_ms ?? -1} ms (${
        node.runs.cancellation.stopped_within_5s ? 'CPU idle confirmed within 5 s' : 'CPU stop NOT confirmed'
      })`,
      'python-sidecar': `${py.runs.cancellation.disconnect_to_server_stop_ms ?? -1} ms (${
        py.runs.cancellation.stopped_within_5s ? 'CPU idle confirmed within 5 s' : 'CPU stop NOT confirmed'
      })`,
    },
  },
  reranker_local_files_only_reproduced: reproduced,
  provenance: {
    measured_at_utc: node.measured_at_utc,
    machine: { tag: 'devstation', os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model ?? 'unknown' },
    git_commit: commit,
    script_sha256: scriptSha,
    raw: { node: req('--node'), python: req('--python'), probe: req('--probe') },
  },
};

function sliceEvidence(res, exe, ciUrl) {
  const cancelLatencyMs = res.runs.cancellation.disconnect_to_server_stop_ms;
  return {
    installer: {
      filename: exe.split(/[\\/]/).pop(),
      sha256: sha256(exe),
      size_bytes: fs.statSync(exe).size,
      ci_run_url: ciUrl,
    },
    streamed_answer: {
      streamed: res.runs.ask_2k.done_terminal && res.runs.ask_2k.token_count > 0,
      token_count: res.runs.ask_2k.token_count,
      done_event: res.runs.ask_2k.done_terminal,
      grounding: res.runs.ask_2k.grounding ?? 'general',
    },
    cancellation: { stop_latency_s: Number(((cancelLatencyMs ?? 0) / 1000).toFixed(3)) },
  };
}

const evidence = {
  schema: 'adr0003-e2e-evidence/1',
  machine: {
    tag: 'devstation',
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length}C/${os.cpus().length * 2}T)`,
    ram: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))} GB`,
    os: `${os.type()} ${os.release()} build ${process.env.OS_BUILD ?? '10.0.26200'}`,
    gpu: process.env.SPIKE_GPU ?? 'Intel Arc Pro B50 (CPU-inference spike; GPU unused)',
    reference_i5_status: 'PENDING - reference laptop not available to this session; a materially different laptop result reopens the decision (ADR-0002:192 pattern)',
  },
  slices: {
    node: sliceEvidence(node, exeNode, ciNodeUrl),
    'python-sidecar': sliceEvidence(py, exePy, ciPyUrl),
  },
  reranker_probe: probe,
  provenance: matrix.provenance,
};

fs.mkdirSync('eval', { recursive: true });
fs.writeFileSync('eval/adr0003-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
fs.writeFileSync('eval/adr0003-e2e-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log('write-evidence: wrote eval/adr0003-matrix.json and eval/adr0003-e2e-evidence.json');
