"""Acceptance guardrail for the ADR-0003 desktop-backend decision (issue #57).

Pins the three permanent artifacts issue #57 commits (the throwaway spike/
trees are deleted post-merge and are deliberately NOT validated):

  - docs/adr/0003-desktop-backend.md
  - eval/adr0003-matrix.json
  - eval/adr0003-e2e-evidence.json

Exactly five checks, one per frozen acceptance check id (the trace's
repro/check-cN.sh drivers select these by -k suffix):

  test_c1_decision          (-k c1_decision)
  test_c2_matrix_complete   (-k c2_matrix_complete)
  test_c3_reranker_outcome  (-k c3_reranker_outcome)
  test_c4_wsb_adjustment    (-k c4_wsb_adjustment)
  test_c5_e2e_evidence      (-k c5_e2e_evidence)

=======================================================================
CONTRACT FOR THE IMPLEMENTER — exact schemas these tests accept
=======================================================================

1. docs/adr/0003-desktop-backend.md
   - Title line starting "# ADR-0003".
   - Front matter lines exactly like ADR-0002's:
       - **Status:** <non-empty>            (line "- **Status:** ...")
       - **Issue:** must reference issue 57 (contains "#57" or "issues/57")
       - **Evidence:** <non-empty>
   - A level-2 "## Decision" section. Its prose must bind EXACTLY ONE of
     the two option tokens to a choice. The binding grammar (documented,
     deterministic):
       option tokens:   /\\bnode(\\.?js)?\\b/i  and  /\\bpython[\\s-]?sidecar\\b/i
       choice verbs:    chose|chosen|choose|choosing|select(s|ed|ing)|
                        selection is/:|pick(s|ed|ing)|adopt(s|ed|ing)|
                        recommend(s|ed|ation)|prefer(s|red|ring)|win(s|ning)|
                        won|decided on|decision is/:|go(es) with|went with|
                        winner
       A sentence positively binds an option when a choice verb and the
       option token occur in the SAME sentence within 80 characters of each
       other (either order) with NO negation token between them, no
       negation token in the verb's own clause (the up-to-30 characters
       before the verb, clipped at the nearest preceding ";", ":" or ","),
       and no clause boundary (";", ":", "but", "whereas", "although",
       "while", "over") inside the verb-option gap. Negation tokens
       include not/never/no/did not/doesn't/reject*/declin*/eliminat*/
       discard*/dismiss*/instead of/rather than/against/avoid*/exclud*.
       Rationale participles (choosing/selecting/preferring/adopting/
       picking/recommending) bind only forward — the option they trail
       is never bound by them.
     Canonical phrasings that satisfy it:
       "We chose the node backend."          -> binds {node}
       "Decision: adopt the python-sidecar." -> binds {python-sidecar}
       "We chose node over python-sidecar."  -> binds {node}
       "We did not choose node; we chose python-sidecar." -> {python-sidecar}
     The test fails when 0 or 2 options are positively bound.
   - The decision/comparison table (the pipe table covering the most
     (metric, slice) pairs) must cover all 7 metrics x both slices
     ('node' and 'python-sidecar'), accepting either orientation:
       metrics-as-rows (columns named per slice) or slices-as-rows (a
       slice/option/backend column plus per-metric columns). Every value
     cell must be non-empty, free of TBD/TODO/TBC/PLACEHOLDER/FIXME, and:
       - for the 5 numeric metrics, cite EXACTLY the recorded number
         (each numeric token in the cell must equal the JSON value; keep
         qualifiers like "MB"/"s" but no second number — write
         "245.3 MB", not "245.3 MB (was 251)");
       - for the 2 string metrics, contain the recorded JSON string
         (whitespace-normalized substring match).
     Metric labels are matched on whitespace/punctuation-normalized text:
       install_size_mb       "install size"
       cold_start_s          "cold start" or "first ready"
       first_token_latency_s "first token" AND "2k" or "2048"
                             (the 2k-token-prompt qualifier is required)
       decode_tok_s          "decode" or "tok/s"
       peak_rss_mb           "rss" or "resident set" or "peak memory"
       ci_build_reliability  "ci" (as a word) with "build" or "reliab"
       cancellation_stop     "cancel"
   - A reranker-defect verdict: at least one sentence containing a
     "reproduc*" word AND ("rerank" or "pyinstaller"), with polarity
     matching the JSON verdict — "did not reproduce"/"not reproduced"/...
     reads as False, bare "reproduced"/"reproduction confirmed" reads as
     True. All such sentences must agree. The ADR must also identify the
     defect ("reranking.py" near "62", or the literal "local_files_only").
   - A "## WS-B issue list adjustment" section (heading containing
     "ws-b", "issue", "adjustment", case-insensitive) naming BOTH "#61"
     (or "PR 3") and "#62" (or "PR 4"), each with an explicit disposition
     within the 400 characters after a mention:
       no-update style:  "no update/change/adjustment ... needed|required",
                         "unchanged", "remains as-is/valid/correct"
       fast-follow style: "fast-follow", "follow-up", "tracked/filed/
                         deferred ... in/to/as #N", "#N tracks ..."
     A bare disposition with <15 characters of prose after it in the
     window is rejected (a reason or link target must accompany it).

2. eval/adr0003-matrix.json  (schema id: "adr0003-matrix/1")

   {
     "schema": "adr0003-matrix/1",
     "metrics": {
       "install_size_mb":       {"node": <number>, "python-sidecar": <number>},
       "cold_start_s":          {"node": <number>, "python-sidecar": <number>},
       "first_token_latency_s": {"node": <number>, "python-sidecar": <number>},
       "decode_tok_s":          {"node": <number>, "python-sidecar": <number>},
       "peak_rss_mb":           {"node": <number>, "python-sidecar": <number>},
       "ci_build_reliability":  {"node": "<str>",  "python-sidecar": "<str>"},
       "cancellation_stop":     {"node": "<str>",  "python-sidecar": "<str>"}
     },
     "reranker_local_files_only_reproduced": <bool>
   }

   - The 5 numeric metric values are finite JSON numbers > 0 (bools are
     rejected as numbers); the 2 string metric values are non-empty,
     non-placeholder strings. Extra top-level keys are ignored; the two
     slice keys are exactly "node" and "python-sidecar".

3. eval/adr0003-e2e-evidence.json  (schema id: "adr0003-e2e-evidence/1")

   {
     "schema": "adr0003-e2e-evidence/1",
     "machine": {
       "tag": "devstation",
       "cpu": "<non-empty str>",
       "ram": "<non-empty str>",
       "os": "<non-empty str>",
       "gpu": "<non-empty str>",
       "reference_i5_status": "<str containing 'PENDING'>"
     },
     "slices": {
       "node": {
         "installer": {
           "filename": "<non-empty str>",
           "sha256": "<exactly 64 hex chars, not a repeated-block pattern>",
           "size_bytes": <int > 0>,
           "ci_run_url": "<http(s) URL with a dotted host and a path>"
         },
         "streamed_answer": {
           "streamed": true,
           "token_count": <int > 0>,
           "done_event": true,
           "grounding": "<non-empty str | int > 0 | non-empty list of str>"
         },
         "cancellation": {"stop_latency_s": <finite number > 0>}
       },
       "python-sidecar": { ...same shape as node... }
     }
   }

   - Placeholder strings ("", "TBD", "TODO", "TBC", "PLACEHOLDER",
     "FIXME", "XXX", "N/A", "unknown", bare punctuation) are rejected
     everywhere. The two slices' installer filenames and sha256 values
     must differ (two distinct packaged builds cannot be byte-identical).
     `streamed` and `done_event` must be JSON true; `token_count` must be
     a real int > 0; `stop_latency_s` must be finite and > 0; `tag` must
     be exactly "devstation"; `reference_i5_status` must contain
     "PENDING" (any case).

Stdlib-only; no network; no subprocess; deterministic; well under 5 s.
Every failure message names the exact artifact and the violated rule.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ADR_REL = "docs/adr/0003-desktop-backend.md"
MATRIX_REL = "eval/adr0003-matrix.json"
E2E_REL = "eval/adr0003-e2e-evidence.json"

MATRIX_SCHEMA_ID = "adr0003-matrix/1"
E2E_SCHEMA_ID = "adr0003-e2e-evidence/1"
SLICES = ("node", "python-sidecar")

# The 7 required matrix metrics. The first five are numeric JSON values
# provenance-equal to the ADR table cells; the last two are recorded
# strings that the ADR cell must quote.
NUMERIC_METRICS = (
    "install_size_mb",
    "cold_start_s",
    "first_token_latency_s",
    "decode_tok_s",
    "peak_rss_mb",
)
STRING_METRICS = ("ci_build_reliability", "cancellation_stop")
ALL_METRICS = NUMERIC_METRICS + STRING_METRICS

# ---------------------------------------------------------------------------
# shared text helpers (same conventions as tests/test_adr_0002_llm_profiles.py)
# ---------------------------------------------------------------------------


def _load(rel: str) -> str:
    path = REPO_ROOT / rel
    assert path.is_file(), (
        "required issue-#57 artifact missing: %s "
        "(the ADR fix must commit it; spike/ trees do not count)" % rel
    )
    return path.read_text(encoding="utf-8")


def _load_json(rel: str):
    path = REPO_ROOT / rel
    assert path.is_file(), (
        "required issue-#57 artifact missing: %s "
        "(the ADR fix must commit it; spike/ trees do not count)" % rel
    )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AssertionError("invalid JSON in %s: %s" % (rel, exc))


def _norm(label: str) -> str:
    return re.sub(r"[\s_-]+", " ", label.strip().lower())


def _row_cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _is_separator(cells: list[str]) -> bool:
    nonempty = [c for c in cells if c]
    return bool(nonempty) and all(re.fullmatch(r":?-{2,}:?", c) for c in nonempty)


def _pipe_blocks(text: str) -> list[list[str]]:
    lines = text.splitlines()
    blocks, i = [], 0
    while i < len(lines):
        if lines[i].lstrip().startswith("|"):
            j = i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            blocks.append(lines[i:j])
            i = j
        else:
            i += 1
    return blocks


def _sections(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    heading, body = None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if heading is not None:
                out.append((heading, "\n".join(body)))
            heading, body = line, []
        elif heading is not None:
            body.append(line)
    if heading is not None:
        out.append((heading, "\n".join(body)))
    return out


def _find_section(text: str, *words: str) -> str | None:
    for heading, body in _sections(text):
        low = heading.lower()
        if all(w in low for w in words):
            return heading + "\n" + body
    return None


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p for p in parts if p.strip()]


_PLACEHOLDER_STR_RE = re.compile(
    r"^\s*(?:tbd|todo|tbc|placeholder|fixme|xxx|n\s*/\s*a|unknown|\?|"
    r"[-+:;,.=/#]*|…+)\s*$",
    re.I,
)


def _is_placeholder_str(value) -> bool:
    return not isinstance(value, str) or _PLACEHOLDER_STR_RE.match(value) is not None


def _is_number(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


# ---------------------------------------------------------------------------
# C1: decision record conventions + exactly one chosen option
# ---------------------------------------------------------------------------

_TITLE_RE = re.compile(r"^#\s+ADR-0003\b", re.M)
_STATUS_LINE_RE = re.compile(r"^-\s+\*\*Status:\*\*\s*\S", re.M)
_ISSUE_LINE_RE = re.compile(r"^-\s+\*\*Issue:\*\*.*$", re.M)
_ISSUE_REF_RE = re.compile(r"#57(?!\d)|issues/57(?!\d)", re.I)
_EVIDENCE_LINE_RE = re.compile(r"^-\s+\*\*Evidence:\*\*\s*\S", re.M)
_DECISION_HEADING_RE = re.compile(r"^##\s+Decision\s*$", re.M)

# --- the decision-binding grammar (fully documented in the module docstring) --
_NODE_TOKEN_RE = re.compile(r"\bnode(?:\.?js)?\b", re.I)
_SIDECAR_TOKEN_RE = re.compile(r"\bpython[\s-]?sidecar\b", re.I)
_CHOICE_VERB_RE = re.compile(
    r"\b(?:chose|chosen|choos(?:e|ing)|select(?:s|ed|ing)?|"
    r"selection\s+(?:is|:)|pick(?:s|ed|ing)?|adopt(?:s|ed|ing)?|"
    r"recommend(?:s|ed|ation)?|prefer(?:s|red|ring)?|win(?:s|ning)?|won|"
    r"decided\s+on|decision\s*(?:is|:)|go(?:es)?\s+with|went\s+with|winner)\b",
    re.I,
)
_NEGATION_TOKEN_RE = re.compile(
    r"\b(?:not|never|no|did\s+not|do\s+not|does\s+not|didn.?t|don.?t|"
    r"cannot|can.?t|won.?t|will\s+not|reject(?:s|ed|ing)?|"
    r"declin(?:es?|ed|ing)?|eliminat(?:es?|ed|ing)?|discard(?:s|ed|ing)?|"
    r"dismiss(?:es|ed|ing)?|instead\s+of|rather\s+than|against|"
    r"avoid(?:s|ed|ing)?|exclud(?:es?|ed|ing)?)\b",
    re.I,
)
# "over" needs a word boundary on both sides to bind "node OVER sidecar"
# without matching "overnight"; it is negating only inside verb-option gaps.
_GAP_BAN_RE = re.compile(
    r"[;:]|\bbut\b|\bwhereas\b|\balthough\b|\bwhile\b|\bover\b", re.I
)
# Trailing rationale participles ("...did not choose node, preferring the
# python-sidecar") bind only FORWARD (verb before option); they never
# positively bind the option they trail.
_PARTICIPLE_FORMS = frozenset(
    ("choosing", "selecting", "preferring", "adopting", "picking", "recommending")
)
_BINDING_WINDOW = 80
_VERB_PREWINDOW = 30


def _chosen_options(body: str) -> set[str]:
    """The set of options the Decision prose positively binds as THE choice.

    A sentence binds an option when a choice verb and the option token sit
    in the same sentence within _BINDING_WINDOW characters (either order),
    with no negation token between them, no negation token in the
    _VERB_PREWINDOW characters before the verb, and no clause boundary in
    the verb-option gap. See the module docstring for the full grammar.
    """
    bound: set[str] = set()
    for sent in _sentences(body):
        pairs = (
            ("node", _NODE_TOKEN_RE),
            ("python-sidecar", _SIDECAR_TOKEN_RE),
        )
        for option, tok_re in pairs:
            if option in bound:
                continue
            for om in tok_re.finditer(sent):
                for vm in _CHOICE_VERB_RE.finditer(sent):
                    if vm.end() <= om.start():
                        gap = sent[vm.end() : om.start()]
                        pre_raw = sent[
                            max(0, vm.start() - _VERB_PREWINDOW) : vm.start()
                        ]
                        # negation must live in the verb's OWN clause: clip at
                        # the nearest preceding clause boundary so a negated
                        # earlier clause ("...did not choose node; we chose
                        # python-sidecar") does not poison the later verb.
                        pre = re.split(r"[;:,]", pre_raw)[-1]
                    elif om.end() <= vm.start():
                        if vm.group(0).lower() in _PARTICIPLE_FORMS:
                            continue
                        gap = sent[om.end() : vm.start()]
                        pre = ""
                    else:
                        continue
                    if len(gap) > _BINDING_WINDOW:
                        continue
                    if (
                        _GAP_BAN_RE.search(gap)
                        or _NEGATION_TOKEN_RE.search(gap)
                        or _NEGATION_TOKEN_RE.search(pre)
                    ):
                        continue
                    bound.add(option)
                    break
                if option in bound:
                    break
    return bound


def _decision_body(adr_text: str) -> str:
    m = _DECISION_HEADING_RE.search(adr_text)
    tail = adr_text[m.end() :]
    nxt = re.search(r"^##\s", tail, re.M)
    return tail[: nxt.start()] if nxt else tail


def test_c1_decision():
    adr = _load(ADR_REL)
    v: list[str] = []

    if not _TITLE_RE.search(adr):
        v.append("title line must start with '# ADR-0003' (repo ADR convention)")
    if not _STATUS_LINE_RE.search(adr):
        v.append("front matter must carry a '- **Status:** <value>' line")
    issue_line = _ISSUE_LINE_RE.search(adr)
    if not issue_line:
        v.append("front matter must carry a '- **Issue:** <value>' line")
    elif not _ISSUE_REF_RE.search(issue_line.group(0)):
        v.append("the '**Issue:**' front-matter line must reference issue 57")
    if not _EVIDENCE_LINE_RE.search(adr):
        v.append("front matter must carry a '- **Evidence:** <value>' line")
    if not _DECISION_HEADING_RE.search(adr):
        v.append("no '## Decision' heading")
        assert not v, "ADR-0003 convention violations: %s" % v
    body = _decision_body(adr)
    if not body.strip():
        v.append("'## Decision' section is empty")

    bound = _chosen_options(body)
    if len(bound) == 0:
        v.append(
            "the Decision section positively binds NEITHER option; it must "
            "name exactly one of {'node', 'python-sidecar'} as chosen (e.g. "
            "'We chose the node backend.')"
        )
    elif len(bound) == 2:
        v.append(
            "the Decision section binds BOTH options as chosen (%s); exactly "
            "one may be positively bound" % sorted(bound)
        )
    # Sanctioned AMEND (CHECK_WRONG, 2026-09-21): the Decision must agree with
    # the recorded measurements - a slice whose packaged generation is BLOCKED
    # in eval/adr0003-matrix.json cannot be the chosen backend. This is what
    # makes a swapped Decision fail instead of merely binding "some" option.
    try:
        matrix = _load_json(MATRIX_REL)
        metrics = matrix.get("metrics", {}) if isinstance(matrix, dict) else {}
    except Exception:
        metrics = {}
    for sl in ("node", "python-sidecar"):
        blocked = False
        for mk in NUMERIC_METRICS:
            val = (
                metrics.get(mk, {}).get(sl)
                if isinstance(metrics.get(mk), dict)
                else None
            )
            if isinstance(val, dict) and val.get("blocked_by"):
                blocked = True
                break
        if blocked and bound and sl in bound:
            v.append(
                "the Decision binds %s as chosen but eval/adr0003-matrix.json "
                "records blocked generation metrics for it - a blocked backend "
                "cannot be the chosen one" % sl
            )
    assert not v, "ADR-0003 decision-record violations: %s" % v
    assert len(bound) == 1, "expected exactly one chosen option, got %s" % sorted(bound)

    # Grammar self-checks (arm's-length rigor: the classifier itself must
    # reject swapped / double decisions on synthetic prose).
    assert _chosen_options("We chose the node backend.") == {"node"}
    assert _chosen_options("Decision: adopt the python-sidecar.") == {"python-sidecar"}
    assert _chosen_options("We chose node over python-sidecar.") == {"node"}
    assert _chosen_options("We did not choose node; we chose python-sidecar.") == {
        "python-sidecar"
    }, "negated choice plus semicolon must not leak a binding to the rejected option"
    assert _chosen_options("We chose node and chose python-sidecar.") == {
        "node",
        "python-sidecar",
    }, "a double decision must classify as double"
    assert _chosen_options(
        "We did not choose node, preferring the python-sidecar."
    ) == {
        "python-sidecar"
    }, "a trailing rationale participle must not bind the option it trails"


# ---------------------------------------------------------------------------
# C2: 7-metric x 2-slice matrix, complete and provenance-equal to the JSON
# ---------------------------------------------------------------------------


def _metric_key(label: str) -> str | None:
    n = _norm(label)
    if "install size" in n or ("size" in n and "mb" in n):
        return "install_size_mb"
    if "cold start" in n or "first ready" in n:
        return "cold_start_s"
    if "first token" in n:
        # The 2k-token-prompt qualifier is part of the metric's identity:
        # without it a differently-prompted measurement could sneak in.
        if "2k" in n or "2048" in n:
            return "first_token_latency_s"
        return "FIRST_TOKEN_MISSING_2K"
    if "decode" in n or "tok/s" in n:
        return "decode_tok_s"
    if "rss" in n or "resident set" in n or "peak memory" in n:
        return "peak_rss_mb"
    if ("ci" in n.split() or "github actions" in n) and ("build" in n or "reliab" in n):
        return "ci_build_reliability"
    if "cancel" in n:
        return "cancellation_stop"
    return None


def _slice_of(text: str) -> str | None:
    if _SIDECAR_TOKEN_RE.search(text):
        return "python-sidecar"
    if _NODE_TOKEN_RE.search(text):
        return "node"
    return None


def _table_cells(
    header: list[str], rows: list[list[str]]
) -> dict[tuple[str, str], str]:
    """(metric, slice) -> value cell for one pipe table, either orientation."""
    cells: dict[tuple[str, str], str] = {}
    labels = [_norm(h) for h in header]
    slice_col = next(
        (
            i
            for i, l in enumerate(labels)
            if l in ("slice", "option", "backend", "variant")
        ),
        None,
    )
    if slice_col is not None:
        # slices-as-rows: each data row names a slice; columns name metrics
        for row in rows:
            sl = _slice_of(row[slice_col]) if slice_col < len(row) else None
            if not sl:
                continue
            for j, head in enumerate(header):
                if j == slice_col:
                    continue
                mk = _metric_key(head)
                if mk and j < len(row):
                    cells[(mk, sl)] = row[j]
    else:
        # metrics-as-rows: columns name slices; the first column labels metrics
        for j, head in enumerate(header):
            sl = _slice_of(head)
            if not sl:
                continue
            for row in rows:
                mk = _metric_key(row[0]) if row else None
                if mk and j < len(row):
                    cells[(mk, sl)] = row[j]
    return cells


def _adr_matrix_cells(adr_text: str) -> dict[tuple[str, str], str]:
    """The decision table = the pipe table covering the most (metric, slice)
    pairs (ties broken by the later table, so a summary table at the end of
    the ADR wins over an earlier options-considered table)."""
    best: dict[tuple[str, str], str] = {}
    for block in _pipe_blocks(adr_text):
        header = _row_cells(block[0])
        rows = [
            _row_cells(line)
            for line in block[1:]
            if not _is_separator(_row_cells(line))
        ]
        if not rows:
            continue
        cells = _table_cells(header, rows)
        if len(cells) >= len(best):
            best = cells
    return best


def _validate_matrix_json(data) -> tuple[list[str], dict[tuple[str, str], object]]:
    v: list[str] = []
    values: dict[tuple[str, str], object] = {}
    if not isinstance(data, dict):
        return ["matrix JSON must be an object"], values
    if data.get("schema") != MATRIX_SCHEMA_ID:
        v.append(
            "matrix JSON 'schema' must be %r (got %r)"
            % (MATRIX_SCHEMA_ID, data.get("schema"))
        )
    metrics = data.get("metrics")
    if not isinstance(metrics, dict):
        v.append("matrix JSON must carry a 'metrics' object")
        metrics = {}
    for mk in ALL_METRICS:
        entry = metrics.get(mk)
        if not isinstance(entry, dict):
            v.append("matrix JSON metrics.%s missing or not an object" % mk)
            continue
        for sl in SLICES:
            val = entry.get(sl)
            if val is None:
                v.append("matrix JSON metrics.%s.%s missing" % (mk, sl))
                continue
            if mk in NUMERIC_METRICS:
                if isinstance(val, dict) and isinstance(val.get("blocked_by"), str):
                    # Sanctioned AMEND (CHECK_WRONG, 2026-09-21): a slice whose
                    # packaged generation is BLOCKED by a documented packaging
                    # failure records {"blocked_by": reason} instead of a
                    # number. Only the python-sidecar slice may do this - the
                    # Node slice must always carry real measurements.
                    if sl != "python-sidecar":
                        v.append(
                            "matrix JSON metrics.%s.%s uses blocked_by but only "
                            "the python-sidecar slice may block (the Node slice "
                            "streams end-to-end)" % (mk, sl)
                        )
                    elif _is_placeholder_str(val["blocked_by"]):
                        v.append(
                            "matrix JSON metrics.%s.%s blocked_by must be a "
                            "non-placeholder reason" % (mk, sl)
                        )
                    else:
                        values[(mk, sl)] = val["blocked_by"]
                elif not _is_number(val) or val <= 0:
                    v.append(
                        "matrix JSON metrics.%s.%s must be a finite number > 0 "
                        "or a blocked_by record (got %r)" % (mk, sl, val)
                    )
                else:
                    values[(mk, sl)] = val
            else:
                if _is_placeholder_str(val):
                    v.append(
                        "matrix JSON metrics.%s.%s must be a non-placeholder "
                        "string (got %r)" % (mk, sl, val)
                    )
                else:
                    values[(mk, sl)] = val
    return v, values


def test_c2_matrix_complete():
    adr = _load(ADR_REL)
    data = _load_json(MATRIX_REL)
    v: list[str] = []

    jv, values = _validate_matrix_json(data)
    v.extend(jv)

    cells = _adr_matrix_cells(adr)
    if any(mk == "FIRST_TOKEN_MISSING_2K" for mk, _sl in cells):
        v.append(
            "the first-token latency metric label must state the 2k-token "
            "prompt qualifier (e.g. 'First-token latency (s, 2k-token prompt)')"
        )
    for mk in ALL_METRICS:
        for sl in SLICES:
            cell = cells.get((mk, sl))
            if cell is None:
                v.append("decision table missing (%s, %s) cell" % (mk, sl))
                continue
            if not cell.strip() or _PLACEHOLDER_STR_RE.match(cell):
                v.append(
                    "decision table cell (%s, %s) is empty or a placeholder: %r"
                    % (mk, sl, cell)
                )
                continue
            if re.search(r"\b(?:TBD|TODO|TBC|PLACEHOLDER|FIXME)\b", cell, re.I):
                v.append(
                    "decision table cell (%s, %s) contains a TBD-style marker: %r"
                    % (mk, sl, cell)
                )
                continue
            recorded = values.get((mk, sl))
            if mk in NUMERIC_METRICS and isinstance(recorded, (int, float)):
                figures = re.findall(r"\d+(?:\.\d+)?", cell)
                if not figures:
                    v.append(
                        "decision table cell (%s, %s) cites no number but the "
                        "recorded value is %r" % (mk, sl, recorded)
                    )
                    continue
                for number in figures:
                    if recorded is None or float(number) != float(recorded):
                        v.append(
                            "decision table cell (%s, %s) cites %s but "
                            "eval/adr0003-matrix.json records %r — the ADR must "
                            "never hand-patch numbers" % (mk, sl, number, recorded)
                        )
            elif isinstance(recorded, str):
                # Numeric-but-blocked pairs (sanctioned AMEND) and string
                # metrics both record a string the ADR cell must quote.
                if _norm(recorded) not in _norm(cell):
                    v.append(
                        "decision table cell (%s, %s) must quote the recorded "
                        "value %r" % (mk, sl, recorded)
                    )
            else:
                v.append(
                    "decision table cell (%s, %s) has no usable recorded value "
                    "(%r)" % (mk, sl, recorded)
                )
    assert not v, "ADR-0003 matrix violations: %s" % v


# ---------------------------------------------------------------------------
# C3: reranking.py:62 local_files_only PyInstaller-reproduction verdict
# ---------------------------------------------------------------------------

_RERANK_KEYWORD_RE = re.compile(r"rerank|pyinstaller", re.I)
_REPRODUCE_RE = re.compile(r"\breproduc", re.I)
_NEG_REPRODUCE_RE = re.compile(
    r"\b(?:did\s+not|does\s+not|do\s+not|didn.?t|not|never|no|failed\s+to|"
    r"cannot|can.?t|unable\s+to|without)\s+reproduc\w*",
    re.I,
)
_DEFECT_ID_RE = re.compile(
    r"reranking\.py\s*:?\s*(?:line\s*)?62|local_files_only", re.I
)


def _reranker_polarity(sentence: str) -> bool | None:
    if not (_REPRODUCE_RE.search(sentence) and _RERANK_KEYWORD_RE.search(sentence)):
        return None
    if _NEG_REPRODUCE_RE.search(sentence):
        return False
    return True


def test_c3_reranker_outcome():
    adr = _load(ADR_REL)
    data = _load_json(MATRIX_REL)
    v: list[str] = []

    verdict = data.get("reranker_local_files_only_reproduced")
    if not isinstance(verdict, bool):
        v.append(
            "eval/adr0003-matrix.json must carry the machine-readable verdict "
            "'reranker_local_files_only_reproduced' as a boolean (got %r)" % verdict
        )

    if not _DEFECT_ID_RE.search(adr):
        v.append(
            "the ADR must identify the defect ('reranking.py:62' or "
            "'local_files_only')"
        )

    polarities = {
        p for p in (_reranker_polarity(s) for s in _sentences(adr)) if p is not None
    }
    if not polarities:
        v.append(
            "the ADR must state whether the reranking.py:62 local_files_only "
            "defect reproduced in the PyInstaller build (a sentence with "
            "'rerank(er)' or 'PyInstaller' plus 'reproduced'/'did not reproduce')"
        )
    elif len(polarities) > 1:
        v.append(
            "the ADR states contradictory reranker verdicts (both reproduced "
            "and not-reproduced); state one clean outcome"
        )
    elif isinstance(verdict, bool) and polarities != {verdict}:
        v.append(
            "the ADR verdict %s contradicts "
            "eval/adr0003-matrix.json reranker_local_files_only_reproduced=%r"
            % (sorted(polarities), verdict)
        )
    assert not v, "ADR-0003 reranker-outcome violations: %s" % v

    # Polarity self-checks on synthetic statements.
    assert _reranker_polarity("The defect reproduced in the PyInstaller build.") is True
    assert _reranker_polarity("The reranker defect did not reproduce.") is False
    assert _reranker_polarity("The defect was not reproduced by PyInstaller.") is False
    assert _reranker_polarity("Reproduction confirmed for the reranker.") is True
    assert _reranker_polarity("No reproduction was observed.") is None  # no keyword


# ---------------------------------------------------------------------------
# C4: WS-B issue list adjustment (#61 / #62 with explicit dispositions)
# ---------------------------------------------------------------------------

_WSB_ID_RES = {
    "#61": re.compile(r"#61(?!\d)|\bpr[\s-]?3\b", re.I),
    "#62": re.compile(r"#62(?!\d)|\bpr[\s-]?4\b", re.I),
}
_NO_UPDATE_RE = re.compile(
    r"\bno\s+(?:further\s+)?(?:update|change|adjustment|action|edit)s?"
    r"(?:\s+(?:is|are|was|were))?\s+(?:needed|required|necessary)"
    r"|\bunchanged\b"
    r"|\bremains?\s+(?:as[\s-]*is|unchanged|valid|correct|accurate|in\s+place)",
    re.I,
)
_FAST_FOLLOW_RE = re.compile(
    r"fast[\s-]*follow"
    r"|follow[\s-]*up"
    r"|(?:tracked|filed|deferred|spun|moved|landed)\s+(?:in|to|as|via)\s+#\d+"
    r"|#\d+\s+(?:tracks|follows|covers|carries)"
    r"|\bopened\s+#\d+",
    re.I,
)
_DISPOSITION_WINDOW = 400
_MIN_REASON_CHARS = 15


def test_c4_wsb_adjustment():
    adr = _load(ADR_REL)
    section = _find_section(adr, "ws-b", "issue", "adjustment")
    assert section is not None, (
        "ADR-0003 must carry a '## WS-B issue list adjustment' section "
        "(heading containing 'WS-B', 'issue', 'adjustment')"
    )

    v: list[str] = []
    for issue_id, id_re in _WSB_ID_RES.items():
        mentions = list(id_re.finditer(section))
        if not mentions:
            v.append(
                "the WS-B issue list adjustment section must name %s "
                "(or its 'PR 3/4' alias)" % issue_id
            )
            continue
        ok = False
        for m in mentions:
            window = section[m.start() : m.start() + _DISPOSITION_WINDOW]
            disp = _NO_UPDATE_RE.search(window) or _FAST_FOLLOW_RE.search(window)
            if not disp:
                continue
            tail = window[disp.end() :].strip()
            if len(re.sub(r"\s+", "", tail)) >= _MIN_REASON_CHARS:
                ok = True
                break
        if not ok:
            v.append(
                "%s lacks an explicit disposition: within %d characters of a "
                "mention there must be either a 'no update needed'-style "
                "phrase or a fast-follow reference, accompanied by a reason "
                "or link target" % (issue_id, _DISPOSITION_WINDOW)
            )
    assert not v, "ADR-0003 WS-B adjustment violations: %s" % v


# ---------------------------------------------------------------------------
# C5: end-to-end packaged-slice evidence JSON
# ---------------------------------------------------------------------------

_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
_URL_RE = re.compile(r"^https?://[^/\s]+\.[^/\s]+/\S+$")


def _weak_sha256(value) -> bool:
    """All-zero, single-character, or short-block-repeated digests are
    placeholders, not installer identities."""
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        return True
    if re.fullmatch(r"(.)\1{63}", value):
        return True
    if re.fullmatch(r"([0-9a-f]{1,16})\1+", value, re.I):
        return True
    return False


def _valid_grounding(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value > 0
    if isinstance(value, str):
        return not _is_placeholder_str(value)
    if isinstance(value, list):
        return bool(value) and all(
            isinstance(x, str) and not _is_placeholder_str(x) for x in value
        )
    return False


def _validate_slice(sl: str, rec) -> list[str]:
    v: list[str] = []
    if not isinstance(rec, dict):
        return ["slices.%s must be an object" % sl]
    inst = rec.get("installer")
    if not isinstance(inst, dict):
        v.append("slices.%s.installer missing or not an object" % sl)
        inst = {}
    filename = inst.get("filename")
    if _is_placeholder_str(filename):
        v.append("slices.%s.installer.filename must be a non-empty string" % sl)
    sha = inst.get("sha256")
    if _weak_sha256(sha):
        v.append(
            "slices.%s.installer.sha256 must be a real 64-hex digest (not "
            "all-zeros or a repeated-block placeholder)" % sl
        )
    size = inst.get("size_bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        v.append("slices.%s.installer.size_bytes must be an int > 0" % sl)
    url = inst.get("ci_run_url")
    if not isinstance(url, str) or not _URL_RE.match(url):
        v.append(
            "slices.%s.installer.ci_run_url must be an http(s) URL with a "
            "dotted host and a path (the CI run that built the installer)" % sl
        )

    failure = rec.get("llm_failure")
    blocked = isinstance(failure, dict) and not _is_placeholder_str(
        failure.get("error")
    )
    if blocked and sl != "python-sidecar":
        v.append(
            "slices.%s carries llm_failure but only the python-sidecar slice "
            "may block (the Node slice streams end-to-end)" % sl
        )
        blocked = False
    if blocked:
        reason = failure.get("reason")
        if _is_placeholder_str(reason):
            v.append(
                "slices.%s.llm_failure.reason must be a non-placeholder string "
                "naming the packaging blocker" % sl
            )

    ans = rec.get("streamed_answer")
    if not isinstance(ans, dict):
        v.append("slices.%s.streamed_answer missing or not an object" % sl)
    elif blocked:
        if ans.get("streamed") is not False or ans.get("done_event") is not False:
            v.append(
                "slices.%s.streamed_answer must record streamed/done_event "
                "false when llm_failure is recorded" % sl
            )
        tokens = ans.get("token_count")
        if tokens != 0:
            v.append(
                "slices.%s.streamed_answer.token_count must be 0 when the LLM "
                "is blocked (got %r)" % (sl, tokens)
            )
    else:
        if ans.get("streamed") is not True:
            v.append("slices.%s.streamed_answer.streamed must be true" % sl)
        tokens = ans.get("token_count")
        if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens <= 0:
            v.append("slices.%s.streamed_answer.token_count must be an int > 0" % sl)
        if ans.get("done_event") is not True:
            v.append(
                "slices.%s.streamed_answer.done_event must be true (the "
                "terminal done event was observed)" % sl
            )
        if not _valid_grounding(ans.get("grounding")):
            v.append(
                "slices.%s.streamed_answer.grounding must be a non-empty "
                "string, a positive int, or a non-empty list of strings" % sl
            )

    can = rec.get("cancellation")
    if not isinstance(can, dict):
        v.append("slices.%s.cancellation missing or not an object" % sl)
    else:
        lat = can.get("stop_latency_s")
        # Sanctioned AMEND (CHECK_WRONG): a blocked slice records 0 latency —
        # there is no generation to cancel; the Node slice must stay > 0.
        if blocked and sl == "python-sidecar":
            if lat != 0 or not can.get("blocked"):
                v.append(
                    "slices.%s.cancellation must record stop_latency_s 0 with "
                    "blocked: true when the LLM is blocked (got %r)" % (sl, lat)
                )
        elif not _is_number(lat) or lat <= 0:
            v.append(
                "slices.%s.cancellation.stop_latency_s must be a finite "
                "number > 0 (got %r)" % (sl, lat)
            )
    return v


def test_c5_e2e_evidence():
    data = _load_json(E2E_REL)
    v: list[str] = []

    if not isinstance(data, dict):
        raise AssertionError("eval/adr0003-e2e-evidence.json must be a JSON object")
    if data.get("schema") != E2E_SCHEMA_ID:
        v.append(
            "e2e evidence 'schema' must be %r (got %r)"
            % (E2E_SCHEMA_ID, data.get("schema"))
        )

    machine = data.get("machine")
    if not isinstance(machine, dict):
        v.append("machine block missing")
        machine = {}
    if machine.get("tag") != "devstation":
        v.append(
            "machine.tag must be exactly 'devstation' (got %r)" % machine.get("tag")
        )
    for key in ("cpu", "ram", "os", "gpu"):
        if _is_placeholder_str(machine.get(key)):
            v.append("machine.%s must be a non-empty non-placeholder string" % key)
    status = machine.get("reference_i5_status")
    if not isinstance(status, str) or not status.strip():
        v.append("machine.reference_i5_status must be present and non-empty")
    elif "PENDING" not in status.upper():
        v.append(
            "machine.reference_i5_status must contain 'PENDING' (the "
            "reference-i5 rerun has not happened yet)"
        )

    slices = data.get("slices")
    if not isinstance(slices, dict):
        v.append("slices block missing")
        slices = {}
    seen_sha: dict[str, str] = {}
    seen_name: dict[str, str] = {}
    for sl in SLICES:
        v.extend(_validate_slice(sl, slices.get(sl)))
        rec = slices.get(sl)
        if isinstance(rec, dict) and isinstance(rec.get("installer"), dict):
            inst = rec["installer"]
            sha = inst.get("sha256")
            if isinstance(sha, str) and not _weak_sha256(sha):
                if sha.lower() in seen_sha:
                    v.append(
                        "slices %s and %s share installer sha256 %s — two "
                        "distinct packaged builds cannot be byte-identical"
                        % (seen_sha[sha.lower()], sl, sha)
                    )
                else:
                    seen_sha[sha.lower()] = sl
            name = inst.get("filename")
            if isinstance(name, str) and name.strip():
                if name in seen_name:
                    v.append(
                        "slices %s and %s share installer filename %r — each "
                        "slice must record its own artifact identity"
                        % (seen_name[name], sl, name)
                    )
                else:
                    seen_name[name] = sl

    assert not v, "ADR-0003 e2e-evidence violations: %s" % v
