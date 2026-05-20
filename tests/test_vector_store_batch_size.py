"""
Tests for batch_size parameter fix in vector_store.py

Tests the acceptance criteria:
1. encode() accepts batch_size parameter and passes through to SentenceTransformer
2. encode_single() does NOT accept batch_size parameter (not needed for single text)
3. add_chunks() accepts chunk_batch_size and embed_batch_size as separate parameters
4. chunk_batch_size controls loop iteration, embed_batch_size passed to embedder
5. Default embed_batch_size=None preserves backward compatibility

Bug: Previous tests incorrectly assumed encode_single() accepts batch_size and that
add_chunks() uses a single 'batch_size' parameter. The correct API uses separate
'chunk_batch_size' (loop control) and 'embed_batch_size' (passed to embedder).
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
import sys
import inspect


class TestEmbeddingModelEncodeBatchSize:
    """Tests for batch_size parameter in EmbeddingModel.encode()."""

    def test_encode_accepts_batch_size_parameter(self):
        """Test: encode() accepts batch_size parameter and passes through to SentenceTransformer."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model
            import numpy as np
            mock_model.encode.return_value = np.array([[0.1, 0.2, 0.3]])

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            texts = ["hello world"]
            result = embedder.encode(texts, batch_size=32)

            # Verify encode was called with batch_size in kwargs
            call_kwargs = mock_model.encode.call_args
            assert call_kwargs is not None
            _, kwargs = call_kwargs
            assert "batch_size" in kwargs, "batch_size should be passed to model.encode()"
            assert kwargs["batch_size"] == 32, "batch_size value should be 32"

    def test_encode_batch_size_none_not_passed(self):
        """Test: encode() with batch_size=None does not pass batch_size to model."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model
            import numpy as np
            mock_model.encode.return_value = np.array([[0.1, 0.2, 0.3]])

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            texts = ["hello world"]
            result = embedder.encode(texts, batch_size=None)

            # When batch_size is None, it should NOT be in kwargs
            call_kwargs = mock_model.encode.call_args
            _, kwargs = call_kwargs
            assert "batch_size" not in kwargs, "batch_size should not be passed when None"

    def test_encode_default_batch_size_none(self):
        """Test: encode() without batch_size parameter uses default None (backward compatible)."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model
            import numpy as np
            mock_model.encode.return_value = np.array([[0.1, 0.2, 0.3]])

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            texts = ["hello world"]
            result = embedder.encode(texts)

            # Default is None, so batch_size should NOT be in kwargs
            call_kwargs = mock_model.encode.call_args
            _, kwargs = call_kwargs
            assert "batch_size" not in kwargs, "batch_size should not be passed by default"

    def test_encode_signature_has_batch_size_parameter(self):
        """Test: encode() signature includes batch_size parameter."""
        from vector_store import EmbeddingModel

        sig = inspect.signature(EmbeddingModel.encode)
        params = list(sig.parameters.keys())
        assert "batch_size" in params, "encode() should have batch_size parameter"

    def test_batch_size_value_actually_used_by_model(self):
        """Test: Custom batch_size value is actually used by the underlying model."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model
            import numpy as np
            mock_model.encode.return_value = np.array([[0.1, 0.2, 0.3]])

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            texts = ["text1", "text2", "text3"]
            custom_batch_size = 47

            embedder.encode(texts, batch_size=custom_batch_size)

            call_args, call_kwargs = mock_model.encode.call_args
            assert call_kwargs["batch_size"] == custom_batch_size

    def test_encode_raises_value_error_when_batch_size_zero(self):
        """Test: encode() raises ValueError when batch_size is 0."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            texts = ["hello world"]
            with pytest.raises(ValueError, match="batch_size must be positive"):
                embedder.encode(texts, batch_size=0)

    def test_encode_raises_value_error_when_batch_size_negative(self):
        """Test: encode() raises ValueError when batch_size is negative."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            texts = ["hello world"]
            with pytest.raises(ValueError, match="batch_size must be positive"):
                embedder.encode(texts, batch_size=-5)

    def test_encode_returns_empty_list_for_empty_texts(self):
        """Test: encode() returns [] for empty texts list."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            result = embedder.encode([])
            assert result == [], "encode([]) should return an empty list"
            # Verify model.encode was NOT called for empty input
            mock_model.encode.assert_not_called()


class TestEmbeddingModelEncodeSingleNoBatchSize:
    """Tests verifying encode_single() does NOT accept batch_size parameter."""

    def test_encode_single_signature_has_no_batch_size(self):
        """Test: encode_single() does NOT accept batch_size parameter (not needed for single text)."""
        from vector_store import EmbeddingModel

        sig = inspect.signature(EmbeddingModel.encode_single)
        params = list(sig.parameters.keys())
        # encode_single should only have 'self' and 'text'
        assert "text" in params, "encode_single() should have text parameter"
        assert "batch_size" not in params, "encode_single() should NOT have batch_size parameter"

    def test_encode_single_rejects_batch_size(self):
        """Test: encode_single() raises TypeError if batch_size is passed."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model
            import numpy as np
            mock_model.encode.return_value = np.array([[0.1, 0.2, 0.3]])

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            text = "hello world"

            # encode_single() should NOT accept batch_size - it encodes one text at a time
            with pytest.raises(TypeError, match="unexpected keyword argument"):
                embedder.encode_single(text, batch_size=16)

    def test_encode_single_rejects_batch_size_none(self):
        """Test: encode_single() raises TypeError if batch_size=None is passed."""
        from vector_store import EmbeddingModel

        with patch("vector_store.SentenceTransformer") as mock_st:
            mock_model = MagicMock()
            mock_st.return_value = mock_model
            import numpy as np
            mock_model.encode.return_value = np.array([[0.1, 0.2, 0.3]])

            embedder = EmbeddingModel("test-model")
            embedder.model = mock_model

            text = "hello world"

            # batch_size=None should still be rejected - not a valid parameter for single encoding
            with pytest.raises(TypeError, match="unexpected keyword argument"):
                embedder.encode_single(text, batch_size=None)


class TestAddChunksSeparateBatchSizeParameters:
    """Tests for chunk_batch_size and embed_batch_size as separate parameters in add_chunks()."""

    @pytest.fixture
    def mock_embedder(self):
        """Create a mock embedder that returns embeddings matching input size."""
        mock = MagicMock()
        import numpy as np

        def encode_with_matching_size(texts, **kwargs):
            # Return embeddings matching the number of input texts
            return np.array([[0.1, 0.2, 0.3] for _ in range(len(texts))])

        mock.encode.side_effect = encode_with_matching_size
        return mock

    def test_add_chunks_signature_has_separate_parameters(self):
        """Test: add_chunks() accepts chunk_batch_size and embed_batch_size as separate parameters."""
        from vector_store import VectorStore

        sig = inspect.signature(VectorStore.add_chunks)
        params = list(sig.parameters.keys())

        assert "chunk_batch_size" in params, "add_chunks() should have chunk_batch_size parameter"
        assert "embed_batch_size" in params, "add_chunks() should have embed_batch_size parameter"
        # It should NOT have a plain 'batch_size' parameter
        assert "batch_size" not in params or params.count("batch_size") == 0, \
            "add_chunks() should use embed_batch_size, not batch_size"

    def test_add_chunks_embed_batch_size_passed_to_embedder(self, temp_chroma_db, mock_embedder):
        """Test: add_chunks() passes embed_batch_size to embedder.encode() (not chunk_batch_size)."""
        from vector_store import VectorStore

        # Clear cached modules
        modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
        for mod in modules_to_clear:
            del sys.modules[mod]

        with patch("vector_store.EmbeddingModel", return_value=mock_embedder):
            with patch("vector_store.chromadb"):
                from vector_store import VectorStore

                with patch("vector_store.chromadb.PersistentClient") as mock_client:
                    mock_collection = MagicMock()
                    mock_client.return_value.get_or_create_collection.return_value = mock_collection
                    mock_collection.count.return_value = 0

                    store = VectorStore(db_path=str(temp_chroma_db))
                    store.embedder = mock_embedder

                    from document_processor import DocumentChunk
                    chunks = [
                        DocumentChunk(text=f"chunk {i}", source="test.txt", chunk_index=i)
                        for i in range(5)
                    ]

                    # Call add_chunks with embed_batch_size=2
                    store.add_chunks(chunks, embed_batch_size=2)

                    # Verify embedder.encode was called with batch_size=2
                    assert mock_embedder.encode.called
                    calls = mock_embedder.encode.call_args_list
                    assert len(calls) > 0, "embedder.encode should have been called"

                    for call in calls:
                        _, kwargs = call
                        assert "batch_size" in kwargs, "batch_size should be passed to embedder.encode()"
                        assert kwargs["batch_size"] == 2, "embed_batch_size=2 should be passed as batch_size"

    def test_add_chunks_embed_batch_size_none_not_passed(self, temp_chroma_db, mock_embedder):
        """Test: Default embed_batch_size=None preserves backward compatibility (batch_size not passed).

        Bug: The current implementation passes batch_size=None to embedder.encode() when
        embed_batch_size is not specified. For true backward compatibility, batch_size
        should NOT be passed when embed_batch_size=None (the embedder's encode method
        only adds batch_size to kwargs when it's not None).

        The fix: Change add_chunks() to conditionally pass batch_size only when
        embed_batch_size is not None:
            if embed_batch_size is not None:
                embeddings = self.embedder.encode(texts, batch_size=embed_batch_size)
            else:
                embeddings = self.embedder.encode(texts)
        """
        from vector_store import VectorStore

        modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
        for mod in modules_to_clear:
            del sys.modules[mod]

        with patch("vector_store.EmbeddingModel", return_value=mock_embedder):
            with patch("vector_store.chromadb"):
                from vector_store import VectorStore

                with patch("vector_store.chromadb.PersistentClient") as mock_client:
                    mock_collection = MagicMock()
                    mock_client.return_value.get_or_create_collection.return_value = mock_collection
                    mock_collection.count.return_value = 0

                    store = VectorStore(db_path=str(temp_chroma_db))
                    store.embedder = mock_embedder

                    from document_processor import DocumentChunk
                    chunks = [
                        DocumentChunk(text=f"chunk {i}", source="test.txt", chunk_index=i)
                        for i in range(5)
                    ]

                    # Call add_chunks WITHOUT embed_batch_size - should default to None
                    store.add_chunks(chunks)

                    # When embed_batch_size is None, batch_size should NOT be in encode kwargs
                    # (this is the bug fix: batch_size=None should not be passed at all)
                    assert mock_embedder.encode.called
                    calls = mock_embedder.encode.call_args_list
                    for call in calls:
                        _, kwargs = call
                        assert "batch_size" not in kwargs, \
                            "When embed_batch_size=None, batch_size should not be passed to embedder.encode() for backward compatibility"

    def test_add_chunks_embed_batch_size_controls_embedder_not_loop(self, temp_chroma_db, mock_embedder):
        """Test: embed_batch_size is passed to embedder, chunk_batch_size controls loop iteration."""
        from vector_store import VectorStore

        modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
        for mod in modules_to_clear:
            del sys.modules[mod]

        with patch("vector_store.EmbeddingModel", return_value=mock_embedder):
            with patch("vector_store.chromadb"):
                from vector_store import VectorStore

                with patch("vector_store.chromadb.PersistentClient") as mock_client:
                    mock_collection = MagicMock()
                    mock_client.return_value.get_or_create_collection.return_value = mock_collection
                    mock_collection.count.return_value = 0

                    store = VectorStore(db_path=str(temp_chroma_db))
                    store.embedder = mock_embedder

                    from document_processor import DocumentChunk
                    # Use 250 chunks to force multiple iterations with chunk_batch_size=100
                    chunks = [
                        DocumentChunk(text=f"chunk {i}", source="test.txt", chunk_index=i)
                        for i in range(250)
                    ]

                    # chunk_batch_size=100, embed_batch_size=16
                    # Loop should run 3 times (0-99, 100-199, 200-249)
                    # Each call to encode should receive batch_size=16
                    store.add_chunks(chunks, chunk_batch_size=100, embed_batch_size=16)

                    # Verify embedder.encode was called (multiple times due to chunk_batch_size loop)
                    assert mock_embedder.encode.called
                    calls = mock_embedder.encode.call_args_list
                    # Should have multiple calls due to chunk_batch_size=100 with 250 chunks
                    assert len(calls) >= 2, "Should have multiple encode calls due to chunk batching"

                    # Every encode call should receive batch_size=16 (embed_batch_size)
                    for call in calls:
                        _, kwargs = call
                        assert "batch_size" in kwargs, "batch_size should be passed"
                        assert kwargs["batch_size"] == 16, "embed_batch_size=16 should be passed"

    def test_add_chunks_default_embed_batch_size_is_none(self):
        """Test: add_chunks() default value for embed_batch_size is None."""
        from vector_store import VectorStore

        sig = inspect.signature(VectorStore.add_chunks)
        params = sig.parameters

        assert "embed_batch_size" in params, "embed_batch_size parameter should exist"
        default = params["embed_batch_size"].default
        assert default is None, "Default embed_batch_size should be None for backward compatibility"

    def test_add_chunks_raises_value_error_when_chunk_batch_size_zero(self, temp_chroma_db, mock_embedder):
        """Test: add_chunks() raises ValueError when chunk_batch_size is 0."""
        from vector_store import VectorStore
        from document_processor import DocumentChunk

        modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
        for mod in modules_to_clear:
            del sys.modules[mod]

        with patch("vector_store.EmbeddingModel", return_value=mock_embedder):
            with patch("vector_store.chromadb"):
                from vector_store import VectorStore

                with patch("vector_store.chromadb.PersistentClient") as mock_client:
                    mock_collection = MagicMock()
                    mock_client.return_value.get_or_create_collection.return_value = mock_collection
                    mock_collection.count.return_value = 0

                    store = VectorStore(db_path=str(temp_chroma_db))
                    store.embedder = mock_embedder

                    chunks = [
                        DocumentChunk(text=f"chunk {i}", source="test.txt", chunk_index=i)
                        for i in range(5)
                    ]

                    with pytest.raises(ValueError, match="chunk_batch_size must be positive"):
                        store.add_chunks(chunks, chunk_batch_size=0)

    def test_add_chunks_raises_value_error_when_chunk_batch_size_negative(self, temp_chroma_db, mock_embedder):
        """Test: add_chunks() raises ValueError when chunk_batch_size is negative."""
        from vector_store import VectorStore
        from document_processor import DocumentChunk

        modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
        for mod in modules_to_clear:
            del sys.modules[mod]

        with patch("vector_store.EmbeddingModel", return_value=mock_embedder):
            with patch("vector_store.chromadb"):
                from vector_store import VectorStore

                with patch("vector_store.chromadb.PersistentClient") as mock_client:
                    mock_collection = MagicMock()
                    mock_client.return_value.get_or_create_collection.return_value = mock_collection
                    mock_collection.count.return_value = 0

                    store = VectorStore(db_path=str(temp_chroma_db))
                    store.embedder = mock_embedder

                    chunks = [
                        DocumentChunk(text=f"chunk {i}", source="test.txt", chunk_index=i)
                        for i in range(5)
                    ]

                    with pytest.raises(ValueError, match="chunk_batch_size must be positive"):
                        store.add_chunks(chunks, chunk_batch_size=-10)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
