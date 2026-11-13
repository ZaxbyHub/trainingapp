"""Mismatch-refusal oracle for the interop driver stamps (issue #325 AC3).

Imports run_interop's refusal helper and proves both directions:
  1. a deliberately MISMATCHED contract stamp pair refuses loud, naming both
     versions (executed mismatch leg);
  2. a MISSING stamp refuses loud (driver predating the stamp contract);
  3. a MATCHING pair proceeds (no refusal).
Mirrors the frozen-check convention of the store-interop harness: the oracle
exits 0 only when every leg behaves as designed.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_interop import _stamp_pair_or_fail  # noqa: E402


def main() -> int:
    base = {"contract_stamp": "store-schema-v5", "driver_stamp": "interop-node-1"}

    # Leg 1: mismatched contract stamp refuses, naming both versions.
    writer = dict(base)
    reader = {"contract_stamp": "store-schema-v4", "driver_stamp": "interop-python-1"}
    try:
        _stamp_pair_or_fail(writer, reader)
    except RuntimeError as exc:
        message = str(exc)
        assert "contract stamp mismatch" in message, message
        assert "store-schema-v5" in message and "store-schema-v4" in message, message
        print(f"oracle leg 1 OK: contract mismatch refused -> {message}")
    else:
        raise AssertionError("mismatched contract stamp pair was not refused")

    # Leg 2: missing stamp refuses (pre-stamp driver).
    try:
        _stamp_pair_or_fail(dict(base), {"runtime": "python"})
    except RuntimeError as exc:
        message = str(exc)
        assert "no contract_stamp" in message or "no driver_stamp" in message, message
        print(f"oracle leg 2 OK: missing stamp refused -> {message}")
    else:
        raise AssertionError("missing-stamp evidence was not refused")

    # Leg 3: matching pair proceeds (no refusal).
    _stamp_pair_or_fail(dict(base), dict(base))
    print("oracle leg 3 OK: matching pair proceeds")
    print("stamp_refusal_oracle OK: contract/driver stamp pins verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
