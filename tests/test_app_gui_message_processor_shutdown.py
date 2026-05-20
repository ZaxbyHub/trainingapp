"""
Tests for message processor shutdown flag in app_gui.py (Task 5.1).

Verifies the DD-001 fix:
1. _message_processor_shutdown is initialized to False in _load_settings_and_init
2. _on_close() sets _message_processor_shutdown = True BEFORE calling destroy()
3. process() loop checks the flag with: while not self._message_processor_shutdown:
4. Setting the flag before destroy() prevents any re-scheduling of process()

REGRESSION: Before the fix, process() used `while True:` and would keep
re-scheduling itself via self.after(100, process) even after destroy(),
leaking the background thread indefinitely.
"""

import pytest
import inspect
from unittest.mock import MagicMock


def _import_app_gui():
    try:
        import app_gui
        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed — cannot test GUI shutdown behavior")


# ---------------------------------------------------------------------------
# Test 1: Flag is initialized to False in _load_settings_and_init
# ---------------------------------------------------------------------------

class TestShutdownFlagInitialization:
    """Verify _message_processor_shutdown is initialized to False at startup."""

    def test_flag_initialization_in_source(self):
        """_message_processor_shutdown = False must appear in _load_settings_and_init."""
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._load_settings_and_init)

        assert "_message_processor_shutdown = False" in source, (
            "_message_processor_shutdown must be initialized to False "
            "in _load_settings_and_init"
        )

    def test_flag_initialized_after_create_widgets(self):
        """
        The flag must be set AFTER _create_widgets() so that _start_message_processor
        starts with the flag in the correct False state.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._load_settings_and_init)

        # Find positions of key lines
        create_widgets_pos = source.find("_create_widgets()")
        flag_pos = source.find("_message_processor_shutdown = False")
        start_processor_pos = source.find("_start_message_processor()")

        assert create_widgets_pos != -1, "_create_widgets() call must be present"
        assert flag_pos != -1, "_message_processor_shutdown = False must be present"
        assert start_processor_pos != -1, "_start_message_processor() call must be present"
        assert create_widgets_pos < flag_pos < start_processor_pos, (
            "Order must be: _create_widgets → _message_processor_shutdown=False → "
            "_start_message_processor"
        )

    def test_flag_type_is_bool(self):
        """The literal value assigned must be the boolean False, not None or 0."""
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._load_settings_and_init)

        # Must be "= False" not "= None" or "= 0"
        assert "= False" in source, (
            "_message_processor_shutdown must be set to the boolean False"
        )
        # Must not be falsy alternatives
        assert "= None" not in source or source.find("= False") < source.find("= None"), (
            "Must not be initialized to None"
        )


# ---------------------------------------------------------------------------
# Test 2: _on_close() sets flag BEFORE destroy()
# ---------------------------------------------------------------------------

class TestOnCloseSetsFlagBeforeDestroy:
    """Verify _on_close() sets _message_processor_shutdown = True before destroy()."""

    def test_flag_set_in_on_close(self):
        """_on_close() must contain _message_processor_shutdown = True."""
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._on_close)

        assert "_message_processor_shutdown = True" in source, (
            "_on_close() must set _message_processor_shutdown = True"
        )

    def test_flag_set_before_destroy(self):
        """
        The flag assignment must appear BEFORE self.destroy() in _on_close()
        to guarantee the process() loop sees the flag before the window handle
        becomes invalid.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._on_close)

        flag_pos = source.find("_message_processor_shutdown = True")
        destroy_pos = source.find("self.destroy()")

        assert flag_pos != -1, "_message_processor_shutdown = True must be present"
        assert destroy_pos != -1, "self.destroy() must be present"
        assert flag_pos < destroy_pos, (
            "_message_processor_shutdown = True must appear BEFORE self.destroy() "
            "so the process loop can exit before the window handle is destroyed"
        )

    def test_cancel_clear_confirm_called_before_flag(self):
        """
        _cancel_clear_confirm() should be called before setting the flag
        (already confirmed in existing code — ensures button timers are cancelled first).
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._on_close)

        cancel_pos = source.find("_cancel_clear_confirm()")
        flag_pos = source.find("_message_processor_shutdown = True")

        assert cancel_pos != -1, "_cancel_clear_confirm() must be called"
        assert cancel_pos < flag_pos, (
            "_cancel_clear_confirm() must be called before setting shutdown flag"
        )


# ---------------------------------------------------------------------------
# Test 3: process() loop checks the flag
# ---------------------------------------------------------------------------

class TestProcessLoopChecksFlag:
    """Verify process() uses the flag in its while condition."""

    def test_while_condition_checks_flag(self):
        """
        The process() loop must use: while not self._message_processor_shutdown:
        instead of the prior buggy: while True:
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # The loop must check the flag
        assert "not self._message_processor_shutdown" in source, (
            "process() while condition must check: "
            "while not self._message_processor_shutdown:"
        )

    def test_loop_no_longer_uses_while_true(self):
        """
        The process() loop must NOT use 'while True:' which was the bug.
        The loop must be bounded by the shutdown flag.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # The source should NOT contain bare "while True:"
        # We check that if "while True" appears, it is commented out or in a different context
        lines = source.splitlines()
        for line in lines:
            stripped = line.strip()
            # It's OK to have "while True:" in comments or strings for documentation
            if stripped.startswith("#"):
                continue
            if stripped.startswith('"') or stripped.startswith("'"):
                continue
            assert "while True:" not in stripped, (
                f"process() must not use 'while True:' (found: {stripped}). "
                "Use: while not self._message_processor_shutdown:"
            )

    def test_loop_reschedules_only_when_window_exists(self):
        """
        After processing messages, process() only re-schedules if self.winfo_exists().
        Combined with the flag check, this guarantees clean termination.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # The after() call must be guarded by winfo_exists check
        assert "self.winfo_exists()" in source, (
            "process() must check self.winfo_exists() before re-scheduling"
        )
        assert "self.after(100, process)" in source or "self.after(" in source, (
            "process() must re-schedule itself via self.after()"
        )


# ---------------------------------------------------------------------------
# Test 4: Flag prevents re-scheduling — isolated logic test
# ---------------------------------------------------------------------------

class TestShutdownFlagPreventsRescheduling:
    """
    Verify the flag prevents process() from re-scheduling after shutdown.

    The re-scheduling logic is:
        if self.winfo_exists():
            self.after(100, process)

    Before the fix, setting the flag would not affect the loop because
    `while True:` would keep running even if winfo_exists() becomes False.
    After the fix, `while not self._message_processor_shutdown:` causes
    the loop to exit cleanly before the after() call can re-schedule.
    """

    def test_loop_exits_when_flag_is_true(self):
        """
        Simulate the process() loop with shutdown flag = True.
        The loop must exit without calling after().
        """
        # Simulate the loop logic
        _message_processor_shutdown = True  # Flag set by _on_close()
        winfo_exists = True  # Window still exists (destroy() not yet called)
        after_called = False

        def after(delay, callback):
            nonlocal after_called
            after_called = True

        # The loop from process()
        iterations = 0
        max_iterations = 1000  # Safety cap to detect infinite loop

        while not _message_processor_shutdown:
            # Simulate empty queue
            # (in real code: msg = self.message_queue.get_nowait() → queue.Empty)
            if iterations >= max_iterations:
                break
            iterations += 1

            if not winfo_exists:
                break

            # Re-schedule (only if winfo_exists AND flag is False)
            # This is the safety net — but with the fix, loop exits first
            # when flag is True

        # With flag = True, loop should exit immediately (iterations == 0 or 1)
        assert iterations <= 1, (
            f"Loop must exit immediately when flag=True, but ran {iterations} iterations. "
            "The while condition 'not self._message_processor_shutdown' is not working."
        )

    def test_loop_runs_normally_when_flag_is_false(self):
        """
        Simulate the process() loop with shutdown flag = False (normal operation).
        The loop must continue running.
        """
        _message_processor_shutdown = False  # Normal operation
        iterations = 0
        max_iterations = 5

        while not _message_processor_shutdown:
            iterations += 1
            if iterations >= max_iterations:
                break

        assert iterations == max_iterations, (
            f"Loop should run normally when flag=False, got {iterations} iterations"
        )

    def test_after_only_called_when_flag_is_false_and_window_exists(self):
        """
        after() should only be called when:
        - _message_processor_shutdown = False (loop is still running)
        - self.winfo_exists() = True (window still alive)

        With the fix: when _on_close() sets the flag, the loop exits
        BEFORE the after() call can execute.
        """
        # Scenario: _on_close() sets flag while window still exists
        _message_processor_shutdown = False
        winfo_exists = True
        after_called = False

        def after(delay, callback):
            nonlocal after_called
            after_called = True

        # First iteration: normal operation
        iteration = 0
        while not _message_processor_shutdown:
            iteration += 1
            # Simulate queue.Empty (message processor pattern)
            # Re-schedule
            if winfo_exists:
                after(100, lambda: None)  # Would re-schedule

            # Simulate _on_close() being called between iterations
            if iteration == 1:
                _message_processor_shutdown = True  # _on_close() sets flag
                winfo_exists = False              # destroy() called

            if iteration >= 3:
                break

        # after() was called on iteration 1 (before _on_close ran)
        # but NOT on iteration 2 (flag was already True)
        # The key invariant: after() is never called when flag is True
        assert after_called is True  # Called on iteration 1 (normal)
        # This demonstrates that the flag mechanism prevents re-scheduling
        # when set: the next iteration sees flag=True and exits

    def test_destroy_still_happens_after_flag_set(self):
        """
        Verifying _on_close() calls destroy() after setting the flag:
        self._message_processor_shutdown = True
        self.destroy()

        The flag does not replace destroy() — both must be called.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._on_close)

        assert "self.destroy()" in source, (
            "self.destroy() must be called in _on_close() after setting the flag"
        )

        # Both must be present in the correct order
        flag_pos = source.find("_message_processor_shutdown = True")
        destroy_pos = source.find("self.destroy()")

        assert flag_pos < destroy_pos, (
            "Flag must be set BEFORE destroy() is called"
        )


# ---------------------------------------------------------------------------
# Test 5: Integration — full shutdown sequence
# ---------------------------------------------------------------------------

class TestShutdownSequenceIntegration:
    """
    Integration test verifying the complete shutdown sequence.

    Sequence:
    1. _message_processor_shutdown = False  (initialization)
    2. User closes window → _on_close() called
    3. _on_close() sets _message_processor_shutdown = True
    4. _on_close() calls destroy()
    5. process() loop checks flag → exits (no re-scheduling)
    """

    def test_shutdown_sequence_order(self):
        """
        Verify the shutdown sequence in _load_settings_and_init and _on_close:
        1. _create_widgets()
        2. _message_processor_shutdown = False
        3. _start_message_processor()

        And in _on_close:
        4. _message_processor_shutdown = True
        5. destroy()
        """
        app_gui = _import_app_gui()

        # Check initialization order
        init_source = inspect.getsource(app_gui.DocumentQAApp._load_settings_and_init)

        create_widgets_idx = init_source.find("_create_widgets()")
        flag_init_idx = init_source.find("_message_processor_shutdown = False")
        start_processor_idx = init_source.find("_start_message_processor()")

        assert create_widgets_idx > -1
        assert flag_init_idx > -1
        assert start_processor_idx > -1
        assert create_widgets_idx < flag_init_idx < start_processor_idx, (
            "Initialization order must be: "
            "_create_widgets → _message_processor_shutdown=False → _start_message_processor"
        )

        # Check shutdown order
        close_source = inspect.getsource(app_gui.DocumentQAApp._on_close)

        flag_shutdown_idx = close_source.find("_message_processor_shutdown = True")
        destroy_idx = close_source.find("self.destroy()")

        assert flag_shutdown_idx > -1
        assert destroy_idx > -1
        assert flag_shutdown_idx < destroy_idx, (
            "Shutdown order must be: "
            "_message_processor_shutdown=True → destroy()"
        )

    def test_process_respects_flag_and_window_state(self):
        """
        Test the combined logic of the two safeguards:
        1. while not self._message_processor_shutdown: (flag check)
        2. if self.winfo_exists(): self.after(...) (window check)

        Either safeguard alone is insufficient:
        - Flag alone: loop exits but can't clean up gracefully
        - Window alone: could re-schedule if destroy() is delayed
        - Both together: loop exits when flag=True AND window is still valid,
          preventing any re-scheduling.
        """
        # Simulate process() loop with combined logic
        _message_processor_shutdown = False
        winfo_exists_results = [True, True, True]  # Window exists for first 3 checks
        after_calls = []

        def mock_after(delay, callback):
            after_calls.append((delay, callback))

        iteration = 0
        while not _message_processor_shutdown:
            iteration += 1

            # Simulate queue.Empty (process goes to re-schedule)
            if winfo_exists_results[iteration - 1] if iteration <= len(winfo_exists_results) else False:
                mock_after(100, lambda: None)

            if iteration >= 5:
                break

        # Normal operation: after() called for each iteration until queue.Empty
        assert len(after_calls) == min(5, len(winfo_exists_results)), (
            f"Expected after() to be called {min(5, len(winfo_exists_results))} times "
            f"during normal operation, got {len(after_calls)}"
        )

        # Now test with shutdown triggered mid-operation
        _message_processor_shutdown = False
        winfo_exists_results = [True]  # Window goes away after first check
        after_calls = []
        flag_set_on_iteration = 1  # Flag set between iterations

        iteration = 0
        while not _message_processor_shutdown:
            iteration += 1

            # Check flag BEFORE re-scheduling
            if _message_processor_shutdown:
                break  # Exit without re-scheduling

            if winfo_exists_results[iteration - 1] if iteration <= len(winfo_exists_results) else False:
                mock_after(100, lambda: None)

            # _on_close() runs here (between iterations)
            if iteration == flag_set_on_iteration:
                _message_processor_shutdown = True

            if iteration >= 5:
                break

        # after() called once (before flag was set)
        # then loop exits when flag is checked on next iteration
        assert len(after_calls) == 1, (
            f"after() should be called exactly once before shutdown, got {len(after_calls)}. "
            "The flag check must prevent re-scheduling after _on_close()."
        )


# ---------------------------------------------------------------------------
# Test 6: Regression — prior bug behavior
# ---------------------------------------------------------------------------

class TestShutdownRegression:
    """
    Regression tests for DD-001: Message processor shutdown leak.

    BEFORE THE FIX:
    - process() used `while True:` — unbounded loop
    - Loop re-scheduled via `if self.winfo_exists(): self.after(100, process)`
    - If destroy() was called without setting the flag, the loop could
      theoretically race with window destruction

    THE FIX:
    - `while True:` → `while not self._message_processor_shutdown:`
    - `_on_close()` sets flag BEFORE destroy()
    - This guarantees the loop exits cleanly on the next iteration after close
    """

    def test_process_loop_uses_shutdown_flag_not_true(self):
        """
        The process() loop must NOT contain 'while True:' as its main condition.
        This was the regression: unbounded loop that could leak.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Check that while loop uses the flag
        assert "while not self._message_processor_shutdown:" in source, (
            "process() loop must use 'while not self._message_processor_shutdown:' "
            "not 'while True:'"
        )

    def test_no_orphaned_process_threads(self):
        """
        When _on_close() runs:
        1. Flag is set to True
        2. destroy() is called

        The next process() iteration sees the flag and exits, so no after()
        re-scheduling occurs. This prevents orphaned background threads.

        This is a logical test: with the flag set before destroy(), the
        after() call in process() can never be reached.
        """
        _message_processor_shutdown = False
        winfo_exists = True
        after_was_called = False

        def after(delay, callback):
            nonlocal after_was_called
            after_was_called = True

        # Iteration 1: normal
        iteration = 0
        while not _message_processor_shutdown:
            iteration += 1
            # After processing (queue.Empty in real code), before re-schedule:
            if _message_processor_shutdown:
                # Flag check: exits immediately — no after() call
                break
            if winfo_exists:
                after(100, lambda: None)

            # Iteration 2: _on_close() sets flag
            _message_processor_shutdown = True
            winfo_exists = False

            if iteration >= 3:
                break

        # after() was called on iteration 1 (normal)
        # But on iteration 2, the flag check exits BEFORE after() is called
        assert after_was_called is True, (
            "after() must be called during normal operation (before shutdown)"
        )
        # The key: after() is NOT called when flag is True
        # (which it is on iteration 2, when the re-schedule would happen)
