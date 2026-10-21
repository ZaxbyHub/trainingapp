"""Unit tests for the bench floors parser and the native benchmark matrix.

These are CI-fast structural tests: no model weights, no inference. They guard
the contract that the converted perf suites depend on (machine-tagged floors
parsed from bench/RESULTS.md) and that the native driver enumerates the full
36-cell matrix required by issue #52.
"""

import importlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

floors = importlib.import_module("bench.floors")
llama_driver = importlib.import_module("bench.llama_bench_driver")

RESULTS = REPO_ROOT / "bench" / "RESULTS.md"


class TestFloorsParser:
    def test_results_floors_block_is_valid_json(self):
        """The bench-floors fence must stay machine-parseable."""
        rows = floors.parse_floors(RESULTS)
        assert isinstance(rows, list)

    def test_missing_results_file_returns_empty(self, tmp_path):
        assert floors.parse_floors(tmp_path / "absent.md") == []

    def test_get_floors_filters_by_machine(self, tmp_path):
        results = tmp_path / "RESULTS.md"
        results.write_text(
            "```bench-floors\n"
            + json.dumps(
                {
                    "floors": [
                        {
                            "surface": "rag",
                            "model": "bge-small-en-v1.5",
                            "machine": "devstation",
                            "metric": "query_p95_ceiling_ms",
                            "value": 400,
                            "direction": "ceiling",
                            "provenance": "test",
                        },
                        {
                            "surface": "rag",
                            "model": "bge-small-en-v1.5",
                            "machine": "reference-i5",
                            "metric": "query_p95_ceiling_ms",
                            "value": 900,
                            "direction": "ceiling",
                            "provenance": "test",
                        },
                    ]
                }
            )
            + "\n```\n",
            encoding="utf-8",
        )
        got = floors.get_floors(results, machine_tag="devstation")
        assert got[("rag", "bge-small-en-v1.5", "query_p95_ceiling_ms")]["value"] == 400
        got_ref = floors.get_floors(results, machine_tag="reference-i5")
        assert (
            got_ref[("rag", "bge-small-en-v1.5", "query_p95_ceiling_ms")]["value"]
            == 900
        )
        # Unset machine tag selects nothing (never invents a threshold).
        assert floors.get_floors(results, machine_tag="") == {}

    def test_threshold_directions(self, tmp_path):
        results = tmp_path / "RESULTS.md"
        results.write_text(
            "```bench-floors\n"
            + json.dumps(
                {
                    "floors": [
                        {
                            "surface": "rag",
                            "model": "m",
                            "machine": "x",
                            "metric": "decode_floor_tps",
                            "value": 5,
                            "direction": "floor",
                            "provenance": "t",
                        },
                        {
                            "surface": "rag",
                            "model": "m",
                            "machine": "x",
                            "metric": "latency_ceiling_ms",
                            "value": 900,
                            "direction": "ceiling",
                            "provenance": "t",
                        },
                        {
                            "surface": "rag",
                            "model": "m",
                            "machine": "x",
                            "metric": "bad",
                            "value": 1,
                            "direction": "nonsense",
                            "provenance": "t",
                        },
                    ]
                }
            )
            + "\n```\n",
            encoding="utf-8",
        )
        assert floors.threshold(
            results, "rag", "m", "decode_floor_tps", machine_tag="x"
        ) == (5.0, "floor")
        assert floors.threshold(
            results, "rag", "m", "latency_ceiling_ms", machine_tag="x"
        ) == (900.0, "ceiling")
        # Malformed rows are treated as absent, never guessed.
        assert floors.threshold(results, "rag", "m", "bad", machine_tag="x") is None
        assert floors.threshold(results, "rag", "m", "absent", machine_tag="x") is None


class TestNativeMatrix:
    def test_matrix_covers_36_required_cells(self):
        """3 model families x Q4_K_M/Q5_K_M x threads {4,8} x prompts {1k,2k,3k}."""
        cells = llama_driver.build_matrix()
        families = {"gemma-4-e2b-it", "lfm2.5-1.2b-instruct", "gemma-3-1b-it"}
        by_model = {}
        for cell in cells:
            by_model.setdefault(cell["model"], set()).add(
                (cell["quant"], cell["threads"], cell["prompt_tokens"])
            )
        assert set(by_model) == families
        required = {
            (q, t, p)
            for q in ("Q4_K_M", "Q5_K_M")
            for t in (4, 8)
            for p in (1024, 2048, 3072)
        }
        for model, got in by_model.items():
            assert required <= got, f"{model} missing cells: {required - got}"

    def test_list_matrix_flag_emits_json(self):
        """--list-matrix must print machine-readable cells on stdout."""
        import subprocess

        proc = subprocess.run(
            [
                sys.executable,
                "-B",
                str(REPO_ROOT / "bench" / "llama_bench_driver.py"),
                "--list-matrix",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert proc.returncode == 0, proc.stderr[-300:]
        payload = json.loads(proc.stdout)
        cells = payload["cells"] if isinstance(payload, dict) else payload
        assert len(cells) >= 36

    def test_help_mentions_vulkan(self):
        import subprocess

        proc = subprocess.run(
            [
                sys.executable,
                "-B",
                str(REPO_ROOT / "bench" / "llama_bench_driver.py"),
                "--help",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert proc.returncode == 0
        assert "vulkan" in proc.stdout.lower()

    def test_results_md_tables_carry_machine_column(self):
        """Every results section table names its machine; reference rows PENDING."""
        text = RESULTS.read_text(encoding="utf-8")
        for heading in (
            "## Native llama.cpp CPU results",
            "## Vulkan attempt",
            "## wllama (browser WASM) results",
        ):
            section = text.split(heading, 1)[1].split("## ", 1)[0]
            assert "| machine |" in section or "reference-i5" in section
        assert "<fill in>" not in text


class TestFloorsProvenance:
    """Issue #205/#206 provenance pins over the bench-floors fence rows.

    CI-fast structural tests (like the rest of this module): they read
    bench/RESULTS.md only, never the artifacts it cites — except the
    source-site pin below, which reads the enforcement module's SOURCE so
    the warm-loop idiom is guarded in CI (the -k protocol/-k eviction pins
    live in the BENCH_FLOORS_MACHINE-gated module and never run in CI;
    review PRR-009).
    """

    def test_floors_provenance_thread_config_recorded(self):
        """Both desktop-retrieval-eval rows must record the thread
        configuration the re-verification ran under (issue #205: recorded
        provenance predating the TRAININGAPP_DESKTOP_EMBED_THREADS=1 pin is
        the hole this pins shut)."""
        rows = floors.parse_floors(RESULTS)
        desktop_rows = [
            row
            for row in rows
            if row.get("surface") == "desktop-retrieval-eval"
            and row.get("machine") == "devstation"
        ]
        assert len(desktop_rows) == 2, (
            "expected the recall@5 and mrr desktop-retrieval-eval rows for "
            f"devstation, got {len(desktop_rows)}"
        )
        for row in desktop_rows:
            provenance = str(row.get("provenance", ""))
            metric = row.get("metric")
            assert "TRAININGAPP_DESKTOP_EMBED_THREADS" in provenance, (
                f"the {metric} row's provenance must record the thread pin "
                "the re-verification ran under "
                "(TRAININGAPP_DESKTOP_EMBED_THREADS=1)"
            )
            assert "report-i205-thread-provenance" in provenance, (
                f"the {metric} row's provenance must cite the recorded run "
                "artifact (eval/samples/report-i205-thread-provenance.json)"
            )

    def test_floors_provenance_gemma_replacement_named_and_retired_when_landed(
        self,
    ):
        """The DEVSTATION gemma floor's deviation from the 2x slack convention
        must NAME its concrete replacement row (issue #206 AC9), and the
        pending note must be RETIRED once the replacement lands.

        Review PRR-007 (swarm-pr-review pr242-20261021) corrected both halves
        of the original tripwire, which was dead and self-blocking:
        * the naming/"2x" literals are demanded only of the DEVIATING row
          (the devstation decode floor, or a machine-untagged gemma row) —
          a future reference-i5 fence row is NOT required to carry them;
        * the retirement trigger reads the NATIVE RESULTS TABLE (the
          free-text pipe table under "## Native llama.cpp CPU results" —
          where a measured reference-i5 row will actually land), not the
          bench-floors fence (which contains zero reference-i5 native rows
          today, so a fence-only trigger could never fire).
        When a reference-i5 gemma row with a recorded (non-PENDING)
        decode_tok_s exists in that native table, every devstation gemma
        fence row must have dropped the pending marker and cite the
        recorded row instead."""
        rows = floors.parse_floors(RESULTS)
        gemma_rows = [
            row
            for row in rows
            if row.get("model") == "gemma-4-e2b-it"
            and (
                row.get("machine") == "devstation"
                or not str(row.get("machine", "")).strip()
            )
        ]
        assert gemma_rows, "the gemma-4-e2b-it decode floor row must exist"
        for row in gemma_rows:
            provenance = str(row.get("provenance", ""))
            assert "reference-i5 native decode row" in provenance, (
                "the gemma floor deviates from the block's 2x convention, so "
                "its provenance must name the concrete replacement row (the "
                "reference-i5 native decode row), not an vague pointer"
            )
            assert (
                "2x" in provenance
            ), "the deviation from the 2x slack convention must be stated"
        if _reference_i5_gemma_native_decode_recorded(
            RESULTS.read_text(encoding="utf-8")
        ):
            for row in gemma_rows:
                provenance = str(row.get("provenance", ""))
                pending_marker = "pending note is VOID once that row is recorded"
                assert pending_marker not in provenance, (
                    "a reference-i5 native gemma decode row with a recorded "
                    "decode_tok_s now exists in the native results table of "
                    "bench/RESULTS.md, so the gemma row's pending-replacement "
                    "note must have been retired — edit the provenance to "
                    "cite the recorded row instead of declaring the "
                    "replacement pending"
                )

    def test_floors_provenance_rerank_warm_loop_source_site(self):
        """The rerank floor's warm-up loop keeps its exact slice idiom at the
        measurement SITE (review PRR-009: the -k protocol pin lives in the
        BENCH_FLOORS_MACHINE-gated tests/test_bench_floor_enforcement.py and
        is CI-inert; this pin runs in the plain CI matrix and cannot be
        satisfied by constants alone).

        RERANK_WARM_FEEDS is None (warm EVERY candidate feed), and the warm
        loop must stay the verbatim slice form — the two forbidden idioms
        silently warm zero feeds when None (`or 0`) or skip the warm loop's
        per-feed shape (`range(...)`), drifting the enforced measurement
        cell away from the warm-all-feeds protocol the RESULTS.md rows
        name; a hardcoded `feeds[:2]` would drift it just as silently."""
        enforcement_source = (
            REPO_ROOT / "tests" / "test_bench_floor_enforcement.py"
        ).read_text(encoding="utf-8")
        # Comment-stripped so the pins bind executable lines, not prose.
        code_lines = [
            line
            for line in enforcement_source.splitlines()
            if not line.lstrip().startswith("#")
        ]
        code = "\n".join(code_lines)
        assert "for f in feeds[:RERANK_WARM_FEEDS]:" in code, (
            "the rerank warm loop must keep the exact slice idiom "
            "`for f in feeds[:RERANK_WARM_FEEDS]:` (None warms every "
            "candidate feed); see RERANK_WARM_FEEDS in "
            "tests/test_bench_floor_enforcement.py"
        )
        assert "RERANK_WARM_FEEDS or 0" not in code, (
            "`feeds[:RERANK_WARM_FEEDS or 0]` silently warms ZERO feeds "
            "when RERANK_WARM_FEEDS is None — the executed mutant the "
            "-k protocol pin provably could not see (review PRR-009)"
        )
        assert "range(RERANK_WARM_FEEDS)" not in code, (
            "`range(RERANK_WARM_FEEDS)` is the wrong loop shape for the "
            "None-means-all warm contract (and a TypeError when None)"
        )
        assert "feeds[:2]" not in code, (
            "a hardcoded warm count (`feeds[:2]`-style) drifts the enforced "
            "cell away from the warm-all-feeds protocol the RESULTS.md "
            "rerank rows name"
        )


def _native_table_data_rows(text: str) -> list[list[str]]:
    """Data rows (as stripped cell lists) of the free-text native llama.cpp
    pipe table under "## Native llama.cpp CPU results".

    Structural parse only: header and |-separator rows are skipped, every
    other pipe line in the section is returned. Column meaning comes from
    the header row (machine/model/decode_tok_s), not fixed positions."""
    heading = "## Native llama.cpp CPU results"
    if heading not in text:
        return []
    section = text.split(heading, 1)[1].split("## ", 1)[0]
    data_rows: list[list[str]] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if cells and cells[0] == "machine":
            continue  # the header row
        if all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue  # the |- separator row
        data_rows.append(cells)
    return data_rows


def _reference_i5_gemma_native_decode_recorded(text: str) -> bool:
    """True when the native table carries a reference-i5 gemma-4-e2b-it row
    whose decode_tok_s cell is a recorded number (not PENDING/blank)."""
    rows = _native_table_data_rows(text)
    header = None
    for line in (
        text.split("## Native llama.cpp CPU results", 1)[1]
        .split("## ", 1)[0]
        .splitlines()
    ):
        stripped = line.strip()
        if stripped.startswith("|") and "machine" in stripped and "model" in stripped:
            header = [cell.strip() for cell in stripped.strip("|").split("|")]
            break
    if header is None:
        return False
    try:
        machine_i = header.index("machine")
        model_i = header.index("model")
        decode_i = header.index("decode_tok_s")
    except ValueError:
        return False
    for cells in rows:
        if len(cells) <= max(machine_i, model_i, decode_i):
            continue
        if cells[machine_i] != "reference-i5":
            continue
        if "gemma-4-e2b-it" not in cells[model_i]:
            continue
        value = cells[decode_i]
        if not value or value.upper() == "PENDING":
            continue
        try:
            float(value)
        except ValueError:
            continue
        return True
    return False
