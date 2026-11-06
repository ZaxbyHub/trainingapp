"""Acceptance tests for the Python PackManager lifecycle (issue #69, C2).

Covers every acceptance row of issue #69 plus the install-policy refusals,
registry persistence, idempotent retry, and the on_conflict guardrail.
Real ChromaDB in temp dirs; the embedding model is stubbed inline (never via
conftest's vector_store fixture, whose teardown invalidates sys.modules).
"""

import json
import shutil
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pack_manager import (  # noqa: E402
    PackManager,
    PackManagerError,
    chunk_id_of,
    doc_id_from_bytes,
    normalize_text,
)
from vector_store import BM25Index, VectorStore  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "contracts" / "fixtures" / "packs"


class StubEmbeddingModel:
    def __init__(self, model_name=None):
        self.model_name = model_name or "stub"

    def encode(self, texts):
        return [[0.1] * 384 for _ in texts]

    def encode_single(self, text):
        return [0.1] * 384


def make_store(tmp_path: Path) -> VectorStore:
    with patch("vector_store.EmbeddingModel", StubEmbeddingModel):
        return VectorStore(db_path=str(tmp_path / "db"), embedding_model="stub")


def make_manager(tmp_path: Path) -> PackManager:
    return PackManager(make_store(tmp_path), packs_root=tmp_path / "packs")


def copy_fixture(name: str, dest: Path) -> Path:
    target = dest / name
    shutil.copytree(FIXTURES / name, target)
    return target


def collection_ids(store: VectorStore) -> set:
    return set(store.collection.get()["ids"])


def write_doc(pack_dir: Path, rel_path: str, obj: dict) -> None:
    doc = pack_dir / rel_path
    doc.write_text(json.dumps(obj), encoding="utf-8")
    manifest_path = pack_dir / "pack.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest["docs"]:
        if entry["path"] == rel_path:
            entry["sha256"] = doc_id_from_bytes(doc.read_bytes())
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


@pytest.fixture()
def workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


# ------------------------------------------------------------------ #
# AC1 — fresh install with content-hash identity
# ------------------------------------------------------------------ #


def test_install_bundled_min_content_hash_ids(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    result = pm.install(source)

    assert result.pack_id == "bundled-min"
    assert result.docs_installed == 2
    assert result.chunks_added == 2

    manifest = json.loads((source / "pack.json").read_text(encoding="utf-8"))
    store = pm.store
    stored = store.collection.get(include=["documents", "metadatas"])
    assert len(stored["ids"]) == 2

    expected_ids = set()
    for entry in manifest["docs"]:
        raw = (source / entry["path"]).read_bytes()
        doc_sha = doc_id_from_bytes(raw)
        text = normalize_text(json.loads(raw.decode("utf-8"))["text"])
        expected_ids.add(chunk_id_of(doc_sha, 0, text))
        # stored text is the normalized text, byte-for-byte
        idx = [i for i, s in enumerate(stored["metadatas"]) if s["doc_id"] == doc_sha]
        assert len(idx) == 1
        assert stored["documents"][idx[0]] == text
    assert set(stored["ids"]) == expected_ids


def test_install_splits_long_docs_by_fixed_words(workspace):
    pm = make_manager(workspace)
    pack = workspace / "src" / "longpack"
    pack.mkdir(parents=True)
    long_text = " ".join(f"word{i}" for i in range(600))
    (pack / "docs").mkdir()
    doc = pack / "docs" / "long.json"
    doc.write_text(json.dumps({"title": "L", "text": long_text}), encoding="utf-8")
    manifest = {
        "id": "longpack",
        "name": "Long",
        "version": "1.0.0",
        "published_at": "2026-09-16T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": "bge-small-en-v1.5", "dims": 384, "normalize": True},
        "chunking": {"strategy": "fixed-words", "size": 256, "overlap": 100},
        "docs": [
            {
                "path": "docs/long.json",
                "sha256": doc_id_from_bytes(doc.read_bytes()),
                "title": "L",
                "mime": "application/json",
            }
        ],
    }
    (pack / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")

    result = pm.install(pack)
    # 600 words, size 256 overlap 100 -> windows at 0,156,312,468 -> 4 chunks
    assert result.chunks_added == 4
    assert len(collection_ids(pm.store)) == 4

    stored = pm.store.collection.get(include=["documents", "metadatas"])
    rows = sorted(
        zip(stored["ids"], stored["metadatas"], stored["documents"]),
        key=lambda triple: triple[1]["chunk_index"],
    )
    words_per_chunk = [text.split() for _, _, text in rows]
    assert [len(w) for w in words_per_chunk] == [256, 256, 256, 132]
    # overlap: each chunk's trailing 100 words are the next chunk's first 100
    for prev, nxt in zip(words_per_chunk, words_per_chunk[1:]):
        assert prev[-100:] == nxt[:100]
    # every chunk id matches the ADR formula over its own stored text
    for chunk_id, meta, text in rows:
        assert chunk_id == chunk_id_of(meta["doc_id"], meta["chunk_index"], text)


# ------------------------------------------------------------------ #
# AC2 — the stale-chunk regression (the actual bug)
# ------------------------------------------------------------------ #


def test_reinstall_with_changed_content_removes_stale_chunks(workspace):
    pm = make_manager(workspace)
    install_dir = workspace / "install" / "versioned-a"
    shutil.copytree(FIXTURES / "versioned-a-1.0.0", install_dir)

    v1 = pm.install(install_dir)
    manifest = json.loads((install_dir / "pack.json").read_text(encoding="utf-8"))
    v1_sha = manifest["docs"][0]["sha256"]
    old_chunk_id = chunk_id_of(
        v1_sha,
        0,
        normalize_text(
            json.loads((install_dir / "docs" / "a.json").read_text(encoding="utf-8"))[
                "text"
            ]
        ),
    )

    # mutate content and re-install as 2.0.0 at the SAME manifest path
    shutil.rmtree(install_dir)
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", install_dir)
    write_doc(
        install_dir,
        "docs/a.json",
        {
            "title": "Doc A",
            "text": "Versioned A fixture document, mutated for the 2.0.0 refresh.",
        },
    )
    v2 = pm.install(install_dir)

    assert v1.version == "1.0.0" and v2.version == "2.0.0"
    assert v1_sha in v2.replaced_doc_ids
    ids_now = collection_ids(pm.store)
    assert old_chunk_id not in ids_now, "stale v1 chunk survived the 2.0.0 install"
    assert len(ids_now) == 1  # exactly the new content, no duplicates


# ------------------------------------------------------------------ #
# AC3 — supersede (cross-id, schema-valid foreign id)
# ------------------------------------------------------------------ #


def build_pack_a(workspace: Path) -> Path:
    pack = workspace / "src" / "pack-a"
    (pack / "docs").mkdir(parents=True)
    doc = pack / "docs" / "x.json"
    doc.write_text(
        json.dumps({"title": "X", "text": "Pack A original body text."}),
        encoding="utf-8",
    )
    manifest = {
        "id": "pack-a",
        "name": "Pack A",
        "version": "1.0.0",
        "published_at": "2026-09-16T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": "bge-small-en-v1.5", "dims": 384, "normalize": True},
        "chunking": {"strategy": "fixed-words", "size": 256, "overlap": 100},
        "docs": [
            {
                "path": "docs/x.json",
                "sha256": doc_id_from_bytes(doc.read_bytes()),
                "title": "X",
                "mime": "application/json",
            }
        ],
    }
    (pack / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")
    return pack


def test_cross_id_supersede_deactivates_target_keeps_files(workspace):
    pm = make_manager(workspace)
    pack_a = build_pack_a(workspace)
    res_a = pm.install(pack_a)
    a_chunk_id = chunk_id_of(
        json.loads((pack_a / "pack.json").read_text(encoding="utf-8"))["docs"][0][
            "sha256"
        ],
        0,
        normalize_text("Pack A original body text."),
    )

    superseding = workspace / "src" / "versioned-a-2.0.0"
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", superseding)
    manifest = json.loads((superseding / "pack.json").read_text(encoding="utf-8"))
    manifest["supersedes"] = ["pack-a@1.0.0"]
    (superseding / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")
    pm.install(superseding)

    assert a_chunk_id not in collection_ids(pm.store)

    records = {f"{r.pack_id}@{r.version}": r for r in pm.list_installed()}
    assert records["pack-a@1.0.0"].active is False
    assert records["versioned-a@2.0.0"].active is True

    # superseded pack's own files remain on disk
    assert (Path(res_a.install_path) / "pack.json").is_file()
    assert (Path(res_a.install_path) / "docs" / "x.json").is_file()


# ------------------------------------------------------------------ #
# AC4 — rollback restores the original chunk-id set
# ------------------------------------------------------------------ #


def test_rollback_restores_v1_chunk_id_set(workspace):
    pm = make_manager(workspace)
    install_dir = workspace / "install" / "versioned-a"
    shutil.copytree(FIXTURES / "versioned-a-1.0.0", install_dir)
    pm.install(install_dir)
    ids_after_v1 = collection_ids(pm.store)

    shutil.rmtree(install_dir)
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", install_dir)
    write_doc(
        install_dir,
        "docs/a.json",
        {
            "title": "Doc A",
            "text": "Versioned A fixture document, mutated for the 2.0.0 refresh.",
        },
    )
    pm.install(install_dir)
    assert collection_ids(pm.store) != ids_after_v1

    pm.rollback("versioned-a", "1.0.0")

    assert collection_ids(pm.store) == ids_after_v1
    records = {r.version: r for r in pm.list_installed() if r.pack_id == "versioned-a"}
    assert records["1.0.0"].active is True
    assert records["2.0.0"].active is False


# ------------------------------------------------------------------ #
# AC5 — remove
# ------------------------------------------------------------------ #


def test_remove_deletes_files_chunks_and_registry_row(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    result = pm.install(source)

    pm.remove("bundled-min")

    assert not Path(result.install_path).exists()
    assert collection_ids(pm.store) == set()
    assert [r for r in pm.list_installed() if r.pack_id == "bundled-min"] == []


# ------------------------------------------------------------------ #
# AC6 — BM25 persistence stays JSON-only
# ------------------------------------------------------------------ #


def test_bm25_persistence_round_trips_through_json_only(tmp_path):
    from document_processor import DocumentChunk

    index = BM25Index()
    index.add_documents(
        [
            DocumentChunk(
                text="alpha body", source="a.txt", chunk_index=0, doc_id="d1"
            ),
            DocumentChunk(text="beta body", source="b.txt", chunk_index=0, doc_id="d2"),
        ]
    )
    save_path = tmp_path / "bm25.json"
    index.save(str(save_path))
    assert save_path.exists()
    assert not (tmp_path / "bm25.pkl").exists()
    assert json.loads(save_path.read_text(encoding="utf-8"))["chunks"]

    reloaded = BM25Index()
    reloaded.load(str(save_path))
    assert [c.text for c in reloaded.chunks] == ["alpha body", "beta body"]
    assert [c.doc_id for c in reloaded.chunks] == ["d1", "d2"]


# ------------------------------------------------------------------ #
# AC7 — on_conflict semantics at the store API
# ------------------------------------------------------------------ #


def test_on_conflict_default_preserves_fail_fast(workspace):
    store = make_store(workspace)
    payload = [
        {
            "chunk_id": "dup-1",
            "text": "first",
            "embedding": [0.1] * 384,
            "metadata": {"source": "x", "doc_id": "d1"},
        }
    ]
    store.add_chunks_with_embeddings(payload)
    with pytest.raises(ValueError, match="already exist"):
        store.add_chunks_with_embeddings(payload)


def test_on_conflict_replace_deletes_then_inserts(workspace):
    store = make_store(workspace)
    first = [
        {
            "chunk_id": "dup-1",
            "text": "OLD TEXT",
            "embedding": [0.1] * 384,
            "metadata": {"source": "x", "doc_id": "d1", "chunk_index": 0},
        }
    ]
    second = [
        {
            "chunk_id": "dup-1",
            "text": "NEW TEXT",
            "embedding": [0.2] * 384,
            "metadata": {"source": "x", "doc_id": "d1", "chunk_index": 0},
        }
    ]
    store.add_chunks_with_embeddings(first)
    store.add_chunks_with_embeddings(second, on_conflict="replace")

    got = store.collection.get(ids=["dup-1"], include=["documents"])
    assert got["documents"] == ["NEW TEXT"]
    # BM25 purge (PRR-010): exactly one chunk for doc d1 remains, with the
    # new text -- a broken purge would leave the stale chunk here.
    bm25_for_doc = [c for c in store.bm25_index.chunks if c.doc_id == "d1"]
    assert len(bm25_for_doc) == 1
    assert bm25_for_doc[0].text == "NEW TEXT"


def test_on_conflict_signature_defaults_to_error():
    import inspect

    sig = inspect.signature(VectorStore.add_chunks_with_embeddings)
    param = sig.parameters.get("on_conflict")
    assert param is not None
    assert param.default == "error"


# ------------------------------------------------------------------ #
# AC8 — list_installed records
# ------------------------------------------------------------------ #


def test_list_installed_reports_id_version_active_path(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    result = pm.install(source)

    records = pm.list_installed()
    assert len(records) == 1
    record = records[0]
    assert record.pack_id == "bundled-min"
    assert record.version == "1.0.0"
    assert record.active is True
    assert record.install_path == result.install_path


# ------------------------------------------------------------------ #
# install-policy refusals and identity guards
# ------------------------------------------------------------------ #


def test_downgrade_refused(workspace):
    pm = make_manager(workspace)
    v2_dir = workspace / "v2"
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", v2_dir)
    pm.install(v2_dir)
    v1_dir = workspace / "v1"
    shutil.copytree(FIXTURES / "versioned-a-1.0.0", v1_dir)
    with pytest.raises(PackManagerError, match="downgrade"):
        pm.install(v1_dir)


def test_equal_version_reinstall_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    pm.install(source)
    with pytest.raises(PackManagerError, match="already installed"):
        pm.install(source)


def test_sha_mismatch_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    doc = source / "docs" / "welcome.json"
    doc.write_text(json.dumps({"title": "W", "text": "tampered"}), encoding="utf-8")
    with pytest.raises(PackManagerError, match="validation"):
        pm.install(source)


def test_traversal_doc_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("invalid-traversal", workspace)
    with pytest.raises(PackManagerError, match="validation"):
        pm.install(source)


# ------------------------------------------------------------------ #
# registry persistence, retry idempotence, delete fallback, verbs
# ------------------------------------------------------------------ #


def test_registry_persists_across_manager_instances(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    pm.install(source)

    pm2 = PackManager(pm.store, packs_root=pm.packs_root)
    records = pm2.list_installed()
    assert len(records) == 1 and records[0].pack_id == "bundled-min"

    # a second manager instance can drive lifecycle off the persisted registry
    pm2.remove("bundled-min")
    assert pm.list_installed() == []


def test_install_retry_after_registry_loss_is_idempotent(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    pm.install(source)
    ids_before = collection_ids(pm.store)

    # simulate a crash after the Chroma write but before the registry commit
    pm.registry_path.unlink()

    result = pm.install(source)
    assert result.chunks_added == 2
    assert collection_ids(pm.store) == ids_before
    assert len(pm.list_installed()) == 1


def test_delete_document_removes_pack_chunks_via_doc_id_fallback(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    pm.install(source)
    manifest = json.loads((source / "pack.json").read_text(encoding="utf-8"))
    doc_sha = manifest["docs"][0]["sha256"]

    assert pm.store.delete_document(doc_sha) is True
    remaining = pm.store.collection.get(include=["metadatas"])
    assert all(m["doc_id"] != doc_sha for m in remaining["metadatas"])


def test_supersede_and_rollback_verbs_are_symmetric(workspace):
    pm = make_manager(workspace)
    install_dir = workspace / "install" / "versioned-a"
    shutil.copytree(FIXTURES / "versioned-a-1.0.0", install_dir)
    pm.install(install_dir)
    ids_v1 = collection_ids(pm.store)

    shutil.rmtree(install_dir)
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", install_dir)
    write_doc(
        install_dir,
        "docs/a.json",
        {
            "title": "Doc A",
            "text": "Versioned A fixture document, mutated for the 2.0.0 refresh.",
        },
    )
    pm.install(install_dir)
    ids_v2 = collection_ids(pm.store)
    assert ids_v2 != ids_v1

    pm.rollback("versioned-a", "1.0.0")
    assert collection_ids(pm.store) == ids_v1

    pm.supersede("versioned-a", "1.0.0", "2.0.0")
    assert collection_ids(pm.store) == ids_v2
    records = {r.version: r for r in pm.list_installed() if r.pack_id == "versioned-a"}
    assert records["1.0.0"].active is False
    assert records["2.0.0"].active is True


def test_rollback_to_unknown_version_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    pm.install(source)
    with pytest.raises(PackManagerError, match="not installed"):
        pm.rollback("bundled-min", "9.9.9")


# ------------------------------------------------------------------ #
# round-2 hardening: zip refusal, semver pre-release order, embed guard
# ------------------------------------------------------------------ #


def test_zip_source_refused_cleanly(workspace):
    import zipfile

    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    zip_path = workspace / "bundled-min.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for path in source.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(source))
    with pytest.raises(PackManagerError, match="folder-form packs only"):
        pm.install(zip_path)


def test_semver_prerelease_numeric_binds_lower_than_alnum():
    from pack_manager import _version_key

    # semver 11.4: numeric identifiers have LOWER precedence than alphanumeric
    assert _version_key("1.0.0-1") < _version_key("1.0.0-alpha")
    assert _version_key("1.0.0-alpha") < _version_key("1.0.0-beta")
    assert _version_key("1.0.0-1") < _version_key("1.0.0-2")
    # a pre-release sorts below its release
    assert _version_key("1.0.0-rc.1") < _version_key("1.0.0")
    # longer identifier set wins on equal prefix
    assert _version_key("1.0.0-alpha") < _version_key("1.0.0-alpha.1")


def test_embedder_length_mismatch_refuses_partial_install(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)

    class ShortEmbedder:
        def encode(self, texts):
            return [[0.1] * 384]  # one vector for two docs

    pm.store.embedder = ShortEmbedder()
    with pytest.raises(PackManagerError, match="refusing partial install"):
        pm.install(source)
    assert pm.list_installed() == []


# ------------------------------------------------------------------ #
# swarm-pr-feedback round (PRR-001..018): error contract + negative paths
# ------------------------------------------------------------------ #


def test_missing_pack_json_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    (source / "pack.json").unlink()
    with pytest.raises(PackManagerError, match="missing from the pack"):
        pm.install(source)


def test_corrupt_pack_json_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    (source / "pack.json").write_bytes(b"\xff\xfe\x00not json")
    with pytest.raises(PackManagerError, match="not valid UTF-8 JSON"):
        pm.install(source)


def test_duplicate_doc_paths_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    manifest = json.loads((source / "pack.json").read_text(encoding="utf-8"))
    manifest["docs"].append(dict(manifest["docs"][0]))
    (source / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PackManagerError, match="duplicate docs"):
        pm.install(source)


def test_registry_corruption_raises_pack_manager_error(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    pm.install(source)
    pm.registry_path.write_bytes(b"\xff\xfe not utf-8 json")
    with pytest.raises(PackManagerError, match="unreadable"):
        pm.list_installed()


def test_remove_specific_version_keeps_other_versions(workspace):
    pm = make_manager(workspace)
    install_dir = workspace / "install" / "versioned-a"
    shutil.copytree(FIXTURES / "versioned-a-1.0.0", install_dir)
    pm.install(install_dir)
    ids_v1 = collection_ids(pm.store)
    shutil.rmtree(install_dir)
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", install_dir)
    write_doc(
        install_dir,
        "docs/a.json",
        {
            "title": "Doc A",
            "text": "Versioned A fixture document, mutated for the 2.0.0 refresh.",
        },
    )
    pm.install(install_dir)
    ids_v2 = collection_ids(pm.store)
    assert ids_v2 != ids_v1

    removed = pm.remove("versioned-a", version="1.0.0")

    assert removed == 1
    records = {r.version: r for r in pm.list_installed() if r.pack_id == "versioned-a"}
    assert "1.0.0" not in records
    assert records["2.0.0"].active is True
    assert collection_ids(pm.store) == ids_v2


def test_supersedes_warning_for_absent_target(workspace):
    pm = make_manager(workspace)
    superseding = workspace / "src" / "versioned-a-2.0.0"
    shutil.copytree(FIXTURES / "versioned-a-2.0.0", superseding)
    manifest = json.loads((superseding / "pack.json").read_text(encoding="utf-8"))
    manifest["supersedes"] = ["ghost-pack@3.1.4"]
    (superseding / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")

    result = pm.install(superseding)

    assert any("ghost-pack@3.1.4" in w for w in result.warnings)
    records = {r.pack_id: r for r in pm.list_installed()}
    assert records["versioned-a"].supersedes == ["ghost-pack@3.1.4"]


def test_unsupported_mime_refused(workspace):
    pm = make_manager(workspace)
    source = copy_fixture("bundled-min", workspace)
    manifest = json.loads((source / "pack.json").read_text(encoding="utf-8"))
    manifest["docs"][0]["mime"] = "application/pdf"
    (source / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PackManagerError, match="unsupported doc mime"):
        pm.install(source)


def build_long_doc_pack(workspace: Path, chunking: dict) -> Path:
    pack = workspace / "src" / "longpack"
    (pack / "docs").mkdir(parents=True)
    long_text = " ".join(f"word{i}" for i in range(600))
    doc = pack / "docs" / "long.json"
    doc.write_text(json.dumps({"title": "L", "text": long_text}), encoding="utf-8")
    manifest = {
        "id": "longpack",
        "name": "Long",
        "version": "1.0.0",
        "published_at": "2026-09-16T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": "bge-small-en-v1.5", "dims": 384, "normalize": True},
        "chunking": chunking,
        "docs": [
            {
                "path": "docs/long.json",
                "sha256": doc_id_from_bytes(doc.read_bytes()),
                "title": "L",
                "mime": "application/json",
            }
        ],
    }
    (pack / "pack.json").write_text(json.dumps(manifest), encoding="utf-8")
    return pack


def test_overlap_ge_size_refused(workspace):
    pm = make_manager(workspace)
    pack = build_long_doc_pack(
        workspace, {"strategy": "fixed-words", "size": 256, "overlap": 256}
    )
    with pytest.raises(PackManagerError, match="overlap"):
        pm.install(pack)


def test_strategy_over_size_refused(workspace):
    pm = make_manager(workspace)
    pack = build_long_doc_pack(
        workspace, {"strategy": "slide-aware", "size": 256, "overlap": 100}
    )
    with pytest.raises(PackManagerError, match="C6"):
        pm.install(pack)


def test_unknown_on_conflict_value_raises(workspace):
    store = make_store(workspace)
    payload = [
        {
            "chunk_id": "x1",
            "text": "t",
            "embedding": [0.1] * 384,
            "metadata": {"source": "s"},
        }
    ]
    store.add_chunks_with_embeddings(payload)
    with pytest.raises(ValueError, match="Unknown on_conflict"):
        store.add_chunks_with_embeddings(payload, on_conflict="bogus")


# ------------------------------------------------------------------ #
# #287 — claimant-aware document lifetime (shared-doc survival)
# ------------------------------------------------------------------ #


SHARED_DOC_OBJ = {
    "title": "Shared",
    "text": "Shared knowledge pack document byte-identical across two packs.",
}

A_ONLY_OBJ = {"title": "A only", "text": "Pack A specific document content."}
B_ONLY_OBJ = {"title": "B only", "text": "Pack B specific document content."}


def build_multi_doc_pack(root, name, pack_id, version, docs):
    """Write a minimal valid pack dir; manifest carries each doc's sha256."""
    pack = root / name
    pack.mkdir(parents=True, exist_ok=True)
    manifest_docs = []
    for rel_path, obj in sorted(docs.items()):
        p = pack / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(obj, indent=2).encode("utf-8")
        p.write_bytes(raw)
        manifest_docs.append(
            {
                "path": rel_path,
                "sha256": doc_id_from_bytes(raw),
                "title": obj["title"],
                "mime": "application/json",
            }
        )
    manifest = {
        "id": pack_id,
        "name": name,
        "version": version,
        "published_at": "2026-11-04T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": "bge-small-en-v1.5", "dims": 384, "normalize": True},
        "chunking": {"strategy": "fixed-words", "size": 256, "overlap": 100},
        "docs": manifest_docs,
    }
    (pack / "pack.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return pack


def shared_doc_id():
    raw = json.dumps(SHARED_DOC_OBJ, indent=2).encode("utf-8")
    return doc_id_from_bytes(raw)


def doc_chunk_ids(store, doc_id):
    got = store.collection.get(where={"doc_id": doc_id})
    return set(got["ids"])


def install_sibling_pair(workspace):
    """pack-a@1.0.0 + pack-b@1.0.0, both listing the byte-identical doc."""
    pm = make_manager(workspace)
    src_a = build_multi_doc_pack(
        workspace,
        "src-a",
        "pack-a",
        "1.0.0",
        {"docs/shared.json": SHARED_DOC_OBJ, "docs/a-only.json": A_ONLY_OBJ},
    )
    src_b = build_multi_doc_pack(
        workspace,
        "src-b",
        "pack-b",
        "1.0.0",
        {"docs/shared.json": SHARED_DOC_OBJ, "docs/b-only.json": B_ONLY_OBJ},
    )
    pm.install(src_a)
    pm.install(src_b)
    return pm


def test_shared_doc_survival_keeps_claim_on_remove(workspace):
    pm = install_sibling_pair(workspace)
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"

    pm.remove("pack-a")

    # storage-presence control: the shared doc's chunks survive
    assert doc_chunk_ids(pm.store, shared) == before
    # real retrievability: a genuine search() call returns the shared text
    hits = pm.store.search("Shared knowledge", n_results=10)
    assert any("byte-identical across two packs" in doc for doc, _, _ in hits)
    # sibling claim kept: pack-b's row still lists the shared doc, and is active
    row_b = next(r for r in pm.list_installed() if r.pack_id == "pack-b")
    assert row_b.active is True
    assert row_b.docs["docs/shared.json"]["doc_id"] == shared
    # unshared deletion preserved: pack-a's unique doc did NOT survive
    a_only_sha = doc_id_from_bytes(json.dumps(A_ONLY_OBJ, indent=2).encode("utf-8"))
    assert doc_chunk_ids(pm.store, a_only_sha) == set()


def test_shared_doc_survival_keeps_claim_on_upgrade_dropping_doc(workspace):
    pm = install_sibling_pair(workspace)
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"
    upgraded = build_multi_doc_pack(
        workspace, "src-a2", "pack-a", "2.0.0", {"docs/a-only.json": A_ONLY_OBJ}
    )
    pm.install(upgraded)

    assert doc_chunk_ids(pm.store, shared) == before
    row_b = next(r for r in pm.list_installed() if r.pack_id == "pack-b")
    assert row_b.active is True


def test_shared_doc_survival_keeps_claim_on_direct_supersede_without_it(workspace):
    ws = workspace
    src_a1 = build_multi_doc_pack(
        ws, "src-a1", "pack-a", "1.0.0", {"docs/a-only.json": A_ONLY_OBJ}
    )
    src_a2 = build_multi_doc_pack(
        ws,
        "src-a2",
        "pack-a",
        "2.0.0",
        {"docs/shared.json": SHARED_DOC_OBJ, "docs/a-only.json": A_ONLY_OBJ},
    )
    pm = make_manager(ws)
    pm.install(src_a1)
    pm.install(src_a2)
    pm.install(
        build_multi_doc_pack(
            ws, "src-b", "pack-b", "1.0.0", {"docs/shared.json": SHARED_DOC_OBJ}
        )
    )
    shared = shared_doc_id()

    pm.supersede("pack-a", "2.0.0", "1.0.0")

    assert doc_chunk_ids(pm.store, shared), "claimant-aware supersede lost the doc"
    row_b = next(r for r in pm.list_installed() if r.pack_id == "pack-b")
    assert row_b.active is True


def test_shared_doc_survival_keeps_claim_on_rollback_without_it(workspace):
    ws = workspace
    src_a1 = build_multi_doc_pack(
        ws, "src-a1", "pack-a", "1.0.0", {"docs/a-only.json": A_ONLY_OBJ}
    )
    src_a2 = build_multi_doc_pack(
        ws,
        "src-a2",
        "pack-a",
        "2.0.0",
        {"docs/shared.json": SHARED_DOC_OBJ, "docs/a-only.json": A_ONLY_OBJ},
    )
    pm = make_manager(ws)
    pm.install(src_a1)
    pm.install(src_a2)
    pm.install(
        build_multi_doc_pack(
            ws, "src-b", "pack-b", "1.0.0", {"docs/shared.json": SHARED_DOC_OBJ}
        )
    )
    shared = shared_doc_id()

    pm.rollback("pack-a", "1.0.0")

    assert doc_chunk_ids(pm.store, shared), "claimant-aware rollback lost the doc"
    row_b = next(r for r in pm.list_installed() if r.pack_id == "pack-b")
    assert row_b.active is True


def test_shared_doc_survival_other_version_claim_keeps_doc_until_whole_pack_removed(
    workspace,
):
    # M5 discriminator: the surviving claim is an INACTIVE sibling version row.
    ws = workspace
    docs_with = {"docs/shared.json": SHARED_DOC_OBJ}
    pm = make_manager(ws)
    pm.install(build_multi_doc_pack(ws, "src-a1", "pack-a", "1.0.0", docs_with))
    pm.install(build_multi_doc_pack(ws, "src-a2", "pack-a", "2.0.0", docs_with))
    pm.rollback("pack-a", "1.0.0")
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"
    rows = {r.version: r for r in pm.list_installed()}
    assert rows["1.0.0"].active is True
    assert rows["2.0.0"].active is False
    assert doc_chunk_ids(pm.store, shared) == before

    # version-scoped removal must not delete what the inactive row claims
    pm.remove("pack-a", "1.0.0")
    assert doc_chunk_ids(pm.store, shared) == before

    # whole-pack removal excludes victim rows as claimants: cleanup still works
    pm.remove("pack-a")
    assert doc_chunk_ids(pm.store, shared) == set()


def test_shared_doc_survival_controls_unshared_docs_still_deleted(workspace):
    # Falsifiability half: with NO sibling claim every verb still deletes, so
    # the guard cannot pass by never deleting (M4 over-broad). Each sub-leg
    # gets its own subdirectory: make_manager pins one store db + registry
    # per directory, so sharing a workspace would cross-contaminate rows.
    ctl = workspace / "controls"
    ctl.mkdir()
    pm = install_sibling_pair(ctl / "remove")
    a_only_sha = doc_id_from_bytes(json.dumps(A_ONLY_OBJ, indent=2).encode("utf-8"))
    pm.remove("pack-a")
    assert doc_chunk_ids(pm.store, a_only_sha) == set()

    # upgrade: changed content at the same path deletes the old doc
    old_obj = {"title": "V1", "text": "Versioned A fixture document v1 body."}
    new_obj = {"title": "V2", "text": "Versioned A fixture document v2 body."}
    up = ctl / "upgrade"
    up.mkdir()
    pm2 = make_manager(up)
    pm2.install(
        build_multi_doc_pack(up, "src-v1", "pack-v", "1.0.0", {"docs/v.json": old_obj})
    )
    old_sha = doc_id_from_bytes(json.dumps(old_obj, indent=2).encode("utf-8"))
    pm2.install(
        build_multi_doc_pack(up, "src-v2", "pack-v", "2.0.0", {"docs/v.json": new_obj})
    )
    assert doc_chunk_ids(pm2.store, old_sha) == set()

    # direct supersede control: target without the doc, no sibling -> deleted
    sup = ctl / "supersede"
    sup.mkdir()
    shared = shared_doc_id()
    pm3 = make_manager(sup)
    pm3.install(
        build_multi_doc_pack(
            sup, "src-a1", "pack-a", "1.0.0", {"docs/a.json": A_ONLY_OBJ}
        )
    )
    pm3.install(
        build_multi_doc_pack(
            sup, "src-a2", "pack-a", "2.0.0", {"docs/shared.json": SHARED_DOC_OBJ}
        )
    )
    pm3.supersede("pack-a", "2.0.0", "1.0.0")
    assert doc_chunk_ids(pm3.store, shared) == set()

    # rollback control: target without the doc, no sibling -> deleted
    rb = ctl / "rollback"
    rb.mkdir()
    pm4 = make_manager(rb)
    pm4.install(
        build_multi_doc_pack(
            rb, "src-b1", "pack-b", "1.0.0", {"docs/b.json": B_ONLY_OBJ}
        )
    )
    pm4.install(
        build_multi_doc_pack(
            rb, "src-b2", "pack-b", "2.0.0", {"docs/shared.json": SHARED_DOC_OBJ}
        )
    )
    pm4.rollback("pack-b", "1.0.0")
    assert doc_chunk_ids(pm4.store, shared) == set()


# ------------------------------------------------------------------ #
# #287 — route-level shared-doc survival (AC2)
# ------------------------------------------------------------------ #


def route_client(monkeypatch, pm):
    """TestClient for the pack routes that is hermetic against test-order
    auth pollution: test_auth.py reloads auth/api_server with ENABLE_AUTH
    enabled and leaves the reimported module cached, so the routes' auth
    dependency is overridden explicitly (the tests/test_api_endpoints.py
    pattern) instead of relying on the ambient auth state."""
    from fastapi.testclient import TestClient

    import api_server
    from auth import authenticate

    monkeypatch.setitem(
        api_server.app.dependency_overrides,
        authenticate,
        lambda: {"authenticated": True, "method": "test"},
    )
    monkeypatch.setattr(api_server, "pack_manager", pm)
    return TestClient(api_server.app)


def test_shared_doc_route_remove_keeps_shared_doc(workspace, monkeypatch):
    pm = install_sibling_pair(workspace)
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"
    test_client = route_client(monkeypatch, pm)

    response = test_client.post("/packs/remove", json={"pack_id": "pack-a"})

    assert response.status_code == 200
    assert response.json() == {"removed": 1}
    assert doc_chunk_ids(pm.store, shared) == before
    listed = test_client.get("/packs").json()["packs"]
    assert not any(p["pack_id"] == "pack-a" for p in listed)
    row_b = next(p for p in listed if p["pack_id"] == "pack-b")
    assert row_b["active"] is True


def test_shared_doc_route_rollback_keeps_shared_doc(workspace, monkeypatch):
    ws = workspace
    src_a1 = build_multi_doc_pack(
        ws, "src-a1", "pack-a", "1.0.0", {"docs/a-only.json": A_ONLY_OBJ}
    )
    src_a2 = build_multi_doc_pack(
        ws,
        "src-a2",
        "pack-a",
        "2.0.0",
        {"docs/shared.json": SHARED_DOC_OBJ, "docs/a-only.json": A_ONLY_OBJ},
    )
    pm = make_manager(ws)
    pm.install(src_a1)
    pm.install(src_a2)
    pm.install(
        build_multi_doc_pack(
            ws, "src-b", "pack-b", "1.0.0", {"docs/shared.json": SHARED_DOC_OBJ}
        )
    )
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"
    test_client = route_client(monkeypatch, pm)

    response = test_client.post(
        "/packs/rollback", json={"pack_id": "pack-a", "to_version": "1.0.0"}
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert doc_chunk_ids(pm.store, shared) == before
    rows = {r.version: r for r in pm.list_installed() if r.pack_id == "pack-a"}
    assert rows["1.0.0"].active is True
    assert rows["2.0.0"].active is False


def test_shared_doc_route_remove_still_deletes_unshared_doc(workspace, monkeypatch):
    pm = make_manager(workspace)
    pm.install(
        build_multi_doc_pack(
            workspace, "src-solo", "pack-solo", "1.0.0", {"docs/only.json": A_ONLY_OBJ}
        )
    )
    only_sha = doc_id_from_bytes(json.dumps(A_ONLY_OBJ, indent=2).encode("utf-8"))
    test_client = route_client(monkeypatch, pm)

    response = test_client.post("/packs/remove", json={"pack_id": "pack-solo"})

    assert response.status_code == 200
    assert response.json() == {"removed": 1}
    assert doc_chunk_ids(pm.store, only_sha) == set()


# ------------------------------------------------------------------ #
# #287 review round - claim-true citation re-attribution (PRR-004)
# ------------------------------------------------------------------ #


def test_shared_doc_citation_reattributes_to_surviving_claim(workspace):
    """After the chunk metadata's LAST WRITER is removed, retrieval must
    name the SURVIVING claimant in the citation source and pack fields,
    not the removed pack's stale last-writer metadata (PRR-004).

    install_sibling_pair installs pack-a then pack-b, so the store chunk
    rows carry pack-b's metadata (same content-hash chunk ids, replace
    mode); removing pack-b exercises the stale-writer shape.
    """
    pm = install_sibling_pair(workspace)
    pm.store.pack_status_provider = pm.active_pack_claims
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"

    pm.remove("pack-b")
    assert doc_chunk_ids(pm.store, shared) == before

    context, sources, chunks = pm.store.get_context(
        "Shared knowledge pack document",
        n_results=5,
        hybrid_search=True,
        retrieval_window=1,
    )
    hit = next(c for c in chunks if c.doc_id == shared)
    assert hit.source.startswith("pack-a/"), hit.source
    assert not hit.source.startswith("pack-b/")
    assert hit.pack_id == "pack-a"
    assert hit.pack_version == "1.0.0"


def test_shared_doc_citation_reattributes_vector_only_path(workspace):
    """The vector-only branch (hybrid_search=False) must re-attribute the
    stale last-writer source too (reviewer round follow-up question)."""
    pm = install_sibling_pair(workspace)
    pm.store.pack_status_provider = pm.active_pack_claims
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"

    pm.remove("pack-b")
    assert doc_chunk_ids(pm.store, shared) == before

    for window in (0, 1):
        context, sources, chunks = pm.store.get_context(
            "Shared knowledge pack document",
            n_results=5,
            hybrid_search=False,
            retrieval_window=window,
        )
        hit = next(c for c in chunks if c.doc_id == shared)
        assert hit.source.startswith("pack-a/"), (window, hit.source)
        assert hit.pack_id == "pack-a"
        assert hit.pack_version == "1.0.0"


def test_claims_helper_tolerates_malformed_registry_rows(workspace):
    """PRR-005 pin: a malformed registry row (docs null, non-dict doc info)
    must not abort an unrelated pack's lifecycle verb (the route would
    have answered 500 via the unguarded AttributeError)."""
    pm = install_sibling_pair(workspace)
    shared = shared_doc_id()
    before = doc_chunk_ids(pm.store, shared)
    assert before, "fixture failed to install the shared doc"

    rows = pm._rows()
    rows.append(
        {
            "pack_id": "ghost",
            "version": "9.9.9",
            "active": True,
            "install_path": "nowhere",
            "docs": None,
        }
    )
    rows.append(
        {
            "pack_id": "ghost2",
            "version": "9.9.9",
            "active": True,
            "install_path": "nowhere",
            "docs": {"x": "not-a-dict"},
        }
    )
    with patch.object(pm, "_rows", return_value=rows):
        pm.remove("pack-a")

    assert doc_chunk_ids(pm.store, shared) == before
