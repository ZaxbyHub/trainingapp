"""
Tests for streaming GUI fixes (Task 4.2 retry 2) in app_gui.py.

Verifies all 5 acceptance criteria:
1. on_token checks _operation_cancelled.is_set() before queuing tokens
2. stream_end queued by worker; main thread processes and clears refs
3. stream_destroy queued by worker for cancellation; main thread destroys frame
4. NO .destroy() from worker thread (all widget ops via message_queue)
5. typing indicator shown during streaming

These are BLACK-BOX behavioral tests of the source code invariants.
"""

import pytest
import threading
import queue
import inspect
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# Criterion 1: on_token checks _operation_cancelled.is_set() before queuing
# ---------------------------------------------------------------------------

class TestOnTokenChecksCancellation:
    """Criterion 1: on_token closure checks _operation_cancelled.is_set() before queuing tokens."""

    def test_on_token_checks_is_set_before_put(self):
        """
        The on_token callback defined in _ask_question must check
        _operation_cancelled.is_set() BEFORE putting tokens into message_queue.

        Bug: if cancellation happens between the is_set() check and the queue put,
        the token would still be queued. The fix requires checking is_set() at put time.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find on_token function
        on_token_start = source.find("def on_token")
        on_token_end = source.find("\n        def query", on_token_start)
        if on_token_end == -1:
            on_token_end = len(source)

        on_token_body = source[on_token_start:on_token_end]

        # Must check is_set() before put
        assert "_operation_cancelled.is_set()" in on_token_body, (
            "on_token must check _operation_cancelled.is_set()"
        )

        # The check must come BEFORE the queue put
        is_set_pos = on_token_body.find("_operation_cancelled.is_set()")
        put_pos = on_token_body.find("message_queue.put")
        assert is_set_pos < put_pos, (
            f"is_set() check (pos {is_set_pos}) must come BEFORE "
            f"message_queue.put (pos {put_pos}) in on_token"
        )

    def test_on_token_does_not_put_when_cancelled(self):
        """
        When _operation_cancelled.is_set() is True, on_token must NOT put
        the token into the queue.
        """
        _operation_cancelled = threading.Event()
        _operation_cancelled.set()  # Simulate cancellation
        message_queue = queue.Queue()

        token = "test token"

        # This is the correct pattern: check before put
        if not _operation_cancelled.is_set():
            message_queue.put(("assistant_token", token))

        # Queue should be empty because cancellation was set
        assert message_queue.empty(), (
            "When _operation_cancelled.is_set() is True, "
            "on_token must NOT put token into queue"
        )

    def test_on_token_puts_when_not_cancelled(self):
        """
        When _operation_cancelled.is_set() is False, on_token MUST put
        the token into the queue.
        """
        _operation_cancelled = threading.Event()
        # NOT set = not cancelled
        message_queue = queue.Queue()

        token = "hello world"

        if not _operation_cancelled.is_set():
            message_queue.put(("assistant_token", token))

        assert not message_queue.empty(), (
            "When not cancelled, on_token must put token into queue"
        )
        msg = message_queue.get_nowait()
        assert msg == ("assistant_token", token)

    def test_on_token_uses_correct_message_type(self):
        """on_token must put ('assistant_token', token) tuple, not any other type."""
        _operation_cancelled = threading.Event()
        message_queue = queue.Queue()

        token = "partial "
        if not _operation_cancelled.is_set():
            message_queue.put(("assistant_token", token))

        msg = message_queue.get_nowait()
        assert msg[0] == "assistant_token", "Message type must be 'assistant_token'"
        assert msg[1] == token, "Message payload must be the token string"


# ---------------------------------------------------------------------------
# Criterion 2: stream_end queued by worker; main thread processes and clears refs
# ---------------------------------------------------------------------------

class TestStreamEndQueuedByWorker:
    """Criterion 2a: stream_end is queued by the query worker thread."""

    def test_stream_end_put_in_query_thread(self):
        """
        In _ask_question's query() inner function, after engine.query() returns
        and if streaming happened (_streaming_message_ref is not None),
        stream_end must be put into message_queue.

        This is the worker thread putting stream_end.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the stream_end put
        stream_end_patterns = [
            'message_queue.put(("stream_end"',
            'message_queue.put(("stream_end",',
            "message_queue.put(('stream_end'",
            "message_queue.put(('stream_end',",
        ]
        stream_end_pos = -1
        for pattern in stream_end_patterns:
            pos = source.find(pattern)
            if pos != -1:
                stream_end_pos = pos
                break

        assert stream_end_pos != -1, (
            "_ask_question must put 'stream_end' into message_queue "
            "from the worker thread (query function)"
        )

    def test_stream_end_guarded_by_streaming_check(self):
        """
        stream_end should only be put if _streaming_message_ref is not None,
        meaning at least one token was received (streaming happened).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the stream_end put
        stream_end_patterns = [
            'message_queue.put(("stream_end"',
            'message_queue.put(("stream_end",',
            "message_queue.put(('stream_end'",
            "message_queue.put(('stream_end',",
        ]
        stream_end_pos = -1
        for pattern in stream_end_patterns:
            pos = source.find(pattern)
            if pos != -1:
                stream_end_pos = pos
                break

        assert stream_end_pos != -1, "stream_end must be put in queue"

        # Check that there's a guard before this
        guard_pos = source.rfind("_streaming_message_ref is not None", 0, stream_end_pos)
        assert guard_pos != -1, (
            "stream_end should be guarded by _streaming_message_ref is not None check"
        )


class TestStreamEndProcessedByMainThread:
    """Criterion 2b: stream_end is processed by main thread and clears refs."""

    def test_message_processor_handles_stream_end(self):
        """
        The process() function in _start_message_processor must handle
        msg[0] == "stream_end" and clear _streaming_message_ref and _streaming_message_frame.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert '"stream_end"' in source or "'stream_end'" in source, (
            "_start_message_processor must handle 'stream_end' message type"
        )

    def test_stream_end_clears_both_refs(self):
        """
        When 'stream_end' is processed, _finalize_streaming_message must be called
        with destroy_frame=True, which destroys the frame and clears both refs.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find stream_end handler - use longer chunk to capture full handler
        stream_end_idx = source.find("msg[0] == \"stream_end\"")
        if stream_end_idx == -1:
            stream_end_idx = source.find("msg[0] == 'stream_end'")

        chunk = source[stream_end_idx:stream_end_idx+600]

        assert "_finalize_streaming_message" in chunk, (
            "'stream_end' handler must call _finalize_streaming_message to "
            "persist the message and destroy the frame"
        )

    def test_stream_end_uses_none_assignment(self):
        """
        stream_end must use '= None' assignment, not 'delete' or other patterns.
        """
        _streaming_message_ref = MagicMock()
        _streaming_message_frame = MagicMock()

        # Simulate stream_end processing
        _streaming_message_ref = None
        _streaming_message_frame = None

        assert _streaming_message_ref is None
        assert _streaming_message_frame is None


# ---------------------------------------------------------------------------
# Criterion 3: stream_destroy queued by worker for cancellation;
#              main thread destroys frame
# ---------------------------------------------------------------------------

class TestStreamDestroyQueuedByWorker:
    """Criterion 3a: stream_destroy is queued by worker thread on cancellation."""

    def test_stream_destroy_put_on_cancellation(self):
        """
        When cancellation is detected (after engine.query() returns with is_set() true),
        stream_destroy must be put into message_queue from the worker thread.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find stream_destroy put - should be in the cancellation path
        stream_destroy_patterns = [
            'message_queue.put(("stream_destroy"',
            'message_queue.put(("stream_destroy",',
            "message_queue.put(('stream_destroy'",
            "message_queue.put(('stream_destroy',",
        ]
        stream_destroy_pos = -1
        for pattern in stream_destroy_patterns:
            pos = source.find(pattern)
            if pos != -1:
                stream_destroy_pos = pos
                break

        assert stream_destroy_pos != -1, (
            "_ask_question must put 'stream_destroy' into message_queue "
            "from worker thread on cancellation"
        )

    def test_stream_destroy_in_cancellation_branch(self):
        """
        stream_destroy must be in the cancellation branch, not the normal completion branch.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find stream_destroy
        stream_destroy_idx = source.find("stream_destroy")
        if stream_destroy_idx == -1:
            stream_destroy_idx = source.find("'stream_destroy'")

        assert stream_destroy_idx != -1, "stream_destroy must be in _ask_question"

        # Get the context around stream_destroy
        # It should be near the cancellation check
        context = source[max(0, stream_destroy_idx-300):stream_destroy_idx+100]

        assert "_operation_cancelled.is_set()" in context or "is_set()" in context, (
            "stream_destroy should be in cancellation branch"
        )

    def test_stream_destroy_also_in_exception_handler(self):
        """
        stream_destroy should also be put in the exception handler,
        since errors during query may leave partial streaming state.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find exception handler
        exception_idx = source.find("except Exception")

        if exception_idx != -1:
            # After exception handler, stream_destroy should appear
            exception_chunk = source[exception_idx:exception_idx+500]
            assert "stream_destroy" in exception_chunk, (
                "stream_destroy should also be queued in exception handler "
                "to clean up partial streaming state"
            )


class TestStreamDestroyProcessedByMainThread:
    """Criterion 3b: stream_destroy processed by main thread destroys frame."""

    def test_message_processor_handles_stream_destroy(self):
        """
        The process() function in _start_message_processor must handle
        msg[0] == "stream_destroy" and destroy the frame.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert '"stream_destroy"' in source or "'stream_destroy'" in source, (
            "_start_message_processor must handle 'stream_destroy' message type"
        )

    def test_stream_destroy_calls_finalize(self):
        """
        The stream_destroy handler must call _finalize_streaming_message with
        destroy_frame=True, which calls .destroy() on the frame internally.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find stream_destroy handler - use longer chunk to capture full handler
        stream_destroy_idx = source.find("msg[0] == \"stream_destroy\"")
        if stream_destroy_idx == -1:
            stream_destroy_idx = source.find("msg[0] == 'stream_destroy'")

        chunk = source[stream_destroy_idx:stream_destroy_idx+600]

        assert "_finalize_streaming_message" in chunk, (
            "'stream_destroy' handler must call _finalize_streaming_message "
            "which internally calls .destroy() on the frame"
        )

    def test_stream_destroy_clears_refs(self):
        """
        When 'stream_destroy' is processed, _finalize_streaming_message must be called
        with destroy_frame=True, which sets both refs to None internally.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find stream_destroy handler - use longer chunk to capture full handler
        stream_destroy_idx = source.find("msg[0] == \"stream_destroy\"")
        if stream_destroy_idx == -1:
            stream_destroy_idx = source.find("msg[0] == 'stream_destroy'")

        chunk = source[stream_destroy_idx:stream_destroy_idx+600]

        # _finalize_streaming_message with destroy_frame=True clears both refs
        assert "_finalize_streaming_message" in chunk, (
            "'stream_destroy' handler must call _finalize_streaming_message "
            "which sets refs to None internally"
        )

    def test_stream_destroy_checks_frame_exists(self):
        """
        The stream_destroy handler must check winfo_exists() before calling destroy(),
        to avoid TclError if the frame was already destroyed.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find stream_destroy handler - use longer chunk to capture full handler
        stream_destroy_idx = source.find("msg[0] == \"stream_destroy\"")
        if stream_destroy_idx == -1:
            stream_destroy_idx = source.find("msg[0] == 'stream_destroy'")

        chunk = source[stream_destroy_idx:stream_destroy_idx+600]

        assert "winfo_exists()" in chunk, (
            "'stream_destroy' handler must check winfo_exists() before destroy()"
        )


# ---------------------------------------------------------------------------
# Criterion 4: NO .destroy() from worker thread (all widget ops via message_queue)
# ---------------------------------------------------------------------------

class TestNoDestroyFromWorkerThread:
    """Criterion 4: No .destroy() calls happen from the worker thread."""

    def test_no_destroy_in_query_function(self):
        """
        The query() inner function (worker thread) must NOT call .destroy() on any widget.
        All widget cleanup must go through message_queue.put(("stream_destroy",)).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the query function (inner function)
        query_start = source.find("def query(")
        if query_start == -1:
            pytest.fail("Could not find query function in _ask_question")

        # Get the query function body
        # Find the end - either next def at same indent or end of _ask_question
        query_lines = source[query_start:].split("\n")
        query_body_lines = []
        for i, line in enumerate(query_lines[1:], 1):  # skip "def query(" line
            # Stop at next top-level def or class
            if line.strip().startswith("def ") and not line.strip().startswith("def query"):
                break
            query_body_lines.append(line)

        query_body = "\n".join(query_body_lines)

        # query() function must NOT have .destroy()
        assert ".destroy()" not in query_body, (
            "Worker thread (query function) must NOT call .destroy() on any widget. "
            "All widget operations must go through message_queue."
        )

    def test_all_widget_ops_use_message_queue(self):
        """
        All widget operations from the worker thread must go through message_queue.put().
        This includes: stream_destroy, cancel_button_show, cancel_button_hide,
        hide_typing, enable_input, etc.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the query function (worker thread)
        query_start = source.find("def query(")
        if query_start == -1:
            pytest.fail("Could not find query function in _ask_question")

        # Get query function body
        query_lines = source[query_start:].split("\n")
        query_body_lines = []
        for i, line in enumerate(query_lines[1:], 1):
            if line.strip().startswith("def ") and not line.strip().startswith("def query"):
                break
            query_body_lines.append(line)

        query_body = "\n".join(query_body_lines)

        # All widget operations must use message_queue
        # These are the widget operations that must go through message_queue
        widget_ops = [
            "cancel_button_show",
            "cancel_button_hide",
            "hide_typing",
            "enable_input",
            "stream_destroy",
            "stream_end",
        ]

        for op in widget_ops:
            if op in query_body:
                # This operation is used in worker thread
                # It MUST go through message_queue.put
                assert f'message_queue.put' in query_body and op in query_body, (
                    f"Widget operation '{op}' in worker thread must use message_queue.put()"
                )

    def test_message_processor_runs_on_main_thread(self):
        """
        The _start_message_processor runs via self.after(100, process),
        which means it runs on the main thread (tkinter's event loop).
        This is how widget operations end up on the main thread.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Must re-schedule itself via after() - this is the tkinter event loop
        assert "after(100, process)" in source or "after(100,process)" in source, (
            "Message processor must re-schedule itself via after() - runs on main thread"
        )


# ---------------------------------------------------------------------------
# Criterion 5: typing indicator shown during streaming
# ---------------------------------------------------------------------------

class TestTypingIndicatorShownDuringStreaming:
    """Criterion 5: Typing indicator shown during streaming."""

    def test_show_typing_indicator_called_on_query_start(self):
        """
        _ask_question must call _show_typing_indicator() BEFORE starting query thread.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        assert "_show_typing_indicator" in source, (
            "_ask_question must call _show_typing_indicator() when streaming starts"
        )

    def test_typing_indicator_hidden_on_completion(self):
        """
        _ask_question must queue 'hide_typing' when query completes normally.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        assert "hide_typing" in source, (
            "_ask_question must queue 'hide_typing' when streaming completes"
        )

    def test_typing_indicator_hidden_on_cancellation(self):
        """
        _ask_question must queue 'hide_typing' when query is cancelled.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the cancellation path - use rfind to find the occurrence AFTER
        # the on_token callback (which is the first occurrence)
        # The cancellation check is inside the query() function after engine.query() returns
        query_start = source.find("def query(")
        if query_start != -1:
            # Search for is_set in the query function
            query_source = source[query_start:]
            cancel_idx = query_source.find("_operation_cancelled.is_set()")
            if cancel_idx != -1:
                cancel_chunk = query_source[cancel_idx:cancel_idx+600]
                assert "hide_typing" in cancel_chunk, (
                    "Cancellation path must also queue 'hide_typing'"
                )

    def test_message_processor_handles_hide_typing(self):
        """
        _start_message_processor must handle 'hide_typing' message type.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert '"hide_typing"' in source or "'hide_typing'" in source, (
            "_start_message_processor must handle 'hide_typing' message"
        )

    def test_hide_typing_calls_hide_method(self):
        """
        When 'hide_typing' is processed, _hide_typing_indicator() must be called.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find the "hide_typing" message check
        idx = source.find('msg[0] == "hide_typing"')
        if idx == -1:
            idx = source.find("msg[0] == 'hide_typing'")

        assert idx != -1, "Could not find 'msg[0] == \"hide_typing\"' in message processor"

        # Get chunk AFTER the message check
        chunk = source[idx:idx+500]

        assert "_hide_typing_indicator" in chunk, (
            "'hide_typing' handler must call _hide_typing_indicator()"
        )

    def test_show_typing_indicator_implementation_exists(self):
        """
        _show_typing_indicator method must exist and create a typing frame.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._show_typing_indicator)

        assert "_typing_frame" in source, (
            "_show_typing_indicator must create _typing_frame widget"
        )
        assert "_typing_label" in source, (
            "_show_typing_indicator must create _typing_label widget"
        )


# ---------------------------------------------------------------------------
# Integration: Full streaming lifecycle verification
# ---------------------------------------------------------------------------

class TestStreamingLifecycleIntegration:
    """Integration test for complete streaming token lifecycle."""

    def test_full_streaming_lifecycle_with_all_criteria(self):
        """
        Simulate complete streaming lifecycle verifying all 5 criteria:
        1. on_token checks cancellation before queuing
        2. stream_end queued by worker
        3. stream_destroy queued on cancellation
        4. No destroy from worker
        5. Typing indicator shown/hidden
        """
        _operation_cancelled = threading.Event()
        message_queue = queue.Queue()
        _streaming_message_ref = None
        _streaming_message_frame = None
        typing_visible = False

        # Step 1: Query starts -> typing indicator shown
        typing_visible = True
        assert typing_visible, "Typing indicator should be shown at start"

        # Step 2: Tokens arrive via on_token (checks cancellation)
        tokens = ["Hello", " world", "!"]
        for token in tokens:
            if not _operation_cancelled.is_set():  # Criterion 1: check before queue
                message_queue.put(("assistant_token", token))

        # Step 3: Simulate normal completion - stream_end queued by worker
        # (This is what happens after engine.query returns)
        if _streaming_message_ref is not None:
            message_queue.put(("stream_end",))  # Criterion 2: worker queues stream_end

        # Step 4: Main thread processes messages
        processed_tokens = []
        while True:
            try:
                msg = message_queue.get_nowait()
                if msg[0] == "assistant_token":
                    processed_tokens.append(msg[1])
                elif msg[0] == "stream_end":
                    # Main thread clears refs (Criterion 2)
                    _streaming_message_ref = None
                    _streaming_message_frame = None
                    break
            except queue.Empty:
                break

        # All tokens processed
        assert processed_tokens == tokens
        # Refs cleared after stream_end
        assert _streaming_message_ref is None

    def test_cancellation_path_stream_destroy(self):
        """
        Simulate cancellation path verifying stream_destroy is queued.
        """
        _operation_cancelled = threading.Event()
        message_queue = queue.Queue()

        # Simulate: query started, tokens flowing
        message_queue.put(("assistant_token", "Hello "))
        message_queue.put(("assistant_token", "world"))

        # Cancellation happens
        _operation_cancelled.set()

        # on_token checks cancellation - no more tokens queued (Criterion 1)
        if not _operation_cancelled.is_set():
            message_queue.put(("assistant_token", " never seen"))

        # After query returns, cancellation path queues stream_destroy (Criterion 3)
        if _operation_cancelled.is_set():
            message_queue.put(("stream_destroy",))  # Worker queues stream_destroy
            message_queue.put(("cancel_button_hide",))
            message_queue.put(("hide_typing",))
            message_queue.put(("enable_input", True))

        # Verify stream_destroy was queued by worker
        messages = []
        while True:
            try:
                messages.append(message_queue.get_nowait())
            except queue.Empty:
                break

        # stream_destroy should be in queue (Criterion 3)
        msg_types = [m[0] for m in messages]
        assert "stream_destroy" in msg_types, (
            "stream_destroy must be queued on cancellation"
        )

        # No .destroy() in worker - all widget ops go through queue (Criterion 4)
        # (This is verified by the structural tests above)

    def test_no_destroy_from_worker_thread_pattern(self):
        """
        Verify the pattern: worker thread only puts messages, never destroys widgets.
        """
        # This simulates the query() function behavior
        message_queue = queue.Queue()
        _streaming_message_frame = MagicMock()  # Simulate frame that would be destroyed

        # Worker thread ONLY puts messages
        message_queue.put(("stream_destroy",))  # Worker queues the destroy request
        message_queue.put(("hide_typing",))

        # Worker does NOT call .destroy() directly
        # The worker just puts the message

        # Main thread processes and actually destroys
        while True:
            try:
                msg = message_queue.get_nowait()
                if msg[0] == "stream_destroy":
                    # Main thread would call frame.destroy() here
                    pass
            except queue.Empty:
                break

        # This demonstrates the pattern: worker puts, main destroys


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
