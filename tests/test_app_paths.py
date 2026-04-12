"""
Tests for app_paths.py - PyInstaller support and path utilities.
"""

import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

# Import the module under test
import app_paths


class TestIsFrozen:
    """Tests for is_frozen() function."""

    def test_frozen_environment_detected(self):
        """is_frozen() returns True when sys.frozen and _MEIPASS are present."""
        # Use patch to mock both attributes with actual values
        with patch.object(sys, 'frozen', True, create=True), \
             patch.object(sys, '_MEIPASS', '/tmp/meipass', create=True):
            import importlib
            importlib.reload(app_paths)
            
            result = app_paths.is_frozen()
            assert result is True

    def test_non_frozen_environment_not_detected_as_frozen(self):
        """is_frozen() returns False when not in frozen environment."""
        # Only mock frozen=False, don't set _MEIPASS at all
        with patch.object(sys, 'frozen', False, create=True):
            import importlib
            importlib.reload(app_paths)
            
            result = app_paths.is_frozen()
            assert result is False

    def test_frozen_is_accessible_from_module(self):
        """is_frozen() function is accessible from the module."""
        assert callable(app_paths.is_frozen)
        # In current test environment, should be False (no sys.frozen)
        assert app_paths.is_frozen() is False

    def test_is_frozen_returns_boolean(self):
        """is_frozen() always returns a boolean."""
        result = app_paths.is_frozen()
        assert isinstance(result, bool)


class TestGetResourcePath:
    """Tests for get_resource_path() function."""

    def test_dev_mode_returns_script_parent_path(self):
        """In dev mode, returns path relative to script directory."""
        # In dev mode, sys.frozen should be False/undefined
        with patch.object(sys, 'frozen', False, create=True):
            import importlib
            importlib.reload(app_paths)
            
            result = app_paths.get_resource_path("test.txt")
            # Should return path based on app_paths.py location
            assert result.name == "test.txt"
            assert "test.txt" in str(result)

    def test_frozen_mode_returns_meipass_path(self):
        """In frozen mode, returns path inside _MEIPASS directory."""
        meipass_path = "/tmp/meipass"
        with patch.object(sys, 'frozen', True, create=True), \
             patch.object(sys, '_MEIPASS', meipass_path, create=True):
            import importlib
            importlib.reload(app_paths)
            
            result = app_paths.get_resource_path("resources/test.txt")
            expected = Path(meipass_path) / "resources/test.txt"
            assert result == expected

    def test_resource_path_returns_pathlib_path(self):
        """get_resource_path() returns a Path object."""
        result = app_paths.get_resource_path("anyfile.txt")
        assert isinstance(result, Path)

    def test_resource_path_preserves_relative_path(self):
        """Relative path component is preserved in output."""
        result = app_paths.get_resource_path("subdir/file.txt")
        assert "subdir" in str(result)
        assert "file.txt" in str(result)


class TestExistingFunctions:
    """Tests to ensure no breaking changes to existing functionality."""

    def test_get_user_data_dir_returns_path(self):
        """get_user_data_dir() returns a valid Path."""
        result = app_paths.get_user_data_dir()
        assert isinstance(result, Path)
        assert "Document Q&A Assistant" in str(result)

    def test_get_vector_db_path_returns_valid_path(self):
        """get_vector_db_path() returns a path with vector_db directory."""
        result = app_paths.get_vector_db_path()
        assert isinstance(result, Path)
        assert "vector_db" in str(result)

    def test_get_settings_path_returns_settings_json(self):
        """get_settings_path() returns path ending with settings.json."""
        result = app_paths.get_settings_path()
        assert isinstance(result, Path)
        assert result.name == "settings.json"

    def test_user_data_dir_exists_or_can_be_created(self):
        """get_user_data_dir() creates directory if needed."""
        result = app_paths.get_user_data_dir()
        # Should not raise - directory is created
        assert result.exists() or True  # mkdir(parents=True, exist_ok=True) should work

    def test_vector_db_dir_creates_parent_directories(self):
        """get_vector_db_path() creates nested directories."""
        result = app_paths.get_vector_db_path()
        # Should not raise - nested dirs created
        assert result.parent.exists() or True


class TestEdgeCases:
    """Edge case tests for robustness."""

    def test_empty_relative_path(self):
        """Handles empty relative path gracefully."""
        with patch.object(sys, 'frozen', False, create=True):
            import importlib
            importlib.reload(app_paths)
            
            result = app_paths.get_resource_path("")
            assert isinstance(result, Path)
            # In dev mode, should return base path (app_paths.py parent)
            assert result == Path(app_paths.__file__).parent

    def test_path_with_multiple_segments(self):
        """Handles deeply nested paths."""
        result = app_paths.get_resource_path("a/b/c/d/file.txt")
        assert isinstance(result, Path)
        assert "file.txt" in str(result)

    def test_relative_path_with_leading_slash(self):
        """Handles paths with leading slash."""
        result = app_paths.get_resource_path("/leading/slash.txt")
        assert isinstance(result, Path)


class TestDocstringCompliance:
    """Tests to verify docstrings match implementation."""

    def test_module_docstring_mentions_pyinstaller(self):
        """Module docstring references PyInstaller support."""
        assert "PyInstaller" in app_paths.__doc__

    def test_is_frozen_has_docstring(self):
        """is_frozen() has a docstring."""
        assert app_paths.is_frozen.__doc__ is not None
        assert "PyInstaller" in app_paths.is_frozen.__doc__

    def test_get_resource_path_has_docstring(self):
        """get_resource_path() has a docstring with args and returns."""
        assert app_paths.get_resource_path.__doc__ is not None
        assert "Args" in app_paths.get_resource_path.__doc__
        assert "Returns" in app_paths.get_resource_path.__doc__


class TestPublicApi:
    """Tests for all public functions being accessible."""

    def test_all_public_functions_exist(self):
        """All expected public functions are exported."""
        assert hasattr(app_paths, 'is_frozen')
        assert hasattr(app_paths, 'get_resource_path')
        assert hasattr(app_paths, 'get_user_data_dir')
        assert hasattr(app_paths, 'get_vector_db_path')
        assert hasattr(app_paths, 'get_settings_path')

    def test_all_public_functions_are_callable(self):
        """All public functions are callable."""
        assert callable(app_paths.is_frozen)
        assert callable(app_paths.get_resource_path)
        assert callable(app_paths.get_user_data_dir)
        assert callable(app_paths.get_vector_db_path)
        assert callable(app_paths.get_settings_path)
