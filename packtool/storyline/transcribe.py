#!/usr/bin/env python3
"""Offline narration transcription for Storyline publishes (issue #78, Workstream D2).

Build-machine-only CLI: walks an unmodified Articulate Storyline 360 HTML5
publish, inventories every audio/video media object that has no native
transcript sidecar, transcribes it with faster-whisper (CPU, int8) under a
content-hash cache, and emits one sidecar-format transcript file per media
OBJECT id so D1's packtool consumer (storyline/video-refs.ts) can read ASR
output through the exact decode path used for native sidecars.

Usage:
    python packtool/storyline/transcribe.py --publish <publishDir> \
        --out <asrDir> --cache-dir <cacheDir> --report <report.json> \
        [--model distil-large-v3] [--compute-type int8] [--language en] \
        [--cpu-threads N]

Media identity: the cache is keyed by CONTENT (sha256 of the media bytes) plus
the ASR parameters (format version, model, compute type) — never by filename
(publish filenames embed sample-rate/index metadata that churns across
re-publishes). Transcript OUTPUT is keyed by the media OBJECT id — the same
id space native `story_content/<id>_transcripts.js` sidecars use (issue #77
localization H7) — so re-publishes whose filenames churn still resolve.

This module is build-time tooling. Nothing in web_ui/ or the Electron
runtime imports it (acceptance check C5); faster-whisper is a build-machine
dependency installed separately (docs/training-transcription.md), imported
lazily so the module (and its tests) load without it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

DEFAULT_MODEL = "distil-large-v3"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_LANGUAGE = "en"
DEFAULT_CPU_THREADS = min(8, os.cpu_count() or 1)

# Chosen model (issue #78: name the actual choice, do not leave both as
# options): distil-large-v3, feasibility measured on the reference build
# machine (docs/training-transcription.md). `medium.en` remains available as
# an explicit --model override via the alias table below, never as a default.
MODEL_ALIASES = {
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
    "medium.en": "Systran/faster-whisper-medium.en",
}

CACHE_FORMAT_VERSION = 1
TRANSCRIPT_SUFFIX = "_transcripts.js"
_MEDIA_EXTS = (".mp3", ".mp4")


class TranscribeError(Exception):
    """Fatal, loud inventory/decode failure (drift or adversarial publish)."""


# ---------------------------------------------------------------------------
# Decode layer (mirrors packtool/storyline/decode.ts byte-for-byte semantics)


def read_text(path: str) -> str:
    """utf-8-sig semantics: strip one leading BOM from a utf-8 read."""
    with open(path, "r", encoding="utf-8-sig") as fh:
        return fh.read()


def decode_global_provide_data(
    payload_name: str, text: str, source_path: str = "<input>"
) -> Any:
    marker = "window.globalProvideData('" + payload_name + "', '"
    at = text.find(marker)
    if at == -1:
        raise TranscribeError(
            f"no window.globalProvideData('{payload_name}', ...) wrapper found in {source_path}"
        )
    start = at + len(marker)
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2  # skip escaped char; the terminating quote is unescaped only
            continue
        if ch == "'":
            break
        i += 1
    if i >= len(text):
        raise TranscribeError(
            f"unterminated globalProvideData('{payload_name}') payload in {source_path}"
        )
    raw = text[start:i]
    unescaped = raw.replace("\\\\", "\x00").replace("\\'", "'").replace("\x00", "\\")
    return json.loads(unescaped)


# ---------------------------------------------------------------------------
# Path safety (same contract as isUnsafeComponent in extract.ts/video-refs.ts)


def is_unsafe_component(value: str) -> bool:
    if len(value) == 0:
        return True
    if "/" in value or "\\" in value or "\x00" in value:
        return True
    if value in (".", "..") or value.startswith("./") or value.startswith("../"):
        return True
    if value.startswith(".\\") or value.startswith("..\\"):
        return True
    return False


def resolve_inside_publish(publish_dir: str, rel_url: str, what: str) -> str:
    # Path safety is per COMPONENT (the same contract as isUnsafeComponent in
    # extract.ts/video-refs.ts): a publish-relative url legitimately contains
    # '/' separators, but no component may be empty/absolute traversal.
    if not isinstance(rel_url, str) or not rel_url:
        raise TranscribeError(
            f"{what} refuses an unsafe publish-relative value: {rel_url!r}"
        )
    if rel_url.startswith("/") or rel_url.startswith("\\") or "://" in rel_url:
        raise TranscribeError(
            f"{what} refuses an unsafe publish-relative value: {rel_url!r}"
        )
    components = rel_url.replace("\\", "/").split("/")
    if any(is_unsafe_component(component) for component in components):
        raise TranscribeError(
            f"{what} refuses an unsafe publish-relative value: {rel_url!r}"
        )
    resolved = os.path.abspath(os.path.join(publish_dir, *components))
    base = os.path.abspath(publish_dir)
    if resolved != base and not resolved.startswith(base + os.sep):
        raise TranscribeError(
            f"{what} resolves outside the publish dir (refused): {rel_url!r}"
        )
    return resolved


# ---------------------------------------------------------------------------
# Inventory


@dataclass
class MediaObject:
    kind: str  # 'audio' | 'video'
    object_id: str
    asset_id: Any = None
    url: Optional[str] = None  # publish-relative, when resolvable


@dataclass
class Inventory:
    objects: List[MediaObject] = field(default_factory=list)
    # sidecar-covered object ids (native story_content/<id>_transcripts.js)
    sidecar_ids: set = field(default_factory=set)


def _walk_media_objects(node: Any, out: List[MediaObject]) -> None:
    """Fully recursive walk: audio objects may nest under layer audiolib[]
    arrays or objects[] depending on publisher version; recursion is the safe
    superset (fix plan U1/U3)."""
    if isinstance(node, dict):
        kind = node.get("kind")
        obj_id = node.get("id")
        if kind == "audio" and isinstance(obj_id, str):
            out.append(MediaObject("audio", obj_id, node.get("assetId")))
        elif kind == "video" and isinstance(obj_id, str):
            videodata = node.get("data") or {}
            asset_id = (
                videodata.get("videodata", {}).get("assetId")
                if isinstance(videodata, dict)
                else None
            )
            out.append(MediaObject("video", obj_id, asset_id))
        for value in node.values():
            _walk_media_objects(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk_media_objects(value, out)


def build_inventory(publish_dir: str) -> Inventory:
    data_js = os.path.join(publish_dir, "html5", "data", "js", "data.js")
    data = decode_global_provide_data("data", read_text(data_js), data_js)
    asset_lib = {
        entry.get("id"): entry.get("url")
        for entry in (data.get("assetLib") or [])
        if isinstance(entry, dict)
    }

    inv = Inventory()
    seen_ids: set = set()
    js_dir = os.path.join(publish_dir, "html5", "data", "js")
    for name in sorted(os.listdir(js_dir)):
        if not name.endswith(".js") or name in ("data.js", "frame.js", "paths.js"):
            continue
        slide_path = os.path.join(js_dir, name)
        payload = decode_global_provide_data("slide", read_text(slide_path), slide_path)
        found: List[MediaObject] = []
        _walk_media_objects(payload, found)
        for obj in found:
            if obj.object_id in seen_ids:
                continue
            seen_ids.add(obj.object_id)
            if is_unsafe_component(obj.object_id):
                raise TranscribeError(
                    f"media object id refuses an unsafe value: {obj.object_id!r}"
                )
            url = asset_lib.get(obj.asset_id) if obj.asset_id is not None else None
            if not (isinstance(url, str) and url.lower().endswith(_MEDIA_EXTS)):
                url = None  # unresolvable: becomes a per-entry error at run time
            obj.url = url
            inv.objects.append(obj)
            sidecar = os.path.join(
                publish_dir, "story_content", obj.object_id + TRANSCRIPT_SUFFIX
            )
            if os.path.isfile(sidecar):
                inv.sidecar_ids.add(obj.object_id)
    return inv


# ---------------------------------------------------------------------------
# Content-hash cache


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_composite(media_sha256: str, model_id: str, compute_type: str) -> str:
    return f"{CACHE_FORMAT_VERSION}|{media_sha256}|{model_id}|{compute_type}"


def cache_entry_path(
    cache_dir: str, media_sha256: str, model_id: str, compute_type: str
) -> str:
    composite = cache_composite(media_sha256, model_id, compute_type)
    key_hash = hashlib.sha256(composite.encode("utf-8")).hexdigest()
    return os.path.join(cache_dir, "transcripts", media_sha256[:12], key_hash + ".json")


def load_cues(
    cache_dir: str, media_sha256: str, model_id: str, compute_type: str
) -> Optional[dict]:
    """Return the cached payload, or None on a miss. A stored entry whose key
    components do not match the request is treated as a MISS (guardrail:
    stale/mis-keyed entries can never be served)."""
    path = cache_entry_path(cache_dir, media_sha256, model_id, compute_type)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return None
    stored = payload.get("key") or {}
    expected = {
        "format_version": CACHE_FORMAT_VERSION,
        "media_sha256": media_sha256,
        "model": model_id,
        "compute_type": compute_type,
    }
    if stored != expected:
        return None
    if not isinstance(payload.get("cues"), list):
        return None
    return payload


def store_cues(
    cache_dir: str,
    media_sha256: str,
    model_id: str,
    compute_type: str,
    cues: List[dict],
    duration_ms: Optional[int],
    note: Optional[str] = None,
) -> str:
    path = cache_entry_path(cache_dir, media_sha256, model_id, compute_type)
    payload = {
        "key": {
            "format_version": CACHE_FORMAT_VERSION,
            "media_sha256": media_sha256,
            "model": model_id,
            "compute_type": compute_type,
        },
        "model_alias": _alias_of(model_id),
        "duration_ms": duration_ms,
        "note": note,
        "cues": cues,
    }
    atomic_write_json(path, payload)
    return path


def atomic_write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _alias_of(model_id: str) -> str:
    for alias, resolved in MODEL_ALIASES.items():
        if resolved == model_id:
            return alias
    return model_id


# ---------------------------------------------------------------------------
# ASR runner (lazy faster-whisper; DI seam keeps tests hermetic)


@dataclass
class RunnerSpec:
    model_id: str
    compute_type: str
    language: str
    cpu_threads: int


Runner = Callable[[str, RunnerSpec], dict]

_MODEL_CACHE: Dict[Tuple[str, str, int], Any] = {}


def resolve_model_id(model: str) -> str:
    return MODEL_ALIASES.get(model, model)


def default_runner(media_path: str, spec: RunnerSpec) -> dict:
    """Lazy faster-whisper runner. Audio decode uses the bundled FFmpeg
    (PyAV) that faster-whisper ships, so MP3 and MP4 audio tracks take the
    same path with no system ffmpeg dependency. Media with NO audio stream
    (silent Storyline bumper videos) transcribe to an empty cue list — the
    honest ASR result for silence — instead of a decoder error."""
    try:
        import av
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - exercised only without dep
        raise TranscribeError(
            "faster-whisper is not installed; install it on the build machine: "
            "pip install faster-whisper (docs/training-transcription.md)"
        ) from exc

    with av.open(media_path) as container:
        if len(container.streams.audio) == 0:
            duration_ms = int(container.duration / 1000) if container.duration else None
            return {"cues": [], "duration_ms": duration_ms, "note": "no audio stream"}

    key = (spec.model_id, spec.compute_type, spec.cpu_threads)
    model = _MODEL_CACHE.get(key)
    if model is None:
        model = WhisperModel(
            spec.model_id,
            device="cpu",
            compute_type=spec.compute_type,
            cpu_threads=spec.cpu_threads,
        )
        _MODEL_CACHE[key] = model
    segments, info = model.transcribe(media_path, language=spec.language)
    cues = [{"start_ms": int(seg.start * 1000), "text": seg.text} for seg in segments]
    duration_ms = int(info.duration * 1000) if getattr(info, "duration", None) else None
    return {"cues": cues, "duration_ms": duration_ms}


# ---------------------------------------------------------------------------
# Output: sidecar-format transcript per media OBJECT id


def sidecar_payload(model_alias: str, cues: List[dict]) -> dict:
    return {
        "transcripts": [
            {
                "name": "captions",
                "source": "asr",
                "model": model_alias,
                "cues": cues,
            }
        ]
    }


def write_asr_sidecar(
    out_dir: str, object_id: str, model_alias: str, cues: List[dict]
) -> str:
    """Byte-format compatible with native story_content/<id>_transcripts.js
    sidecars (decode.ts decodeSidecarAsset parses it unchanged)."""
    path = os.path.join(out_dir, object_id + TRANSCRIPT_SUFFIX)
    body = json.dumps(sidecar_payload(model_alias, cues), ensure_ascii=False, indent=2)
    content = (
        "(function() {\n"
        f"    const data = {body};\n"
        f"    window.globalLoadJsAsset('{object_id}{TRANSCRIPT_SUFFIX}', JSON.stringify(data));\n"
        "})();\n"
    )
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return path


# ---------------------------------------------------------------------------
# Orchestration


@dataclass
class QueueItem:
    kind: str  # 'audio' | 'video'
    url: Optional[str]
    object_ids: List[str]


def build_queue(inv: Inventory) -> List[QueueItem]:
    """Audio grouped per unique media file (the ASR unit of work); videos per
    sidecar-less object id (the identity native sidecars would have used)."""
    queue: List[QueueItem] = []
    audio_by_url: Dict[str, List[str]] = {}
    for obj in inv.objects:
        if obj.object_id in inv.sidecar_ids:
            continue  # native sidecar covers this object; not in scope
        if obj.kind == "audio" and obj.url is not None:
            audio_by_url.setdefault(obj.url, []).append(obj.object_id)
        else:
            queue.append(QueueItem(obj.kind, obj.url, [obj.object_id]))
    for url, ids in audio_by_url.items():
        queue.append(QueueItem("audio", url, ids))
    return queue


def run_transcription(
    publish_dir: str,
    out_dir: str,
    cache_dir: str,
    model: str = DEFAULT_MODEL,
    compute_type: str = DEFAULT_COMPUTE_TYPE,
    language: str = DEFAULT_LANGUAGE,
    cpu_threads: Optional[int] = None,
    runner: Optional[Runner] = None,
) -> dict:
    """Transcribe every sidecar-less media asset; returns the JSON report."""
    model_id = resolve_model_id(model)
    threads = DEFAULT_CPU_THREADS if cpu_threads is None else cpu_threads
    spec = RunnerSpec(
        model_id=model_id,
        compute_type=compute_type,
        language=language,
        cpu_threads=threads,
    )
    transcribe: Runner = runner if runner is not None else default_runner
    model_alias = _alias_of(model_id)

    inv = build_inventory(publish_dir)
    queue = build_queue(inv)

    media_entries: List[dict] = []
    failures = 0
    cache_hits = 0
    transcribed = 0

    for item in queue:
        entry: Dict[str, Any] = {
            "kind": item.kind,
            "object_ids": item.object_ids,
            "url": item.url,
            "media_sha256": None,
            "status": "error",
            "error": None,
        }
        try:
            if item.url is None:
                raise TranscribeError(
                    f"{item.kind} object(s) {item.object_ids} reference "
                    + "no resolvable .mp3/.mp4 asset"
                )
            media_path = resolve_inside_publish(
                publish_dir, item.url, f"{item.kind} media {item.object_ids}"
            )
            if not os.path.isfile(media_path):
                raise TranscribeError(f"media file missing: {item.url}")
            media_sha = sha256_file(media_path)
            entry["media_sha256"] = media_sha

            cached = load_cues(cache_dir, media_sha, model_id, compute_type)
            if cached is not None:
                cues = cached["cues"]
                note = cached.get("note")
                entry["status"] = "cache_hit"
                cache_hits += 1
            else:
                result = transcribe(media_path, spec)
                cues = [
                    {"start_ms": int(cue["start_ms"]), "text": str(cue["text"])}
                    for cue in result["cues"]
                ]
                note = result.get("note")
                store_cues(
                    cache_dir,
                    media_sha,
                    model_id,
                    compute_type,
                    cues,
                    result.get("duration_ms"),
                    note=note,
                )
                entry["status"] = "transcribed"
                transcribed += 1
            if note:
                entry["note"] = note
            first_path = None
            for object_id in item.object_ids:
                path = write_asr_sidecar(out_dir, object_id, model_alias, cues)
                if first_path is None:
                    first_path = path
            entry["cues_path"] = first_path
        except Exception as exc:  # noqa: BLE001 - per-entry containment: one bad
            # media file must fail its own entry (report error + exit 1), never
            # abort the whole run (partial-failure contract, fix plan edge cases).
            entry["status"] = "error"
            entry["error"] = f"{type(exc).__name__}: {exc}"
            failures += 1
        media_entries.append(entry)

    return {
        "publish": publish_dir,
        "model_alias": model_alias,
        "model": model_id,
        "compute_type": compute_type,
        "language": language,
        "total": len(media_entries),
        "media_count": len(media_entries),
        # Successfully transcribed media = fresh ASR computes + cache hits
        # (a cache hit IS a transcription result; the C1 acceptance driver's
        # status vocabulary counts 'transcribed' and 'cache_hit' alike).
        "transcribed": transcribed + cache_hits,
        "transcribed_fresh": transcribed,
        "cache_hits": cache_hits,
        "failures": failures,
        "media": media_entries,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="transcribe.py",
        description="Offline narration transcription with a content-hash cache "
        "(build machine only; issue #78).",
    )
    parser.add_argument(
        "--publish", required=True, help="Storyline HTML5 publish folder"
    )
    parser.add_argument(
        "--out", required=True, help="ASR transcript output folder (per object id)"
    )
    parser.add_argument(
        "--cache-dir", required=True, help="content-hash transcript cache folder"
    )
    parser.add_argument("--report", required=True, help="JSON report output path")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, help="whisper model (default: %(default)s)"
    )
    parser.add_argument(
        "--compute-type", default=DEFAULT_COMPUTE_TYPE, help="CT2 compute type"
    )
    parser.add_argument(
        "--language", default=DEFAULT_LANGUAGE, help="spoken language code"
    )
    parser.add_argument(
        "--cpu-threads", type=int, default=None, help="CPU threads for inference"
    )
    args = parser.parse_args(argv)

    try:
        report = run_transcription(
            publish_dir=args.publish,
            out_dir=args.out,
            cache_dir=args.cache_dir,
            model=args.model,
            compute_type=args.compute_type,
            language=args.language,
            cpu_threads=args.cpu_threads,
        )
    except TranscribeError as exc:
        # Fatal inventory error: report it loudly, still write the report file.
        report = {
            "publish": args.publish,
            "model_alias": args.model,
            "model": resolve_model_id(args.model),
            "compute_type": args.compute_type,
            "language": args.language,
            "total": 0,
            "media_count": 0,
            "transcribed": 0,
            "cache_hits": 0,
            "failures": 1,
            "media": [],
            "fatal": str(exc),
        }
    atomic_write_json(args.report, report)
    return 1 if report["failures"] != 0 else 0


if __name__ == "__main__":
    sys.exit(main())
