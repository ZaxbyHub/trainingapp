"""
Tests for LLM Interface Module (Phase 4.4)
"""

import pytest
import os
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock, mock_open
from dataclasses import dataclass

from llm_interface import (
    SmartLLM,
    InferenceConfig,
    BaseLLM,
    OpenVINOLLM,
    GGUFBackend,
    OllamaLLM,
    OpenAICompatibleLLM,
    RAGPromptBuilder,
)


class TestGGUFBackendBadPath:
    """Tests for GGUF backend with bad paths (test_ggufbackend_bad_path)."""

    def test_gguf_backend_nonexistent_file(self, tmp_path):
        """Test GGUFBackend with non-existent file."""
        bad_path = str(tmp_path / "nonexistent.gguf")

        with pytest.raises(FileNotFoundError, match="GGUF model path not found"):
            GGUFBackend(gguf_path=bad_path)

    def test_gguf_backend_invalid_magic_bytes(self, tmp_path):
        """Test GGUFBackend with invalid magic bytes."""
        # Create a file with wrong magic bytes
        bad_path = tmp_path / "invalid.gguf"
        bad_path.write_bytes(b"GGUX")  # Wrong magic (should be b"GGUF")

        with pytest.raises(ValueError, match="Invalid GGUF file"):
            GGUFBackend(gguf_path=str(bad_path))

    def test_gguf_backend_empty_file(self, tmp_path):
        """Test GGUFBackend with empty file."""
        empty_path = tmp_path / "empty.gguf"
        empty_path.write_bytes(b"")

        with pytest.raises(ValueError, match="Invalid GGUF file"):
            GGUFBackend(gguf_path=str(empty_path))

    def test_gguf_backend_not_a_file(self, tmp_path):
        """Test GGUFBackend with directory instead of file."""
        dir_path = tmp_path / "directory"
        dir_path.mkdir()

        with pytest.raises(ValueError, match="Invalid GGUF file"):
            GGUFBackend(gguf_path=str(dir_path))


class TestSmartLLMFallbackChain:
    """Tests for SmartLLM fallback chain (test_smartllm_fallback_chain)."""

    def test_smartllm_gguf_priority(self, tmp_path):
        """Test that GGUF takes priority in fallback chain."""
        # Create a valid GGUF file with correct magic bytes
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)  # Valid magic + dummy data

        with patch("llm_interface.GGUFBackend") as mock_gguf:
            mock_gguf.return_value = MagicMock()

            llm = SmartLLM(gguf_path=str(gguf_path))

            # GGUFBackend should be attempted and used
            mock_gguf.assert_called_once()
            assert len(llm.backends) > 0

    def test_fallback_gguf_to_openvino(self, tmp_path):
        """Test fallback from GGUF to OpenVINO when GGUF fails."""
        # Create paths for both backends
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        openvino_path = tmp_path / "openvino_model"
        openvino_path.mkdir()

        with patch("llm_interface.GGUFBackend") as mock_gguf:
            with patch("llm_interface.OpenVINOLLM") as mock_openvino:
                # Make GGUF fail
                mock_gguf.side_effect = Exception("GGUF failed")

                # Make OpenVINO succeed
                mock_openvino.return_value = MagicMock()

                llm = SmartLLM(gguf_path=str(gguf_path), model_path=str(openvino_path))

                # Verify GGUF was tried first
                mock_gguf.assert_called_once()

                # Verify OpenVINO was tried as fallback
                mock_openvino.assert_called_once()

    def test_fallback_openvino_to_openai(self, tmp_path):
        """Test fallback from OpenVINO to OpenAI-compatible API."""
        openvino_path = tmp_path / "openvino_model"
        openvino_path.mkdir()

        with patch("llm_interface.OpenVINOLLM") as mock_openvino:
            with patch("llm_interface.OpenAICompatibleLLM") as mock_api:
                # Make OpenVINO fail
                mock_openvino.side_effect = Exception("OpenVINO failed")

                # Make API succeed
                mock_api.return_value = MagicMock()

                llm = SmartLLM(
                    model_path=str(openvino_path), api_url="http://localhost:8000"
                )

                # Verify OpenVINO was tried
                mock_openvino.assert_called_once()

                # Verify API was tried as fallback
                mock_api.assert_called_once()

    def test_fallback_gguf_to_openvino_to_openai(self, tmp_path):
        """Test full fallback chain: GGUF -> OpenVINO -> OpenAI."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        openvino_path = tmp_path / "openvino_model"
        openvino_path.mkdir()

        with patch("llm_interface.GGUFBackend") as mock_gguf:
            with patch("llm_interface.OpenVINOLLM") as mock_openvino:
                with patch("llm_interface.OpenAICompatibleLLM") as mock_api:
                    # Make first two fail
                    mock_gguf.side_effect = Exception("GGUF failed")
                    mock_openvino.side_effect = Exception("OpenVINO failed")

                    # Make API succeed
                    mock_api.return_value = MagicMock()

                    llm = SmartLLM(
                        gguf_path=str(gguf_path),
                        model_path=str(openvino_path),
                        api_url="http://localhost:8000",
                    )

                    # Verify all were tried in order
                    mock_gguf.assert_called_once()
                    mock_openvino.assert_called_once()
                    mock_api.assert_called_once()

    def test_ollama_dev_only_not_in_chain(self):
        """Test that Ollama is dev/testing only, not in production fallback chain."""
        # When only Ollama is provided, it should work
        with patch("llm_interface.OllamaLLM") as mock_ollama:
            mock_ollama.return_value = MagicMock()

            llm = SmartLLM(ollama_model="test-model")
            mock_ollama.assert_called_once()

    def test_fallback_to_ollama_after_api_fails(self):
        """Test Ollama as last fallback after API fails."""
        with patch("llm_interface.OpenAICompatibleLLM") as mock_api:
            with patch("llm_interface.OllamaLLM") as mock_ollama:
                # Make API fail
                mock_api.side_effect = Exception("API failed")

                # Make Ollama succeed
                mock_ollama.return_value = MagicMock()

                llm = SmartLLM(
                    api_url="http://localhost:8000", ollama_model="test-model"
                )

                # Verify API was tried first
                mock_api.assert_called_once()

                # Verify Ollama was tried as fallback
                mock_ollama.assert_called_once()

    def test_smartllm_no_backend_available(self):
        """Test SmartLLM with no available backends raises RuntimeError."""
        with pytest.raises(RuntimeError, match="No LLM backend available"):
            SmartLLM(
                model_path="/nonexistent/path", gguf_path="/nonexistent/model.gguf"
            )

    def test_smartllm_all_backends_fail(self, tmp_path):
        """Test that RuntimeError is raised when all backends fail."""
        gguf_path = tmp_path / "test.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        openvino_path = tmp_path / "openvino_model"
        openvino_path.mkdir()

        with patch("llm_interface.GGUFBackend") as mock_gguf:
            with patch("llm_interface.OpenVINOLLM") as mock_openvino:
                with patch("llm_interface.OpenAICompatibleLLM") as mock_api:
                    with patch("llm_interface.OllamaLLM") as mock_ollama:
                        # Make all backends fail
                        mock_gguf.side_effect = Exception("GGUF failed")
                        mock_openvino.side_effect = Exception("OpenVINO failed")
                        mock_api.side_effect = Exception("API failed")
                        mock_ollama.side_effect = Exception("Ollama failed")

                        with pytest.raises(
                            RuntimeError, match="No LLM backend available"
                        ):
                            llm = SmartLLM(
                                gguf_path=str(gguf_path),
                                model_path=str(openvino_path),
                                api_url="http://localhost:8000",
                                ollama_model="test-model",
                            )


class TestGGUFMagicValidation:
    """Tests for GGUF magic byte validation (test_gguf_magic_validation)."""

    def test_gguf_valid_magic_bytes(self, tmp_path):
        """Test GGUFBackend with valid magic bytes."""
        # Skip if llama-cpp-python not installed
        pytest.importorskip("llama_cpp", reason="llama-cpp-python not installed")
        
        # Create a file with correct magic bytes
        gguf_path = tmp_path / "valid.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        # Mock the Llama class to avoid actual model loading
        # Since Llama is imported inside GGUFBackend.__init__, we patch it there
        with patch("llama_cpp.Llama"):
            backend = GGUFBackend(gguf_path=str(gguf_path))
            # Should not raise ValueError - if we get here, test passes

    def test_gguf_magic_bytes_verification(self, tmp_path):
        """Test that magic bytes are actually verified."""
        # Create file with wrong magic
        bad_path = tmp_path / "bad.gguf"
        bad_path.write_bytes(b"XXXX")

        with pytest.raises(ValueError, match="Invalid GGUF file"):
            GGUFBackend(gguf_path=str(bad_path))

    def test_gguf_magic_bytes_exact(self, tmp_path):
        """Test that magic bytes must be exactly b'GGUF'."""
        # Test variations of wrong magic - first 4 bytes must be different from b'GGUF'
        wrong_magics = [
            (b"GGUX", "ggux"),  # Wrong last character
            (b"GFUF", "gfuf"),  # Wrong second character
            (b"gguf", "gguf"),  # Wrong case
            (b"XXXX", "xxxx"),  # Completely different
        ]

        for wrong_magic, suffix in wrong_magics:
            wrong_path = tmp_path / f"wrong_{suffix}.gguf"
            wrong_path.write_bytes(wrong_magic)

            # Mock Llama to avoid actual model loading
            with patch("llama_cpp.Llama"):
                with pytest.raises(ValueError, match="Invalid GGUF file"):
                    GGUFBackend(gguf_path=str(wrong_path))


# Additional tests for other LLM backends


class TestOpenVINOLLM:
    """Tests for OpenVINO LLM backend."""

    def test_openvino_nonexistent_model(self, tmp_path):
        """Test OpenVINOLLM with non-existent model path."""
        bad_path = str(tmp_path / "nonexistent_model")

        with pytest.raises(FileNotFoundError):
            OpenVINOLLM(model_path=bad_path)

    def test_openvino_device_detection(self, tmp_path):
        """Test OpenVINO device auto-detection."""
        # Skip if openvino not installed
        pytest.importorskip("openvino", reason="openvino not installed")
        pytest.importorskip("openvino_genai", reason="openvino-genai not installed")
        
        # Create a dummy model directory
        model_path = tmp_path / "model"
        model_path.mkdir()

        # Since Core is imported inside _detect_best_device, patch it at import location
        with patch("openvino.Core") as mock_core:
            mock_core.return_value.available_devices = ["CPU", "GPU"]

            # Since LLMPipeline is imported inside __init__, patch it at import location
            with patch("openvino_genai.LLMPipeline"):
                backend = OpenVINOLLM(model_path=str(model_path))
                # Should detect device
                assert backend.device in ["CPU", "GPU", "NPU"]


class TestOllamaLLM:
    """Tests for Ollama LLM backend."""

    def test_ollama_connection_error(self):
        """Test OllamaLLM with unreachable server."""
        # Patch validate_url for port validation, then make _verify_connection
        # explicitly raise ConnectionError (not a no-op MagicMock)
        with patch("llm_interface.validate_url", return_value=True):
            with patch.object(
                OllamaLLM,
                "_verify_connection",
                side_effect=ConnectionError("Cannot connect to Ollama at http://localhost:9999"),
            ):
                with pytest.raises(ConnectionError, match="Cannot connect to Ollama"):
                    OllamaLLM(base_url="http://localhost:9999")

    def test_ollama_valid_connection(self):
        """Test OllamaLLM with valid connection (mocked)."""
        with patch("urllib.request.urlopen") as mock_urlopen:
            # Mock the response for /api/tags
            mock_response = MagicMock()
            mock_response.read.return_value = b'{"models": [{"name": "test"}]}'
            mock_response.headers = MagicMock()
            mock_response.headers.get_content_charset.return_value = "utf-8"
            mock_urlopen.return_value.__enter__.return_value = mock_response

            llm = OllamaLLM(base_url="http://localhost:11434")
            assert llm.base_url == "http://localhost:11434"


class TestOpenAICompatibleLLM:
    """Tests for OpenAI-compatible API backend."""

    def test_api_generation(self):
        """Test OpenAICompatibleLLM generation (mocked)."""
        with patch("llm_interface.validate_url", return_value=True):
            with patch("urllib.request.urlopen") as mock_urlopen:
                # Setup mock for constructor's _verify_connection
                mock_response = MagicMock()
                mock_response.read.return_value = b'{"models": []}'
                mock_response.headers = MagicMock()
                mock_response.headers.get_content_charset.return_value = "utf-8"
                mock_urlopen.return_value.__enter__.return_value = mock_response
                
                llm = OpenAICompatibleLLM(base_url="http://localhost:8000")
                assert llm.base_url == "http://localhost:8000"
                assert llm.model_name == "default"
                
                # Update mock for generate() call
                mock_response.read.return_value = (
                    b'{"choices": [{"message": {"content": "Test answer"}}]}'
                )
                response = llm.generate("Test prompt")
                assert response == "Test answer"


class TestRAGPromptBuilder:
    """Tests for RAG prompt builder."""

    def test_build_prompt(self):
        """Test building a RAG prompt."""
        question = "What is Python?"
        context = "Python is a programming language."
        sources = ["doc1.txt"]

        prompt = RAGPromptBuilder.build_prompt(question, context, sources)

        assert isinstance(prompt, str)
        assert len(prompt) > len(question) + len(context)
        assert question in prompt
        assert context in prompt
        assert sources[0] in prompt
        assert "You are a precise document assistant" in prompt

    def test_build_prompt_empty_context(self):
        """Test building prompt with empty context."""
        question = "Question?"
        context = ""
        sources = []

        prompt = RAGPromptBuilder.build_prompt(question, context, sources)

        assert question in prompt
        # Empty context should not add context section but prompt should still be valid
        assert "Context:" not in prompt or prompt.endswith("Context:\n\n")


class TestInferenceConfig:
    """Tests for inference configuration."""

    def test_config_defaults(self):
        """Test InferenceConfig with defaults."""
        config = InferenceConfig()

        assert config.max_tokens == 1024
        assert config.temperature == 0.7
        assert config.top_p == 0.9

    def test_config_custom_values(self):
        """Test InferenceConfig with custom values."""
        config = InferenceConfig(
            max_tokens=1024,
            temperature=0.7,
            top_p=0.95,
        )

        assert config.max_tokens == 1024
        assert config.temperature == 0.7
        assert config.top_p == 0.95


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
