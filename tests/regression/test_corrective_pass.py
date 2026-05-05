"""Regression tests for the corrective pass (post-10-fix).

Three issues confirmed after the initial remediation:
  C1: Document identity end-to-end (metadata keyed by doc_id, delete by doc_id)
  C2: QueryResult.retrieved_chunks reflects final context, not raw candidates
  C3: GUI normalize_settings() migrates rag_* keys; SettingsDialog uses canonical keys
"""

import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# ---------------------------------------------------------------------------
# Stub unavailable GUI dependencies so app_gui can be inspected in headless CI.
# These must be in sys.modules BEFORE any import of app_gui or theme.
# ---------------------------------------------------------------------------
_MOCK_CTK = MagicMock()
_MOCK_CTK.CTkBaseClass = type("CTkBaseClass", (), {})
_MOCK_CTK.CTk = type("CTk", (), {"__init__": lambda self, *a, **k: None})
_MOCK_CTK.CTkFrame = type("CTkFrame", (), {"__init__": lambda self, *a, **k: None})
_MOCK_CTK.CTkLabel = MagicMock
_MOCK_CTK.CTkButton = MagicMock
_MOCK_CTK.CTkEntry = MagicMock
_MOCK_CTK.CTkTextbox = MagicMock
_MOCK_CTK.CTkProgressBar = MagicMock
_MOCK_CTK.CTkOptionMenu = MagicMock
_MOCK_CTK.CTkScrollableFrame = MagicMock
_MOCK_CTK.CTkToplevel = type("CTkToplevel", (), {"__init__": lambda self, *a, **k: None})
_MOCK_CTK.CTkSwitch = MagicMock
_MOCK_CTK.StringVar = MagicMock
_MOCK_CTK.set_appearance_mode = MagicMock()
_MOCK_CTK.set_default_color_theme = MagicMock()
_MOCK_CTK.ThemeManager = MagicMock()

for _name in ("customtkinter",):
    sys.modules.setdefault(_name, _MOCK_CTK)

# Stub tkinter if absent (headless)
if "tkinter" not in sys.modules:
    _tk_mock = MagicMock()
    _tk_mock.Event = type("Event", (), {})
    sys.modules["tkinter"] = _tk_mock
    sys.modules["tkinter.filedialog"] = MagicMock()
    sys.modules["tkinter.messagebox"] = MagicMock()

# theme.py imports customtkinter — stub the whole module if needed
if "theme" not in sys.modules:
    _theme_mock = MagicMock()
    _theme_mock.ColorTokens = type("ColorTokens", (), {})()
    _theme_mock.TypeScale = type("TypeScale", (), {})()
    _theme_mock.FONT_FAMILY = "Helvetica"

    class _Spacing:
        XS = 2; SM = 4; MD = 8; LG = 12; XL = 16

    _theme_mock.Spacing = _Spacing
    sys.modules["theme"] = _theme_mock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_testable_vs():
    """Return a VectorStore subclass instance that skips __init__."""
    from vector_store import VectorStore

    class TestableVS(VectorStore):
        def __init__(self):
            pass  # skip real __init__

    vs = TestableVS()
    vs._lock = threading.RLock()
    vs.bm25_index = None
    vs._bm25_needs_rebuild = False
    vs.db_path = Path(tempfile.mkdtemp())
    vs.metadata = {"document_count": 0, "chunk_count": 0, "documents": {}}
    vs.collection = MagicMock()
    vs.collection.count = MagicMock(return_value=0)
    vs.collection.delete = MagicMock()
    vs.collection.add = MagicMock()
    vs.collection.get = MagicMock(return_value={"ids": [], "documents": [], "metadatas": []})
    # Return correct-length embeddings for any batch size
    vs.embedder = MagicMock()
    vs.embedder.encode = MagicMock(
        side_effect=lambda texts: [[0.0] * 384 for _ in texts]
    )
    return vs


def _make_chunk(source, chunk_index=0, doc_id=None, source_path=None, text="hello"):
    from document_processor import DocumentChunk
    c = DocumentChunk(text=text, source=source, chunk_index=chunk_index)
    c.doc_id = doc_id
    c.source_path = source_path
    return c


# ---------------------------------------------------------------------------
# C1: Document identity end-to-end
# ---------------------------------------------------------------------------

class TestC1DocumentIdentityEndToEnd:
    """metadata["documents"] must be keyed by doc_id, not source basename."""

    def test_add_chunks_keys_metadata_by_doc_id(self):
        """After add_chunks(), metadata["documents"] must be keyed by the chunk's doc_id."""
        vs = _make_testable_vs()
        vs.collection.count = MagicMock(return_value=1)

        chunk = _make_chunk(
            source="report.txt",
            doc_id="abc12345",
            source_path="/dir1/report.txt",
        )
        vs.add_chunks([chunk])

        assert "abc12345" in vs.metadata["documents"], (
            "metadata['documents'] must be keyed by doc_id, not basename"
        )
        assert "report.txt" not in vs.metadata["documents"], (
            "metadata['documents'] must NOT be keyed by the bare filename"
        )

    def test_two_same_basename_files_produce_two_metadata_entries(self):
        """Two report.txt files in different dirs must produce separate metadata entries."""
        from document_processor import DocumentProcessor

        vs = _make_testable_vs()
        vs.collection.count = MagicMock(return_value=2)

        with tempfile.TemporaryDirectory() as tmp:
            dir1 = Path(tmp) / "dirA"
            dir2 = Path(tmp) / "dirB"
            dir1.mkdir()
            dir2.mkdir()
            f1 = dir1 / "report.txt"
            f2 = dir2 / "report.txt"
            f1.write_text("Content from directory A.")
            f2.write_text("Content from directory B.")

            proc = DocumentProcessor(chunk_size=50, chunk_overlap=0)
            chunks1 = proc.process_file(str(f1))
            chunks2 = proc.process_file(str(f2))

        assert chunks1 and chunks2
        id1 = chunks1[0].doc_id
        id2 = chunks2[0].doc_id
        assert id1 != id2, "Different-dir report.txt files must yield different doc_ids"

        vs.add_chunks(chunks1 + chunks2)

        docs = vs.metadata["documents"]
        assert len(docs) == 2, (
            f"Two different report.txt files must produce 2 metadata entries, "
            f"got {len(docs)}: {list(docs.keys())}"
        )
        assert id1 in docs and id2 in docs

    def test_delete_one_doc_id_does_not_delete_the_other(self):
        """Deleting doc_id A must leave doc_id B untouched in metadata and Chroma."""
        vs = _make_testable_vs()
        vs.collection.count = MagicMock(return_value=1)

        vs.metadata["documents"] = {
            "aaa00001": {
                "doc_id": "aaa00001",
                "source_display": "report.txt",
                "source_path": "/dirA/report.txt",
                "chunks": 2,
                "added_at": "",
            },
            "bbb00002": {
                "doc_id": "bbb00002",
                "source_display": "report.txt",
                "source_path": "/dirB/report.txt",
                "chunks": 3,
                "added_at": "",
            },
        }
        vs.metadata["document_count"] = 2
        vs.metadata["chunk_count"] = 5
        vs._save_metadata = MagicMock()

        result = vs.delete_document("aaa00001")

        assert result is True, "delete_document should return True for an existing doc_id"
        assert "aaa00001" not in vs.metadata["documents"], "aaa00001 must be removed"
        assert "bbb00002" in vs.metadata["documents"], (
            "bbb00002 must remain — deleting aaa00001 must not affect bbb00002"
        )

    def test_delete_uses_doc_id_field_for_chroma(self):
        """delete_document must issue Chroma delete by doc_id metadata field for new-style entries."""
        vs = _make_testable_vs()
        vs.collection.count = MagicMock(return_value=0)
        vs._save_metadata = MagicMock()

        vs.metadata["documents"] = {
            "abc12345": {
                "doc_id": "abc12345",
                "source_display": "report.txt",
                "source_path": "/dirA/report.txt",
                "chunks": 1,
                "added_at": "",
            }
        }
        vs.metadata["document_count"] = 1

        vs.delete_document("abc12345")

        assert vs.collection.delete.called, "collection.delete() must be called"
        delete_kwargs = vs.collection.delete.call_args[1]
        where_arg = delete_kwargs.get("where")
        assert where_arg is not None, "collection.delete() must receive a 'where' kwarg"
        assert "doc_id" in where_arg, (
            f"Chroma delete must filter by 'doc_id', got where={where_arg}"
        )
        assert where_arg["doc_id"] == "abc12345"

    def test_get_all_documents_returns_id_field(self):
        """get_all_documents() must return dicts with 'id' equal to doc_id."""
        vs = _make_testable_vs()
        vs.metadata["documents"] = {
            "abc12345": {
                "doc_id": "abc12345",
                "source_display": "my_doc.txt",
                "source_path": "/some/path/my_doc.txt",
                "chunks": 5,
                "added_at": "2026-01-01",
            }
        }

        docs = vs.get_all_documents()

        assert len(docs) == 1
        d = docs[0]
        assert d["id"] == "abc12345", "get_all_documents must return 'id' equal to doc_id"
        assert d["source_display"] == "my_doc.txt"
        assert d["source_path"] == "/some/path/my_doc.txt"
        assert d["chunks"] == 5
        assert d["added_at"] == "2026-01-01"

    def test_load_metadata_migrates_legacy_entries(self):
        """_load_metadata() must upgrade old source-keyed entries to new format."""
        from vector_store import VectorStore

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp)
            metadata_path = db_path / VectorStore.METADATA_FILE

            legacy = {
                "document_count": 1,
                "chunk_count": 3,
                "documents": {
                    "old_report.txt": {"chunks": 3, "added_at": "2025-01-01"},
                },
            }
            metadata_path.write_text(json.dumps(legacy))

            class BareVS(VectorStore):
                def __init__(self):
                    pass

            bvs = BareVS()
            bvs.db_path = db_path
            bvs._load_metadata()

            entry = bvs.metadata["documents"].get("old_report.txt")
            assert entry is not None, "Legacy key must still exist after migration"
            assert isinstance(entry, dict), "Legacy entry must be upgraded to dict"
            assert "source_display" in entry, "Migrated entry must have source_display"
            assert "doc_id" in entry, "Migrated entry must have doc_id"
            assert entry["chunks"] == 3, "chunks must be preserved after migration"

    def test_get_all_documents_handles_legacy_entries(self):
        """get_all_documents() must work with already-migrated legacy entries."""
        vs = _make_testable_vs()
        vs.metadata["documents"] = {
            "old_file.txt": {
                "doc_id": "old_file.txt",
                "source_display": "old_file.txt",
                "source_path": "old_file.txt",
                "chunks": 2,
                "added_at": "2025-01-01",
            }
        }

        docs = vs.get_all_documents()
        assert len(docs) == 1
        assert docs[0]["id"] == "old_file.txt"


# ---------------------------------------------------------------------------
# C2: QueryResult.retrieved_chunks reflects final context
# ---------------------------------------------------------------------------

class TestC2RetrievedChunksFinalContext:
    """retrieved_chunks must reflect the chunks actually sent to the LLM."""

    def test_chunk_details_built_from_final_chunks_with_scores(self):
        """query() source must build chunk_details from final_chunks_with_scores."""
        import inspect
        import rag_engine
        src = inspect.getsource(rag_engine.RAGEngine.query)

        assert "final_chunks_with_scores" in src, (
            "query() must track final_chunks_with_scores"
        )
        assert "chunk_details" in src, "query() must build chunk_details"

        # final_chunks_with_scores must be assigned before chunk_details uses it
        fcs_idx = src.index("final_chunks_with_scores")
        cd_idx = src.index("chunk_details")
        assert fcs_idx < cd_idx, (
            "final_chunks_with_scores must be assigned before chunk_details references it"
        )

    def test_non_rerank_path_populates_final_chunks_with_scores(self):
        """Non-reranking path must assign final_chunks_with_scores with None scores."""
        import inspect
        import rag_engine
        src = inspect.getsource(rag_engine.RAGEngine.query)
        assert "final_chunks_with_scores = [(chunk, None)" in src, (
            "Non-reranking path must assign final_chunks_with_scores with None scores"
        )

    def test_rerank_path_populates_final_chunks_with_scores(self):
        """Reranking path must assign final_chunks_with_scores from (chunk, score) pairs."""
        import inspect
        import rag_engine
        src = inspect.getsource(rag_engine.RAGEngine.query)
        assert "final_chunks_with_scores = [(chunk, score)" in src, (
            "Reranking path must assign final_chunks_with_scores from reranked (chunk, score) pairs"
        )

    def test_retrieved_chunks_count_matches_chunks_retrieved(self):
        """retrieved_chunks list length must equal chunks_retrieved in QueryResult."""
        from rag_engine import RAGEngine, RAGConfig, QueryResult
        from document_processor import DocumentChunk

        config = RAGConfig(n_results=2, reranking_enabled=False, initial_retrieval_top_k=10)

        # 5 chunks retrieved, but n_results=2 → final should be 2
        chunks = [
            DocumentChunk(text=f"chunk {i}", source="doc.txt", chunk_index=i)
            for i in range(5)
        ]
        for c in chunks:
            c.doc_id = "aaa00001"
            c.source_path = "/docs/doc.txt"

        mock_vs = MagicMock()
        mock_vs.get_context = MagicMock(return_value=(
            "\n\n---\n\n".join(c.text for c in chunks),
            ["doc.txt"],
            chunks,
        ))
        mock_vs.get_stats = MagicMock(return_value={"document_count": 1, "chunk_count": 5})

        mock_llm = MagicMock()
        mock_llm.answer_question = MagicMock(return_value="The answer.")

        engine = object.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.query_transformer = None
        engine.conversation_history = []

        result = engine.query("What is chunk 1?")

        assert isinstance(result, QueryResult)
        assert result.retrieved_chunks is not None, "retrieved_chunks must not be None"
        assert len(result.retrieved_chunks) == result.chunks_retrieved, (
            f"retrieved_chunks length ({len(result.retrieved_chunks)}) must equal "
            f"chunks_retrieved ({result.chunks_retrieved})"
        )
        assert len(result.retrieved_chunks) == 2, (
            f"With n_results=2 and 5 retrieved, expected 2 final chunks, "
            f"got {len(result.retrieved_chunks)}"
        )

    def test_retrieved_chunk_dict_has_required_fields(self):
        """Each retrieved_chunks entry must include the required fields."""
        from rag_engine import RAGEngine, RAGConfig
        from document_processor import DocumentChunk

        config = RAGConfig(n_results=1, reranking_enabled=False, initial_retrieval_top_k=4)

        chunk = DocumentChunk(text="hello world", source="doc.txt", chunk_index=0, page=1)
        chunk.doc_id = "aaa00001"
        chunk.source_path = "/docs/doc.txt"

        mock_vs = MagicMock()
        mock_vs.get_context = MagicMock(return_value=("hello world", ["doc.txt"], [chunk]))
        mock_vs.get_stats = MagicMock(return_value={"document_count": 1, "chunk_count": 1})

        mock_llm = MagicMock()
        mock_llm.answer_question = MagicMock(return_value="hello")

        engine = object.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.query_transformer = None
        engine.conversation_history = []

        result = engine.query("What does the document cover?")

        assert result.retrieved_chunks and len(result.retrieved_chunks) == 1
        d = result.retrieved_chunks[0]
        for field in ("source_display", "doc_id", "source_path", "page", "chunk_index", "snippet"):
            assert field in d, (
                f"retrieved_chunks entry must have '{field}' field, got: {list(d.keys())}"
            )
        assert d["doc_id"] == "aaa00001"
        assert d["source_path"] == "/docs/doc.txt"
        assert "hello" in d["snippet"]

    def test_no_context_path_has_empty_retrieved_chunks(self):
        """When no context is found, retrieved_chunks should be empty or None."""
        from rag_engine import RAGEngine, RAGConfig, QueryResult

        config = RAGConfig(n_results=4, reranking_enabled=False)

        mock_vs = MagicMock()
        mock_vs.get_context = MagicMock(return_value=("", [], []))
        mock_vs.get_stats = MagicMock(return_value={"document_count": 0, "chunk_count": 0})

        mock_llm = MagicMock()

        engine = object.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.query_transformer = None
        engine.conversation_history = []

        result = engine.query("anything?")

        assert isinstance(result, QueryResult)
        assert result.retrieved_chunks is None or result.retrieved_chunks == [], (
            "No-context path must produce None or [] for retrieved_chunks"
        )


# ---------------------------------------------------------------------------
# C3: Normalize GUI settings to canonical keys
# ---------------------------------------------------------------------------

def _import_app_gui_symbols():
    """Import normalize_settings and inspection targets from app_gui, stubbing GUI deps."""
    import app_gui
    return app_gui


class TestC3NormalizeGuiSettings:
    """normalize_settings() must migrate rag_* keys; SettingsDialog uses canonical keys."""

    def test_normalize_settings_migrates_rag_chunk_overlap(self):
        m = _import_app_gui_symbols()
        result = m.normalize_settings({"rag_chunk_overlap": 200})
        assert result.get("chunk_overlap") == 200
        assert "rag_chunk_overlap" not in result

    def test_normalize_settings_migrates_rag_min_similarity(self):
        m = _import_app_gui_symbols()
        result = m.normalize_settings({"rag_min_similarity": 0.65})
        assert result.get("min_similarity") == 0.65
        assert "rag_min_similarity" not in result

    def test_normalize_settings_migrates_rag_context_truncation(self):
        m = _import_app_gui_symbols()
        result = m.normalize_settings({"rag_context_truncation": 12000})
        assert result.get("context_truncation") == 12000
        assert "rag_context_truncation" not in result

    def test_normalize_settings_migrates_rag_db_path(self):
        m = _import_app_gui_symbols()
        result = m.normalize_settings({"rag_db_path": "/tmp/mydb"})
        assert result.get("db_path") == "/tmp/mydb"
        assert "rag_db_path" not in result

    def test_canonical_key_takes_precedence_over_legacy(self):
        """When both canonical and rag_-prefixed key are present, canonical wins."""
        m = _import_app_gui_symbols()
        result = m.normalize_settings({"chunk_overlap": 100, "rag_chunk_overlap": 999})
        assert result["chunk_overlap"] == 100, "Canonical key must win over rag_-prefixed"
        assert "rag_chunk_overlap" not in result

    def test_old_settings_file_migrates_all_legacy_keys(self):
        """A settings dict from an old file with rag_* keys must fully migrate."""
        m = _import_app_gui_symbols()

        old_settings = {
            "chunk_size": 512,
            "rag_chunk_overlap": 100,
            "rag_min_similarity": 0.3,
            "rag_context_truncation": 20000,
            "rag_db_path": "./legacy_db",
        }
        result = m.normalize_settings(old_settings)

        assert result["chunk_overlap"] == 100
        assert result["min_similarity"] == 0.3
        assert result["context_truncation"] == 20000
        assert result["db_path"] == "./legacy_db"
        assert result["chunk_size"] == 512

        for key in ("rag_chunk_overlap", "rag_min_similarity", "rag_context_truncation", "rag_db_path"):
            assert key not in result, f"Legacy key '{key}' must be removed"

    def test_load_settings_calls_normalize(self):
        """_load_settings() source must call normalize_settings()."""
        import inspect
        import app_gui
        src = inspect.getsource(app_gui.DocumentQAApp._load_settings)
        assert "normalize_settings" in src, (
            "_load_settings() must call normalize_settings() to migrate legacy rag_* keys"
        )

    def test_settings_dialog_populate_reads_canonical_db_path(self):
        """SettingsDialog._populate_fields() must read 'db_path', not 'rag_db_path'."""
        import inspect
        import app_gui
        src = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        assert '"db_path"' in src or "'db_path'" in src, (
            "_populate_fields() must read canonical 'db_path'"
        )
        assert "rag_db_path" not in src, (
            "_populate_fields() must NOT reference legacy 'rag_db_path'"
        )

    def test_settings_dialog_populate_reads_canonical_chunk_overlap(self):
        """SettingsDialog._populate_fields() must read 'chunk_overlap', not 'rag_chunk_overlap'."""
        import inspect
        import app_gui
        src = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        assert '"chunk_overlap"' in src or "'chunk_overlap'" in src, (
            "_populate_fields() must read canonical 'chunk_overlap'"
        )
        assert "rag_chunk_overlap" not in src, (
            "_populate_fields() must NOT reference legacy 'rag_chunk_overlap'"
        )

    def test_settings_dialog_save_writes_canonical_keys(self):
        """SettingsDialog._save() must write canonical keys, not rag_* keys."""
        import inspect
        import app_gui
        src = inspect.getsource(app_gui.SettingsDialog._save)

        for legacy_key in ("rag_chunk_overlap", "rag_min_similarity", "rag_context_truncation", "rag_db_path"):
            assert legacy_key not in src, (
                f"SettingsDialog._save() must NOT write legacy key '{legacy_key}'"
            )

        for canonical_key in ("chunk_overlap", "min_similarity", "context_truncation", "db_path"):
            assert f'"{canonical_key}"' in src or f"'{canonical_key}'" in src, (
                f"SettingsDialog._save() must write canonical key '{canonical_key}'"
            )

    def test_normalize_settings_is_idempotent(self):
        """Calling normalize_settings() twice must produce the same result."""
        m = _import_app_gui_symbols()
        settings = {"rag_chunk_overlap": 50, "chunk_size": 512}
        once = m.normalize_settings(settings)
        twice = m.normalize_settings(once)
        assert once == twice, "normalize_settings() must be idempotent"

    def test_normalize_settings_does_not_mutate_input(self):
        """normalize_settings() must return a new dict, not mutate the input."""
        m = _import_app_gui_symbols()
        original = {"rag_db_path": "/tmp/db", "chunk_size": 512}
        copy_before = dict(original)
        m.normalize_settings(original)
        assert original == copy_before, "normalize_settings() must not mutate the input dict"

    def test_load_settings_legacy_file_value_overrides_default(self):
        """File value under rag_* key must override code default, not be silently discarded.

        Regression: if defaults have chunk_overlap=100 and the saved file has
        rag_chunk_overlap=200, the final settings must have chunk_overlap=200,
        NOT 100 (the default). The bug would be normalize_settings() seeing both
        canonical+legacy and preferring canonical (the code default), discarding
        the user's saved value.
        """
        import json as _json
        import app_gui

        settings_with_legacy = {
            "chunk_size": 512,
            "rag_chunk_overlap": 200,   # user saved non-default value under legacy key
            "rag_min_similarity": 0.7,  # user saved non-default value under legacy key
            "n_results": 4,
            "max_tokens": 512,
            "temperature": 0.3,
        }

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            _json.dump(settings_with_legacy, f)
            settings_path = f.name

        try:
            # Patch _get_settings_path to return our temp file
            with patch.object(app_gui.DocumentQAApp, "_get_settings_path", return_value=settings_path), \
                 patch.object(app_gui.DocumentQAApp, "__init__", lambda self: None):
                app = app_gui.DocumentQAApp.__new__(app_gui.DocumentQAApp)
                result = app._load_settings()

            assert result.get("chunk_overlap") == 200, (
                f"File value 200 must win over code default 100, got {result.get('chunk_overlap')}"
            )
            assert result.get("min_similarity") == 0.7, (
                f"File value 0.7 must win over code default 0.3, got {result.get('min_similarity')}"
            )
            assert "rag_chunk_overlap" not in result
            assert "rag_min_similarity" not in result
        finally:
            os.unlink(settings_path)


# ---------------------------------------------------------------------------
# Edge cases: C1 delete_document backward-compat, C2 reranking path
# ---------------------------------------------------------------------------

class TestC1EdgeCases:
    """Additional edge cases for document identity end-to-end."""

    def test_delete_document_backward_compat_source_keyed_entry(self):
        """delete_document(source_name) must work for legacy source-keyed metadata entries."""
        vs = _make_testable_vs()
        vs.collection.count = MagicMock(return_value=0)
        vs._save_metadata = MagicMock()

        # Legacy-style metadata: key IS the source/filename, doc_id == source_display
        vs.metadata["documents"] = {
            "old_report.txt": {
                "doc_id": "old_report.txt",
                "source_display": "old_report.txt",
                "source_path": "old_report.txt",
                "chunks": 3,
                "added_at": "2025-01-01",
            }
        }
        vs.metadata["document_count"] = 1

        result = vs.delete_document("old_report.txt")

        assert result is True, "delete_document must work for legacy source-keyed entries"
        assert "old_report.txt" not in vs.metadata["documents"], (
            "Legacy entry must be removed from metadata"
        )

    def test_delete_document_basename_fallback(self):
        """delete_document('/full/path/report.txt') must find metadata keyed by basename."""
        vs = _make_testable_vs()
        vs.collection.count = MagicMock(return_value=0)
        vs._save_metadata = MagicMock()

        # Legacy metadata keyed by basename only
        vs.metadata["documents"] = {
            "report.txt": {
                "doc_id": "report.txt",
                "source_display": "report.txt",
                "source_path": "report.txt",
                "chunks": 2,
                "added_at": "",
            }
        }
        vs.metadata["document_count"] = 1

        # Pass the full path — should resolve via basename fallback
        result = vs.delete_document("/some/path/report.txt")

        assert result is True, (
            "delete_document must resolve full paths via basename fallback for legacy entries"
        )
        assert "report.txt" not in vs.metadata["documents"]

    def test_delete_nonexistent_returns_false(self):
        """delete_document with unknown id must return False without raising."""
        vs = _make_testable_vs()
        vs._save_metadata = MagicMock()
        vs.metadata["documents"] = {}

        result = vs.delete_document("does_not_exist")
        assert result is False, "delete_document must return False for unknown doc_id"

    def test_get_all_documents_empty_store(self):
        """get_all_documents() on empty store must return empty list."""
        vs = _make_testable_vs()
        vs.metadata["documents"] = {}
        docs = vs.get_all_documents()
        assert docs == [], "get_all_documents() on empty store must return []"

    def test_from_dict_db_path_none_resolves_lazily(self):
        """RAGConfig.from_dict() with missing db_path must not eagerly evaluate app_paths."""
        from rag_engine import RAGConfig
        import app_paths

        call_count = [0]
        original = app_paths.get_vector_db_path

        def counting_get_vector_db_path():
            call_count[0] += 1
            return original()

        app_paths.get_vector_db_path = counting_get_vector_db_path
        try:
            before = call_count[0]
            # from_dict without db_path should pass None to __init__, not eagerly resolve
            config = RAGConfig.from_dict({"chunk_size": 512})
            after = call_count[0]
            assert after - before <= 1, (
                "from_dict should call get_vector_db_path at most once (in __init__), "
                "not additionally in from_dict itself"
            )
            assert config.db_path is not None, "db_path must be resolved to a string after __init__"
        finally:
            app_paths.get_vector_db_path = original


class TestC2EdgeCases:
    """Additional edge cases for retrieved_chunks correctness."""

    def test_reranking_path_final_chunks_with_scores_from_reranked(self):
        """Reranking path: retrieved_chunks must come from reranked output, not all retrieved."""
        from rag_engine import RAGEngine, RAGConfig, QueryResult
        from document_processor import DocumentChunk

        config = RAGConfig(
            n_results=2,
            reranking_enabled=True,
            initial_retrieval_top_k=5,
            rerank_top_k=2,
        )

        # 5 chunks retrieved; reranker returns only 2
        all_chunks = [
            DocumentChunk(text=f"chunk {i} content", source="doc.txt", chunk_index=i)
            for i in range(5)
        ]
        for i, c in enumerate(all_chunks):
            c.doc_id = f"doc{i:04d}"
            c.source_path = "/docs/doc.txt"

        reranked_chunks = [(all_chunks[3], 0.9), (all_chunks[1], 0.7)]

        mock_vs = MagicMock()
        mock_vs.get_context = MagicMock(return_value=(
            " ".join(c.text for c in all_chunks),
            ["doc.txt"],
            all_chunks,
        ))
        mock_vs.get_stats = MagicMock(return_value={"document_count": 1, "chunk_count": 5})

        mock_reranker = MagicMock()
        mock_reranker.rerank = MagicMock(return_value=reranked_chunks)

        mock_llm = MagicMock()
        mock_llm.answer_question = MagicMock(return_value="Reranked answer.")

        engine = object.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = mock_reranker
        engine.query_transformer = None
        engine.conversation_history = []

        result = engine.query("What is in the document?")

        assert result.retrieved_chunks is not None
        assert len(result.retrieved_chunks) == 2, (
            f"Reranking path must produce 2 chunks (from reranker), got {len(result.retrieved_chunks)}"
        )
        assert result.chunks_retrieved == 2
        # Chunks must be the reranked ones (indices 3 and 1), not the original 5
        chunk_indices = [d["chunk_index"] for d in result.retrieved_chunks]
        assert 3 in chunk_indices, "Reranked top-1 (index 3) must appear in retrieved_chunks"
        assert 1 in chunk_indices, "Reranked top-2 (index 1) must appear in retrieved_chunks"
        # Scores must be present and correct
        scores = {d["chunk_index"]: d.get("score") for d in result.retrieved_chunks}
        assert scores.get(3) == pytest.approx(0.9), "Score must be passed through from reranker"
        assert scores.get(1) == pytest.approx(0.7)

    def test_reranker_init_failure_falls_back_to_top_k_not_empty(self):
        """When reranker init fails, retrieved_chunks must NOT be empty — must fall back to top-k.

        Regression for: reranking_enabled=True + reranker init failure leaves
        final_chunks_with_scores=[] so retrieved_chunks=[] even though chunks were retrieved.
        """
        from rag_engine import RAGEngine, RAGConfig, QueryResult
        from document_processor import DocumentChunk

        config = RAGConfig(
            n_results=2,
            reranking_enabled=True,  # reranking requested
            initial_retrieval_top_k=5,
            rerank_top_k=2,
        )

        chunks = [
            DocumentChunk(text=f"chunk {i} content", source="doc.txt", chunk_index=i)
            for i in range(3)
        ]
        for i, c in enumerate(chunks):
            c.doc_id = f"doc{i:04d}"
            c.source_path = "/docs/doc.txt"

        mock_vs = MagicMock()
        mock_vs.get_context = MagicMock(return_value=(
            " ".join(c.text for c in chunks),
            ["doc.txt"],
            chunks,
        ))
        mock_vs.get_stats = MagicMock(return_value={"document_count": 1, "chunk_count": 3})
        mock_llm = MagicMock()
        mock_llm.answer_question = MagicMock(return_value="Fallback answer.")

        # Simulate a reranker whose rerank() method raises (e.g., lazy model load fails)
        mock_reranker = MagicMock()
        mock_reranker.rerank = MagicMock(side_effect=RuntimeError("model not available"))

        engine = object.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = mock_reranker  # reranker exists but rerank() will raise
        engine.query_transformer = None
        engine.conversation_history = []

        result = engine.query("What does this document cover?")

        assert result.retrieved_chunks is not None, (
            "retrieved_chunks must not be None when reranker fails"
        )
        assert len(result.retrieved_chunks) > 0, (
            "retrieved_chunks must NOT be empty when reranker fails — must fall back to top-k"
        )
        assert len(result.retrieved_chunks) == result.chunks_retrieved, (
            "retrieved_chunks length must match chunks_retrieved even on reranker fallback"
        )

    def test_retrieved_chunks_not_present_on_no_context_result(self):
        """QueryResult from no-context path must not have a non-empty retrieved_chunks."""
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(n_results=4, reranking_enabled=False)
        mock_vs = MagicMock()
        mock_vs.get_context = MagicMock(return_value=(None, None, None))
        mock_vs.get_stats = MagicMock(return_value={"document_count": 0, "chunk_count": 0})
        mock_llm = MagicMock()

        engine = object.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.query_transformer = None
        engine.conversation_history = []

        result = engine.query("What is this about?")
        assert not result.retrieved_chunks, (
            "No-context path must not return non-empty retrieved_chunks"
        )
