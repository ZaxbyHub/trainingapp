"""
Tests for keyboard shortcuts and button styling in app_gui.py (Task 3.3).

Tests verify:
- FR-701: Ctrl+Enter binding for question submission
- FR-702: Ctrl+L binding for clear chat
- FR-703: Ctrl+, binding for settings
- FR-704a: Clear chat confirmation dialog
- FR-704b: Button styling (primary/secondary)
"""

import pytest
from unittest.mock import MagicMock, patch
import inspect


def test_ctrl_enter_binding_exists():
    """FR-701: DocumentQAAp must have <Control-Return> binding."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    # Check that the binding method exists and has correct implementation
    source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
    assert 'bind("<Control-Return>"' in source, \
        "Missing <Control-Return> binding for Ctrl+Enter question submission"
    assert "_ask_question" in source, \
        "Ctrl+Enter binding must call _ask_question"


def test_ctrl_l_binding_exists():
    """FR-702: DocumentQAAp must have <Control-l> binding."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
    assert 'bind("<Control-l>"' in source, \
        "Missing <Control-l> binding for Ctrl+L clear chat"
    assert "_confirm_clear_chat" in source, \
        "Ctrl+L binding must call _confirm_clear_chat"


def test_ctrl_comma_binding_exists():
    """FR-703: DocumentQAAp must have <Control-comma> binding."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
    assert 'bind("<Control-comma>"' in source, \
        "Missing <Control-comma> binding for Ctrl+, settings"


def test_clear_chat_requires_confirmation():
    """FR-704a: Clear chat must require user confirmation."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    # Verify _confirm_clear_chat method exists
    assert hasattr(app_gui.DocumentQAApp, '_confirm_clear_chat'), \
        "_confirm_clear_chat method must exist"

    # Verify it calls messagebox.askyesno
    source = inspect.getsource(app_gui.DocumentQAApp._confirm_clear_chat)
    assert "askyesno" in source, \
        "_confirm_clear_chat must call messagebox.askyesno"
    assert "_do_clear_chat" in source, \
        "_confirm_clear_chat must call _do_clear_chat when confirmed"


def test_ask_button_has_primary_style():
    """FR-704b: Ask button must have primary (blue) styling."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
    # Find the ask_button creation block (now uses _make_button helper)
    assert 'input_frame, text="Ask"' in source, \
        "ask_button must be created with _make_button"

    # Verify primary styling colors
    assert 'fg_color="#1a73e8"' in source, \
        "ask_button must have primary fg_color=#1a73e8 (blue)"
    assert 'hover_color="#1557b0"' in source, \
        "ask_button must have hover_color=#1557b0"
    assert 'text_color="white"' in source, \
        "ask_button must have text_color=white"


def test_clear_button_has_secondary_style():
    """FR-704b: Clear button must have secondary (gray) styling."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
    # Find the clear_button creation block (now uses _make_button helper)
    assert 'input_frame, text="Clear"' in source, \
        "clear_button must be created with _make_button"

    # Verify secondary styling colors
    assert 'fg_color="#444444"' in source, \
        "clear_button must have secondary fg_color=#444444 (gray)"
    assert 'hover_color="#555555"' in source, \
        "clear_button must have hover_color=#555555"
    assert 'border_width=1' in source, \
        "clear_button must have border_width=1 for secondary styling"


def test_settings_save_button_has_primary_style():
    """FR-704b: SettingsDialog Save button must have primary (blue) styling."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    # Get SettingsDialog source
    source = inspect.getsource(app_gui.SettingsDialog)
    # Button uses _make_button with positional text arg
    assert 'Save' in source and '_make_button' in source, \
        "SettingsDialog must have Save button"

    # Find the Save button _make_button call
    # Look for the pattern: _make_button(..., "Save", ..., fg_color=...)
    save_button_match = None
    for line_idx, line in enumerate(source.split('\n')):
        if '"Save"' in line and '_make_button' in line:
            # Get surrounding context (the button creation spans multiple lines)
            context = '\n'.join(source.split('\n')[max(0, line_idx-2):line_idx+3])
            save_button_match = context
            break

    assert save_button_match is not None, \
        "Save button _make_button creation not found"
    assert 'fg_color="#1a73e8"' in save_button_match, \
        "Save button must have primary fg_color=#1a73e8 (blue)"
    assert 'hover_color="#1557b0"' in save_button_match, \
        "Save button must have hover_color=#1557b0"


def test_settings_cancel_button_has_secondary_style():
    """FR-704b: SettingsDialog Cancel button must have secondary (gray) styling."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    # Get SettingsDialog source
    source = inspect.getsource(app_gui.SettingsDialog)
    # Button uses _make_button with positional text arg
    assert 'Cancel' in source and '_make_button' in source, \
        "SettingsDialog must have Cancel button"

    # Find the Cancel button _make_button call
    # Look for the pattern: _make_button(..., "Cancel", ..., fg_color=...)
    cancel_button_match = None
    for line_idx, line in enumerate(source.split('\n')):
        if '"Cancel"' in line and '_make_button' in line:
            context = '\n'.join(source.split('\n')[max(0, line_idx-2):line_idx+3])
            cancel_button_match = context
            break

    assert cancel_button_match is not None, \
        "Cancel button _make_button creation not found"
    assert 'fg_color="#444444"' in cancel_button_match, \
        "Cancel button must have secondary fg_color=#444444 (gray)"
    assert 'border_width=1' in cancel_button_match, \
        "Cancel button must have border_width=1 for secondary styling"


def test_confirm_clear_chat_calls_do_clear_on_yes():
    """FR-704a: _confirm_clear_chat must call _do_clear_chat when user confirms."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    # Verify _do_clear_chat method exists
    assert hasattr(app_gui.DocumentQAApp, '_do_clear_chat'), \
        "_do_clear_chat method must exist for actual clearing"

    # Verify _confirm_clear_chat calls _do_clear_chat inside the if block
    source = inspect.getsource(app_gui.DocumentQAApp._confirm_clear_chat)
    assert "askyesno" in source, \
        "_confirm_clear_chat must call askyesno"
    # The logic should be: if askyesno returns True, call _do_clear_chat
    assert "_do_clear_chat()" in source, \
        "_confirm_clear_chat must call _do_clear_chat when confirmed"


def test_no_old_clear_chat_method():
    """FR-704a: Old _clear_chat method must be removed (replaced by _confirm_clear_chat)."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    # The old method should not exist
    assert not hasattr(app_gui.DocumentQAApp, '_clear_chat'), \
        "Old _clear_chat method should be removed - use _confirm_clear_chat instead"


def test_do_clear_chat_removes_widgets():
    """FR-704a: _do_clear_chat must actually remove widgets from chat_frame."""
    try:
        import app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")

    source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
    assert "chat_frame.winfo_children()" in source, \
        "_do_clear_chat must iterate over chat_frame children"
    assert "widget.destroy()" in source, \
        "_do_clear_chat must call destroy() on each widget"
