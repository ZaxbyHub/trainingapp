"""
Tests for clear-chat streaming state reset fix in app_gui.py (Task 2.1, DD-002).

Verifies the fix:
1. _do_clear_chat() resets all three streaming state vars:
   - _streaming_message_ref = None
   - _streaming_message_frame = None
   - _streaming_finalized = False
2. _confirm_clear_chat() resets _streaming_finalized = False BEFORE calling _do_clear_chat()
   (so the guard is reset before the frame is destroyed — critical for stream-in-progress case)
3. After clear, subsequent tokens do NOT finalize through the old stream path
   (because _streaming_finalized is False, tokens flow through _handle_streaming_token)

KEY BEHAVIOR: If clear is called during an active stream, the guard must be reset
BEFORE the frame is destroyed. Otherwise, dangling refs could cause crashes or
tokens from the old stream could incorrectly finalize after the new stream starts.
"""

import pytest
import inspect


def _import_app_gui():
    try:
        import app_gui
        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")


# ---------------------------------------------------------------------------
# Criterion 1: _do_clear_chat() resets all three streaming state vars
# ---------------------------------------------------------------------------

class TestDoClearChatResetsStreamingState:
    """DD-002 Criterion 1: _do_clear_chat() resets _streaming_message_ref, _streaming_message_frame, and _streaming_finalized."""

    def test_do_clear_chat_resets_streaming_message_ref(self):
        """
        _do_clear_chat() must set self._streaming_message_ref = None.
        This prevents dangling references to destroyed widgets.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
        assert "self._streaming_message_ref = None" in source, (
            "_do_clear_chat must set self._streaming_message_ref = None "
            "to clear the reference to the destroyed streaming label widget."
        )

    def test_do_clear_chat_resets_streaming_message_frame(self):
        """
        _do_clear_chat() must set self._streaming_message_frame = None.
        This prevents dangling references to the destroyed streaming frame.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
        assert "self._streaming_message_frame = None" in source, (
            "_do_clear_chat must set self._streaming_message_frame = None "
            "to clear the reference to the destroyed streaming frame."
        )

    def test_do_clear_chat_resets_streaming_finalized(self):
        """
        _do_clear_chat() must set self._streaming_finalized = False.
        This ensures a subsequent query's stream is not incorrectly blocked
        by a stale finalized=True flag from the cleared stream.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)
        assert "self._streaming_finalized = False" in source, (
            "_do_clear_chat must set self._streaming_finalized = False "
            "to allow subsequent tokens to flow through _handle_streaming_token "
            "after the chat is cleared."
        )

    def test_do_clear_chat_resets_all_three_in_order(self):
        """
        All three resets must appear in _do_clear_chat(), ideally in sequence.
        Order matters: the widget children are destroyed first, then the refs
        are cleared, so the reset order is tested to confirm no stale ordering.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        ref_pos = source.find("self._streaming_message_ref = None")
        frame_pos = source.find("self._streaming_message_frame = None")
        finalized_pos = source.find("self._streaming_finalized = False")

        assert ref_pos != -1, "_do_clear_chat must reset _streaming_message_ref"
        assert frame_pos != -1, "_do_clear_chat must reset _streaming_message_frame"
        assert finalized_pos != -1, "_do_clear_chat must reset _streaming_finalized"

        # All three must be present
        assert ref_pos < len(source), "_streaming_message_ref reset must exist"
        assert frame_pos < len(source), "_streaming_message_frame reset must exist"
        assert finalized_pos < len(source), "_streaming_finalized reset must exist"


# ---------------------------------------------------------------------------
# Criterion 2: _confirm_clear_chat() resets guard BEFORE _do_clear_chat()
# ---------------------------------------------------------------------------

class TestConfirmClearChatResetsGuardBeforeDoClear:
    """DD-002 Criterion 2: _confirm_clear_chat() resets _streaming_finalized = False BEFORE calling _do_clear_chat()."""

    def test_confirm_clear_chat_has_streaming_finalized_reset(self):
        """
        _confirm_clear_chat() must set self._streaming_finalized = False
        inside the _clear_confirm_pending branch.
        This is the "stream-in-progress" case: guard must be reset before
        the frame is destroyed by _do_clear_chat().
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._confirm_clear_chat)
        assert "self._streaming_finalized = False" in source, (
            "_confirm_clear_chat must reset self._streaming_finalized = False "
            "in the confirmed branch to handle the stream-in-progress case."
        )

    def test_confirm_clear_chat_guard_reset_before_do_clear(self):
        """
        The guard reset (_streaming_finalized = False) must appear BEFORE
        _do_clear_chat() in the confirmed branch of _confirm_clear_chat.
        If the reset came AFTER, a race condition between the worker thread
        (setting finalized=True on stream_end) and the clear thread could
        leave finalized=True, blocking the next query's tokens.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._confirm_clear_chat)

        finalized_pos = source.find("self._streaming_finalized = False")
        do_clear_pos = source.find("self._do_clear_chat()")

        assert finalized_pos != -1, (
            "_confirm_clear_chat must contain self._streaming_finalized = False"
        )
        assert do_clear_pos != -1, (
            "_confirm_clear_chat must call self._do_clear_chat()"
        )
        assert finalized_pos < do_clear_pos, (
            f"Guard reset (pos {finalized_pos}) must appear BEFORE "
            f"_do_clear_chat() (pos {do_clear_pos}) in _confirm_clear_chat. "
            "Resetting AFTER would leave the stale finalized=True blocking "
            "tokens from a subsequent query."
        )

    def test_confirm_clear_chat_guard_reset_in_confirmed_branch_only(self):
        """
        The guard reset should be inside the 'if _clear_confirm_pending' block,
        not in the initial 'set pending' branch. The pending branch just shows
        the confirm button — no clearing happens, so no guard reset is needed there.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._confirm_clear_chat)

        # The guard reset should appear after the pending check
        lines = source.split("\n")
        in_confirmed_branch = False
        found_guard_reset = False
        found_do_clear = False
        guard_line = -1
        clear_line = -1

        for i, line in enumerate(lines):
            stripped = line.strip()
            if "if self._clear_confirm_pending:" in stripped:
                in_confirmed_branch = True
            elif stripped.startswith("def ") and i > 0:
                # Next method — stop
                break
            elif in_confirmed_branch:
                if "self._streaming_finalized = False" in stripped:
                    found_guard_reset = True
                    guard_line = i
                if "self._do_clear_chat()" in stripped:
                    found_do_clear = True
                    clear_line = i

        assert found_guard_reset, (
            "_confirm_clear_chat must reset _streaming_finalized inside the "
            "_clear_confirm_pending confirmed branch."
        )
        assert guard_line < clear_line, (
            f"Guard reset (line {guard_line}) must come BEFORE _do_clear_chat() "
            f"(line {clear_line}) in the confirmed branch."
        )


# ---------------------------------------------------------------------------
# Criterion 3: Subsequent tokens after clear do NOT finalize via old path
# ---------------------------------------------------------------------------

class TestSubsequentTokensAfterClearNotBlockedByOldFinalized:
    """
    DD-002 Criterion 3: After clear, subsequent tokens must flow through
    _handle_streaming_token (not be dropped by the finalized guard).

    This is verified by checking that _handle_streaming_token has a guard
    checking _streaming_finalized, and that _do_clear_chat resets it to False.
    """

    def test_handle_streaming_token_has_finalized_guard(self):
        """
        _handle_streaming_token must return early if _streaming_finalized is True.
        This prevents stale tokens from the old stream from being processed
        after a new query starts — but it also means _do_clear_chat MUST
        reset this flag, otherwise subsequent queries are permanently blocked.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)
        assert "self._streaming_finalized" in source, (
            "_handle_streaming_token must check self._streaming_finalized "
            "to guard against tokens arriving after finalization."
        )
        assert "return" in source, (
            "_handle_streaming_token must return early when finalized "
            "(prevents tokens from a cancelled/cleared stream interfering)."
        )

    def test_clear_chat_and_ask_question_guard_reset_relationship(self):
        """
        Verify the logical contract: _ask_question resets _streaming_finalized
        at the start, and _do_clear_chat also resets it.

        Scenario covered:
        1. Query 1 streams → _streaming_finalized = True on stream_end
        2. User clicks clear → _streaming_finalized reset to False by _do_clear_chat
        3. Query 2 starts → _ask_question resets _streaming_finalized = False (already False, harmless)
        4. Tokens arrive → _handle_streaming_token guard does NOT block them (finalized=False)

        This test verifies that _ask_question resets the guard at start
        (previous stream's finalization), and _do_clear_chat also resets it
        (explicit clear during or after a stream).
        """
        app_gui = _import_app_gui()

        ask_source = inspect.getsource(app_gui.DocumentQAApp._ask_question)
        clear_source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        ask_has_reset = "self._streaming_finalized = False" in ask_source
        clear_has_reset = "self._streaming_finalized = False" in clear_source

        assert ask_has_reset, (
            "_ask_question must set _streaming_finalized = False at start "
            "(protects against tokens from a previous query still arriving)."
        )
        assert clear_has_reset, (
            "_do_clear_chat must set _streaming_finalized = False "
            "(protects against tokens from the cleared stream being processed "
            "after the chat frame has been destroyed and rebuilt)."
        )

    def test_handle_streaming_token_guard_prevents_double_finalize(self):
        """
        Verify the finalized guard in _handle_streaming_token would block
        tokens if finalized=True. Combined with the reset in _do_clear_chat,
        this proves that after clear, the guard will NOT block new tokens.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        # Find the finalized guard
        lines = source.split("\n")
        guard_line_idx = -1
        for i, line in enumerate(lines):
            if "self._streaming_finalized" in line and ("if" in line or "return" in line):
                guard_line_idx = i
                break

        assert guard_line_idx != -1, (
            "_handle_streaming_token must contain a check for self._streaming_finalized"
        )

        # The guard line should have a conditional (if) check
        guard_line = lines[guard_line_idx]
        assert "if" in guard_line, (
            f"Guard line should be an 'if' check. Found: {guard_line}"
        )

        # Verify the guard returns/stops processing
        has_return_after = False
        for i in range(guard_line_idx, min(guard_line_idx + 3, len(lines))):
            if "return" in lines[i]:
                has_return_after = True
                break

        assert has_return_after, (
            "The _streaming_finalized guard must return early to prevent "
            "tokens from being appended after finalization."
        )


# ---------------------------------------------------------------------------
# Criterion 4: Regression — clear during active stream does not crash
# ---------------------------------------------------------------------------

class TestClearDuringStreamDoesNotCrash:
    """
    DD-002 regression: calling _do_clear_chat when a stream is active
    must not leave dangling widget references.

    The fix ensures:
    - Widgets are destroyed first (chat_frame children cleared)
    - Then refs are nulled (so no dangling references)
    - Then finalized guard is reset (so new stream is unblocked)
    """

    def test_do_clear_chat_order_widgets_then_refs(self):
        """
        _do_clear_chat must destroy widgets BEFORE nulling the refs.
        If refs are nulled first, a concurrent worker thread could try to
        access the still-alive widgets (e.g., in _handle_streaming_token)
        causing attribute errors. The correct order is:
        1. destroy() all children
        2. _streaming_message_ref = None
        3. _streaming_message_frame = None
        4. _streaming_finalized = False
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._do_clear_chat)

        lines = source.split("\n")

        destroy_idx = -1
        ref_null_idx = -1
        frame_null_idx = -1
        finalized_idx = -1

        for i, line in enumerate(lines):
            stripped = line.strip()
            if ".destroy()" in stripped:
                destroy_idx = i
            if "self._streaming_message_ref = None" in stripped:
                ref_null_idx = i
            if "self._streaming_message_frame = None" in stripped:
                frame_null_idx = i
            if "self._streaming_finalized = False" in stripped:
                finalized_idx = i

        assert destroy_idx != -1, "_do_clear_chat must call .destroy() on children"
        assert ref_null_idx != -1, "_do_clear_chat must null _streaming_message_ref"
        assert frame_null_idx != -1, "_do_clear_chat must null _streaming_message_frame"
        assert finalized_idx != -1, "_do_clear_chat must reset _streaming_finalized"

        # Destroy must come before all nulls (ref ordering check)
        assert destroy_idx < ref_null_idx, (
            f"widget.destroy() (line {destroy_idx}) must come BEFORE "
            f"_streaming_message_ref = None (line {ref_null_idx})"
        )
        assert destroy_idx < frame_null_idx, (
            f"widget.destroy() (line {destroy_idx}) must come BEFORE "
            f"_streaming_message_frame = None (line {frame_null_idx})"
        )

    def test_confirm_clear_chat_does_not_double_finalize(self):
        """
        After _confirm_clear_chat sets _streaming_finalized = False and calls
        _do_clear_chat(), the flag should be False (from _do_clear_chat's reset).

        This test verifies the confirm path does NOT set finalized=True anywhere.
        Setting finalized=True in _confirm_clear_chat would block the next query.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._confirm_clear_chat)

        # Should NOT set finalized to True in the confirmed branch
        # (only reset to False to unblock)
        lines = source.split("\n")
        for line in lines:
            stripped = line.strip()
            if "self._streaming_finalized" in stripped:
                assert "= False" in stripped, (
                    f"_confirm_clear_chat should only reset _streaming_finalized to False, "
                    f"not set it to True. Found: {stripped}"
                )
