"""Frozen check C4 (issue #319, AC2's committed half): CONTRIBUTING.md carries
a standing Dependabot triage policy under the Dependency currency policy
section (trace 319-dependency-gate-follow-through, revision 4).

This file is the POLICY GUARD ONLY — the AC3 workflow-condition guard moved
to tests/test_master_push_advisory_scan.py (the issue's exact file name),
which evaluates the job-if truth table instead of substring-matching.

Revision 4 (plan-critic round 3): SIX classes, precedence
``T1 > T2 > T3 > PIN > T5 > T4``:
  - T1, extractor-twin break {mammoth, pdfjs-dist} -> close;
  - T2, @types/node major ABOVE THE BASELINE -> close. The baseline exception
    is recorded in the policy: the baseline is @types/node 26 (desktop and
    packtool), established by maintainer merge on 2026-11-07 (PRs #302/#317),
    so bumps to 26.x are compatible and bumps above it close. T2 still
    discloses that tests/test_runtime_pins.py does NOT inspect @types/node;
  - T3, epic-#284 reserved majors — NARROWED to exactly
    {@huggingface/transformers, vitest} (round-2 ruling: ASK 6 owns only the
    transformers and vitest families) -> stay open, label
    ``epic-284-decision``, comment linking #284 (ASK 6); an agent never
    merges these;
  - PIN (new), a GitHub-Actions action bump whose new @sha is not recorded in
    .github/workflows/pins.json -> the PR must add the pins.json entry in the
    same PR, otherwise close with a comment naming the pin-record contract
    (.github/workflows/pins.json, enforced by acceptance-precision-contract.test.ts);
  - T5, any other semver-major with NO owning epic decision -> stay open with
    a class comment and label ``deps:major-review`` (NOT epic-284-decision;
    no generic #284 ownership). electron and typescript majors land here;
  - T4, contract-compatible minor/patch/digest -> stays open; no agent merges
    or closes these.

The guard is SEMANTIC (round-2 F6): the section is read with fenced code
blocks and HTML comments stripped (policy hidden in a fence or a comment does
not count), and per class it pins the ACTION, not just a keyword:
  - T1 / T2 / PIN: close WITH a contract-naming comment, and the block
    carries no negated or opposite action ("do not close", "keep open",
    "stay open"); PIN must demand the pins.json entry in the SAME PR and must
    not permit merging without it;
  - T3: label ``epic-284-decision``, stay open, the owning-epic link phrase
    ``comment linking [epic ]#284``, ASK 6, and "an agent never merges";
  - T5: label ``deps:major-review``, stay open, and NO epic-284-decision /
    owning-epic claim (a T5 that claims epic-284-decision fails);
  - T4: stays open and says no agent merges or closes it;
  - the recurrence sentence: Dependabot recreates ``single-sided`` bumps and
    ``close-with-comment`` is the ``standing mechanism``.
Named negative legs: reversed precedence, a removed class, a wrong label,
negated T1 action ("do not close"), T1 "keep open", T3 without the owning
link, T4 permitting an agent merge, PIN allowing merge without the pins.json
update, T5 claiming epic-284-decision, a missing recurrence sentence, and the
whole policy hidden in a fence/comment.

Marker format (stated for the production author, and pinned by the embedded
exemplar below): each class block starts with a bold ``**T<n>`` or ``**PIN``
marker, the six blocks appear in the order T1, T2, T3, PIN, T5, T4, and the
member list of the T1 and T3 blocks is the FIRST parenthesized group inside
that block, comma-separated, backticks allowed around each name. The
precedence sentence is plain text (no bold markers). The exemplar is the
reference wording.

Stdlib + pytest only (no yaml needed here).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRIBUTING = REPO_ROOT / "CONTRIBUTING.md"

TRIAGE_HEADING = "### Triaging Dependabot update PRs"
POLICY_HEADING = "## Dependency currency policy"
PRECEDENCE = "T1 > T2 > T3 > PIN > T5 > T4"
EXPECTED_ORDER = ["T1", "T2", "T3", "PIN", "T5", "T4"]

# A bold class marker: "**T1", "**T2", ... or "**PIN" (the class-block openers).
CLASS_MARKER = re.compile(r"\*\*(T\d|PIN)\b")

TWIN_SET = {"mammoth", "pdfjs-dist"}
RESERVED_MAJORS = {"@huggingface/transformers", "vitest"}

# A negated or contradicting action inside a CLOSE class (T1/T2/PIN).
NEGATED_CLOSE = re.compile(
    r"\b(?:do not|don't|never|must not|should not|not)\s+(?:be\s+)?clos\w*"
    r"|\b(?:keep|kept|stay|stays|remain|remains|leave|left)\s+(?:it\s+|the\s+pr\s+)?open",
    re.IGNORECASE,
)
# The owning-epic link requirement for T3.
OWNING_LINK = re.compile(r"comment linking (?:epic )?#284", re.IGNORECASE)
# T4: agents never merge nor close it.
T4_NO_MERGE_NO_CLOSE = re.compile(
    r"\b(?:no agent|an agent never|agents never)\s+(?:merges or closes|merge or close)\b",
    re.IGNORECASE,
)
# Any text permitting an agent merge.
AGENT_MERGE_PERMITTED = re.compile(
    r"\bagents?\s+(?:may|can|should|will|is allowed to|are allowed to)\s+(?:\w+\s+)?merge"
    r"|\bauto-?merge",
    re.IGNORECASE,
)
# PIN: any text that lets the PR merge without the pins.json update.
PIN_MERGE_WITHOUT_UPDATE = re.compile(
    r"\b(?:may|can)\s+merge\b|\bmerge[sd]?\s+without\s+(?:a\s+|the\s+)?pins\.json",
    re.IGNORECASE,
)
STAY_OPEN = re.compile(r"stay open|stays open|remain open|remains open", re.IGNORECASE)


def _strip_non_prose(text: str) -> str:
    """Drop HTML comments and fenced code blocks (``` or ~~~): policy text
    hidden there is not policy (rev 3)."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(
        r"^[ \t]*```.*?^[ \t]*```[^\n]*$", "", text, flags=re.DOTALL | re.MULTILINE
    )
    text = re.sub(
        r"^[ \t]*~~~.*?^[ \t]*~~~[^\n]*$", "", text, flags=re.DOTALL | re.MULTILINE
    )
    return text


def _check_policy(section_text: str) -> None:
    """All C4 pins over the triage section BODY (heading stripped, non-prose
    already removed by the caller).

    Raises AssertionError on the first violation; returns None when the
    section satisfies every pin."""
    # Markdown reflows prose freely: compare on whitespace-collapsed text so a
    # pinned phrase that wraps across lines still counts (and still binds).
    section_text = re.sub(r"\s+", " ", section_text)
    assert (
        PRECEDENCE in section_text
    ), f"the triage policy must state the precedence sentence {PRECEDENCE!r}"

    markers = list(CLASS_MARKER.finditer(section_text))
    keys = [m.group(1) for m in markers]
    assert keys == EXPECTED_ORDER, (
        f"the class markers must appear exactly once each, in order "
        f"T1, T2, T3, PIN, T5, T4 (revision-4 precedence); got {keys}"
    )
    bounds = [m.start() for m in markers] + [len(section_text)]
    blocks = {
        markers[i].group(1): section_text[bounds[i] : bounds[i + 1]]
        for i in range(len(markers))
    }

    def members(block: str, label: str) -> set[str]:
        match = re.search(r"\(([^)]*)\)", block)
        assert (
            match is not None
        ), f"the {label} block must open with its member list in parentheses"
        return {
            part.strip().strip("`").lower()
            for part in match.group(1).split(",")
            if part.strip().strip("`")
        }

    twins = members(blocks["T1"], "T1")
    assert (
        twins == TWIN_SET
    ), f"the T1 extractor-twin set must be exactly {sorted(TWIN_SET)}; got {sorted(twins)}"
    # Round-3 ruling: ASK 6 owns ONLY the transformers and vitest families.
    reserved = members(blocks["T3"], "T3")
    assert reserved == RESERVED_MAJORS, (
        f"the T3 reserved-major set must be exactly {sorted(RESERVED_MAJORS)} "
        f"(electron and typescript majors move to T5); got {sorted(reserved)}"
    )

    # T1/T2/PIN: close, with a contract-naming comment, and never a negated action.
    for key in ("T1", "T2", "PIN"):
        block = blocks[key]
        assert re.search(
            r"\bclose\b", block, re.IGNORECASE
        ), f"class {key} must state the CLOSE action"
        negated = NEGATED_CLOSE.search(block)
        assert (
            negated is None
        ), f"class {key} negates or contradicts its close action: {negated.group(0)!r}"
        assert re.search(
            r"comment naming", block, re.IGNORECASE
        ), f"class {key} must close WITH a contract-naming comment"
        assert not AGENT_MERGE_PERMITTED.search(
            block
        ), f"class {key} must not permit an agent merge"

    # T3 (narrowed): label epic-284-decision, stay open, ASK 6, owning link,
    # and an agent never merges.
    t3 = blocks["T3"]
    assert "epic-284-decision" in t3, "class T3 must label the PR epic-284-decision"
    assert STAY_OPEN.search(
        t3
    ), "class T3 must keep the PR open (the maintainer decides)"
    assert OWNING_LINK.search(
        t3
    ), "class T3 must comment linking the owning epic decision (#284)"
    assert "ASK 6" in t3, "class T3 must cite ASK 6 as the owning epic decision"
    assert re.search(
        r"agent never merges", t3, re.IGNORECASE
    ), "class T3 must say an agent never merges the reserved majors"
    assert not AGENT_MERGE_PERMITTED.search(
        t3
    ), "class T3 must not permit an agent merge"

    # PIN: the pins.json entry must land in the SAME PR; merging without the
    # update is never permitted.
    pin = blocks["PIN"]
    assert "pins.json" in pin, "class PIN must name .github/workflows/pins.json"
    assert (
        "acceptance-precision-contract" in pin
    ), "class PIN must name the enforcing contract (acceptance-precision-contract.test.ts)"
    assert re.search(
        r"same PR", pin, re.IGNORECASE
    ), "class PIN must demand the pins.json entry in the SAME PR"
    assert not PIN_MERGE_WITHOUT_UPDATE.search(
        pin
    ), "class PIN must not permit merging without the pins.json update"

    # T5 (amended): label deps:major-review, stay open, NO epic-284-decision
    # and NO owning-epic claim; electron and typescript majors land here.
    t5 = blocks["T5"]
    assert "deps:major-review" in t5, "class T5 must label the PR deps:major-review"
    assert STAY_OPEN.search(
        t5
    ), "class T5 must keep the PR open (the maintainer decides)"
    assert (
        "epic-284-decision" not in t5
    ), "class T5 must NOT carry the epic-284-decision label (no generic #284 ownership)"
    assert not OWNING_LINK.search(
        t5
    ), "class T5 must not claim an owning-epic link (ASK 6 owns only transformers/vitest)"
    assert not AGENT_MERGE_PERMITTED.search(
        t5
    ), "class T5 must not permit an agent merge"
    assert (
        "electron" in t5 and "typescript" in t5
    ), "class T5 must state that electron and typescript majors land here"

    # T4: stays open; no agent merges or closes it.
    t4 = blocks["T4"]
    assert STAY_OPEN.search(
        t4
    ), "class T4 must keep the PR open (the maintainer decides)"
    assert T4_NO_MERGE_NO_CLOSE.search(
        t4
    ), "class T4 must say no agent merges or closes it"
    assert not AGENT_MERGE_PERMITTED.search(
        t4
    ), "class T4 must not permit an agent merge"

    # T2's @types/node disclosure (critic F9) and the recorded baseline
    # exception (round 3): the baseline is @types/node 26, established by
    # maintainer merge on 2026-11-07 (PRs #302/#317).
    t2 = blocks["T2"]
    assert "@types/node" in t2, "T2 must name @types/node as its trigger surface"
    assert "test_runtime_pins" in t2, "T2 must name the test_runtime_pins.py contract"
    assert re.search(
        r"does not inspect", t2, re.IGNORECASE
    ), "T2 must disclose that test_runtime_pins.py does not inspect @types/node today"
    assert re.search(
        r"@types/node 26", t2
    ), "T2 must record the @types/node 26 baseline (desktop and packtool)"
    assert "26.x" in t2, "T2 must state that bumps to 26.x are compatible"
    assert (
        "#302" in t2 and "#317" in t2
    ), "T2 must cite PRs #302/#317 as the baseline's origin"
    assert "2026-11-07" in t2, "T2 must record the baseline date (2026-11-07)"

    # Recurrence (critic F9): single-sided twin bumps recur; close-with-comment
    # is the standing mechanism.
    assert re.search(
        r"single-sided", section_text, re.IGNORECASE
    ), "the policy must state that single-sided twin bumps recur"
    assert re.search(
        r"\b(?:recreat\w*|recur\w*)", section_text, re.IGNORECASE
    ), "the policy must state that Dependabot recreates the single-sided bumps"
    assert re.search(
        r"close-with-comment", section_text, re.IGNORECASE
    ), "the policy must name close-with-comment as the response to a recurrence"
    assert re.search(
        r"standing mechanism", section_text, re.IGNORECASE
    ), "the policy must call close-with-comment the standing mechanism"


# ---------------------------------------------------------------------------
# the documented exemplar (also the helper's positive control; passes at base)
# ---------------------------------------------------------------------------

_EXEMPLAR = """
Standing policy, highest precedence first: T1 > T2 > T3 > PIN > T5 > T4.

- **T1, extractor-twin break (`mammoth`, `pdfjs-dist`) → close.** A
  single-sided bump breaks `tests/test_extractor_twins.py` (one exact version
  per extractor twin across the three lockfiles). Close with a comment naming
  that contract.
- **T2, Node runtime mismatch above the baseline (`@types/node`) → close.**
  A `@types/node` major beyond the runtime pin would type-check against APIs
  that are absent at runtime. `tests/test_runtime_pins.py` does not inspect
  `@types/node` today — this rule is policy, not an existing test. The
  baseline is @types/node 26 (desktop and packtool), established by
  maintainer merge on 2026-11-07 (PRs #302/#317): bumps to 26.x are
  compatible and bumps above it close, with a comment naming the Node-pin
  contract.
- **T3, epic-#284 reserved majors (`@huggingface/transformers`, `vitest`) →
  stay open.** Label `epic-284-decision` and comment linking epic #284 (ASK 6
  owns only these two families). An agent never merges these.
- **PIN, action bump without a pins.json entry → close.** A GitHub-Actions
  action bump whose new @sha is not recorded in `.github/workflows/pins.json`
  must add the pins.json entry in the same PR; otherwise close with a comment
  naming the pin-record contract (`.github/workflows/pins.json`, enforced by
  `acceptance-precision-contract.test.ts`).
- **T5, any other semver-major with no owning epic decision () → stay
  open.** Class comment and label `deps:major-review`. No epic-#284 decision
  owns these (ASK 6 owns only the transformers and vitest families);
  `electron` and `typescript` majors land here. The maintainer decides.
- **T4, contract-compatible minor/patch/digest () → stay open.** Class
  comment and stay open until the maintainer decides; no agent merges or
  closes these.

Recurrence: `.github/dependabot.yml` updates the three npm directories
independently, so Dependabot recreates single-sided twin bumps after every
close. Close-with-comment each time is the standing mechanism; an `ignore`
rule cannot express "only if all three lockfiles move".
"""


def _block_replace(text: str, key: str, old: str, new: str) -> str:
    """Replace ``old`` with ``new`` only inside the T1/T2/T3/PIN/T5/T4 block."""
    markers = list(CLASS_MARKER.finditer(text))
    bounds = [m.start() for m in markers] + [len(text)]
    for i, m in enumerate(markers):
        if m.group(1) == key:
            block = text[bounds[i] : bounds[i + 1]]
            assert old in block, f"mutation anchor {old!r} not in the {key} block"
            return text[: bounds[i]] + block.replace(old, new) + text[bounds[i + 1] :]
    raise AssertionError(f"no {key} block")  # pragma: no cover


def test_check_policy_accepts_the_documented_exemplar():
    """Positive control: the helper itself is satisfiable, in exactly the
    marker format the docstring documents."""
    _check_policy(_EXEMPLAR)


def test_check_policy_rejects_reversed_precedence():
    mutated = _EXEMPLAR.replace(PRECEDENCE, "T4 > T5 > PIN > T3 > T2 > T1")
    assert "T4 > T5 > PIN > T3 > T2 > T1" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_a_removed_class():
    # Drop the whole T3 block (from its bold marker up to the PIN marker).
    mutated = re.sub(
        r"\n- \*\*T3\b.*?(?=\n- \*\*PIN\b)", "", _EXEMPLAR, flags=re.DOTALL
    )
    assert "**T3" not in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_a_wrong_label():
    mutated = _EXEMPLAR.replace("epic-284-decision", "epic-284-decide")
    assert "epic-284-decision" not in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_negated_t1_action():
    mutated = _block_replace(_EXEMPLAR, "T1", "→ close.**", "→ do not close.**")
    assert "do not close" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_t1_keep_open():
    mutated = _block_replace(_EXEMPLAR, "T1", "→ close.**", "→ keep open.**")
    assert "keep open" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_t3_without_the_owning_link():
    mutated = _block_replace(
        _EXEMPLAR, "T3", "comment linking epic #284", "add a comment"
    )
    assert "comment linking epic #284" not in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_t3_with_electron_or_typescript():
    # The round-3 narrowing: electron/typescript must NOT be T3 members.
    mutated = _block_replace(
        _EXEMPLAR,
        "T3",
        "(`@huggingface/transformers`, `vitest`)",
        "(`@huggingface/transformers`, `vitest`, `electron`, `typescript`)",
    )
    assert "`typescript`)" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_t4_permitting_agent_merge():
    mutated = re.sub(
        r"no agent\s+merges or\s+closes these",
        "an agent may merge these once CI is green",
        _EXEMPLAR,
    )
    assert "an agent may merge" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_pin_allowing_merge_without_pins_json_update():
    mutated = _block_replace(
        _EXEMPLAR,
        "PIN",
        "must add the pins.json entry in the same PR; otherwise close with a comment",
        "may merge without a pins.json entry; close with a comment",
    )
    assert "may merge without" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_t5_claiming_epic_284_decision():
    mutated = _block_replace(
        _EXEMPLAR, "T5", "label `deps:major-review`", "label `epic-284-decision`"
    )
    assert "label `epic-284-decision`" in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_a_missing_baseline_exception():
    mutated = re.sub(
        r"The\s+baseline is @types/node 26.*?Node-pin\s+contract\.",
        "Close with a comment naming the Node-pin contract.",
        _EXEMPLAR,
        flags=re.DOTALL,
    )
    assert "@types/node 26" not in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_check_policy_rejects_missing_recurrence_sentence():
    mutated = _EXEMPLAR.split("\nRecurrence:")[0]
    assert "standing mechanism" not in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_policy(mutated)


def test_policy_hidden_in_fence_or_comment_does_not_count():
    fenced = "Intro text.\n\n```markdown\n" + _EXEMPLAR + "\n```\n"
    with pytest.raises(AssertionError):
        _check_policy(_strip_non_prose(fenced))
    commented = "Intro text.\n\n<!--\n" + _EXEMPLAR + "\n-->\n"
    with pytest.raises(AssertionError):
        _check_policy(_strip_non_prose(commented))
    # Positive control: the stripper leaves plain prose untouched.
    _check_policy(_strip_non_prose(_EXEMPLAR))


# ---------------------------------------------------------------------------
# the live CONTRIBUTING.md pin
# ---------------------------------------------------------------------------


def test_contributing_md_dependabot_triage_policy():
    text = _strip_non_prose(CONTRIBUTING.read_text(encoding="utf-8"))
    assert (
        POLICY_HEADING in text
    ), "CONTRIBUTING.md has no Dependency currency policy section"
    assert TRIAGE_HEADING in text, f"CONTRIBUTING.md has no {TRIAGE_HEADING!r} section"

    policy_at = text.index(POLICY_HEADING)
    triage_at = text.index(TRIAGE_HEADING)
    next_h2 = re.search(
        r"^## ", text[policy_at + len(POLICY_HEADING) :], flags=re.MULTILINE
    )
    policy_end = (
        len(text)
        if next_h2 is None
        else policy_at + len(POLICY_HEADING) + next_h2.start()
    )
    assert (
        policy_at < triage_at < policy_end
    ), "the triage section must sit under the Dependency currency policy section"

    body_start = triage_at + len(TRIAGE_HEADING)
    next_heading = re.search(r"^#{1,3} ", text[body_start:], flags=re.MULTILINE)
    section = (
        text[body_start:]
        if next_heading is None
        else text[body_start : body_start + next_heading.start()]
    )

    _check_policy(section)
