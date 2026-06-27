"""
Tests for cancel_button show/hide message routing in app_gui.py (Task 1.2).

Verifies the routing path: worker → message_queue → _start_message_processor
→ cancel_button widget pack state changes on the main thread.

This is a FAITHFUL INTEGRATION TEST that calls the REAL _start_message_processor
dispatch logic against a lightweight test double — it does NOT re-implement handler
logic.
"""

import pytest
import queue
import inspect
import sys


def _import_app_gui():
    try:
        import customtkinter
        import app_gui
        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed — cannot test GUI widget behavior")


_real_tkinter_cache = None


def _force_real_tkinter():
    """Return real tkinter, temporarily clearing any leaked mock from sys.modules.

    Other test modules (e.g. test_corrective_pass.py) install a MagicMock for
    tkinter at collection time for headless CI. That mock leaks into this
    module's import, making tk.Tk()/tk.Button() return mocks. We clear the
    mock, import real tkinter (cached after first import to avoid re-executing
    module code on every test), and return it along with saved state for
    restoration after the test.
    """
    global _real_tkinter_cache
    saved = {}
    for key in list(sys.modules):
        if key == "tkinter" or key.startswith("tkinter."):
            saved[key] = sys.modules.pop(key)
    if _real_tkinter_cache is not None:
        sys.modules["tkinter"] = _real_tkinter_cache
        return _real_tkinter_cache, saved
    import tkinter as _tk
    _real_tkinter_cache = _tk
    return _tk, saved


def _restore_tkinter(saved):
    """Restore sys.modules tkinter entries saved by _force_real_tkinter."""
    for key, val in saved.items():
        sys.modules[key] = val


class TestCancelButtonShowHideRouting:
    """
    Test the cancel_button_show / cancel_button_hide message routing via the
    REAL _start_message_processor dispatch code path.
    """

    @pytest.fixture
    def tk_root_and_double(self):
        """
        Build a lightweight test double that the real _start_message_processor
        can operate on as `self`, plus a real Tk root for widget geometry.
        """
        app_gui = _import_app_gui()
        tk, _saved = _force_real_tkinter()
        try:
            # Real withdrawn Tk root — provides the widget geometry system
            root = tk.Tk()
            root.withdraw()

            # SimpleNamespace or minimal class as the test double
            class Double:
                pass

            double = Double()

            # Required attributes that _start_message_processor reads/writes
            double.message_queue = queue.Queue()
            double._message_processor_shutdown = False

            # winfo_exists must exist and return True so the handler runs
            def winfo_exists():
                return True
            double.winfo_exists = winfo_exists

            # `after` — capture the `process` closure the first time it's called,
            # otherwise no-op (we drive it manually, not via the Tk event loop)
            double._captured_after_callback = None

            def after(delay, callback):
                if double._captured_after_callback is None:
                    double._captured_after_callback = callback
                # On subsequent calls (re-schedule), also capture
                # (each call to process() re-schedules itself)

            double.after = after

            # Real tk.Button so pack()/pack_forget()/winfo_manager() work for assertions
            double.cancel_button = tk.Button(root)

            # Spacing — the handler uses Spacing.LG and Spacing.SM from theme.py
            # Import Spacing from app_gui module level
            from theme import Spacing
            double.Spacing = Spacing

            yield double, root

            # Cleanup
            double._message_processor_shutdown = True
            try:
                root.destroy()
            except Exception:
                # Already destroyed or not connected
                pass
        finally:
            _restore_tkinter(_saved)

    def test_cancel_button_show_then_hide(self, tk_root_and_double):
        """
        Emit ('cancel_button_show',) → process() → button packed.
        Then emit ('cancel_button_hide',) → process() → button unpacked.
        """
        app_gui = _import_app_gui()
        double, root = tk_root_and_double

        # Invoke the REAL _start_message_processor on the double
        # In Python 3, unbound method can be called with instance as first arg
        app_gui.DocumentQAApp._start_message_processor(double)

        # The method called double.after(100, process) — capture the process closure
        assert double._captured_after_callback is not None, \
            "_start_message_processor must call self.after(100, process)"
        process = double._captured_after_callback

        # --- Step 1: cancel_button_show ---
        double.message_queue.put(("cancel_button_show",))
        root.update_idletasks()   # Ensure geometry state is fresh
        process()                 # Drive one iteration — drains the queue
        root.update_idletasks()   # Let pack() geometry settle

        # Assert button is now packed
        assert double.cancel_button.winfo_manager() == "pack", \
            f"After cancel_button_show: expected winfo_manager()=='pack', got {double.cancel_button.winfo_manager()!r}"

        # --- Step 2: cancel_button_hide ---
        double.message_queue.put(("cancel_button_hide",))
        root.update_idletasks()
        process()
        root.update_idletasks()

        # Assert button is now unpacked
        assert double.cancel_button.winfo_manager() == "", \
            f"After cancel_button_hide: expected winfo_manager()=='', got {double.cancel_button.winfo_manager()!r}"

    def test_show_hide_idempotent_toggle(self, tk_root_and_double):
        """
        Multiple show→hide→show cycles in sequence must be stable.
        Each transition must produce the correct final pack state.
        """
        app_gui = _import_app_gui()
        double, root = tk_root_and_double

        app_gui.DocumentQAApp._start_message_processor(double)
        process = double._captured_after_callback

        for cycle in range(3):
            # Show
            double.message_queue.put(("cancel_button_show",))
            root.update_idletasks()
            process()
            root.update_idletasks()
            assert double.cancel_button.winfo_manager() == "pack", \
                f"Cycle {cycle}: after show — winfo_manager() must be 'pack'"

            # Hide
            double.message_queue.put(("cancel_button_hide",))
            root.update_idletasks()
            process()
            root.update_idletasks()
            assert double.cancel_button.winfo_manager() == "", \
                f"Cycle {cycle}: after hide — winfo_manager() must be ''"

    def test_hide_when_already_unpacked_is_safe(self, tk_root_and_double):
        """
        pack_forget() on an already-unpacked widget is a no-op — must not raise.
        This can happen if cancel_button_hide is emitted when no operation is active.
        """
        app_gui = _import_app_gui()
        double, root = tk_root_and_double

        app_gui.DocumentQAApp._start_message_processor(double)
        process = double._captured_after_callback

        # Ensure button starts unpacked (should be default for a new button)
        root.update_idletasks()
        assert double.cancel_button.winfo_manager() == "", \
            "New button should not be managed by any geometry manager"

        # Emit hide on an already-unpacked button
        double.message_queue.put(("cancel_button_hide",))
        root.update_idletasks()
        # Must not raise
        process()
        root.update_idletasks()

        # Button should still be unpacked
        assert double.cancel_button.winfo_manager() == "", \
            "After hide on already-unpacked button: winfo_manager() must still be ''"


class TestCancelButtonSourceInspection:
    """
    Source-level sanity checks that the dispatch branches exist.
    These are SECONDARY to the live pack-state tests above.
    """

    def test_both_handler_branches_exist_in_source(self):
        """
        _start_message_processor must contain dispatch logic for both
        'cancel_button_show' and 'cancel_button_hide'.
        """
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        assert 'msg[0] == "cancel_button_show"' in source, \
            "_start_message_processor must handle 'cancel_button_show'"
        assert 'msg[0] == "cancel_button_hide"' in source, \
            "_start_message_processor must handle 'cancel_button_hide'"

    def test_show_handler_uses_pack(self):
        """The cancel_button_show branch must call pack() on cancel_button."""
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        # Find the cancel_button_show branch
        show_branch_idx = source.find('msg[0] == "cancel_button_show"')
        assert show_branch_idx != -1, "cancel_button_show branch not found"

        # The next ~5 lines should contain cancel_button.pack
        show_block = source[show_branch_idx:show_branch_idx + 500]
        assert "cancel_button.pack" in show_block, \
            "cancel_button_show handler must call cancel_button.pack()"

    def test_hide_handler_uses_pack_forget(self):
        """The cancel_button_hide branch must call pack_forget() on cancel_button."""
        app_gui = _import_app_gui()
        source = inspect.getsource(app_gui.DocumentQAApp._start_message_processor)

        hide_branch_idx = source.find('msg[0] == "cancel_button_hide"')
        assert hide_branch_idx != -1, "cancel_button_hide branch not found"

        hide_block = source[hide_branch_idx:hide_branch_idx + 500]
        assert "cancel_button.pack_forget" in hide_block, \
            "cancel_button_hide handler must call cancel_button.pack_forget()"
