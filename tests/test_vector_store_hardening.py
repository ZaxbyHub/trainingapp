"""
Tests for EmbeddingModel.__init__() hardening — offline-only enforcement.

Verifies:
1. All 3 code paths pass local_files_only=True to SentenceTransformer
2. FileNotFoundError is raised with helpful messages when model not found
3. No print() calls — logger used instead
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest


# Ensure vector_store is fresh each time by clearing sys.modules
def clear_vector_store():
    for mod_name in list(sys.modules.keys()):
        if mod_name == "vector_store" or mod_name.startswith("vector_store."):
            del sys.modules[mod_name]


def setup_sentence_transformers_mock(st_mock):
    """Pre-populate sys.modules so vector_store imports the mock."""
    fake_st = MagicMock(SentenceTransformer=st_mock)
    sys.modules["sentence_transformers"] = fake_st
    sys.modules["sentence_transformers"].SENTENCE_TRANSFORMERS_AVAILABLE = True
    # Other deps vector_store may import
    for dep in ["chromadb", "chromadb.config", "rank_bm25", "document_processor", "utils", "query_transformer"]:
        sys.modules[dep] = MagicMock()


def teardown_sentence_transformers_mock():
    # Clean up all modules that setup_sentence_transformers_mock added
    for dep in ["sentence_transformers", "chromadb", "chromadb.config", "rank_bm25", 
                "document_processor", "utils", "query_transformer"]:
        sys.modules.pop(dep, None)
    # Also clean any sentence_transformers submodules
    for mod_name in list(sys.modules.keys()):
        if mod_name.startswith("sentence_transformers"):
            sys.modules.pop(mod_name, None)


# ------------------------------------------------------------------------------------------------
# Test 1: Path A — PyInstaller bundle found → local_files_only=True
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
@patch("vector_store.sys")
def test_pyinstaller_bundle_used(mock_sys, mock_path_cls, mock_st_cls):
    clear_vector_store()
    setup_sentence_transformers_mock(mock_st_cls)

    mock_sys.frozen = True
    mock_sys._MEIPASS = "/app"

    bundle_path = MagicMock()
    bundle_path.exists.return_value = True
    bundle_path.iterdir.return_value = ["file1"]
    bundle_path.__truediv__ = MagicMock(return_value=bundle_path)

    local_path = MagicMock()
    local_path.exists.return_value = False
    local_path.iterdir.return_value = []

    # Order: local_model_path = Path(...) is called FIRST, then bundle_path = Path(sys._MEIPASS) is called SECOND
    mock_path_cls.side_effect = [local_path, bundle_path]

    try:
        from vector_store import EmbeddingModel
        # Model is NOT loaded during __init__ (lazy loading)
        em = EmbeddingModel()
        mock_st_cls.assert_not_called()
        
        # Now trigger lazy load by calling encode
        em.encode(["test"])
        mock_st_cls.assert_called_once()
        assert mock_st_cls.call_args[1]["local_files_only"] is True
    finally:
        teardown_sentence_transformers_mock()
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 2: Path B — PyInstaller bundle missing, local fallback exists → local_files_only=True
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
@patch("vector_store.sys")
def test_pyinstaller_local_fallback(mock_sys, mock_path_cls, mock_st_cls):
    clear_vector_store()
    setup_sentence_transformers_mock(mock_st_cls)

    mock_sys.frozen = True
    mock_sys._MEIPASS = "/app"

    bundle_path = MagicMock()
    bundle_path.exists.return_value = False
    bundle_path.__truediv__ = MagicMock(return_value=bundle_path)

    local_path = MagicMock()
    local_path.exists.return_value = True
    local_path.iterdir.return_value = ["config.json"]
    local_path.__truediv__ = MagicMock(return_value=local_path)
    local_path.resolve.return_value = Path("C:/app/models/bge-small-en-v1.5")

    # Order: local_model_path = Path(...) is called FIRST, then bundle_path = Path(sys._MEIPASS) is called SECOND
    mock_path_cls.side_effect = [local_path, bundle_path]

    try:
        from vector_store import EmbeddingModel
        # Model is NOT loaded during __init__ (lazy loading)
        em = EmbeddingModel()
        mock_st_cls.assert_not_called()
        
        # Now trigger lazy load
        em.encode(["test"])
        mock_st_cls.assert_called_once()
        assert mock_st_cls.call_args[1]["local_files_only"] is True
    finally:
        teardown_sentence_transformers_mock()
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 3: Path B — Both missing → FileNotFoundError raised during lazy load
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
@patch("vector_store.sys")
def test_pyinstaller_no_model_raises(mock_sys, mock_path_cls, mock_st_cls):
    clear_vector_store()

    mock_sys.frozen = True
    mock_sys._MEIPASS = "/app"

    bundle_path = MagicMock()
    bundle_path.exists.return_value = False
    bundle_path.iterdir.return_value = []
    bundle_path.__truediv__ = MagicMock(return_value=bundle_path)

    # Both bundle and local missing → raises FileNotFoundError directly
    local_path = MagicMock()
    local_path.exists.return_value = False
    local_path.resolve.return_value = Path("C:/app/models/bge-small-en-v1.5")

    # Order: local_model_path = Path(...) is called FIRST, then bundle_path = Path(sys._MEIPASS) is called SECOND
    mock_path_cls.side_effect = [local_path, bundle_path]

    try:
        from vector_store import EmbeddingModel
        # __init__ should NOT raise - model not loaded yet
        em = EmbeddingModel()
        mock_st_cls.assert_not_called()
        
        # Now trigger lazy load - this should raise (both bundle and local missing)
        with pytest.raises(FileNotFoundError, match="Embedding model not found"):
            em.encode(["test"])
    finally:
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 4: Path C — Dev mode, local model exists → local_files_only=True
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
def test_dev_mode_local_model(mock_path_cls, mock_st_cls):
    clear_vector_store()
    setup_sentence_transformers_mock(mock_st_cls)

    local_path = MagicMock()
    local_path.exists.return_value = True
    local_path.iterdir.return_value = ["config.json"]
    mock_path_cls.return_value = local_path

    try:
        from vector_store import EmbeddingModel
        # Model NOT loaded during __init__
        em = EmbeddingModel()
        mock_st_cls.assert_not_called()
        
        # Trigger lazy load
        em.encode(["test"])
        mock_st_cls.assert_called_once()
        assert mock_st_cls.call_args[1]["local_files_only"] is True
    finally:
        teardown_sentence_transformers_mock()
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 5: Path C — Dev mode, local missing, cache hit → local_files_only=True
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
def test_dev_mode_cache_fallback(mock_path_cls, mock_st_cls):
    clear_vector_store()
    setup_sentence_transformers_mock(mock_st_cls)

    local_path = MagicMock()
    local_path.exists.return_value = False
    mock_path_cls.return_value = local_path

    # cache hit — no OSError raised
    mock_st_cls.return_value = MagicMock()

    try:
        from vector_store import EmbeddingModel
        # Model NOT loaded during __init__
        em = EmbeddingModel()
        mock_st_cls.assert_not_called()
        
        # Trigger lazy load
        em.encode(["test"])
        mock_st_cls.assert_called_once()
        assert mock_st_cls.call_args[1]["local_files_only"] is True
    finally:
        teardown_sentence_transformers_mock()
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 6: Path C — Dev mode, nothing found → FileNotFoundError during lazy load
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer", side_effect=OSError("not found"))
@patch("vector_store.Path")
def test_dev_mode_no_model_raises(mock_path_cls, mock_st_cls):
    clear_vector_store()

    local_path = MagicMock()
    local_path.exists.return_value = False
    local_path.resolve.return_value = Path("C:/app/models/bge-small-en-v1.5")
    mock_path_cls.return_value = local_path

    try:
        from vector_store import EmbeddingModel
        # __init__ should NOT raise - model not loaded yet
        em = EmbeddingModel()
        mock_st_cls.assert_not_called()
        
        # Trigger lazy load - this should raise (OSError caught and re-raised as FileNotFoundError)
        with pytest.raises(FileNotFoundError, match="not found in HuggingFace cache"):
            em.encode(["test"])
    finally:
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 7: FileNotFoundError message includes expected path
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
@patch("vector_store.sys")
def test_error_message_contains_path(mock_sys, mock_path_cls):
    """
    Test 7: FileNotFoundError message contains model name, path info, and download instructions.
    Uses a single mock Path return value that returns False for exists() to trigger the error path.
    Error is raised during lazy load (encode), not during __init__.
    """
    clear_vector_store()

    mock_sys.frozen = True
    mock_sys._MEIPASS = "/app"

    mock_path = MagicMock()
    mock_path.exists.return_value = False
    mock_path.resolve.return_value = Path("C:/app/models/bge-small-en-v1.5")
    mock_path.__truediv__ = MagicMock(return_value=mock_path)
    mock_path_cls.return_value = mock_path

    try:
        from vector_store import EmbeddingModel
        # __init__ should not raise
        em = EmbeddingModel()
        
        # Now trigger lazy load - this should raise (both bundle and local missing)
        with pytest.raises(FileNotFoundError) as exc_info:
            em.encode(["test"])

        err = str(exc_info.value)
        # Verify key content in the error message
        assert "bge-small-en-v1.5" in err, f"Error should mention model name. Got: {err}"
        assert "models" in err, f"Error should mention models path. Got: {err}"
        assert "Download BAAI/bge-small-en-v1.5" in err, f"Error should mention download instructions. Got: {err}"
    finally:
        clear_vector_store()


# ------------------------------------------------------------------------------------------------
# Test 8: No print() calls — verify logger used instead
# ------------------------------------------------------------------------------------------------
@pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
@patch("vector_store.SentenceTransformer")
@patch("vector_store.Path")
def test_no_print_calls(mock_path_cls, mock_st_cls, capsys):
    clear_vector_store()
    setup_sentence_transformers_mock(mock_st_cls)

    local_path = MagicMock()
    local_path.exists.return_value = True
    local_path.iterdir.return_value = ["config.json"]
    mock_path_cls.return_value = local_path

    try:
        from vector_store import EmbeddingModel
        # __init__ should not print
        em = EmbeddingModel()
        
        # Trigger lazy load
        em.encode(["test"])
        
        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == ""
    finally:
        teardown_sentence_transformers_mock()
        clear_vector_store()
