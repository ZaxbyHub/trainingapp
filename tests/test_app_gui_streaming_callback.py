"""
Tests for streaming token callback wiring in app_gui.py (Task 4.2).

Verifies the complete streaming callback chain:
1. stream_callback puts tokens into message_queue (on_token closure in _ask_question)
2. message_processor handles "assistant_token" message type and appends to streaming message
3. streaming message is created when first token arrives (_handle_streaming_token)
4. typing indicator shown during streaming (cancel_button_show sent when worker starts)
5. streaming message finalized when "message" tuple arrives as final result

CRITICAL BUG: rag_engine.query() does NOT accept stream_callback parameter,
but app_gui._ask_question() passes stream_callback=on_token to query().
This causes a TypeError: query() got an unexpected keyword argument 'stream_callback'.
"""

import pytest
import inspect


# ---------------------------------------------------------------------------
# Criterion 1: stream_callback puts tokens into message_queue
# ---------------------------------------------------------------------------

class TestStreamCallbackPutsTokensIntoQueue:
    """Task 4.2 Criterion 1: on_token closure puts tokens into message_queue."""

    def test_on_token_closure_puts_assistant_token_tuple(self):
        """
        The on_token callback defined in _ask_question must put
        ("assistant_token", token) tuples into self.message_queue.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # The on_token function must put ("assistant_token", token) into message_queue
        assert 'message_queue.put(("assistant_token", token))' in source, (
            "on_token callback must put ('assistant_token', token) tuple into message_queue. "
            "Found: " + source[source.find("on_token"):source.find("on_token")+200]
        )

    def test_on_token_closure_uses_message_queue_put(self):
        """
        The on_token callback must call self.message_queue.put(), not a different method.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the on_token definition and verify it uses message_queue.put
        lines = source.split("\n")
        in_on_token = False
        on_token_lines = []
        for line in lines:
            if "def on_token" in line or "on_token(" in line and "lambda" not in line:
                in_on_token = True
            if in_on_token:
                on_token_lines.append(line)
                if line.strip() and not line.strip().startswith("#"):
                    if "message_queue.put" in line or "self.message_queue.put" in line:
                        break
                    if line.strip().startswith("def ") and "on_token" not in line:
                        break

        on_token_body = "\n".join(on_token_lines)
        assert "message_queue.put" in on_token_body, (
            f"on_token callback must call message_queue.put(). Body found:\n{on_token_body}"
        )


# ---------------------------------------------------------------------------
# Criterion 2: message_processor handles "assistant_token"
# ---------------------------------------------------------------------------

class TestMessageProcessorHandlesAssistantToken:
    """Task 4.2 Criterion 2: message_processor dispatches 'assistant_token' to _handle_streaming_token."""

    def test_message_processor_handles_assistant_token(self):
        """
        The process() function in _start_message_processor must handle
        msg[0] == "assistant_token" and call _handle_streaming_token.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Must check for "assistant_token" message type
        assert '"assistant_token"' in source or "'assistant_token'" in source, (
            "_start_message_processor must check for 'assistant_token' message type. "
            "Found source:\n" + source[:500]
        )

        # Must call _handle_streaming_token
        assert "_handle_streaming_token" in source, (
            "_start_message_processor must call _handle_streaming_token "
            "when handling 'assistant_token' messages."
        )

        # Must extract token from msg[1]
        assert "msg[1]" in source, (
            "_start_message_processor must pass msg[1] (the token) to _handle_streaming_token."
        )

    def test_assistant_token_branch_winxinfo_check(self):
        """
        The assistant_token handler must check winfo_exists() before updating UI.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find the assistant_token handling section
        assistant_token_idx = source.find("assistant_token")
        if assistant_token_idx == -1:
            assistant_token_idx = source.find("'assistant_token'")

        # Get the next ~200 chars after assistant_token check
        chunk = source[assistant_token_idx:assistant_token_idx+300]

        assert "winfo_exists()" in chunk, (
            "assistant_token handler must check winfo_exists() before updating UI widgets."
        )


# ---------------------------------------------------------------------------
# Criterion 3: streaming message created when first token arrives
# ---------------------------------------------------------------------------

class TestStreamingMessageCreatedOnFirstToken:
    """Task 4.2 Criterion 3: _handle_streaming_token creates message frame on first token."""

    def test_handle_streaming_token_checks_streaming_message_ref(self):
        """
        _handle_streaming_token must check if _streaming_message_ref is None
        to detect first token and create the message structure.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        # Must check _streaming_message_ref is None
        assert "_streaming_message_ref is None" in source or "_streaming_message_ref == None" in source, (
            "_handle_streaming_token must check 'self._streaming_message_ref is None' "
            "to detect first token arrival. Found:\n" + source[:300]
        )

    def test_first_token_creates_message_frame_and_label(self):
        """
        On first token (_streaming_message_ref is None), must create
        _streaming_message_frame and _streaming_message_ref (CTkLabel).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        # First token path must create _streaming_message_frame
        assert "_streaming_message_frame" in source, (
            "_handle_streaming_token must create _streaming_message_frame on first token."
        )

        # First token path must create _streaming_message_ref (the text label)
        assert "_streaming_message_ref" in source, (
            "_handle_streaming_token must assign _streaming_message_ref on first token."
        )

    def test_subsequent_tokens_append_to_existing(self):
        """
        After first token, subsequent tokens should append to existing
        _streaming_message_ref text (else branch).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        # Must have else branch for subsequent tokens
        assert "else:" in source, (
            "_handle_streaming_token must have an else branch for subsequent tokens."
        )

        # Subsequent tokens must get current text and append
        assert "cget(\"text\")" in source or "cget('text')" in source, (
            "Subsequent tokens must read current text via cget('text') and append token."
        )

    def test_scroll_to_bottom_on_each_token(self):
        """
        Both first and subsequent token paths must scroll chat to bottom.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._handle_streaming_token)

        # Must call yview_moveto(1.0) to scroll to bottom
        scroll_count = source.count("yview_moveto(1.0)")
        assert scroll_count >= 2, (
            f"_handle_streaming_token must call yview_moveto(1.0) at least twice "
            f"(once for first token, once for subsequent). Found {scroll_count} calls."
        )


# ---------------------------------------------------------------------------
# Criterion 4: typing indicator shown during streaming
# ---------------------------------------------------------------------------

class TestTypingIndicatorShownDuringStreaming:
    """Task 4.2 Criterion 4: cancel_button_show sent when worker starts (typing indicator shown)."""

    def test_ask_question_shows_cancel_button_on_start(self):
        """
        _ask_question must send cancel_button_show to message_queue when
        the query worker thread starts, signaling streaming is beginning.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Must queue cancel_button_show when query starts
        assert "cancel_button_show" in source, (
            "_ask_question must queue 'cancel_button_show' when query worker starts. "
            "This signals that streaming/operation has begun."
        )

    def test_ask_question_calls_show_typing_indicator(self):
        """
        _ask_question must call _show_typing_indicator() before starting the query thread.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Must call _show_typing_indicator
        assert "_show_typing_indicator" in source, (
            "_ask_question must call _show_typing_indicator() to show typing indicator "
            "during streaming operation."
        )

    def test_hide_typing_indicator_on_completion(self):
        """
        After streaming completes, _hide_typing_indicator must be called
        via 'hide_typing' message.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Must hide typing indicator on completion
        assert "hide_typing" in source, (
            "_ask_question must queue 'hide_typing' when streaming completes."
        )

    def test_hide_typing_in_message_processor(self):
        """
        _start_message_processor must handle 'hide_typing' message type.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert '"hide_typing"' in source or "'hide_typing'" in source, (
            "_start_message_processor must handle 'hide_typing' message to hide typing indicator."
        )


# ---------------------------------------------------------------------------
# Criterion 5: streaming finalized when "message" tuple arrives
# ---------------------------------------------------------------------------

class TestStreamingFinalizedWhenMessageArrives:
    """Task 4.2 Criterion 5: streaming message refs cleared when final message tuple arrives."""

    def test_query_clears_streaming_ref_on_completion(self):
        """
        In _ask_question, after engine.query() returns, the query() inner function
        must clear _streaming_message_ref and _streaming_message_frame.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Must clear _streaming_message_ref after query completes
        assert "_streaming_message_ref = None" in source, (
            "_ask_question must set _streaming_message_ref = None after streaming completes "
            "to finalize the message."
        )

        # Must clear _streaming_message_frame too
        assert "_streaming_message_frame = None" in source, (
            "_ask_question must set _streaming_message_frame = None after streaming completes."
        )

    def test_streaming_ref_cleared_only_if_not_none(self):
        """
        The clearing of _streaming_message_ref should only happen if it was
        actually set (i.e., at least one token was received).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Should check _streaming_message_ref is not None before clearing
        # This guards against clearing twice or when no streaming happened
        assert "_streaming_message_ref is not None" in source, (
            "_ask_question should check 'if self._streaming_message_ref is not None' "
            "before clearing streaming refs (guards against double-clear / non-streaming path)."
        )

    def test_query_thread_clears_on_cancellation(self):
        """
        When query is cancelled, _streaming_message_ref and _streaming_message_frame
        must also be cleared (cancelled streaming message should not persist).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Cancellation path must also clear streaming refs
        # Find the cancellation handling section
        if "_operation_cancelled.is_set()" in source:
            # Extract ~500 chars around the cancellation check
            cancel_idx = source.find("_operation_cancelled.is_set()")
            chunk = source[cancel_idx:cancel_idx+500]

            assert "_streaming_message_ref" in chunk and "None" in chunk, (
                "Cancellation path must also clear _streaming_message_ref to avoid "
                "stale streaming message persisting after cancellation."
            )


# ---------------------------------------------------------------------------
# CRITICAL BUG TEST: stream_callback is NOT wired through rag_engine.query()
# ---------------------------------------------------------------------------

class TestStreamCallbackWiringBug:
    """
    CRITICAL BUG FOUND: rag_engine.query() does NOT accept stream_callback parameter.

    app_gui._ask_question() passes stream_callback=on_token to self.engine.query(),
    but rag_engine.query() signature is:
        def query(self, question, n_results=None, conversation_history=None, cancellation_event=None) -> QueryResult

    This causes: TypeError: query() got an unexpected keyword argument 'stream_callback'

    Additionally, even if query() accepted stream_callback, it does NOT pass
    stream_callback to self.llm.answer_question() inside query().
    """

    def test_rag_engine_query_accepts_stream_callback(self):
        """
        rag_engine.query() has a stream_callback parameter wired correctly.
        """
        try:
            import rag_engine
        except ImportError:
            pytest.skip("rag_engine module not available")

        sig = inspect.signature(rag_engine.RAGEngine.query)
        params = list(sig.parameters.keys())

        assert "stream_callback" in params, (
            f"BUG: rag_engine.query() is missing stream_callback parameter. "
            f"Current params: {params}"
        )

    def test_rag_engine_query_passes_stream_callback_to_llm(self):
        """
        app_gui._ask_question() passes stream_callback=on_token to query().
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Verify that stream_callback IS passed to query
        assert "stream_callback=on_token" in source, (
            "app_gui._ask_question() must pass stream_callback=on_token to query()."
        )

    def test_rag_engine_query_passes_stream_callback_to_answer_question(self):
        """
        rag_engine.query() passes stream_callback to self.llm.answer_question().
        """
        try:
            import rag_engine
        except ImportError:
            pytest.skip("rag_engine module not available")

        source = inspect.getsource(rag_engine.RAGEngine.query)

        # Find the answer_question call
        if "answer_question" in source:
            # Get the answer_question call lines
            lines = source.split("\n")
            for i, line in enumerate(lines):
                if "answer_question" in line and "self.llm" in line:
                    # Get surrounding 3 lines
                    call_chunk = "\n".join(lines[max(0,i-1):i+8])
                    assert "stream_callback" in call_chunk, (
                        f"BUG: answer_question call missing stream_callback:\n{call_chunk}"
                    )
                    break


# ---------------------------------------------------------------------------
# Sanity checks: required instance variables exist
# ---------------------------------------------------------------------------

class TestRequiredInstanceVariables:
    """Verify DocumentQAApp has all required instance variables for streaming."""

    def test_has_message_queue(self):
        """DocumentQAApp.__init__ must initialize self.message_queue."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp.__init__)
        assert "message_queue = queue.Queue()" in source, (
            "__init__ must initialize self.message_queue = queue.Queue()"
        )

    def test_has_streaming_message_ref(self):
        """
        DocumentQAApp must initialize _streaming_message_ref as None.
        Initialized in _create_widgets (called via deferred _load_settings_and_init).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        assert "_streaming_message_ref" in source, (
            "_create_widgets must initialize _streaming_message_ref = None"
        )

    def test_has_streaming_message_frame(self):
        """
        DocumentQAApp must initialize _streaming_message_frame as None.
        Initialized in _create_widgets (called via deferred _load_settings_and_init).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        assert "_streaming_message_frame" in source, (
            "_create_widgets must initialize _streaming_message_frame = None"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
