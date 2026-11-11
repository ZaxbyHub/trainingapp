"""Search normalization for the derived lexical mirror (issue #281, Workstream E).

Python twin of desktop/main/backend/ingest/normalize.ts — one table-driven
contract, twin-tested by contracts/text-normalization-vectors.json in all four
runtimes. Consumed by tests/test_text_normalization_vectors.py (Audit guards)
and by the store-interop harness (writers + oracle_fts).

This function NEVER touches chunk identity: chunks.text, chunk ids and
content_hash stay byte-identical (ADR-0004).
"""
from __future__ import annotations

import re
import unicodedata

_DEFAULT_IGNORABLES = re.compile("[\u00ad\u200b\u200c\u200d\u2060\ufeff]")
_DASHES = re.compile("[\u2010-\u2015\u2212]")
_SINGLE_QUOTES = re.compile("[\u2018\u2019]")
_DOUBLE_QUOTES = re.compile("[\u201c\u201d]")
_ELLIPSIS = re.compile("\u2026")
_WS = re.compile(r"\s+")


def normalize_search(text: str) -> str:
    """Apply the search normalization contract to text."""
    out = unicodedata.normalize("NFKC", text)
    out = _DEFAULT_IGNORABLES.sub("", out)
    out = _DASHES.sub("-", out)
    out = _SINGLE_QUOTES.sub("'", out)
    out = _DOUBLE_QUOTES.sub('"', out)
    out = _ELLIPSIS.sub("...", out)
    return _WS.sub(" ", out).strip()
