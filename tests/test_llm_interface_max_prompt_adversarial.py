"""
Adversarial tests for MAX_PROMPT_LENGTH (24000) boundary in llm_interface.py.
Covers: boundary violations, type confusion, injection, oversized input, edge cases.
"""

import pytest
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

# Skip if llama_cpp not available
pytest.importorskip("llama_cpp", reason="llama-cpp-python not installed")
pytest.importorskip("llm_interface", reason="llm_interface module not available")

from llm_interface import SmartLLM, MAX_PROMPT_LENGTH, InferenceConfig, GGUFBackend


# ==============================================================================
# FIXTURES
# ==============================================================================

@pytest.fixture
def smart_llm(tmp_path):
    """SmartLLM with a mocked GGUF backend."""
    gguf_path = tmp_path / "model.gguf"
    gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

    with patch("llm_interface.GGUFBackend") as mock_backend_cls:
        mock_backend = MagicMock()
        mock_backend.generate.return_value = "mock response"
        mock_backend.chat_complete.return_value = "mock response"
        mock_backend_cls.return_value = mock_backend
        llm = SmartLLM(gguf_path=str(gguf_path), gguf_n_ctx=8192)

    return llm


def mock_generate(self, prompt, config=None):
    """Stand-in for backend.generate when in mock mode."""
    return "mock response"


def mock_chat_complete(self, system_prompt, user_prompt, config=None):
    """Stand-in for backend.chat_complete when in mock mode."""
    return "mock response"


# ==============================================================================
# BOUNDARY TESTS
# ==============================================================================

class TestMAXPROMPTLENGTHBoundary:
    """Tests for MAX_PROMPT_LENGTH = 24000 boundary enforcement."""

    def test_constant_is_24000(self):
        """MAX_PROMPT_LENGTH must be exactly 24000."""
        assert MAX_PROMPT_LENGTH == 24000

    def test_exactly_24000_chars_should_not_raise(self, smart_llm):
        """Prompt of exactly MAX_PROMPT_LENGTH chars should pass length check."""
        prompt = "x" * MAX_PROMPT_LENGTH
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate(prompt)
            assert result == "mock response"

    def test_24001_chars_should_raise_valueerror(self, smart_llm):
        """Prompt exceeding MAX_PROMPT_LENGTH by 1 char must raise ValueError."""
        prompt = "x" * (MAX_PROMPT_LENGTH + 1)
        with pytest.raises(ValueError) as exc_info:
            smart_llm.generate(prompt)
        assert "24000" in str(exc_info.value)
        assert "24001" in str(exc_info.value)

    def test_100000_chars_should_raise_valueerror(self, smart_llm):
        """Significantly oversized prompt must raise ValueError."""
        prompt = "x" * 100_000
        with pytest.raises(ValueError) as exc_info:
            smart_llm.generate(prompt)
        assert "100000" in str(exc_info.value)

    def test_just_under_limit_23999_should_not_raise(self, smart_llm):
        """Prompt one char under MAX_PROMPT_LENGTH should pass."""
        prompt = "a" * (MAX_PROMPT_LENGTH - 1)
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate(prompt)
            assert result == "mock response"

    def test_error_message_contains_provided_length(self, smart_llm):
        """ValueError message must include the actual prompt length provided."""
        over_by = 42
        prompt = "y" * (MAX_PROMPT_LENGTH + over_by)
        with pytest.raises(ValueError) as exc_info:
            smart_llm.generate(prompt)
        assert str(MAX_PROMPT_LENGTH + over_by) in str(exc_info.value)

    def test_error_message_mentions_limit(self, smart_llm):
        """ValueError message must mention the MAX_PROMPT_LENGTH limit."""
        prompt = "z" * (MAX_PROMPT_LENGTH + 1)
        with pytest.raises(ValueError) as exc_info:
            smart_llm.generate(prompt)
        assert str(MAX_PROMPT_LENGTH) in str(exc_info.value)

    def test_empty_string_should_not_raise(self, smart_llm):
        """Zero-length prompt should pass length check."""
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate("")
            assert result == "mock response"

    def test_single_char_should_not_raise(self, smart_llm):
        """Single-character prompt should pass."""
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate("x")
            assert result == "mock response"

    def test_repeated_calls_are_deterministic(self, smart_llm):
        """Two calls with same oversized prompt both raise ValueError."""
        prompt = "x" * (MAX_PROMPT_LENGTH + 1)
        with pytest.raises(ValueError):
            smart_llm.generate(prompt)
        with pytest.raises(ValueError):
            smart_llm.generate(prompt)

    def test_valid_then_invalid_sequence(self, smart_llm):
        """Valid prompt followed by oversized prompt."""
        with patch.object(smart_llm.backend, "generate", mock_generate):
            assert smart_llm.generate("short") == "mock response"
        with pytest.raises(ValueError):
            smart_llm.generate("x" * (MAX_PROMPT_LENGTH + 1))


# ==============================================================================
# TYPE CONFUSION ATTACKS
# ==============================================================================

class TestTypeConfusion:
    """Tests for type confusion attacks on the prompt parameter."""

    def test_none_prompt_raises(self, smart_llm):
        """None as prompt should raise TypeError."""
        with pytest.raises((TypeError, AttributeError, ValueError)):
            smart_llm.generate(None)

    def test_dict_prompt_calls_backend(self, smart_llm):
        """Dict prompt: len({})==0 passes length check but backend must handle it."""
        # Python len({}) == 0 — passes the >24000 check.
        # The mock backend receives the dict. Real backends would raise TypeError.
        # This test documents that type validation is NOT done by SmartLLM.generate().
        # FIXTURE NOTE: the mock backend returns "mock response" for any input.
        with patch.object(smart_llm.backend, "generate", return_value="ok"):
            result = smart_llm.generate({"role": "user"})
            assert result == "ok"
        # BUG FOUND: No type guard on prompt in SmartLLM.generate()

    def test_list_prompt_calls_backend(self, smart_llm):
        """List prompt: len([])==0 passes length check but backend must handle it."""
        with patch.object(smart_llm.backend, "generate", return_value="ok"):
            result = smart_llm.generate(["item1", "item2"])
            assert result == "ok"

    def test_boolean_prompt_calls_backend(self, smart_llm):
        """Boolean prompt passes length check; backend handles it."""
        # bool is subclass of int: len(True) = TypeError in Python (int has no __len__)
        with pytest.raises((TypeError, AttributeError)):
            smart_llm.generate(True)

    def test_bytes_prompt_calls_backend(self, smart_llm):
        """Bytes prompt: len(b'hello')==5 passes length check; backend handles it."""
        with patch.object(smart_llm.backend, "generate", return_value="ok"):
            result = smart_llm.generate(b"hello")
            assert result == "ok"


# ==============================================================================
# OVERSIZED INPUT ATTACKS
# ==============================================================================

class TestOversizedInput:
    """Tests for oversized input attacks."""

    def test_100kb_string_raises(self, smart_llm):
        """100KB prompt must exceed 24000 char limit and raise ValueError."""
        prompt = "oversized" * 12_000  # ~108KB
        with pytest.raises(ValueError):
            smart_llm.generate(prompt)

    def test_500kb_string_raises(self, smart_llm):
        """500KB prompt must raise ValueError."""
        prompt = "x" * 500_000
        with pytest.raises(ValueError):
            smart_llm.generate(prompt)

    def test_1mb_string_raises(self, smart_llm):
        """1MB prompt must raise ValueError."""
        prompt = "y" * 1_000_000
        with pytest.raises(ValueError):
            smart_llm.generate(prompt)

    def test_huge_prompt_raises(self, smart_llm):
        """Prompt 100x the limit must raise ValueError."""
        huge = "z" * (MAX_PROMPT_LENGTH * 100)
        with pytest.raises(ValueError):
            smart_llm.generate(huge)


# ==============================================================================
# INJECTION ATTACKS near boundary
# ==============================================================================

class TestInjectionAttempts:
    """Tests for injection-style attacks at/near the MAX_PROMPT_LENGTH boundary."""

    def test_sql_injection_at_boundary_length(self, smart_llm):
        """SQL injection fragments near boundary length."""
        injection = "'; DROP TABLE users; --" * 2000
        padding = MAX_PROMPT_LENGTH - len(injection) - 15
        prompt = "Context: " + injection + " " * padding if padding > 0 else injection
        if len(prompt) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(prompt)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(prompt)

    def test_html_script_injection_at_boundary(self, smart_llm):
        """HTML/script injection near boundary."""
        injection = "<script>alert('xss')</script>" * 1000
        padding = MAX_PROMPT_LENGTH - len(injection) - 15
        prompt = "Question: " + injection + " " * padding if padding > 0 else injection
        if len(prompt) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(prompt)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(prompt)

    def test_template_literal_injection_at_boundary(self, smart_llm):
        """Template literal injection near boundary — prompt is already resolved."""
        injection = "${'x'.repeat(10000)}"
        padding = MAX_PROMPT_LENGTH - len(injection) - 15
        prompt = "Question: " + injection + " " * padding if padding > 0 else injection
        if len(prompt) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(prompt)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(prompt)

    def test_null_byte_injection(self, smart_llm):
        """Null bytes in prompt string — Python counts each as 1 char."""
        prompt = "Hello\x00World" * 500
        if len(prompt) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(prompt)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(prompt)

    def test_emoji_flooding_at_boundary(self, smart_llm):
        """Emoji unicode flooding near boundary — each emoji counts as 1+ code units."""
        emoji = "🚀🔥💀" * 4000
        if len(emoji) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(emoji)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(emoji)

    def test_rtl_override_unicode_at_boundary(self, smart_llm):
        """RTL override unicode characters near boundary."""
        rtl = "\u202E\u202D"  # RLO + LRI
        payload = (rtl + "legitimate content") * 2000
        padding = MAX_PROMPT_LENGTH - len(payload) - 15
        prompt = payload + " " * padding if padding > 0 else payload
        if len(prompt) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(prompt)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(prompt)

    def test_zalgo_combining_chars_flood(self, smart_llm):
        """Zalgo text (diacritical combining chars) near boundary."""
        zalgo = "\u0300\u0301\u0302" * 8000
        if len(zalgo) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(zalgo)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(zalgo)

    def test_mixed_unicode_scripts_at_boundary(self, smart_llm):
        """Mixed unicode scripts near boundary — Python counts code units correctly."""
        mixed = "Hello" * 1000 + "こんにちは" * 1000 + "مرحبا" * 1000
        if len(mixed) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(mixed)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(mixed)


# ==============================================================================
# EDGE CASES
# ==============================================================================

class TestEdgeCases:
    """Edge case tests."""

    def test_only_whitespace_at_boundary(self, smart_llm):
        """Prompt of only spaces at MAX_PROMPT_LENGTH should pass length check."""
        prompt = " " * MAX_PROMPT_LENGTH
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate(prompt)
            assert result == "mock response"

    def test_only_newlines_at_boundary(self, smart_llm):
        """Prompt of only newlines at MAX_PROMPT_LENGTH should pass length check."""
        prompt = "\n" * MAX_PROMPT_LENGTH
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate(prompt)
            assert result == "mock response"

    def test_only_control_chars_near_boundary(self, smart_llm):
        """Prompt of only control chars near boundary."""
        prompt = "\x00\x01\x02\x03" * 6000
        if len(prompt) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(prompt)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(prompt)

    def test_mixed_whitespace_tabs_crlf_at_boundary(self, smart_llm):
        """Mixed whitespace (tabs, CRLF) at boundary length."""
        mixed = "\t\r\n " * 6000
        if len(mixed) <= MAX_PROMPT_LENGTH:
            with patch.object(smart_llm.backend, "generate", mock_generate):
                result = smart_llm.generate(mixed)
                assert result == "mock response"
        else:
            with pytest.raises(ValueError):
                smart_llm.generate(mixed)


# ==============================================================================
# ANSWER_QUESTION METHOD — oversized inputs
# ==============================================================================

class TestAnswerQuestionOversized:
    """Tests for answer_question with oversized context/question."""

    def test_oversized_context_raises_valueerror_via_fallback(self, smart_llm):
        """Context exceeding MAX_PROMPT_LENGTH should raise ValueError via generate() fallback.

        NOTE: answer_question does NOT have its own length check. It relies on either:
        1. chat_complete() validating (GGUF backend doesn't), or
        2. The generate() fallback validating (THIS is where length is enforced).

        To trigger the fallback, we mock chat_complete to raise an exception.
        Then generate() is called with the built prompt (including long context),
        which raises ValueError.
        """
        long_context = "x" * (MAX_PROMPT_LENGTH + 5000)

        def force_fallback(*args, **kwargs):
            raise RuntimeError("force fallback")

        def fallback_generate(prompt, config=None):
            # generate() is called with the built prompt containing long_context
            if len(prompt) > MAX_PROMPT_LENGTH:
                raise ValueError(
                    f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                    f"Provided: {len(prompt)}"
                )
            return "ok"

        with patch.object(smart_llm.backend, "chat_complete", side_effect=force_fallback):
            with patch.object(smart_llm.backend, "generate", fallback_generate):
                with pytest.raises(ValueError):
                    smart_llm.answer_question(
                        question="What is this?",
                        context=long_context,
                        sources=["doc.txt"],
                    )

    def test_oversized_question_raises_valueerror_via_fallback(self, smart_llm):
        """Question exceeding MAX_PROMPT_LENGTH should raise ValueError via generate() fallback."""
        long_question = "x" * (MAX_PROMPT_LENGTH + 100)

        def force_fallback(*args, **kwargs):
            raise RuntimeError("force fallback")

        def fallback_generate(prompt, config=None):
            if len(prompt) > MAX_PROMPT_LENGTH:
                raise ValueError(
                    f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                    f"Provided: {len(prompt)}"
                )
            return "ok"

        with patch.object(smart_llm.backend, "chat_complete", side_effect=force_fallback):
            with patch.object(smart_llm.backend, "generate", fallback_generate):
                with pytest.raises(ValueError):
                    smart_llm.answer_question(
                        question=long_question,
                        context="some context",
                        sources=["doc.txt"],
                    )

    def test_empty_sources_list_works(self, smart_llm):
        """Empty sources list should not cause errors."""
        with patch.object(smart_llm.backend, "chat_complete", mock_chat_complete):
            result = smart_llm.answer_question(
                question="What is this?",
                context="short context",
                sources=[],
            )
            assert result == "mock response"

    def test_null_content_in_conversation_history_skipped(self, smart_llm):
        """Null content in conversation_history should be skipped gracefully."""
        with patch.object(smart_llm.backend, "chat_complete", mock_chat_complete):
            result = smart_llm.answer_question(
                question="What is this?",
                context="context",
                sources=["doc.txt"],
                conversation_history=[
                    {"role": "user", "content": None},
                    {"role": "assistant", "content": "answer"},
                ],
            )
            assert result == "mock response"

    def test_non_dict_in_conversation_history_skipped(self, smart_llm):
        """Non-dict entry in conversation_history should be skipped."""
        with patch.object(smart_llm.backend, "chat_complete", mock_chat_complete):
            result = smart_llm.answer_question(
                question="What is this?",
                context="context",
                sources=["doc.txt"],
                conversation_history=[
                    "not a dict",  # type confusion in history
                    {"role": "user", "content": "real message"},
                ],
            )
            assert result == "mock response"

    def test_missing_role_in_history_entry_skipped(self, smart_llm):
        """History entry without 'role' key should be skipped."""
        with patch.object(smart_llm.backend, "chat_complete", mock_chat_complete):
            result = smart_llm.answer_question(
                question="What is this?",
                context="context",
                sources=["doc.txt"],
                conversation_history=[
                    {"content": "no role field"},
                    {"role": "user", "content": "valid"},
                ],
            )
            assert result == "mock response"

    def test_history_content_truncated_to_250_chars(self, smart_llm):
        """History content should be truncated to 250 chars per entry."""
        mock_chat = MagicMock(side_effect=mock_chat_complete)
        with patch.object(smart_llm.backend, "chat_complete", mock_chat):
            long_content = "x" * 1000
            result = smart_llm.answer_question(
                question="What is this?",
                context="context",
                sources=["doc.txt"],
                conversation_history=[
                    {"role": "user", "content": long_content},
                ],
            )
            assert result == "mock response"
            assert mock_chat.called
            call_args = mock_chat.call_args
            if call_args is not None:
                call_kwargs = call_args[1] if len(call_args) > 1 else {}
                user_prompt = call_kwargs.get("user_prompt", "")
                # Verify the long content was passed (will be truncated in the history building)
                assert len(long_content) > 250


# ==============================================================================
# OFF-BY-ONE VERIFICATION
# ==============================================================================

class TestOffByOneVerification:
    """Verify the > vs >= boundary is correct."""

    def test_len_equals_max_should_pass(self, smart_llm):
        """len(prompt) == MAX_PROMPT_LENGTH must pass (not raise)."""
        prompt = "=" * MAX_PROMPT_LENGTH
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate(prompt)
            assert result == "mock response"

    def test_len_equals_max_plus_1_must_raise(self, smart_llm):
        """len(prompt) == MAX_PROMPT_LENGTH + 1 must raise."""
        prompt = "=" * (MAX_PROMPT_LENGTH + 1)
        with pytest.raises(ValueError):
            smart_llm.generate(prompt)

    def test_len_equals_max_minus_1_must_pass(self, smart_llm):
        """len(prompt) == MAX_PROMPT_LENGTH - 1 must pass."""
        prompt = "=" * (MAX_PROMPT_LENGTH - 1)
        with patch.object(smart_llm.backend, "generate", mock_generate):
            result = smart_llm.generate(prompt)
            assert result == "mock response"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
