"""Frozen-schema validator for the A5 bake-off results artifact (issue #55).

This module is the single definition shared by the collectors (emit-time
validation) and tests/test_bakeoff_artifacts.py (CI guardrail). Its rules
mirror the frozen acceptance checks C1-C6 authored at arm's length before
implementation:

  eval/bakeoff/results/bakeoff-results.json
    threads == 8
    embeddings: exactly the 4 canonical embedding ids, each with
      dims (positive int), license (non-placeholder string),
      quality {recall@1, recall@3, recall@5 in [0,1]; mrr in (0,1]},
      cpu {top15_ms_p50 > 0, top30_ms_p50 > 0}
    rerankers: exactly 3 ids -- ettin as the staged name or org-qualified
      form (one spelling only), the non-hyphenated MiniLM canonical id, and
      BAAI/bge-reranker-v2-m3 -- each with license/quality/cpu shapes
    combos: non-empty list of {embedding, reranker, recall@1/3/5, mrr}

ADR consistency (check C5): docs/adr/0001-embedding-reranker.md has a
level-2 '## Decision' section whose body names exactly one scored embedding
id and one scored reranker id, and pairs the winning embedding with the dims
value recorded in the results JSON (labeled 'dims: N' or adjacent number).

Pure stdlib; importable from CI without the model stack.
"""

from __future__ import annotations

import json
import math
import os
import re

RESULTS_REL = "eval/bakeoff/results/bakeoff-results.json"
ADR_REL = "docs/adr/0001-embedding-reranker.md"

EMBEDDING_IDS = (
    "BAAI/bge-small-en-v1.5",
    "Snowflake/snowflake-arctic-embed-m-v1.5",
    "google/embeddinggemma-300m",
    "Qwen/Qwen3-Embedding-0.6B",
)
MINILM_ID = "cross-encoder/ms-marco-MiniLM-L6-v2"
BGE_RERANKER_ID = "BAAI/bge-reranker-v2-m3"
ETTIN_NAME = "ettin-reranker-32m-v1"

_PLACEHOLDER_LICENSES = {"", "tbd", "unknown", "n/a", "none", "todo", "placeholder"}
_ADJACENCY_WINDOW = 80
_HEAD2_RE = re.compile(r"^## (.+?)\s*$")


def _is_num(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _ettin_key(rerankers):
    matches = [
        key
        for key in rerankers
        if key == ETTIN_NAME
        or (
            key.count("/") == 1
            and key.endswith("/" + ETTIN_NAME)
            and key.split("/", 1)[0] != ""
        )
    ]
    if len(matches) != 1:
        return None
    return matches[0]


def _quality_violations(record, label, out):
    quality = record.get("quality")
    if not isinstance(quality, dict):
        out.append("%s: quality must be an object" % label)
        return
    for metric in ("recall@1", "recall@3", "recall@5"):
        value = quality.get(metric)
        if not _is_num(value):
            out.append("%s: quality.%s must be a finite number" % (label, metric))
        elif not 0.0 <= value <= 1.0:
            out.append("%s: quality.%s must be within [0,1]" % (label, metric))
    value = quality.get("mrr")
    if not _is_num(value):
        out.append("%s: quality.mrr must be a finite number" % label)
    elif not 0.0 < value <= 1.0:
        out.append("%s: quality.mrr must be within (0,1]" % label)


def _cpu_violations(record, label, out):
    cpu = record.get("cpu")
    if not isinstance(cpu, dict):
        out.append("%s: cpu must be an object" % label)
        return
    for metric in ("top15_ms_p50", "top30_ms_p50"):
        value = cpu.get(metric)
        if not _is_num(value) or value <= 0:
            out.append("%s: cpu.%s must be a number > 0" % (label, metric))


def _license_violations(record, label, out):
    license_value = record.get("license")
    if not isinstance(license_value, str):
        out.append("%s: license must be a string" % label)
        return
    if license_value.strip().lower() in _PLACEHOLDER_LICENSES:
        out.append("%s: license is empty or a placeholder" % label)


def validate_results(data, source_label=RESULTS_REL):
    """Return a list of violations; empty list means schema-valid."""
    out = []
    if not isinstance(data, dict):
        return ["%s: top-level JSON value must be an object" % source_label]

    threads = data.get("threads")
    if threads != 8 or isinstance(threads, bool):
        out.append("%s: threads must equal the integer 8" % source_label)

    embeddings = data.get("embeddings")
    if not isinstance(embeddings, dict):
        out.append("%s: embeddings must be an object" % source_label)
    else:
        for cid in EMBEDDING_IDS:
            if cid not in embeddings:
                out.append("embeddings is missing required key '%s'" % cid)
        extra = sorted(set(embeddings) - set(EMBEDDING_IDS))
        if extra:
            out.append(
                "embeddings has key(s) beyond the 4 required candidates: %s"
                % ", ".join(extra)
            )
        for cid in EMBEDDING_IDS:
            record = embeddings.get(cid)
            if not isinstance(record, dict):
                out.append("embeddings['%s'] must be an object" % cid)
                continue
            dims = record.get("dims")
            if not isinstance(dims, int) or isinstance(dims, bool) or dims <= 0:
                out.append("embeddings['%s'].dims must be a positive integer" % cid)
            _license_violations(record, "embeddings['%s']" % cid, out)
            _quality_violations(record, "embeddings['%s']" % cid, out)
            _cpu_violations(record, "embeddings['%s']" % cid, out)

    rerankers = data.get("rerankers")
    if not isinstance(rerankers, dict):
        out.append("%s: rerankers must be an object" % source_label)
    else:
        ettin = _ettin_key(rerankers)
        if ettin is None:
            out.append(
                "rerankers must list '%s' exactly once (staged or org-qualified form)"
                % ETTIN_NAME
            )
        for cid in (MINILM_ID, BGE_RERANKER_ID):
            if cid not in rerankers:
                out.append("rerankers is missing required key '%s'" % cid)
        allowed = {MINILM_ID, BGE_RERANKER_ID}
        if ettin:
            allowed.add(ettin)
        extra = sorted(set(rerankers) - allowed)
        if extra:
            out.append(
                "rerankers has key(s) beyond the 3 required candidates: %s"
                % ", ".join(extra)
            )
        for key in sorted(set(rerankers)):
            record = rerankers.get(key)
            if not isinstance(record, dict):
                out.append("rerankers['%s'] must be an object" % key)
                continue
            _license_violations(record, "rerankers['%s']" % key, out)
            _quality_violations(record, "rerankers['%s']" % key, out)
            _cpu_violations(record, "rerankers['%s']" % key, out)

    combos = data.get("combos")
    if not isinstance(combos, list) or not combos:
        out.append("%s: combos must be a non-empty array" % source_label)
    else:
        for index, combo in enumerate(combos):
            if not isinstance(combo, dict):
                out.append("combos[%d] must be an object" % index)
                continue
            emb = combo.get("embedding")
            rer = combo.get("reranker")
            if emb not in EMBEDDING_IDS:
                out.append("combos[%d].embedding must be a scored embedding id" % index)
            if rer not in (MINILM_ID, BGE_RERANKER_ID, ETTIN_NAME) and not (
                isinstance(rer, str)
                and rer.count("/") == 1
                and rer.endswith("/" + ETTIN_NAME)
            ):
                out.append("combos[%d].reranker must be a scored reranker id" % index)
            for metric in ("recall@1", "recall@3", "recall@5", "mrr"):
                value = combo.get(metric)
                if not _is_num(value) or not 0.0 <= value <= 1.0:
                    out.append(
                        "combos[%d].%s must be a number within [0,1]" % (index, metric)
                    )
    return out


def _level2_sections(text):
    sections = []
    title = None
    body = []
    for line in text.splitlines():
        match = _HEAD2_RE.match(line)
        if match:
            if title is not None:
                sections.append((title, "\n".join(body)))
            title = match.group(1)
            body = []
        else:
            body.append(line)
    if title is not None:
        sections.append((title, "\n".join(body)))
    return sections


def validate_adr_consistency(adr_text, data):
    """Mirror of frozen check C5. Returns a list of violations."""
    out = []
    embeddings = data.get("embeddings") if isinstance(data, dict) else None
    rerankers = data.get("rerankers") if isinstance(data, dict) else None
    if not isinstance(embeddings, dict) or not isinstance(rerankers, dict):
        return ["results artifact lacks embeddings/rerankers objects"]

    bodies = [body for title, body in _level2_sections(adr_text) if title == "Decision"]
    if not bodies:
        return ["ADR has no level-2 heading exactly '## Decision'"]
    decision = bodies[0]

    named_embeddings = [cid for cid in EMBEDDING_IDS if cid in decision]
    if len(named_embeddings) != 1:
        out.append(
            "'## Decision' must name exactly one embedding candidate id, found %d"
            % len(named_embeddings)
        )
    named_rerankers = [
        cid for cid in (ETTIN_NAME, MINILM_ID, BGE_RERANKER_ID) if cid in decision
    ]
    if len(named_rerankers) != 1:
        out.append(
            "'## Decision' must name exactly one reranker candidate id, found %d"
            % len(named_rerankers)
        )
    if out or not named_embeddings:
        return out

    record = embeddings.get(named_embeddings[0])
    if not isinstance(record, dict):
        return ["winning embedding '%s' missing from results" % named_embeddings[0]]
    dims = record.get("dims")
    if not isinstance(dims, int) or isinstance(dims, bool) or dims <= 0:
        return ["winning embedding dims must be a positive integer in results"]
    dims_str = str(dims)
    labeled = re.search(
        r"dims\s*[:=]\s*%s\b" % re.escape(dims_str), decision, re.IGNORECASE
    )
    adjacent = False
    for match in re.finditer(re.escape(named_embeddings[0]), decision):
        window = decision[match.end() : match.end() + _ADJACENCY_WINDOW]
        if re.search(r"\b%s\b" % re.escape(dims_str), window):
            adjacent = True
            break
    if labeled is None and not adjacent:
        out.append(
            "'## Decision' must pair winning embedding '%s' with dims %s "
            "(labeled 'dims: %s' or adjacent)"
            % (named_embeddings[0], dims_str, dims_str)
        )
    return out


def load_and_validate(repo_root, results_rel=RESULTS_REL, adr_rel=ADR_REL):
    """Convenience for the CI guardrail test. Returns (violations, data)."""
    results_path = os.path.join(repo_root, *results_rel.split("/"))
    if not os.path.isfile(results_path):
        return ["%s not found" % results_rel], None
    with open(results_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    violations = validate_results(data, results_rel)
    adr_path = os.path.join(repo_root, *adr_rel.split("/"))
    if not os.path.isfile(adr_path):
        violations.append("%s not found" % adr_rel)
    else:
        with open(adr_path, "r", encoding="utf-8") as handle:
            adr_text = handle.read()
        violations.extend(validate_adr_consistency(adr_text, data))
    return violations, data
