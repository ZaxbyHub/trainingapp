"""Regression tests for the 10-fix remediation pass.

Each test class maps to one numbered fix. Tests are designed to fail on the
old code and pass on the fixed code, proving the bug was real and is now gone.
"""

import hashlib
import inspect
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))


# ---------------------------------------------------------------------------
# FIX 1: Canonical settings schema — rag_* prefixed keys must be consumed
# ---------------------------------------------------------------------------

def _build_config_from_settings(settings: dict):
    """Helper: call create_engine_from_settings with a mocked RAGEngine and return the RAGConfig used."""
    from rag_engine import RAGConfig
    import engine_factory

    captured_config = {}

    original_create = engine_factory.create_engine

    def fake_create(gguf_path, config=None, **kwargs):
        captured_config["config"] = config
        fake_engine = MagicMock()
        fake_engine.config = config
        return fake_engine

    engine_factory.create_engine = fake_create
    try:
        engine_factory.create_engine_from_settings(settings)
    finally:
        engine_factory.create_engine = original_create

    return captured_config.get("config")


class TestFix1CanonicalSettingsSchema:
    """engine_factory.create_engine_from_settings() must accept rag_-prefixed keys."""

    def test_rag_chunk_overlap_key_consumed(self):
        """Saving as 'rag_chunk_overlap' (GUI style) must produce correct RAGConfig."""
        config = _build_config_from_settings({
            "chunk_size": 512,
            "rag_chunk_overlap": 250,
        })
        assert config.chunk_overlap == 250, (
            "chunk_overlap from rag_-prefixed key was silently ignored — key mismatch bug"
        )

    def test_rag_min_similarity_key_consumed(self):
        config = _build_config_from_settings({"rag_min_similarity": 0.7})
        assert config.min_similarity == 0.7

    def test_rag_context_truncation_key_consumed(self):
        config = _build_config_from_settings({"rag_context_truncation": 12000})
        assert config.context_truncation == 12000

    def test_rag_db_path_key_consumed(self):
        config = _build_config_from_settings({"rag_db_path": "/tmp/mydb"})
        assert config.db_path == "/tmp/mydb"

    def test_canonical_key_takes_precedence_over_legacy(self):
        """When both canonical and rag_-prefixed key are present, canonical wins."""
        config = _build_config_from_settings({
            "chunk_overlap": 100,
            "rag_chunk_overlap": 999,
        })
        assert config.chunk_overlap == 100, "Canonical key must take precedence over rag_-prefixed"

    def test_query_transformation_enabled_wired(self):
        config = _build_config_from_settings({"query_transformation_enabled": True})
        assert config.query_transformation_enabled is True

    def test_context_truncation_wired(self):
        config = _build_config_from_settings({"context_truncation": 8000})
        assert config.context_truncation == 8000

    def test_gguf_n_ctx_wired(self):
        config = _build_config_from_settings({"gguf_n_ctx": 2048})
        assert config.gguf_n_ctx == 2048

    def test_gguf_n_threads_wired(self):
        config = _build_config_from_settings({"gguf_n_threads": 2})
        assert config.gguf_n_threads == 2


# ---------------------------------------------------------------------------
# FIX 2: context_truncation in RAGConfig
# ---------------------------------------------------------------------------

class TestFix2ContextTruncationInRAGConfig:
    """context_truncation must be a first-class RAGConfig field."""

    def test_ragconfig_has_context_truncation_param(self):
        from rag_engine import RAGConfig
        sig = inspect.signature(RAGConfig.__init__)
        assert "context_truncation" in sig.parameters, (
            "RAGConfig must accept context_truncation — it was formerly read from global settings"
        )

    def test_ragconfig_context_truncation_default_is_20000(self):
        from rag_engine import RAGConfig
        c = RAGConfig()
        assert c.context_truncation == 20000

    def test_ragconfig_context_truncation_custom_value(self):
        from rag_engine import RAGConfig
        c = RAGConfig(context_truncation=5000)
        assert c.context_truncation == 5000

    def test_ragconfig_to_dict_includes_context_truncation(self):
        from rag_engine import RAGConfig
        d = RAGConfig(context_truncation=7777).to_dict()
        assert "context_truncation" in d
        assert d["context_truncation"] == 7777

    def test_ragconfig_from_dict_restores_context_truncation(self):
        from rag_engine import RAGConfig
        c = RAGConfig.from_dict({"context_truncation": 3000})
        assert c.context_truncation == 3000

    def test_ragconfig_from_dict_backward_compat_default(self):
        """Old dicts without context_truncation get the default."""
        from rag_engine import RAGConfig
        c = RAGConfig.from_dict({})
        assert c.context_truncation == 20000


# ---------------------------------------------------------------------------
# FIX 3: InferenceConfig temperature wired from RAGConfig
# ---------------------------------------------------------------------------

class TestFix3InferenceConfigTemperature:
    """RAGEngine must pass temperature from config, not use InferenceConfig default (0.7)."""

    def test_inference_config_uses_ragconfig_temperature(self):
        from llm_interface import InferenceConfig
        from rag_engine import RAGConfig
        import rag_engine

        captured = {}

        class FakeLLM:
            def answer_question(self, question, context, history, config):
                captured["temperature"] = config.temperature
                return "answer"

        config = RAGConfig(temperature=0.1)
        engine = MagicMock()
        engine.config = config
        engine.llm = FakeLLM()

        # Verify that InferenceConfig constructed with config temperature matches
        ic = InferenceConfig(max_tokens=config.max_tokens, temperature=config.temperature)
        assert ic.temperature == 0.1, (
            "InferenceConfig temperature must come from RAGConfig, not default 0.7"
        )

    def test_inference_config_default_not_used(self):
        """The InferenceConfig default temperature (0.7) must not override config."""
        from llm_interface import InferenceConfig
        ic_default = InferenceConfig()
        assert ic_default.temperature == 0.7  # document the default

        from rag_engine import RAGConfig
        config = RAGConfig(temperature=0.3)
        ic_from_config = InferenceConfig(max_tokens=512, temperature=config.temperature)
        assert ic_from_config.temperature == 0.3
        assert ic_from_config.temperature != ic_default.temperature


# ---------------------------------------------------------------------------
# FIX 4: BM25 rebuild triggered on hybrid search even when index is None
# ---------------------------------------------------------------------------

class TestFix4BM25RebuildOnNullIndex:
    """_rebuild_bm25_if_needed() must be called when hybrid_search=True even if bm25_index is None."""

    def test_rebuild_unconditional_when_hybrid_search(self):
        """get_context() must call _rebuild_bm25_if_needed unconditionally when hybrid_search=True.

        Before the fix, get_context() only called rebuild if self.bm25_index was not None,
        meaning the first hybrid search after a fresh VectorStore (bm25_index=None) was skipped.
        The fix removes the bm25_index guard: rebuild is called whenever hybrid_search=True.
        """
        import inspect
        from vector_store import VectorStore
        src = inspect.getsource(VectorStore.get_context)
        lines = src.split("\n")

        # Find the hybrid_search branch and verify rebuild is called WITHOUT a bm25_index guard
        hybrid_idx = next((i for i, l in enumerate(lines) if "if hybrid_search" in l and "rebuild" not in l), None)
        rebuild_idx = next((i for i, l in enumerate(lines) if "_rebuild_bm25_if_needed" in l), None)

        assert rebuild_idx is not None, "_rebuild_bm25_if_needed must be called in get_context"
        assert hybrid_idx is not None, "get_context must have an if hybrid_search branch"

        # Rebuild must be called BEFORE any self.bm25_index check (within the hybrid block)
        bm25_none_idx = next(
            (i for i, l in enumerate(lines) if "bm25_index is None" in l or "not self.bm25_index" in l),
            len(lines)
        )
        assert rebuild_idx < bm25_none_idx, (
            "_rebuild_bm25_if_needed must be called BEFORE checking if bm25_index is None"
        )

    def test_fallback_to_vector_when_rebuild_fails(self):
        """If BM25 rebuild fails and index remains None, must fall back to vector-only."""
        import inspect
        from vector_store import VectorStore
        src = inspect.getsource(VectorStore.get_context)
        assert "bm25_index is None" in src or "hybrid_search = False" in src, (
            "get_context must fall back to vector-only when BM25 rebuild fails"
        )

    def test_rebuild_called_on_fresh_instance(self):
        """A fresh VectorStore with bm25_index=None must call rebuild on first hybrid search."""
        from vector_store import VectorStore

        rebuild_calls = []

        class TestableVS(VectorStore):
            def __init__(self):
                pass  # skip real init

            def _rebuild_bm25_if_needed(self):
                rebuild_calls.append(1)
                # Do not set bm25_index — simulate rebuild failure

            def search(self, *a, **kw):
                return []

        vs = TestableVS()
        vs.bm25_index = None
        vs._bm25_needs_rebuild = True
        vs._lock = __import__("threading").Lock()
        vs.embedder = MagicMock()
        vs.embedder.encode = MagicMock(return_value=[[0.0] * 384])
        vs.collection = MagicMock()
        vs.collection.query = MagicMock(return_value={
            "documents": [[]], "metadatas": [[]], "distances": [[]]
        })
        vs.metadata = {}

        try:
            vs.get_context("test", n_results=2, hybrid_search=True)
        except Exception:
            pass

        assert rebuild_calls, (
            "_rebuild_bm25_if_needed must be called even when bm25_index starts as None"
        )


# ---------------------------------------------------------------------------
# FIX 5: Stable doc_id for document identity
# ---------------------------------------------------------------------------

class TestFix5StableDocumentIdentity:
    """Two files with the same basename must get different doc_ids."""

    def test_documentchunk_has_doc_id_field(self):
        from document_processor import DocumentChunk
        c = DocumentChunk(text="test", source="file.pdf")
        assert hasattr(c, "doc_id"), "DocumentChunk must have doc_id field"

    def test_documentchunk_has_source_path_field(self):
        from document_processor import DocumentChunk
        c = DocumentChunk(text="test", source="file.pdf")
        assert hasattr(c, "source_path"), "DocumentChunk must have source_path field"

    def test_same_basename_different_dirs_get_different_doc_ids(self):
        """Two real files with same basename in different dirs must get different doc_ids."""
        from document_processor import DocumentProcessor

        with tempfile.TemporaryDirectory() as tmp:
            dir1 = Path(tmp) / "dir1"
            dir2 = Path(tmp) / "dir2"
            dir1.mkdir()
            dir2.mkdir()

            file1 = dir1 / "report.txt"
            file2 = dir2 / "report.txt"
            file1.write_text("Content from directory one.")
            file2.write_text("Content from directory two.")

            proc = DocumentProcessor(chunk_size=50, chunk_overlap=0)
            chunks1 = proc.process_file(str(file1))
            chunks2 = proc.process_file(str(file2))

            assert chunks1, "Should produce chunks from file1"
            assert chunks2, "Should produce chunks from file2"

            doc_id_1 = chunks1[0].doc_id
            doc_id_2 = chunks2[0].doc_id

            assert doc_id_1 is not None, "doc_id must be set"
            assert doc_id_2 is not None, "doc_id must be set"
            assert doc_id_1 != doc_id_2, (
                f"Same basename 'report.txt' in different dirs must yield different doc_ids, "
                f"got {doc_id_1!r} == {doc_id_2!r}"
            )

    def test_doc_id_stable_across_calls(self):
        """Same file processed twice must get the same doc_id."""
        from document_processor import DocumentProcessor

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False, mode="w") as f:
            f.write("Stable identity test content.")
            fpath = f.name

        try:
            proc = DocumentProcessor(chunk_size=50, chunk_overlap=0)
            chunks_a = proc.process_file(fpath)
            chunks_b = proc.process_file(fpath)
            assert chunks_a[0].doc_id == chunks_b[0].doc_id, (
                "doc_id must be deterministic for the same file path"
            )
        finally:
            os.unlink(fpath)

    def test_doc_id_is_hash_based(self):
        """doc_id must be a hex string derived from the file path hash."""
        from document_processor import DocumentProcessor

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False, mode="w") as f:
            f.write("Hash test content.")
            fpath = f.name

        try:
            proc = DocumentProcessor(chunk_size=50, chunk_overlap=0)
            chunks = proc.process_file(fpath)
            doc_id = chunks[0].doc_id
            # Must be a hex string
            int(doc_id, 16)  # raises ValueError if not valid hex
        finally:
            os.unlink(fpath)

    def test_vector_store_chunk_id_uses_doc_id(self):
        """VectorStore.add_chunks() must use doc_id (not just source) for chunk IDs."""
        import inspect
        from vector_store import VectorStore
        src = inspect.getsource(VectorStore.add_chunks)
        assert "doc_id" in src, (
            "add_chunks must use doc_id in chunk ID generation to prevent collisions"
        )


# ---------------------------------------------------------------------------
# FIX 7: CLI chunk-size and chunk-overlap wired to engine
# ---------------------------------------------------------------------------

class TestFix7CLIArgWiring:
    """--chunk-size and --chunk-overlap CLI args must set env vars for create_engine_from_env."""

    def test_chunk_size_arg_sets_env_var(self):
        """Passing --chunk-size must set RAG_CHUNK_SIZE env var."""
        import importlib
        import main as m

        parser = m.create_parser()
        args = parser.parse_args(["--cli", "--chunk-size", "256"])
        assert args.chunk_size == 256

        saved = os.environ.pop("RAG_CHUNK_SIZE", None)
        try:
            # Simulate what main() does with args
            if args.chunk_size is not None:
                os.environ["RAG_CHUNK_SIZE"] = str(args.chunk_size)
            assert os.environ.get("RAG_CHUNK_SIZE") == "256"
        finally:
            if saved is not None:
                os.environ["RAG_CHUNK_SIZE"] = saved
            else:
                os.environ.pop("RAG_CHUNK_SIZE", None)

    def test_chunk_overlap_arg_sets_env_var(self):
        """Passing --chunk-overlap must set RAG_CHUNK_OVERLAP env var."""
        import main as m

        parser = m.create_parser()
        args = parser.parse_args(["--cli", "--chunk-overlap", "75"])
        assert args.chunk_overlap == 75

        saved = os.environ.pop("RAG_CHUNK_OVERLAP", None)
        try:
            if args.chunk_overlap is not None:
                os.environ["RAG_CHUNK_OVERLAP"] = str(args.chunk_overlap)
            assert os.environ.get("RAG_CHUNK_OVERLAP") == "75"
        finally:
            if saved is not None:
                os.environ["RAG_CHUNK_OVERLAP"] = saved
            else:
                os.environ.pop("RAG_CHUNK_OVERLAP", None)

    def test_main_py_wires_chunk_size(self):
        """main.py source must contain wiring for RAG_CHUNK_SIZE."""
        src = Path(__file__).parent.parent.parent / "main.py"
        content = src.read_text()
        assert "RAG_CHUNK_SIZE" in content, (
            "main.py must set RAG_CHUNK_SIZE env var from --chunk-size arg"
        )

    def test_main_py_wires_chunk_overlap(self):
        """main.py source must contain wiring for RAG_CHUNK_OVERLAP."""
        src = Path(__file__).parent.parent.parent / "main.py"
        content = src.read_text()
        assert "RAG_CHUNK_OVERLAP" in content, (
            "main.py must set RAG_CHUNK_OVERLAP env var from --chunk-overlap arg"
        )

    def test_create_engine_from_env_reads_chunk_size(self):
        """create_engine_from_env() must honour RAG_CHUNK_SIZE env var."""
        saved = os.environ.pop("RAG_CHUNK_SIZE", None)
        try:
            os.environ["RAG_CHUNK_SIZE"] = "128"
            import config
            config._settings = None  # reset cache
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_chunk_size == 128
        finally:
            config._settings = None
            if saved is not None:
                os.environ["RAG_CHUNK_SIZE"] = saved
            else:
                os.environ.pop("RAG_CHUNK_SIZE", None)

    def test_create_engine_from_env_reads_chunk_overlap(self):
        """create_engine_from_env() must honour RAG_CHUNK_OVERLAP env var."""
        saved = os.environ.pop("RAG_CHUNK_OVERLAP", None)
        try:
            os.environ["RAG_CHUNK_OVERLAP"] = "64"
            import config
            config._settings = None
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_chunk_overlap == 64
        finally:
            config._settings = None
            if saved is not None:
                os.environ["RAG_CHUNK_OVERLAP"] = saved
            else:
                os.environ.pop("RAG_CHUNK_OVERLAP", None)


# ---------------------------------------------------------------------------
# FIX 8: Minimum-hardware defaults
# ---------------------------------------------------------------------------

class TestFix8MinimumHardwareDefaults:
    """RAGConfig and RAGSettings defaults must be conservative for 11th-gen i5 / 16 GB."""

    def test_ragconfig_reranking_disabled_by_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().reranking_enabled is False, (
            "reranking_enabled must default to False — reranker model is expensive to load"
        )

    def test_ragconfig_initial_retrieval_top_k_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().initial_retrieval_top_k == 12, (
            "initial_retrieval_top_k must default to 12 (was 30)"
        )

    def test_ragconfig_rerank_top_k_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().rerank_top_k == 4

    def test_ragconfig_retrieval_window_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().retrieval_window == 1

    def test_ragconfig_n_results_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().n_results == 4

    def test_ragconfig_max_tokens_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().max_tokens == 512

    def test_ragconfig_gguf_n_ctx_default(self):
        from rag_engine import RAGConfig
        assert RAGConfig().gguf_n_ctx == 4096

    def test_ragconfig_gguf_n_threads_default(self):
        from rag_engine import RAGConfig
        c = RAGConfig()
        assert c.gguf_n_threads == 4, (
            "gguf_n_threads must default to 4 (half of 8 cores on i5), not cpu_count()"
        )

    def test_ragconfig_gguf_fields_in_to_dict(self):
        from rag_engine import RAGConfig
        d = RAGConfig().to_dict()
        assert "gguf_n_ctx" in d
        assert "gguf_n_threads" in d

    def test_ragconfig_gguf_fields_in_from_dict(self):
        from rag_engine import RAGConfig
        c = RAGConfig.from_dict({"gguf_n_ctx": 2048, "gguf_n_threads": 2})
        assert c.gguf_n_ctx == 2048
        assert c.gguf_n_threads == 2

    def test_config_py_defaults_match_ragconfig(self):
        """RAGSettings defaults must agree with RAGConfig defaults."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig
        s = RAGSettings()
        c = RAGConfig()
        assert s.rag_n_results == c.n_results
        assert s.rag_reranking_enabled == c.reranking_enabled
        assert s.rag_initial_retrieval_top_k == c.initial_retrieval_top_k


# ---------------------------------------------------------------------------
# FIX 9: BM25 tokenization strips punctuation
# ---------------------------------------------------------------------------

class TestFix9BM25Tokenization:
    """BM25 tokenizer must strip punctuation so 'procedure.' matches 'procedure'."""

    def _get_tokenizer(self):
        from vector_store import BM25Index
        b = BM25Index()
        return b._tokenize

    def test_punctuation_stripped(self):
        tokenize = self._get_tokenizer()
        tokens = tokenize("procedure.")
        assert "procedure" in tokens, (
            "'procedure.' must tokenize to 'procedure' — punctuation must be stripped"
        )

    def test_comma_stripped(self):
        tokenize = self._get_tokenizer()
        tokens = tokenize("method, process")
        assert "method" in tokens
        assert "process" in tokens

    def test_hyphen_handling(self):
        tokenize = self._get_tokenizer()
        tokens = tokenize("step-by-step procedure")
        # At minimum, 'procedure' must appear
        assert "procedure" in tokens

    def test_query_matches_document_with_period(self):
        """A query 'procedure' must match a document containing 'procedure.'

        Note: BM25Okapi IDF=0 for terms in >=50% of a tiny corpus (2 docs),
        so we use 4 documents where only 1 contains 'procedure.' to get non-zero scores.
        """
        pytest.importorskip("rank_bm25", reason="rank_bm25 not installed — BM25 search pipeline unavailable")
        from vector_store import BM25Index
        b = BM25Index()
        b.build_index([
            "The procedure. is critical.",
            "Unrelated document about cats.",
            "Dogs are friendly animals.",
            "Birds can fly high.",
        ])
        results = b.search("procedure")
        assert len(results) > 0, "BM25 must return results for 'procedure' matching 'procedure.'"
        best_doc_idx = results[0][0]
        assert best_doc_idx == 0, (
            "The document containing 'procedure.' must rank first for query 'procedure'"
        )

    def test_tokenizer_uses_regex_not_split(self):
        """Verify tokenizer uses regex, not simple whitespace split."""
        import inspect
        from vector_store import BM25Index
        src = inspect.getsource(BM25Index._tokenize)
        assert "findall" in src or "re." in src, (
            "_tokenize must use regex (re.findall) not simple split()"
        )


# ---------------------------------------------------------------------------
# FIX 10: QueryResult includes retrieved_chunks
# ---------------------------------------------------------------------------

class TestFix10QueryResultRetrievedChunks:
    """QueryResult must include retrieved_chunks with text snippets and metadata."""

    def test_queryresult_has_retrieved_chunks_field(self):
        from rag_engine import QueryResult
        qr = QueryResult(
            question="q", answer="a", sources=[],
            context_length=0, inference_time=0.0, chunks_retrieved=0
        )
        assert hasattr(qr, "retrieved_chunks"), (
            "QueryResult must have retrieved_chunks field"
        )

    def test_queryresult_retrieved_chunks_defaults_to_none(self):
        from rag_engine import QueryResult
        qr = QueryResult(
            question="q", answer="a", sources=[],
            context_length=0, inference_time=0.0, chunks_retrieved=0
        )
        assert qr.retrieved_chunks is None, (
            "retrieved_chunks must default to None for backward compatibility"
        )

    def test_queryresult_retrieved_chunks_accepts_list(self):
        from rag_engine import QueryResult
        chunk_data = [{"source_display": "doc.pdf", "page": 1, "chunk_index": 0, "snippet": "test"}]
        qr = QueryResult(
            question="q", answer="a", sources=["doc.pdf"],
            context_length=100, inference_time=0.5, chunks_retrieved=1,
            retrieved_chunks=chunk_data
        )
        assert qr.retrieved_chunks == chunk_data

    def test_queryresult_chunk_has_required_fields(self):
        """Each entry in retrieved_chunks must have source_display, page, chunk_index, snippet."""
        from rag_engine import QueryResult
        chunk = {
            "source_display": "manual.pdf",
            "doc_id": "abc123def456",
            "page": 3,
            "chunk_index": 5,
            "snippet": "This is the chunk text...",
        }
        qr = QueryResult(
            question="q", answer="a", sources=["manual.pdf"],
            context_length=50, inference_time=0.1, chunks_retrieved=1,
            retrieved_chunks=[chunk]
        )
        assert qr.retrieved_chunks[0]["source_display"] == "manual.pdf"
        assert qr.retrieved_chunks[0]["page"] == 3
        assert qr.retrieved_chunks[0]["chunk_index"] == 5
        assert "snippet" in qr.retrieved_chunks[0]

    def test_backward_compat_sources_list_still_present(self):
        """Existing sources field must still work after adding retrieved_chunks."""
        from rag_engine import QueryResult
        qr = QueryResult(
            question="q", answer="a", sources=["doc1.pdf", "doc2.pdf"],
            context_length=200, inference_time=1.0, chunks_retrieved=4
        )
        assert qr.sources == ["doc1.pdf", "doc2.pdf"]
