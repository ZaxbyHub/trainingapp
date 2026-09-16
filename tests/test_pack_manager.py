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
