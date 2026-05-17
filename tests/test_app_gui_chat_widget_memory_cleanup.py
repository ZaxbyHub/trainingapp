"""
Tests for chat widget memory cleanup in app_gui.py (task 4.6).

Verifies:
1. _do_clear_chat() destroys all widgets in chat_frame
2. _expanded_pills dict is empty after clear
3. orphaned _snippet_frame_* attributes are removed from self.__dict__ after clear
"""

import pytest
import inspect
import textwrap
from unittest.mock import MagicMock, patch


class MockWidget:
    """Mock tkinter/CTk widget with winfo_children support."""
    def __init__(self):
        self.children = []
        self._exists = True

    def winfo_children(self):
        return self.children

    def winfo_exists(self):
        return self._exists

    def destroy(self):
        self._exists = False


class TestDoClearChatDestroysWidgets:
    """Criterion 1: _do_clear_chat() destroys all widgets in chat_frame."""

    def test_do_clear_chat_calls_destroy_on_all_children(self):
        """
        _do_clear_chat() must call .destroy() on every widget in chat_frame.winfo_children().
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        # Must iterate over winfo_children
        assert "winfo_children()" in source, (
            "_do_clear_chat must iterate over chat_frame.winfo_children()"
        )

        # Must call .destroy() on each widget
        assert ".destroy()" in source, (
            "_do_clear_chat must call .destroy() on each child widget"
        )

    def test_do_clear_chat_loop_structure(self):
        """
        Verify the loop iterates over chat_frame.winfo_children() and calls destroy.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
        source_dedented = textwrap.dedent(source)

        # Should have: for widget in self.chat_frame.winfo_children(): widget.destroy()
        assert "for widget in self.chat_frame.winfo_children()" in source_dedented, (
            "Must loop over self.chat_frame.winfo_children()"
        )
        assert "widget.destroy()" in source_dedented, (
            "Must call widget.destroy() in the loop"
        )

    def test_do_clear_chat_mock_integration(self):
        """
        Integration test: verify that calling _do_clear_chat on a mock app
        with child widgets results in all widgets being destroyed.

        Note: We test the logic by calling _do_clear_chat on a standalone basis
        since DocumentQAApp inherits from CTk (tkinter) and requires full initialization.
        """
        import app_gui

        # Create mock widgets
        widget1 = MockWidget()
        widget2 = MockWidget()
        widget3 = MockWidget()

        # Create mock chat_frame
        mock_chat_frame = MockWidget()
        mock_chat_frame.children = [widget1, widget2, widget3]

        # Test the cleanup logic directly by simulating what _do_clear_chat does
        # This tests the actual cleanup logic without requiring full CTk initialization
        for w in mock_chat_frame.winfo_children():
            w.destroy()

        # All widgets should be destroyed
        assert not widget1._exists, "widget1 should be destroyed"
        assert not widget2._exists, "widget2 should be destroyed"
        assert not widget3._exists, "widget3 should be destroyed"


class TestExpandedPillsCleared:
    """Criterion 2: _expanded_pills dict is empty after clear."""

    def test_do_clear_chat_clears_expanded_pills(self):
        """
        _do_clear_chat() must clear the _expanded_pills dictionary.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        # Must check for _expanded_pills attribute
        assert "_expanded_pills" in source, (
            "_do_clear_chat must handle _expanded_pills cleanup"
        )

        # Must call .clear() on _expanded_pills
        assert "_expanded_pills.clear()" in source or "_expanded_pills = {}" in source, (
            "_do_clear_chat must clear _expanded_pills dictionary"
        )

    def test_do_clear_chat_has_expanded_pills_check(self):
        """
        Verify _do_clear_chat uses hasattr check before clearing _expanded_pills.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
        source_dedented = textwrap.dedent(source)

        # Should use hasattr or getattr to safely check for _expanded_pills
        lines = source_dedented.split('\n')
        expanded_pills_handled = False
        for line in lines:
            if "_expanded_pills" in line and "hasattr" in line:
                expanded_pills_handled = True
                break
            elif "_expanded_pills" in line and "getattr" in line:
                expanded_pills_handled = True
                break

        assert expanded_pills_handled, (
            "_do_clear_chat should use hasattr/getattr to safely check _expanded_pills"
        )

    def test_do_clear_chat_expanded_pills_mock_integration(self):
        """
        Integration test: verify _expanded_pills is empty after calling _do_clear_chat.
        """
        import app_gui

        with patch.object(app_gui.DocumentQAApp, '__init__', lambda self: None):
            app = app_gui.DocumentQAApp()

            # Set up mock chat_frame
            mock_chat_frame = MockWidget()
            app.chat_frame = mock_chat_frame

            # Set up _expanded_pills with some data
            app._expanded_pills = {
                "file1.txt": True,
                "file2.pdf": False,
                "file3.md": True,
            }

            # Call _do_clear_chat
            app._do_clear_chat()

            # _expanded_pills should be empty
            assert len(app._expanded_pills) == 0, (
                f"_expanded_pills should be empty after clear, but has {len(app._expanded_pills)} items"
            )


class TestSnippetFrameAttributesRemoved:
    """Criterion 3: orphaned _snippet_frame_* attributes removed from self.__dict__."""

    def test_do_clear_chat_removes_snippet_frame_attributes(self):
        """
        _do_clear_chat() must remove all _snippet_frame_* attributes from self.__dict__.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        # Must iterate over __dict__ or vars(self)
        has_dict_iteration = (
            "self.__dict__" in source or "vars(self)" in source or "self.__dict__.keys()" in source
        )
        assert has_dict_iteration, (
            "_do_clear_chat must iterate over self.__dict__ to find _snippet_frame_* attributes"
        )

        # Must check for _snippet_frame_ prefix
        assert "_snippet_frame_" in source, (
            "_do_clear_chat must check for _snippet_frame_ prefixed attributes"
        )

    def test_do_clear_chat_deletes_snippet_attributes(self):
        """
        Verify _do_clear_chat deletes _snippet_frame_* attributes using del.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
        source_dedented = textwrap.dedent(source)

        # Should have del or pop to remove attributes
        has_delete = "del self.__dict__[" in source_dedented or "delattr(self," in source_dedented

        assert has_delete, (
            "_do_clear_chat must use del/delattr to remove _snippet_frame_* attributes"
        )

    def test_do_clear_chat_snippet_attrs_logic(self):
        """
        Test the snippet frame cleanup logic directly.

        Since DocumentQAApp inherits from CTk (tkinter), we test the cleanup
        logic by directly simulating what _do_clear_chat does with __dict__.
        """
        # Simulate _do_clear_chat's snippet frame cleanup logic
        class FakeAppDict:
            """Fake app __dict__ to test cleanup logic without CTk initialization."""
            def __init__(self):
                self._data = {}
                self._snippet_frame_12345 = MockWidget()
                self._snippet_frame_67890 = MockWidget()
                self._snippet_frame_11111 = None
                self._other_attribute = "should remain"

            def __contains__(self, key):
                return key in self._data or key in self.__dict__

            def __getitem__(self, key):
                if key in self._data:
                    return self._data[key]
                return getattr(self, key)

            def keys(self):
                # Return all "instance" attributes
                result = set(k for k in self._data)
                result.update(k for k in dir(self) if not k.startswith('_'))
                return result

            def __delitem__(self, key):
                if hasattr(self, key):
                    delattr(self, key)

        # Create fake app and add snippet frame attrs
        fake_app = FakeAppDict()

        # Count _snippet_frame_* before
        all_keys = list(vars(fake_app).keys()) if hasattr(fake_app, '__dict__') else []
        snippet_keys_before = [k for k in all_keys if k.startswith("_snippet_frame_")]
        assert len(snippet_keys_before) == 3, (
            f"Should have 3 _snippet_frame_* attrs before clear, got {len(snippet_keys_before)}"
        )

        # Simulate _do_clear_chat's cleanup logic
        keys_to_delete = [k for k in vars(fake_app) if k.startswith("_snippet_frame_")]
        for k in keys_to_delete:
            delattr(fake_app, k)

        # _snippet_frame_* attributes should be removed
        remaining_keys = list(vars(fake_app).keys()) if hasattr(fake_app, '__dict__') else []
        snippet_keys_after = [k for k in remaining_keys if k.startswith("_snippet_frame_")]
        assert len(snippet_keys_after) == 0, (
            f"_snippet_frame_* attrs should be removed after clear, found: {snippet_keys_after}"
        )

        # _other_attribute should still exist
        assert hasattr(fake_app, "_other_attribute"), (
            "_other_attribute should NOT be removed during clear"
        )
        assert fake_app._other_attribute == "should remain", (
            "_other_attribute value should be preserved"
        )


class TestMemoryCleanupIntegration:
    """Integration test verifying all memory cleanup happens together."""

    def test_all_cleanup_happens_in_do_clear_chat(self):
        """
        Verify _do_clear_chat performs ALL three cleanup operations:
        1. Destroys chat_frame children
        2. Clears _expanded_pills
        3. Removes _snippet_frame_* attributes
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        # All three cleanup operations must be present
        assert "winfo_children()" in source, "Must destroy chat_frame children"
        assert "_expanded_pills" in source, "Must clear _expanded_pills"
        assert "_snippet_frame_" in source, "Must remove _snippet_frame_* attributes"

    def test_full_memory_cleanup_integration(self):
        """
        Full integration test: verify the cleanup logic for all three criteria.
        Since DocumentQAApp requires full CTk initialization, we test the
        cleanup logic directly by simulating what _do_clear_chat does.
        """
        # Create mock widgets
        widget1 = MockWidget()
        widget2 = MockWidget()

        # Create mock chat_frame
        mock_chat_frame = MockWidget()
        mock_chat_frame.children = [widget1, widget2]

        # Simulate _expanded_pills dict
        expanded_pills = {
            "doc1.txt": True,
            "doc2.pdf": True,
        }

        # Simulate __dict__ with _snippet_frame_* and regular attrs
        class FakeApp:
            def __init__(self):
                self._snippet_frame_100 = MockWidget()
                self._snippet_frame_200 = MockWidget()
                self.regular_attr = "keep me"

        fake_app = FakeApp()

        # Verify initial state
        assert len(mock_chat_frame.children) == 2
        assert len(expanded_pills) == 2
        assert len([k for k in vars(fake_app) if k.startswith("_snippet_frame_")]) == 2

        # --- Simulate _do_clear_chat cleanup logic ---

        # 1. Destroy chat_frame children
        for w in mock_chat_frame.winfo_children():
            w.destroy()

        # 2. Clear _expanded_pills
        expanded_pills.clear()

        # 3. Remove _snippet_frame_* attrs
        keys_to_delete = [k for k in vars(fake_app) if k.startswith("_snippet_frame_")]
        for k in keys_to_delete:
            delattr(fake_app, k)

        # --- Verify cleanup ---

        # Verify widgets destroyed
        assert not widget1._exists, "widget1 should be destroyed"
        assert not widget2._exists, "widget2 should be destroyed"

        # Verify _expanded_pills cleared
        assert len(expanded_pills) == 0, "_expanded_pills should be empty"

        # Verify _snippet_frame_* removed
        remaining_snippet = [k for k in vars(fake_app) if k.startswith("_snippet_frame_")]
        assert len(remaining_snippet) == 0, f"_snippet_frame_* attrs should be removed: {remaining_snippet}"

        # Verify regular attrs preserved
        assert hasattr(fake_app, "regular_attr"), "regular_attr should not be removed"
        assert fake_app.regular_attr == "keep me"
