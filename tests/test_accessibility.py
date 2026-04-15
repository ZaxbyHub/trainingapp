"""
Verification tests for accessibility changes in app_gui.py (Task 3.5).
Covers: FR-708 (button height 36px), FR-709 (Segoe UI font), FR-710 (focus_set).
"""

import re
import sys
import os

# Ensure the project root is on the path so 'from app_gui import ...' resolves
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest


# ---------------------------------------------------------------------------
# Mock-based tests (no real GUI needed)
# ---------------------------------------------------------------------------

def _layout_passthrough(self, **kw): return self
def _config_passthrough(self, **kw): pass


class MockCTkButton:
    """Minimal stand-in for customtkinter.CTkButton."""
    def __init__(self, parent=None, text="", command=None, **kwargs):
        self._parent = parent
        self._text = text
        self._command = command
        self._height = kwargs.get("height")
        self._kwargs = kwargs

    def cget(self, key):
        if key == "height":
            return self._height
        if key == "text":
            return self._text
        return self._kwargs.get(key)

    def configure(self, **kwargs):
        self._kwargs.update(kwargs)
        if "height" in kwargs:
            self._height = kwargs["height"]

    pack = _layout_passthrough
    grid = _layout_passthrough
    configure = _config_passthrough


class MockCTkToplevel:
    """Minimal stand-in for customtkinter.CTkToplevel."""
    instances = []

    def __init__(self, parent=None):
        MockCTkToplevel.instances.append(self)
        self.settings = {}
        self.result = None
        self._parent = parent

    title = staticmethod(lambda t: None)
    geometry = staticmethod(lambda t: None)
    transient = staticmethod(lambda p: None)
    grab_set = staticmethod(lambda: None)

    def destroy(self):  # instance method, not staticmethod
        pass

    def _create_widgets(self): pass
    def _populate_fields(self):
        self.model_path_entry = MockCTkEntry()
        self.chunk_size_entry = MockCTkEntry()
        self.n_results_entry = MockCTkEntry()
        self.max_tokens_entry = MockCTkEntry()
        self.temperature_entry = MockCTkEntry()
        self.hybrid_search_var = type("V", (), {"get": lambda s: "on", "set": lambda s, v: None})()
        self.retrieval_window_entry = MockCTkEntry()
        self.reranking_var = type("V", (), {"get": lambda s: "off", "set": lambda s, v: None})()


class MockCTkEntry:
    """Minimal stand-in for customtkinter.CTkEntry."""
    def __init__(self, master=None, width=0, **kwargs):
        self._value = ""
        self.focus_called = False

    def insert(self, idx, val):
        self._value = str(val)

    def focus_set(self):
        self.focus_called = True

    def get(self):
        return self._value

    pack = _layout_passthrough
    grid = _layout_passthrough
    configure = _config_passthrough


class MockCTkFrame:
    """Minimal stand-in for customtkinter.CTkFrame."""
    def __init__(self, parent=None, **kw): pass
    pack = _layout_passthrough
    grid = _layout_passthrough
    configure = _config_passthrough


class MockCTkLabel:
    """Minimal stand-in for customtkinter.CTkLabel."""
    def __init__(self, parent=None, text="", **kw): pass
    pack = _layout_passthrough
    grid = _layout_passthrough
    configure = _config_passthrough


class MockCTk:
    """Minimal stand-in for customtkinter module."""
    @staticmethod
    def set_appearance_mode(mode): pass
    @staticmethod
    def set_default_color_theme(theme): pass


class MockCTkSwitch:
    """Minimal stand-in for customtkinter.CTkSwitch."""
    def __init__(self, master=None, **kw): pass
    pack = _layout_passthrough
    grid = _layout_passthrough
    configure = _config_passthrough


class MockCTkProgressBar:
    """Minimal stand-in for customtkinter.CTkProgressBar."""
    def __init__(self, master=None, **kw): pass
    def set(self, val): pass
    pack = _layout_passthrough
    configure = _config_passthrough


class MockCTkScrollableFrame:
    """Minimal stand-in for customtkinter.CTkScrollableFrame."""
    def __init__(self, master=None, **kw): pass
    pack = _layout_passthrough
    configure = _config_passthrough


class MockCTkOptionMenu:
    """Minimal stand-in for customtkinter.CTkOptionMenu."""
    def __init__(self, master=None, **kw): pass
    pack = _layout_passthrough
    configure = _config_passthrough


# ---------------------------------------------------------------------------
# Patch customtkinter before importing app_gui
# ---------------------------------------------------------------------------

import customtkinter  # noqa: E402
customtkinter.CTk = MockCTk
customtkinter.CTkFrame = MockCTkFrame
customtkinter.CTkLabel = MockCTkLabel
customtkinter.CTkButton = MockCTkButton
customtkinter.CTkEntry = MockCTkEntry
customtkinter.CTkToplevel = MockCTkToplevel
customtkinter.CTkProgressBar = MockCTkProgressBar
customtkinter.CTkOptionMenu = MockCTkOptionMenu
customtkinter.CTkScrollableFrame = MockCTkScrollableFrame
customtkinter.CTkSwitch = MockCTkSwitch

# Mock tkinter submodules
import tkinter as tk  # noqa: E402
tk.filedialog = type("fd", (), {"askopenfilename": lambda **kw: "", "askdirectory": lambda **kw: ""})()
tk.messagebox = type("mb", (), {"showerror": lambda t, m: None, "askyesno": lambda t, m: True})()


class MockStringVar:
    """Stand-in for tk.StringVar."""
    def __init__(self, value=""):
        self._v = value

    def get(self):
        return self._v

    def set(self, v):
        self._v = v


tk.StringVar = MockStringVar


# ---------------------------------------------------------------------------
# Import the symbols under test (after mocking)
# ---------------------------------------------------------------------------

# We reload the module to pick up our mocks
import importlib
import app_gui
importlib.reload(app_gui)

from app_gui import (
    _make_button,
    DEFAULT_BUTTON_HEIGHT,
    FONT_FAMILY,
    SettingsDialog,
)


# ---------------------------------------------------------------------------
# Test 1: FONT_FAMILY constant
# ---------------------------------------------------------------------------

def test_font_family_is_segoe_ui():
    """FR-709: FONT_FAMILY must be 'Segoe UI' for consistent Windows typography."""
    assert FONT_FAMILY == "Segoe UI", f"Expected FONT_FAMILY='Segoe UI', got {FONT_FAMILY!r}"


# ---------------------------------------------------------------------------
# Test 2: DEFAULT_BUTTON_HEIGHT constant
# ---------------------------------------------------------------------------

def test_default_button_height_is_36():
    """FR-708: DEFAULT_BUTTON_HEIGHT must be 36 to meet WCAG 2.5.5 touch target."""
    assert DEFAULT_BUTTON_HEIGHT == 36, (
        f"Expected DEFAULT_BUTTON_HEIGHT=36, got {DEFAULT_BUTTON_HEIGHT}"
    )


# ---------------------------------------------------------------------------
# Test 3: _make_button returns CTkButton instance
# ---------------------------------------------------------------------------

def test_make_button_returns_ctkbutton():
    """FR-708: _make_button must return a CTkButton instance."""
    btn = _make_button(None, "Test", lambda: None)
    assert isinstance(btn, MockCTkButton), (
        f"Expected MockCTkButton instance, got {type(btn).__name__}"
    )


# ---------------------------------------------------------------------------
# Test 4: _make_button applies default height of 36
# ---------------------------------------------------------------------------

def test_make_button_applies_default_height():
    """FR-708: Buttons created without explicit height must use DEFAULT_BUTTON_HEIGHT (36)."""
    btn = _make_button(None, "Test", lambda: None)
    height = btn.cget("height")
    assert height == DEFAULT_BUTTON_HEIGHT, (
        f"Expected height={DEFAULT_BUTTON_HEIGHT}, got {height}"
    )


# ---------------------------------------------------------------------------
# Test 5: _make_button explicit height overrides default
# ---------------------------------------------------------------------------

def test_make_button_explicit_height_overrides_default():
    """FR-708: Explicit height kwarg must override DEFAULT_BUTTON_HEIGHT."""
    btn = _make_button(None, "Test", lambda: None, height=50)
    height = btn.cget("height")
    assert height == 50, (
        f"Expected explicit height=50, got {height} (default not overridden)"
    )


# ---------------------------------------------------------------------------
# Test 6: No direct CTkButton(...) calls outside _make_button
# ---------------------------------------------------------------------------

def test_no_direct_ctkbutton_calls():
    """FR-708: All CTkButton instantiation must go through _make_button."""
    source_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "app_gui.py"
    )
    with open(source_path, encoding="utf-8") as fh:
        lines = fh.readlines()

    # Pattern matches CTkButton( that is NOT inside the _make_button definition
    # or inside the import line / docstring
    violations = []
    inside_make_button = False
    docstring_depth = 0

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Track docstring boundaries
        if '"""' in stripped or "'''" in stripped:
            docstring_depth ^= 1

        if stripped.startswith("def _make_button"):
            inside_make_button = True
        elif inside_make_button and stripped.startswith("def ") and "_make_button" not in stripped:
            inside_make_button = False

        # Skip import line
        if "from customtkinter import" in line:
            continue

        # Skip _make_button definition lines
        if inside_make_button:
            continue

        # Skip docstring lines
        if docstring_depth == 1:
            continue

        # Match CTkButton( outside allowed contexts
        if re.search(r"CTkButton\s*\(", line):
            violations.append(f"  Line {i}: {line.rstrip()}")

    assert not violations, (
        "Direct CTkButton(...) calls found outside _make_button:\n" +
        "\n".join(violations)
    )


# ---------------------------------------------------------------------------
# Test 7: All fonts use FONT_FAMILY, not ("", size)
# ---------------------------------------------------------------------------

def test_all_fonts_use_segoe_ui():
    """FR-709: No font tuples with empty string '' as family — all must use FONT_FAMILY."""
    source_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "app_gui.py"
    )
    with open(source_path, encoding="utf-8") as fh:
        content = fh.read()

    # Match font=('', ...) — empty string font family
    pattern = r'font\s*=\s*\(\s*["\'][\s]*["\'],'
    matches = list(re.finditer(pattern, content))

    assert len(matches) == 0, (
        f"Found {len(matches)} font tuple(s) with empty string family:\n" +
        "\n".join(
            f"  Line {content[:m.start()].count(chr(10)) + 1}: {m.group()}"
            for m in matches
        )
    )


# ---------------------------------------------------------------------------
# Test 8: SettingsDialog calls model_path_entry.focus_set()
# ---------------------------------------------------------------------------

def test_settings_dialog_focus_set_called():
    """FR-710: SettingsDialog.__init__ must call focus_set() on model_path_entry."""
    # Clear any lingering instances from prior tests
    MockCTkToplevel.instances.clear()

    settings = {
        "gguf_path": "test.gguf",
        "chunk_size": 500,
        "max_tokens": 512,
        "top_k": 5,
    }

    dialog = SettingsDialog(parent=None, current_settings=settings)

    # The mock entry's focus_set() must have been called
    assert hasattr(dialog, "model_path_entry"), (
        "model_path_entry not created on SettingsDialog"
    )
    assert dialog.model_path_entry.focus_called, (
        "model_path_entry.focus_set() was NOT called during SettingsDialog initialization. "
        "This violates FR-710 keyboard accessibility."
    )
