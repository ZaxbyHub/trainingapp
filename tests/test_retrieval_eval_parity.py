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

Cluster-B additions (test-batch-oct2026, issues #170/#186): the fast
weights-free ``test_retrieval_config_pinned`` pins the recorded
retrieval-geometry defaults the floors were measured under (config drift
must fail on ANY box, never skip); ``test_backend_stats_document_count``
pins the report's ``backend_stats.document_count`` against the seeded count
(sharing the parity run, weights-gated like its siblings); and
``test_embed_threads_seam_shape`` pins the default-OFF
``TRAININGAPP_DESKTOP_EMBED_THREADS`` determinism seam (issue #170 D1),
which ``_sanitized_env()`` sets to 1 on the measured path.

Issue #205 additions: the parity cache now also caches FAILURES (the second
consumer re-raises the shared exception instead of re-running the ~540s
flow) and re-validates floors/dist preconditions on the cache-hit path
(box-independent pins in ``TestParityCacheSemantics``); the AC14 stats pin
branches on the runner's ``stats_fetch_error`` transport sentinel before
the count pin (``test_transport_message_pin_side_synthetic_report``); and
setting ``TRAININGAPP_PARITY_CAPTURE_DIR`` copies the run's report.json /
REPORT.md / host.err out of the tempdir for recorded-run provenance under
eval/samples/.
"""

import http.client
import http.server
import json
import os
import re
import secrets
import shutil
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
# The host loads the q8/QUANTIZED artifact: the reranker worker hardcodes
# dtype 'q8' (rerank-worker.ts:78), whose suffix maps to model_quantized.onnx,
# and bench/fetch_models.py stages/downloads exactly that file first for
# ettin (candidates[0]) — gating on the full model would skip every correctly
# staged box and never match what the recorded floors were measured with.
RERANK_ONNX_CANDIDATES = (
    REPO_ROOT / "models" / "ettin-reranker-32m-v1" / "onnx" / "model_quantized.onnx",
)
DEV_SERVER = REPO_ROOT / "desktop" / "dist" / "main" / "backend" / "dev-server.js"
MAIN_SRC = REPO_ROOT / "desktop" / "main"

# Eval-set identity pins (see the module docstring's re-derivation contract).
EXPECTED_QUESTIONS = 60
EXPECTED_DOCUMENTS = 9
# The denominator recall@5 and MRR divide over (runner counts rows with a
# non-null expected_doc_id): 54 of the 60 — 4 in-corpus rows target
# eval/corpus/slides/*.json, which desktop ingest cannot load
# (SUPPORTED_EXTENSIONS has no .json), so they are structurally unanswerable
# and are part of the recorded set identity, not a corpus defect.
EXPECTED_IN_CORPUS = 54

_STAGING_HINT = "run python bench/fetch_models.py --onnx"
_COMPILE_HINT = "run npm --prefix desktop run compile"


def _real_weights(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size >= WEIGHTS_MIN_BYTES
    except OSError:
        return False


def _has_reranker_weights() -> bool:
    return any(_real_weights(p) for p in RERANK_ONNX_CANDIDATES)


# The arm/disarm switch: tag set = the guard is armed (lookup failures must
# HARD-FAIL in the body); tag unset = the designed skip for unconfigured boxes
# (CI). Captured at collection like every skipif input.
_MACHINE_TAG = (os.environ.get("BENCH_FLOORS_MACHINE", "") or "").strip()

# Populated by _floors_value when a machine tag IS set but the lookup fails;
# consumed by _assert_floors_armed (fail-closed, never a silent skip).
_FLOORS_BROKEN: dict = {}


def _floors_value(metric: str):
    """Floor for the current machine tag; None when absent (never invented).

    Failure modes are deliberately distinguished: no machine tag -> None
    (designed skip for weightless/unconfigured boxes), but once a tag IS
    set, a broken import/fence/key/direction must NOT read as "absent" —
    the test body hard-fails in that case (see _assert_floors_armed), so a
    malformed bench-floors fence can never silently disarm the guard.
    """
    if not _MACHINE_TAG:
        return None
    try:
        from bench.floors import threshold

        found = threshold(
            REPO_ROOT / "bench" / "RESULTS.md",
            "desktop-retrieval-eval",
            "bge-small-en-v1.5",
            metric,
        )
    except Exception as exc:
        _FLOORS_BROKEN[f"import/lookup error for {metric}"] = repr(exc)
        return None
    if found is None:
        _FLOORS_BROKEN[f"no floor row for {metric}"] = (
            "surface/model/metric key miss or unparsable value in the "
            "bench-floors fence"
        )
        return None
    value, direction = found
    # The parity contract is metric >= floor; a ceiling row would be a
    # misconfigured fence, not a parity bound.
    if direction != "floor":
        _FLOORS_BROKEN[f"direction of {metric}"] = f"direction={direction!r}"
        return None
    return value


def _assert_floors_armed() -> None:
    """Fail closed when the machine tag is set but the lookup failed."""
    if _MACHINE_TAG and (_FLOOR_RECALL5 is None or _FLOOR_MRR is None):
        pytest.fail(
            f"floors rows missing/broken for BENCH_FLOORS_MACHINE={_MACHINE_TAG!r} "
            f"({_FLOORS_BROKEN or 'rows absent'}); fix the bench-floors fence "
            "in bench/RESULTS.md — an armed parity guard must fail, not skip"
        )


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
        not _MACHINE_TAG,
        reason=(
            "BENCH_FLOORS_MACHINE not set (unconfigured box; record "
            "bench-floors rows for this machine to arm the parity guard)"
        ),
    ),
]

# Ambient overrides that would silently skew the measured parity: retrieval
# geometry/flags (retrieval/config.ts), packs recency (same), ingest chunking
# (ingest/config.ts — changes seeded chunks, hence recall/mrr), the
# stub-token delay (latency only, stripped for determinism), security-posture
# seams the host resolves from env (pack-extract.ts, server.ts cors, the
# airgap flag — a differently-postured host is a differently-measured host),
# and proxy env (httpx honors HTTP_PROXY/HTTPS_PROXY/ALL_PROXY by default and
# would route the loopback metric path off-box on a proxied machine).
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
    "TRAININGAPP_PACKS_REQUIRE_SIGNATURE",
    "TRAININGAPP_PACKS_TRUSTED_KEYS",
    "TRAININGAPP_DESKTOP_DEV_ORIGINS",
    "TRAININGAPP_AIRGAP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
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
    # D1 (issue #170): pin ONNX session threading to 1 intra-op thread on the
    # measured path (seed ingest embeds, host query embeds, rerank worker
    # sessions) — parallel intra-op float reduction reorders accumulation, so
    # the default multithreaded sessions are not run-to-run deterministic.
    # The TRAININGAPP_DESKTOP_EMBED_THREADS seam (ingest/embed-threads.ts) is
    # default-OFF for production; this is the parity host opting in. Being an
    # explicit SET, it also wins over any ambient value on this box.
    env["TRAININGAPP_DESKTOP_EMBED_THREADS"] = "1"
    return env


# --- AC12 (issue #170): weights-free retrieval-geometry config pin ----------

RETRIEVAL_CONFIG_TS = (
    REPO_ROOT / "desktop" / "main" / "backend" / "retrieval" / "config.ts"
)

# The recorded defaults the desktop-retrieval-eval floors were measured under
# (config.ts DEFAULT_RETRIEVAL_CONFIG; relevanceFloor resolves to the
# ADR-0007 calibrated floor). Values are pinned as the SOURCE literals the
# parser extracts, so any drift in the declared defaults trips the pin.
_PINNED_RETRIEVAL_DEFAULTS = {
    "topK": "10",
    "candidateMultiplier": "3",
    "rerank": "true",
    "rrfK": "60",
}
_PINNED_RELEVANCE_FLOOR_EXPR = "CALIBRATED_RELEVANCE_FLOOR"
_PINNED_CALIBRATED_RELEVANCE_FLOOR = 0.569387  # ADR-0007 `floor:` line


def _config_drift_message(key: str, got: object, pinned: object) -> str:
    """Re-derive-style failure naming the drifted key and both values."""
    return (
        f"retrieval config drift: {key} is {got!r}, the recorded default is "
        f"{pinned!r} — the desktop-retrieval-eval floors were measured under "
        "the recorded geometry. Re-derive: record a fresh weighted run per "
        "eval/README.md, refresh eval/samples/report-devstation-weighted.json "
        "and the bench/RESULTS.md floor rows alongside the pins in this file, "
        "then re-run this test."
    )


def _parse_retrieval_config_defaults() -> dict:
    """Deterministically parse config.ts's exported frozen defaults.

    No cross-language constants seam exists between tests/ and the desktop
    TS sources, so the values are parsed from the config SOURCE the host
    resolves its env-independent defaults from (deterministic regex parse of
    the two exported declarations, the same pattern as
    tests/test_issue156_llm_swap.py) — never a parallel hand-typed copy that
    can drift.
    """
    assert (
        RETRIEVAL_CONFIG_TS.is_file()
    ), f"required surface missing: {RETRIEVAL_CONFIG_TS.relative_to(REPO_ROOT)}"
    text = RETRIEVAL_CONFIG_TS.read_text(encoding="utf-8")
    floor_decl = re.search(
        r"export const CALIBRATED_RELEVANCE_FLOOR\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*;",
        text,
    )
    assert (
        floor_decl
    ), "CALIBRATED_RELEVANCE_FLOOR export not found in retrieval/config.ts"
    defaults_decl = re.search(
        r"export const DEFAULT_RETRIEVAL_CONFIG[^=]*=\s*Object\.freeze\(\s*\{",
        text,
    )
    assert (
        defaults_decl
    ), "DEFAULT_RETRIEVAL_CONFIG export not found in retrieval/config.ts"
    rest = text[defaults_decl.end() :]
    close = rest.find("})")
    assert close != -1, "DEFAULT_RETRIEVAL_CONFIG literal is not terminated by })"
    fields: dict = {}
    for match in re.finditer(r"(\w+)\s*:\s*([^,\n]+)", rest[:close]):
        fields[match.group(1)] = match.group(2).strip()
    assert fields, "DEFAULT_RETRIEVAL_CONFIG parsed to an empty object literal"
    return {"calibrated_floor": float(floor_decl.group(1)), "fields": fields}


def test_retrieval_config_pinned() -> None:
    """AC12 (issue #170): the effective retrieval configuration equals the
    recorded defaults the floors were measured under.

    Weights-free and gate-free BY DESIGN: geometry drift must fail on any
    box (CI included), never ride a weights-gated skip.
    """
    parsed = _parse_retrieval_config_defaults()
    fields = parsed["fields"]
    for key, pinned in _PINNED_RETRIEVAL_DEFAULTS.items():
        assert fields.get(key) == pinned, _config_drift_message(
            key, fields.get(key), pinned
        )
    floor_expr = fields.get("relevanceFloor")
    assert floor_expr == _PINNED_RELEVANCE_FLOOR_EXPR, _config_drift_message(
        "relevanceFloor", floor_expr, _PINNED_RELEVANCE_FLOOR_EXPR
    )
    floor = parsed["calibrated_floor"]
    assert floor == pytest.approx(
        _PINNED_CALIBRATED_RELEVANCE_FLOOR, rel=1e-9
    ), _config_drift_message(
        "CALIBRATED_RELEVANCE_FLOOR", floor, _PINNED_CALIBRATED_RELEVANCE_FLOOR
    )


# --- D1 seam unit pin (issue #170) -------------------------------------------

_SEAM_PROBE_SCRIPT = r"""
const { embedSessionOptions } = await import(process.env.SEAM_MODULE_URL);
const shape = (value) => (value === undefined ? null : value);
process.stdout.write(JSON.stringify({
  set1: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1' }, 4)),
  set2: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '2' }, 4)),
  unset: shape(embedSessionOptions({}, 4)),
  empty: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '' }, 4)),
  zero: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '0' }, 4)),
  junk: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: 'abc' }, 4)),
  huge: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '999999999' }, 4)),
  above: shape(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '5' }, 4)),
}));
"""


@pytest.mark.skipif(
    not DEV_SERVER.is_file(),
    reason=f"desktop dist not built: {DEV_SERVER.relative_to(REPO_ROOT)} - {_COMPILE_HINT}",
)
def test_embed_threads_seam_shape() -> None:
    """D1 seam unit pin (issue #170): embedSessionOptions returns the pinned
    session shape when TRAININGAPP_DESKTOP_EMBED_THREADS is a positive
    integer and NOTHING (undefined) when unset/empty/invalid — the
    default-OFF contract keeping production behavior byte-identical without
    the env var."""
    _assert_dist_fresh()
    module_url = (
        REPO_ROOT
        / "desktop"
        / "dist"
        / "main"
        / "backend"
        / "ingest"
        / "embed-threads.js"
    ).as_uri()
    with tempfile.TemporaryDirectory(prefix="i103-seam-") as tmp:
        script = Path(tmp) / "seam-probe.mjs"
        script.write_text(_SEAM_PROBE_SCRIPT, encoding="utf-8")
        env = {**os.environ, "SEAM_MODULE_URL": module_url}
        proc = _run_node(script, env, timeout=60)
    assert (
        proc.returncode == 0
    ), f"seam probe failed exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    results = json.loads(proc.stdout.strip().splitlines()[-1])
    assert results["set1"] == {
        "intraOpNumThreads": 1,
        "interOpNumThreads": 1,
        "executionMode": "sequential",
    }
    assert results["set2"] == {
        "intraOpNumThreads": 2,
        "interOpNumThreads": 1,
        "executionMode": "sequential",
    }
    # Issue #204 AC6 (secondary coverage of the clamp): oversized pins clamp
    # to the injected coreCount and never forward the raw value to ORT.
    assert results["huge"] == {
        "intraOpNumThreads": 4,
        "interOpNumThreads": 1,
        "executionMode": "sequential",
    }, f"999999999 must clamp to coreCount, got {results['huge']!r}"
    assert (
        results["above"]["intraOpNumThreads"] == 4
    ), f"coreCount+1 must clamp to coreCount, got {results['above']!r}"
    for unset_key in ("unset", "empty", "zero", "junk"):
        assert results[unset_key] is None, (
            f"embedSessionOptions leaked a session_options object for a "
            f"{unset_key!r} env: {results[unset_key]!r} — the seam must stay "
            "default-OFF (no session_options key when the env var does not "
            "name a positive integer)"
        )


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
    # utf-8 (not the locale codec) so a non-ASCII byte can never raise
    # before the diagnostic assert; errors=replace keeps stdout/stderr
    # readable on any box. TimeoutExpired is converted to a diagnostic
    # failure — the raw exception carries no captured output.
    try:
        return subprocess.run(
            ["node", str(script)],
            cwd=REPO_ROOT,
            env=env,
            timeout=timeout,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as exc:
        partial_out = (
            (exc.stdout or b"").decode("utf-8", "replace")
            if isinstance(exc.stdout, bytes)
            else (exc.stdout or "")
        )
        raise AssertionError(
            f"node seed timed out after {timeout}s (no captured completion)\n{partial_out}"
        ) from None


def _seed_store(work: Path, env: dict, store_path: Path) -> None:
    script = work / "parity-seed.mjs"
    script.write_text(_SEED_SCRIPT, encoding="utf-8")
    seed_env = dict(env)
    seed_env["PARITY_REPO_ROOT"] = str(REPO_ROOT)
    seed_env["PARITY_STORE_PATH"] = str(store_path)
    proc = _run_node(script, seed_env, timeout=240)
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
        "(exact identity pin; recursive ingest counts every supported file "
        "under eval/corpus including slides/PROVENANCE.md)"
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
                    timeout=30,
                )
            else:
                self.proc.kill()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            pass


def _start_host(work: Path, env: dict, store_path: Path) -> _HostProc:
    token = f"parity-{secrets.token_hex(16)}"
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
        # The port file is child-written; poll-then-parse has a truncate
        # window, so a bad read reports through _host_failure, not ValueError.
        try:
            port = int(port_file.read_text(encoding="utf-8").strip())
        except (ValueError, OSError) as exc:
            raise _host_failure(f"unparseable port file ({exc!r})") from None
        health_deadline = time.monotonic() + 30
        last_health_error: Exception | None = None
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
            except Exception as exc:
                # Keep the client-side cause: a permanent 401/proxy error
                # must be distinguishable from startup ConnectionRefused.
                last_health_error = exc
            if proc.poll() is not None:
                raise _host_failure("host exited before /health became ready")
            if time.monotonic() > health_deadline:
                raise _host_failure(
                    "host /health not ready within 30s "
                    f"(last client error: {last_health_error!r})"
                )
            time.sleep(0.1)
    except BaseException:
        # A raise anywhere above leaves a LIVE node host behind (the caller
        # never receives `host`, so its kill_tree cannot run). Tear it down
        # here: closing stdin triggers the dev-server's own backstop, and the
        # explicit kill covers a host that ignores EOF.
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except OSError:
            pass
        if proc.poll() is None:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=30,
                )
            else:
                proc.kill()
        raise
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
    # Hardening for the hand-rolled proxy: validate the request boundary
    # (malformed/negative Content-Length must 400, not raise or read until
    # EOF), cap the buffered body, and never forward hop-by-hop or duplicate
    # framing headers upstream (send_response already emits Server/Date).
    _MAX_BODY_BYTES = 64 * 1024 * 1024

    def _forward(self) -> None:
        server: _TokenProxy = self.server  # type: ignore[assignment]
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send_response(400)
            self.end_headers()
            return
        length = max(0, min(length, self._MAX_BODY_BYTES))
        body = self.rfile.read(length) if length else None
        conn = http.client.HTTPConnection("127.0.0.1", server.upstream_port, timeout=60)
        try:
            headers = {
                k: v
                for k, v in self.headers.items()
                if k.lower() not in ("host", "content-length", "transfer-encoding")
            }
            headers["x-desktop-token"] = server.token
            conn.request(self.command, self.path, body=body, headers=headers)
            res = conn.getresponse()
            payload = res.read()
            self.send_response(res.status)
            for key, value in res.getheaders():
                if key.lower() not in (
                    "transfer-encoding",
                    "connection",
                    "date",
                    "server",
                ):
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
    # Budget: 240s + the 30/30s host waits + 240s seed = 540s worst case,
    # deliberately under CI's per-test 600s cap (test.yml --timeout=600) so
    # an outer timeout can never destroy the metric evidence first.
    try:
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
            timeout=240,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as exc:
        partial_out = (
            (exc.stdout or b"").decode("utf-8", "replace")
            if isinstance(exc.stdout, bytes)
            else (exc.stdout or "")
        )
        raise AssertionError(
            f"eval runner timed out after 240s\n{partial_out}"
        ) from None
    assert (
        proc.returncode == 0
    ), f"eval runner exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    return json.loads(json_out.read_text(encoding="utf-8"))


# The parity flow is expensive (weights-gated seed + host boot + full
# 60-question eval), so it runs ONCE per process and the parsed report is
# cached: the metric pins and the AC14 backend_stats pin share one measured
# run (test-batch-oct2026 cluster B). A FAILED first execution is cached the
# same way (issue #205 AC1): the second consumer re-raises the shared
# exception object instead of re-running a ~540s flow that is already known
# to be broken (or racing the first attempt's teardown).
_PARITY_RUN: dict = {}


def _cached_host_stderr_tail() -> str:
    text = _PARITY_RUN.get("host_err", "")
    return "--- host stderr (tail) ---\n" + text[-4000:]


# Issue #205 B4: opt-in artifact capture for the recorded run — when set, the
# flow copies its report.json / REPORT.md / host.err out of the tempdir so a
# recorded-run's evidence can be committed under eval/samples/. Unset (the
# default, CI included) this is a no-op.
_PARITY_CAPTURE_ENV = "TRAININGAPP_PARITY_CAPTURE_DIR"


def _execute_parity_flow() -> dict:
    """The cache-miss worker: seed a store, boot the host, run the eval.

    Returns the parsed eval report. The host stderr TEXT is captured while
    the tempdir still exists — the cached report outlives it, and the metric
    assertions quote that stderr as their diagnostic — the same reason every
    assertion originally lived inside the tempdir block.
    """
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
            host_err = (work / "host.err").read_text(encoding="utf-8", errors="replace")
        finally:
            host.kill_tree()
        # Cache the host stderr BEFORE the opt-in capture block (review
        # PRR-005): a capture failure must never poison the cached run — the
        # metric assertions quote this stderr as their diagnostic.
        _PARITY_RUN["host_err"] = host_err
        capture_dir = os.environ.get(_PARITY_CAPTURE_ENV)
        if capture_dir:
            # Warn-and-continue (review PRR-005): the capture is opt-in
            # evidence recording, not part of the measurement. An OSError
            # here must not turn a successful ~540 s measurement into a
            # sticky cached failure.
            try:
                dest = Path(capture_dir)
                dest.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(work / "report.json", dest / "report.json")
                shutil.copyfile(work / "REPORT.md", dest / "REPORT.md")
                (dest / "host.err").write_text(host_err, encoding="utf-8")
            except Exception as exc:
                print(
                    f"parity: capture to {capture_dir} failed ({exc!r}); "
                    "continuing without recorded artifacts",
                    file=sys.stderr,
                )
    return report


def _parity_report() -> dict:
    """Execute the seeded parity flow once and return the parsed report.

    Cache semantics (issue #205 AC1): the flow runs at most once per process
    on BOTH the success and the failure path — a cached failure re-raises the
    SAME exception object (never a re-run, never a second teardown race). The
    floors-armed and dist-fresh preconditions are asserted BEFORE the
    cache-hit return, so a cached report is never handed to a caller on a box
    that would not be allowed to measure it in the first place.
    """
    if "failure" in _PARITY_RUN:
        raise _PARITY_RUN["failure"]
    _assert_floors_armed()
    _assert_dist_fresh()
    if "report" in _PARITY_RUN:
        return _PARITY_RUN["report"]
    try:
        report = _execute_parity_flow()
    except Exception as exc:  # review PRR-006: never cache BaseException —
        # KeyboardInterrupt/pytest Skipped must unwind, not become a sticky
        # cached failure that re-raises (and re-logs) on every consumer.
        _PARITY_RUN["failure"] = exc
        raise
    _PARITY_RUN["report"] = report
    return report


@_SKIP_GATES[0]
@_SKIP_GATES[1]
@_SKIP_GATES[2]
@_SKIP_GATES[3]
def test_desktop_retrieval_eval_parity() -> None:
    """Desktop host retrieval stays at parity with the recorded weighted run."""
    report = _parity_report()
    # All assertions consume the cached run (host stderr captured during it),
    # so a metric failure still reports the host-side cause.
    assert (
        report.get("error_count") == 0
    ), f"eval run had errors: {report.get('error_count')}\n{_cached_host_stderr_tail()}"
    question_count = report.get("question_count")
    assert question_count == EXPECTED_QUESTIONS, _rederive_message(
        f"question_count={question_count!r}, pinned {EXPECTED_QUESTIONS}"
    )
    in_corpus = report.get("in_corpus_count")
    assert in_corpus == EXPECTED_IN_CORPUS, _rederive_message(
        f"in_corpus_count={in_corpus!r}, pinned {EXPECTED_IN_CORPUS} "
        "(the denominator recall@5 and MRR divide over)"
    )
    # Silent-degrade detector: a run that reaches the metric asserts
    # must not have logged the rerank degrade — otherwise a fused-
    # ordering host could satisfy the floors unnoticed.
    assert "reranker unavailable" not in _PARITY_RUN["host_err"], (
        "host logged a rerank degrade during a passing run — "
        f"the floors were measured without the reranker:\n{_PARITY_RUN['host_err']}"
    )
    metrics = report["metrics"]
    recall5 = float(metrics["recall_at_k"]["5"])
    mrr = float(metrics["mrr"])
    assert recall5 >= float(_FLOOR_RECALL5), (
        f"recall@5={recall5} below floor {float(_FLOOR_RECALL5)} — "
        f"retrieval parity regressed\n{_cached_host_stderr_tail()}"
    )
    assert mrr >= float(_FLOOR_MRR), (
        f"mrr={mrr} below floor {float(_FLOOR_MRR)} — "
        f"retrieval parity regressed\n{_cached_host_stderr_tail()}"
    )


def _assert_backend_stats_document_count(report: dict) -> None:
    """AC14 (issue #186) stats pin body, factored so the transport-failure
    branch (issue #205 AC2) is unit-testable against a synthetic report.

    The transport sentinel is checked BEFORE the count pin: a /stats fetch
    that died at the transport layer (host down, proxy refused, non-200)
    must fail with the transport remedy, never with the re-derive-the-floors
    remedy — those are different failure classes with different fixes.
    """
    stats = report.get("backend_stats")
    assert isinstance(stats, dict), (
        "eval report is missing backend_stats — eval/runner.py's report "
        f"assembly dropped it (got {stats!r}); the parity report must carry "
        "the host's GET /stats snapshot"
    )
    stats_fetch_error = stats.get("stats_fetch_error")
    assert stats_fetch_error is None, (
        f"backend_stats.stats_fetch_error is set ({stats_fetch_error!r}): the "
        "eval runner's GET /stats failed at the transport layer (host or "
        "loopback proxy unreachable, or a non-200 response) — a runner-side "
        "infrastructure failure, not a retrieval-quality or count defect; "
        "make the host's /stats route reachable from the runner (check the "
        "host boot and the proxy thread) and re-run the eval"
    )
    document_count = stats.get("document_count")
    assert document_count is not None, (
        "backend_stats.document_count is null: the eval runner could not fetch "
        "/stats (transport/runner failure) or the route returned no count — "
        "this is NOT a floor drift; re-run the parity suite and, if it persists, "
        "check the host /stats route and eval/runner.py best-effort fetch"
    )
    assert document_count == EXPECTED_DOCUMENTS, _rederive_message(
        f"backend_stats.document_count={document_count!r}, seeded (and "
        f"pinned) {EXPECTED_DOCUMENTS} — the host's /stats document count "
        "must equal the ingest seed count (GET /stats -> engine.getStats -> "
        "store counts)"
    )


@_SKIP_GATES[0]
@_SKIP_GATES[1]
@_SKIP_GATES[2]
@_SKIP_GATES[3]
def test_backend_stats_document_count() -> None:
    """AC14 (issue #186): the report's backend_stats block carries the host's
    real /stats document count for the seeded store.

    Shares the parity run (seeded machinery + ``_run_eval``'s parsed report);
    weights-gated skip preserved like its siblings — a skip at head is the
    sanctioned shape on weightless boxes.
    """
    _assert_backend_stats_document_count(_parity_report())


# --- issue #205 AC1: parity cache semantics (box-independent unit pins) -----


class TestParityCacheSemantics:
    """``_parity_report()`` cache discipline, with every environmental seam
    monkeypatched away (worker, floor arming, dist freshness): these run green
    on weightless, dist-less, untagged boxes — C4's verdict never depends on
    the dev-server stat or BENCH_FLOORS_MACHINE.
    """

    @pytest.fixture(autouse=True)
    def _isolated_run_cache(self):
        saved = dict(_PARITY_RUN)
        _PARITY_RUN.clear()
        yield
        _PARITY_RUN.clear()
        _PARITY_RUN.update(saved)

    @staticmethod
    def _patch_seams(monkeypatch, worker):
        calls = {"worker": 0, "floors": 0, "dist": 0}

        def fake_worker():
            calls["worker"] += 1
            return worker()

        this_module = sys.modules[__name__]
        monkeypatch.setattr(this_module, "_execute_parity_flow", fake_worker)
        monkeypatch.setattr(
            this_module,
            "_assert_floors_armed",
            lambda: calls.__setitem__("floors", calls["floors"] + 1),
        )
        monkeypatch.setattr(
            this_module,
            "_assert_dist_fresh",
            lambda: calls.__setitem__("dist", calls["dist"] + 1),
        )
        return calls

    def test_cache_semantics_failure_is_cached_and_reraised(self, monkeypatch):
        """A mid-flow failure runs the worker ONCE; both consumers re-raise
        the SAME exception object (fail fast with the shared cause)."""
        boom = RuntimeError("parity flow exploded mid-flight")

        def failing_worker():
            raise boom

        calls = self._patch_seams(monkeypatch, failing_worker)
        with pytest.raises(RuntimeError) as first:
            _parity_report()
        with pytest.raises(RuntimeError) as second:
            _parity_report()
        assert calls["worker"] == 1, (
            "a failed first execution must be cached — the second consumer "
            f"re-runs the expensive worker (executions: {calls['worker']})"
        )
        assert first.value is boom, "the first raise must carry the worker's object"
        assert second.value is boom, (
            "the cached re-raise must be the SAME exception object, not a "
            "fresh copy or a re-run"
        )

    def test_cache_semantics_success_runs_once_and_revalidates(self, monkeypatch):
        """The success twin: one worker execution, two cached returns, and
        the floors/dist preconditions are invoked per call — never skipped
        on the cache-hit path."""
        fake_report = {"schema": "eval-report/1", "metrics": {}}

        calls = self._patch_seams(monkeypatch, lambda: fake_report)
        first = _parity_report()
        second = _parity_report()
        assert calls["worker"] == 1
        assert first is fake_report
        assert second is fake_report
        assert calls["floors"] == 2, (
            "_assert_floors_armed must run on EVERY call including the "
            "cache hit (a cached report must not bypass floor arming)"
        )
        assert calls["dist"] == 2, (
            "_assert_dist_fresh must run on EVERY call including the cache "
            "hit (a cached report must not bypass dist freshness)"
        )


# --- issue #205 AC2: transport-message pin side (synthetic report) -----------


def test_transport_message_pin_side_synthetic_report() -> None:
    """The AC14 pin must branch on the runner's transport sentinel: a report
    carrying ``stats_fetch_error`` fails with the TRANSPORT remedy and NOT
    with the floor/re-derive remedy (box-independent synthetic report, so
    C5's verdict needs no weights, dist, or machine tag)."""
    synthetic = {
        "schema": "eval-report/1",
        "backend_stats": {
            "embedding_model": None,
            "llm_backend": None,
            "document_count": None,
            "chunk_count": None,
            "stats_fetch_error": "transport error: ConnectError: [Errno] refused",
        },
    }
    with pytest.raises(AssertionError) as excinfo:
        _assert_backend_stats_document_count(synthetic)
    message = str(excinfo.value)
    assert (
        "stats_fetch_error" in message
    ), f"the transport failure must name the sentinel: {message!r}"
    assert (
        "transport" in message
    ), f"the remedy must name the transport failure class: {message!r}"
    assert "if it persists" not in message, (
        "a transport failure must NOT fire the floor-remedy (null-count) "
        f"message: {message!r}"
    )
