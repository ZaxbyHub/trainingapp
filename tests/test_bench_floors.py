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
