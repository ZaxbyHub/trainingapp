"""Learn-panel result assembly (issue #82, Workstream D6).

Builds the ``learn[]`` array carried on every /ask and /ask/stream response:
the union of (a) cited chunks that ARE Storyline training-slide documents
(``reason: "direct"``) and (b) the top-linked training slides of the cited
doc chunks from the #80 ``links`` table (``reason: "linked"``), deduped by
slide_id keeping the highest score, sorted descending, capped at
``MAX_LEARN_RESULTS``.

The same algorithm is mirrored in desktop/main/backend/learn.ts and
web_ui/src/lib/rag/learn-kernel.ts (the D4 precedent of mirrored kernels
with mirrored golden tests); keep the three in lockstep.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

MAX_LEARN_RESULTS = 5

# Storyline slide documents are named docs/slide-<digits>-<slide_id>.json
# (contracts/store.schema.sql links DDL comment). Detection runs on the
# basename so it also matches Python/browser surfaces that only carry a
# filename; the Node store additionally gates on docs.source_class='training'.
_SLIDE_NAME_RE = re.compile(r"slide-(\d+)-(.+)\.json$", re.IGNORECASE)

# Marker line prepended by the Storyline slide-doc extractor
# (document_processor.process_file). Values are |-sanitized at extraction.
_MARKER_RE = re.compile(
    r"^\[training-slide\] section=(.*) \| title=(.*) \| slide_id=(\S+)\s*$"
)

SNIPPET_MAX_CHARS = 120


def slide_id_from_name(name: Optional[str]) -> Optional[str]:
    """Return the raw Storyline slide id encoded in a slide-doc filename."""
    if not name:
        return None
    match = _SLIDE_NAME_RE.search(name.replace("\\", "/").rsplit("/", 1)[-1])
    if match is None:
        return None
    return match.group(2)


def _parse_marker(text: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Extract (section, title) from the extractor's marker line, if present."""
    if not text:
        return (None, None)
    first_line = text.split("\n", 1)[0].strip()
    match = _MARKER_RE.match(first_line)
    if match is None:
        return (None, None)
    return (match.group(1), match.group(2))


def _snippet_after_marker(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    body = text
    first_line = body.split("\n", 1)[0].strip()
    if _MARKER_RE.match(first_line):
        body = body.split("\n", 1)[1] if "\n" in body else ""
    body = body.strip()
    if not body:
        return None
    return body[:SNIPPET_MAX_CHARS]


def build_learn_results(
    chunk_entries: List[Dict[str, Any]],
    grounding: Optional[str] = None,
    links_lookup: Optional[
        Callable[
            [Dict[str, Any]],
            Iterable[Tuple[str, float, Optional[str], Optional[str], Optional[str]]],
        ]
    ] = None,
    max_results: int = MAX_LEARN_RESULTS,
) -> List[Dict[str, Any]]:
    """Assemble the learn[] payload for one answer.

    ``chunk_entries`` are the cited-chunk detail dicts built by
    rag_engine.query (source_display/doc_id/source_path/snippet/score...).
    ``grounding`` is the #72 provenance value when present: "general"
    suppresses all learn results (a general-knowledge answer must not imply
    training coverage). ``links_lookup`` yields
    (slide_id, score, title, section, snippet) tuples per cited chunk from
    the #80 links table; surfaces without a links store (Python stack,
    browser) pass None, which is a documented acceptable divergence.
    """
    if grounding == "general":
        return []

    best: Dict[str, Dict[str, Any]] = {}

    def offer(
        slide_id: str,
        score: float,
        reason: str,
        title: Optional[str],
        section: Optional[str],
        snippet: Optional[str],
    ) -> None:
        candidate = {
            "slide_id": slide_id,
            "title": title or slide_id,
            "section": section or "",
            "score": float(score),
            "reason": reason,
        }
        if snippet:
            candidate["snippet"] = snippet
        current = best.get(slide_id)
        prefer = (
            current is None
            or candidate["score"] > current["score"]
            or (
                candidate["score"] == current["score"]
                and reason == "direct"
                and current["reason"] != "direct"
            )
        )
        if prefer:
            # Keep the surviving entry's snippet when the challenger has none.
            if (
                current is not None
                and not candidate.get("snippet")
                and current.get("snippet")
            ):
                candidate["snippet"] = current["snippet"]
            best[slide_id] = candidate

    for entry in chunk_entries:
        name = entry.get("source_path") or entry.get("source_display")
        slide_id = slide_id_from_name(name if isinstance(name, str) else None)
        if slide_id is not None:
            section, title = _parse_marker(entry.get("snippet"))
            offer(
                slide_id,
                float(entry.get("score") or 0.0),
                "direct",
                title,
                section,
                _snippet_after_marker(entry.get("snippet")),
            )
        if links_lookup is not None:
            for linked in links_lookup(entry):
                linked_slide_id, score, title, section, snippet = linked
                offer(linked_slide_id, float(score), "linked", title, section, snippet)

    ranked = sorted(best.values(), key=lambda r: -r["score"])
    return ranked[:max_results]
