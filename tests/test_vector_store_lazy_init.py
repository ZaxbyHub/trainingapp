"""
Tests for lazy initialization behavior in vector_store.py.

Verifies:
1. EmbeddingModel model is NOT loaded during __init__ (lazy loading)
2. EmbeddingModel model IS loaded on first encode() / encode_single() call
3. EmbeddingModel model is loaded only once across multiple encodes
4. STOP_WORDS is importable at module level
5. BM25 rebuild is deferred (not triggered during __init__)
6. _rebuild_bm25_if_needed() resets _bm25_needs_rebuild flag to False
7. _rebuild_bm25_if_needed() resets flag even on failure
8. _rebuild_bm25_if_needed() skips rebuild when flag is False
"""

import pytest
import threading
from unittest.mock import patch, MagicMock


class TestEmbeddingModelLazyLoad:
    """Tests for EmbeddingModel lazy initialization."""

    def test_embedding_model_not_loaded_during_init(self):
        """EmbeddingModel.__init__ should NOT load the SentenceTransformer model."""
        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.iterdir.return_value = ["config.json"]
            with patch("vector_store.Path", return_value=mock_path):
                from vector_store import EmbeddingModel

                em = EmbeddingModel()
                # Model must NOT be loaded during __init__
                assert em.model is None
                # SentenceTransformer must NOT be instantiated during __init__
                mock_st.assert_not_called()

    def test_embedding_model_loaded_on_encode(self):
        """SentenceTransformer should be loaded when encode() is first called."""
        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_st.return_value = MagicMock()
            mock_st.return_value.encode.return_value = MagicMock()
            mock_st.return_value.encode.return_value.tolist.return_value = [[0.1, 0.2, 0.3]]

            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.iterdir.return_value = ["config.json"]
            with patch("vector_store.Path", return_value=mock_path):
                from vector_store import EmbeddingModel

                em = EmbeddingModel()
                assert em.model is None

                em.encode(["test text"])

                mock_st.assert_called_once()
                assert em.model is not None

    def test_embedding_model_loads_once_for_multiple_encodes(self):
        """SentenceTransformer should be loaded only once even with multiple encode calls."""
        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_st.return_value = MagicMock()
            mock_st.return_value.encode.return_value = MagicMock()
            mock_st.return_value.encode.return_value.tolist.return_value = [[0.1]]

            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.iterdir.return_value = ["config.json"]
            with patch("vector_store.Path", return_value=mock_path):
                from vector_store import EmbeddingModel

                em = EmbeddingModel()

                em.encode(["test1"])
                em.encode(["test2"])
                em.encode_single("test3")

                # Should be called exactly once, not three times
                assert mock_st.call_count == 1

    def test_encode_single_triggers_lazy_load(self):
        """encode_single() should trigger lazy loading of the model."""
        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_result = MagicMock()
            mock_result.tolist.return_value = [0.1, 0.2, 0.3]
            mock_st.return_value = MagicMock()
            mock_st.return_value.encode.return_value = [mock_result]

            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.iterdir.return_value = ["config.json"]
            with patch("vector_store.Path", return_value=mock_path):
                from vector_store import EmbeddingModel

                em = EmbeddingModel()
                assert em.model is None

                result = em.encode_single("hello world")

                mock_st.assert_called_once()
                assert em.model is not None
                assert result == [0.1, 0.2, 0.3]


class TestStopWordsModuleLevel:
    """Tests for STOP_WORDS import at module level."""

    def test_stop_words_importable_from_module(self):
        """STOP_WORDS must be importable from the vector_store module."""
        import vector_store

        assert hasattr(vector_store, "STOP_WORDS")
        assert isinstance(vector_store.STOP_WORDS, set)
        # Should contain common English stop words
        assert "the" in vector_store.STOP_WORDS
        assert "and" in vector_store.STOP_WORDS
        assert "a" in vector_store.STOP_WORDS

    def test_stop_words_used_in_bm25_tokenize(self):
        """STOP_WORDS should be used in BM25Index._tokenize() to filter tokens."""
        from vector_store import BM25Index

        index = BM25Index()
        # "the" and "and" are stop words and should be filtered out
        tokens = index._tokenize("The quick and the fox")
        assert "the" not in tokens
        assert "and" not in tokens
        # "quick" and "fox" are NOT stop words and should remain
        assert "quick" in tokens
        assert "fox" in tokens


class TestBM25LazyRebuild:
    """Tests for BM25 lazy rebuild behavior in VectorStore."""

    def test_bm25_flag_not_triggered_during_init(self):
        """_bm25_needs_rebuild flag should be True but BM25Index NOT instantiated during __init__."""
        with patch("vector_store.chromadb") as mock_chroma:
            mock_client = MagicMock()
            mock_collection = MagicMock()
            mock_collection.count.return_value = 100
            mock_client.get_or_create_collection.return_value = mock_collection
            mock_chroma.PersistentClient.return_value = mock_client
            mock_chroma.Settings = MagicMock()

            with patch("vector_store.BM25Index") as mock_bm25_cls:
                mock_path_instance = MagicMock()
                mock_path_instance.exists.return_value = True
                mock_path_instance.mkdir.return_value = None
                with patch("vector_store.Path", return_value=mock_path_instance):
                    with patch("builtins.open", MagicMock()):
                        with patch("json.load", return_value={"chunk_count": 100, "document_count": 5, "documents": {}}):
                            from vector_store import VectorStore

                            vs = VectorStore(db_path="./test_db")

                            # Flag should be True (chunk_count > 0)
                            assert vs._bm25_needs_rebuild is True
                            # BM25Index must NOT be instantiated during __init__
                            mock_bm25_cls.assert_not_called()
                            # bm25_index must be None
                            assert vs.bm25_index is None

    def test_bm25_rebuild_resets_flag_on_success(self):
        """_rebuild_bm25_if_needed() should reset _bm25_needs_rebuild to False after success."""
        from vector_store import VectorStore

        mock_collection = MagicMock()
        mock_collection.get.return_value = {
            "documents": ["test document text here"],
            "metadatas": [{"source": "src.txt", "chunk_index": 0}],
        }

        with patch("vector_store.BM25Index") as mock_bm25_cls:
            mock_bm25_instance = MagicMock()
            mock_bm25_cls.return_value = mock_bm25_instance

            vs = VectorStore.__new__(VectorStore)
            vs._lock = threading.RLock()
            vs.bm25_index = None
            vs._bm25_needs_rebuild = True
            vs.collection = mock_collection
            vs.metadata = {}

            vs._rebuild_bm25_if_needed()

            assert vs._bm25_needs_rebuild is False
            mock_bm25_cls.assert_called_once()
            mock_bm25_instance.build_index.assert_called_once()
            assert vs.bm25_index is not None

    def test_bm25_rebuild_resets_flag_on_failure(self):
        """_rebuild_bm25_if_needed() should reset flag even when rebuild fails."""
        from vector_store import VectorStore

        mock_collection = MagicMock()
        mock_collection.get.side_effect = Exception("DB connection error")

        vs = VectorStore.__new__(VectorStore)
        vs._lock = threading.RLock()
        vs.bm25_index = None
        vs._bm25_needs_rebuild = True
        vs.collection = mock_collection
        vs.metadata = {}

        vs._rebuild_bm25_if_needed()

        # Flag MUST be reset even on failure
        assert vs._bm25_needs_rebuild is False
        # bm25_index must remain None on failure
        assert vs.bm25_index is None

    def test_bm25_rebuild_skipped_when_flag_false(self):
        """_rebuild_bm25_if_needed() should skip rebuild when flag is False."""
        from vector_store import VectorStore

        with patch("vector_store.BM25Index") as mock_bm25_cls:
            vs = VectorStore.__new__(VectorStore)
            vs._lock = threading.RLock()
            vs.bm25_index = None
            vs._bm25_needs_rebuild = False

            vs._rebuild_bm25_if_needed()

            mock_bm25_cls.assert_not_called()
            assert vs.bm25_index is None

    def test_bm25_flag_set_based_on_chunk_count(self):
        """_bm25_needs_rebuild should be True when chunk_count > 0, False otherwise."""
        with patch("vector_store.chromadb") as mock_chroma:
            mock_client = MagicMock()
            mock_chroma.PersistentClient.return_value = mock_client
            mock_chroma.Settings = MagicMock()

            # Test chunk_count == 0 → flag should be False
            mock_collection_zero = MagicMock()
            mock_collection_zero.count.return_value = 0
            mock_client.get_or_create_collection.return_value = mock_collection_zero

            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = False
            mock_path_instance.mkdir.return_value = None
            with patch("vector_store.Path", return_value=mock_path_instance):
                with patch("builtins.open", MagicMock()):
                    with patch("json.load", return_value={"chunk_count": 0, "document_count": 0, "documents": {}}):
                        from vector_store import VectorStore

                        vs = VectorStore(db_path="./test_empty_db")
                        assert vs._bm25_needs_rebuild is False

            # Test chunk_count > 0 → flag should be True
            mock_collection_nonzero = MagicMock()
            mock_collection_nonzero.count.return_value = 50
            mock_client.get_or_create_collection.return_value = mock_collection_nonzero

            with patch("vector_store.Path", return_value=mock_path_instance):
                with patch("builtins.open", MagicMock()):
                    with patch("json.load", return_value={"chunk_count": 50, "document_count": 2, "documents": {}}):
                        vs2 = VectorStore(db_path="./test_nonzero_db")
                        assert vs2._bm25_needs_rebuild is True


class TestEmbeddingModelEncodeContracts:
    """Tests for EmbeddingModel encode return value contracts."""

    def test_encode_returns_list_of_lists(self):
        """encode() must return List[List[float]], not nested np.array."""
        with patch("vector_store.SentenceTransformer") as mock_st:
            # encode() returns a numpy array, so .tolist() is called on it
            mock_st.return_value = MagicMock()
            mock_st.return_value.encode.return_value = MagicMock()
            mock_st.return_value.encode.return_value.tolist.return_value = [
                [0.1, 0.2, 0.3],
                [0.4, 0.5, 0.6],
            ]

            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.iterdir.return_value = ["config.json"]
            with patch("vector_store.Path", return_value=mock_path):
                from vector_store import EmbeddingModel

                em = EmbeddingModel()
                result = em.encode(["text1", "text2"])

                assert isinstance(result, list)
                assert len(result) == 2
                assert isinstance(result[0], list)
                assert isinstance(result[0][0], float)
                assert result[0] == [0.1, 0.2, 0.3]
                assert result[1] == [0.4, 0.5, 0.6]

    def test_encode_single_returns_list(self):
        """encode_single() must return List[float], not np.array."""
        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_embedding = MagicMock()
            mock_embedding.tolist.return_value = [0.1, 0.2, 0.3]
            mock_st.return_value = MagicMock()
            mock_st.return_value.encode.return_value = [mock_embedding]

            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.iterdir.return_value = ["config.json"]
            with patch("vector_store.Path", return_value=mock_path):
                from vector_store import EmbeddingModel

                em = EmbeddingModel()
                result = em.encode_single("single text")

                assert isinstance(result, list)
                assert isinstance(result[0], float)
                assert result == [0.1, 0.2, 0.3]
