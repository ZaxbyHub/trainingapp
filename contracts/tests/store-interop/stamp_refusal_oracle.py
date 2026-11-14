"""Mismatch-refusal oracle for the interop driver stamps (issue #325 AC3).

Proves the refusal at BOTH levels:
  helper level (legs 1-3, in-process):
    1. a deliberately MISMATCHED contract stamp pair refuses loud, naming both
       versions (executed mismatch leg);
    2. a MISSING stamp refuses loud (driver predating the stamp contract) —
       legs 2a (no contract_stamp) and 2b (contract present, driver_stamp
       absent) independently, so the presence loop's second key is pinned too;
    3. a MATCHING pair proceeds (no refusal).
  enforcement-seam level (leg 4, PR #347 swarm-pr-review F3): the refusal
    helper is worthless if main() never calls it, so this leg executes the
    REAL orchestration path — main() with fixture-controlled evidence —
    where leg 4a requires a nonzero exit with the stamp refusal named on
    stderr, and the matching control (leg 4b) must PASS the stamp gate and
    exit nonzero at the row comparison instead (zeroed evidence cannot
    satisfy the rows; the full-direction happy paths are covered by the real
    interop CI legs). Deleting the production enforcement call
    (run_interop.py's _stamp_pair_or_fail call site) turns leg 4 of this
    oracle RED (executed probe).
Mirrors the frozen-check convention of the store-interop harness: the oracle
exits 0 only when every leg behaves as designed.
"""

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_interop  # noqa: E402


def main() -> int:
    base = {
        "contract_stamp": run_interop.CONTRACT_STAMP,
        "driver_stamp": "interop-node-1",
    }

    # Leg 1: mismatched contract stamp refuses, naming both versions.
    writer = dict(base)
    reader = {"contract_stamp": "store-schema-v4", "driver_stamp": "interop-python-1"}
    try:
        run_interop._stamp_pair_or_fail(writer, reader)
    except RuntimeError as exc:
        message = str(exc)
        assert "contract stamp mismatch" in message, message
        assert "store-schema-v4" in message, message
        assert run_interop.CONTRACT_STAMP in message, message
        print(f"oracle leg 1 OK: contract mismatch refused -> {message}")
    else:
        raise AssertionError("mismatched contract stamp pair was not refused")

    # Leg 2a: missing contract_stamp refuses (pre-stamp driver).
    try:
        run_interop._stamp_pair_or_fail(dict(base), {"runtime": "python"})
    except RuntimeError as exc:
        message = str(exc)
        assert "no contract_stamp" in message, message
        print(f"oracle leg 2a OK: missing contract stamp refused -> {message}")
    else:
        raise AssertionError("missing-contract_stamp evidence was not refused")

    # Leg 2b: contract present, driver_stamp absent refuses independently
    # (the presence loop's second key is pinned, not shadowed by leg 2a's
    # earlier branch).
    try:
        reader = {"contract_stamp": run_interop.CONTRACT_STAMP}
        run_interop._stamp_pair_or_fail(dict(base), reader)
    except RuntimeError as exc:
        message = str(exc)
        assert "no driver_stamp" in message, message
        print(f"oracle leg 2b OK: missing driver stamp refused -> {message}")
    else:
        raise AssertionError("missing-driver_stamp evidence was not refused")

    # Leg 3: matching pair proceeds (no refusal).
    run_interop._stamp_pair_or_fail(dict(base), dict(base))
    print("oracle leg 3 OK: matching pair proceeds")

    # Leg 4 (enforcement seam): drive main() itself. The node side is
    # monkeypatched to emit fixture-controlled evidence; a recorder wraps
    # _stamp_pair_or_fail to pin that main() actually CALLS it (the seam the
    # production call site provides). Zeroed evidence cannot satisfy the row
    # comparison, so leg 4b's control asserts the run got PAST the stamp gate
    # (row-mismatch failure, not a stamp refusal) rather than a full pass —
    # the full-direction happy paths are covered by the real interop CI legs.
    import contextlib

    calls = {"stamp_pair_or_fail": 0}
    original_stamp_check = run_interop._stamp_pair_or_fail
    original_node_side = run_interop.node_side
    original_python_read = run_interop.python_read
    original_argv = sys.argv

    def recording_stamp_check(writer, reader):
        calls["stamp_pair_or_fail"] += 1
        return original_stamp_check(writer, reader)

    def node_evidence(payload: dict):
        def fake_node_side(db_path, mode):
            return {
                "runtime": "node",
                "contract_stamp": payload["contract_stamp"],
                "driver_stamp": "interop-node-1",
                "sqlite_vec_version": "0.0.0-oracle",
                "content_hashes": [],
                "docs_rows": 0,
                "chunks_rows": 0,
                "embeddings_rows": 0,
                "topk_ids": [],
                "topk_distances": [],
                "fts_hits": [],
            }

        return fake_node_side

    def fake_python_side(db_path, fixture):
        return {
            "runtime": "python",
            "contract_stamp": run_interop.CONTRACT_STAMP,
            "driver_stamp": run_interop.DRIVER_STAMP_PYTHON,
            "sqlite_vec_version": "0.0.0-oracle",
            "content_hashes": [],
            "docs_rows": 0,
            "chunks_rows": 0,
            "embeddings_rows": 0,
            "topk_ids": [],
            "topk_distances": [],
            "fts_hits": [],
        }

    run_interop._stamp_pair_or_fail = recording_stamp_check
    mismatched = dict(base)
    mismatched["contract_stamp"] = "store-schema-v999"
    try:
        sys.argv = ["run_interop.py", "--direction", "node->python"]
        run_interop.node_side = node_evidence(mismatched)
        run_interop.python_read = fake_python_side
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = run_interop.main()
        assert (
            calls["stamp_pair_or_fail"] == 1
        ), "main() never invoked the stamp refusal helper"
        assert code != 0, "mismatched-stamp run through main() must not exit 0"
        assert "contract stamp mismatch" in stderr.getvalue(), stderr.getvalue()
    finally:
        sys.argv = original_argv
        run_interop.node_side = original_node_side
        run_interop.python_read = original_python_read
        run_interop._stamp_pair_or_fail = original_stamp_check
    print(
        "oracle leg 4a OK: enforcement seam refused a mismatched stamp through main()"
    )

    run_interop._stamp_pair_or_fail = recording_stamp_check
    try:
        sys.argv = ["run_interop.py", "--direction", "node->python"]
        run_interop.node_side = node_evidence(base)
        run_interop.python_read = fake_python_side
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = run_interop.main()
        assert (
            calls["stamp_pair_or_fail"] == 2
        ), "main() skipped the stamp gate on the control run"
        assert (
            code != 0
        ), "zeroed evidence must fail the row comparison (control design)"
        assert "contract stamp mismatch" not in stderr.getvalue(), (
            "matching stamps were refused by the enforcement seam — the gate "
            "misfires on a matching pair"
        )
        assert "verdict mismatch" in stderr.getvalue(), stderr.getvalue()
    finally:
        sys.argv = original_argv
        run_interop.node_side = original_node_side
        run_interop.python_read = original_python_read
        run_interop._stamp_pair_or_fail = original_stamp_check
    print(
        "oracle leg 4b OK: enforcement seam passed a matching pair through to the row comparison"
    )

    print(
        "stamp_refusal_oracle OK: stamp pins verified at helper AND enforcement level"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
