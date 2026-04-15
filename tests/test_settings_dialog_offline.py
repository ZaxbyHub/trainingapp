import pytest
import re


def test_no_ollama_references_in_app_gui():
    """FR-401/402/403/404: app_gui.py must have zero ollama references."""
    import app_gui
    source = open(app_gui.__file__, "r", encoding="utf-8").read()
    assert "ollama" not in source.lower(), "Found 'ollama' reference in app_gui.py"


def test_no_openai_references_in_app_gui():
    """FR-404: app_gui.py must have zero OpenAI references."""
    import app_gui
    source = open(app_gui.__file__, "r", encoding="utf-8").read()
    assert "openai" not in source.lower(), "Found 'openai' reference in app_gui.py"


def test_no_test_ollama_method():
    """FR-403: _test_ollama method must not exist."""
    import app_gui
    assert not hasattr(app_gui.SettingsDialog, "_test_ollama"), \
        "_test_ollama method must be removed"


def test_no_test_api_method():
    """FR-403: _test_api method must not exist."""
    import app_gui
    assert not hasattr(app_gui.SettingsDialog, "_test_api"), \
        "_test_api method must be removed"


def test_no_ollama_api_in_save_result():
    """FR-404: _save() result dict must not contain ollama/api keys."""
    import app_gui
    source = open(app_gui.__file__, "r", encoding="utf-8").read()
    
    # Find the _save method
    save_match = re.search(r'def _save\(self.*?(?=\n    def |\nclass |\Z)', source, re.DOTALL)
    assert save_match, "_save method not found"
    save_source = save_match.group(0)
    
    assert "ollama_url" not in save_source, "ollama_url found in _save()"
    assert "ollama_model" not in save_source, "ollama_model found in _save()"
    assert "api_url" not in save_source, "api_url found in _save()"


def test_no_ollama_api_in_load_settings_defaults():
    """FR-404: _load_settings() defaults must not contain ollama/api keys."""
    import app_gui
    source = open(app_gui.__file__, "r", encoding="utf-8").read()
    
    load_match = re.search(r'def _load_settings\(self.*?(?=\n    def |\nclass |\Z)', source, re.DOTALL)
    assert load_match, "_load_settings method not found"
    load_source = load_match.group(0)
    
    assert "ollama_url" not in load_source, "ollama_url found in _load_settings()"
    assert "ollama_model" not in load_source, "ollama_model found in _load_settings()"
    assert "api_url" not in load_source, "api_url found in _load_settings()"


def test_bundled_model_list_has_gemma4():
    """FR-110: Bundled model list must reference Gemma 4."""
    import app_gui
    source = open(app_gui.__file__, "r", encoding="utf-8").read()
    assert "gemma-4" in source, "Bundled model list must reference Gemma 4"
