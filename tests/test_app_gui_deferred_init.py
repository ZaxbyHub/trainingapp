import pytest
from unittest.mock import MagicMock, patch


def test_load_settings_and_init_method_exists():
    """FR-503: _load_settings_and_init method must exist on the app class."""
    # Import will fail if customtkinter not installed — handle gracefully
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")
    
    # Check method exists on the class
    assert hasattr(app_gui.DocumentQAApp, '_load_settings_and_init')


def test_init_defers_settings_load():
    """FR-503: __init__ must NOT call _load_settings directly."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")
    
    # We can't easily instantiate the GUI without a display, but we can check
    # the __init__ source doesn't directly call _load_settings
    import inspect
    source = inspect.getsource(app_gui.DocumentQAApp.__init__)
    assert "self._load_settings()" not in source, \
        "__init__ should not call _load_settings() directly — use self.after()"
    assert "_load_settings_and_init" in source, \
        "__init__ should reference _load_settings_and_init"
    assert "self.after" in source, \
        "__init__ should use self.after() for deferred initialization"
