"""Guardrail: no unconditional perf-test skips may return (issue #52).

Defect class: real-evidence performance gates replaced by unconditional skips,
leaving perf behavior unmeasured and unenforceable.

Two tiers:

1. PERF-EVIDENCE SUITES (files named test_*performance*, test_*hardware*,
   test_*bench*): ZERO unconditional module-level skips and ZERO blanket
   skip decorators - no allowlist. These suites must gate on the exact
   missing artifact (weights file, floors row, pip package) via conditional
   skipif, as done for tests/test_rag_performance.py and
   tests/test_low_end_hardware.py in issue #52.

2. EVERYWHERE ELSE: existing blanket skips are frozen in an exact ALLOWLIST
   (the visible debt register from the issue #52 sweep). The ratchet is
   two-sided: a NEW unlisted skip fails, and an allowlist entry that no
   longer matches any live site fails as stale - the register cannot grow
   silently and cannot outlive the skips it documents.

Sanctioned gate form (negative control): conditional
``pytest.mark.skipif(<artifact check>, reason=<names the artifact>)``.

Detector coverage: module-level ``pytestmark`` skips, blanket skip
decorators, constant-literal skipif conditions (``True``/``False``/``1``/
``0`` are never artifact gates - one direction always skips, the other is a
decorative gate), and unguarded inline ``pytest.skip()`` calls inside test
bodies (recognized guarded shapes: the skip sits on an ``if``/``elif`` line,
or the preceding meaningful line is an ``except ...:`` / ``if ...:`` /
``elif ...:`` guard or a ``try:``/``else:``/``finally:``/``with ...:``
opener). Perf suites allow zero of any of these; everywhere else the sites
are frozen in the two-sided registers below.
"""

import re
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PERF_SUITE_RE = re.compile(
    r"test_.*(?:performance|hardware|bench).*\.py$", re.IGNORECASE
)

# Positive control: assembled at runtime so this file never matches itself.
MODULE_SKIP_POSITIVE_CONTROL = (
    "pytestmark = pytest.mark." + "skip(" + 'reason="blanket"'
)
MODULE_SKIP_RE = re.compile(
    r"^\s*pytestmark\s*=\s*pytest\.mark\.skip\s*\(", re.MULTILINE
)
SKIP_IF_TRUE_RE = re.compile(
    r"^\s*pytestmark\s*=\s*pytest\.mark\.skipif\s*\(\s*(?:True|False|1|0)\s*,",
    re.MULTILINE,
)
DECORATOR_SKIP_RE = re.compile(
    r"@pytest\.mark\.skip\s*\(\s*reason\s*=\s*(?P<q>[\"'])(?P<reason>.+?)(?P=q)\s*\)",
    re.DOTALL,
)
# Inline pytest.skip("...") inside test bodies; only sites that the guard
# classifier in _inline_skip_is_unconditional cannot recognize as conditional
# count as blanket skips.
INLINE_SKIP_RE = re.compile(r"pytest\.skip\s*\(\s*[\"'](?P<reason>[^\"']*)")


def _inline_skip_is_unconditional(lines: "list[str]", idx: int) -> bool:
    """True when the pytest.skip site at lines[idx] has no lexical guard.

    Guarded shapes (return False): the skip sits on an ``if``/``elif`` line,
    or the preceding meaningful line is an ``except ...:`` / ``if ...:`` /
    ``elif ...:`` guard or a ``try:`` / ``else:`` / ``finally:`` /
    ``with ...:`` block opener.
    """
    stripped = lines[idx].strip()
    if stripped.startswith(("if ", "elif ")):
        return False
    j = idx - 1
    while j >= 0 and (not lines[j].strip() or lines[j].strip().startswith("#")):
        j -= 1
    prev = lines[j].strip() if j >= 0 else ""
    if prev.startswith("except "):
        return False
    if prev.startswith(("if ", "elif ")) and prev.endswith(":"):
        return False
    if prev in ("try:", "else:", "finally:") or prev.startswith("with "):
        return False
    return True


# Shared justification for every tier-2 module-skip entry (kept short to
# satisfy E501; the audit detail lives in the issue #52 trace artifacts).
_LEGACY_SKIP_REASON = (
    "pre-existing blanket module skip in a functional suite "
    "(GUI/adversarial/regression) - out of #52 perf-evidence scope; "
    "conversion tracked for follow-up"
)

# Tier-2 debt register (issue #52 sweep, 2026-09-06): exact
# (file, reason prefix) -> audited site count. Every entry must keep matching
# at least one live site; a new unlisted site fails.
MODULE_ALLOWLIST = {
    "integration/test_rag_engine_integration.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_001_gui_gguf_wiring.py": {
        "count": 2,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_002_api_gguf_env.py": {
        "count": 2,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_003_adversarial.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_003_url_validation.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_004_upload_source.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_005_upload_mismatch.py": {
        "count": 2,
        "reason": _LEGACY_SKIP_REASON,
    },
    "regression/test_defect_006_build_path.py": {
        "count": 2,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_app_gui_role_header_timestamp.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_app_paths.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_main_gguf_path.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_phase1_adversarial.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_phase1_adversarial_zero_trust.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_phase2_adversarial.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_progress_animation_wm_delete.py": {
        "count": 2,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_rag_engine.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
    "test_rag_engine_query_adversarial.py": {
        "count": 1,
        "reason": _LEGACY_SKIP_REASON,
    },
}

DECORATOR_ALLOWLIST = {
    "regression/test_defect_004_upload_source.py": {
        "tkinter.tclError — no GUI in CI environment": {
            "reason": "tkinter.tclError — no GUI in CI environment",
            "sites": 2,
        },
    },
    "test_api.py": {
        "Pre-existing error message mismatch — security.py messages c": {
            "reason": "Pre-existing error message mismatch — security.py messages c",
            "sites": 2,
        },
    },
    "test_app_gui_streaming_callback.py": {
        "Attribute cleared via message queue in UI modernization (PR ": {
            "reason": "Attribute cleared via message queue in UI modernization (PR ",
            "sites": 2,
        },
        "Attribute initialized in __init__, not _create_widgets, in U": {
            "reason": "Attribute initialized in __init__, not _create_widgets, in U",
            "sites": 2,
        },
    },
    "test_app_paths.py": {
        "Required model directories not present in CI": {
            "reason": "Required model directories not present in CI",
            "sites": 3,
        },
    },
    "test_main_gguf_path.py": {
        "Requires model path infrastructure": {
            "reason": "Requires model path infrastructure",
            "sites": 1,
        },
    },
    "test_phase2_adversarial.py": {
        "Source behavior changed — KeyboardInterrupt not caught, URL ": {
            "reason": "Source behavior changed — KeyboardInterrupt not caught, URL ",
            "sites": 2,
        },
        "Requires real embedding model — incompatible with conftest m": {
            "reason": "Requires real embedding model — incompatible with conftest m",
            "sites": 1,
        },
    },
    "test_rag_engine.py": {
        "Mocked vector store behavior changed after refactor": {
            "reason": "Mocked vector store behavior changed after refactor",
            "sites": 1,
        },
    },
    "test_rag_pipeline_edge_cases.py": {
        "Requires real embedding model — incompatible with conftest m": {
            "reason": "Requires real embedding model — incompatible with conftest m",
            "sites": 8,
        },
    },
    "test_security.py": {
        "DEFAULT_ALLOWED_PORTS is {80, 443}, 11434 is not included by": {
            "reason": "DEFAULT_ALLOWED_PORTS is {80, 443}, 11434 is not included by",
            "sites": 2,
        },
    },
    "test_vector_store.py": {
        "Requires real embedding model — incompatible with conftest m": {
            "reason": "Requires real embedding model — incompatible with conftest m",
            "sites": 5,
        },
        "Mock embeddings produce unexpected similarity ordering — win": {
            "reason": "Mock embeddings produce unexpected similarity ordering — win",
            "sites": 1,
        },
    },
    "test_vector_store_hardening.py": {
        "Requires real embedding model — incompatible with conftest m": {
            "reason": "Requires real embedding model — incompatible with conftest m",
            "sites": 8,
        },
    },
    "test_vector_store_lazy_init.py": {
        "Requires real embedding model — incompatible with conftest m": {
            "reason": "Requires real embedding model — incompatible with conftest m",
            "sites": 2,
        },
    },
}


def _inline_entry(reason: str, sites: int) -> dict:
    """Register entry keyed exactly as the detector truncates reasons."""
    return {reason[:60]: {"reason": reason[:60], "sites": sites}}


# Tier-2c debt register (issue #52 review sweep, 2026-09-06): unguarded
# inline pytest.skip() call sites, exact (file, reason prefix) -> site count.
# Two-sided like the other registers: a new unlisted site fails, and an entry
# that no longer matches any live site fails as stale.
INLINE_ALLOWLIST = {
    "integration/test_gguf_wiring.py": _inline_entry("ChromaDB KeyError ", 1),
    "integration/test_workflows.py": {
        **_inline_entry("Engine not initialized - skipping ingestion tests", 1),
        **_inline_entry("Engine not initialized", 2),
    },
    "test_accessibility.py": _inline_entry("MockCTkEntry missing ", 1),
    "test_engine_factory.py": _inline_entry(
        "OS null-byte env var behavior differs on CI — DID NOT RAISE ValueError", 1
    ),
    "test_full_council_adversarial.py": _inline_entry(
        "Source code inspection test — bare CTkButton found in _create_widgets", 1
    ),
    "test_gguf_path_wiring_final.py": _inline_entry("ChromaDB KeyError ", 2),
    "test_phase1_adversarial.py": _inline_entry(
        "Windows 8.3 short name path mismatch on CI — temp path case differs", 2
    ),
    "test_vector_store.py": _inline_entry(
        "Embedding similarity is non-deterministic across Python versions", 1
    ),
}


class TestNoBlanketPerfSkips:
    def test_positive_control_matches(self):
        """The module-skip detector must match the unconditional form."""
        assert MODULE_SKIP_RE.search(MODULE_SKIP_POSITIVE_CONTROL)

    def test_negative_control_sanctioned_gate(self):
        """Sanctioned artifact-naming skipif gates must NOT match."""
        sanctioned = (
            "pytestmark = [\n"
            "    pytest.mark.skipif(not _HAS_WEIGHTS,\n"
            "                       reason='weights not staged: models/x'),\n"
            "]\n"
        )
        assert not MODULE_SKIP_RE.search(sanctioned)
        assert not SKIP_IF_TRUE_RE.search(sanctioned)

    def test_constant_literal_skipif_matches(self):
        """Constant-literal skipif conditions are blanket forms in either
        direction: True/1 always skip, False/0 is a decorative gate."""
        for lit in ("True", "1", "False", "0"):
            text = "pytestmark = pytest.mark.skipif(%s, reason='x')" % lit
            assert SKIP_IF_TRUE_RE.search(text), lit
        assert not SKIP_IF_TRUE_RE.search(
            "pytestmark = pytest.mark.skipif(not _HAS_WEIGHTS,\n"
            "                               reason='weights')\n"
        )

    def test_inline_skip_detector_controls(self):
        """Guarded inline shapes must not flag; the bare test-body skip must."""
        guarded = [
            "try:\n"
            "    import customtkinter\n"
            "except ImportError:\n"
            "    pytest.skip('customtkinter not installed')\n",
            "if weights is None:\n    pytest.skip('weights not staged')\n",
            "if not _HAS_ENGINE:\n"
            "    pytest.skip('engine missing')\n"
            "run_bench()\n",
        ]
        for text in guarded:
            lines = text.splitlines()
            hits = [
                i
                for i, ln in enumerate(lines)
                if INLINE_SKIP_RE.search(ln) and _inline_skip_is_unconditional(lines, i)
            ]
            assert hits == [], text
        unconditional = "def test_x():\n    pytest.skip('non-deterministic')\n"
        lines = unconditional.splitlines()
        hits = [
            i
            for i, ln in enumerate(lines)
            if INLINE_SKIP_RE.search(ln) and _inline_skip_is_unconditional(lines, i)
        ]
        assert hits == [1]

    def test_perf_suites_have_no_unconditional_skips(self):
        """Tier 1: perf-evidence suites must gate on artifacts, never skip
        blanket (the exact class issue #52 fixed)."""
        offenders = []
        for path in sorted(TESTS_DIR.rglob("test_*.py")):
            if not PERF_SUITE_RE.search(path.name):
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if MODULE_SKIP_RE.search(text) or SKIP_IF_TRUE_RE.search(text):
                offenders.append(f"{path.name}: module-level blanket skip")
            lines = text.splitlines()
            for i, ln in enumerate(lines):
                match = INLINE_SKIP_RE.search(ln)
                if match and _inline_skip_is_unconditional(lines, i):
                    offenders.append(
                        f"{path.name}:{i + 1}: unguarded inline pytest.skip()"
                    )
            for match in DECORATOR_SKIP_RE.finditer(text):
                line = text[: match.start()].count("\n") + 1
                offenders.append(f"{path.name}:{line}: blanket skip decorator")
        assert not offenders, (
            "perf-evidence suites carry unconditional skips (issue #52 class): "
            + ", ".join(offenders)
        )

    def test_module_skips_match_allowlist(self):
        """Tier 2a: module-level skips outside perf suites are frozen debt."""
        live = {}
        for path in sorted(TESTS_DIR.rglob("test_*.py")):
            if path.name == Path(__file__).name:
                continue
            rel = str(path.relative_to(TESTS_DIR)).replace("\\", "/")
            text = path.read_text(encoding="utf-8", errors="replace")
            n = len(MODULE_SKIP_RE.findall(text)) + len(SKIP_IF_TRUE_RE.findall(text))
            if n:
                live[rel] = live.get(rel, 0) + n
        offenders, stale = [], []
        for f, n in live.items():
            entry = MODULE_ALLOWLIST.get(f)
            if entry is None:
                offenders.append(f"{f}: {n} unallowlisted module skip(s)")
            elif entry["count"] != n:
                offenders.append(
                    f"{f}: {n} module skip(s) but the register records "
                    f"{entry['count']} - update the register deliberately"
                )
        for f in MODULE_ALLOWLIST:
            if f not in live:
                stale.append(f)
        assert not offenders, "; ".join(offenders)
        assert not stale, (
            "stale MODULE_ALLOWLIST entries (skip was removed - delete the "
            "entry): " + ", ".join(stale)
        )

    def test_decorator_skips_match_allowlist(self):
        """Tier 2b: blanket skip decorators are frozen debt."""
        live = {}
        for path in sorted(TESTS_DIR.rglob("test_*.py")):
            if path.name == Path(__file__).name:
                continue
            rel = str(path.relative_to(TESTS_DIR)).replace("\\", "/")
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in DECORATOR_SKIP_RE.finditer(text):
                reason = match.group("reason")[:60]
                live.setdefault(rel, {})
                live[rel].setdefault(reason, 0)
                live[rel][reason] += 1
        offenders, stale = [], []
        for f, reasons in live.items():
            entries = DECORATOR_ALLOWLIST.get(f, {})
            for reason, n in reasons.items():
                entry = entries.get(reason)
                if entry is None:
                    offenders.append(f"{f}: unallowlisted skip {reason[:50]!r}")
                elif entry["sites"] != n:
                    offenders.append(
                        f"{f}: {n} site(s) for {reason[:40]!r} but the register "
                        f"records {entry['sites']}"
                    )
        for f, entries in DECORATOR_ALLOWLIST.items():
            for reason in entries:
                if reason not in live.get(f, {}):
                    stale.append(f"{f}: {reason[:40]!r}")
        assert not offenders, "; ".join(offenders)
        assert not stale, (
            "stale DECORATOR_ALLOWLIST entries (skip was converted or removed "
            "- delete the entry): " + "; ".join(stale)
        )

    def test_inline_skips_match_allowlist(self):
        """Tier 2c: unguarded inline pytest.skip() calls are frozen debt."""
        live = {}
        for path in sorted(TESTS_DIR.rglob("test_*.py")):
            if path.name == Path(__file__).name:
                continue
            rel = str(path.relative_to(TESTS_DIR)).replace("\\", "/")
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            for i, ln in enumerate(lines):
                match = INLINE_SKIP_RE.search(ln)
                if match and _inline_skip_is_unconditional(lines, i):
                    reason = match.group("reason")[:60]
                    live.setdefault(rel, {})
                    live[rel][reason] = live[rel].get(reason, 0) + 1
        offenders, stale = [], []
        for f, reasons in live.items():
            entries = INLINE_ALLOWLIST.get(f, {})
            for reason, n in reasons.items():
                entry = entries.get(reason)
                if entry is None:
                    offenders.append(f"{f}: unallowlisted inline skip {reason[:50]!r}")
                elif entry["sites"] != n:
                    offenders.append(
                        f"{f}: {n} inline site(s) for {reason[:40]!r} but the "
                        f"register records {entry['sites']}"
                    )
        for f, entries in INLINE_ALLOWLIST.items():
            for reason in entries:
                if reason not in live.get(f, {}):
                    stale.append(f"{f}: {reason[:40]!r}")
        assert not offenders, "; ".join(offenders)
        assert not stale, (
            "stale INLINE_ALLOWLIST entries (skip was converted or removed "
            "- delete the entry): " + "; ".join(stale)
        )
