"""
FR-405 Tests: _initialize_engine must use engine_factory, not direct RAGEngine.

Validates:
1. _initialize_engine calls create_engine_from_settings
2. _initialize_engine does not construct RAGEngine directly
3. engine_factory is imported at module level
4. Error messages don't reference specific backend names
"""

import inspect
import pytest


def test_initialize_engine_uses_factory():
    """FR-405: _initialize_engine must use create_engine_from_settings, not direct RAGEngine."""
    import app_gui
    
    source = inspect.getsource(app_gui.DocumentQAApp._initialize_engine)
    
    # Must call create_engine_from_settings
    assert "create_engine_from_settings" in source, \
        "_initialize_engine must use create_engine_from_settings"
    
    # Must NOT construct RAGEngine directly
    assert "RAGEngine(" not in source, \
        "_initialize_engine must not construct RAGEngine directly"


def test_no_ollama_kwargs_in_engine_init():
    """FR-405: _initialize_engine must not pass ollama_model, ollama_url, or api_url as engine kwargs."""
    import app_gui
    
    source = inspect.getsource(app_gui.DocumentQAApp._initialize_engine)
    
    # These should NOT appear as direct engine arguments
    assert "ollama_model" not in source, \
        "ollama_model must not be referenced in _initialize_engine"
    assert "ollama_url" not in source, \
        "ollama_url must not be referenced in _initialize_engine"
    assert "api_url" not in source, \
        "api_url must not be referenced in _initialize_engine"


def test_engine_factory_imported_at_module_level():
    """FR-405: engine_factory must be imported at module level, not inside a function."""
    import app_gui
    
    # Check module-level namespace for the factory function
    assert hasattr(app_gui, 'create_engine_from_settings'), \
        "create_engine_from_settings must be importable from app_gui module"
    
    # Verify it's imported, not defined in this module
    source_file = inspect.getfile(app_gui)
    with open(source_file, 'r', encoding='utf-8', errors='replace') as f:
        module_source = f.read()
    
    # Should have import statement for engine_factory
    assert "from engine_factory import create_engine_from_settings" in module_source or \
           "import engine_factory" in module_source, \
           "engine_factory must be imported at module level"


def test_error_message_no_backend_references():
    """FR-405: Error message in _initialize_engine must not reference Ollama or API backends."""
    import app_gui
    
    source = inspect.getsource(app_gui.DocumentQAApp._initialize_engine)
    
    # Error messages should be generic, not reference specific backends
    assert "Ollama" not in source, \
        "Error message must not reference Ollama"
    assert "API backend" not in source, \
        "Error message must not reference API backend"


def test_create_engine_from_settings_receives_settings():
    """FR-405: _initialize_engine must pass self.settings to create_engine_from_settings."""
    import app_gui
    
    source = inspect.getsource(app_gui.DocumentQAApp._initialize_engine)
    
    # Must call the factory with settings parameter
    assert "create_engine_from_settings(self.settings)" in source, \
        "_initialize_engine must call create_engine_from_settings(self.settings)"
