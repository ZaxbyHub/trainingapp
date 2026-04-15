"""
Tests for RAGEngine.__init__() and _init_llm() simplification (Task 1.4).
Verifies that removed online/legacy parameters are rejected (TypeError) and
that only gguf_path is used for LLM initialization.
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, call


class TestRAGEngineInitRemovedParams:
    """Verify that __init__ rejects removed parameters with TypeError."""

    # Removed parameters that should no longer be accepted
    REMOVED_PARAMS = [
        ("model_path", "/fake/model.gguf"),
        ("ollama_model", "llama3"),
        ("ollama_url", "http://localhost:11434"),
        ("api_url", "http://localhost:8000"),
        ("api_model", "gpt-4"),
        ("device", "cuda"),
    ]

    @pytest.mark.parametrize("param_name,param_value", REMOVED_PARAMS)
    def test_init_rejects_removed_params(self, param_name, param_value):
        """All removed params must raise TypeError when passed to __init__."""
        from rag_engine import RAGEngine

        with pytest.raises(TypeError):
            RAGEngine(**{param_name: param_value})

    def test_init_accepts_valid_params(self):
        """Sanity check: valid params (config, gguf_path) are accepted."""
        from rag_engine import RAGEngine, RAGConfig

        with patch("rag_engine.SmartLLM"):
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        # Should not raise
                        engine = RAGEngine(config=RAGConfig(), gguf_path=None)
                        assert engine is not None

    def test_init_accepts_only_config(self):
        """Sanity check: config-only init is accepted."""
        from rag_engine import RAGEngine, RAGConfig

        with patch("rag_engine.SmartLLM"):
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine(config=RAGConfig())
                        assert engine is not None

    def test_init_accepts_only_gguf_path(self):
        """Sanity check: gguf_path-only init is accepted."""
        from rag_engine import RAGEngine

        with patch("rag_engine.SmartLLM"):
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine(gguf_path="/some/path.gguf")
                        assert engine is not None


class TestRAGEngineInitGGUFNone:
    """Test that __init__ succeeds when gguf_path is None / no valid model."""

    def test_init_gguf_path_none_llm_is_none(self):
        """RAGEngine(config=None, gguf_path=None) succeeds; llm is None."""
        from rag_engine import RAGEngine

        with patch("rag_engine.SmartLLM") as mock_smartllm:
            # SmartLLM raises RuntimeError when no valid gguf is available
            mock_smartllm.side_effect = RuntimeError(
                "No GGUF backend available. Provide a valid gguf_path."
            )
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine(config=None, gguf_path=None)
                        assert engine.llm is None

    def test_init_fake_path_llm_is_none(self):
        """RAGEngine(config=None, gguf_path='/fake/path.gguf') succeeds; llm is None."""
        from rag_engine import RAGEngine

        with patch("rag_engine.SmartLLM") as mock_smartllm:
            # SmartLLM raises RuntimeError when gguf path doesn't exist
            mock_smartllm.side_effect = RuntimeError(
                "No GGUF backend available. Provide a valid gguf_path."
            )
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine(config=None, gguf_path="/fake/path.gguf")
                        assert engine.llm is None


class TestInitLLMSingleParam:
    """Verify _init_llm() is called with only gguf_path and SmartLLM is
    constructed with only gguf_path."""

    def test_init_llm_called_with_only_gguf_path(self):
        """_init_llm() is invoked with the gguf_path kwarg, not model_path or
        other removed kwargs."""
        from rag_engine import RAGEngine

        with patch("rag_engine.SmartLLM") as mock_smartllm:
            mock_smartllm.return_value = MagicMock()
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine(gguf_path="/models/test.gguf")

                        # SmartLLM should have been called with only gguf_path
                        mock_smartllm.assert_called_once_with(gguf_path="/models/test.gguf")
                        call_kwargs = mock_smartllm.call_args.kwargs
                        assert "gguf_path" in call_kwargs
                        assert len(call_kwargs) == 1

    def test_init_llm_called_with_none_path(self):
        """_init_llm() is called with gguf_path=None when no path provided."""
        from rag_engine import RAGEngine

        with patch("rag_engine.SmartLLM") as mock_smartllm:
            mock_smartllm.side_effect = RuntimeError("No GGUF")
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine()

                        # SmartLLM should have been called with gguf_path=None
                        mock_smartllm.assert_called_once_with(gguf_path=None)
                        call_kwargs = mock_smartllm.call_args.kwargs
                        assert "gguf_path" in call_kwargs
                        assert call_kwargs["gguf_path"] is None
                        assert len(call_kwargs) == 1

    def test_smartllm_not_called_with_removed_kwargs(self):
        """SmartLLM is never called with model_path, ollama_model, ollama_url,
        api_url, api_model, or device kwargs."""
        from rag_engine import RAGEngine

        REMOVED_KWARGS = {
            "model_path",
            "ollama_model",
            "ollama_url",
            "api_url",
            "api_model",
            "device",
        }

        with patch("rag_engine.SmartLLM") as mock_smartllm:
            mock_smartllm.return_value = MagicMock()
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        RAGEngine(gguf_path="/models/test.gguf")

                        call_kwargs = mock_smartllm.call_args.kwargs
                        for removed_kwarg in REMOVED_KWARGS:
                            assert (
                                removed_kwarg not in call_kwargs
                            ), f"SmartLLM was called with removed kwarg: {removed_kwarg}"


class TestInitLLMSuccess:
    """Test that _init_llm() sets self.llm when SmartLLM succeeds."""

    def test_init_llm_sets_llm_on_success(self):
        """When SmartLLM initializes successfully, self.llm is set."""
        from rag_engine import RAGEngine

        mock_llm_instance = MagicMock()
        mock_llm_instance.get_info.return_value = {"backend": "GGUF"}

        with patch("rag_engine.SmartLLM") as mock_smartllm:
            mock_smartllm.return_value = mock_llm_instance
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore"):
                    with patch("rag_engine.DocumentProcessor"):
                        engine = RAGEngine(gguf_path="/models/test.gguf")
                        assert engine.llm is mock_llm_instance


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
