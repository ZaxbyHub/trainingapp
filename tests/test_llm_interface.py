"""
Tests for LLM Interface Module (Phase 4.4)
"""

import sys
import pytest
import os
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock, mock_open
from dataclasses import dataclass

# Pre-register llama_cpp as a mock so tests pass when the optional
# dependency is not installed. Has no effect when it is installed.
sys.modules.setdefault("llama_cpp", MagicMock())

from llm_interface import (
    SmartLLM,
    InferenceConfig,
    BaseLLM,
    GGUFBackend,
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


class TestGemma4Detection:
    """Tests for Gemma 4 model detection and thinking mode suppression (FR-108)."""

    @patch("llama_cpp.Llama")
    def test_gemma4_detected_by_filename(self, mock_llama, tmp_path):
        """GGUFBackend detects Gemma 4 from filename."""
        mock_llama.return_value = MagicMock()
        model_path = tmp_path / "gemma-4-E2B-it-Q5_K_M.gguf"
        model_path.write_bytes(b"GGUF" + b"\x00" * 20)
        backend = GGUFBackend(str(model_path))
        assert backend.is_gemma4 is True

    @patch("llama_cpp.Llama")
    def test_non_gemma4_not_detected(self, mock_llama, tmp_path):
        """GGUFBackend does not flag non-Gamma models."""
        mock_llama.return_value = MagicMock()
        model_path = tmp_path / "phi3-mini-int4.gguf"
        model_path.write_bytes(b"GGUF" + b"\x00" * 20)
        backend = GGUFBackend(str(model_path))
        assert backend.is_gemma4 is False

    @patch("llama_cpp.Llama")
    def test_gemma4_in_get_info(self, mock_llama, tmp_path):
        """Gemma 4 model detection is included in get_info()."""
        mock_llama.return_value = MagicMock()
        model_path = tmp_path / "gemma-4-E2B-it-Q5_K_M.gguf"
        model_path.write_bytes(b"GGUF" + b"\x00" * 20)
        backend = GGUFBackend(str(model_path))
        info = backend.get_info()
        assert info["is_gemma4"] is True

    @patch("llama_cpp.Llama")
    def test_non_gemma4_in_get_info(self, mock_llama, tmp_path):
        """Non-Gemma 4 model has is_gemma4=False in get_info()."""
        mock_llama.return_value = MagicMock()
        model_path = tmp_path / "phi3-mini-int4.gguf"
        model_path.write_bytes(b"GGUF" + b"\x00" * 20)
        backend = GGUFBackend(str(model_path))
        info = backend.get_info()
        assert info["is_gemma4"] is False


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
