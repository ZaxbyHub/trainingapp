"""
Verification tests for Phase 1.2: Simplified SmartLLM (GGUF-only, no multi-backend fallback)

These tests verify:
1. OpenVINOLLM, OllamaLLM, OpenAICompatibleLLM classes are REMOVED
2. SmartLLM only supports GGUFBackend (single backend, no list)
3. SmartLLM has no ollama/api/device parameters
4. SmartLLM delegates to backend correctly
"""

import pytest
import inspect
import sys
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock


class TestRemovedClasses:
    """Verify that removed classes are no longer importable from llm_interface."""

    def test_openvinollm_not_in_module(self):
        """OpenVINOLLM class must NOT exist in llm_interface module."""
        import llm_interface as mod
        assert not hasattr(mod, "OpenVINOLLM"), \
            "OpenVINOLLM still exists in llm_interface — it must be removed"

    def test_ollamallm_not_in_module(self):
        """OllamaLLM class must NOT exist in llm_interface module."""
        import llm_interface as mod
        assert not hasattr(mod, "OllamaLLM"), \
            "OllamaLLM still exists in llm_interface — it must be removed"

    def test_openaicompatibllm_not_in_module(self):
        """OpenAICompatibleLLM class must NOT exist in llm_interface module."""
        import llm_interface as mod
        assert not hasattr(mod, "OpenAICompatibleLLM"), \
            "OpenAICompatibleLLM still exists in llm_interface — it must be removed"

    def test_import_raises_no_nameerror_for_smartllm(self):
        """SmartLLM must still be importable after removals."""
        from llm_interface import SmartLLM
        assert callable(SmartLLM)

    def test_import_raises_no_nameerror_for_ggufbackend(self):
        """GGUFBackend must still be importable after removals."""
        from llm_interface import GGUFBackend
        assert callable(GGUFBackend)


class TestSmartLLMSignature:
    """Verify SmartLLM.__init__ has no ollama/api/device parameters."""

    def test_no_ollama_model_param(self):
        """SmartLLM.__init__ must NOT have ollama_model parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "ollama_model" not in sig.parameters, \
            "SmartLLM still has ollama_model parameter — remove it"

    def test_no_ollama_url_param(self):
        """SmartLLM.__init__ must NOT have ollama_url parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "ollama_url" not in sig.parameters, \
            "SmartLLM still has ollama_url parameter — remove it"

    def test_no_api_url_param(self):
        """SmartLLM.__init__ must NOT have api_url parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "api_url" not in sig.parameters, \
            "SmartLLM still has api_url parameter — remove it"

    def test_no_api_model_param(self):
        """SmartLLM.__init__ must NOT have api_model parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "api_model" not in sig.parameters, \
            "SmartLLM still has api_model parameter — remove it"

    def test_no_device_param(self):
        """SmartLLM.__init__ must NOT have device parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "device" not in sig.parameters, \
            "SmartLLM still has device parameter — remove it"

    def test_no_model_path_param(self):
        """SmartLLM.__init__ must NOT have model_path parameter (old OpenVINO path)."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "model_path" not in sig.parameters, \
            "SmartLLM still has model_path parameter — remove it"

    def test_has_gguf_path_param(self):
        """SmartLLM.__init__ must have gguf_path parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "gguf_path" in sig.parameters, \
            "SmartLLM missing gguf_path parameter"

    def test_has_gguf_n_ctx_param(self):
        """SmartLLM.__init__ must have gguf_n_ctx parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "gguf_n_ctx" in sig.parameters, \
            "SmartLLM missing gguf_n_ctx parameter"

    def test_has_gguf_n_threads_param(self):
        """SmartLLM.__init__ must have gguf_n_threads parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "gguf_n_threads" in sig.parameters, \
            "SmartLLM missing gguf_n_threads parameter"

    def test_has_gguf_verbose_param(self):
        """SmartLLM.__init__ must have gguf_verbose parameter."""
        from llm_interface import SmartLLM
        sig = inspect.signature(SmartLLM.__init__)
        assert "gguf_verbose" in sig.parameters, \
            "SmartLLM missing gguf_verbose parameter"


class TestSmartLLMInit:
    """Test SmartLLM initialization behavior."""

    def test_init_with_valid_gguf_path_creates_backend(self, tmp_path):
        """SmartLLM init with valid gguf_path creates a GGUFBackend instance."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        with patch("llm_interface.GGUFBackend") as mock_backend_cls:
            mock_backend_cls.return_value = MagicMock()
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            mock_backend_cls.assert_called_once_with(
                gguf_path=str(gguf_path),
                n_ctx=8192,
                n_threads=None,
                verbose=False,
            )
            # Should have single backend, not backends list
            assert hasattr(llm, "backend")
            assert llm.backend is not None

    def test_init_with_invalid_gguf_path_raises_runtimeerror(self, tmp_path):
        """SmartLLM init with non-existent gguf_path raises RuntimeError."""
        bad_path = tmp_path / "nonexistent.gguf"

        with patch("llm_interface.GGUFBackend"):
            from llm_interface import SmartLLM
            with pytest.raises(RuntimeError, match="No GGUF backend available"):
                SmartLLM(gguf_path=str(bad_path))

    def test_init_with_none_gguf_path_raises_runtimeerror(self):
        """SmartLLM init with None gguf_path raises RuntimeError."""
        with patch("llm_interface.GGUFBackend"):
            from llm_interface import SmartLLM
            with pytest.raises(RuntimeError, match="No GGUF backend available"):
                SmartLLM(gguf_path=None)

    def test_init_with_empty_string_gguf_path_raises_runtimeerror(self):
        """SmartLLM init with empty string gguf_path raises RuntimeError."""
        with patch("llm_interface.GGUFBackend"):
            from llm_interface import SmartLLM
            with pytest.raises(RuntimeError, match="No GGUF backend available"):
                SmartLLM(gguf_path="")

    def test_init_gguf_backend_exception_propagates(self, tmp_path):
        """If GGUFBackend raises during init, RuntimeError is raised."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        with patch("llm_interface.GGUFBackend") as mock_backend_cls:
            mock_backend_cls.side_effect = RuntimeError("GGUF init failed")
            from llm_interface import SmartLLM
            with pytest.raises(RuntimeError, match="No GGUF backend available"):
                SmartLLM(gguf_path=str(gguf_path))

    def test_init_with_custom_n_ctx_and_threads(self, tmp_path):
        """SmartLLM passes gguf_n_ctx and gguf_n_threads to backend."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        with patch("llm_interface.GGUFBackend") as mock_backend_cls:
            mock_backend_cls.return_value = MagicMock()
            from llm_interface import SmartLLM
            llm = SmartLLM(
                gguf_path=str(gguf_path),
                gguf_n_ctx=4096,
                gguf_n_threads=4,
                gguf_verbose=True,
            )

            mock_backend_cls.assert_called_once_with(
                gguf_path=str(gguf_path),
                n_ctx=4096,
                n_threads=4,
                verbose=True,
            )


class TestSmartLLMGenerate:
    """Test SmartLLM.generate() delegates to backend."""

    def test_generate_delegates_to_backend(self, tmp_path):
        """SmartLLM.generate() must call self.backend.generate() with the prompt."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        mock_backend = MagicMock()
        mock_backend.generate.return_value = "LLM response text"

        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            result = llm.generate("Hello, model!")

            mock_backend.generate.assert_called_once_with("Hello, model!", None)
            assert result == "LLM response text"

    def test_generate_with_config_delegates_to_backend(self, tmp_path):
        """SmartLLM.generate() passes InferenceConfig to backend."""
        from llm_interface import InferenceConfig

        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        mock_backend = MagicMock()
        mock_backend.generate.return_value = "Response"

        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))
            config = InferenceConfig(max_tokens=512, temperature=0.3)

            llm.generate("prompt", config=config)

            mock_backend.generate.assert_called_once_with("prompt", config)
            assert config.max_tokens == 512
            assert config.temperature == 0.3

    def test_generate_rejects_oversized_prompt(self, tmp_path):
        """SmartLLM.generate() raises ValueError for prompts exceeding MAX_PROMPT_LENGTH."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        mock_backend = MagicMock()
        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            oversized = "x" * 200000  # Exceeds MAX_PROMPT_LENGTH (100000)
            with pytest.raises(ValueError, match="exceeds maximum length"):
                llm.generate(oversized)


class TestSmartLLMAnswerQuestion:
    """Test SmartLLM.answer_question() uses chat_complete with generate fallback."""

    def test_answer_question_uses_chat_complete(self, tmp_path):
        """answer_question() must call self.backend.chat_complete() for GGUF."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        mock_backend = MagicMock()
        mock_backend.chat_complete.return_value = "Answer from chat_complete"

        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            result = llm.answer_question(
                question="What is Python?",
                context="Python is a language.",
                sources=["doc.txt"],
            )

            mock_backend.chat_complete.assert_called_once()
            # Verify system_prompt was passed (it's RAGPromptBuilder.SYSTEM_PROMPT)
            call_kwargs = mock_backend.chat_complete.call_args
            assert "system_prompt" in call_kwargs.kwargs or call_kwargs.args is not None
            assert result == "Answer from chat_complete"

    def test_answer_question_falls_back_to_generate_on_exception(self, tmp_path):
        """answer_question() falls back to generate() if chat_complete raises."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        mock_backend = MagicMock()
        mock_backend.chat_complete.side_effect = RuntimeError("chat_complete failed")
        mock_backend.generate.return_value = "Answer from generate fallback"

        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            result = llm.answer_question(
                question="What is Python?",
                context="Python is a language.",
                sources=["doc.txt"],
            )

            mock_backend.chat_complete.assert_called_once()
            mock_backend.generate.assert_called_once()
            assert result == "Answer from generate fallback"

    def test_answer_question_passes_conversation_history(self, tmp_path):
        """answer_question() includes conversation_history in the prompt."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        mock_backend = MagicMock()
        mock_backend.chat_complete.return_value = "Answer"

        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            history = [
                {"role": "user", "content": "First question"},
                {"role": "assistant", "content": "First answer"},
                {"role": "user", "content": "Follow up"},
            ]

            llm.answer_question(
                question="Follow up question",
                context="Context here",
                sources=["doc.txt"],
                conversation_history=history,
            )

            # Verify chat_complete was called with history in the prompt
            call_kwargs = mock_backend.chat_complete.call_args.kwargs
            user_prompt = call_kwargs.get("user_prompt", "")
            assert "Previous conversation:" in user_prompt
            assert "First question" in user_prompt


class TestSmartLLMGetInfo:
    """Test SmartLLM.get_info() delegates to backend."""

    def test_get_info_returns_backend_info(self, tmp_path):
        """SmartLLM.get_info() must return self.backend.get_info()."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        expected_info = {
            "backend": "GGUF",
            "model": "test.gguf",
            "n_ctx": 8192,
            "n_threads": None,
        }

        mock_backend = MagicMock()
        mock_backend.get_info.return_value = expected_info

        with patch("llm_interface.GGUFBackend", return_value=mock_backend):
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            info = llm.get_info()

            mock_backend.get_info.assert_called_once()
            assert info == expected_info


class TestNoMultiBackendFallbackChain:
    """Verify no multi-backend fallback chain exists in SmartLLM."""

    def test_smartllm_has_single_backend_attribute(self, tmp_path):
        """SmartLLM must have self.backend (singular), not self.backends (list)."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        with patch("llm_interface.GGUFBackend") as mock_backend_cls:
            mock_backend_cls.return_value = MagicMock()
            from llm_interface import SmartLLM
            llm = SmartLLM(gguf_path=str(gguf_path))

            assert hasattr(llm, "backend")
            assert not hasattr(llm, "backends") or llm.backends is None, \
                "SmartLLM should not have self.backends — fallback chain is removed"

    def test_no_fallback_loop_in_init_source(self):
        """Source code of SmartLLM.__init__ must not contain a loop over backends."""
        from llm_interface import SmartLLM
        source = inspect.getsource(SmartLLM.__init__)

        # These patterns would indicate a fallback chain
        forbidden = [
            "for backend in",
            "while ",
            "self.backends",
            "fallback",
        ]
        for pattern in forbidden:
            assert pattern not in source, \
                f"SmartLLM.__init__ contains forbidden pattern '{pattern}' — fallback chain detected"

    def test_no_openvino_openvinollm_in_smartllm_source(self):
        """SmartLLM source must not reference removed classes."""
        from llm_interface import SmartLLM
        source = inspect.getsource(SmartLLM)

        forbidden = ["OpenVINOLLM", "OllamaLLM", "OpenAICompatibleLLM"]
        for cls_name in forbidden:
            assert cls_name not in source, \
                f"SmartLLM source contains '{cls_name}' — class must be removed"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
