"""
Acceptance checks for issue #53 (AC4 diagnostic content): the RAM-gate
refusal error must let the user identify WHICH model failed and by how much.

DISCRIMINATING check: at base the gate message includes the required GB and
the available GB but NOT the model file name (llm_interface.py builds the
message from numbers only), so this file fails at base with
"model file name missing from RAM diagnostic". After the fix, all three
elements must be present in the refusal text.
"""

from unittest.mock import MagicMock, patch

import pytest

GIB = 1024**3
MODEL_PATH = "models/gemma-4-E2B-it-Q5_K_M.gguf"
MODEL_NAME = "gemma-4-E2B-it-Q5_K_M.gguf"
MODEL_SIZE = int(3.1 * 1e9)  # ~3.1 GB (decimal GB)


class MockVirtualMemory:
    """Mock psutil.virtual_memory() return value."""

    def __init__(self, available: int, total: int):
        self.available = available
        self.total = total


class TestGateDiagnosticNamesTheModel:
    """The refusal error must include required GB, available GB, model name."""

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_refusal_message_includes_numbers_and_model_name(
        self, mock_vm, mock_backend
    ):
        """Gate refusal (3.1 GB model, 4 GiB free) must carry all three elements."""
        mock_vm.return_value = MockVirtualMemory(available=4 * GIB, total=16 * GIB)
        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=MODEL_SIZE)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            with pytest.raises(RuntimeError) as exc_info:
                SmartLLM(gguf_path=MODEL_PATH, gguf_n_ctx=4096)

        msg = str(exc_info.value)

        # Element 1: "Insufficient RAM" marker
        assert "Insufficient RAM" in msg, f"missing RAM marker; got: {msg!r}"

        # Element 2: a required-memory GB figure (format-agnostic)
        assert "GB" in msg, f"required GB figure missing; got: {msg!r}"

        # Element 3: the available GB figure (accept GiB/decimal/no-decimal formats:
        # 4 GiB formats as 4.0GB in GiB units or 4.3GB in decimal GB units)
        assert any(
            variant in msg for variant in ("4.0GB", "4.3GB", "4GB", "4 GiB")
        ), f"available GB figure missing; got: {msg!r}"

        # Element 4: the model file name (MISSING at base — the pinned defect)
        if MODEL_NAME not in msg:
            pytest.fail("model file name missing from RAM diagnostic: " + msg)
