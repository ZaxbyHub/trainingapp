"""Frozen check C3 (issue #319 AC3): the Python advisory scan runs on EVERY
push to master, regardless of the conformance diff bucket, while PR-triggered
runs keep the bucket scoping (trace 319-dependency-gate-follow-through,
revision 2 — replaces the C3 half of tests/test_319_guards.py).

At base the python-conformance job condition gates every event on the bucket
(``!cancelled() && needs.changes.outputs.conformance != 'false'``), so a
docs-only or web-only master push skips the pip-audit step while the required
check reads Success.

Instead of substring-matching the condition (round-1 critic finding F6: too
easily evaded, e.g. by AND-negating the push term away), this guard carries a
tiny recursive-descent evaluator for the job-``if:`` grammar it needs —
``!``, ``&&``, ``||``, parentheses, ``==``, ``!=``, single-quoted strings,
``cancelled()``, ``github.event_name`` and ``needs.changes.outputs.<name>`` —
and asserts the TRUTH TABLE of the live condition read from
.github/workflows/conformance.yml:

    push           x bucket true  -> run
    push           x bucket false -> run   (the #319 requirement)
    pull_request   x bucket true  -> run
    pull_request   x bucket false -> skip  (PRs keep bucket scoping)
    any, cancelled              -> skip   (fail-safe prefix)

Plus: the pip-audit step stays present/pinned/merge-blocking, and
pack-fixture-build keeps its bucket-only polarity (the override is scoped to
the one job).

Revision 3 (plan-critic round 2, F5): the evaluator implements GitHub's
CASE-INSENSITIVE string equality, the executed 'PUSH' counterexample is a
named negative leg, and two further pins hold: the pip-audit step carries
NO step-level ``if:``, and the workflow's ``on.push.branches`` includes
``master``.

Stdlib + yaml (runs in the python-conformance job; rostered in security.yml).
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFORMANCE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "conformance.yml"


# ---------------------------------------------------------------------------
# workflow loading
# ---------------------------------------------------------------------------


def _jobs() -> dict:
    with open(CONFORMANCE_WORKFLOW, encoding="utf-8") as fh:
        return yaml.safe_load(fh)["jobs"]


def _condition(job: dict) -> str:
    """The job ``if:`` with the ``${{ }}`` wrapper removed (a leading ``!``
    is a YAML tag indicator, so ``!cancelled()`` conditions must be wrapped)."""
    cond = str(job.get("if", "")).strip()
    if cond.startswith("${{") and cond.endswith("}}"):
        cond = cond[3:-2].strip()
    return cond


# ---------------------------------------------------------------------------
# job-if condition evaluator (recursive descent)
# ---------------------------------------------------------------------------


class _ExprError(ValueError):
    """The condition left the supported job-if grammar (fail loudly)."""


def _tokenize(text: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        two = text[i : i + 2]
        if two in ("&&", "||", "==", "!="):
            tokens.append(("op", two))
            i += 2
            continue
        if ch == "(":
            tokens.append(("lparen", ch))
            i += 1
            continue
        if ch == ")":
            tokens.append(("rparen", ch))
            i += 1
            continue
        if ch == "!":
            tokens.append(("op", "!"))
            i += 1
            continue
        if ch == "'":
            end = text.find("'", i + 1)
            if end < 0:
                raise _ExprError(f"unterminated string literal at {i}")
            tokens.append(("string", text[i + 1 : end]))
            i = end + 1
            continue
        if ch.isalnum() or ch in "_.":
            j = i
            while j < n and (text[j].isalnum() or text[j] in "_."):
                j += 1
            name = text[i:j]
            if text.startswith("(", j):
                if name != "cancelled" or not text.startswith("()", j):
                    raise _ExprError(f"unsupported function call: {name!r}")
                tokens.append(("func", name))
                i = j + 2
            else:
                tokens.append(("name", name))
                i = j
            continue
        raise _ExprError(f"unexpected character {ch!r} at {i}")
    return tokens


def _truth(value: object) -> bool:
    return bool(value)


def _str(value: object) -> str:
    # GitHub string-compares booleans as 'true'/'false'.
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class _Parser:
    """Grammar (loosest to tightest binding):

    or   := and ('||' and)*
    and  := cmp ('&&' cmp)*
    cmp  := unary (('==' | '!=') unary)?
    unary:= '!' unary | primary
    prim := '(' or ')' | 'string' | name | cancelled()
    """

    def __init__(self, tokens: list[tuple[str, str]], env: dict[str, object]):
        self._tokens = tokens
        self._pos = 0
        self._env = env

    def _peek(self) -> tuple[str, str]:
        return (
            self._tokens[self._pos] if self._pos < len(self._tokens) else (None, None)
        )

    def parse(self) -> bool:
        value = self._or()
        if self._pos != len(self._tokens):
            raise _ExprError("trailing tokens after expression")
        return _truth(value)

    def _or(self) -> object:
        value = self._and()
        while self._peek() == ("op", "||"):
            self._pos += 1
            rhs = self._and()
            value = _truth(value) or _truth(rhs)
        return value

    def _and(self) -> object:
        value = self._cmp()
        while self._peek() == ("op", "&&"):
            self._pos += 1
            rhs = self._cmp()
            value = _truth(value) and _truth(rhs)
        return value

    def _cmp(self) -> object:
        left = self._unary()
        if self._peek() in (("op", "=="), ("op", "!=")):
            _, op = self._peek()
            self._pos += 1
            right = self._unary()
            # GitHub expression semantics: string comparison IGNORES CASE
            # (docs: "GitHub ignores case when comparing strings"; rev 3, F5).
            equal = _str(left).casefold() == _str(right).casefold()
            return equal if op == "==" else not equal
        return left

    def _unary(self) -> object:
        if self._peek() == ("op", "!"):
            self._pos += 1
            return not _truth(self._unary())
        return self._primary()

    def _primary(self) -> object:
        kind, val = self._peek()
        if kind == "lparen":
            self._pos += 1
            value = self._or()
            if self._peek()[0] != "rparen":
                raise _ExprError("missing ')'")
            self._pos += 1
            return value
        if kind == "string":
            self._pos += 1
            return val
        if kind == "func":
            if val != "cancelled":
                raise _ExprError(f"unsupported function {val!r}")
            self._pos += 1
            return bool(self._env.get("cancelled", False))
        if kind == "name":
            self._pos += 1
            if val in ("true", "false"):
                return val == "true"
            if val not in self._env:
                raise _ExprError(f"unbound name {val!r} (extend _env for it)")
            return self._env[val]
        raise _ExprError(f"unexpected token {(kind, val)!r}")


def _env(
    event_name: str,
    bucket_value: str,
    bucket: str = "conformance",
    cancelled: bool = False,
) -> dict[str, object]:
    return {
        "github.event_name": event_name,
        f"needs.changes.outputs.{bucket}": bucket_value,
        "cancelled": cancelled,
    }


def _eval(condition: str, env: dict[str, object]) -> bool:
    return _Parser(_tokenize(condition), env).parse()


# ---------------------------------------------------------------------------
# C3 pins
# ---------------------------------------------------------------------------


def test_python_conformance_runs_on_every_master_push():
    """The #319 truth table over the LIVE python-conformance condition."""
    cond = _condition(_jobs()["python-conformance"])
    # (A wrong or missing term leaves the supported grammar/env and raises
    # _ExprError loudly — the truth table below is the substance.)

    # Push runs REGARDLESS of the conformance bucket (the #319 requirement).
    assert _eval(cond, _env("push", "true")) is True
    assert (
        _eval(cond, _env("push", "false")) is True
    ), f"a master push with a python-safe-false diff still skips the scan: {cond!r}"
    # PR-triggered runs keep the conformance-bucket scoping.
    assert _eval(cond, _env("pull_request", "true")) is True
    assert _eval(cond, _env("pull_request", "false")) is False
    # The fail-safe prefix: a cancelled run never executes the scan.
    assert _eval(cond, _env("push", "true", cancelled=True)) is False
    assert _eval(cond, _env("pull_request", "false", cancelled=True)) is False


def test_evaluator_rejects_the_and_negated_evasion_on_push_legs():
    """Round-1 critic F6 evasion: the push term is present but AND-negated
    away, so substring pins pass while every push leg skips. The evaluator
    must catch it: NO push leg may satisfy this condition."""
    evasion = (
        "!cancelled() && ((github.event_name == 'push' "
        "|| needs.changes.outputs.conformance != 'false') "
        "&& github.event_name != 'push')"
    )
    for bucket in ("true", "false"):
        assert (
            _eval(evasion, _env("push", bucket)) is False
        ), f"the AND-negated evasion must fail the push legs (bucket={bucket})"
    # Sanity: the evaluator is not merely returning False for everything.
    assert _eval(evasion, _env("pull_request", "true")) is True
    assert _eval(evasion, _env("pull_request", "false")) is False
    assert _eval(evasion, _env("push", "true", cancelled=True)) is False


def test_evaluator_grammar_semantics():
    """Self-test of the evaluator itself (passes at base; tests the guard,
    not the repo): parens, !, ==/!= and truthiness."""
    assert (
        _eval("(github.event_name == 'push') || (false)", _env("push", "false")) is True
    )
    assert (
        _eval("!(github.event_name == 'push')", _env("pull_request", "false")) is True
    )
    assert _eval("'push' != github.event_name", _env("push", "false")) is False
    assert (
        _eval("!cancelled() && github.event_name == 'push'", _env("push", "false"))
        is True
    )
    assert _eval("cancelled()", _env("push", "false", cancelled=True)) is True
    try:
        _eval("always()", _env("push", "false"))
    except _ExprError:
        pass
    else:  # pragma: no cover - the unsupported construct must raise
        raise AssertionError("always() must be rejected, not silently mis-evaluated")


def test_pip_audit_step_present_pinned_and_merge_blocking():
    """The scan the condition gates must actually be there: the pip-audit
    step runs python scripts/pip_audit_gate.py with no continue-on-error."""
    job = _jobs()["python-conformance"]
    steps = job.get("steps", [])
    audit = [s for s in steps if "pip_audit_gate.py" in str(s.get("run", ""))]
    assert audit, "python-conformance lost its pip-audit step (issue #277 AC5 / #319)"
    run = str(audit[0]["run"])
    assert (
        "python scripts/pip_audit_gate.py" in run
    ), f"the gate script is not invoked: {run!r}"
    assert not audit[0].get(
        "continue-on-error"
    ), "the advisory scan must be merge-blocking"


def test_pack_fixture_build_keeps_bucket_only_polarity():
    """The #319 override is scoped to python-conformance: pack-fixture-build
    stays bucket-gated (push x pack=false skips it, exactly as at base)."""
    cond = _condition(_jobs()["pack-fixture-build"])
    assert (
        _eval(cond, _env("push", "false", bucket="pack")) is False
    ), f"pack-fixture-build must not carry the push override: {cond!r}"
    assert _eval(cond, _env("pull_request", "true", bucket="pack")) is True
    assert _eval(cond, _env("pull_request", "false", bucket="pack")) is False


# ---------------------------------------------------------------------------
# revision 3 pins (plan-critic round 2, F5)
# ---------------------------------------------------------------------------


def test_evaluator_string_equality_is_case_insensitive():
    """GitHub ignores case when comparing strings: the evaluator must too,
    or a mutant that only differs by literal case is mis-evaluated."""
    assert _eval("github.event_name == 'PUSH'", _env("push", "false")) is True
    assert _eval("github.event_name != 'Push'", _env("push", "false")) is False
    assert (
        _eval(
            "needs.changes.outputs.conformance != 'FALSE'",
            _env("pull_request", "false"),
        )
        is False
    )
    assert _eval("github.event_name == 'PUSH'", _env("pull_request", "false")) is False


def test_evaluator_rejects_the_case_folded_push_counterexample():
    """The executed round-2 counterexample: an upper-case 'PUSH' term ANDed
    with a lower-case `!= 'push'` conjunct. Under GitHub's case-insensitive
    equality 'PUSH' == 'push' is TRUE, so `github.event_name != 'push'` is
    FALSE on push and the whole condition is FALSE -> the job SKIPS on every
    push. The push legs must therefore reject this mutant."""
    mutant = (
        "!cancelled() && ((github.event_name == 'PUSH' "
        "|| needs.changes.outputs.conformance != 'false') "
        "&& github.event_name != 'push')"
    )
    for bucket in ("true", "false"):
        assert (
            _eval(mutant, _env("push", bucket)) is False
        ), f"the case-folded counterexample must fail the push legs (bucket={bucket})"

    def _push_legs_pass(cond: str) -> bool:
        return all(_eval(cond, _env("push", b)) for b in ("true", "false"))

    assert not _push_legs_pass(
        mutant
    ), "the push-leg assertion must catch the case-folded mutant"
    # Sanity: the evaluator is not returning False for everything.
    assert _eval(mutant, _env("pull_request", "true")) is True
    assert _eval(mutant, _env("pull_request", "false")) is False


def test_pip_audit_step_has_no_step_level_if():
    """A step-level ``if:`` could re-gate the scan on push even though the
    job runs; the pip-audit step must carry none."""
    steps = _jobs()["python-conformance"].get("steps", [])
    audit = [s for s in steps if "pip_audit_gate.py" in str(s.get("run", ""))]
    assert audit, "python-conformance lost its pip-audit step (issue #277 AC5 / #319)"
    assert (
        "if" not in audit[0]
    ), f"the pip-audit step must not carry a step-level if: {audit[0].get('if')!r}"


def test_workflow_push_trigger_includes_master():
    """The 'every push to master' requirement presupposes the workflow is
    triggered by pushes to master at all."""
    with open(CONFORMANCE_WORKFLOW, encoding="utf-8") as fh:
        workflow = yaml.safe_load(fh)
    # PyYAML (YAML 1.1) loads the bare key `on` as boolean True.
    triggers = workflow.get("on", workflow.get(True))
    assert isinstance(
        triggers, dict
    ), f"conformance.yml has no mapping trigger block: {triggers!r}"
    push = triggers.get("push")
    assert isinstance(
        push, dict
    ), f"conformance.yml has no push trigger mapping: {push!r}"
    branches = push.get("branches") or []
    assert (
        "master" in branches
    ), f"conformance.yml on.push.branches must include master: {branches!r}"
