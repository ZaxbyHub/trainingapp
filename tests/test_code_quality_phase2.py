import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch


class TestUtilsDefaultDictImport:
    """FR-803: defaultdict import at module level."""
    def test_defaultdict_importable_at_module_level(self):
        import utils
        assert hasattr(utils, 'defaultdict')
        from collections import defaultdict
        assert utils.defaultdict is defaultdict

    def test_rrf_fuse_works(self):
        from utils import rrf_fuse
        result = rrf_fuse([
            [(1, 0.9), (2, 0.8)],
            [(2, 0.95), (3, 0.7)],
        ])
        doc_ids = [doc_id for doc_id, _ in result]
        assert 2 in doc_ids  # doc 2 appears in both lists
        assert 1 in doc_ids
        assert 3 in doc_ids


class TestSettingsProxyError:
    """FR-806: _SettingsProxy AttributeError with helpful message."""
    def test_invalid_attribute_raises_helpful_error(self):
        import config
        proxy = config._SettingsProxy()
        with pytest.raises(AttributeError) as exc_info:
            _ = proxy.nonexistent_setting_xyz
        assert "Check CONFIGURATION.md" in str(exc_info.value)

    def test_valid_attribute_works(self):
        import config
        proxy = config._SettingsProxy()
        # Should not raise — rag_db_path is a valid attribute
        val = proxy.rag_db_path
        assert val is not None


class TestApiServerPathHelper:
    """FR-801: _resolve_and_validate_path shared helper."""
    def test_rejects_path_traversal(self):
        from api_server import _resolve_and_validate_path
        with pytest.raises(ValueError, match="traversal"):
            _resolve_and_validate_path("../../etc/passwd")

    def test_rejects_relative_path_outside_base(self):
        from api_server import _resolve_and_validate_path
        with pytest.raises(ValueError, match="traversal"):
            _resolve_and_validate_path("../../../windows/system32", base_dir=Path("C:/app"))

    def test_allows_absolute_path(self):
        from api_server import _resolve_and_validate_path
        # Absolute paths bypass base_dir containment (same as before refactoring)
        result = _resolve_and_validate_path("C:/Models/model.gguf")
        assert str(result) == "C:\\Models\\model.gguf"


class TestSecurityOfflineUrl:
    """FR-901: Reject non-file URL schemes."""
    def test_rejects_ftp_url(self):
        from security import validate_url
        with pytest.raises(ValueError, match="not allowed"):
            validate_url("ftp://example.com/file")

    def test_rejects_non_file_scheme(self):
        from security import validate_url
        with pytest.raises(ValueError, match="not allowed"):
            validate_url("gopher://localhost")

    def test_allows_empty_scheme(self):
        """Empty scheme passes the offline scheme check (fails later on scheme requirement)."""
        from security import validate_url
        # urlparse("localhost:8080") → scheme='localhost' (not empty)
        # urlparse("//localhost:8080") → scheme='' (empty), so it tests the empty-scheme path
        with pytest.raises(ValueError) as exc_info:
            validate_url("//localhost:8080", allow_local=True)
        # Must fail on scheme requirement (http/https), NOT on offline scheme check
        assert "not allowed" not in str(exc_info.value)
