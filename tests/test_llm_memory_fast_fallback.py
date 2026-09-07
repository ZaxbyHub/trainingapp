"""
Acceptance checks for issue #53 (AC3/AC4): SmartLLM must support an optional
fast_profile_path so that, when the primary GGUF model fails the RAM gate,
a smaller fast-profile model loads instead of dropping the LLM entirely.

NEW-SURFACE check: the `fast_profile_path` kwarg does not exist at base, so
scenarios A and B fail at base with TypeError ("unexpected keyword argument
'fast_profile_path'") — the expected RED. Scenario C (no fast profile →
direct refusal, today's behavior) is expected to pass at base and after the
fix.

Contract pinned here:

    SmartLLM(gguf_path=..., fast_profile_path=...)  # new optional kwarg

- primary fails gate + fast profile passes its own gate -> fast model loads;
- primary fails + fast also fails -> RuntimeError mentioning the PRIMARY
  model's shortfall (required/available GB and the primary model file name);
- primary fails + no fast_profile_path -> RuntimeError "Insufficient RAM"
  exactly as today.

All heavy deps are mocked (psutil, llm_interface.Path, GGUFBackend). The
Path mock is per-path so the primary and the fast profile can have
different file sizes in the same construction call.
"""

from pathlib import PurePath
from unittest.mock import MagicMock, patch

import pytest

GIB = 1024**3
MIB = 1024**2
PRIMARY_PATH = "models/gemma-4-E2B-it-Q5_K_M.gguf"
PRIMARY_SIZE = int(3.1 * 1e9)  # ~3.1 GB (decimal GB)
FAST_PATH = "models/fast.gguf"
FAST_SIZE = 800 * MIB  # 800 MiB fast-profile model


class MockVirtualMemory:
    """Mock psutil.virtual_memory() return value."""

    def __init__(self, available: int, total: int):
        self.available = available
        self.total = total


def _path_side_effect_for(sizes: dict):
    """Build a Path-class side effect mapping each path string to a mock
    whose exists()/stat() reflect the given size table."""

    def _factory(path_str, *args, **kwargs):
        instance = MagicMock()
        instance.exists.return_value = str(path_str) in sizes
        instance.stat.return_value = MagicMock(st_size=sizes.get(str(path_str), 0))
        instance.name = PurePath(str(path_str)).name
        return instance

    return _factory


class TestFastProfileFallback:
    """SmartLLM fast_profile_path behavior on RAM-gate refusal."""

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_primary_refused_fast_profile_loads(self, mock_vm, mock_backend):
        """Scenario A: primary (3.1 GB) refuses at 4 GiB free; fast profile loads."""
        mock_vm.return_value = MockVirtualMemory(available=4 * GIB, total=16 * GIB)
        path_sizes = {PRIMARY_PATH: PRIMARY_SIZE, FAST_PATH: FAST_SIZE}

        with patch("llm_interface.Path", side_effect=_path_side_effect_for(path_sizes)):
            from llm_interface import SmartLLM

            llm = SmartLLM(
                gguf_path=PRIMARY_PATH,
                fast_profile_path=FAST_PATH,
                gguf_n_ctx=4096,
            )

        assert llm.backend is not None, (
            "SmartLLM must construct via the fast profile when the primary "
            "model fails the RAM gate"
        )
        mock_backend.assert_called_once()
        call_kwargs = mock_backend.call_args.kwargs
        assert call_kwargs.get("gguf_path") == FAST_PATH, (
            f"GGUFBackend must be constructed with the fast profile "
            f"({FAST_PATH}); got call: {mock_backend.call_args}"
        )

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_primary_and_fast_both_refuse_mentions_primary_shortfall(
        self, mock_vm, mock_backend
    ):
        """Scenario B: both models refuse (500 MiB free); the error must name
        the PRIMARY model's requirement, not just the fast profile's."""
        mock_vm.return_value = MockVirtualMemory(available=500 * MIB, total=16 * GIB)
        path_sizes = {PRIMARY_PATH: PRIMARY_SIZE, FAST_PATH: FAST_SIZE}

        with patch("llm_interface.Path", side_effect=_path_side_effect_for(path_sizes)):
            from llm_interface import SmartLLM

            with pytest.raises(RuntimeError) as exc_info:
                SmartLLM(
                    gguf_path=PRIMARY_PATH,
                    fast_profile_path=FAST_PATH,
                    gguf_n_ctx=4096,
                )

        msg = str(exc_info.value)
        assert (
            "Insufficient RAM" in msg
        ), f"double refusal must raise the RAM diagnostic; got: {msg!r}"
        assert "GB" in msg, (
            f"double refusal error must include the primary model's required "
            f"GB figure; got: {msg!r}"
        )
        assert PRIMARY_PATH.split("/")[-1] in msg, (
            f"double refusal error must name the PRIMARY model "
            f"({PRIMARY_PATH}); got: {msg!r}"
        )
        mock_backend.assert_not_called()

    @patch("llm_interface.GGUFBackend")
    @patch("psutil.virtual_memory")
    def test_primary_refused_no_fast_profile_raises(self, mock_vm, mock_backend):
        """Scenario C: no fast_profile_path configured -> direct refusal, as today."""
        mock_vm.return_value = MockVirtualMemory(available=4 * GIB, total=16 * GIB)
        path_sizes = {PRIMARY_PATH: PRIMARY_SIZE}

        with patch("llm_interface.Path", side_effect=_path_side_effect_for(path_sizes)):
            from llm_interface import SmartLLM

            with pytest.raises(RuntimeError) as exc_info:
                SmartLLM(gguf_path=PRIMARY_PATH, gguf_n_ctx=4096)

        assert "Insufficient RAM" in str(exc_info.value)
        mock_backend.assert_not_called()
