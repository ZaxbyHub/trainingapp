"""Merge quality + cost + asset provenance into the frozen-schema results
artifact `eval/bakeoff/results/bakeoff-results.json` (issue #55) and render
the markdown comparison-table fragment embedded in ADR-0001.

Validates the merged artifact against eval/bakeoff/schema.py (the same rules
the frozen acceptance checks C1-C6 enforce) and refuses to write on any
violation. Run in the repo .venv after bakeoff_quality.py + bakeoff_cost.py:
  python eval/bakeoff/collect.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import schema  # noqa: E402

QUALITY_REL = "eval/bakeoff/results/quality.json"
COST_REL = "eval/bakeoff/results/cost.json"
META_REL = "eval/bakeoff/assets/assets-meta.json"
OUT_REL = "eval/bakeoff/results/bakeoff-results.json"
TABLE_REL = "eval/bakeoff/results/adr-comparison-table.md"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quality", default=str(REPO_ROOT / QUALITY_REL))
    parser.add_argument("--cost", default=str(REPO_ROOT / COST_REL))
    parser.add_argument("--meta", default=str(REPO_ROOT / META_REL))
    parser.add_argument("--out", default=str(REPO_ROOT / OUT_REL))
    args = parser.parse_args(argv)

    quality = json.loads(Path(args.quality).read_text(encoding="utf-8"))
    cost = json.loads(Path(args.cost).read_text(encoding="utf-8"))
    meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))

    def cost_row(hf_id: str) -> dict:
        if hf_id not in cost["rows"]:
            raise SystemExit(
                "collect: %s is present in %s but missing from %s -- the two"
                " inputs come from mismatched candidate sets; re-run both"
                " drivers against the same registry" % (hf_id, args.quality, args.cost)
            )
        return cost["rows"][hf_id]

    embeddings: dict[str, dict] = {}
    for hf_id, record in quality["embeddings"].items():
        embeddings[hf_id] = {
            "dims": record["dims"],
            "license": meta[hf_id]["license"],
            "quality": record["quality"],
            "cpu": {
                "top15_ms_p50": cost_row(hf_id)["top15_ms_p50"],
                "top30_ms_p50": cost_row(hf_id)["top30_ms_p50"],
            },
        }

    rerankers: dict[str, dict] = {}
    for hf_id, record in quality["rerankers"].items():
        rerankers[hf_id] = {
            "license": meta[hf_id]["license"],
            "quality": record["quality"],
            "per_embedding": record.get("per_embedding", []),
            "cpu": {
                "top15_ms_p50": cost_row(hf_id)["top15_ms_p50"],
                "top30_ms_p50": cost_row(hf_id)["top30_ms_p50"],
                "pair_mean_ms_top15": cost_row(hf_id).get("pair_mean_ms_top15"),
            },
        }

    git_rev = None
    try:
        import subprocess

        git_rev = (
            subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            or None
        )
    except Exception:
        git_rev = None  # provenance stamp is best-effort; never blocks the merge

    merged = {
        "threads": quality["threads"],
        "hardware": quality["hardware"],
        "machine_tag": cost.get("machine_tag"),
        "generated_by": {
            "git_rev": git_rev,
            "collect": "eval/bakeoff/collect.py",
            "drivers": [
                "eval/bakeoff/bakeoff_quality.py",
                "eval/bakeoff/bakeoff_cost.py",
                "eval/bakeoff/fetch_assets.py",
            ],
        },
        "in_corpus": quality["in_corpus"],
        "out_of_corpus": quality["out_of_corpus"],
        "chunks": quality["chunks"],
        "chunker": quality["chunker"],
        "embeddings": embeddings,
        "rerankers": rerankers,
        "combos": quality["combos"],
        "prompts_used": quality["prompts_used"],
        "quality_sources": {
            hf_id: {
                "path": record.get("quality_path"),
                "load_source": record.get("load_source"),
            }
            for hf_id, record in quality["embeddings"].items()
        },
        "reranker_summary_basis": {
            hf_id: record["summary_basis"]
            for hf_id, record in quality["rerankers"].items()
        },
        "cost_assets": {
            hf_id: {"onnx": row["onnx"], "quant": row["onnx_quant"]}
            for hf_id, row in cost["rows"].items()
        },
        "provenance": {
            hf_id: {
                "license": entry["license"],
                "revision": entry["revision"],
                "quality_source": entry.get("quality_source"),
            }
            for hf_id, entry in meta.items()
        },
        "deviations": quality["deviations"],
        "execution_log": quality.get("execution_log", [])
        + cost.get("execution_log", []),
    }

    violations = schema.validate_results(merged)
    if violations:
        print("collect: REFUSING to write; schema violations:", file=sys.stderr)
        for violation in violations:
            print("  - %s" % violation, file=sys.stderr)
        return 1

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    print("collect: wrote %s (schema-valid)" % out_path)

    # PRR-019: commit the asset provenance (licenses + revisions) alongside the
    # decision artifact; the working copy under the gitignored assets dir stays
    # the execution-time original.
    meta_copy = out_path.parent / "assets-meta.json"
    meta_copy.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print("collect: wrote %s" % meta_copy)

    def q(record):
        quality_block = record["quality"]
        return (
            "%.3f / %.3f / %.3f"
            % (
                quality_block["recall@1"],
                quality_block["recall@3"],
                quality_block["recall@5"],
            ),
            quality_block["mrr"],
        )

    header = (
        "| Candidate | dims | recall@1/3/5 | MRR | CPU top15 p50 (ms) |"
        " CPU top30 p50 (ms) | license |"
    )
    lines = [header, "|---|---|---|---|---|---|---|"]
    for hf_id, record in embeddings.items():
        recalls, mrr = q(record)
        lines.append(
            "| %s | %d | %s | %.3f | %.1f | %.1f | %s |"
            % (
                hf_id,
                record["dims"],
                recalls,
                mrr,
                record["cpu"]["top15_ms_p50"],
                record["cpu"]["top30_ms_p50"],
                record["license"],
            )
        )
    for hf_id, record in rerankers.items():
        recalls, mrr = q(record)
        lines.append(
            "| %s | - | %s | %.3f | %.1f | %.1f | %s |"
            % (
                hf_id,
                recalls,
                mrr,
                record["cpu"]["top15_ms_p50"],
                record["cpu"]["top30_ms_p50"],
                record["license"],
            )
        )
    table_path = REPO_ROOT / TABLE_REL
    table_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("collect: wrote %s" % table_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
