"""
Tests for streaming token callback in llm_interface.py.

Tests cover:
1. generate() with stream_callback=None returns complete string (backward compatible)
2. generate() with stream_callback is called for each token yielded from stream=True generator
3. chat_complete() with stream_callback=None returns complete string (backward compatible)
4. chat_complete() with stream_callback yields delta content, skips empty deltas
5. Think-tag stripping applied per-token during streaming (Qwen3/no_think, Gemma4 <|think|>)
"""

import pytest
from unittest.mock import MagicMock, patch
import re


import sys
sys.path.insert(0, '.')

from llm_interface import (
    GGUFBackend,
    SmartLLM,
    InferenceConfig,
    MAX_PROMPT_LENGTH,
)


def make_gguf_file(tmp_path, name="test_model.gguf"):
    """Create a minimal valid GGUF file with magic bytes."""
    gguf_file = tmp_path / name
    gguf_file.write_bytes(b"GGUF" + b"\x00" * 100)
    return gguf_file


class TestGGUFBackendGenerate:
    """Tests for GGUFBackend.generate() streaming behavior."""

    @pytest.fixture
    def mock_llama(self):
        """Create a mock Llama instance."""
        mock = MagicMock()
        mock.return_value = {}  # placeholder for non-streaming call
        return mock

    @pytest.fixture
    def gguf_backend(self, mock_llama, tmp_path):
        """Create a GGUFBackend with a mocked llama instance."""
        gguf_file = make_gguf_file(tmp_path)

        with patch("llama_cpp.Llama", return_value=mock_llama):
            backend = GGUFBackend(
                gguf_path=str(gguf_file),
                n_ctx=2048,
                n_threads=2,
            )
        # Replace the real llama with our mock (already set by the constructor)
        backend.llama = mock_llama
        yield backend

    # --- Criterion 1: generate() with stream_callback=None returns complete string ---

    def test_generate_no_callback_returns_complete_string(self, gguf_backend, mock_llama):
        """Non-streaming generate() returns the full text from choices."""
        mock_llama.return_value = {
            "choices": [{"text": "Hello world"}],
        }

        result = gguf_backend.generate("Say hello", config=InferenceConfig())

        assert result == "Hello world"
        mock_llama.assert_called_once()
        call_kwargs = mock_llama.call_args[1]
        # stream=False or stream not set
        assert call_kwargs.get("stream") in (None, False)

    # --- Criterion 2: generate() with stream_callback is called per token ---

    def test_generate_with_callback_called_per_token(self, gguf_backend, mock_llama):
        """Streaming generate() calls callback once per yielded chunk."""
        chunks = [
            {"choices": [{"text": "Hello"}]},
            {"choices": [{"text": " world"}]},
            {"choices": [{"text": "!"}]},
        ]
        mock_llama.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.generate(
            "Say hello",
            config=InferenceConfig(),
            stream_callback=lambda t: tokens.append(t),
        )

        assert result == "Hello world!"
        assert tokens == ["Hello", " world", "!"]

    def test_generate_stream_callback_accumulates_full_text(self, gguf_backend, mock_llama):
        """Streaming generate() returns concatenated text matching individual tokens."""
        chunks = [
            {"choices": [{"text": "The"}]},
            {"choices": [{"text": " quick"}]},
            {"choices": [{"text": " brown"}]},
            {"choices": [{"text": " fox"}]},
        ]
        mock_llama.return_value = iter(chunks)

        result = gguf_backend.generate(
            "Test prompt",
            config=InferenceConfig(),
            stream_callback=lambda t: None,
        )

        assert result == "The quick brown fox"

    # --- Criterion 5: Think-tag stripping applied per-token during streaming ---

    def test_generate_strips_think_tags_from_tokens(self, gguf_backend, mock_llama):
        """Think tags are stripped from each token chunk as it's streamed.

        When a chunk contains a complete think block (opening + closing tags),
        the entire block is stripped and only the remaining text is passed to
        the callback.
        """
        chunks = [
            {"choices": [{"text": "<think>inner thought</think>"}]},
            {"choices": [{"text": " visible text"}]},
        ]
        mock_llama.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.generate(
            "What do you think?",
            config=InferenceConfig(),
            stream_callback=lambda t: tokens.append(t),
        )

        # Think block stripped from first chunk, leaving empty string (skipped)
        # Second chunk has visible text
        assert "<think>" not in result
        assert "</think>" not in result
        assert result == " visible text"
        # Empty stripped chunk should not be passed to callback
        assert tokens == [" visible text"]

    def test_generate_no_think_tags_no_op(self, gguf_backend, mock_llama):
        """Normal text without think tags passes through unchanged."""
        chunks = [
            {"choices": [{"text": "Plain"}]},
            {"choices": [{"text": " response"}]},
        ]
        mock_llama.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.generate(
            "Hello",
            config=InferenceConfig(),
            stream_callback=lambda t: tokens.append(t),
        )

        assert result == "Plain response"
        assert tokens == ["Plain", " response"]

    # --- Edge cases ---

    def test_generate_skips_empty_text_chunks(self, gguf_backend, mock_llama):
        """Chunks with empty text are skipped and not passed to callback."""
        chunks = [
            {"choices": [{"text": ""}]},
            {"choices": [{"text": "Hello"}]},
            {"choices": [{"text": ""}]},
        ]
        mock_llama.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.generate(
            "Test",
            config=InferenceConfig(),
            stream_callback=lambda t: tokens.append(t),
        )

        assert result == "Hello"
        assert tokens == ["Hello"]

    def test_generate_skips_chunks_without_choices(self, gguf_backend, mock_llama):
        """Chunks with no choices key are skipped."""
        chunks = [
            {},
            {"choices": []},
            {"choices": [{"text": "Hello"}]},
        ]
        mock_llama.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.generate(
            "Test",
            config=InferenceConfig(),
            stream_callback=lambda t: tokens.append(t),
        )

        assert result == "Hello"
        assert tokens == ["Hello"]


class TestGGUFBackendChatComplete:
    """Tests for GGUFBackend.chat_complete() streaming behavior."""

    @pytest.fixture
    def mock_llama(self):
        """Create a mock Llama instance."""
        mock = MagicMock()
        mock.create_chat_completion = MagicMock()
        return mock

    @pytest.fixture
    def gguf_backend(self, mock_llama, tmp_path):
        """Create a GGUFBackend with mocked llama instance."""
        gguf_file = make_gguf_file(tmp_path)

        with patch("llama_cpp.Llama", return_value=mock_llama):
            backend = GGUFBackend(
                gguf_path=str(gguf_file),
                n_ctx=2048,
                n_threads=2,
            )
        backend.llama = mock_llama
        yield backend

    # --- Criterion 3: chat_complete() with stream_callback=None returns complete string ---

    def test_chat_complete_no_callback_returns_complete_string(self, gguf_backend, mock_llama):
        """Non-streaming chat_complete() returns full message content."""
        mock_llama.create_chat_completion.return_value = {
            "choices": [{"message": {"content": "The answer is 42"}}],
        }

        result = gguf_backend.chat_complete(
            system_prompt="You are a helpful assistant.",
            user_prompt="What is the answer?",
        )

        assert result == "The answer is 42"

    def test_chat_complete_no_callback_strips_think_tags(self, gguf_backend, mock_llama):
        """Non-streaming chat_complete() strips think-tag blocks from full response."""
        mock_llama.create_chat_completion.return_value = {
            "choices": [
                {
                    "message": {
                        "content": "<think> I should think about this </think> The answer is 42"
                    }
                }
            ],
        }

        result = gguf_backend.chat_complete(
            system_prompt="You are a helpful assistant.",
            user_prompt="What is the answer?",
        )

        assert "<think>" not in result
        assert "</think>" not in result
        assert result.strip() == "The answer is 42"

    # --- Criterion 4: chat_complete() with stream_callback yields delta content, skips empty deltas ---

    def test_chat_complete_with_callback_yields_deltas(self, gguf_backend, mock_llama):
        """Streaming chat_complete() calls callback for each non-empty delta."""
        chunks = [
            {"choices": [{"delta": {"content": ""}}]},   # empty first delta
            {"choices": [{"delta": {"content": "The"}}]},
            {"choices": [{"delta": {"content": " answer"}}]},
            {"choices": [{"delta": {"content": " is"}}]},
            {"choices": [{"delta": {"content": " 42"}}]},
        ]
        mock_llama.create_chat_completion.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.chat_complete(
            system_prompt="You are a helpful assistant.",
            user_prompt="What is the answer?",
            stream_callback=lambda t: tokens.append(t),
        )

        # Skips empty first delta
        assert tokens == ["The", " answer", " is", " 42"]
        assert result == "The answer is 42"

    def test_chat_complete_skips_empty_deltas(self, gguf_backend, mock_llama):
        """Empty deltas are not passed to the stream callback."""
        chunks = [
            {"choices": [{"delta": {"content": ""}}]},
            {"choices": [{"delta": {"content": ""}}]},
            {"choices": [{"delta": {"content": "Hello"}}]},
            {"choices": [{"delta": {"content": ""}}]},
        ]
        mock_llama.create_chat_completion.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.chat_complete(
            system_prompt="System",
            user_prompt="Hi",
            stream_callback=lambda t: tokens.append(t),
        )

        assert tokens == ["Hello"]
        assert result == "Hello"

    def test_chat_complete_with_callback_accumulates_full_text(self, gguf_backend, mock_llama):
        """Streaming chat_complete() returns concatenated deltas."""
        chunks = [
            {"choices": [{"delta": {"content": "First"}}]},
            {"choices": [{"delta": {"content": "Second"}}]},
            {"choices": [{"delta": {"content": "Third"}}]},
        ]
        mock_llama.create_chat_completion.return_value = iter(chunks)

        result = gguf_backend.chat_complete(
            system_prompt="System",
            user_prompt="Prompt",
            stream_callback=lambda t: None,
        )

        assert result == "FirstSecondThird"

    # --- Criterion 5: Think-tag stripping applied per-token during streaming ---

    def test_chat_complete_strips_think_tags_from_deltas(self, gguf_backend, mock_llama):
        """Think tags are stripped from each delta chunk during streaming.

        When a delta chunk contains a complete think block, it is stripped
        and only the remaining text is passed to the callback.
        """
        chunks = [
            {"choices": [{"delta": {"content": "<think>thinking content</think> visible"}}]},
            {"choices": [{"delta": {"content": " text"}}]},
        ]
        mock_llama.create_chat_completion.return_value = iter(chunks)

        tokens = []
        result = gguf_backend.chat_complete(
            system_prompt="System",
            user_prompt="Question",
            stream_callback=lambda t: tokens.append(t),
        )

        # Think block stripped from first chunk (leaving " visible"), second chunk is " text"
        assert "<think>" not in result
        assert "</think>" not in result
        assert "visible text" in result
        # Only non-empty tokens passed to callback
        assert " visible" in tokens
        assert " text" in tokens

    def test_chat_complete_gemma4_stop_token(self, gguf_backend, mock_llama):
        """For Gemma4 models, <|think|> is passed as stop sequence."""
        gguf_backend.is_gemma4 = True

        chunks = [
            {"choices": [{"delta": {"content": "Answer"}}]},
        ]
        mock_llama.create_chat_completion.return_value = iter(chunks)

        gguf_backend.chat_complete(
            system_prompt="System",
            user_prompt="Question",
            stream_callback=lambda t: None,
        )

        call_kwargs = mock_llama.create_chat_completion.call_args[1]
        assert call_kwargs.get("stop") == ["<|think|>"]

    def test_chat_complete_qwen3_no_think_prepended(self, gguf_backend, mock_llama):
        """For Qwen3 models, /no_think is prepended to system prompt."""
        gguf_backend.is_qwen3 = True

        mock_llama.create_chat_completion.return_value = iter([
            {"choices": [{"delta": {"content": "Answer"}}]},
        ])

        gguf_backend.chat_complete(
            system_prompt="You are helpful.",
            user_prompt="Hello",
            stream_callback=lambda t: None,
        )

        call_kwargs = mock_llama.create_chat_completion.call_args[1]
        messages = call_kwargs.get("messages", [])
        system_content = messages[0]["content"]
        assert system_content.startswith("/no_think\n")


class TestSmartLLMAnswerQuestion:
    """Tests for SmartLLM.answer_question() stream_callback passthrough."""

    @pytest.fixture
    def mock_backend(self):
        """Create a mock GGUFBackend."""
        mock = MagicMock(spec=GGUFBackend)
        mock.is_qwen3 = False
        mock.is_gemma4 = False
        return mock

    @pytest.fixture
    def smart_llm(self, mock_backend, tmp_path):
        """Create a SmartLLM with mocked backend."""
        gguf_file = make_gguf_file(tmp_path)

        with patch("llama_cpp.Llama"):
            llm = SmartLLM.__new__(SmartLLM)
            llm.backend = mock_backend
            llm.prompt_builder = MagicMock()
            yield llm

    def test_answer_question_passes_stream_callback_to_backend(self, smart_llm, mock_backend):
        """answer_question() forwards stream_callback to backend.chat_complete()."""
        mock_backend.chat_complete.return_value = "Answer"

        tokens = []
        smart_llm.answer_question(
            question="What is 2+2?",
            context="Context",
            sources=["doc.pdf"],
            stream_callback=lambda t: tokens.append(t),
        )

        mock_backend.chat_complete.assert_called_once()
        call_kwargs = mock_backend.chat_complete.call_args[1]
        assert call_kwargs.get("stream_callback") is not None

    def test_answer_question_fallback_to_generate(self, smart_llm, mock_backend):
        """When chat_complete raises, answer_question falls back to backend.generate()."""
        mock_backend.chat_complete.side_effect = RuntimeError("fail")
        mock_backend.generate.return_value = "Fallback answer"

        smart_llm.answer_question(
            question="What is 2+2?",
            context="Context",
            sources=["doc.pdf"],
        )

        mock_backend.generate.assert_called_once()
        call_kwargs = mock_backend.generate.call_args[1]
        assert "stream_callback" in call_kwargs


class TestPromptLengthValidation:
    """Tests for MAX_PROMPT_LENGTH enforcement."""

    @pytest.fixture
    def mock_llama(self):
        mock = MagicMock()
        mock.create_chat_completion.return_value = iter([
            {"choices": [{"delta": {"content": "Answer"}}]},
        ])
        mock.return_value = iter([{"choices": [{"text": "OK"}]}])
        return mock

    @pytest.fixture
    def gguf_backend(self, mock_llama, tmp_path):
        gguf_file = make_gguf_file(tmp_path)
        with patch("llama_cpp.Llama", return_value=mock_llama):
            backend = GGUFBackend(str(gguf_file), n_ctx=2048)
        backend.llama = mock_llama
        yield backend

    def test_generate_rejects_prompt_exceeding_max_length(self, gguf_backend, mock_llama):
        """Prompt over MAX_PROMPT_LENGTH raises RuntimeError (ValueError is wrapped)."""
        long_prompt = "a" * (MAX_PROMPT_LENGTH + 1)

        with pytest.raises(RuntimeError, match="exceeds maximum length"):
            gguf_backend.generate(long_prompt)

    def test_chat_complete_rejects_combined_prompt_exceeding_max(self, gguf_backend, mock_llama):
        """Combined system+user prompt over MAX_PROMPT_LENGTH raises RuntimeError."""
        long_content = "a" * (MAX_PROMPT_LENGTH + 1)

        with pytest.raises(RuntimeError, match="exceeds maximum length"):
            gguf_backend.chat_complete(
                system_prompt=long_content,
                user_prompt="short",
            )

    def test_generate_accepts_prompt_at_exact_max_length(self, gguf_backend, mock_llama):
        """Prompt at exactly MAX_PROMPT_LENGTH is accepted (no ValueError raised)."""
        exact_prompt = "a" * MAX_PROMPT_LENGTH
        # Non-streaming generate expects a dict with choices
        mock_llama.return_value = {"choices": [{"text": "OK"}]}

        # Should not raise
        gguf_backend.generate(exact_prompt)


class TestErrorSanitization:
    """Tests for _sanitize_error() behavior."""

    def test_sanitize_removes_file_paths(self):
        from llm_interface import _sanitize_error
        msg = _sanitize_error("Error at C:\\Users\\test\\file.py line 42")
        assert "C:\\Users" not in msg
        assert "[PATH]" in msg

    def test_sanitize_removes_api_keys(self):
        from llm_interface import _sanitize_error
        msg = _sanitize_error("Failed: api_key=secret123")
        assert "secret123" not in msg
        assert "[REDACTED]" in msg

    def test_sanitize_truncates_long_messages(self):
        from llm_interface import _sanitize_error
        long_msg = "x" * 1000
        result = _sanitize_error(long_msg)
        assert len(result) <= 500

    def test_sanitize_returns_generic_for_empty(self):
        from llm_interface import _sanitize_error
        result = _sanitize_error("")
        assert result == "An error occurred while processing the request."


class TestInferenceConfig:
    """Tests for InferenceConfig defaults."""

    def test_inference_config_defaults(self):
        config = InferenceConfig()
        assert config.temperature == 0.7
        assert config.max_tokens == 1024
        assert config.top_p == 0.9
        assert config.stop_sequences is None

    def test_inference_config_custom_values(self):
        config = InferenceConfig(temperature=0.5, max_tokens=512)
        assert config.temperature == 0.5
        assert config.max_tokens == 512
        assert config.top_p == 0.9  # unchanged
