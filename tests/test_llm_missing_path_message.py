"""
Preserving checks for issue #53: SmartLLM's no-backend error message for a
missing model path must keep saying "No GGUF backend available".

PRESERVING (expected GREEN at base and after the fix):
- gguf_path=None skips the load block entirely and raises the no-backend
  message;
- a path that genuinely does not exist on disk (real Path, no mocking)
  raises the same message.

Only these two genuinely-preserved cases are pinned. The
constructor-failure message for an EXISTING file is intentionally improving
in this issue and is deliberately not asserted here.
"""

import pytest


class TestMissingPathMessage:
    """SmartLLM must keep raising "No GGUF backend available" for missing paths."""

    def test_none_path_raises_no_gguf_backend_message(self):
        from llm_interface import SmartLLM

        with pytest.raises(RuntimeError) as exc_info:
            SmartLLM(gguf_path=None)

        assert "No GGUF backend available" in str(exc_info.value), (
            f"gguf_path=None must raise the no-backend message; "
            f"got: {str(exc_info.value)!r}"
        )

    def test_absent_file_raises_no_gguf_backend_message(self):
        from llm_interface import SmartLLM

        with pytest.raises(RuntimeError) as exc_info:
            SmartLLM(gguf_path="definitely/not/here.gguf")

        assert "No GGUF backend available" in str(exc_info.value), (
            f"a nonexistent gguf_path must raise the no-backend message; "
            f"got: {str(exc_info.value)!r}"
        )
