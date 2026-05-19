"""
Tests for memory budget check before GGUF model load in SmartLLM.
Covers: llm_interface.py lines 400-409
"""

import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path


class MockVirtualMemory:
    """Mock psutil.virtual_memory() return value."""

    def __init__(self, available: int, total: int):
        self.available = available
        self.total = total


class TestSmartLLMMemoryBudget:
    """Memory budget check tests for SmartLLM.__init__."""

    def _make_smart_llm_with_mocked_deps(
        self,
        mock_vm,
        mock_gguf_backend,
        available_bytes: int,
        total_bytes: int,
        gguf_path: str = "fake_model.gguf",
        gguf_file_size: int = 4 * 1024**3,
    ):
        """Helper: create SmartLLM with psutil and GGUFBackend mocked, path exists=True."""
        mock_vm.return_value = MockVirtualMemory(available=available_bytes, total=total_bytes)

        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=gguf_file_size)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            return SmartLLM(gguf_path=gguf_path)

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_raises_runtime_error_when_available_ram_below_required(
        self, mock_vm, mock_gguf_backend
    ):
        """Test: SmartLLM.__init__ raises RuntimeError when available RAM < model_size * 4."""
        # Model file is 4GB, requires 16GB (4 * 4), but only 12GB available
        gguf_file_size = 4 * 1024**3
        required_memory = int(gguf_file_size * 4)  # 16GB
        available_bytes = 12 * 1024**3
        total_bytes = 16 * 1024**3

        with pytest.raises(RuntimeError) as exc_info:
            self._make_smart_llm_with_mocked_deps(
                mock_vm,
                mock_gguf_backend,
                available_bytes,
                total_bytes,
                gguf_file_size=gguf_file_size,
            )

        assert "Insufficient RAM" in str(exc_info.value)

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_error_message_includes_available_and_required_ram(
        self, mock_vm, mock_gguf_backend
    ):
        """Test: Error message includes available RAM and required RAM based on model size."""
        gguf_file_size = 4 * 1024**3
        required_memory = int(gguf_file_size * 4)  # 16GB
        available_bytes = 10 * 1024**3
        total_bytes = 16 * 1024**3

        with pytest.raises(RuntimeError) as exc_info:
            self._make_smart_llm_with_mocked_deps(
                mock_vm,
                mock_gguf_backend,
                available_bytes,
                total_bytes,
                gguf_file_size=gguf_file_size,
            )

        error_msg = str(exc_info.value)
        # Check "Insufficient RAM" is present
        assert "Insufficient RAM" in error_msg
        # Check required memory is mentioned (based on model file size)
        assert f"{required_memory / (1024**3):.1f}GB" in error_msg
        # Check available RAM is mentioned
        assert f"{available_bytes / (1024**3):.1f}GB" in error_msg

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_proceeds_normally_when_available_ram_exceeds_required(
        self, mock_vm, mock_gguf_backend
    ):
        """Test: SmartLLM.__init__ proceeds normally when available RAM >= model_size * 4."""
        # Model file is 4GB, requires 16GB, and 20GB is available
        gguf_file_size = 4 * 1024**3
        available_bytes = 20 * 1024**3
        total_bytes = 16 * 1024**3

        llm = self._make_smart_llm_with_mocked_deps(
            mock_vm,
            mock_gguf_backend,
            available_bytes,
            total_bytes,
            gguf_file_size=gguf_file_size,
        )
        assert llm.backend is not None

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_memory_check_before_gguf_backend_constructor(
        self, mock_vm, mock_gguf_backend
    ):
        """Test: Memory check is evaluated BEFORE GGUFBackend constructor is called."""
        # Model file is 4GB, requires 16GB, but only 10GB available
        gguf_file_size = 4 * 1024**3
        available_bytes = 10 * 1024**3
        total_bytes = 16 * 1024**3
        mock_vm.return_value = MockVirtualMemory(available=available_bytes, total=total_bytes)

        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=gguf_file_size)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            with pytest.raises(RuntimeError):
                SmartLLM(gguf_path="fake_model.gguf")

            # Verify GGUFBackend was NEVER called — memory check threw before constructor
            mock_gguf_backend.assert_not_called()

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_available_ram_exactly_at_required_boundary_accepted(
        self, mock_vm, mock_gguf_backend
    ):
        """Test: Available RAM exactly at required boundary is accepted (>= not >)."""
        # Model file is 4GB, requires exactly 16GB (4 * 4)
        gguf_file_size = 4 * 1024**3
        required_memory = int(gguf_file_size * 4)
        available_bytes = required_memory
        total_bytes = 16 * 1024**3

        llm = self._make_smart_llm_with_mocked_deps(
            mock_vm,
            mock_gguf_backend,
            available_bytes,
            total_bytes,
            gguf_file_size=gguf_file_size,
        )
        assert llm.backend is not None

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_gguf_backend_called_when_memory_sufficient(
        self, mock_vm, mock_gguf_backend
    ):
        """Verify GGUFBackend constructor is actually invoked when memory check passes."""
        gguf_file_size = 4 * 1024**3
        available_bytes = 18 * 1024**3
        total_bytes = 32 * 1024**3
        mock_vm.return_value = MockVirtualMemory(available=available_bytes, total=total_bytes)

        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=gguf_file_size)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            llm = SmartLLM(gguf_path="fake_model.gguf")
            # Verify GGUFBackend was called (meaning we passed the memory check)
            mock_gguf_backend.assert_called_once()

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_different_model_sizes_have_different_thresholds(
        self, mock_vm, mock_gguf_backend
    ):
        """Test: Larger models require more memory, smaller models require less."""
        # Small model: 2GB file → requires 8GB, 10GB available is enough
        small_model_size = 2 * 1024**3
        # Large model: 8GB file → requires 32GB, 20GB available is not enough
        large_model_size = 8 * 1024**3

        # Small model should pass with 10GB available (2GB * 4 = 8GB required)
        llm_small = self._make_smart_llm_with_mocked_deps(
            mock_vm,
            mock_gguf_backend,
            available_bytes=10 * 1024**3,
            total_bytes=16 * 1024**3,
            gguf_file_size=small_model_size,
        )
        assert llm_small.backend is not None

        # Large model should fail with 20GB available (needs 32GB)
        with pytest.raises(RuntimeError) as exc_info:
            self._make_smart_llm_with_mocked_deps(
                mock_vm,
                mock_gguf_backend,
                available_bytes=20 * 1024**3,
                total_bytes=48 * 1024**3,
                gguf_file_size=large_model_size,
            )
        assert "Insufficient RAM" in str(exc_info.value)
