"""Issue #78 acceptance and unit tests for packtool/storyline/transcribe.py.

Selectors pinned by the frozen acceptance checks (trace
.agents/issue-traces/78-offline-narration-transcription):
  -k cache_hit       -> C2 (AC2): second run over identical media makes 0 ASR calls
  -k content_change  -> C3 (AC3): same filename, different bytes -> new key -> re-run
  -k idempotent      -> C7 (AC7): main/CLI-level double run, 0 calls on run 2

HERMETIC: these tests never import faster_whisper. The producer module must be
importable and fully functional with faster_whisper UNAVAILABLE (build machines
and CI without the dependency); ASR is injected through the documented `runner`
seam. The hermeticity test installs a sys.meta_path blocker BEFORE the module
import and asserts the import plus core calls succeed.
"""

import importlib.util
import json
import os
import sys
import uuid

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULE_PATH = os.path.join(_HERE, "..", "packtool", "storyline", "transcribe.py")
_FIXTURE_PUBLISH = os.path.join(_HERE, "fixtures", "storyline-mini")


class _ImportBlocker:
    """sys.meta_path finder that makes `import faster_whisper` impossible."""

    def __init__(self, name_prefix):
        self.name_prefix = name_prefix

    def find_spec(self, fullname, path=None, target=None):
        if fullname == self.name_prefix or fullname.startswith(self.name_prefix + "."):
            raise ImportError(f"{self.name_prefix} is blocked (hermetic test)")
        return None


def _load_transcribe_module():
    blocker = _ImportBlocker("faster_whisper")
    sys.meta_path.insert(0, blocker)
    try:
        spec = importlib.util.spec_from_file_location(
            "storyline_transcribe", _MODULE_PATH
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        # Register before exec: dataclass field introspection resolves
        # cls.__module__ through sys.modules.
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    finally:
        sys.meta_path.remove(blocker)
    return module


transcribe = _load_transcribe_module()


# ---------------------------------------------------------------------------
# Synthetic publish builder (no real media decoding: runners are stubs)


def write_slide_js(path, payload):
    text = (
        json.dumps(payload, ensure_ascii=False)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
    )
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write("window.globalProvideData('slide', '" + text + "');")


def make_publish(
    tmp_path, media_bytes, audio_objects, video_objects, sidecar_ids=(), asset_lib=True
):
    """Build a minimal publish: data.js assetLib + one slide carrying the given
    audio (layer audiolib) and video (layer objects) objects."""
    publish = tmp_path / "publish"
    js_dir = publish / "html5" / "data" / "js"
    story = publish / "story_content"
    js_dir.mkdir(parents=True)
    story.mkdir(parents=True)

    lib = []
    if asset_lib:
        for idx, name in enumerate(sorted(media_bytes)):
            lib.append(
                {"id": 100 + idx, "kind": "asset", "url": "story_content/" + name}
            )
    data_payload = {"courseId": "syntheticCourse", "assetLib": lib, "scenes": []}
    text = json.dumps(data_payload).replace("\\", "\\\\").replace("'", "\\'")
    with open(js_dir / "data.js", "w", encoding="utf-8", newline="") as fh:
        fh.write("window.globalProvideData('data', '" + text + "');")

    objects = []
    audiolib = []
    asset_by_name = {name: 100 + idx for idx, name in enumerate(sorted(media_bytes))}
    for object_id, media_name in audio_objects:
        audiolib.append(
            {"kind": "audio", "id": object_id, "assetId": asset_by_name.get(media_name)}
        )
    for object_id, media_name in video_objects:
        videodata = {"assetId": asset_by_name.get(media_name)} if asset_lib else {}
        objects.append(
            {"kind": "video", "id": object_id, "data": {"videodata": videodata}}
        )
    slide_payload = {
        "id": "slideA",
        "slideLayers": [{"kind": "layer", "objects": objects, "audiolib": audiolib}],
    }
    write_slide_js(js_dir / "slideA.js", slide_payload)

    for name, blob in media_bytes.items():
        (story / name).write_bytes(blob)
    for object_id in sidecar_ids:
        (story / (object_id + "_transcripts.js")).write_text(
            "(function() { const data = "
            + json.dumps(
                {
                    "transcripts": [
                        {"name": "captions", "cues": [{"start": 0, "text": "native"}]}
                    ]
                }
            )
            + "}; window.globalLoadJsAsset('story_content/x', JSON.stringify(data)); })();",
            encoding="utf-8",
        )
    return publish


def stub_runner(outputs=None):
    """Runner counting ASR calls; each call returns the next output (or default)."""
    state = {"calls": 0}
    outputs = list(outputs or [])

    def runner(media_path, spec):
        state["calls"] += 1
        state["last_spec"] = spec
        state["last_path"] = media_path
        if outputs:
            return outputs.pop(0)
        return {
            "cues": [{"start_ms": 1500, "text": " Select the ProC button. "}],
            "duration_ms": 1560,
        }

    runner.calls = state  # type: ignore[attr-defined]
    return runner


AUDIO_A = ("audA", "narr_a_44100_56_0.mp3")
AUDIO_B = ("audB", "narr_b_44100_56_0.mp3")


def base_media_bytes():
    return {
        AUDIO_A[1]: b"\xff\xfb" + uuid.uuid4().hex.encode() + b" audio-bytes-a",
        AUDIO_B[1]: b"\xff\xfb" + uuid.uuid4().hex.encode() + b" audio-bytes-b",
    }


# ---------------------------------------------------------------------------
# Hermeticity + decode parity


def test_module_imports_and_runs_with_faster_whisper_blocked(tmp_path):
    publish = make_publish(tmp_path, base_media_bytes(), [AUDIO_A], [])
    runner = stub_runner()
    report = transcribe.run_transcription(
        str(publish), str(tmp_path / "out"), str(tmp_path / "cache"), runner=runner
    )
    assert report["total"] == 1 and report["failures"] == 0
    assert runner.calls["calls"] == 1


def test_decode_parity_with_fixture_data_js():
    fixture = os.path.join(_FIXTURE_PUBLISH, "html5", "data", "js", "data.js")
    data = transcribe.decode_global_provide_data(
        "data", transcribe.read_text(fixture), fixture
    )
    # The same payload the TS decode layer parses for the extract goldens
    # (the fixture trims the real payload to these keys).
    assert data["courseId"] == "5fox24EQH9w"
    assert data["version"] == "3.114.36620.0"
    assert data["slideCount"] == 6 and len(data["scenes"]) == 3


def test_decode_parity_with_fixture_sidecar_wrapper():
    fixture = os.path.join(
        _FIXTURE_PUBLISH, "story_content", "5a5ry690OX4_transcripts.js"
    )
    raw = transcribe.read_text(fixture)
    # The writer must emit content matching the SAME wrapper regex the TS
    # decoder uses (decode.ts decodeSidecarAsset).
    import re

    match = re.search(r"const data = (\{[\s\S]*\});\s*window\.globalLoadJsAsset", raw)
    assert match is not None
    payload = json.loads(match.group(1))
    assert payload["transcripts"][0]["cues"][0]["text"].startswith(
        "Patient documentation"
    )


def test_emitted_asr_sidecar_matches_native_wrapper_regex(tmp_path):
    cues = [{"start_ms": 1056, "text": "Patient documentation"}]
    path = transcribe.write_asr_sidecar(
        str(tmp_path), "abc123XYZ", "distil-large-v3", cues
    )
    import re

    raw = open(path, encoding="utf-8").read()
    match = re.search(r"const data = (\{[\s\S]*\});\s*window\.globalLoadJsAsset", raw)
    assert match is not None
    payload = json.loads(match.group(1))
    transcript = payload["transcripts"][0]
    assert transcript["source"] == "asr"
    assert transcript["cues"] == cues


# ---------------------------------------------------------------------------
# Inventory


def test_inventory_on_committed_fixture():
    inv = transcribe.build_inventory(_FIXTURE_PUBLISH)
    by_id = {obj.object_id: obj for obj in inv.objects}
    assert set(by_id) == {"5a5ry690OX4", "6qX2mV8bR1k"}
    assert all(obj.kind == "video" for obj in inv.objects)
    # The fixture's one native sidecar covers 5a5ry690OX4; the other video is
    # the queue. The fixture has no assetLib, so the queued video has no file.
    assert inv.sidecar_ids == {"5a5ry690OX4"}
    queue = transcribe.build_queue(inv)
    assert len(queue) == 1
    assert queue[0].kind == "video" and queue[0].object_ids == ["6qX2mV8bR1k"]


def test_audio_objects_in_audiolib_nesting_are_found(tmp_path):
    publish = make_publish(tmp_path, base_media_bytes(), [AUDIO_A, AUDIO_B], [])
    inv = transcribe.build_inventory(str(publish))
    assert {obj.object_id for obj in inv.objects} == {"audA", "audB"}
    assert inv.sidecar_ids == set()
    queue = transcribe.build_queue(inv)
    # Audio dedupes per unique media file: 2 files -> 2 queue items.
    assert len(queue) == 2


def test_unsafe_object_id_is_refused_loudly(tmp_path):
    publish = make_publish(tmp_path, base_media_bytes(), [("../evil", AUDIO_A[1])], [])
    with pytest.raises(transcribe.TranscribeError):
        transcribe.build_inventory(str(publish))


# ---------------------------------------------------------------------------
# Cache behavior (C2 / C3 + component matrix)


def test_cache_hit_second_run_zero_asr_calls(tmp_path):
    publish = make_publish(tmp_path, base_media_bytes(), [AUDIO_A, AUDIO_B], [])
    out_dir = str(tmp_path / "out")
    cache_dir = str(tmp_path / "cache")

    runner1 = stub_runner()
    report1 = transcribe.run_transcription(
        str(publish), out_dir, cache_dir, runner=runner1
    )
    assert (
        report1["transcribed"] == 2
        and report1["cache_hits"] == 0
        and report1["failures"] == 0
    )
    assert runner1.calls["calls"] == 2

    runner2 = stub_runner()
    report2 = transcribe.run_transcription(
        str(publish), out_dir, cache_dir, runner=runner2
    )
    assert report2["cache_hits"] == 2 and report2["transcribed_fresh"] == 0
    assert report2["transcribed"] == 2, "cache hits count as transcribed media"
    assert runner2.calls["calls"] == 0, "second run must make zero ASR calls"
    assert report2["failures"] == 0
    # Output sidecars are regenerated from the cache.
    assert os.path.isfile(os.path.join(out_dir, "audA_transcripts.js"))


def test_content_change_invalidates_cache_key(tmp_path):
    media = base_media_bytes()
    publish = make_publish(tmp_path, media, [AUDIO_A], [])
    cache_dir = str(tmp_path / "cache")
    out_dir = str(tmp_path / "out")

    runner1 = stub_runner()
    transcribe.run_transcription(str(publish), out_dir, cache_dir, runner=runner1)
    assert runner1.calls["calls"] == 1

    # SAME filename, DIFFERENT bytes -> different content hash -> re-transcribe.
    (publish / "story_content" / AUDIO_A[1]).write_bytes(b"\xff\xfb brand-new-bytes")
    runner2 = stub_runner()
    report2 = transcribe.run_transcription(
        str(publish), out_dir, cache_dir, runner=runner2
    )
    assert runner2.calls["calls"] == 1, "changed content must trigger re-transcription"
    assert report2["cache_hits"] == 0 and report2["transcribed_fresh"] == 1

    # The cache composite key is content-derived: different media hashes yield
    # different keys even when every other component matches.
    assert transcribe.cache_composite(
        "a" * 64, "m", "int8"
    ) != transcribe.cache_composite("b" * 64, "m", "int8")


def test_cache_key_component_matrix(tmp_path):
    model = transcribe.resolve_model_id("distil-large-v3")
    media = base_media_bytes()
    publish = make_publish(tmp_path, media, [AUDIO_A], [])
    cache_dir = str(tmp_path / "cache")
    out_dir = str(tmp_path / "out")

    runner = stub_runner()
    transcribe.run_transcription(str(publish), out_dir, cache_dir, runner=runner)

    sha = transcribe.sha256_file(str(publish / "story_content" / AUDIO_A[1]))
    cues = [{"start_ms": 0, "text": "x"}]

    # Hit: identical components.
    assert transcribe.load_cues(cache_dir, sha, model, "int8") is not None
    # Miss: different bytes under the same filename would produce a different
    # media sha (C3); here we assert the other component axes.
    assert (
        transcribe.load_cues(cache_dir, "f" * 64, model, "int8") is None
    ), "different bytes -> miss"
    assert (
        transcribe.load_cues(cache_dir, sha, "some/other-model", "int8") is None
    ), "different model -> miss"
    assert (
        transcribe.load_cues(cache_dir, sha, model, "float16") is None
    ), "different compute_type -> miss"
    stale = {
        "key": {
            "format_version": transcribe.CACHE_FORMAT_VERSION + 1,
            "media_sha256": sha,
            "model": model,
            "compute_type": "int8",
        },
        "cues": cues,
    }
    transcribe.atomic_write_json(
        transcribe.cache_entry_path(cache_dir, sha, model, "int8"), stale
    )
    # format_version lives inside the composite key, so a v2 entry written at
    # the v1 path still fails the stored-component comparison.
    assert (
        transcribe.load_cues(cache_dir, sha, model, "int8") is None
    ), "format_version mismatch -> miss"


def test_shared_file_two_object_ids_two_outputs_one_compute(tmp_path):
    media = base_media_bytes()
    publish = make_publish(
        tmp_path, media, [("audX", AUDIO_A[1]), ("audY", AUDIO_A[1])], []
    )
    out_dir = str(tmp_path / "out")
    cache_dir = str(tmp_path / "cache")

    runner = stub_runner()
    report = transcribe.run_transcription(
        str(publish), out_dir, cache_dir, runner=runner
    )
    assert runner.calls["calls"] == 1, "one unique file -> one ASR call"
    assert report["total"] == 1
    entry = report["media"][0]
    assert entry["object_ids"] == ["audX", "audY"]
    assert os.path.isfile(os.path.join(out_dir, "audX_transcripts.js"))
    assert os.path.isfile(os.path.join(out_dir, "audY_transcripts.js"))


# ---------------------------------------------------------------------------
# Idempotency at orchestration level (C7)


def test_idempotent_double_run_zero_calls_second_run(tmp_path):
    media = base_media_bytes()
    publish = make_publish(
        tmp_path,
        media,
        [AUDIO_A, AUDIO_B],
        [("vidSide", AUDIO_B[1])],
        sidecar_ids=("vidSide",),
    )
    out_dir = str(tmp_path / "out")
    cache_dir = str(tmp_path / "cache")

    runner1 = stub_runner()
    report1 = transcribe.run_transcription(
        str(publish), out_dir, cache_dir, runner=runner1
    )
    assert (
        report1["total"] == 2
    ), "sidecar-covered video must be excluded from the queue"
    assert report1["failures"] == 0

    runner2 = stub_runner()
    report2 = transcribe.run_transcription(
        str(publish), out_dir, cache_dir, runner=runner2
    )
    assert report2["cache_hits"] == report2["total"] == 2
    assert report2["transcribed_fresh"] == 0
    assert runner2.calls["calls"] == 0
    assert report2["failures"] == 0


def test_main_cli_double_run_via_stub_seam(tmp_path, monkeypatch):
    media = base_media_bytes()
    publish = make_publish(tmp_path, media, [AUDIO_A], [])
    out_dir = str(tmp_path / "out")
    cache_dir = str(tmp_path / "cache")
    report_path = str(tmp_path / "report.json")

    runner = stub_runner()
    argv = [
        "--publish",
        str(publish),
        "--out",
        out_dir,
        "--cache-dir",
        cache_dir,
        "--report",
        report_path,
    ]
    monkeypatch.setattr(transcribe, "default_runner", runner)
    assert transcribe.main(argv) == 0
    assert transcribe.main(argv) == 0
    assert runner.calls["calls"] == 1, "CLI double run: exactly one ASR call total"
    report = json.load(open(report_path, encoding="utf-8"))
    assert report["cache_hits"] == 1 and report["failures"] == 0


# ---------------------------------------------------------------------------
# Report contract + error paths


def test_report_shape_contract(tmp_path):
    publish = make_publish(tmp_path, base_media_bytes(), [AUDIO_A], [])
    runner = stub_runner()
    report = transcribe.run_transcription(
        str(publish), str(tmp_path / "out"), str(tmp_path / "cache"), runner=runner
    )
    for key in (
        "total",
        "media_count",
        "transcribed",
        "cache_hits",
        "failures",
        "media",
    ):
        assert key in report
    assert report["total"] == report["media_count"] == 1
    entry = report["media"][0]
    assert entry["kind"] == "audio"
    assert entry["url"].endswith(".mp3")
    assert entry["status"] in ("transcribed", "cache_hit")
    assert entry["error"] is None
    assert len(entry["media_sha256"]) == 64


def test_start_ms_int_math_from_runner():
    runner = stub_runner(
        outputs=[
            {"cues": [{"start_ms": int(1.5 * 1000), "text": "a"}], "duration_ms": 1500}
        ]
    )
    spec = transcribe.RunnerSpec(
        model_id="m", compute_type="int8", language="en", cpu_threads=1
    )
    result = runner("ignored.mp3", spec)
    cue = result["cues"][0]
    assert cue["start_ms"] == 1500 and isinstance(cue["start_ms"], int)


def test_missing_media_file_is_entry_error_not_crash(tmp_path):
    media = base_media_bytes()
    publish = make_publish(tmp_path, media, [AUDIO_A], [])
    os.remove(publish / "story_content" / AUDIO_A[1])
    runner = stub_runner()
    report = transcribe.run_transcription(
        str(publish), str(tmp_path / "out"), str(tmp_path / "cache"), runner=runner
    )
    assert report["failures"] == 1
    assert report["media"][0]["status"] == "error"
    assert "missing" in report["media"][0]["error"]
    assert runner.calls["calls"] == 0


def test_unresolvable_asset_is_entry_error(tmp_path):
    publish = make_publish(
        tmp_path, {}, [], [("vidNoAsset", "ghost.mp4")], asset_lib=True
    )
    runner = stub_runner()
    report = transcribe.run_transcription(
        str(publish), str(tmp_path / "out"), str(tmp_path / "cache"), runner=runner
    )
    assert report["failures"] == 1
    assert report["media"][0]["status"] == "error"
    assert "resolvable" in report["media"][0]["error"]


def test_empty_publish_zero_media(tmp_path):
    publish = make_publish(tmp_path, {}, [], [])
    report = transcribe.run_transcription(
        str(publish),
        str(tmp_path / "out"),
        str(tmp_path / "cache"),
        runner=stub_runner(),
    )
    assert report["total"] == 0 and report["failures"] == 0


def test_sidecar_covered_video_excluded_even_when_file_present(tmp_path):
    media = base_media_bytes()
    publish = make_publish(
        tmp_path, media, [], [("vidCov", AUDIO_A[1])], sidecar_ids=("vidCov",)
    )
    runner = stub_runner()
    report = transcribe.run_transcription(
        str(publish), str(tmp_path / "out"), str(tmp_path / "cache"), runner=runner
    )
    assert report["total"] == 0 and runner.calls["calls"] == 0


def test_no_audio_stream_media_transcribes_to_empty_cues(tmp_path):
    """Real-corpus semantics (C1): 22 sidecar-less bumper MP4s carry NO audio
    stream. faster-whisper's decoder raises on them; default_runner must probe
    first and return an empty (honest) transcription. Requires av (bundled
    with faster-whisper on build machines); skips where av is absent (CI)."""
    av = pytest.importorskip("av")
    media_path = str(tmp_path / "silent_bumper.mp4")
    container = av.open(media_path, "w")
    stream = container.add_stream("mpeg4", rate=8)
    stream.width, stream.height = 64, 64
    stream.pix_fmt = "yuv420p"
    for _ in range(8):
        frame = av.VideoFrame(width=64, height=64, format="yuv420p")
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()

    with av.open(media_path) as probe:
        assert len(probe.streams.audio) == 0, "fixture must have no audio stream"

    spec = transcribe.RunnerSpec(
        model_id=transcribe.resolve_model_id("distil-large-v3"),
        compute_type="int8",
        language="en",
        cpu_threads=1,
    )
    result = transcribe.default_runner(media_path, spec)
    assert result["cues"] == []
    assert result.get("note") == "no audio stream"
