"""Tier-0 retrieval-eval parity guard for the desktop host (issue #103 AC2).

RED at base (this module absent), GREEN after the fix: boots the compiled
desktop backend (``dev-server.js --engine stub``) against a temp store seeded
through the real B6 ingest pipeline with the real bge-small embedder AND the
staged ettin reranker (the recorded baseline is a rerank-era measurement),
runs ``eval/runner.py`` over the tier-0 question set through a
token-injecting loopback proxy, and asserts recall@5 and MRR at-or-above the
machine-tagged ``desktop-retrieval-eval`` floors in bench/RESULTS.md — the
recorded weighted-run parity contract inherited from issue #65's C7 check.

Gated on real (non-LFS-pointer) staged weights, a built AND fresh desktop
dist, and floors rows for the current BENCH_FLOORS_MACHINE; CI (no weights)
skips with the staging instruction, like tests/test_rag_performance.py.

The test pins the eval-set identity (60 questions / 9 documents): when the
corpus or question set changes it fails with a re-derivation instruction —
record a fresh weighted run per eval/README.md, refresh
eval/samples/report-devstation-weighted.json alongside the floor rows and
the pins in this file (floor values must stay <= that recorded run's
metrics), and re-run this test.
"""

import http.client
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# Mirrors STAGED_WEIGHTS_MIN_BYTES (desktop/main/backend/ingest/embedder.ts)
# and RERANKER_WEIGHTS_MIN_BYTES (retrieval/reranker.ts): a git-LFS pointer
# (~130 bytes) passes Path.is_file() but is not weights, so file EXISTENCE
# is not a valid gate — size is.
WEIGHTS_MIN_BYTES = 10 * 1024 * 1024

EMBED_ONNX = REPO_ROOT / "models" / "bge-small-en-v1.5" / "onnx" / "model.onnx"
RERANK_ONNX_CANDIDATES = (
    REPO_ROOT / "models" / "ettin-reranker-32m-v1" / "onnx" / "model.onnx",
    REPO_ROOT / "models" / "ettin-reranker-32m-v1" / "onnx" / "model_quantized.onnx",
)
DEV_SERVER = REPO_ROOT / "desktop" / "dist" / "main" / "backend" / "dev-server.js"
MAIN_SRC = REPO_ROOT / "desktop" / "main"

# Eval-set identity pins (see the module docstring's re-derivation contract).
EXPECTED_QUESTIONS = 60
EXPECTED_DOCUMENTS = 9

_STAGING_HINT = "run python bench/fetch_models.py --onnx"
_COMPILE_HINT = "run npm --prefix desktop run compile"


def _real_weights(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size >= WEIGHTS_MIN_BYTES
    except OSError:
        return False


def _has_reranker_weights() -> bool:
    return any(_real_weights(p) for p in RERANK_ONNX_CANDIDATES)


def _floors_value(metric: str):
    """Floor for the current machine tag; None when absent (never invented)."""
    machine = (os.environ.get("BENCH_FLOORS_MACHINE", "") or "").strip()
    if not machine:
        return None
    try:
        from bench.floors import threshold

        found = threshold(
            REPO_ROOT / "bench" / "RESULTS.md",
            "desktop-retrieval-eval",
            "bge-small-en-v1.5",
            metric,
        )
    except Exception:
        return None
    if found is None:
        return None
    value, direction = found
    # The parity contract is metric >= floor; a ceiling row would be a
    # misconfigured fence, not a parity bound.
    return value if direction == "floor" else None


_FLOOR_RECALL5 = _floors_value("recall@5")
_FLOOR_MRR = _floors_value("mrr")

_SKIP_GATES = [
    pytest.mark.skipif(
        not _real_weights(EMBED_ONNX),
        reason=(
            "embedding ONNX weights not staged or still an LFS pointer: "
            f"{EMBED_ONNX.relative_to(REPO_ROOT)} must be >= 10 MiB - {_STAGING_HINT}"
        ),
    ),
    pytest.mark.skipif(
        not _has_reranker_weights(),
        reason=(
            "ettin reranker ONNX weights not staged (rerank defaults on; the "
            "recorded baseline is a rerank-era measurement): "
            "models/ettin-reranker-32m-v1/onnx - " + _STAGING_HINT
        ),
    ),
    pytest.mark.skipif(
        not DEV_SERVER.is_file(),
        reason=f"desktop dist not built: {DEV_SERVER.relative_to(REPO_ROOT)} - {_COMPILE_HINT}",
    ),
    pytest.mark.skipif(
        _FLOOR_RECALL5 is None or _FLOOR_MRR is None,
        reason=(
            "no desktop-retrieval-eval floors rows for BENCH_FLOORS_MACHINE="
            f"{os.environ.get('BENCH_FLOORS_MACHINE', '')!r} in bench/RESULTS.md "
            "(set the machine tag or record rows)"
        ),
    ),
]

# Ambient overrides that would silently skew the measured parity: retrieval
# geometry/flags (retrieval/config.ts), packs recency (same), ingest chunking
# (ingest/config.ts — changes seeded chunks, hence recall/mrr), and the
# stub-token delay (latency only, stripped for determinism).
_SKEWING_OVERRIDES = (
    "TRAININGAPP_RETRIEVAL_TOPK",
    "TRAININGAPP_RETRIEVAL_CANDIDATE_MULTIPLIER",
    "TRAININGAPP_RETRIEVAL_RERANK",
    "TRAININGAPP_RETRIEVAL_RRF_K",
    "TRAININGAPP_RETRIEVAL_RELEVANCE_FLOOR",
    "TRAININGAPP_PACKS_RECENCY_FLOOR",
    "TRAININGAPP_PACKS_RECENCY_FLOOR_MONTHS",
    "TRAININGAPP_PACKS_RECENCY_HALF_LIFE_MONTHS",
    "TRAININGAPP_INGEST_CHUNK_WORD_COUNT",
    "TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS",
    "TRAININGAPP_DESKTOP_RERANKER_STUB",
    "TRAININGAPP_STUB_TOKEN_DELAY_MS",
)


def _sanitized_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k not in _SKEWING_OVERRIDES}
    env["TRAININGAPP_EMBEDDING_MODEL_DIR"] = str(
        REPO_ROOT / "models" / "bge-small-en-v1.5"
    )
    env["TRAININGAPP_RERANKER_MODEL_DIR"] = str(
        REPO_ROOT / "models" / "ettin-reranker-32m-v1"
    )
    env["TRAININGAPP_DESKTOP_EMBEDDER"] = ""
    env["TRAININGAPP_DESKTOP_REPO_ROOT"] = ""
    return env


_SEED_SCRIPT = r"""
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repoRoot = process.env.PARITY_REPO_ROOT;
const dbPath = process.env.PARITY_STORE_PATH;
const dist = (rel) => pathToFileURL(path.join(repoRoot, 'desktop', 'dist', 'main', rel)).href;
const { openStore } = await import(dist('backend/store/sqlite-store.js'));
const { resolveEmbedder } = await import(dist('backend/ingest/embedder.js'));
const { IngestPipeline } = await import(dist('backend/ingest/pipeline.js'));
const { resolveIngestConfig } = await import(dist('backend/ingest/config.js'));
const store = openStore({ dbPath });
let code = 1;
try {
  const embedder = resolveEmbedder({ env: process.env, dims: store.dims, repoRoot });
  const config = resolveIngestConfig(process.env);
  const pipeline = new IngestPipeline({ store, embedder, config });
  const result = await pipeline.ingestDirectory(path.join(repoRoot, 'eval', 'corpus'));
  console.log(JSON.stringify({
    success: result.success,
    documents: result.documents,
    chunks_added: result.chunks_added,
  }));
  code = result.success ? 0 : 1;
} finally {
  store.close();
}
process.exit(code);
"""


def _rederive_message(what: str) -> str:
    return (
        f"{what} — the tier-0 eval set changed. Re-derive the "
        "desktop-retrieval-eval floors: record a fresh weighted run per "
        "eval/README.md, refresh eval/samples/report-devstation-weighted.json "
        "alongside the bench/RESULTS.md floor rows and the pins in this file "
        "(floor values must stay <= that recorded run's metrics), then re-run "
        "this test."
    )


def _assert_dist_fresh() -> None:
    """Hard-fail on a stale desktop dist (lives in the BODY: weightless
    boxes are entitled to the module-level skips, never a hard failure)."""
    newest_src = max(
        (p.stat().st_mtime for p in MAIN_SRC.rglob("*.ts")),
        default=0.0,
    )
    if newest_src > DEV_SERVER.stat().st_mtime:
        pytest.fail(
            "desktop dist is stale (newer desktop/main sources than "
            f"{DEV_SERVER.relative_to(REPO_ROOT)}) — {_COMPILE_HINT}"
        )


def _run_node(script: Path, env: dict, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(script)],
        cwd=REPO_ROOT,
        env=env,
        timeout=timeout,
        capture_output=True,
        text=True,
    )


def _seed_store(work: Path, env: dict, store_path: Path) -> None:
    script = work / "parity-seed.mjs"
    script.write_text(_SEED_SCRIPT, encoding="utf-8")
    seed_env = dict(env)
    seed_env["PARITY_REPO_ROOT"] = str(REPO_ROOT)
    seed_env["PARITY_STORE_PATH"] = str(store_path)
    proc = _run_node(script, seed_env, timeout=300)
    assert (
        proc.returncode == 0
    ), f"seed failed exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
    assert lines, f"seed printed no JSON result\nstdout:\n{proc.stdout}"
    result = json.loads(lines[-1])
    assert result.get("success") is True, f"seed reported failure: {result}"
    documents = result.get("documents")
    assert documents == EXPECTED_DOCUMENTS, _rederive_message(
        f"seed ingested {documents!r} documents, pinned {EXPECTED_DOCUMENTS} "
        "(sanity floor >= 8)"
    )


class _HostProc:
    def __init__(self, proc: subprocess.Popen, port: int):
        self.proc = proc
        self.port = port

    def kill_tree(self) -> None:
        if self.proc.poll() is None:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                    capture_output=True,
                )
            else:
                self.proc.kill()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            pass


def _start_host(work: Path, env: dict, store_path: Path) -> _HostProc:
    token = f"parity-{os.getpid()}-{time.time_ns()}"
    port_file = work / "port.txt"
    out_path = work / "host.out"
    err_path = work / "host.err"
    out_fh = out_path.open("w", encoding="utf-8")
    err_fh = err_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        [
            "node",
            str(DEV_SERVER),
            "--port-file",
            str(port_file),
            "--mode",
            "node",
            "--engine",
            "stub",
            "--token",
            token,
            "--store-path",
            str(store_path),
        ],
        cwd=REPO_ROOT,
        env=env,
        # dev-server.js stops (host.stop + exit 0) when stdin CLOSES — its
        # orphan-prevention backstop. A PIPE that stays open keeps it alive
        # (same shape as the #65 C7 driver's stdio ['pipe','inherit','inherit']).
        stdin=subprocess.PIPE,
        stdout=out_fh,
        stderr=err_fh,
    )

    def _host_failure(what: str) -> AssertionError:
        out_fh.flush()
        err_fh.flush()
        out_text = out_path.read_text(encoding="utf-8", errors="replace")
        err_text = err_path.read_text(encoding="utf-8", errors="replace")
        return AssertionError(
            f"{what} (exit={proc.poll()})\n--- host stdout ---\n{out_text}\n"
            f"--- host stderr ---\n{err_text}"
        )

    deadline = time.monotonic() + 30
    try:
        while not port_file.is_file():
            if proc.poll() is not None:
                raise _host_failure("host exited before writing its port file")
            if time.monotonic() > deadline:
                raise _host_failure("host did not write its port file within 30s")
            time.sleep(0.05)
        port = int(port_file.read_text(encoding="utf-8").strip())
        health_deadline = time.monotonic() + 30
        while True:
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/health",
                    headers={"x-desktop-token": token},
                )
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(req, timeout=5) as res:
                    if res.status == 200:
                        break
            except Exception:
                pass
            if proc.poll() is not None:
                raise _host_failure("host exited before /health became ready")
            if time.monotonic() > health_deadline:
                raise _host_failure("host /health not ready within 30s")
            time.sleep(0.1)
    finally:
        out_fh.close()
        err_fh.close()
    host = _HostProc(proc, port)
    host.token = token  # type: ignore[attr-defined]
    return host


class _TokenProxy(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, upstream_port: int, token: str):
        self.upstream_port = upstream_port
        self.token = token
        super().__init__(("127.0.0.1", 0), _ProxyHandler)


class _ProxyHandler(http.server.BaseHTTPRequestHandler):
    def _forward(self) -> None:
        server: _TokenProxy = self.server  # type: ignore[assignment]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        conn = http.client.HTTPConnection("127.0.0.1", server.upstream_port, timeout=60)
        try:
            headers = {k: v for k, v in self.headers.items() if k.lower() != "host"}
            headers["x-desktop-token"] = server.token
            conn.request(self.command, self.path, body=body, headers=headers)
            res = conn.getresponse()
            payload = res.read()
            self.send_response(res.status)
            for key, value in res.getheaders():
                if key.lower() not in ("transfer-encoding", "connection"):
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass
        finally:
            conn.close()

    do_GET = do_POST = do_PUT = do_DELETE = _forward

    def log_message(self, fmt: str, *args) -> None:  # quiet
        return


def _run_eval(work: Path, env: dict, proxy_port: int) -> dict:
    json_out = work / "report.json"
    report_md = work / "REPORT.md"
    proc = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "eval" / "runner.py"),
            "--base-url",
            f"http://127.0.0.1:{proxy_port}",
            "--label",
            "pytest-parity",
            "--json-out",
            str(json_out),
            "--report",
            str(report_md),
        ],
        cwd=REPO_ROOT,
        env=env,
        timeout=420,
        capture_output=True,
        text=True,
    )
    assert (
        proc.returncode == 0
    ), f"eval runner exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    return json.loads(json_out.read_text(encoding="utf-8"))


@_SKIP_GATES[0]
@_SKIP_GATES[1]
@_SKIP_GATES[2]
@_SKIP_GATES[3]
def test_desktop_retrieval_eval_parity() -> None:
    """Desktop host retrieval stays at parity with the recorded weighted run."""
    _assert_dist_fresh()
    with tempfile.TemporaryDirectory(prefix="i103-parity-") as tmp:
        work = Path(tmp)
        env = _sanitized_env()
        store_path = work / "store.sqlite"
        _seed_store(work, env, store_path)
        host = _start_host(work, env, store_path)
        try:
            proxy = _TokenProxy(host.port, host.token)  # type: ignore[attr-defined]
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            try:
                report = _run_eval(work, env, proxy.server_address[1])
            finally:
                proxy.shutdown()
                proxy.server_close()
        finally:
            host.kill_tree()

    assert (
        report.get("error_count") == 0
    ), f"eval run had errors: {report.get('error_count')}"
    question_count = report.get("question_count")
    assert question_count == EXPECTED_QUESTIONS, _rederive_message(
        f"question_count={question_count!r}, pinned {EXPECTED_QUESTIONS}"
    )
    metrics = report["metrics"]
    recall5 = float(metrics["recall_at_k"]["5"])
    mrr = float(metrics["mrr"])
    assert recall5 >= float(
        _FLOOR_RECALL5
    ), f"recall@5={recall5} below floor {float(_FLOOR_RECALL5)} — retrieval parity regressed"
    assert mrr >= float(
        _FLOOR_MRR
    ), f"mrr={mrr} below floor {float(_FLOOR_MRR)} — retrieval parity regressed"
