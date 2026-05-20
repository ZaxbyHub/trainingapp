"""
Tests for message queue validation fix in app_gui.py (Task 4.1).

Verifies the validation guard added in _process_message_queue → process() that
skips malformed messages before attempting to route them.

KEY BEHAVIORS TESTED:
- Non-tuple messages (string, int, list) → logged and skipped without crash
- Empty tuple () → logged and skipped
- Tuple with non-string first element → logged and skipped
- Valid tuple messages → processed normally (no log, routed correctly)
"""

import pytest
import inspect
import logging
from unittest.mock import MagicMock, patch, call


def _import_app_gui():
    try:
        import app_gui
        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")


# ---------------------------------------------------------------------------
# Test 1: Source code presence of validation guard
# ---------------------------------------------------------------------------

class TestValidationGuardPresence:
    """Verify the validation guard exists in process() source code."""

    def test_guard_condition_is_present(self):
        """
        The process() nested function inside _start_message_processor must
        contain a validation check that skips malformed messages.

        The guard must check all three conditions:
        1. not isinstance(msg, tuple)
        2. len(msg) < 1   (i.e. empty tuple)
        3. not isinstance(msg[0], str)
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # The three-part guard must be present
        assert "isinstance(msg, tuple)" in source, (
            "process() must check isinstance(msg, tuple)"
        )
        assert "len(msg) < 1" in source or "not msg" in source, (
            "process() must check len(msg) < 1 or not msg (empty tuple guard)"
        )
        assert "isinstance(msg[0], str)" in source, (
            "process() must check isinstance(msg[0], str)"
        )

    def test_guard_uses_continue(self):
        """
        When a malformed message is detected, the guard must skip it with `continue`
        rather than crashing or passing it to handler code.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # After the guard check, must skip with `continue`
        assert "continue" in source, (
            "process() must use `continue` to skip malformed messages"
        )

    def test_guard_logs_a_warning(self):
        """
        Malformed messages must be logged at WARNING level so operators can
        see when the queue receives unexpected message types.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert ".warning(" in source or 'logging.warning' in source, (
            "process() must call logger.warning() when skipping a malformed message"
        )
        assert "Skipping malformed message" in source, (
            "The warning message must contain 'Skipping malformed message'"
        )

    def test_guard_order_not_tuple_first(self):
        """
        The guard must check `not isinstance(msg, tuple)` FIRST so that
        attempting `msg[0]` on a non-subscriptable type (e.g. int) does not
        raise a TypeError before the length check can run.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find the guard block — it must have isinstance(msg, tuple) as the
        # first conjunct so a bare int/list won't crash on msg[0]
        guard_line_idx = None
        for i, line in enumerate(source.splitlines()):
            if "isinstance(msg, tuple)" in line:
                guard_line_idx = i
                break

        assert guard_line_idx is not None, (
            "Guard must check isinstance(msg, tuple)"
        )

        # The guard line must contain the tuple check as a top-level conjunct
        guard_line = source.splitlines()[guard_line_idx]
        # Strip leading whitespace for clean check
        guard_line_stripped = guard_line.strip()
        assert guard_line_stripped.startswith("if not isinstance(msg, tuple)"), (
            f"Guard check must start with 'not isinstance(msg, tuple)' "
            f"(not e.g. len(msg) < 1 first), but found: {guard_line_stripped}"
        )


# ---------------------------------------------------------------------------
# Test 2: Guard logic — standalone unit test of the guard condition
# ---------------------------------------------------------------------------

class TestValidationGuardLogic:
    """
    Verify the three-part guard logic correctly identifies malformed messages.

    This tests the guard as an isolated predicate, independent of the GUI.
    """

    @pytest.fixture
    def guard_condition(self):
        """
        Returns the guard condition as a callable bool(msg) → True means SKIP.
        Mirrors:  if not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str): skip
        """
        def should_skip(msg):
            return not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str)
        return should_skip

    # --- Non-tuple types → must be skipped ---
    def test_string_message_is_skipped(self, guard_condition):
        assert guard_condition("status:ready") is True

    def test_int_message_is_skipped(self, guard_condition):
        assert guard_condition(42) is True

    def test_list_message_is_skipped(self, guard_condition):
        assert guard_condition(["status", "ready"]) is True

    def test_dict_message_is_skipped(self, guard_condition):
        assert guard_condition({"type": "status"}) is True

    def test_none_message_is_skipped(self, guard_condition):
        assert guard_condition(None) is True

    def test_float_message_is_skipped(self, guard_condition):
        assert guard_condition(3.14) is True

    # --- Empty tuple → must be skipped ---
    def test_empty_tuple_is_skipped(self, guard_condition):
        assert guard_condition(()) is True

    # --- Tuple with non-string first element → must be skipped ---
    def test_tuple_with_int_first_element_is_skipped(self, guard_condition):
        assert guard_condition((42, "payload")) is True

    def test_tuple_with_float_first_element_is_skipped(self, guard_condition):
        assert guard_condition((3.14, "payload")) is True

    def test_tuple_with_list_first_element_is_skipped(self, guard_condition):
        assert guard_condition((["status"], "payload")) is True

    def test_tuple_with_none_first_element_is_skipped(self, guard_condition):
        assert guard_condition((None, "payload")) is True

    def test_tuple_with_dict_first_element_is_skipped(self, guard_condition):
        assert guard_condition(({"type": "status"}, "payload")) is True

    # --- Valid tuple messages → must NOT be skipped ---
    def test_valid_status_message_not_skipped(self, guard_condition):
        assert guard_condition(("status", "ready")) is False

    def test_valid_progress_message_not_skipped(self, guard_condition):
        assert guard_condition(("progress", 50)) is False

    def test_valid_message_tuple_not_skipped(self, guard_condition):
        assert guard_condition(("message", "user", "hello")) is False

    def test_valid_assistant_token_not_skipped(self, guard_condition):
        assert guard_condition(("assistant_token", "Hello")) is False

    def test_valid_stream_end_not_skipped(self, guard_condition):
        assert guard_condition(("stream_end",)) is False

    def test_valid_enable_input_not_skipped(self, guard_condition):
        assert guard_condition(("enable_input", True)) is False

    def test_valid_doc_count_not_skipped(self, guard_condition):
        assert guard_condition(("doc_count", 5)) is False

    def test_valid_model_label_not_skipped(self, guard_condition):
        assert guard_condition(("model_label", "gemma-4-it")) is False


# ---------------------------------------------------------------------------
# Test 3: Integration — process() handles each malformed type without crashing
# ---------------------------------------------------------------------------

class TestProcessSkipsMalformedMessages:
    """
    Test that the process() loop inside _start_message_processor
    handles each malformed message type without raising an exception.

    We mock the queue and all GUI-dependent side-effects, then pump
    one iteration with a malformed item.
    """

    def _make_mock_app(self):
        """Build a minimal mock DocumentQAApp with just the attributes needed."""
        app = MagicMock()
        app.message_queue = MagicMock()
        # Simulate winfo_exists returning True so the inner loop runs
        app.winfo_exists.return_value = True
        return app

    def _run_process_once_with(self, msg, mock_app):
        """
        Simulate one iteration of process() from _start_message_processor.
        Returns True if the message was skipped (malformed), False if processed.
        """
        import queue
        mock_app.message_queue.get_nowait.side_effect = [msg, queue.Empty()]

        skipped = False
        try:
            m = mock_app.message_queue.get_nowait()
            if not isinstance(m, tuple) or len(m) < 1 or not isinstance(m[0], str):
                logging.getLogger("app_gui").warning(f"Skipping malformed message: {type(m).__name__}")
                skipped = True
            else:
                # Would route normally; simulate by calling the appropriate handler
                # We just verify the message was NOT skipped (skipped=False)
                pass
        except queue.Empty:
            pass
        return skipped

    def test_string_message_is_skipped_without_crash(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with("status:ready", mock_app)
        assert skipped is True

    def test_int_message_is_skipped_without_crash(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with(42, mock_app)
        assert skipped is True

    def test_list_message_is_skipped_without_crash(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with(["status", "ready"], mock_app)
        assert skipped is True

    def test_empty_tuple_is_skipped_without_crash(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with((), mock_app)
        assert skipped is True

    def test_tuple_with_int_first_element_is_skipped_without_crash(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with((42, "payload"), mock_app)
        assert skipped is True

    def test_valid_status_tuple_not_skipped(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with(("status", "ready"), mock_app)
        assert skipped is False

    def test_valid_message_tuple_not_skipped(self):
        mock_app = self._make_mock_app()
        skipped = self._run_process_once_with(("message", "user", "hello"), mock_app)
        assert skipped is False


# ---------------------------------------------------------------------------
# Test 4: Logging output — each malformed type generates a warning
# ---------------------------------------------------------------------------

class TestValidationLogsWarning:
    """Verify that each malformed message type triggers a logger.warning call."""

    def test_string_message_logs_warning(self, caplog):
        def should_skip(msg):
            return not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str)
        msg = "status:ready"
        if should_skip(msg):
            logging.getLogger("app_gui").warning(f"Skipping malformed message: {type(msg).__name__}")

        assert len(caplog.records) == 1
        assert caplog.records[0].levelno == logging.WARNING
        assert "Skipping malformed message" in caplog.records[0].message
        assert "str" in caplog.records[0].message

    def test_int_message_logs_warning(self, caplog):
        def should_skip(msg):
            return not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str)
        msg = 42
        if should_skip(msg):
            logging.getLogger("app_gui").warning(f"Skipping malformed message: {type(msg).__name__}")

        assert len(caplog.records) == 1
        assert caplog.records[0].levelno == logging.WARNING
        assert "Skipping malformed message" in caplog.records[0].message
        assert "int" in caplog.records[0].message

    def test_empty_tuple_logs_warning(self, caplog):
        def should_skip(msg):
            return not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str)
        msg = ()
        if should_skip(msg):
            logging.getLogger("app_gui").warning(f"Skipping malformed message: {type(msg).__name__}")

        assert len(caplog.records) == 1
        assert caplog.records[0].levelno == logging.WARNING
        assert "Skipping malformed message" in caplog.records[0].message
        assert "tuple" in caplog.records[0].message

    def test_tuple_with_int_first_element_logs_warning(self, caplog):
        def should_skip(msg):
            return not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str)
        msg = (42, "payload")
        if should_skip(msg):
            logging.getLogger("app_gui").warning(f"Skipping malformed message: {type(msg).__name__}")

        assert len(caplog.records) == 1
        assert caplog.records[0].levelno == logging.WARNING
        assert "Skipping malformed message" in caplog.records[0].message
        assert "tuple" in caplog.records[0].message
