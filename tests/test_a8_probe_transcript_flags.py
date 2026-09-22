"""Observability pins for the A8 probe transcript flags (PR #129 feedback round).

Complements the frozen issue-#58 acceptance checks
(tests/test_a8_training_player_evidence.py, checkpoint-pinned — do not edit
that file). These checks pin the evidence-observability fields added in the
PR-review feedback round so they cannot silently regress:

  - every probes.jumps[] record carries an integer `unstick_count` (the
    landed-but-unready slideReady recovery firings — forced-readiness
    landings must be distinguishable from natural ones in the evidence);
  - probes.txt_default carries a measured `html5_assets_in_source` integer
    (the html5/ tree is actually walked — the desktop-rendering-path ground
    truth is never asserted from a hardcoded literal);
  - the txt_default note does not hardcode an html5 count (it must reference
    the measured values).
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROBE_REL = "eval/a8-recipe-probe.json"


def _load_probe():
    path = REPO_ROOT / PROBE_REL
    assert path.is_file(), "required A8 artifact missing: %s" % PROBE_REL
    return json.loads(path.read_text(encoding="utf-8"))


def test_jump_records_carry_unstick_count():
    data = _load_probe()
    jumps = data["probes"]["jumps"]
    assert len(jumps) == 10, "expected the 10 frozen jump records"
    for idx, jump in enumerate(jumps):
        assert "unstick_count" in jump, "probes.jumps[%d] missing unstick_count" % idx
        count = jump["unstick_count"]
        assert (
            isinstance(count, int) and not isinstance(count, bool) and count >= 0
        ), "probes.jumps[%d].unstick_count must be a non-negative int (got %r)" % (
            idx,
            count,
        )


def test_txt_default_carries_measured_html5_count():
    data = _load_probe()
    block = data["probes"]["txt_default"]
    count = block.get("html5_assets_in_source")
    assert isinstance(count, int) and not isinstance(count, bool) and count >= 0, (
        "probes.txt_default.html5_assets_in_source must be a measured non-negative int "
        "(the html5/ tree must be walked, not hardcoded)"
    )
    note = block.get("note", "")
    assert (
        "html5/" in note
    ), "txt_default note must state the measured html5/ ground truth"
    assert (
        "0 txt__default files exist under html5/" not in note
    ), "txt_default note must not hardcode the html5 count as a literal"
