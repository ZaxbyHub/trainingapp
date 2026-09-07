"""
Preserving check for issue #53: the RAM gate must be evaluated BEFORE the
GGUFBackend constructor is attempted, both at base and after the fix.

PRESERVING (expected GREEN at base and after the fix): a 100 GiB file with
8 GiB free is refused under the old 4x rule (400 GiB required) and under the
new estimate (file + KV + overhead, ~102 GiB), and the backend constructor
must never run for a refused model. All heavy deps are mocked.
"""

from unittest.mock import MagicMock, patch

import pytest

GIB = 1024**3


class MockVirtualMemory:
    """Mock psutil.virtual_memory() return value."""

    def __init__(self, available: int, total: int):
        self.available = available
        self.total = total


class TestGateOrderBeforeBackendConstruction:
    """Gate refusal must happen before GGUFBackend construction."""

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_refusal_skips_backend_constructor(self, mock_vm, mock_backend):
        """100 GiB model with 8 GiB free: refuse AND never construct backend."""
        mock_vm.return_value = MockVirtualMemory(available=8 * GIB, total=32 * GIB)

        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=100 * GIB)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            with pytest.raises(RuntimeError) as exc_info:
                SmartLLM(gguf_path="huge.gguf", gguf_n_ctx=4096)

        assert "Insufficient RAM" in str(exc_info.value)
        mock_backend.assert_not_called()
