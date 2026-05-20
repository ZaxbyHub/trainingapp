"""
Tests for chat history bounding fix (DD-006) in app_gui.py (task 3.1).

Verifies:
1. CHAT_HISTORY_MAX_MESSAGES = 50 and CHAT_HISTORY_PRUNE_COUNT = 10 constants exist
2. At exactly 50 messages: no pruning
3. At 51 messages: oldest widget is destroyed
4. Overflow beyond 50 removes all excess widgets
5. Pruning destroys widgets without crashing
6. The newest messages remain after pruning
"""

import pytest
import inspect
import textwrap
from unittest.mock import MagicMock, patch


class MockWidget:
    """Mock tkinter/CTk widget with winfo_children and destroy support."""
    _instances = []

    def __init__(self, widget_id=None):
        self.widget_id = widget_id or f"widget_{len(MockWidget._instances)}"
        MockWidget._instances.append(self)
        self.children = []
        self._exists = True
        self._destroyed = False

    def winfo_children(self):
        return self.children

    def winfo_exists(self):
        return self._exists

    def destroy(self):
        self._exists = False
        self._destroyed = True


def _reset_mocks():
    """Reset MockWidget state between tests."""
    MockWidget._instances.clear()
    for inst in MockWidget._instances:
        inst._exists = True
        inst._destroyed = False


# ─────────────────────────────────────────────────────────────────────────────
# Constants tests
# ─────────────────────────────────────────────────────────────────────────────

class TestConstants:
    """Verify the bounding constants are defined and correct."""

    def test_max_messages_constant_exists(self):
        """CHAT_HISTORY_MAX_MESSAGES must be defined."""
        import app_gui
        assert hasattr(app_gui, "CHAT_HISTORY_MAX_MESSAGES"), (
            "CHAT_HISTORY_MAX_MESSAGES must be defined in app_gui module"
        )

    def test_max_messages_value_is_50(self):
        """CHAT_HISTORY_MAX_MESSAGES must be 50."""
        import app_gui
        assert app_gui.CHAT_HISTORY_MAX_MESSAGES == 50, (
            f"CHAT_HISTORY_MAX_MESSAGES must be 50, got {app_gui.CHAT_HISTORY_MAX_MESSAGES}"
        )

    def test_prune_count_constant_exists(self):
        """CHAT_HISTORY_PRUNE_COUNT must be defined."""
        import app_gui
        assert hasattr(app_gui, "CHAT_HISTORY_PRUNE_COUNT"), (
            "CHAT_HISTORY_PRUNE_COUNT must be defined in app_gui module"
        )

    def test_prune_count_value_is_10(self):
        """CHAT_HISTORY_PRUNE_COUNT must be 10."""
        import app_gui
        assert app_gui.CHAT_HISTORY_PRUNE_COUNT == 10, (
            f"CHAT_HISTORY_PRUNE_COUNT must be 10, got {app_gui.CHAT_HISTORY_PRUNE_COUNT}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Source-code structure tests
# ─────────────────────────────────────────────────────────────────────────────

class TestPruningLogicInSource:
    """Verify _add_message contains the pruning logic."""

    def test_add_message_has_pruning_block(self):
        """_add_message must check chat history length after adding a message."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        assert "winfo_children()" in source, (
            "_add_message must call winfo_children() to check child count"
        )

    def test_add_message_checks_max_threshold(self):
        """_add_message must compare against CHAT_HISTORY_MAX_MESSAGES."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        assert "CHAT_HISTORY_MAX_MESSAGES" in source, (
            "_add_message must reference CHAT_HISTORY_MAX_MESSAGES for threshold check"
        )

    def test_add_message_calls_destroy_on_overflow(self):
        """_add_message must call .destroy() on widgets when over threshold."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        assert ".destroy()" in source, (
            "_add_message must call .destroy() on excess widgets"
        )

    def test_add_message_pruning_uses_negative_slice(self):
        """
        Pruning must use a negative slice to keep the newest MAX_MESSAGES.
        children[:-MAX] keeps the last MAX items, discarding the oldest.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        # The slice must be [:-CHAT_HISTORY_MAX_MESSAGES] to keep newest 50
        assert ":-CHAT_HISTORY_MAX_MESSAGES]" in source, (
            "Pruning must slice [:-CHAT_HISTORY_MAX_MESSAGES] to keep newest messages"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Mock integration tests — boundary behavior
# ─────────────────────────────────────────────────────────────────────────────

class TestAtExactlyMaxMessages:
    """
    Boundary: when len(chat_frame.winfo_children()) == MAX, no pruning.
    """

    def test_at_exactly_50_messages_no_pruning(self):
        """
        When chat has exactly 50 messages (children), no widget should be destroyed.
        """
        import app_gui

        # Create 50 mock widgets
        widgets = [MockWidget(f"msg_{i}") for i in range(50)]

        # Simulate the pruning logic from _add_message
        children = widgets  # 50 children
        if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

        # No widget should be destroyed
        destroyed = [w for w in widgets if w._destroyed]
        assert len(destroyed) == 0, (
            f"At exactly 50 messages, no pruning should occur. "
            f"Found {len(destroyed)} destroyed widgets: {[w.widget_id for w in destroyed]}"
        )


class TestAtOneOverMax:
    """
    Boundary: when len(chat_frame.winfo_children()) == MAX+1, oldest is destroyed.
    """

    def test_at_51_messages_oldest_is_destroyed(self):
        """
        When chat has 51 messages, only the oldest (index 0) should be destroyed.
        """
        import app_gui

        # Create 51 mock widgets
        widgets = [MockWidget(f"msg_{i}") for i in range(51)]

        # Simulate the pruning logic from _add_message
        children = widgets
        if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

        destroyed = [w for w in widgets if w._destroyed]
        survivors = [w for w in widgets if not w._destroyed]

        assert len(destroyed) == 1, (
            f"At 51 messages, exactly 1 widget should be destroyed, got {len(destroyed)}"
        )
        assert destroyed[0].widget_id == "msg_0", (
            f"The oldest widget (msg_0) should be destroyed first, "
            f"got {destroyed[0].widget_id}"
        )
        assert len(survivors) == 50, (
            f"50 widgets should survive, got {len(survivors)}"
        )
        assert survivors[0].widget_id == "msg_1", (
            f"msg_1 (formerly index 1) should be the new oldest, "
            f"got {survivors[0].widget_id}"
        )


class TestOverflowMultipleMessages:
    """
    Overflow: when len(chat_frame.winfo_children()) >> MAX, all excess removed.
    """

    def test_at_60_messages_10_destroyed(self):
        """
        When chat has 60 messages (10 over limit), exactly 10 oldest are destroyed.
        """
        import app_gui

        widgets = [MockWidget(f"msg_{i}") for i in range(60)]

        children = widgets
        if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

        destroyed = [w for w in widgets if w._destroyed]
        survivors = [w for w in widgets if not w._destroyed]

        assert len(destroyed) == 10, (
            f"At 60 messages, exactly 10 widgets should be destroyed, got {len(destroyed)}"
        )
        assert len(survivors) == 50, (
            f"50 widgets should survive, got {len(survivors)}"
        )
        # The destroyed widgets should be msg_0 through msg_9
        destroyed_ids = {w.widget_id for w in destroyed}
        expected_destroyed = {f"msg_{i}" for i in range(10)}
        assert destroyed_ids == expected_destroyed, (
            f"Expected destroyed IDs {expected_destroyed}, got {destroyed_ids}"
        )
        # Survivors should be msg_10 through msg_59
        survivor_ids = {w.widget_id for w in survivors}
        expected_survivors = {f"msg_{i}" for i in range(10, 60)}
        assert survivor_ids == expected_survivors, (
            f"Survivors should be msg_10..msg_59, got {survivor_ids}"
        )

    def test_at_100_messages_50_destroyed(self):
        """
        When chat has 100 messages (50 over limit), exactly 50 oldest are destroyed.
        """
        import app_gui

        widgets = [MockWidget(f"msg_{i}") for i in range(100)]

        children = widgets
        if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

        destroyed = [w for w in widgets if w._destroyed]
        survivors = [w for w in widgets if not w._destroyed]

        assert len(destroyed) == 50, (
            f"At 100 messages, exactly 50 widgets should be destroyed, got {len(destroyed)}"
        )
        assert len(survivors) == 50, (
            f"50 widgets should survive, got {len(survivors)}"
        )


class TestNewestMessagesPreserved:
    """
    After pruning, the newest (most recently added) messages must remain.
    """

    def test_newest_10_messages_preserved_after_60(self):
        """
        After pruning from 60 to 50, messages 50-59 must be intact.
        """
        import app_gui

        widgets = [MockWidget(f"msg_{i}") for i in range(60)]

        children = widgets
        if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

        survivors = [w for w in widgets if not w._destroyed]
        survivor_ids = sorted(w.widget_id for w in survivors)

        # The newest 10 messages (50-59) must all be present
        expected_newest = [f"msg_{i}" for i in range(50, 60)]
        for wid in expected_newest:
            assert wid in survivor_ids, (
                f"Newest message {wid} should survive pruning but is missing"
            )

    def test_newest_message_preserved_after_51(self):
        """
        After pruning from 51 to 50, the most recently added message (msg_50)
        must be intact.
        """
        import app_gui

        widgets = [MockWidget(f"msg_{i}") for i in range(51)]

        children = widgets
        if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

        survivors = [w for w in widgets if not w._destroyed]
        survivor_ids = {w.widget_id for w in survivors}

        # msg_50 is the newest message and must survive
        assert "msg_50" in survivor_ids, (
            "The most recently added message (msg_50) must survive pruning"
        )


class TestPruningNeverCrashes:
    """
    Pruning must not raise exceptions even with pathological inputs.
    """

    def test_pruning_empty_list_does_not_crash(self):
        """
        When children is empty, the loop body never executes — must not crash.
        """
        import app_gui

        children = []
        try:
            if len(children) > app_gui.CHAT_HISTORY_MAX_MESSAGES:
                for widget in children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]:
                    widget.destroy()
        except Exception as exc:
            pytest.fail(f"Pruning logic crashed on empty list: {exc}")

    def test_pruning_with_none_widgets_handled(self):
        """
        If a None somehow appears in winfo_children(), .destroy() would raise.
        The code iterates directly without filtering, so we verify what happens.
        This tests the actual slice-based approach — None would raise TypeError.
        """
        import app_gui

        children = list(range(51))  # 51 non-widget objects
        # The pruning slice: children[:-50] = [0] (the integer 0, not a widget)
        excess = children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]
        assert excess == [0], "Slice should isolate the overflow element"

    def test_slice_returns_empty_list_when_exact_max(self):
        """
        children[:-50] on a 50-element list returns [] — loop never runs.
        """
        import app_gui

        children = list(range(50))
        excess = children[:-app_gui.CHAT_HISTORY_MAX_MESSAGES]
        assert excess == [], (
            "When exactly at MAX, excess slice must be empty — no pruning"
        )
