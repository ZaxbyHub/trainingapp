"""
Acceptance checks for issue #53 (AC7): GGUF thread defaults must be
min(os.cpu_count() or 4, 8) everywhere the default is duplicated:
config.RAGSettings, app_gui Fast/Balanced presets (Quality stays 8),
rag_engine.RAGConfig, and the engine_factory fallbacks.

DISCRIMINATING on every machine: a test comparing the literal default to
min(cpu, 8) is vacuous on <=8-core machines (both sides are 4 at base), so
os.cpu_count is monkeypatched to 32 and the modules are RELOADED so their
defaults re-evaluate; the expected value is then 8 regardless of the host.

Everything is accessed via module attributes (import config; config.X), not
from-imports, so reload semantics are observed. Every reload cycle is
wrapped in try/finally-style fixture teardown with a final restoring reload
after the monkeypatch is undone. No engine is built: engine_factory's
create_engine is patched so only its RAGConfig fallback defaults are read.
"""

import importlib
import os
from unittest.mock import MagicMock, patch

import pytest

import app_gui
import config
import engine_factory
import rag_engine


def _reload_modules():
    """Reload, in dependency order, every module holding thread defaults."""
    importlib.reload(config)
    importlib.reload(app_gui)
    importlib.reload(rag_engine)
    importlib.reload(engine_factory)


@pytest.fixture
def cpu32_defaults(monkeypatch):
    """Patch os.cpu_count to 32 and reload the modules so defaults re-evaluate.

    Restores the unpatched modules afterwards with a second reload.
    """
    monkeypatch.delenv("RAG_GGUF_N_THREADS", raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: 32)
    _reload_modules()
    yield
    monkeypatch.undo()
    _reload_modules()


class TestThreadDefaultsCappedAtCpuCount:
    """With os.cpu_count() patched to 32, every default must be 8 (min(32, 8))."""

    def test_config_ragsettings_default(self, cpu32_defaults):
        got = config.RAGSettings().rag_gguf_n_threads
        assert got == 8, (
            f"config.RAGSettings rag_gguf_n_threads default: "
            f"expected 8 (min(32, 8) with os.cpu_count patched to 32), got {got}"
        )

    def test_gui_fast_preset(self, cpu32_defaults):
        got = app_gui._PRESET_FAST["gguf_n_threads"]
        assert got == 8, (
            f"app_gui._PRESET_FAST gguf_n_threads: "
            f"expected 8 (min(32, 8) with os.cpu_count patched to 32), got {got}"
        )

    def test_gui_balanced_preset(self, cpu32_defaults):
        got = app_gui._PRESET_BALANCED["gguf_n_threads"]
        assert got == 8, (
            f"app_gui._PRESET_BALANCED gguf_n_threads: "
            f"expected 8 (min(32, 8) with os.cpu_count patched to 32), got {got}"
        )

    def test_gui_quality_preset_stays_8(self, cpu32_defaults):
        got = app_gui._PRESET_QUALITY["gguf_n_threads"]
        assert got == 8, (
            f"app_gui._PRESET_QUALITY gguf_n_threads: expected 8 (unchanged "
            f"by this issue), got {got}"
        )

    def test_ragconfig_default_constructed_after_reload(self, cpu32_defaults):
        got = rag_engine.RAGConfig().gguf_n_threads
        assert got == 8, (
            f"rag_engine.RAGConfig gguf_n_threads default: "
            f"expected 8 (min(32, 8) with os.cpu_count patched to 32), got {got}"
        )

    def test_engine_factory_settings_fallback(self, cpu32_defaults):
        """create_engine_from_settings({}) must fall back to 8 threads."""
        with patch.object(
            engine_factory, "create_engine", return_value=MagicMock()
        ) as mock_create:
            engine_factory.create_engine_from_settings({})
        got = mock_create.call_args.kwargs["config"].gguf_n_threads
        assert got == 8, (
            f"engine_factory.create_engine_from_settings gguf_n_threads "
            f"fallback: expected 8 (min(32, 8) with os.cpu_count patched "
            f"to 32), got {got}"
        )

    def test_engine_factory_env_fallback(self, cpu32_defaults):
        """create_engine_from_env must default to 8 threads via config.settings."""
        with patch.object(
            engine_factory, "create_engine", return_value=MagicMock()
        ) as mock_create:
            engine_factory.create_engine_from_env()
        got = mock_create.call_args.kwargs["config"].gguf_n_threads
        assert got == 8, (
            f"engine_factory.create_engine_from_env gguf_n_threads default: "
            f"expected 8 (min(32, 8) with os.cpu_count patched to 32), got {got}"
        )
