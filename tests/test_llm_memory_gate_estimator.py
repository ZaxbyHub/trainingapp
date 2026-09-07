"""
Acceptance checks for issue #53 (AC1): the GGUF load RAM requirement must be a
realistic estimate, not the old flat "4x file size" multiplier.

NEW-SURFACE check: `llm_interface.estimate_required_memory` does not exist at
base, so running this file at base fails at collection with ImportError. That
ImportError is the expected RED for this file; it turns green once the fix
introduces the function.

Contract pinned here:

    estimate_required_memory(file_size: int, n_ctx: int) -> int

returns file_size + KV-cache estimate (conservatively a 1 GiB constant) +
1 GiB overhead. For the bundled ~3.1 GB model that is ~5.1 GB — well under
the old 12.4 GB claim — so the model fits the issue's 8-11 GB free-RAM
target hardware.
"""

import pytest

from llm_interface import estimate_required_memory

GIB = 1024**3
# Documented size of the bundled gemma-4-E2B-it-Q5_K_M.gguf (~3.1 GB, decimal GB)
BUNDLED_MODEL_SIZE = int(3.1 * 1e9)


class TestEstimateRequiredMemory:
    """Checks for the module-level memory requirement estimator."""

    def test_3_1gb_model_requirement_is_well_under_old_4x_claim(self):
        """The 3.1 GB model must no longer claim 4x file size (~12.4 GB)."""
        estimate = estimate_required_memory(BUNDLED_MODEL_SIZE, 4096)

        assert estimate < int(BUNDLED_MODEL_SIZE * 4), (
            f"estimate_required_memory({BUNDLED_MODEL_SIZE}, 4096) = {estimate}, "
            f"which is not below the old 4x claim of {int(BUNDLED_MODEL_SIZE * 4)}"
        )

    def test_3_1gb_model_requirement_within_sane_band(self):
        """Estimate must cover at least file + 1 GiB overhead, but stay under file + 4 GiB."""
        estimate = estimate_required_memory(BUNDLED_MODEL_SIZE, 4096)

        lower = BUNDLED_MODEL_SIZE + GIB
        upper = BUNDLED_MODEL_SIZE + 4 * GIB
        assert lower <= estimate <= upper, (
            f"estimate_required_memory({BUNDLED_MODEL_SIZE}, 4096) = {estimate}, "
            f"expected within sane band [{lower}, {upper}] "
            f"(file + KV cache + overhead)"
        )

    @pytest.mark.parametrize("free_gib", [8, 16, 32])
    def test_3_1gb_model_fits_free_ram_scenarios(self, free_gib):
        """AC2 by construction: the 3.1 GB model's estimate fits 8 GiB free (and up)."""
        estimate = estimate_required_memory(BUNDLED_MODEL_SIZE, 4096)
        available = free_gib * GIB

        assert estimate <= available, (
            f"estimate_required_memory({BUNDLED_MODEL_SIZE}, 4096) = {estimate} "
            f"exceeds the {free_gib} GiB free-RAM scenario ({available}); "
            f"the gate would refuse the bundled model on the issue's target hardware"
        )

    def test_larger_model_requires_more_memory(self):
        """Monotonicity: a 16 GiB-file model must require more than a 2 GiB-file model."""
        small = estimate_required_memory(2 * GIB, 4096)
        large = estimate_required_memory(16 * GIB, 4096)

        assert large > small, (
            f"estimate must grow with file size: "
            f"2 GiB file -> {small}, 16 GiB file -> {large}"
        )
