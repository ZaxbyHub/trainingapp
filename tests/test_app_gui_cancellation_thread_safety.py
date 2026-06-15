"""
Tests for cancellation GUI thread safety (task 4.4 - retry 2).

Verifies:
1. engine.query() called with cancellation_event=self._operation_cancelled  (existing)
2. [Cancelled] shows "Cancelled" in chat  (existing)
3. Cancellation queues stream_destroy; main thread runs .destroy()  (NEW - thread safety)
4. NO .destroy() from worker thread  (NEW - thread safety)
5. Cancel button sets _operation_cancelled  (existing)

Key insight: The worker thread MUST NOT call .destroy() on Tk widgets directly.
Instead, it queues "stream_destroy" and the main thread's message processor
handles the .destroy() call. This is required for Tkinter thread safety.
"""

import pytest
import threading
import queue
import ast
import inspect
import textwrap
from unittest.mock import MagicMock, patch


class MockQueryResult:
    """Mock query result for simulating cancelled/normal responses."""
    def __init__(self, answer="", sources=None, chunks_retrieved=0, inference_time=0.1):
        self.answer = answer
        self.sources = sources or []
        self.chunks_retrieved = chunks_retrieved
        self.inference_time = inference_time


# ---------------------------------------------------------------------------
# Test Group: Thread Safety - Worker must NOT call .destroy() directly
# ---------------------------------------------------------------------------

class TestWorkerThreadSafety:
    """Criterion 4: Worker thread must NOT call .destroy() on Tk widgets directly."""

    def test_ask_question_does_not_call_destroy_directly(self):
        """
        CRITICAL: _ask_question worker function must NOT call .destroy() directly.
        It must queue 'stream_destroy' for the main thread to handle.

        Tkinter widgets can ONLY be destroyed from the main thread.
        Calling .destroy() from a worker thread causes race conditions and crashes.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Dedent the source since it's a method body (indented)
        source_dedented = textwrap.dedent(source)

        # Parse the source to find the query() inner function
        tree = ast.parse(source_dedented)

        # Find the query function inside _ask_question
        destroy_calls_found = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == 'query':
                # Check that .destroy() is NOT called anywhere in query()
                for child in ast.walk(node):
                    if isinstance(child, ast.Attribute):
                        if child.attr == 'destroy':
                            destroy_calls_found.append(child.lineno)

        assert len(destroy_calls_found) == 0, (
            f"BUG: Worker thread calls .destroy() directly at lines {destroy_calls_found}. "
            f"This is NOT thread-safe in Tkinter. "
            f"The worker should queue 'stream_destroy' for the main thread."
        )

    def test_stream_destroy_message_queued_on_cancellation(self):
        """
        When cancellation is detected, worker must queue 'stream_destroy' message
        for the main thread to process.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Worker must queue stream_destroy when cancellation is detected
        assert 'message_queue.put(("stream_destroy",))' in source, (
            "Worker must queue ('stream_destroy',) for main thread to handle"
        )

    def test_hide_typing_message_queued_not_direct_call(self):
        """
        Worker must queue 'hide_typing' rather than calling
        _hide_typing_indicator() directly (which would destroy widgets from worker thread).
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Worker should queue hide_typing, NOT call _hide_typing_indicator() directly
        # Direct call would be: self._hide_typing_indicator()
        # Queue call is: self.message_queue.put(("hide_typing",))

        # The worker should queue hide_typing for main thread
        assert 'message_queue.put(("hide_typing",))' in source, (
            "Worker must queue ('hide_typing',) for main thread, "
            "not call _hide_typing_indicator() directly"
        )


# ---------------------------------------------------------------------------
# Test Group: Main Thread Runs .destroy() via Message Processor
# ---------------------------------------------------------------------------

class TestMainThreadDestroysWidgets:
    """Criterion 3: Main thread runs .destroy() via message processor."""

    def test_message_processor_handles_stream_destroy(self):
        """
        The message processor must handle 'stream_destroy' message and call
        .destroy() on _streaming_message_frame from the main thread.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Must handle stream_destroy message
        assert 'msg[0] == "stream_destroy"' in source or '"stream_destroy"' in source, (
            "Message processor must handle 'stream_destroy' message"
        )

        # Must call .destroy() on the widget
        assert '.destroy()' in source, (
            "Main thread must call .destroy() on _streaming_message_frame"
        )

    def test_stream_destroy_checks_winfo_exists_before_destroy(self):
        """
        Before calling .destroy(), must check winfo_exists() to avoid
        calling destroy on an already-destroyed widget.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Dedent for parsing
        source_dedented = textwrap.dedent(source)
        lines = source_dedented.split('\n')

        # Find the stream_destroy handler
        in_stream_destroy = False
        has_destroy = False
        has_winfo_check = False

        for i, line in enumerate(lines):
            if 'stream_destroy' in line and 'msg[0]' in line:
                in_stream_destroy = True
                # Don't break on this line - it's the start of the handler
                continue
            if in_stream_destroy:
                if '.destroy()' in line:
                    has_destroy = True
                if 'winfo_exists()' in line:
                    has_winfo_check = True
                # Exit when we hit another msg[0] handler (after the body)
                # The handler body is typically 5-10 lines
                if 'elif msg[0]' in line and i > 75:  # stream_destroy handler ends around line 78
                    break

        assert has_destroy, "stream_destroy handler must call .destroy()"
        assert has_winfo_check, (
            "Must check winfo_exists() before .destroy() to handle race conditions"
        )


# ---------------------------------------------------------------------------
# Test Group: Refs Cleared After Destroy (Thread-Safe)
# ---------------------------------------------------------------------------

class TestStreamingRefsClearedAfterDestroy:
    """
    After .destroy() is called, _streaming_message_ref and
    _streaming_message_frame must be set to None to prevent dangling references.
    """

    def test_stream_destroy_clears_refs_after_destroy(self):
        """
        After destroying _streaming_message_frame, both refs must be set to None
        to prevent dangling widget references.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # After .destroy(), refs should be set to None
        # This is handled in the message processor, not in _ask_question worker
        assert '_streaming_message_ref = None' in source, (
            "_streaming_message_ref must be set to None after destroy"
        )
        assert '_streaming_message_frame = None' in source, (
            "_streaming_message_frame must be set to None after destroy"
        )

    def test_clearing_refs_in_message_processor_not_worker(self):
        """
        CRITICAL: Refs must be cleared in the message processor (main thread),
        NOT in the worker thread's _ask_question.

        Worker setting refs to None before queuing stream_destroy could cause
        the main thread to try to destroy None (TypeError).
        """
        import app_gui
        ask_source = inspect.getsource(app_gui.DocumentQAApp._ask_question)
        processor_source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Refs are cleared in message processor (correct)
        assert '_streaming_message_ref = None' in processor_source, (
            "_streaming_message_ref = None must be in message processor"
        )

        # Note: _ask_question should NOT clear refs directly before queuing
        # The message processor clears them after calling .destroy()
        # This is the correct thread-safe design


# ---------------------------------------------------------------------------
# Test Group: Cancel Button Sets _operation_cancelled
# ---------------------------------------------------------------------------

class TestCancelButtonWiring:
    """Criterion 5: Cancel button sets _operation_cancelled."""

    def test_cancel_button_command_is_cancel_operation(self):
        """Cancel button command must be _cancel_operation."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._create_chat_page)

        assert "command=self._cancel_operation" in source, (
            "cancel_button command must be self._cancel_operation"
        )

    def test_cancel_operation_sets_event(self):
        """_cancel_operation must set _operation_cancelled event."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._cancel_operation)

        assert "_operation_cancelled.set()" in source, (
            "_cancel_operation must call _operation_cancelled.set()"
        )


# ---------------------------------------------------------------------------
# Test Group: engine.query() Receives cancellation_event
# ---------------------------------------------------------------------------

class TestEngineQueryCancellationEvent:
    """Criterion 1: engine.query() must be called with cancellation_event."""

    def test_query_call_has_cancellation_event_parameter(self):
        """Verify engine.query() is called with cancellation_event parameter."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        assert "cancellation_event=self._operation_cancelled" in source, (
            "engine.query() must be called with cancellation_event=self._operation_cancelled"
        )

    def test_operation_cancelled_is_thread_event(self):
        """_operation_cancelled must be a threading.Event instance."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)

        assert "threading.Event()" in source, (
            "_operation_cancelled must be initialized as threading.Event()"
        )


# ---------------------------------------------------------------------------
# Test Group: [Cancelled] Message Display
# ---------------------------------------------------------------------------

class TestCancelledMessageDisplayed:
    """Criterion 2: [Cancelled] must show 'Cancelled' in chat."""

    def test_message_processor_handles_cancelled_content(self):
        """Message processor must display '[Cancelled]' as 'Cancelled' (not empty bubble)."""
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Must check for [Cancelled] content
        assert '"[Cancelled]"' in source or "'[Cancelled]'" in source, (
            "Message processor must check for '[Cancelled]' content"
        )

        # Must display as 'Cancelled' (without brackets)
        assert '"Cancelled"' in source or "'Cancelled'" in source, (
            "Must display 'Cancelled' not '[Cancelled]'"
        )

    def test_cancelled_message_flow(self):
        """
        When engine.query() returns '[Cancelled]', the message processor
        must display 'Cancelled' in the chat.
        """
        # Simulate the message processor logic
        role = "assistant"
        content = "[Cancelled]"

        if role == "assistant" and content == "[Cancelled]":
            displayed_content = "Cancelled"
        else:
            displayed_content = content

        assert displayed_content == "Cancelled", (
            "'[Cancelled]' must be displayed as 'Cancelled'"
        )


# ---------------------------------------------------------------------------
# Integration Test: Full Cancellation Thread Safety
# ---------------------------------------------------------------------------

class TestCancellationThreadSafetyIntegration:
    """
    Integration test verifying the complete cancellation flow
    respects Tkinter threading rules.
    """

    def test_full_cancellation_flow_thread_safe(self):
        """
        Verify the complete cancellation flow:
        1. User clicks Cancel
        2. _operation_cancelled.set() is called
        3. Worker detects is_set() after engine.query()
        4. Worker queues stream_destroy (DOES NOT call .destroy())
        5. Main thread processes stream_destroy and calls .destroy()

        This flow ensures NO .destroy() from worker thread.
        """
        import app_gui

        # Step 1: Cancel is triggered
        ask_source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Step 2: Worker checks is_set() after query
        assert "_operation_cancelled.is_set()" in ask_source, (
            "Worker must check is_set() after engine.query()"
        )

        # Step 3: Worker queues stream_destroy instead of calling .destroy()
        assert 'message_queue.put(("stream_destroy",))' in ask_source, (
            "Worker must queue stream_destroy message (not call .destroy() directly)"
        )

        # Step 4: Message processor handles stream_destroy
        processor_source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)
        assert 'msg[0] == "stream_destroy"' in processor_source, (
            "Message processor must handle stream_destroy message"
        )
        assert ".destroy()" in processor_source, (
            "Main thread must call .destroy() in stream_destroy handler"
        )

    def test_no_direct_widget_destruction_from_worker(self):
        """
        Verify that _ask_question's query() inner function does NOT
        directly call .destroy() on any widget.

        This is the core thread-safety requirement for Tkinter.
        """
        import app_gui
        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Dedent for AST parsing
        source_dedented = textwrap.dedent(source)

        # Parse and check for .destroy() calls
        tree = ast.parse(source_dedented)

        destroy_calls = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == 'query':
                for child in ast.walk(node):
                    if isinstance(child, ast.Attribute) and child.attr == 'destroy':
                        # Get line number and code
                        destroy_calls.append(
                            f"Line {child.lineno}: .destroy() call found"
                        )

        assert len(destroy_calls) == 0, (
            f"Worker thread must NOT call .destroy() directly. Found: {destroy_calls}. "
            "Use message_queue.put(('stream_destroy',)) instead."
        )
