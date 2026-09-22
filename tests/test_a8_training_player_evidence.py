"""Frozen acceptance checks C1-C7 for issue #58 (A8 spike closure).
Authored at arm's length at base a6e7426bac47ac3d6c91d74f49e569abee6703e0
before any deliverable existed.

Pins the issue-#58 evidence artifacts (probe transcript, screenshots, doc
pointers, harness) so drift (deleted evidence, weakened transcript, dead
trace-local pointers) fails CI. Exactly seven checks, one per frozen
acceptance check id (the trace's repro/check-cN.sh drivers select these by
-k suffix):

  test_c1_iframe_coep_evidence     AC1 iframe-under-COEP evidence
  test_c2_slide_read_evidence      AC2 live slide-read evidence
  test_c3_jump_evidence            AC3 10-jump evidence + jump-method isolation
  test_c4_fallback_documented      AC4 fallback documented
  test_c5_decision_recorded        AC5 decision recorded
  test_c6_txt_default_observation  AC6 txt__default observation
  test_c7_durable_pointers         AC7 durable repo-contained pointers

=======================================================================
CONTRACT FOR THE IMPLEMENTER — exact schemas these tests accept
=======================================================================

1. eval/a8-recipe-probe.json — the machine-written probe transcript:

   provenance (validated by C1; stamps the transcript's identity):
     generated_by      non-empty str
     git_commit        str, exactly 40 hex chars
     timestamp_utc     str, ISO-8601 datetime
                       (YYYY-MM-DDTHH:MM:SS[.fff][Z|+hh:mm])
     harness           str containing "a8-probe"
     source            object:
                         kind           "real-publish" | "committed-fixture"
                         path           non-empty str
                         player_version == "3.114.36620.0" (the pinned
                                          Storyline 360 publish)
                         course_id      non-empty str
                         slide_count    int > 0

   probes.iframe_coep (C1):
     rendered                 JSON true
     headers_sent             object with coop == "same-origin",
                              coep == "require-corp" and a corp key
                              holding a non-empty str
     coop_coep_console_errors EMPTY list
     screenshot               str path naming a8-embed-coep.png

   probes.player_api (C3; the jump-method isolation transcript):
     getPlayer_keys    list of >= 2 non-empty str
     jump_method       == "requestSlideForReview"
     isolation_session non-empty str

   probes.slide_read (C2; refutation re-checked by C4):
     getvar           object with projectSlideNumber and projectSlideTitle,
                      each an object with value JSON null and result, a
                      str containing "null" (the recorded GetVar
                      refutation)
     fallback_reads   list of >= 2 {"slideId": str, "slideTitle": str}
                      records covering >= 2 DISTINCT slideIds
     poll_interval_ms int == 1000

   probes.jumps (C3): EXACTLY 10 objects
     {seq: int 1..10 (the set 1..10 exactly), slideId: non-empty str,
      title: str, section: str, outline_depth: int >= 1, ok: JSON true,
      readback_slideId: str == slideId, ms: finite number > 0}
     with 10 DISTINCT slideIds and >= 1 record at outline_depth >= 2
     (a nested/non-top-level outline node).

   probes.txt_default (C6):
     observed_desktop_fetch  JSON boolean (either value; the observation
                             must simply be recorded)
     desktop_fetch_urls      list of non-empty str, with >= 1 entry when
                             observed_desktop_fetch is true
     mobile_assets_in_source int >= 0
     note                    non-empty str, not "TBD" (case-insensitive)

   decisions (C5):
     embedding           str containing "iframe"
     jump_method         == "requestSlideForReview"
     polling_interval_ms int == 1000

2. Screenshots (each a real PNG: magic bytes 89 50 4E 47 0D 0A 1A 0A and
   > 20000 bytes): eval/a8-embed-coep.png (C1) plus eval/a8-jump-01.png
   .. eval/a8-jump-10.png and NOTHING else matching eval/a8-jump-*.png
   (C3). Blank/tiny captures are rejected.

3. docs/training-player.md:
   - references eval/a8-recipe-probe.json, and every mention of
     "a8-recipe-probe.json" uses the committed eval/ path — no
     "evidence/a8-recipe-probe.json" (the deleted #81 trace-local form)
     or other bare trace-local mentions (C7)
   - mentions txt__default (C6)
   - keeps the decision markers "iframe-vs-window" and
     "requestSlideForReview" plus the 1000 ms polling decision (C5)
   - keeps a fallback marker: a "Fallback findings" heading or a GetVar
     mention (C4)

4. desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md: no
   "evidence/a8-recipe-probe.json" and, like the doc, no mention of
   "a8-recipe-probe.json" outside the committed eval/ path (C7).

5. eval/a8-probe.mjs: the regenerable probe harness, existing and
   non-empty (C7).

Stdlib-only; no network; no browser; deterministic; well under 5 s.
Every failure message names the exact artifact and the violated rule.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROBE_REL = "eval/a8-recipe-probe.json"
DOC_REL = "docs/training-player.md"
FIXTURE_CONTRACT_REL = "desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md"
HARNESS_REL = "eval/a8-probe.mjs"
EMBED_SHOT_REL = "eval/a8-embed-coep.png"
JUMP_SHOT_TEMPLATE = "eval/a8-jump-%02d.png"

PINNED_PLAYER_VERSION = "3.114.36620.0"
PINNED_JUMP_METHOD = "requestSlideForReview"
PINNED_POLL_INTERVAL_MS = 1000
JUMP_COUNT = 10

PROBE_FILENAME = "a8-recipe-probe.json"
DEAD_POINTER = "evidence/a8-recipe-probe.json"
COMMITTED_PROBE_REF = "eval/a8-recipe-probe.json"

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MIN_SCREENSHOT_BYTES = 20000

_COMMIT_RE = re.compile(r"[0-9a-fA-F]{40}")
_ISO_8601_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})"
)
_FALLBACK_HEADING_RE = re.compile(r"^#{1,6}\s+[^\n]*fallback\s+findings", re.I | re.M)
_POLL_DECISION_RE = re.compile(r"1000\s*ms", re.I)


# ---------------------------------------------------------------------------
# shared helpers (same conventions as tests/test_adr_0003_desktop_backend.py)
# ---------------------------------------------------------------------------


def _load(rel: str) -> str:
    path = REPO_ROOT / rel
    assert path.is_file(), (
        "required issue-#58 artifact missing: %s "
        "(the A8 fix must commit it; trace-local files do not count)" % rel
    )
    return path.read_text(encoding="utf-8")


def _load_json(rel: str):
    path = REPO_ROOT / rel
    assert path.is_file(), (
        "required issue-#58 artifact missing: %s "
        "(the A8 fix must commit it; trace-local files do not count)" % rel
    )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AssertionError("invalid JSON in %s: %s" % (rel, exc))


def _probe_block(data, name: str):
    """Navigate data['probes'][name]; returns (block-or-None, violations)."""
    if not isinstance(data, dict):
        return None, ["%s must be a JSON object" % PROBE_REL]
    probes = data.get("probes")
    if not isinstance(probes, dict):
        return None, ["probes block missing or not an object"]
    block = probes.get(name)
    if not isinstance(block, dict):
        return None, ["probes.%s missing or not an object" % name]
    return block, []


def _probe_list(data, name: str):
    """Like _probe_block but for list-valued probes (e.g. jumps)."""
    if not isinstance(data, dict):
        return None, ["%s must be a JSON object" % PROBE_REL]
    probes = data.get("probes")
    if not isinstance(probes, dict):
        return None, ["probes block missing or not an object"]
    block = probes.get(name)
    if not isinstance(block, list):
        return None, ["probes.%s missing or not a list" % name]
    return block, []


def _nonempty_str(value) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _png_violations(rel: str) -> list[str]:
    path = REPO_ROOT / rel
    if not path.is_file():
        return ["%s missing (a real browser capture must be committed)" % rel]
    size = path.stat().st_size
    if size <= MIN_SCREENSHOT_BYTES:
        return [
            "%s is only %d bytes; a real capture must exceed %d bytes"
            % (rel, size, MIN_SCREENSHOT_BYTES)
        ]
    with path.open("rb") as fh:
        magic = fh.read(len(PNG_MAGIC))
    if magic != PNG_MAGIC:
        return ["%s does not start with the PNG magic bytes" % rel]
    return []


# ---------------------------------------------------------------------------
# C1: iframe-under-COEP evidence (transcript provenance + iframe_coep block
#     + the committed embed screenshot)
# ---------------------------------------------------------------------------


def _provenance_violations(data) -> list[str]:
    if not isinstance(data, dict):
        return ["%s must be a JSON object" % PROBE_REL]
    prov = data.get("provenance")
    if not isinstance(prov, dict):
        return ["provenance block missing or not an object"]
    v: list[str] = []
    if not _nonempty_str(prov.get("generated_by")):
        v.append("provenance.generated_by must be a non-empty string")
    commit = prov.get("git_commit")
    if not isinstance(commit, str) or not _COMMIT_RE.fullmatch(commit):
        v.append("provenance.git_commit must be a 40-hex-char commit id")
    stamp = prov.get("timestamp_utc")
    if not isinstance(stamp, str) or not _ISO_8601_RE.fullmatch(stamp):
        v.append(
            "provenance.timestamp_utc must be an ISO-8601 datetime string "
            "(YYYY-MM-DDTHH:MM:SS[.fff][Z|+hh:mm])"
        )
    harness = prov.get("harness")
    if not isinstance(harness, str) or "a8-probe" not in harness:
        v.append("provenance.harness must be a string containing 'a8-probe'")
    source = prov.get("source")
    if not isinstance(source, dict):
        v.append("provenance.source missing or not an object")
        return v
    if source.get("kind") not in ("real-publish", "committed-fixture"):
        v.append(
            "provenance.source.kind must be 'real-publish' or "
            "'committed-fixture' (got %r)" % (source.get("kind"),)
        )
    if not _nonempty_str(source.get("path")):
        v.append("provenance.source.path must be a non-empty string")
    if source.get("player_version") != PINNED_PLAYER_VERSION:
        v.append(
            "provenance.source.player_version must be exactly %r (the "
            "pinned publish; any other player invalidates the recipe)"
            % PINNED_PLAYER_VERSION
        )
    if not _nonempty_str(source.get("course_id")):
        v.append("provenance.source.course_id must be a non-empty string")
    count = source.get("slide_count")
    if not _is_int(count) or count <= 0:
        v.append("provenance.source.slide_count must be an int > 0")
    return v


def _iframe_coep_violations(data) -> list[str]:
    block, v = _probe_block(data, "iframe_coep")
    if block is None:
        return v
    if block.get("rendered") is not True:
        v.append(
            "probes.iframe_coep.rendered must be JSON true (AC1 demands "
            "the course PLAY inside the COOP/COEP iframe)"
        )
    headers = block.get("headers_sent")
    if not isinstance(headers, dict):
        v.append("probes.iframe_coep.headers_sent missing or not an object")
    else:
        if headers.get("coop") != "same-origin":
            v.append(
                "probes.iframe_coep.headers_sent.coop must be 'same-origin' "
                "(got %r)" % (headers.get("coop"),)
            )
        if headers.get("coep") != "require-corp":
            v.append(
                "probes.iframe_coep.headers_sent.coep must be "
                "'require-corp' (got %r)" % (headers.get("coep"),)
            )
        if not _nonempty_str(headers.get("corp")):
            v.append(
                "probes.iframe_coep.headers_sent.corp must be a non-empty "
                "string (the CORP value the host actually sent)"
            )
    errors = block.get("coop_coep_console_errors")
    if not isinstance(errors, list):
        v.append("probes.iframe_coep.coop_coep_console_errors must be a list")
    elif errors:
        v.append(
            "probes.iframe_coep.coop_coep_console_errors must be EMPTY "
            "(got %d entries; AC1 demands zero COOP/COEP console errors)" % len(errors)
        )
    shot = block.get("screenshot")
    if not _nonempty_str(shot):
        v.append(
            "probes.iframe_coep.screenshot must be a non-empty string path "
            "to the committed embed screenshot"
        )
    elif Path(shot.replace("\\", "/")).name != "a8-embed-coep.png":
        v.append(
            "probes.iframe_coep.screenshot must point at the committed "
            "eval/a8-embed-coep.png artifact (got %r)" % shot
        )
    return v


def test_c1_iframe_coep_evidence():
    data = _load_json(PROBE_REL)
    v: list[str] = []
    v.extend(_provenance_violations(data))
    v.extend(_iframe_coep_violations(data))
    v.extend(_png_violations(EMBED_SHOT_REL))
    assert not v, "A8 AC1 (iframe-under-COEP) evidence violations: %s" % v


# ---------------------------------------------------------------------------
# C2: live slide-read evidence (GetVar refutation + >= 2 distinct fallback
#     reads + the frozen 1000 ms poll interval)
# ---------------------------------------------------------------------------


def _slide_read_violations(data) -> list[str]:
    block, v = _probe_block(data, "slide_read")
    if block is None:
        return v
    getvar = block.get("getvar")
    if not isinstance(getvar, dict):
        v.append(
            "probes.slide_read.getvar missing or not an object (the GetVar "
            "attempt must be recorded with its refuted result)"
        )
    else:
        for key in ("projectSlideNumber", "projectSlideTitle"):
            record = getvar.get(key)
            if not isinstance(record, dict):
                v.append("probes.slide_read.getvar.%s missing or not an object" % key)
                continue
            if "value" not in record or record["value"] is not None:
                v.append(
                    "probes.slide_read.getvar.%s.value must be JSON null "
                    "(the refuted GetVar result)" % key
                )
            result = record.get("result")
            if not isinstance(result, str) or "null" not in result.lower():
                v.append(
                    "probes.slide_read.getvar.%s.result must be a string "
                    "recording the null readback" % key
                )
    reads = block.get("fallback_reads")
    if not isinstance(reads, list):
        v.append("probes.slide_read.fallback_reads missing or not a list")
        reads = []
    elif len(reads) < 2:
        v.append(
            "probes.slide_read.fallback_reads must record at least 2 reads "
            "(got %d)" % len(reads)
        )
    slide_ids: list[str] = []
    for idx, record in enumerate(reads):
        if not isinstance(record, dict):
            v.append("fallback_reads[%d] must be an object" % idx)
            continue
        slide_id = record.get("slideId")
        if not _nonempty_str(slide_id):
            v.append("fallback_reads[%d].slideId must be a non-empty string" % idx)
        else:
            slide_ids.append(slide_id)
        if not isinstance(record.get("slideTitle"), str):
            v.append("fallback_reads[%d].slideTitle must be a string" % idx)
    if reads and len(set(slide_ids)) < 2:
        v.append(
            "probes.slide_read.fallback_reads must cover at least 2 "
            "DISTINCT slideIds (live values must update as slides change; "
            "got %s)" % sorted(set(slide_ids))
        )
    interval = block.get("poll_interval_ms")
    if not _is_int(interval) or interval != PINNED_POLL_INTERVAL_MS:
        v.append(
            "probes.slide_read.poll_interval_ms must be exactly %d (the "
            "frozen poll cadence)" % PINNED_POLL_INTERVAL_MS
        )
    return v


def test_c2_slide_read_evidence():
    data = _load_json(PROBE_REL)
    v = _slide_read_violations(data)
    assert not v, "A8 AC2 (live slide read) evidence violations: %s" % v


# ---------------------------------------------------------------------------
# C3: 10-jump evidence (player_api isolation transcript + 10 jump records
#     + the 10 committed jump screenshots)
# ---------------------------------------------------------------------------


def _player_api_violations(data) -> list[str]:
    block, v = _probe_block(data, "player_api")
    if block is None:
        return v
    keys = block.get("getPlayer_keys")
    if (
        not isinstance(keys, list)
        or len(keys) < 2
        or not all(_nonempty_str(key) for key in keys)
    ):
        v.append(
            "probes.player_api.getPlayer_keys must list at least 2 "
            "enumerated GetPlayer() keys (non-empty strings)"
        )
    if block.get("jump_method") != PINNED_JUMP_METHOD:
        v.append(
            "probes.player_api.jump_method must be exactly %r (the "
            "isolated jump method)" % PINNED_JUMP_METHOD
        )
    if not _nonempty_str(block.get("isolation_session")):
        v.append(
            "probes.player_api.isolation_session must be a non-empty string "
            "(the DevTools-equivalent enumeration transcript that isolated "
            "the jump method)"
        )
    return v


def _jumps_violations(data) -> list[str]:
    jumps, v = _probe_list(data, "jumps")
    if jumps is None:
        return v
    if len(jumps) != JUMP_COUNT:
        v.append(
            "probes.jumps must contain EXACTLY %d jump records (got %d)"
            % (JUMP_COUNT, len(jumps))
        )
    seqs: list[int] = []
    slide_ids: list[str] = []
    deepest = 0
    for idx, record in enumerate(jumps):
        if not isinstance(record, dict):
            v.append("probes.jumps[%d] must be an object" % idx)
            continue
        seq = record.get("seq")
        if _is_int(seq) and 1 <= seq <= JUMP_COUNT:
            seqs.append(seq)
        else:
            v.append("probes.jumps[%d].seq must be an int in 1..%d" % (idx, JUMP_COUNT))
        slide_id = record.get("slideId")
        if not _nonempty_str(slide_id):
            v.append("probes.jumps[%d].slideId must be a non-empty string" % idx)
        else:
            slide_ids.append(slide_id)
        if not isinstance(record.get("title"), str):
            v.append("probes.jumps[%d].title must be a string" % idx)
        if not isinstance(record.get("section"), str):
            v.append("probes.jumps[%d].section must be a string" % idx)
        depth = record.get("outline_depth")
        if not _is_int(depth) or depth < 1:
            v.append("probes.jumps[%d].outline_depth must be an int >= 1" % idx)
        elif depth > deepest:
            deepest = depth
        if record.get("ok") is not True:
            v.append("probes.jumps[%d].ok must be JSON true" % idx)
        readback = record.get("readback_slideId")
        if not isinstance(readback, str) or (
            isinstance(slide_id, str) and readback != slide_id
        ):
            v.append(
                "probes.jumps[%d].readback_slideId must equal slideId (the "
                "player's own state must confirm the landing slide)" % idx
            )
        duration = record.get("ms")
        if not _is_number(duration) or duration <= 0:
            v.append("probes.jumps[%d].ms must be a finite number > 0" % idx)
    if len(jumps) == JUMP_COUNT and sorted(seqs) != list(range(1, JUMP_COUNT + 1)):
        v.append("probes.jumps seq values must be exactly 1..%d" % JUMP_COUNT)
    if len(slide_ids) != len(set(slide_ids)):
        v.append(
            "the jump slideIds must be DISTINCT (duplicates among %s)"
            % sorted(set(slide_ids))
        )
    if deepest < 2:
        v.append(
            "at least one jump must target a nested/non-top-level outline "
            "node (outline_depth >= 2; deepest recorded is %d)" % deepest
        )
    return v


def _jump_screenshot_violations() -> list[str]:
    v: list[str] = []
    eval_dir = REPO_ROOT / "eval"
    expected = {"a8-jump-%02d.png" % n for n in range(1, JUMP_COUNT + 1)}
    actual: set[str] = set()
    if eval_dir.is_dir():
        actual = {p.name for p in eval_dir.glob("a8-jump-*.png")}
    if actual != expected:
        v.append(
            "eval/ must contain exactly the %d jump screenshots "
            "a8-jump-01.png..a8-jump-%02d.png (missing=%s, unexpected=%s)"
            % (
                JUMP_COUNT,
                JUMP_COUNT,
                sorted(expected - actual),
                sorted(actual - expected),
            )
        )
    for n in range(1, JUMP_COUNT + 1):
        v.extend(_png_violations(JUMP_SHOT_TEMPLATE % n))
    return v


def test_c3_jump_evidence():
    data = _load_json(PROBE_REL)
    v: list[str] = []
    v.extend(_player_api_violations(data))
    v.extend(_jumps_violations(data))
    v.extend(_jump_screenshot_violations())
    assert not v, "A8 AC3 (10 exact jumps) evidence violations: %s" % v


# ---------------------------------------------------------------------------
# C4: fallback documented (transcript carries the GetVar refutation and a
#     non-empty demonstrated alternative; doc keeps a fallback marker)
# ---------------------------------------------------------------------------


def test_c4_fallback_documented():
    data = _load_json(PROBE_REL)
    doc = _load(DOC_REL)
    block, v = _probe_block(data, "slide_read")
    if block is not None:
        getvar = block.get("getvar")
        if not isinstance(getvar, dict):
            v.append(
                "probes.slide_read.getvar missing (the refuted GetVar path "
                "must be recorded, not silently dropped)"
            )
        else:
            for key in ("projectSlideNumber", "projectSlideTitle"):
                record = getvar.get(key)
                if not isinstance(record, dict):
                    v.append(
                        "probes.slide_read.getvar.%s missing (the refuted "
                        "attempt must be recorded)" % key
                    )
                    continue
                if record.get("value") is not None:
                    v.append(
                        "probes.slide_read.getvar.%s.value must be JSON "
                        "null (the refutation)" % key
                    )
                result = record.get("result")
                if not isinstance(result, str) or "null" not in result.lower():
                    v.append(
                        "probes.slide_read.getvar.%s.result must quote the "
                        "null readback" % key
                    )
        reads = block.get("fallback_reads")
        if not isinstance(reads, list) or not reads:
            v.append(
                "probes.slide_read.fallback_reads must be non-empty (the "
                "demonstrated alternative for the refuted GetVar path)"
            )
    if not (_FALLBACK_HEADING_RE.search(doc) or "getvar" in doc.lower()):
        v.append(
            "docs/training-player.md must keep a fallback marker (a "
            "'Fallback findings' heading or a GetVar mention)"
        )
    assert not v, "A8 AC4 (fallback documented) violations: %s" % v


# ---------------------------------------------------------------------------
# C5: decision recorded (doc decision markers + transcript decisions block)
# ---------------------------------------------------------------------------


def test_c5_decision_recorded():
    data = _load_json(PROBE_REL)
    doc = _load(DOC_REL)
    v: list[str] = []
    for marker in ("iframe-vs-window", PINNED_JUMP_METHOD):
        if marker not in doc:
            v.append(
                "docs/training-player.md must keep the decision-summary "
                "marker %r" % marker
            )
    if not _POLL_DECISION_RE.search(doc):
        v.append(
            "docs/training-player.md must record the 1000 ms "
            "polling-interval decision"
        )
    decisions = data.get("decisions") if isinstance(data, dict) else None
    if not isinstance(decisions, dict):
        v.append("decisions block missing or not an object")
    else:
        embedding = decisions.get("embedding")
        if not isinstance(embedding, str) or "iframe" not in embedding.lower():
            v.append(
                "decisions.embedding must be a string containing 'iframe' "
                "(got %r)" % (embedding,)
            )
        if decisions.get("jump_method") != PINNED_JUMP_METHOD:
            v.append("decisions.jump_method must be exactly %r" % PINNED_JUMP_METHOD)
        interval = decisions.get("polling_interval_ms")
        if not _is_int(interval) or interval != PINNED_POLL_INTERVAL_MS:
            v.append(
                "decisions.polling_interval_ms must be exactly %d"
                % PINNED_POLL_INTERVAL_MS
            )
    assert not v, "A8 AC5 (decision recorded) violations: %s" % v


# ---------------------------------------------------------------------------
# C6: txt__default observation (concrete transcript record + doc mention)
# ---------------------------------------------------------------------------


def test_c6_txt_default_observation():
    data = _load_json(PROBE_REL)
    doc = _load(DOC_REL)
    block, v = _probe_block(data, "txt_default")
    if block is not None:
        observed = block.get("observed_desktop_fetch")
        if not isinstance(observed, bool):
            v.append(
                "probes.txt_default.observed_desktop_fetch must be a JSON "
                "boolean (the observation itself, either way)"
            )
        urls = block.get("desktop_fetch_urls")
        if not isinstance(urls, list) or not all(_nonempty_str(u) for u in urls):
            v.append(
                "probes.txt_default.desktop_fetch_urls must be a list of "
                "non-empty URL strings"
            )
        elif observed is True and not urls:
            v.append(
                "probes.txt_default.desktop_fetch_urls must list at least "
                "one URL when observed_desktop_fetch is true"
            )
        count = block.get("mobile_assets_in_source")
        if not _is_int(count) or count < 0:
            v.append(
                "probes.txt_default.mobile_assets_in_source must be an " "int >= 0"
            )
        note = block.get("note")
        if not _nonempty_str(note):
            v.append(
                "probes.txt_default.note must be a non-empty string (the "
                "concrete observation the D1 OCR follow-up consumes)"
            )
        elif "tbd" in note.lower():
            v.append(
                "probes.txt_default.note must be a concrete observation, " "not TBD"
            )
    if "txt__default" not in doc:
        v.append(
            "docs/training-player.md must mention txt__default (the "
            "rasterized-text asset observation)"
        )
    assert not v, "A8 AC6 (txt__default observation) violations: %s" % v


# ---------------------------------------------------------------------------
# C7: durable pointers (no dead trace-local forms; committed transcript
#     referenced; regenerable harness committed)
# ---------------------------------------------------------------------------


def test_c7_durable_pointers():
    doc = _load(DOC_REL)
    contract = _load(FIXTURE_CONTRACT_REL)
    harness = REPO_ROOT / HARNESS_REL
    v: list[str] = []
    targets = (
        ("docs/training-player.md", doc),
        (FIXTURE_CONTRACT_REL, contract),
    )
    for label, text in targets:
        if DEAD_POINTER in text:
            v.append(
                "%s still references the deleted #81 trace-local artifact "
                "%s" % (label, DEAD_POINTER)
            )
        bare = text.count(PROBE_FILENAME) - text.count(COMMITTED_PROBE_REF)
        if bare > 0:
            v.append(
                "%s mentions 'a8-recipe-probe.json' %d time(s) without the "
                "committed eval/ path; every mention must point at %s"
                % (label, bare, COMMITTED_PROBE_REF)
            )
    if COMMITTED_PROBE_REF not in doc:
        v.append(
            "docs/training-player.md must reference the committed "
            "transcript %s" % COMMITTED_PROBE_REF
        )
    if not harness.is_file() or harness.stat().st_size == 0:
        v.append(
            "eval/a8-probe.mjs (the regenerable probe harness) must exist "
            "and be non-empty"
        )
    assert not v, "A8 AC7 (durable pointers) violations: %s" % v
