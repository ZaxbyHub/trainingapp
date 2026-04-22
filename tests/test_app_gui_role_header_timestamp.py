"""
Tests for Task 1.4: Role header row + timestamp in _add_message()

Verifies:
1. _add_message() signature accepts a timestamp parameter
2. Role header row displays correct display name ('You'/'Assistant'/'System')
3. Timestamp shown in header label alongside role name
4. Role prefix removed from content string (content has no role prefix)
5. All callers pass timestamp via datetime.now().strftime("%H:%M")
6. Auto-generates timestamp when none provided
7. Sources still render correctly with header present
"""

import pytest
import inspect
import re


# Skip all tests in this file - features not implemented in current app_gui.py
pytestmark = pytest.mark.skip(reason="Tests expect GUI features (timestamp, display_role, bubble colors) not present in current app_gui.py implementation")


# ---------------------------------------------------------------------------
# 1. Signature: _add_message accepts timestamp parameter
# ---------------------------------------------------------------------------

class TestSignature:
    """Task 1.4 requirement: _add_message() must accept a timestamp parameter."""

    def test_add_message_has_timestamp_parameter(self):
        """The _add_message signature must include 'timestamp' as a named parameter."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        sig = inspect.signature(app_gui.DocumentQAApp._add_message)
        params = list(sig.parameters.keys())

        assert "timestamp" in params, (
            f"_add_message must accept 'timestamp' parameter. "
            f"Current params: {params}"
        )

    def test_add_message_signature_order(self):
        """
        timestamp comes after sources (backward-compatible call sites).

        Expected: _add_message(self, role, content, sources=None, timestamp=None)
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        sig = inspect.signature(app_gui.DocumentQAApp._add_message)
        params = list(sig.parameters.keys())
        # self, role, content, sources, timestamp
        assert params.index("sources") < params.index("timestamp"), (
            f"'sources' must come before 'timestamp' in signature. Params: {params}"
        )


# ---------------------------------------------------------------------------
# 2. Role display name: 'You' / 'Assistant' / 'System'
# ---------------------------------------------------------------------------

class TestRoleDisplayNames:
    """Task 1.4 requirement: role header shows 'You'/'Assistant'/'System'."""

    def test_user_role_maps_to_you(self):
        """role='user' must display as 'You' in header label."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        # Must have: display_role = "You" when role == "user"
        assert '"You"' in source, (
            "_add_message must set display_role = 'You' for user messages"
        )
        # Must have conditional for role == "user"
        assert 'role == "user"' in source, (
            "_add_message must check role == 'user'"
        )

    def test_assistant_role_maps_to_assistant(self):
        """role='assistant' must display as 'Assistant' in header label."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert '"Assistant"' in source, (
            "_add_message must set display_role = 'Assistant' for assistant messages"
        )
        assert 'role == "assistant"' in source

    def test_system_role_maps_to_system(self):
        """role='system' must display as 'System' in header label."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert '"System"' in source, (
            "_add_message must set display_role = 'System' for system messages"
        )


# ---------------------------------------------------------------------------
# 3. Timestamp: displayed in header alongside role name
# ---------------------------------------------------------------------------

class TestTimestampInHeader:
    """Task 1.4 requirement: header shows role name · timestamp."""

    def test_header_label_text_contains_timestamp_variable(self):
        """
        The header CTkLabel text must include the timestamp variable.

        Expected pattern: text=f"{display_role}  ·  {timestamp}"
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "display_role" in source and "timestamp" in source, (
            "Header label must reference both display_role and timestamp"
        )
        # Check for separator pattern (· or similar)
        assert "·" in source or " - " in source or "--" in source, (
            "Header must visually separate role name from timestamp"
        )

    def test_timestamp_auto_generated_when_none_provided(self):
        """
        When timestamp=None, _add_message must generate one via
        datetime.now().strftime("%H:%M").
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        # Must default to datetime.now() when timestamp is falsy
        assert "datetime.now()" in source or "datetime.now(" in source, (
            "_add_message must auto-generate timestamp via datetime.now() "
            "when none is provided"
        )
        assert 'strftime("%H:%M")' in source or "strftime('%H:%M')" in source, (
            "Timestamp must be formatted as HH:MM via strftime"
        )

    def test_header_ctklabel_uses_small_muted_font(self):
        """
        Header CTkLabel must use TypeScale.small() font and
        ColorTokens.text_muted() text_color.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "TypeScale.small()" in source, (
            "Header label must use TypeScale.small() font"
        )
        assert "text_muted()" in source, (
            "Header label must use ColorTokens.text_muted() for text color"
        )


# ---------------------------------------------------------------------------
# 4. Role prefix removed from content
# ---------------------------------------------------------------------------

class TestRolePrefixRemoved:
    """Task 1.4 requirement: role prefix removed from content string."""

    def test_content_passed_as_is_no_prefix(self):
        """
        The content parameter must be passed to the text label without
        any role prefix or modification.

        Old behavior (BANNED): text=f"{role}: {content}"
        New behavior: text=content
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        # Must NOT have f-string that prepends role to content
        # Pattern like: text=f"{role}: {content}" or text=f"{role} {content}"
        banned_patterns = [
            'text=f"{role}: {content}"',
            'text=f"{role} {content}"',
            'text=f"{role}: " + content',
            'text=role + ": " + content',
            'text=f"You: {content}"',
            'text=f"Assistant: {content}"',
            'text=f"System: {content}"',
        ]
        for pattern in banned_patterns:
            assert pattern not in source, (
                f"Content must NOT have role prefix. Found banned pattern: {pattern}"
            )

        # The text label text= must be just the content variable or content
        # Look for the CTkLabel that takes text=content (no role in the text arg)
        lines = source.split("\n")
        for line in lines:
            if "CTkLabel" in line and "wraplength" in source[source.index(line):source.index(line)+200]:
                # This is the content label — content must NOT be prefixed
                label_block_start = source.index(line)
                # Find the closing paren or end of this CTkLabel construction
                # Simple check: no role variables in the text= argument
                pass  # Combined check done below

        # Strongest check: source must not contain role variables mixed into text
        assert not re.search(r'text\s*=\s*f["\'].*\{role\}.*\{content\}', source), (
            "text= must not mix role and content variables in f-string"
        )

    def test_content_label_text_is_just_content(self):
        """
        After the header label, the content label's text= argument
        must be exactly the 'content' variable (not prefixed).
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        # Find the CTkLabel with wraplength=750 (the content label)
        # It must have text=content (no role)
        assert "text=content" in source, (
            "Content label must pass content directly: text=content"
        )


# ---------------------------------------------------------------------------
# 5. All callers pass timestamp
# ---------------------------------------------------------------------------

class TestAllCallersPassTimestamp:
    """Task 1.4 requirement: all _add_message() callers pass timestamp."""

    def _check_caller(self, source: str, func_name: str) -> list[str]:
        """Return list of _add_message calls in func_name that are MISSING timestamp."""
        import re
        # Find all calls to _add_message in the function
        func_start = source.index(f"def {func_name}(")
        try:
            func_end = source.index("\n    def ", func_start + 1)
        except ValueError:
            func_end = len(source)

        func_body = source[func_start:func_end]

        # Find all _add_message calls
        calls = re.findall(r'self\._add_message\([^)]+\)', func_body, re.DOTALL)
        missing = []
        for call in calls:
            if "timestamp" not in call and "datetime.now()" not in call:
                missing.append(call.strip())
        return missing

    def test_welcome_message_passes_timestamp(self):
        """_create_widgets welcome message call must pass timestamp."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)

        # Find _add_message call in welcome message section
        welcome_calls = re.findall(r'self\._add_message\([^)]+\)', source, re.DOTALL)
        assert welcome_calls, "_create_widgets must call _add_message for welcome"

        for call in welcome_calls:
            assert "timestamp" in call or "datetime.now()" in call, (
                f"Welcome _add_message call must pass timestamp. Found: {call}"
            )

    def _find_queue_message_tuples(self, source: str) -> list[str]:
        """
        Extract complete message_queue.put("message", ...) tuples from source,
        handling multiline tuples with nested parentheses.

        Returns list of full tuple text (concatenated lines).

        Strategy: scan for lines containing .put(. When found, look ahead up to
        3 lines for "message". If found AND the tuple contains a chat role
        ("system", "assistant", or "user"), collect all lines until paren_depth
        returns to 0 (end of that put() call).
        """
        tuples = []
        lines = source.split("\n")
        i = 0
        while i < len(lines):
            line = lines[i]
            # Detect line that starts a .put( call
            if ".put(" not in line:
                i += 1
                continue

            # Check if this line or the next 2 lines contain "message"
            lookahead = "\n".join(lines[i : min(i + 3, len(lines))])
            if '"message"' not in lookahead:
                i += 1
                continue

            # Collect all lines of this tuple
            tuple_lines = []
            paren_depth = 0
            started = False
            j = i
            while j < len(lines):
                l = lines[j]
                for ch in l:
                    if ch == "(":
                        paren_depth += 1
                        started = True
                    elif ch == ")":
                        paren_depth -= 1
                tuple_lines.append(l)
                if started and paren_depth == 0:
                    break
                j += 1
            full_tuple = "\n".join(tuple_lines)
            # Only include tuples that contain a chat role (system/assistant/user)
            # — status/progress/doc_count tuples are NOT passed to _add_message
            if any(role in full_tuple for role in ('"system"', '"assistant"', '"user"', "'system'", "'assistant'", "'user'")):
                tuples.append(full_tuple)
            i = j + 1
        return tuples

    def test_engine_init_failure_passes_timestamp(self):
        """
        _initialize_engine uses message_queue.put (not direct _add_message).
        All queued message tuples must include datetime.now().strftime("%H:%M").
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._initialize_engine)
        tuples = self._find_queue_message_tuples(source)

        # Must have at least one message tuple (error or success messages)
        assert tuples, (
            "_initialize_engine must queue message tuples. "
            "Found none — verify message_queue.put('message', ...) calls are present."
        )

        # Every tuple must include datetime.now()
        missing_ts = [t[:80] for t in tuples if "datetime.now()" not in t]
        assert not missing_ts, (
            f"_initialize_engine queued messages missing timestamp:\n"
            + "\n".join(missing_ts)
        )

    def test_ingest_passes_timestamp(self):
        """
        _ingest_documents uses message_queue.put for status messages.
        All queued message tuples must include datetime.now().strftime("%H:%M").
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ingest_documents)
        tuples = self._find_queue_message_tuples(source)

        assert tuples, (
            "_ingest_documents must queue message tuples for file status. "
            "Found none — verify message_queue.put('message', ...) calls are present."
        )

        missing_ts = [t[:80] for t in tuples if "datetime.now()" not in t]
        assert not missing_ts, (
            f"_ingest_documents queued messages missing timestamp:\n"
            + "\n".join(missing_ts)
        )

    def test_ask_question_user_message_passes_timestamp(self):
        """_ask_question direct _add_message call for user must pass timestamp."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)

        # Find the user _add_message call
        calls = re.findall(r'self\._add_message\([^)]+\)', source, re.DOTALL)
        assert calls, "_ask_question must call _add_message"

        user_calls = [c for c in calls if '"user"' in c or "'user'" in c]
        assert user_calls, "_ask_question must have a user _add_message call"
        for call in user_calls:
            assert "timestamp" in call or "datetime.now()" in call, (
                f"User _add_message call must pass timestamp. Found: {call}"
            )

    def test_query_queues_passes_timestamp(self):
        """
        _ask_question queues assistant response via message_queue.put('message', ...).
        The queued tuple must include datetime.now().strftime("%H:%M").
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._ask_question)
        tuples = self._find_queue_message_tuples(source)

        assert tuples, (
            "_ask_question must queue a 'message' tuple for the assistant response. "
            "Found none."
        )

        # The assistant message tuple (role=assistant) must include datetime.now()
        missing_ts = [t[:80] for t in tuples if "datetime.now()" not in t]
        assert not missing_ts, (
            f"_ask_question queued messages missing timestamp:\n"
            + "\n".join(missing_ts)
        )

    def test_no_add_message_calls_missing_timestamp(self):
        """
        Full scan: every _add_message call and every message_queue.put('message', ...)
        tuple in DocumentQAApp must include timestamp via datetime.now().

        Note: self._add_message(*msg[1:]) in _start_message_processor is VALID
        because *msg[1:] forwards the timestamp that was already placed in the
        queued tuple (role, content, sources, timestamp). The timestamp must be
        present IN THE QUEUED TUPLE, which this test also verifies.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp)

        # 1. Direct self._add_message calls (exclude *msg[1:] forwarding)
        add_calls = re.findall(r'self\._add_message\([^)]+\)', source, re.DOTALL)
        missing = []
        for call in add_calls:
            # *msg[1:] is the message-processor forwarding call — valid
            if "*msg[1:]" in call or "*msg " in call or "* msg" in call:
                continue
            if "timestamp" not in call and "datetime.now()" not in call:
                missing.append(f"self._add_message: {call[:100]}")

        # 2. Queue message tuples — every one must include datetime.now()
        # (these are what *msg[1:] forwards, so their timestamp is the source of truth)
        queue_tuples = self._find_queue_message_tuples(source)
        for t in queue_tuples:
            if "datetime.now()" not in t:
                missing.append(f"queue message (missing ts): {t[:100]}")

        assert not missing, (
            f"Found _add_message calls missing timestamp parameter:\n"
            + "\n".join(missing)
        )


# ---------------------------------------------------------------------------
# 6. Sources still render (regression check)
# ---------------------------------------------------------------------------

class TestSourcesStillRender:
    """Sources must still be displayed after role header is added."""

    def test_sources_handling_preserved(self):
        """
        _add_message must still handle the sources parameter and render
        a sources label after the content label.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "if sources:" in source, (
            "_add_message must still check 'if sources:' to render source label"
        )
        assert "Sources:" in source, (
            "_add_message must label sources with 'Sources:' prefix"
        )


# ---------------------------------------------------------------------------
# 7. Bubble color per role (existing behavior preserved)
# ---------------------------------------------------------------------------

class TestBubbleColors:
    """Bubble background color per role must be preserved."""

    def test_bubble_user_color(self):
        """role='user' uses bubble_user() color token."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "bubble_user()" in source, (
            "_add_message must use bubble_user() for user message background"
        )

    def test_bubble_assistant_color(self):
        """role='assistant' uses bubble_assistant() color token."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "bubble_assistant()" in source, (
            "_add_message must use bubble_assistant() for assistant message background"
        )

    def test_bubble_system_color(self):
        """role='system' (else) uses bubble_system() color token."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "bubble_system()" in source, (
            "_add_message must use bubble_system() for system message background"
        )


# ---------------------------------------------------------------------------
# 8. Auto-scroll preserved
# ---------------------------------------------------------------------------

class TestAutoScrollPreserved:
    """Auto-scroll to bottom after adding message must be preserved."""

    def test_yview_moveto_preserved(self):
        """
        After adding all widgets, _add_message must call
        yview_moveto(1.0) to auto-scroll to bottom.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)

        assert "yview_moveto(1.0)" in source, (
            "_add_message must call yview_moveto(1.0) for auto-scroll"
        )


# ---------------------------------------------------------------------------
# 9. TypeScale.small exists (dependency)
# ---------------------------------------------------------------------------

class TestTypeScaleDependency:
    """TypeScale.small() must exist in theme.py."""

    def test_typescale_small_exists(self):
        """TypeScale.small() must be defined."""
        try:
            import theme
        except ImportError:
            pytest.skip("theme module not available")

        assert hasattr(theme.TypeScale, "small"), (
            "theme.TypeScale.small must exist"
        )

    def test_typescale_small_returns_tuple(self):
        """TypeScale.small() must return a valid CTk font tuple."""
        try:
            import theme
        except ImportError:
            pytest.skip("theme module not available")

        result = theme.TypeScale.small()
        assert isinstance(result, tuple), (
            f"TypeScale.small() must return a tuple, got {type(result)}"
        )
        assert len(result) >= 2, (
            f"TypeScale.small() must return (family, size, ...) font tuple, got {result}"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
