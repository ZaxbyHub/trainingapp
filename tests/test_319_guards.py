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
NEGATED_WAVE_REQUIREMENT = re.compile(
    r"\b(?:does\s+not|doesn't|need\s+not|not\s+required|may\s+skip)\s+"
    r"(?:\w+\s+){0,2}(?:require|verify|record|pass|gate|direct)\b",
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

    # PIN authority clarification (2026-11-16 wave follow-through): repairing the
    # pins.json prerequisite is not itself merge authorization.
    assert re.search(r"not itself merge authorization", section, re.IGNORECASE), (
        "the PIN block must state that repairing the pins.json prerequisite "
        "is not itself merge authorization"
    )


def _extract_wave_section(text: str) -> str:
    heading = "### Wave merges (explicit maintainer instruction only)"
    wave_at = text.index(heading)
    tail = text[wave_at + len(heading) :]
    next_heading = re.search(r"^#{1,3} ", tail, flags=re.MULTILINE)
    return tail if next_heading is None else tail[: next_heading.start()]


def _check_wave_section(section: str) -> None:
    """The wave-merge subsection pins (2026-11-16): bind the LOAD-BEARING
    phrases themselves, not adjacent keywords - removing the requirement a
    keyword describes must fail here (review round 1 on PR #355)."""
    collapsed = re.sub(r"\s+", " ", section)

    # Authorization shape: an explicit, batch-scoped maintainer instruction
    # naming the review-and-disposition verdict form.
    assert re.search(
        r"batch-scoped instruction", collapsed
    ), "the wave exception must be gated on an explicit batch-scoped instruction"
    assert re.search(
        r"When the maintainer issues", collapsed
    ), "the wave exception's authorizing actor must be the maintainer"
    # Reversed requirements keep every phrase above: reject negated-requirement
    # shapes outright (the same idiom as NEGATED_CLOSE on the triage classes).
    assert NEGATED_WAVE_REQUIREMENT.search(collapsed) is None, (
        "the wave subsection negates one of its own requirements "
        f"(matched {NEGATED_WAVE_REQUIREMENT.search(collapsed).group(0)!r})"
    )
    assert re.search(
        r"good to merge / needs work /", collapsed
    ), "the wave exception must name the review-and-disposition verdict form"
    assert re.search(r"that explicitly directs review-and-disposition", collapsed), (
        "the instruction must EXPLICITLY DIRECT review-and-disposition "
        "(affirmative verb bound)"
    )
    assert re.search(
        r"wave-mode exception", collapsed
    ), "the subsection must name the wave-mode exception"

    # Class bounds: T4 minors/patches plus repaired PIN; never T1/T2/T3/T5.
    assert re.search(
        r"T4 minor/patch/digest PRs only", collapsed
    ), "the wave exception must allow T4 minor/patch/digest PRs only"
    assert re.search(r"prerequisite has been repaired in the same PR", collapsed), (
        "the wave exception must require the PIN prerequisite HAS BEEN "
        "repaired in the same PR (affirmative verb bound)"
    )
    assert re.search(
        r"never covers T1, T2, T3 or T5", collapsed
    ), "the wave exception must name its class bounds (never T1/T2/T3/T5)"

    # Acceptance evidence: the rollup properties attach to the rollup phrase
    # itself, and post-merge verification is a compensating control.
    assert re.search(
        r"each merge requires a head CI rollup that is non-empt"
        r"y, fully completed \(zero pending\), and failure-free",
        collapsed,
    ), (
        "wave merges must REQUIRE a non-empty, zero-pending, "
        "failure-free head CI rollup (verb bound to subject)"
    )
    assert re.search(
        r"agent verifies post-merge CI on master", collapsed
    ), "wave merges must VERIFY post-merge CI on master (verb bound to subject)"
    assert re.search(
        r"compensating control, never a\s+substitute for the pre-merge rollup",
        collapsed,
    ), "post-merge green must be stated as a compensating control, not a substitute"

    # Authorization record: the ledger records the instruction verbatim and
    # every merge's SHA + acceptance evidence; PIN repair is not authority.
    assert re.search(
        r"records the instruction's verbatim text and every merge's SHA \+ acceptance evidence",
        collapsed,
    ), "the wave ledger must record the instruction verbatim and every merge's SHA + evidence"
    assert re.search(
        r"not merge authorization", collapsed
    ), "the subsection must restate that PIN repair is not merge authorization"
    assert re.search(
        r"exception dies with the instruction", collapsed
    ), "the wave-mode exception must die with its instruction (one instruction, one batch)"
    assert re.search(
        r"never carries forward as standing permission", collapsed
    ), "a prior wave must never carry forward as standing permission"


_WAVE_EXEMPLAR = """
### Wave merges (explicit maintainer instruction only)

The triage defaults above govern agent behavior when no maintainer instruction is in force.
When the maintainer issues a single, batch-scoped instruction that explicitly directs
review-and-disposition of Dependabot PRs (verdicts of the form "good to merge / needs work /
can be closed"), the executing agent may merge the PRs that instruction covers under this
wave-mode exception, bounded by ALL of:

- **Class bounds**: T4 minor/patch/digest PRs only, plus PIN-class PRs whose pins.json
  prerequisite has been repaired in the same PR. The exception never covers T1, T2, T3 or
  T5 - those stay exactly as their classes dictate, wave or no wave.
- **Acceptance evidence**: each merge requires a head CI rollup that is non-empty, fully
  completed (zero pending), and failure-free; the agent verifies post-merge CI on master
  before recording the disposition. Post-merge green is the compensating control, never a
  substitute for the pre-merge rollup.
- **Authorization record**: the executing agent's wave ledger records the instruction's
  verbatim text and every merge's SHA + acceptance evidence. Satisfying the PIN
  prerequisite is a repair, not merge authorization; merge authority comes from the
  instruction alone.
- **Scope**: one instruction, one batch. The exception dies with the instruction; the next
  batch needs its own. Satisfying PIN by itself does not create merge authority, and a
  prior wave never carries forward as standing permission.
"""


def test_wave_section_exemplar_passes():
    _check_wave_section(_WAVE_EXEMPLAR)


def test_wave_section_rejects_missing_rollup_requirement():
    mutated = _WAVE_EXEMPLAR.replace(
        "a head CI rollup that is non-empty, fully\n  completed (zero pending), and failure-free;",
        "a green build;",
    )
    assert "head CI rollup that is non-empty" not in re.sub(
        r"\s+", " ", mutated
    ), "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_missing_ledger_evidence():
    mutated = _WAVE_EXEMPLAR.replace(
        "records the instruction's\n  verbatim text and every merge's SHA + acceptance evidence.",
        "records that a wave happened.",
    )
    assert "every merge's SHA" not in re.sub(
        r"\s+", " ", mutated
    ), "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_implicit_authorization():
    mutated = _WAVE_EXEMPLAR.replace(
        "a single, batch-scoped instruction", "any maintainer conversation"
    )
    assert "batch-scoped instruction" not in mutated, "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_reserved_class_coverage():
    mutated = _WAVE_EXEMPLAR.replace(
        "The exception never covers T1, T2, T3 or\n  T5",
        "The exception may also cover T5 majors",
    )
    assert "never covers T1, T2, T3 or" not in re.sub(
        r"\s+", " ", mutated
    ), "mutation did not apply"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_actor_swap():
    """Reviewer round-2 falsifier: 'When anyone issues' keeps every phrase
    match while reversing who authorizes."""
    mutated = _WAVE_EXEMPLAR.replace("When the maintainer issues", "When anyone issues")
    assert "When the maintainer issues" not in mutated, "mutation did not apply"
    assert "batch-scoped instruction" in mutated, "mutation lost the phrase"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_negated_rollup_requirement():
    """Reviewer round-2 falsifier: 'does not require a head CI rollup' keeps
    the rollup phrase while reversing the requirement."""
    mutated = _WAVE_EXEMPLAR.replace(
        "each merge requires a head CI rollup",
        "each merge does not require a head CI rollup",
    )
    assert "head CI rollup that is non-empty" in re.sub(
        r"\s+", " ", mutated
    ), "mutation lost the phrase"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_requirement_without_its_verb():
    """Reviewer round-3 falsifier: 'can proceed without a head CI rollup'
    preserves the rollup phrase while deleting the requires-relationship."""
    mutated = _WAVE_EXEMPLAR.replace(
        "each merge requires a head CI rollup",
        "each merge can proceed without a head CI rollup",
    )
    assert "head CI rollup that is non-empty" in re.sub(
        r"\s+", " ", mutated
    ), "mutation lost the phrase"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_negated_direction():
    """Reviewer round-5 falsifier: 'that does not explicitly direct'
    keeps the actor, batch-scope and verdict-form phrases while removing
    the explicit-direction condition, and dodged the negation regex
    before 'direct' joined its verb set."""
    mutated = _WAVE_EXEMPLAR.replace(
        "that explicitly directs",
        "that does not explicitly direct",
    )
    assert "review-and-disposition" in re.sub(
        r"\s+", " ", mutated
    ), "mutation lost the phrase"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_negated_pin_repair():
    """Reviewer round-4 falsifier: 'need not be repaired in the same PR'
    keeps the trailing phrase while deleting the affirmative repair
    requirement (and dodges NEGATED_WAVE_REQUIREMENT - 'repaired' is not
    one of its requirement verbs)."""
    mutated = _WAVE_EXEMPLAR.replace(
        "prerequisite has been repaired in the same PR",
        "prerequisite need not be repaired in the same PR",
    )
    assert "repaired in the same PR" in re.sub(
        r"\s+", " ", mutated
    ), "mutation lost the trailing phrase"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_wave_section_rejects_postmerge_verb_swap():
    """Reviewer round-3 falsifier: 'ignores post-merge CI on master'
    preserves the post-merge phrase while deleting the verifies-relationship."""
    mutated = _WAVE_EXEMPLAR.replace(
        "the agent verifies post-merge CI on master",
        "the agent ignores post-merge CI on master",
    )
    assert "post-merge CI on master" in mutated, "mutation lost the phrase"
    with pytest.raises(AssertionError):
        _check_wave_section(mutated)


def test_contributing_md_wave_mode_exception():
    """The wave-merge subsection (added 2026-11-16 after two maintainer-directed
    waves falsified the T4 default) is pinned by _check_wave_section (exemplar +
    mutation legs above); this leg binds the LIVE document and the ordering of
    the defaults above it."""
    text = _strip_non_prose(CONTRIBUTING.read_text(encoding="utf-8"))
    heading = "### Wave merges (explicit maintainer instruction only)"
    assert heading in text, "CONTRIBUTING.md has no wave-merge subsection"

    _check_wave_section(_extract_wave_section(text))

    # The triage section (with its no-agent-merge T4 default) still sits ABOVE
    # the wave subsection, so the defaults remain the no-instruction behavior.
    wave_at = text.index(heading)
    triage_at = text.index(TRIAGE_HEADING)
    assert triage_at < wave_at, "the wave subsection must follow the triage section"
    triage_body = text[triage_at:wave_at]
    assert T4_NO_MERGE_NO_CLOSE.search(
        triage_body
    ), "the T4 no-merge default must remain in force above the wave subsection"
