"""
Guardrail for issue #53 (defect-class eradication): the GGUF thread default
must never regress to a hardcoded literal in any consumer module.

The original defect was a `4` literal duplicated across config.py,
rag_engine.py, engine_factory.py and app_gui.py; the fix routes every site
through config.default_gguf_threads(). This guardrail greps the four
production files for the defective literal patterns so a future edit cannot
silently reintroduce the drift (repo precedent: test_no_blanket_perf_skips).
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# (file, defective pattern, description)
PATTERNS = [
    (
        "config.py",
        r"rag_gguf_n_threads:\s*int\s*=\s*Field\(\s*default\s*=\s*4\b",
        "hardcoded pydantic default 4",
    ),
    (
        "rag_engine.py",
        r"gguf_n_threads:\s*int\s*=\s*4\b",
        "hardcoded RAGConfig __init__ default",
    ),
    (
        "rag_engine.py",
        r'data\.get\("gguf_n_threads",\s*4\)',
        "hardcoded from_dict default",
    ),
    (
        "engine_factory.py",
        r'_get\("gguf_n_threads",\s*4\)',
        "hardcoded settings-dict fallback",
    ),
    (
        "engine_factory.py",
        r'"rag_gguf_n_threads",\s*4\)',
        "hardcoded settings-attr fallback",
    ),
    ("app_gui.py", r'"gguf_n_threads":\s*4\b', "hardcoded preset value"),
    (
        "app_gui.py",
        r's\.get\("gguf_n_threads",\s*4\)',
        "hardcoded settings-display default",
    ),
    (
        "app_gui.py",
        r"gguf_n_threads_entry\.get\(\)\s*or\s*4\b",
        "hardcoded blank-field fallback",
    ),
]


def test_no_hardcoded_gguf_thread_defaults():
    """No production module may hardcode the GGUF thread default to 4."""
    offenders = []
    for filename, pattern, description in PATTERNS:
        source = (REPO_ROOT / filename).read_text(encoding="utf-8")
        for lineno, line in enumerate(source.splitlines(), start=1):
            if re.search(pattern, line):
                offenders.append(
                    f"{filename}:{lineno}: {description} -> {line.strip()}"
                )

    assert not offenders, (
        "Hardcoded GGUF thread defaults reintroduced; route every site "
        "through config.default_gguf_threads() instead:\n" + "\n".join(offenders)
    )


def test_thread_default_helper_is_single_source_of_truth():
    """config.default_gguf_threads must exist and behave as min(cpu, 8)."""
    import os

    from config import default_gguf_threads

    assert default_gguf_threads() == min(os.cpu_count() or 4, 8)
