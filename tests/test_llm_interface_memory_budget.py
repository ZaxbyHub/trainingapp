"""
Tests for the SmartLLM memory budget check (issue #53 contract).

Rewritten from the old flat "model_size * 4" heuristic to the realistic
estimate: required = file_size + kv_estimate(n_ctx) + 1 GiB overhead
(llm_interface.estimate_required_memory). The bundled ~3.1 GB Gemma 4 E2B
GGUF must load with 8-11 GB free (the issue's target hardware), and the
refusal error must name the model, the required memory, and the available
memory.

Scenario table: the bundled-class 3.1 GB model against 8/16/32 GB free-RAM
machines. A separate artifact-gated test uses the REAL bundled GGUF's actual
size when it is staged locally (operator-acquired artifact, absent in CI).
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from llm_interface import estimate_required_memory

GIB = 1024**3
BUNDLED_MODEL_PATH = "models/gemma-4-E2B-it-Q5_K_M.gguf"
# Documented size of the bundled Gemma 4 E2B Q5_K_M GGUF (~3.1 GB, decimal GB)
BUNDLED_MODEL_SIZE = int(3.1 * 1e9)


class MockVirtualMemory:
    """Mock psutil.virtual_memory() return value."""

    def __init__(self, available: int, total: int):
        self.available = available
        self.total = total


def _make_smart_llm_with_mocked_deps(
    mock_vm,
    mock_gguf_backend,
    available_bytes: int,
    total_bytes: int,
    gguf_path: str = "fake_model.gguf",
    gguf_file_size: int = 4 * GIB,
):
    """Helper: create SmartLLM with psutil and GGUFBackend mocked, path exists=True."""
    mock_vm.return_value = MockVirtualMemory(
        available=available_bytes, total=total_bytes
    )

    with patch("llm_interface.Path") as mock_path_cls:
        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = True
        mock_path_instance.stat.return_value = MagicMock(st_size=gguf_file_size)
        mock_path_cls.return_value = mock_path_instance

        from llm_interface import SmartLLM

        return SmartLLM(gguf_path=gguf_path, gguf_n_ctx=4096)


class TestEstimateRequiredMemory:
    """The estimator replaces the flat 4x-file-size heuristic."""

    def test_bundled_model_estimate_is_realistic_not_4x(self):
        """3.1 GB file must estimate ~5-6 GB, far below the old 12.4 GB claim."""
        estimate = estimate_required_memory(BUNDLED_MODEL_SIZE, 4096)

        assert estimate < int(
            BUNDLED_MODEL_SIZE * 4
        ), "estimate must be well under the old 4x claim of ~12.4 GB"
        assert BUNDLED_MODEL_SIZE + GIB <= estimate <= BUNDLED_MODEL_SIZE + 4 * GIB

    def test_estimate_scales_with_file_size(self):
        """Larger models require strictly more memory."""
        assert estimate_required_memory(8 * GIB, 4096) > estimate_required_memory(
            2 * GIB, 4096
        )


class TestBundledModelScenarios:
    """The bundled 3.1 GB model against 8/16/32 GB free-RAM scenarios."""

    @pytest.mark.parametrize("free_gib", [8, 16, 32])
    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_bundled_model_loads_on_target_hardware(
        self, mock_vm, mock_gguf_backend, free_gib
    ):
        """8/16/32 GB free must all load the bundled ~3.1 GB model (n_ctx=4096)."""
        llm = _make_smart_llm_with_mocked_deps(
            mock_vm,
            mock_gguf_backend,
            available_bytes=free_gib * GIB,
            total_bytes=max(free_gib, 16) * GIB,
            gguf_path=BUNDLED_MODEL_PATH,
            gguf_file_size=BUNDLED_MODEL_SIZE,
        )
        assert llm.backend is not None

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_bundled_model_refused_when_free_ram_below_estimate(
        self, mock_vm, mock_gguf_backend
    ):
        """Below the realistic estimate the gate still refuses, with a diagnostic."""
        estimate = estimate_required_memory(BUNDLED_MODEL_SIZE, 4096)
        available = estimate - (512 * 1024**2)  # half a GB short

        with pytest.raises(RuntimeError) as exc_info:
            _make_smart_llm_with_mocked_deps(
                mock_vm,
                mock_gguf_backend,
                available_bytes=available,
                total_bytes=estimate,
                gguf_path=BUNDLED_MODEL_PATH,
                gguf_file_size=BUNDLED_MODEL_SIZE,
            )

        error_msg = str(exc_info.value)
        assert "Insufficient RAM" in error_msg
        assert "gemma-4-E2B-it-Q5_K_M.gguf" in error_msg
        assert f"{estimate / GIB:.1f}GB" in error_msg
        assert f"{available / GIB:.1f}GB" in error_msg

    def test_real_bundled_model_scenarios_when_staged(self):
        """Artifact-gated: the REAL bundled GGUF against 8/16/32 GB free.

        Skips inline when the operator has not staged the model (CI working
        trees never contain it); with it staged, the gate must accept the
        actual file size at 8 GB free and above.
        """
        bundled = Path(BUNDLED_MODEL_PATH)
        if not bundled.exists():
            pytest.skip("bundled GGUF not staged: " + BUNDLED_MODEL_PATH)
        actual_size = bundled.stat().st_size
        assert actual_size > GIB, "staged file is not a plausibly real GGUF"

        with patch("psutil.virtual_memory") as mock_vm, patch(
            "llm_interface.GGUFBackend"
        ):
            for free_gib in (8, 16, 32):
                mock_vm.return_value = MockVirtualMemory(
                    available=free_gib * GIB, total=free_gib * GIB
                )
                from llm_interface import SmartLLM

                llm = SmartLLM(gguf_path=BUNDLED_MODEL_PATH, gguf_n_ctx=4096)
                assert llm.backend is not None


class TestSmartLLMMemoryBudget:
    """Gate semantics preserved from the original suite, on the new contract."""

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_raises_runtime_error_when_available_ram_below_required(
        self, mock_vm, mock_gguf_backend
    ):
        """SmartLLM.__init__ raises RuntimeError when available RAM < required."""
        gguf_file_size = 4 * GIB
        required_memory = estimate_required_memory(gguf_file_size, 4096)
        available_bytes = required_memory - GIB  # 1 GB short
        total_bytes = required_memory * 2

        with pytest.raises(RuntimeError) as exc_info:
            _make_smart_llm_with_mocked_deps(
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
        """Error message includes available RAM, required RAM, and the model name."""
        gguf_file_size = 4 * GIB
        required_memory = estimate_required_memory(gguf_file_size, 4096)
        available_bytes = required_memory - GIB
        total_bytes = required_memory * 2

        with pytest.raises(RuntimeError) as exc_info:
            _make_smart_llm_with_mocked_deps(
                mock_vm,
                mock_gguf_backend,
                available_bytes,
                total_bytes,
                gguf_path="models/test-model.gguf",
                gguf_file_size=gguf_file_size,
            )

        error_msg = str(exc_info.value)
        assert "Insufficient RAM" in error_msg
        assert f"{required_memory / GIB:.1f}GB" in error_msg
        assert f"{available_bytes / GIB:.1f}GB" in error_msg
        assert "test-model.gguf" in error_msg

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_proceeds_normally_when_available_ram_exceeds_required(
        self, mock_vm, mock_gguf_backend
    ):
        """SmartLLM.__init__ proceeds when available RAM >= required."""
        gguf_file_size = 4 * GIB
        required_memory = estimate_required_memory(gguf_file_size, 4096)
        available_bytes = required_memory + 4 * GIB
        total_bytes = available_bytes * 2

        llm = _make_smart_llm_with_mocked_deps(
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
        """Memory check is evaluated BEFORE GGUFBackend constructor is called."""
        gguf_file_size = 100 * GIB  # refused under any sane formula
        available_bytes = 8 * GIB
        total_bytes = 16 * GIB
        mock_vm.return_value = MockVirtualMemory(
            available=available_bytes, total=total_bytes
        )

        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=gguf_file_size)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            with pytest.raises(RuntimeError):
                SmartLLM(gguf_path="fake_model.gguf", gguf_n_ctx=4096)

            # Verify GGUFBackend was NEVER called — memory check threw before constructor
            mock_gguf_backend.assert_not_called()

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_available_ram_exactly_at_required_boundary_accepted(
        self, mock_vm, mock_gguf_backend
    ):
        """Available RAM exactly at the required boundary is accepted (>= not >)."""
        gguf_file_size = 4 * GIB
        required_memory = estimate_required_memory(gguf_file_size, 4096)
        available_bytes = required_memory
        total_bytes = required_memory * 2

        llm = _make_smart_llm_with_mocked_deps(
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
        """GGUFBackend constructor is actually invoked when the memory check passes."""
        gguf_file_size = 4 * GIB
        required_memory = estimate_required_memory(gguf_file_size, 4096)
        available_bytes = required_memory + 2 * GIB
        total_bytes = available_bytes * 2
        mock_vm.return_value = MockVirtualMemory(
            available=available_bytes, total=total_bytes
        )

        with patch("llm_interface.Path") as mock_path_cls:
            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.stat.return_value = MagicMock(st_size=gguf_file_size)
            mock_path_cls.return_value = mock_path_instance

            from llm_interface import SmartLLM

            SmartLLM(gguf_path="fake_model.gguf", gguf_n_ctx=4096)
            # Verify GGUFBackend was called (meaning we passed the memory check)
            mock_gguf_backend.assert_called_once()

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_different_model_sizes_have_different_thresholds(
        self, mock_vm, mock_gguf_backend
    ):
        """Larger models require more memory; a mid-size model now fits where 4x refused."""
        # Small model: 2 GB file -> ~4 GB required; 10 GB available is plenty
        llm_small = _make_smart_llm_with_mocked_deps(
            mock_vm,
            mock_gguf_backend,
            available_bytes=10 * GIB,
            total_bytes=16 * GIB,
            gguf_file_size=2 * GIB,
        )
        assert llm_small.backend is not None

        # Large model: 8 GB file -> ~10 GB required; 20 GB available now loads
        # (the old 4x formula demanded 32 GB and refused)
        llm_large = _make_smart_llm_with_mocked_deps(
            mock_vm,
            mock_gguf_backend,
            available_bytes=20 * GIB,
            total_bytes=48 * GIB,
            gguf_file_size=8 * GIB,
        )
        assert llm_large.backend is not None

        # A truly oversized model (100 GB file) is still refused at 20 GB
        with pytest.raises(RuntimeError) as exc_info:
            _make_smart_llm_with_mocked_deps(
                mock_vm,
                mock_gguf_backend,
                available_bytes=20 * GIB,
                total_bytes=128 * GIB,
                gguf_file_size=100 * GIB,
            )
        assert "Insufficient RAM" in str(exc_info.value)
