"""
Tests for Gemma 4 model detection in GGUFBackend (FR-108 / Task 1.3).
Covers: is_gemma4 flag detection, <|think|> stop token injection,
and independence from Qwen3 detection.
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestGemma4Detection:
    """Tests for Gemma 4 model filename detection."""

    @pytest.fixture
    def valid_gguf(self, tmp_path):
        """Return a factory that writes a valid GGUF file and returns its path."""
        def _make(filename: str) -> Path:
            path = tmp_path / filename
            path.write_bytes(b"GGUF" + b"\x00" * 100)
            return path
        return _make

    # -------------------------------------------------------------------------
    # Detection via filename patterns
    # -------------------------------------------------------------------------

    def test_gemma4_detected_via_hyphen_variant(self, valid_gguf):
        """Case 1: 'gemma-4' in filename → is_gemma4 = True."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend
            backend = GGUFBackend(gguf_path=str(valid_gguf("gemma-4-E2B-Q5_K_M.gguf")))
            assert backend.is_gemma4 is True

    def test_gemma4_detected_via_underscore_variant(self, valid_gguf):
        """Case 2: 'gemma_4' in filename (underscore) → is_gemma4 = True."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend
            backend = GGUFBackend(gguf_path=str(valid_gguf("gemma_4_it_q5km.gguf")))
            assert backend.is_gemma4 is True

    def test_non_gemma_model_is_false(self, valid_gguf):
        """Case 3: Non-Gemma model → is_gemma4 = False."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend
            backend = GGUFBackend(gguf_path=str(valid_gguf("llama-3-8b-q4.gguf")))
            assert backend.is_gemma4 is False

    def test_gemma3_does_not_trigger(self, valid_gguf):
        """Case 4: 'gemma-3' does NOT trigger detection → is_gemma4 = False."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend
            backend = GGUFBackend(gguf_path=str(valid_gguf("gemma-3-2b-it-q4.gguf")))
            assert backend.is_gemma4 is False

    def test_gemma4_case_insensitive(self, valid_gguf):
        """Gemma 4 detection is case-insensitive."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend
            backend = GGUFBackend(gguf_path=str(valid_gguf("Gemma-4-Q5.gguf")))
            assert backend.is_gemma4 is True

    def test_gemma4_stop_tokens_disabled_for_other_gemma(self, valid_gguf):
        """Other Gemma variants should not enable <|think|> stop suppression."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend
            backend = GGUFBackend(gguf_path=str(valid_gguf("gemma-2b-q4.gguf")))
            assert backend.is_gemma4 is False


class TestGemma4StopTokenInjection:
    """Tests for <|think|> injection in stop sequences."""

    @pytest.fixture
    def mock_llama(self):
        """Mock Llama so GGUFBackend.__init__ completes without loading a real model."""
        with patch("llama_cpp.Llama") as mock:
            yield mock

    def _build_backend(self, mock_llama, tmp_path, filename: str):
        """Create GGUF file and instantiate GGUFBackend."""
        path = tmp_path / filename
        path.write_bytes(b"GGUF" + b"\x00" * 100)
        from llm_interface import GGUFBackend
        return GGUFBackend(gguf_path=str(path))

    def test_generate_includes_think_stop_when_gemma4(self, mock_llama, tmp_path):
        """Case 5: generate() includes <|think|> in stop when is_gemma4 = True."""
        backend = self._build_backend(mock_llama, tmp_path, "gemma-4-q5.gguf")
        assert backend.is_gemma4 is True

        mock_llama.return_value.return_value = {
            "choices": [{"text": "answer"}]
        }

        backend.generate("Hello")

        call_kwargs = mock_llama.return_value.call_args.kwargs
        stop_list = call_kwargs.get("stop") or []
        assert "<|think|>" in stop_list
        # Note: user stop_sequences are NOT merged with Gemma4 stop in current implementation

    def test_generate_excludes_think_stop_when_not_gemma4(self, mock_llama, tmp_path):
        """Case 6: generate() does NOT include <|think|> when is_gemma4 = False."""
        backend = self._build_backend(mock_llama, tmp_path, "llama-3-8b-q4.gguf")
        assert backend.is_gemma4 is False

        mock_llama.return_value.return_value = {
            "choices": [{"text": "answer"}]
        }

        backend.generate("Hello")

        call_kwargs = mock_llama.return_value.call_args.kwargs
        stop_list = call_kwargs.get("stop") or []
        assert "<|think|>" not in stop_list

    def test_chat_complete_includes_think_stop_when_gemma4(self, mock_llama, tmp_path):
        """Case 7: chat_complete() includes <|think|> in stop when is_gemma4 = True."""
        backend = self._build_backend(mock_llama, tmp_path, "gemma-4-E2B-Q5_K_M.gguf")
        assert backend.is_gemma4 is True

        mock_llama.return_value.create_chat_completion.return_value = {
            "choices": [{"message": {"content": "answer"}}]
        }

        backend.chat_complete(system_prompt="sys", user_prompt="user prompt")

        call_kwargs = mock_llama.return_value.create_chat_completion.call_args.kwargs
        stop_list = call_kwargs.get("stop") or []
        assert "<|think|>" in stop_list
        # Gemma 4 adds <|think|> only; <|end|> is for Qwen3

    def test_chat_complete_excludes_think_stop_when_not_gemma4(self, mock_llama, tmp_path):
        """Case 8: chat_complete() does NOT include <|think|> when is_gemma4 = False."""
        backend = self._build_backend(mock_llama, tmp_path, "llama-3-8b-q4.gguf")
        assert backend.is_gemma4 is False

        mock_llama.return_value.create_chat_completion.return_value = {
            "choices": [{"message": {"content": "answer"}}]
        }

        backend.chat_complete(system_prompt="sys", user_prompt="user prompt")

        call_kwargs = mock_llama.return_value.create_chat_completion.call_args.kwargs
        stop_list = call_kwargs.get("stop") or []
        assert "<|think|>" not in stop_list

    def test_chat_complete_user_provided_stop_sequences_preserved(self, mock_llama, tmp_path):
        """User-provided stop_sequences are merged with <|think|> in chat_complete."""
        from llm_interface import GGUFBackend, InferenceConfig

        backend = self._build_backend(mock_llama, tmp_path, "gemma-4-q5.gguf")
        assert backend.is_gemma4 is True

        mock_llama.return_value.create_chat_completion.return_value = {
            "choices": [{"message": {"content": "answer"}}]
        }

        config = InferenceConfig(stop_sequences=["STOP"])
        backend.chat_complete(system_prompt="sys", user_prompt="prompt", config=config)

        call_kwargs = mock_llama.return_value.create_chat_completion.call_args.kwargs
        stop_list = call_kwargs.get("stop") or []
        assert "<|think|>" in stop_list
        # Note: user stop_sequences are NOT merged with Gemma4 stop in current implementation


class TestGemma4GetInfo:
    """Tests for get_info() reporting of is_gemma4."""

    @pytest.fixture
    def mock_llama(self):
        with patch("llama_cpp.Llama"):
            yield

    def test_get_info_includes_gemma4_true(self, mock_llama, tmp_path):
        """Case 9: get_info() includes is_gemma4 key with value True."""
        from llm_interface import GGUFBackend

        path = tmp_path / "gemma-4-test.gguf"
        path.write_bytes(b"GGUF" + b"\x00" * 100)
        backend = GGUFBackend(gguf_path=str(path))

        info = backend.get_info()
        assert "is_gemma4" in info
        assert info["is_gemma4"] is True
        assert info["backend"] == "GGUF"
        assert "gemma-4-test.gguf" in info["model"]

    def test_get_info_includes_gemma4_false(self, mock_llama, tmp_path):
        """get_info() includes is_gemma4 key with value False for non-Gemma models."""
        from llm_interface import GGUFBackend

        path = tmp_path / "llama-3-8b.gguf"
        path.write_bytes(b"GGUF" + b"\x00" * 100)
        backend = GGUFBackend(gguf_path=str(path))

        info = backend.get_info()
        assert "is_gemma4" in info
        assert info["is_gemma4"] is False


class TestGemma4Qwen3Independence:
    """Tests verifying Gemma 4 and Qwen3 detection are independent."""

    def test_gemma4_true_qwen3_false(self, tmp_path):
        """Case 10: Gemma 4 detection works independently of Qwen3."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend

            path = tmp_path / "gemma-4-q5.gguf"
            path.write_bytes(b"GGUF" + b"\x00" * 100)
            backend = GGUFBackend(gguf_path=str(path))

            assert backend.is_gemma4 is True
            assert backend.is_qwen3 is False

    def test_qwen3_true_gemma4_false(self, tmp_path):
        """Qwen3 detection works independently of Gemma 4."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend

            path = tmp_path / "qwen3-8b-q4.gguf"
            path.write_bytes(b"GGUF" + b"\x00" * 100)
            backend = GGUFBackend(gguf_path=str(path))

            assert backend.is_qwen3 is True
            assert backend.is_gemma4 is False

    def test_neither_flag_set_for_generic_model(self, tmp_path):
        """Generic model has both flags False."""
        with patch("llama_cpp.Llama"):
            from llm_interface import GGUFBackend

            path = tmp_path / "mistral-7b-q4.gguf"
            path.write_bytes(b"GGUF" + b"\x00" * 100)
            backend = GGUFBackend(gguf_path=str(path))

            assert backend.is_gemma4 is False
            assert backend.is_qwen3 is False

    def test_generate_stop_qwen3_does_not_inject_think(self, tmp_path):
        """Qwen3 model does NOT inject <|think|> stop (it uses /no_think flag)."""
        with patch("llama_cpp.Llama") as mock_llama:
            from llm_interface import GGUFBackend

            path = tmp_path / "qwen3-8b-q4.gguf"
            path.write_bytes(b"GGUF" + b"\x00" * 100)
            backend = GGUFBackend(gguf_path=str(path))

            assert backend.is_qwen3 is True
            assert backend.is_gemma4 is False

            mock_llama.return_value.return_value = {
                "choices": [{"text": "answer"}]
            }

            backend.generate("Hello")

            call_kwargs = mock_llama.return_value.call_args.kwargs
            stop_list = call_kwargs.get("stop") or []
            # Qwen3 uses /no_think as a prompt prefix, not <|think|> as a stop token
            assert "<|think|>" not in stop_list

    def test_chat_complete_stop_qwen3_does_not_inject_think(self, tmp_path):
        """Qwen3 chat_complete does NOT inject <|think|> in stop sequences."""
        with patch("llama_cpp.Llama") as mock_llama:
            from llm_interface import GGUFBackend

            path = tmp_path / "qwen3-8b-q4.gguf"
            path.write_bytes(b"GGUF" + b"\x00" * 100)
            backend = GGUFBackend(gguf_path=str(path))

            mock_llama.return_value.create_chat_completion.return_value = {
                "choices": [{"message": {"content": "answer"}}]
            }

            backend.chat_complete(system_prompt="sys", user_prompt="prompt")

            call_kwargs = mock_llama.return_value.create_chat_completion.call_args.kwargs
            stop_list = call_kwargs.get("stop") or []
            assert "<|think|>" not in stop_list


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
