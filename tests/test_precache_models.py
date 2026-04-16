"""Tests for scripts/precache_models.py"""

import builtins
import pytest
import sys
import importlib
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestPrecacheModelsImports:
    """Verify sentence_transformers import behavior."""

    def test_import_error_returns_1(self):
        """When sentence_transformers cannot be imported, main() returns 1."""
        # Remove cached module
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        # Remove sentence_transformers from sys.modules so the real import fires
        saved_st = sys.modules.pop('sentence_transformers', None)

        # Capture the real __import__ before patching
        real_import = builtins.__import__

        def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == 'sentence_transformers' or (level == 0 and fromlist and 'sentence_transformers' in str(fromlist)):
                raise ImportError("No module named 'sentence_transformers'")
            return real_import(name, globals, locals, fromlist, level)

        try:
            with patch('builtins.__import__', side_effect=fake_import):
                import scripts.precache_models as pm
                importlib.reload(pm)
                result = pm.main()
            assert result == 1, f"Expected 1 on import error, got {result}"
        finally:
            if saved_st is not None:
                sys.modules['sentence_transformers'] = saved_st


class TestPrecacheModelsHappyPath:
    """Test successful model download path with mocks."""

    def test_main_returns_0_on_success(self):
        """main() returns 0 when both models download successfully."""
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        mock_st = MagicMock()
        mock_st.SentenceTransformer = MagicMock()
        mock_st.CrossEncoder = MagicMock()

        # sentence_transformers may already be imported; replace it
        real_st = sys.modules.get('sentence_transformers')
        sys.modules['sentence_transformers'] = mock_st

        try:
            import scripts.precache_models as pm
            importlib.reload(pm)
            result = pm.main()
        finally:
            if real_st is not None:
                sys.modules['sentence_transformers'] = real_st
            elif 'sentence_transformers' in sys.modules:
                del sys.modules['sentence_transformers']

        assert result == 0, f"Expected 0 on success, got {result}"

    def test_embedding_model_downloaded_with_correct_name(self):
        """SentenceTransformer is called with 'BAAI/bge-small-en-v1.5'."""
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        mock_st = MagicMock()
        mock_st_class = MagicMock()
        mock_ce_class = MagicMock()
        mock_st.SentenceTransformer = mock_st_class
        mock_st.CrossEncoder = mock_ce_class

        real_st = sys.modules.get('sentence_transformers')
        sys.modules['sentence_transformers'] = mock_st

        try:
            import scripts.precache_models as pm
            importlib.reload(pm)
            pm.main()
        finally:
            if real_st is not None:
                sys.modules['sentence_transformers'] = real_st
            elif 'sentence_transformers' in sys.modules:
                del sys.modules['sentence_transformers']

        mock_st_class.assert_called_once_with("BAAI/bge-small-en-v1.5")

    def test_reranker_model_downloaded_with_correct_name(self):
        """CrossEncoder is called with 'cross-encoder/ms-marco-MiniLM-L6-v2'."""
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        mock_st = MagicMock()
        mock_st_class = MagicMock()
        mock_ce_class = MagicMock()
        mock_st.SentenceTransformer = mock_st_class
        mock_st.CrossEncoder = mock_ce_class

        real_st = sys.modules.get('sentence_transformers')
        sys.modules['sentence_transformers'] = mock_st

        try:
            import scripts.precache_models as pm
            importlib.reload(pm)
            pm.main()
        finally:
            if real_st is not None:
                sys.modules['sentence_transformers'] = real_st
            elif 'sentence_transformers' in sys.modules:
                del sys.modules['sentence_transformers']

        mock_ce_class.assert_called_once_with("cross-encoder/ms-marco-MiniLM-L6-v2")


class TestPrecacheModelsErrors:
    """Test error handling paths."""

    def test_embedding_model_failure_returns_1(self):
        """When SentenceTransformer throws, main() returns 1."""
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        mock_st = MagicMock()
        mock_st_class = MagicMock()
        mock_st_class.side_effect = Exception("Download failed")
        mock_ce_class = MagicMock()
        mock_st.SentenceTransformer = mock_st_class
        mock_st.CrossEncoder = mock_ce_class

        real_st = sys.modules.get('sentence_transformers')
        sys.modules['sentence_transformers'] = mock_st

        try:
            import scripts.precache_models as pm
            importlib.reload(pm)
            result = pm.main()
        finally:
            if real_st is not None:
                sys.modules['sentence_transformers'] = real_st
            elif 'sentence_transformers' in sys.modules:
                del sys.modules['sentence_transformers']

        assert result == 1, f"Expected 1 on embedding failure, got {result}"

    def test_reranker_model_failure_returns_1(self):
        """When CrossEncoder throws, main() returns 1."""
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        mock_st = MagicMock()
        mock_st_class = MagicMock()
        mock_ce_class = MagicMock()
        mock_ce_class.side_effect = Exception("Download failed")
        mock_st.SentenceTransformer = mock_st_class
        mock_st.CrossEncoder = mock_ce_class

        real_st = sys.modules.get('sentence_transformers')
        sys.modules['sentence_transformers'] = mock_st

        try:
            import scripts.precache_models as pm
            importlib.reload(pm)
            result = pm.main()
        finally:
            if real_st is not None:
                sys.modules['sentence_transformers'] = real_st
            elif 'sentence_transformers' in sys.modules:
                del sys.modules['sentence_transformers']

        assert result == 1, f"Expected 1 on reranker failure, got {result}"


class TestPrecacheModelsScriptExecution:
    """Test that the script runs as __main__ without crashing."""

    def test_main_is_callable(self):
        """main() function exists and is callable."""
        mods_to_remove = [k for k in sys.modules if k.startswith('scripts.precache_models')]
        for mod in mods_to_remove:
            del sys.modules[mod]

        mock_st = MagicMock()
        mock_st.SentenceTransformer = MagicMock()
        mock_st.CrossEncoder = MagicMock()

        real_st = sys.modules.get('sentence_transformers')
        sys.modules['sentence_transformers'] = mock_st

        try:
            import scripts.precache_models as pm
            importlib.reload(pm)
            assert callable(pm.main), "main() must be callable"
        finally:
            if real_st is not None:
                sys.modules['sentence_transformers'] = real_st
            elif 'sentence_transformers' in sys.modules:
                del sys.modules['sentence_transformers']

    def test_script_defines_main_and_main_block(self):
        """Script defines a main() function and uses __main__ guard."""
        import scripts.precache_models as pm
        src = Path(__file__).parent.parent / 'scripts' / 'precache_models.py'
        content = src.read_text()
        assert 'def main():' in content
        assert 'if __name__ == "__main__":' in content
        assert callable(pm.main)
