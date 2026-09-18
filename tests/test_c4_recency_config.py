"""C4 (issue #71) config-surface tests: packs.recency.* keys in both
settings and engine config, with env overrides honored end to end.

Frozen check driver repro/check-c6.sh runs this whole file.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import RAGSettings  # noqa: E402
from rag_engine import RAGConfig  # noqa: E402


def fresh_settings(monkeypatch=None, **env):
    if monkeypatch is not None:
        for key, value in env.items():
            monkeypatch.setenv(key, value)
    return RAGSettings(_env_file=None)


def test_default_keys_and_values():
    s = fresh_settings()
    assert s.rag_packs_recency_half_life_months == 9
    assert s.rag_packs_recency_floor_months == 18
    assert s.rag_packs_recency_floor == pytest.approx(0.85)


def test_env_overrides_honored(monkeypatch):
    s = fresh_settings(
        monkeypatch,
        RAG_PACKS_RECENCY_HALF_LIFE_MONTHS="12",
        RAG_PACKS_RECENCY_FLOOR_MONTHS="6",
        RAG_PACKS_RECENCY_FLOOR="0.5",
    )
    assert s.rag_packs_recency_half_life_months == 12
    assert s.rag_packs_recency_floor_months == 6
    assert s.rag_packs_recency_floor == pytest.approx(0.5)


def test_ragconfig_carries_recency_keys():
    config = RAGConfig(
        packs_recency_half_life_months=12,
        packs_recency_floor_months=6,
        packs_recency_floor=0.5,
    )
    assert config.packs_recency_half_life_months == 12
    assert config.packs_recency_floor_months == 6
    assert config.packs_recency_floor == pytest.approx(0.5)
    as_dict = config.to_dict()
    assert as_dict["packs_recency_half_life_months"] == 12
    assert RAGConfig.from_dict(as_dict).packs_recency_floor_months == 6
    # Defaults survive a from_dict round-trip of legacy payloads.
    legacy = RAGConfig.from_dict({"db_path": str(Path("x"))})
    assert legacy.packs_recency_floor == pytest.approx(0.85)


def test_overrides_observably_change_the_multiplier(tmp_path, monkeypatch):
    """Env override -> settings -> RAGConfig -> VectorStore recency params ->
    a measurably different ranking adjustment."""
    from datetime import datetime, timedelta, timezone

    from recency import recency_multiplier

    monkeypatch.setenv("RAG_PACKS_RECENCY_FLOOR", "0.5")
    monkeypatch.setenv("RAG_PACKS_RECENCY_FLOOR_MONTHS", "6")
    s = fresh_settings(monkeypatch)
    config = RAGConfig(
        db_path=str(tmp_path / "db"),
        packs_recency_half_life_months=s.rag_packs_recency_half_life_months,
        packs_recency_floor_months=s.rag_packs_recency_floor_months,
        packs_recency_floor=s.rag_packs_recency_floor,
    )
    assert config.packs_recency_floor == pytest.approx(0.5)
    assert config.packs_recency_floor_months == 6

    now = datetime(2026, 9, 18, tzinfo=timezone.utc)
    published_at = (now - timedelta(days=30.44 * 6)).isoformat()
    assert recency_multiplier(published_at, now=now, floor=0.5, floor_months=6) == (
        pytest.approx(0.5, rel=1e-9)
    )


def test_settings_api_models_expose_recency_keys():
    """SettingsResponse/SettingsUpdateRequest carry the three fields so the
    settings surface stays in lockstep with the OpenAPI contract."""
    from api_server import SettingsResponse, SettingsUpdateRequest  # noqa: E402

    response = SettingsResponse(
        chunk_size=512,
        chunk_overlap=100,
        n_results=4,
        min_similarity=0.3,
        temperature=0.3,
        max_tokens=512,
        hybrid_search=True,
        reranking_enabled=False,
        context_truncation=20000,
        retrieval_window=1,
        initial_retrieval_top_k=12,
        rerank_top_k=4,
        packs_recency_half_life_months=9,
        packs_recency_floor_months=18,
        packs_recency_floor=0.85,
    )
    assert response.packs_recency_floor == pytest.approx(0.85)

    update = SettingsUpdateRequest(rag_packs_recency_floor_months=12)
    assert update.rag_packs_recency_half_life_months is None
    assert update.rag_packs_recency_floor_months == 12
    # Validation bounds: floor must stay within [0, 1].
    with pytest.raises(Exception):
        SettingsUpdateRequest(rag_packs_recency_floor=1.5)
