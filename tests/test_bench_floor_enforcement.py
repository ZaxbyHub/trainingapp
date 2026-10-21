"""Live enforcement of the machine-tagged bench-floor rows (issue #168).

Five metric families in bench/RESULTS.md's bench-floors block had recorded
floors that nothing enforced: onnx-embed encode ceilings + throughput floors
for bge-small-en-v1.5 and snowflake-arctic-embed-m-v1.5, onnx-rerank
top15/top30 ceilings for ettin-reranker-32m-v1, and native decode floors for
lfm2.5-vl-450m and gemma-4-e2b-it. This module measures each family live -
via the same engines the recorded rows came from (bench/onnx_bench_driver.py
session/tokenizer semantics, bench/llama_bench_driver.run_with_llama_cpp) -
and asserts against the rows BENCH_FLOORS_MACHINE selects.

Gating (the repo's evidence-conditional shape, cf. test_rag_performance.py):
  * BENCH_FLOORS_MACHINE unset -> every test skips with the arming
    instruction (rows are machine-tagged; an unset tag selects none).
  * artifact (models/*/onnx/*, models/*/*.gguf) or engine missing -> skip
    citing the staging instruction under models/.
  * no floors row for the current machine/surface/model/metric -> skip
    citing the runbook.
There is deliberately NO legacy-bound fallback here (that fallback is a
rag-suite-only design, bench/floors.py:8-12); an unenforceable row skips, it
never invents a threshold.

Out of scope by design (issue #168): reference-i5 rows (PENDING until the
laptop run), the rag-surface legacy fallback, and the desktop-retrieval-eval
rows (already enforced by tests/test_retrieval_eval_parity.py).

Reproduce (POSIX/Git Bash):
  BENCH_FLOORS_MACHINE=devstation python -m pytest tests/test_bench_floor_enforcement.py -q
cmd.exe:
  set BENCH_FLOORS_MACHINE=devstation
  python -m pytest tests/test_bench_floor_enforcement.py -q
Selectable groups: -k embed (onnx-embed), -k rerank (onnx-rerank),
-k native (GGUF decode).
"""

import contextlib
import gc
import importlib
import statistics
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

floors = importlib.import_module("bench.floors")
onnx_driver = importlib.import_module("bench.onnx_bench_driver")
llama_driver = importlib.import_module("bench.llama_bench_driver")

RESULTS = REPO_ROOT / "bench" / "RESULTS.md"
ASSETS = REPO_ROOT / "models"

_MACHINE_TAG = floors.current_machine_tag()

# sys.modules["llama_cpp"] sentinel for "the key was absent on snapshot" (a
# plain None would be ambiguous with a stored None value).
_LLAMA_CPP_ABSENT = object()

UNARMED_REASON = (
    "BENCH_FLOORS_MACHINE is not set, so no machine-tagged floor rows are "
    "selected and enforcement is disarmed by design. Arm with the machine "
    "tag that has recorded rows (devstation): POSIX/Git Bash - "
    "BENCH_FLOORS_MACHINE=devstation python -m pytest "
    "tests/test_bench_floor_enforcement.py -q; cmd.exe - "
    "set BENCH_FLOORS_MACHINE=devstation first. The measured artifacts live "
    "under models/ (python bench/fetch_models.py --onnx, plus the candidate "
    "GGUFs)."
)

pytestmark = [pytest.mark.skipif(not _MACHINE_TAG, reason=UNARMED_REASON)]

# Artifact layout mirrors bench/onnx_bench_driver.py's candidate tables so a
# floor is measured against exactly the file its provenance row recorded.
EMBED_TARGETS = {
    "bge-small-en-v1.5": {
        "dir": "bge-small-en-v1.5",
        "candidates": ("onnx/model.onnx",),
    },
    "snowflake-arctic-embed-m-v1.5": {
        "dir": "snowflake-arctic-embed-m-v1.5",
        "candidates": ("onnx/model_quantized.onnx", "onnx/model.onnx"),
    },
}
RERANK_TARGETS = {
    "ettin-reranker-32m-v1": {
        "dir": "ettin-reranker-32m-v1",
        "candidates": ("onnx/model_quantized.onnx", "onnx/model.onnx"),
    },
}
NATIVE_TARGETS = {
    "lfm2.5-vl-450m": {"gguf": "lfm2.5-vl-450m/model.gguf", "repeats": 3},
    "gemma-4-e2b-it": {"gguf": "gemma-4-e2b-it/model.gguf", "repeats": 2},
}

# The native floors' provenance rows are the devstation llama-cpp-python
# cells at threads=4 / prompt 1024 (bench/RESULTS.md "Native llama.cpp CPU
# results"); measure that same cell.
NATIVE_THREADS = 4
NATIVE_PROMPT_TOKENS = 1024
NATIVE_MAX_TOKENS = 128

# Loaded-box robustness: warm up before timing and report the median of N
# repeats (the floor rows carry 2x provenance slack, but the measurement
# must not lean on that alone). These constants ARE the enforced
# measurement cell the RESULTS.md rows name (issue #206 AC1): the
# onnx-rerank rows (top15/top30 ceilings) cite warm-all-feeds +
# median-of-3-rep-means (RERANK_WARM_FEEDS/RERANK_REPS), the
# embeddings_per_second rows cite warm-2 + median-of-5
# (BATCH_WARMUP/BATCH_RUNS) — the -k protocol test cross-pins both sides so
# neither the rows nor the constants can drift alone.
ENCODE_WARMUP = 3  # mirrors onnx_bench_driver.bench_embed
ENCODE_RUNS = 20
BATCH_WARMUP = 2
BATCH_RUNS = 5
RERANK_REPS = 3
# None = warm EVERY candidate feed before timing (feeds[:None] is the full
# list). An int would warm only that many leading feeds — the warm loop is
# deliberately the slice form `for f in feeds[:RERANK_WARM_FEEDS]:`; never
# `range(RERANK_WARM_FEEDS)` and never `feeds[:RERANK_WARM_FEEDS or 0]`
# (the latter silently warms ZERO feeds when None — measurement-cell drift
# the RESULTS.md row literals cannot catch).
RERANK_WARM_FEEDS: int | None = None


# ---------------------------------------------------------------------------
# Floor-row access (mirror of test_rag_performance._perf_threshold's shape;
# threshold() returns a (value, direction) TUPLE or None - always unpack it)
# ---------------------------------------------------------------------------


def _floor(surface: str, model: str, metric: str):
    """(value, direction) from the machine-tagged row; skip when absent."""
    found = floors.threshold(RESULTS, surface, model, metric)
    if found is None:
        pytest.skip(
            f"no bench-floors row for surface={surface!r} model={model!r} "
            f"metric={metric!r} machine={_MACHINE_TAG!r} in bench/RESULTS.md; "
            "record rows for this machine per the runbook "
            "(bench/append_results.py), then re-arm - the measured artifacts "
            "live under models/"
        )
    value, direction = found
    return value, direction


def _assert_metric(label: str, measured: float, value: float, direction: str):
    if direction == "ceiling":
        assert measured <= value, (
            f"{label}: measured {measured:.3f} exceeds the ceiling {value} "
            f"(bench/RESULTS.md floor row, machine={_MACHINE_TAG})"
        )
    else:
        assert measured >= value, (
            f"{label}: measured {measured:.3f} is below the floor {value} "
            f"(bench/RESULTS.md floor row, machine={_MACHINE_TAG})"
        )


# ---------------------------------------------------------------------------
# Engine gates
# ---------------------------------------------------------------------------


def _require_onnx_runtime():
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except Exception:
        pytest.skip(
            "onnxruntime/tokenizers not importable (pip install onnxruntime "
            "tokenizers) - needed to measure the staged ONNX artifacts under "
            "models/ (python bench/fetch_models.py --onnx)"
        )


@contextlib.contextmanager
def _real_llama_cpp():
    """Yield the real llama_cpp binding for a bounded native-measurement block.

    tests/conftest.py pre-registers sys.modules["llama_cpp"] = MagicMock() so
    `patch("llama_cpp.Llama")` works on machines without the wheel; under
    pytest that stand-in shadows the real binding until it is imported. A
    real binding exposes Llama as a class, a Mock does not - so detect the
    stand-in, evict it just long enough for the real import (the bench
    driver's own `import llama_cpp` then resolves to the real one), and
    RESTORE THE PRE-EXISTING OBJECT ON EXIT unconditionally (issue #206
    AC10): the eviction is symmetric, so the conftest stand-in survives the
    enforcement module instead of being permanently replaced by the real
    wheel (which would no-op every sibling setdefault defense and make
    `patch("llama_cpp.Llama")` collection-order dependent).

    Yields the real module, or None when the wheel is not importable (the
    caller skips in that case).
    """
    mod = sys.modules.get("llama_cpp")
    if mod is not None and isinstance(getattr(mod, "Llama", None), type):
        try:
            yield mod
        finally:
            sys.modules["llama_cpp"] = mod
        return
    mocked = mod is not None and not isinstance(getattr(mod, "Llama", None), type)
    if mocked:
        del sys.modules["llama_cpp"]
    real = None
    try:
        import llama_cpp

        real = llama_cpp
    except Exception:
        real = None
    try:
        yield real
    finally:
        if mocked:
            sys.modules["llama_cpp"] = mod
        elif real is not None and sys.modules.get("llama_cpp") is real:
            # Nothing was there before the block: restore the absence.
            del sys.modules["llama_cpp"]


@pytest.fixture(autouse=True, scope="module")
def _llama_cpp_snapshot_safety_net():
    """Safety net (issue #206 AC10): whatever any test in this module does to
    sys.modules["llama_cpp"], the object that was there when the module
    started is back in place when it finishes — the conftest stand-in must
    survive the enforcement module even if a future edit breaks the context
    manager's own restore."""
    snapshot = sys.modules.get("llama_cpp", _LLAMA_CPP_ABSENT)
    yield
    if snapshot is _LLAMA_CPP_ABSENT:
        sys.modules.pop("llama_cpp", None)
    else:
        sys.modules["llama_cpp"] = snapshot


# ---------------------------------------------------------------------------
# Measurements (cached per model: one session load shared by the group's
# tests; inputs identical to bench/onnx_bench_driver.py so the numbers stay
# comparable to the recorded provenance rows)
# ---------------------------------------------------------------------------

_EMBED_CACHE: dict = {}
_RERANK_CACHE: dict = {}
_NATIVE_CACHE: dict = {}


def _measure_embed(model: str) -> dict:
    if model in _EMBED_CACHE:
        return _EMBED_CACHE[model]
    _require_onnx_runtime()
    entry = EMBED_TARGETS[model]
    model_path = onnx_driver.find_model(ASSETS, entry)
    if model_path is None:
        pytest.skip(
            f"ONNX embed artifact not staged under models/{entry['dir']}/onnx "
            f"(looked for {', '.join(entry['candidates'])}) - run "
            "python bench/fetch_models.py --onnx"
        )
    tok_path = onnx_driver.find_tokenizer(model_path)
    if tok_path is None:
        pytest.skip(
            f"tokenizer.json not found beside/above models/{entry['dir']} - "
            "restage with python bench/fetch_models.py --onnx"
        )
    from tokenizers import Tokenizer

    session = onnx_driver.make_session(model_path)  # 4 intra-op threads
    tokenizer = Tokenizer.from_file(str(tok_path))

    query = "How do I reset my training password?"
    docs = [
        f"Document chunk {i}: procedures for module {i % 7} of the course."
        for i in range(16)
    ]

    # Single-query encode latency: warm-up then median (the driver's method).
    enc = tokenizer.encode(query)
    feed = onnx_driver.feed_inputs(session, enc)
    for _ in range(ENCODE_WARMUP):
        session.run(None, feed)
    lat = []
    for _ in range(ENCODE_RUNS):
        t0 = time.perf_counter()
        session.run(None, feed)
        lat.append((time.perf_counter() - t0) * 1000.0)
    encode_ms = statistics.median(lat)

    # Batch throughput (16 docs, padded): warm-up then median of N batches.
    batch_encs = [tokenizer.encode(d) for d in docs]
    max_len = max(len(e.ids) for e in batch_encs)
    pad_id = tokenizer.token_to_id("[PAD]") or 0

    def pad(e):
        ids = e.ids + [pad_id] * (max_len - len(e.ids))
        mask = e.attention_mask + [0] * (max_len - len(e.attention_mask))
        e_types = getattr(e, "type_ids", None) or [0] * len(e.ids)
        types = e_types + [0] * (max_len - len(e_types))
        return ids, mask, types

    padded = [pad(e) for e in batch_encs]
    feed_b = {}
    for inp in session.get_inputs():
        name = inp.name.lower()
        if "input_ids" in name:
            feed_b[inp.name] = [p[0] for p in padded]
        elif "attention_mask" in name:
            feed_b[inp.name] = [p[1] for p in padded]
        elif "token_type" in name:
            feed_b[inp.name] = [p[2] for p in padded]
    for _ in range(BATCH_WARMUP):
        session.run(None, feed_b)
    batch_s = []
    for _ in range(BATCH_RUNS):
        t0 = time.perf_counter()
        session.run(None, feed_b)
        batch_s.append(max(time.perf_counter() - t0, 1e-9))
    eps = len(docs) / statistics.median(batch_s)

    row = {
        "encode_ms": encode_ms,
        "embeddings_per_second": eps,
        "model_file": str(model_path),
    }
    _EMBED_CACHE[model] = row
    print(
        f"\n[FLOOR] onnx-embed {model}: encode {encode_ms:.3f} ms, "
        f"{eps:.1f} embeddings/s ({model_path.name})"
    )
    return row


def _measure_rerank(model: str) -> dict:
    if model in _RERANK_CACHE:
        return _RERANK_CACHE[model]
    _require_onnx_runtime()
    entry = RERANK_TARGETS[model]
    model_path = onnx_driver.find_model(ASSETS, entry)
    if model_path is None:
        pytest.skip(
            f"ONNX rerank artifact not staged under models/{entry['dir']}/onnx "
            f"(the floors row measures {entry['candidates'][0]}) - run "
            "python bench/fetch_models.py --onnx"
        )
    tok_path = onnx_driver.find_tokenizer(model_path)
    if tok_path is None:
        pytest.skip(
            f"tokenizer.json not found beside/above models/{entry['dir']} - "
            "restage with python bench/fetch_models.py --onnx"
        )
    from tokenizers import Tokenizer

    session = onnx_driver.make_session(model_path)  # 4 intra-op threads
    tokenizer = Tokenizer.from_file(str(tok_path))

    query = "How do I reset my training password?"
    corpus = [
        f"Chunk {i}: password reset steps vary by module {i % 9}." for i in range(32)
    ]
    feeds = [
        onnx_driver.feed_inputs(session, tokenizer.encode(query, d)) for d in corpus
    ]
    # Warm the candidate feeds the enforced cell names before any timing
    # (loaded-box guard): the slice idiom keeps the None-means-all contract
    # exact — see RERANK_WARM_FEEDS above.
    for f in feeds[:RERANK_WARM_FEEDS]:
        session.run(None, f)

    def per_candidate_ms(n_candidates: int) -> float:
        """Median over RERANK_REPS reps of the mean per-candidate latency."""
        rep_means = []
        for _ in range(RERANK_REPS):
            lat = []
            for f in feeds[:n_candidates]:
                t0 = time.perf_counter()
                session.run(None, f)
                lat.append((time.perf_counter() - t0) * 1000.0)
            rep_means.append(sum(lat) / len(lat))
        return statistics.median(rep_means)

    row = {
        "top15_ms": per_candidate_ms(15),
        "top30_ms": per_candidate_ms(30),
        "model_file": str(model_path),
    }
    _RERANK_CACHE[model] = row
    print(
        f"\n[FLOOR] onnx-rerank {model}: top15 {row['top15_ms']:.2f} ms, "
        f"top30 {row['top30_ms']:.2f} ms per candidate ({model_path.name})"
    )
    return row


def _measure_native(model: str) -> dict:
    if model in _NATIVE_CACHE:
        return _NATIVE_CACHE[model]
    target = NATIVE_TARGETS[model]
    gguf = ASSETS / target["gguf"]
    if not gguf.is_file():
        pytest.skip(
            f"GGUF not staged: models/{target['gguf']} - stage the candidate "
            "GGUFs under models/ (see the bench/RESULTS.md reproduce block) "
            "to enforce the native decode floor"
        )
    # The eviction is scoped to the measurement block: the driver's own
    # `import llama_cpp` resolves to the real wheel inside the with, and the
    # conftest stand-in is back in sys.modules before any sibling test runs.
    with _real_llama_cpp() as llama_cpp:
        if llama_cpp is None:
            pytest.skip(
                f"llama-cpp-python not importable (needed to measure "
                f"models/{target['gguf']}) - pip install llama-cpp-python, or "
                "measure via an external llama-bench binary (LLAMA_BENCH_BIN)"
            )
        # The driver loads, warms up (unmeasured) and streams once per call;
        # the median over repeats is the enforced number.
        values = []
        last_row = None
        for _ in range(target["repeats"]):
            row = llama_driver.run_with_llama_cpp(
                gguf,
                "Q4_K_M",
                NATIVE_THREADS,
                NATIVE_PROMPT_TOKENS,
                NATIVE_MAX_TOKENS,
            )
            last_row = row
            if (
                row.get("outcome") != "pass"
                or row.get("decode_tokens_per_second") is None
            ):
                raise AssertionError(f"native bench driver failed for {model}: {row!r}")
            values.append(float(row["decode_tokens_per_second"]))
            gc.collect()
    result = {
        "decode_tokens_per_second": statistics.median(values),
        "repeats": list(values),
        "row": last_row,
    }
    _NATIVE_CACHE[model] = result
    print(
        f"\n[FLOOR] native {model}: decode {result['decode_tokens_per_second']:.2f} "
        f"tok/s (median of {values})"
    )
    return result


# ---------------------------------------------------------------------------
# onnx-embed group (-k embed / -k onnx-embed)
# ---------------------------------------------------------------------------


class TestOnnxEmbedFloors:
    """encode_ceiling_ms + embeddings_per_second_floor rows, bge + snowflake."""

    def test_onnx_embed_bge_small_encode_ceiling_ms(self):
        row = _measure_embed("bge-small-en-v1.5")
        value, direction = _floor(
            "onnx-embed", "bge-small-en-v1.5", "encode_ceiling_ms"
        )
        assert direction == "ceiling"
        _assert_metric(
            "onnx-embed bge-small-en-v1.5 encode",
            row["encode_ms"],
            value,
            direction,
        )

    def test_onnx_embed_bge_small_embeddings_per_second_floor(self):
        row = _measure_embed("bge-small-en-v1.5")
        value, direction = _floor(
            "onnx-embed", "bge-small-en-v1.5", "embeddings_per_second_floor"
        )
        assert direction == "floor"
        _assert_metric(
            "onnx-embed bge-small-en-v1.5 throughput",
            row["embeddings_per_second"],
            value,
            direction,
        )

    def test_onnx_embed_snowflake_encode_ceiling_ms(self):
        row = _measure_embed("snowflake-arctic-embed-m-v1.5")
        value, direction = _floor(
            "onnx-embed", "snowflake-arctic-embed-m-v1.5", "encode_ceiling_ms"
        )
        assert direction == "ceiling"
        _assert_metric(
            "onnx-embed snowflake-arctic-embed-m-v1.5 encode",
            row["encode_ms"],
            value,
            direction,
        )

    def test_onnx_embed_snowflake_embeddings_per_second_floor(self):
        row = _measure_embed("snowflake-arctic-embed-m-v1.5")
        value, direction = _floor(
            "onnx-embed",
            "snowflake-arctic-embed-m-v1.5",
            "embeddings_per_second_floor",
        )
        assert direction == "floor"
        _assert_metric(
            "onnx-embed snowflake-arctic-embed-m-v1.5 throughput",
            row["embeddings_per_second"],
            value,
            direction,
        )


# ---------------------------------------------------------------------------
# onnx-rerank group (-k rerank)
# ---------------------------------------------------------------------------


class TestOnnxRerankFloors:
    """top15/top30 per-candidate ceilings for ettin-reranker-32m-v1."""

    def test_onnx_rerank_ettin_top15_ceiling_ms(self):
        row = _measure_rerank("ettin-reranker-32m-v1")
        value, direction = _floor(
            "onnx-rerank", "ettin-reranker-32m-v1", "top15_ceiling_ms"
        )
        assert direction == "ceiling"
        _assert_metric(
            "onnx-rerank ettin-reranker-32m-v1 top15",
            row["top15_ms"],
            value,
            direction,
        )

    def test_onnx_rerank_ettin_top30_ceiling_ms(self):
        row = _measure_rerank("ettin-reranker-32m-v1")
        value, direction = _floor(
            "onnx-rerank", "ettin-reranker-32m-v1", "top30_ceiling_ms"
        )
        assert direction == "ceiling"
        _assert_metric(
            "onnx-rerank ettin-reranker-32m-v1 top30",
            row["top30_ms"],
            value,
            direction,
        )


# ---------------------------------------------------------------------------
# native group (-k native)
# ---------------------------------------------------------------------------


class TestNativeFloors:
    """decode_floor_tps rows for lfm2.5-vl-450m and gemma-4-e2b-it."""

    def test_native_lfm2_5_vl_450m_decode_floor_tps(self):
        row = _measure_native("lfm2.5-vl-450m")
        value, direction = _floor("native", "lfm2.5-vl-450m", "decode_floor_tps")
        assert direction == "floor"
        _assert_metric(
            "native lfm2.5-vl-450m decode",
            row["decode_tokens_per_second"],
            value,
            direction,
        )

    def test_native_gemma_4_e2b_it_decode_floor_tps(self):
        row = _measure_native("gemma-4-e2b-it")
        value, direction = _floor("native", "gemma-4-e2b-it", "decode_floor_tps")
        assert direction == "floor"
        _assert_metric(
            "native gemma-4-e2b-it decode",
            row["decode_tokens_per_second"],
            value,
            direction,
        )


# ---------------------------------------------------------------------------
# protocol cross-pin (-k protocol, issue #206 AC1)
# ---------------------------------------------------------------------------


class TestProtocolPins:
    """Both dimensions of the enforced measurement cell are named by the
    RESULTS.md rows they belong to AND pinned as module constants — neither
    side can drift alone (a row edit without a constant change trips the
    constants; a constant change without a row edit trips the literals)."""

    def test_protocol_row_literals_match_the_module_constants(self):
        rows = floors.parse_floors(RESULTS)
        rerank_rows = [
            row
            for row in rows
            if row.get("surface") == "onnx-rerank"
            and row.get("machine") == "devstation"
        ]
        assert len(rerank_rows) == 2, (
            "expected the ettin top15/top30 ceiling rows, got " f"{len(rerank_rows)}"
        )
        for row in rerank_rows:
            provenance = str(row.get("provenance", ""))
            assert "warm-all-feeds" in provenance, (
                "the rerank rows' provenance must name the enforced cell's "
                "warm-up protocol (warm-all-feeds)"
            )
            assert "median-of-3-rep-means" in provenance, (
                "the rerank rows' provenance must name the enforced cell's "
                "rep protocol (median-of-3-rep-means)"
            )
        eps_rows = [
            row
            for row in rows
            if row.get("surface") == "onnx-embed"
            and row.get("metric") == "embeddings_per_second_floor"
            and row.get("machine") == "devstation"
        ]
        assert len(eps_rows) == 2, (
            "expected the bge + snowflake embeddings_per_second rows, got "
            f"{len(eps_rows)}"
        )
        for row in eps_rows:
            provenance = str(row.get("provenance", ""))
            assert "warm-2" in provenance, (
                "the eps rows' provenance must name the enforced cell's "
                "warm-up protocol (warm-2, BATCH_WARMUP)"
            )
            assert "median-of-5" in provenance, (
                "the eps rows' provenance must name the enforced cell's "
                "rep protocol (median-of-5, BATCH_RUNS)"
            )
        # Module side: the constants the rows' literals describe. A revert
        # of the warm loop to warm-first-2 (RERANK_WARM_FEEDS = 2) without
        # the row edit trips HERE; a row-only edit trips ABOVE.
        assert RERANK_REPS == 3
        assert RERANK_WARM_FEEDS is None, (
            "RERANK_WARM_FEEDS must be None (warm every candidate feed); an "
            "int here changes the enforced cell away from the "
            "warm-all-feeds protocol the RESULTS.md rows name"
        )
        assert BATCH_WARMUP == 2
        assert BATCH_RUNS == 5


# ---------------------------------------------------------------------------
# llama_cpp eviction pin (-k eviction, issue #206 AC3)
# ---------------------------------------------------------------------------


class TestLlamaCppEviction:
    """The sys.modules['llama_cpp'] swap is symmetric: whatever was there
    before the native block is back after it — the conftest stand-in
    survives the enforcement module."""

    def test_eviction_context_restores_the_pre_existing_object(self):
        import types

        sentinel = types.ModuleType("llama_cpp_sentinel")
        previous = sys.modules.get("llama_cpp", _LLAMA_CPP_ABSENT)
        sys.modules["llama_cpp"] = sentinel
        try:
            with _real_llama_cpp() as real:
                assert (
                    real is not sentinel
                ), "the stand-in must never be yielded as the real binding"
                if real is not None:
                    assert isinstance(real, types.ModuleType) and isinstance(
                        getattr(real, "Llama", None), type
                    ), "a yielded real binding must carry Llama as a class"
            assert sys.modules["llama_cpp"] is sentinel, (
                "the pre-existing object must be restored on exit — a "
                "one-way eviction permanently breaks every sibling "
                'patch("llama_cpp.Llama") defense'
            )
        finally:
            if previous is _LLAMA_CPP_ABSENT:
                sys.modules.pop("llama_cpp", None)
            else:
                sys.modules["llama_cpp"] = previous
