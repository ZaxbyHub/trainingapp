"""
Tests for Task 4.2: Exception logging fix in streaming message handlers.

Verifies that the three silent `except Exception: pass` patterns in the streaming
message functions have been replaced with proper logging calls using the
`app_gui` logger.
"""

import re

# Path resolved at module load so tests can run from any working directory
_SOURCE_FILE = __file__.rsplit("/", 1)[0] + "/../app_gui.py"
_SOURCE_FILE = _SOURCE_FILE.replace("\\", "/")  # Normalize to forward slashes

# Platform-agnostic resolution for Windows
import os as _os
_SOURCE_FILE = _os.path.normpath(
    _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "app_gui.py")
)


def _read_source() -> str:
    with open(_SOURCE_FILE, "r", encoding="utf-8") as f:
        return f.read()


def _extract_function_body(source: str, func_name: str) -> str:
    """Extract the body of a method from the source code."""
    pattern = rf"(?m)^\s+def {re.escape(func_name)}\(.*?\)\s*(?:->\s*\w+)?\s*:\n"
    match = re.search(pattern, source)
    if not match:
        raise ValueError(f"Function '{func_name}' not found in source")
    start = match.end()

    # Count leading whitespace of first line
    first_line_match = re.search(r"(?m)^(\s+)", source[match.start():match.end()])
    base_indent = len(first_line_match.group(1)) if first_line_match else 0

    # Find end of function (next def/class at same or lower indent, or dedent)
    lines = source[start:].splitlines()
    body_lines = []
    for line in lines:
        if line.strip() == "":
            body_lines.append(line)
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= base_indent and (line.strip().startswith("def ") or line.strip().startswith("class ")):
            break
        body_lines.append(line)

    return "\n".join(body_lines)


class TestStreamingExceptionLoggingFix:
    """Verify the three streaming exception handlers log instead of silently pass."""

    def test_get_streaming_text_has_logging_on_widget_access_failure(self):
        """_get_streaming_text: exception handler must call app_gui logger at debug level."""
        source = _read_source()
        body = _extract_function_body(source, "_get_streaming_text")

        # Must use logging.getLogger("app_gui")
        has_logger_call = bool(
            re.search(r'logging\.getLogger\(["\']app_gui["\']\)', body)
        )
        assert has_logger_call, (
            "_get_streaming_text: missing `logging.getLogger('app_gui')` call in exception handler"
        )

        # Must call .debug() on that logger
        has_debug = bool(
            re.search(r'logging\.getLogger\(["\']app_gui["\']\)\.debug\(', body)
        )
        assert has_debug, (
            "_get_streaming_text: exception handler must call .debug() on the app_gui logger, "
            "not error/warning/info"
        )

        # Must NOT contain silent `pass`
        silent_pass_pattern = re.compile(
            r"except\s+Exception\s+as\s+\w+:\s+pass",
            re.DOTALL
        )
        has_silent_pass = bool(silent_pass_pattern.search(body))
        assert not has_silent_pass, (
            "_get_streaming_text: exception handler still contains silent `pass` — "
            "must log the exception instead"
        )

    def test_finalize_streaming_message_add_message_logs_error_on_failure(self):
        """_finalize_streaming_message: _add_message exception handler must log at error level."""
        source = _read_source()
        body = _extract_function_body(source, "_finalize_streaming_message")

        # Locate the _add_message try/except block.
        # Pattern: try:\n followed by indented self._add_message(...) call,
        # then the except line capturing the handler body.
        add_message_exc_pattern = re.compile(
            r"try:\n\s+self\._add_message.*?\n\s+except\s+Exception\s+as\s+(\w+):\n((?:\s+.+\n)+)",
            re.DOTALL
        )
        match = re.search(add_message_exc_pattern, body)
        assert match, (
            "_finalize_streaming_message: could not locate `try: ... self._add_message(...)` "
            "exception handler in function body"
        )

        exception_var = match.group(1)
        handler_body = match.group(2)

        # Must use logging.getLogger("app_gui")
        has_logger = bool(
            re.search(r'logging\.getLogger\(["\']app_gui["\']\)', handler_body)
        )
        assert has_logger, (
            f"_finalize_streaming_message: exception handler around _add_message "
            f"missing `logging.getLogger('app_gui')`"
        )

        # Must call .error()
        has_error = bool(
            re.search(r'logging\.getLogger\(["\']app_gui["\']\)\.error\(', handler_body)
        )
        assert has_error, (
            "_finalize_streaming_message: _add_message exception handler must call "
            ".error() on app_gui logger (not debug/warning/info)"
        )

        # Must NOT contain silent pass
        has_silent_pass = bool(
            re.compile(r"except\s+Exception\s+as\s+\w+:\s+pass").search(handler_body)
        )
        assert not has_silent_pass, (
            "_finalize_streaming_message: _add_message exception handler "
            "still contains silent `pass`"
        )

        # The error message should mention the exception variable
        has_exception_ref = exception_var in handler_body
        assert has_exception_ref, (
            f"_finalize_streaming_message: _add_message exception handler "
            f"should include the exception variable '{exception_var}' in the log message"
        )

    def test_finalize_streaming_message_frame_destroy_logs_debug_on_failure(self):
        """_finalize_streaming_message: frame.destroy() exception handler must log at debug level."""
        source = _read_source()
        body = _extract_function_body(source, "_finalize_streaming_message")

        # Locate the frame destroy try/except block.
        # Pattern: try:\n followed by indented statements including .destroy(),
        # then the except line capturing the handler body.
        destroy_exc_pattern = re.compile(
            r"try:\n\s+.*?\.destroy\(\).*?\n\s+except\s+Exception\s+as\s+(\w+):\n((?:\s+.+\n)+)",
            re.DOTALL
        )
        match = re.search(destroy_exc_pattern, body)
        assert match, (
            "_finalize_streaming_message: could not locate `try: ... .destroy() ...` "
            "exception handler in function body"
        )

        exception_var = match.group(1)
        handler_body = match.group(2)

        # Must use logging.getLogger("app_gui")
        has_logger = bool(
            re.search(r'logging\.getLogger\(["\']app_gui["\']\)', handler_body)
        )
        assert has_logger, (
            "_finalize_streaming_message: frame.destroy() exception handler "
            "missing `logging.getLogger('app_gui')`"
        )

        # Must call .debug()
        has_debug = bool(
            re.search(r'logging\.getLogger\(["\']app_gui["\']\)\.debug\(', handler_body)
        )
        assert has_debug, (
            "_finalize_streaming_message: frame.destroy() exception handler must call "
            ".debug() on app_gui logger (not error/warning/info)"
        )

        # Must NOT contain silent pass
        has_silent_pass = bool(
            re.compile(r"except\s+Exception\s+as\s+\w+:\s+pass").search(handler_body)
        )
        assert not has_silent_pass, (
            "_finalize_streaming_message: frame.destroy() exception handler "
            "still contains silent `pass`"
        )

        # Should reference the exception variable
        has_exception_ref = exception_var in handler_body
        assert has_exception_ref, (
            f"_finalize_streaming_message: frame.destroy() exception handler "
            f"should include the exception variable '{exception_var}' in the log message"
        )


class TestNoSilentPassInAffectedFunctions:
    """Ensure the affected functions no longer contain any bare silent pass patterns."""

    def test_no_silent_pass_in_get_streaming_text(self):
        """_get_streaming_text must not contain `except Exception: pass`."""
        source = _read_source()
        body = _extract_function_body(source, "_get_streaming_text")

        matches = list(re.finditer(r"except\s+Exception\s+as\s+\w+:\s*pass", body))
        assert len(matches) == 0, (
            f"_get_streaming_text contains {len(matches)} silent `except Exception: pass` "
            f"handler(s). Replace with logging.getLogger('app_gui').debug(...)"
        )

    def test_no_silent_pass_in_finalize_streaming_message(self):
        """_finalize_streaming_message must not contain `except Exception: pass`."""
        source = _read_source()
        body = _extract_function_body(source, "_finalize_streaming_message")

        matches = list(re.finditer(r"except\s+Exception\s+as\s+\w+:\s*pass", body))
        assert len(matches) == 0, (
            f"_finalize_streaming_message contains {len(matches)} silent `except Exception: pass` "
            f"handler(s). Replace with logging calls."
        )


class TestLoggerNameConsistency:
    """Ensure all three exception handlers use the canonical 'app_gui' logger name."""

    def test_all_three_handlers_use_same_logger_name(self):
        """All three exception handlers must call logging.getLogger('app_gui')."""
        source = _read_source()
        body_finalize = _extract_function_body(source, "_finalize_streaming_message")
        body_get = _extract_function_body(source, "_get_streaming_text")

        # Extract all logging.getLogger calls from both functions
        logger_calls = re.findall(
            r'logging\.getLogger\(["\']([^"\']+)["\']\)',
            body_finalize + "\n" + body_get
        )

        # All must be 'app_gui'
        non_app_gui = [name for name in logger_calls if name != "app_gui"]
        assert len(non_app_gui) == 0, (
            f"Found logger names other than 'app_gui': {set(non_app_gui)}. "
            f"All streaming exception handlers must use 'app_gui' logger."
        )

        # Must have exactly 3 calls (one per handler)
        assert len(logger_calls) >= 3, (
            f"Expected at least 3 logging.getLogger('app_gui') calls in the streaming "
            f"functions, found {len(logger_calls)}. Are all three exception handlers wired?"
        )
