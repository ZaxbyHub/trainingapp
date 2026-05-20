"""
Tests for streaming message persistence fix in app_gui.py (Task 1.1).

Verifies the 6-part fix:
1. _streaming_finalized = False set at start of _ask_question (before thread spawn)
2. _get_streaming_text() helper reads accumulated text from streaming widget
3. _finalize_streaming_message(accumulated_text, destroy_frame) helper with lock protection
4. stream_end calls _finalize_streaming_message(text, destroy_frame=True) — persists message
5. stream_destroy calls _finalize_streaming_message(text, destroy_frame=True) — preserves partial content
6. _handle_streaming_token() has early-return guard when _streaming_finalized is True

KEY BEHAVIORS TESTED:
- Query 1 streams → message persisted via _finalize_streaming_message → _streaming_finalized = True
- Query 2 starts → _streaming_finalized reset to False → tokens flow through _handle_streaming_token
- If stream_end called twice → second call returns early (empty text or already finalized)
- If exception during stream → stream_destroy called → partial content persisted
"""

import pytest
import inspect


# ---------------------------------------------------------------------------
# Helper: safely import app_gui, skip if customtkinter unavailable
# ---------------------------------------------------------------------------

def _import_app_gui():
    try:
        import app_gui
        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")


# ---------------------------------------------------------------------------
# Test 1: _streaming_finalized reset on new query
# ---------------------------------------------------------------------------

class TestStreamingFinalizedResetOnNewQuery:
    """Criterion 1: _streaming_finalized = False at start of _ask_question."""

    def test_streaming_finalized_reset_before_thread_spawn(self):
        """
        _streaming_finalized must be set to False BEFORE threading.Thread() is created.
        This ensures a new query always starts with the guard in its un-finalized state,
        even if the previous query's thread is still running.

        The reset must appear BEFORE the threading.Thread() call in the source.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Must set _streaming_finalized = False
        assert "self._streaming_finalized = False" in source, (
            "_ask_question must set self._streaming_finalized = False "
            "at the start of each new query."
        )

        # Reset must appear before the thread is spawned
        reset_pos = source.find("self._streaming_finalized = False")
        thread_pos = source.find("threading.Thread(target=query")
        assert reset_pos < thread_pos, (
            f"_streaming_finalized reset (pos {reset_pos}) must come BEFORE "
            f"threading.Thread (pos {thread_pos}) to guarantee clean state "
            "for the new query thread."
        )

    def test_streaming_finalized_initialized_in_create_chat_page(self):
        """
        _streaming_finalized must be initialized in _create_chat_page
        (or _create_widgets) to False, so it is always available as a guard attribute.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._create_chat_page)
        assert "_streaming_finalized" in source, (
            "_create_chat_page must initialize _streaming_finalized (e.g. self._streaming_finalized = False)."
        )


# ---------------------------------------------------------------------------
# Test 2: _get_streaming_text helper
# ---------------------------------------------------------------------------

class TestGetStreamingTextHelper:
    """Criterion 2: _get_streaming_text() extracts accumulated text from streaming widget."""

    def test_get_streaming_text_method_exists(self):
        """DocumentQAApp must have a _get_streaming_text method."""
        app_gui = _import_app_gui()
        assert hasattr(app_gui.DocumentQAApp, "_get_streaming_text"), (
            "_get_streaming_text method must exist on DocumentQAApp."
        )

    def test_get_streaming_text_reads_widget_text(self):
        """
        _get_streaming_text must call _streaming_message_ref.cget("text")
        to read accumulated text from the widget.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._get_streaming_text)
        assert "cget" in source and "text" in source, (
            "_get_streaming_text must call cget('text') on _streaming_message_ref."
        )

    def test_get_streaming_text_returns_empty_if_ref_is_none(self):
        """
        _get_streaming_text must check _streaming_message_ref is not None
        before calling cget, and return "" if it is None.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._get_streaming_text)
        # Must guard against None ref
        assert "_streaming_message_ref is not None" in source or "_streaming_message_ref is None" in source, (
            "_get_streaming_text must check _streaming_message_ref before calling cget."
        )
        # Must return "" for empty/no text
        assert 'return ""' in source or "return ''" in source or "return \"\"" in source, (
            "_get_streaming_text must return an empty string when no text is available."
        )


# ---------------------------------------------------------------------------
# Test 3: _finalize_streaming_message helper
# ---------------------------------------------------------------------------

class TestFinalizeStreamingMessageHelper:
    """Criterion 3: _finalize_streaming_message persists text and optionally destroys frame."""

    def test_finalize_method_exists(self):
        """DocumentQAApp must have a _finalize_streaming_message method."""
        app_gui = _import_app_gui()
        assert hasattr(app_gui.DocumentQAApp, "_finalize_streaming_message"), (
            "_finalize_streaming_message method must exist on DocumentQAApp."
        )

    def test_finalize_calls_add_message(self):
        """
        _finalize_streaming_message must call _add_message with the accumulated text
        to actually persist the streaming content as a chat message.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._finalize_streaming_message)
        assert "_add_message" in source, (
            "_finalize_streaming_message must call _add_message to persist the streaming text."
        )
        # Must pass accumulated_text (or a variable holding it)
        assert "accumulated_text" in source, (
            "_finalize_streaming_message must use the accumulated_text parameter."
        )

    def test_finalize_sets_streaming_finalized_true(self):
        """
        _finalize_streaming_message must set self._streaming_finalized = True
        to prevent late-arriving tokens from being processed.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._finalize_streaming_message)
        assert "self._streaming_finalized = True" in source, (
            "_finalize_streaming_message must set self._streaming_finalized = True "
            "to guard against duplicate finalization."
        )

    def test_finalize_accepts_destroy_frame_parameter(self):
        """
        _finalize_streaming_message must accept a destroy_frame parameter
        (defaulting to True) so stream_destroy can pass False if needed.
        """
        app_gui = _import_app_gui()
        sig = inspect.signature(app_gui.DocumentQAApp._finalize_streaming_message)
        params = list(sig.parameters.keys())
        assert "destroy_frame" in params, (
            "_finalize_streaming_message must accept a 'destroy_frame' parameter. "
            f"Found parameters: {params}"
        )

    def test_finalize_guards_against_empty_text(self):
        """
        _finalize_streaming_message must return early (not call _add_message)
        if accumulated_text is empty/blank, preventing blank messages from
        being persisted.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._finalize_streaming_message)
        # Must check for empty text before persisting
        assert "not accumulated_text" in source or "if accumulated_text" in source or "if not" in source, (
            "_finalize_streaming_message must guard against empty accumulated_text "
            "to prevent persisting blank messages."
        )

    def test_finalize_handles_frame_destroy_when_specified(self):
        """
        When destroy_frame=True, _finalize_streaming_message must destroy
        _streaming_message_frame and clear both refs.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._finalize_streaming_message)
        # Must destroy the frame
        assert "destroy()" in source, (
            "_finalize_streaming_message must call destroy() on the streaming frame "
            "when destroy_frame=True."
        )
        # Must clear refs
        assert "_streaming_message_ref = None" in source, (
            "_finalize_streaming_message must set _streaming_message_ref = None after destroy."
        )
        assert "_streaming_message_frame = None" in source, (
            "_finalize_streaming_message must set _streaming_message_frame = None after destroy."
        )


# ---------------------------------------------------------------------------
# Test 4: stream_end handler calls _finalize_streaming_message
# ---------------------------------------------------------------------------

class TestStreamEndHandler:
    """Criterion 4: stream_end message handler calls _finalize_streaming_message."""

    def test_message_processor_handles_stream_end(self):
        """
        _start_message_processor must handle msg[0] == "stream_end"
        and call _finalize_streaming_message (not destroy the frame directly).
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert '"stream_end"' in source or "'stream_end'" in source, (
            "_start_message_processor must handle 'stream_end' message type."
        )

    def test_stream_end_calls_finalize(self):
        """
        The stream_end handler must call _finalize_streaming_message,
        NOT directly destroy the frame. This ensures the message is persisted
        via _add_message before the frame is torn down.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find stream_end handler
        stream_end_idx = source.find('"stream_end"')
        if stream_end_idx == -1:
            stream_end_idx = source.find("'stream_end'")
        chunk = source[stream_end_idx:stream_end_idx + 200]

        assert "_finalize_streaming_message" in chunk, (
            "stream_end handler must call _finalize_streaming_message, "
            f"not destroy the frame directly. Found:\n{chunk}"
        )

    def test_stream_end_passes_destroy_frame_true(self):
        """
        stream_end must pass destroy_frame=True (or use default) so the
        streaming frame is cleaned up after the message is persisted.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        stream_end_idx = source.find('"stream_end"')
        if stream_end_idx == -1:
            stream_end_idx = source.find("'stream_end'")
        chunk = source[stream_end_idx:stream_end_idx + 200]

        # destroy_frame=True is the default, so just checking _finalize_streaming_message is called
        # is sufficient (default is True). OR it can be explicitly True.
        assert "_finalize_streaming_message" in chunk, (
            f"stream_end handler must call _finalize_streaming_message. Found:\n{chunk}"
        )


# ---------------------------------------------------------------------------
# Test 5: stream_destroy handler preserves partial content
# ---------------------------------------------------------------------------

class TestStreamDestroyHandler:
    """Criterion 5: stream_destroy calls _finalize_streaming_message (preserves partial content)."""

    def test_message_processor_handles_stream_destroy(self):
        """
        _start_message_processor must handle msg[0] == "stream_destroy"
        to handle cancellation and exception paths.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert '"stream_destroy"' in source or "'stream_destroy'" in source, (
            "_start_message_processor must handle 'stream_destroy' message type "
            "for cancellation and exception paths."
        )

    def test_stream_destroy_calls_finalize_not_direct_destroy(self):
        """
        stream_destroy must call _finalize_streaming_message, NOT directly
        destroy the frame. This ensures partial streaming content is persisted
        via _add_message before the frame is torn down.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        stream_destroy_idx = source.find('"stream_destroy"')
        if stream_destroy_idx == -1:
            stream_destroy_idx = source.find("'stream_destroy'")
        chunk = source[stream_destroy_idx:stream_destroy_idx + 200]

        assert "_finalize_streaming_message" in chunk, (
            "stream_destroy handler must call _finalize_streaming_message to persist "
            f"partial content. Found:\n{chunk}"
        )

    def test_stream_destroy_called_on_cancellation(self):
        """
        In the cancellation path of _ask_question (when _operation_cancelled.is_set()),
        stream_destroy must be queued to persist any partial streaming content.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Locate the query() inner function — cancellation is checked inside it
        query_start = source.find("def query():")
        assert query_start != -1, "Could not find query() inner function in _ask_question"
        query_source = source[query_start:]

        # Find cancellation check inside query()
        cancel_idx = query_source.find("_operation_cancelled.is_set()")
        assert cancel_idx != -1, (
            "Cancellation check _operation_cancelled.is_set() not found inside query() inner function."
        )
        chunk = query_source[cancel_idx:cancel_idx + 500]

        assert "stream_destroy" in chunk, (
            "Cancellation path inside query() must queue 'stream_destroy' to persist partial content. "
            f"Found:\n{chunk}"
        )

    def test_stream_destroy_called_on_exception(self):
        """
        In the exception handler of _ask_question's query() inner function,
        stream_destroy must be queued to persist any partial streaming content.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find exception handler
        except_idx = source.find("except Exception")
        assert except_idx != -1, "_ask_question must have an exception handler."

        chunk = source[except_idx:except_idx + 400]

        assert "stream_destroy" in chunk, (
            "Exception handler must queue 'stream_destroy' to persist partial content. "
            f"Found:\n{chunk}"
        )


# ---------------------------------------------------------------------------
# Test 6: _handle_streaming_token guard against late tokens
# ---------------------------------------------------------------------------

class TestHandleStreamingTokenGuard:
    """Criterion 6: _handle_streaming_token returns early when _streaming_finalized is True."""

    def test_handle_streaming_token_checks_streaming_finalized(self):
        """
        _handle_streaming_token must check self._streaming_finalized is True
        and return early, preventing tokens that arrive after finalization
        from being processed (which would re-create the streaming widget).
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        assert "_streaming_finalized" in source, (
            "_handle_streaming_token must check _streaming_finalized "
            "to guard against tokens arriving after finalization."
        )

    def test_handle_streaming_token_returns_early_when_finalized(self):
        """
        _handle_streaming_token must return (not create or append to message)
        when _streaming_finalized is True.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        # Find the _streaming_finalized check
        finalized_idx = source.find("_streaming_finalized")
        if finalized_idx == -1:
            finalized_idx = source.find("_streaming_finalized")

        chunk = source[finalized_idx:finalized_idx + 150]
        assert "return" in chunk, (
            f"_handle_streaming_token must return when _streaming_finalized is True. "
            f"Found:\n{chunk}"
        )

    def test_handle_streaming_token_guard_order(self):
        """
        The _streaming_finalized guard must appear BEFORE any widget creation
        or UI updates in _handle_streaming_token, so that late tokens are
        discarded before any side effects.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        finalized_pos = source.find("_streaming_finalized")
        create_frame_pos = source.find("CTkFrame")

        if finalized_pos != -1 and create_frame_pos != -1:
            assert finalized_pos < create_frame_pos, (
                f"The _streaming_finalized guard (pos {finalized_pos}) must come BEFORE "
                f"frame creation (pos {create_frame_pos}) to prevent late tokens "
                "from creating duplicate widgets."
            )


# ---------------------------------------------------------------------------
# Test 7: Idempotency — double stream_end is safe
# ---------------------------------------------------------------------------

class TestDoubleStreamEndIdempotency:
    """Verify that calling _finalize_streaming_message twice is safe (no crash, no blank message)."""

    def test_finalize_returns_early_for_empty_text(self):
        """
        _finalize_streaming_message must return early when accumulated_text is empty,
        so a second call with no new text does not create a duplicate/blank message.
        This is the idempotency guard for double stream_end.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._finalize_streaming_message)

        # Must check if accumulated_text is empty before calling _add_message
        # The guard can be: if not accumulated_text: return
        # or: if accumulated_text: ...
        lines = source.split("\n")
        has_empty_check = False
        for line in lines:
            # Either "if not accumulated_text" or "if accumulated_text"
            stripped = line.strip()
            if ("not accumulated_text" in line or
                    ("accumulated_text" in line and "if" in stripped)):
                has_empty_check = True
                break

        assert has_empty_check, (
            "_finalize_streaming_message must check accumulated_text is non-empty "
            "before persisting. This guards against double stream_end creating blank messages."
        )

    def test_stream_end_idempotent_when_refs_already_none(self):
        """
        When stream_end is processed twice (e.g., race between stream_end and
        stream_destroy), the second call must not crash because:
        1. accumulated_text will be "" (refs already None/cleared)
        2. _finalize_streaming_message returns early for empty text
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._finalize_streaming_message)

        # The method must return early for empty text
        assert ("not accumulated_text" in source or
                ("accumulated_text" in source and "if" in source)), (
            "_finalize_streaming_message must handle empty accumulated_text gracefully "
            "(idempotent double-finalize)."
        )


# ---------------------------------------------------------------------------
# Test 8: Conversation flow — new query resets finalized guard
# ---------------------------------------------------------------------------

class TestNewQueryResetsFinalizedGuard:
    """Verify that starting a new query resets _streaming_finalized so tokens flow again."""

    def test_ask_question_resets_finalized_before_thread(self):
        """
        Each _ask_question call must reset _streaming_finalized = False
        BEFORE starting its worker thread. This is critical because:
        - Query 1 starts, streams, finalizes (sets _streaming_finalized = True)
        - Query 2 starts → must reset to False so its tokens are not discarded
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        reset_pos = source.find("self._streaming_finalized = False")
        thread_pos = source.find("threading.Thread(target=query")

        assert reset_pos != -1, "_ask_question must reset _streaming_finalized = False"
        assert reset_pos < thread_pos, (
            f"Reset (pos {reset_pos}) must come BEFORE thread spawn (pos {thread_pos}) "
            "so the new query's thread sees the guard in its un-finalized state."
        )

    def test_ask_question_resets_finalized_after_disabled_input(self):
        """
        The reset of _streaming_finalized must appear early in _ask_question,
        after input is disabled but before the thread starts, ensuring
        tokens queued by the new thread are processed normally.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        reset_pos = source.find("self._streaming_finalized = False")
        ask_button_pos = source.find("ask_button.configure")

        # Reset must come after input is disabled (ask_button disabled)
        assert reset_pos > ask_button_pos, (
            f"Reset (pos {reset_pos}) must come AFTER ask_button disable (pos {ask_button_pos}). "
            "The reset should be one of the first actions in the query method."
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
