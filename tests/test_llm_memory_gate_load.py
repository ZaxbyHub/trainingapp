"""
Acceptance checks for issue #53 (AC2): the RAM gate must let the bundled
~3.1 GB GGUF model load on machines with 8-11 GB of free RAM.

DISCRIMINATING check: at base the gate computes required = file_size * 4
(~12.4 GB for the 3.1 GB model) and refuses both the 8 GiB and 11 GiB
free-RAM scenarios, so both mocked tests below fail with "Insufficient RAM".
After the fix (file size + KV cache + overhead, ~5.1 GB) both load.

The third test is artifact-gated on the REAL bundled model file being staged
at models/gemma-4-E2B-it-Q5_K_M.gguf; it skips inline when the file is
absent (operator-acquired artifact, not in CI working trees).

All heavy deps are mocked: psutil.virtual_memory, llm_interface.Path, and
llm_interface.GGUFBackend — no real model is ever loaded.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

GIB = 1024**3
BUNDLED_RELATIVE_PATH = "models/gemma-4-E2B-it-Q5_K_M.gguf"
# Documented size of the bundled model (~3.1 GB, decimal GB)
BUNDLED_MODEL_SIZE = int(3.1 * 1e9)


class MockVirtualMemory:
    """Mock psutil.virtual_memory() return value."""

    def __init__(self, available: int, total: int):
        self.available = available
        self.total = total


class TestBundledModelLoadsOnTargetHardware:
    """The gate must accept the 3.1 GB bundled model with 8-11 GiB free."""

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_bundled_model_loads_with_8gib_free(self, mock_vm, mock_gguf_backend):
        """8 GiB free RAM must be enough for the ~3.1 GB model at n_ctx=4096."""
        mock_vm.return_value = MockVirtualMemory(available=8 * GIB, total=16 * GIB)
        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=BUNDLED_MODEL_SIZE)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            llm = SmartLLM(
                gguf_path=BUNDLED_RELATIVE_PATH,
                gguf_n_ctx=4096,
            )

        assert llm.backend is not None, (
            "SmartLLM must construct (RAM gate passes) for a 3.1 GB model "
            "with 8 GiB available"
        )

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_bundled_model_loads_with_11gib_free(self, mock_vm, mock_gguf_backend):
        """11 GiB free RAM (the issue's upper target band) must also load the model."""
        mock_vm.return_value = MockVirtualMemory(available=11 * GIB, total=16 * GIB)
        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=BUNDLED_MODEL_SIZE)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            llm = SmartLLM(
                gguf_path=BUNDLED_RELATIVE_PATH,
                gguf_n_ctx=4096,
            )

        assert llm.backend is not None, (
            "SmartLLM must construct (RAM gate passes) for a 3.1 GB model "
            "with 11 GiB available"
        )

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_real_bundled_model_loads_with_mocked_free_ram(
        self, mock_vm, mock_gguf_backend
    ):
        """Artifact-gated: use the REAL bundled file's actual size if it is staged.

        The free RAM is mocked to min(8 GiB, actual requirement) where the
        requirement follows the AC1 contract (file + 1 GiB KV + 1 GiB
        overhead), so the gate passes by construction. Only llm_interface.Path
        is NOT mocked here — the real file's st_size is what is under test.
        """
        bundled = Path(BUNDLED_RELATIVE_PATH)
        if not bundled.exists():
            pytest.skip("bundled GGUF not staged: " + BUNDLED_RELATIVE_PATH)
        actual_size = bundled.stat().st_size
        actual_requirement = actual_size + 2 * GIB  # + 1 GiB KV + 1 GiB overhead
        mock_vm.return_value = MockVirtualMemory(
            available=min(8 * GIB, actual_requirement),
            total=max(16 * GIB, actual_requirement),
        )

        from llm_interface import SmartLLM

        llm = SmartLLM(
            gguf_path=BUNDLED_RELATIVE_PATH,
            gguf_n_ctx=4096,
        )

        assert llm.backend is not None, (
            "SmartLLM must construct for the real bundled model with free RAM "
            "mocked at min(8 GiB, actual requirement)"
        )
