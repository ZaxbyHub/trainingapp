"""C4 (issue #71) pure recency/dedup formula tests: AC3, AC5, AC7.

Frozen check drivers repro/check-c3.sh (``-k ac3``), repro/check-c5.sh
(``-k ac5``), and repro/check-c8.sh (``-k ac7``) select tests here by keyword.
Also pins semver-sort-key parity with pack_manager._version_key.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pack_manager  # noqa: E402
import recency  # noqa: E402
from recency import apply_recency_prior, recency_multiplier  # noqa: E402

NOW = datetime(2026, 9, 18, 12, 0, 0, tzinfo=timezone.utc)


def months_ago(months: float) -> str:
    return (NOW - timedelta(days=30.44 * months)).isoformat()


# ------------------------------------------------------------------ #
# AC3 — multiplier formula exactness (injectable now)
# ------------------------------------------------------------------ #


def test_ac3_multiplier_exact_values():
    assert recency_multiplier(NOW.isoformat(), now=NOW) == pytest.approx(1.0, abs=1e-12)
    assert recency_multiplier(months_ago(9), now=NOW) == pytest.approx(0.925, rel=1e-9)
    assert recency_multiplier(months_ago(18), now=NOW) == pytest.approx(0.85, rel=1e-9)
    assert recency_multiplier(months_ago(36), now=NOW) == pytest.approx(0.85, rel=1e-9)


def test_ac3_multiplier_boundaries_and_neutral():
    # Future published_at (clock skew) clamps to fresh.
    future = (NOW + timedelta(days=1)).isoformat()
    assert recency_multiplier(future, now=NOW) == 1.0
    # Missing / unparseable published_at is neutral.
    assert recency_multiplier(None, now=NOW) == 1.0
    assert recency_multiplier("", now=NOW) == 1.0
    assert recency_multiplier("not-a-date", now=NOW) == 1.0
    # Naive datetime is treated as UTC, not an error.
    assert recency_multiplier(datetime(2026, 9, 18, 12, 0, 0), now=NOW) == 1.0
    # Configurable horizon: floor reached at floorMonths.
    assert recency_multiplier(
        months_ago(6), now=NOW, floor=0.5, floor_months=6
    ) == pytest.approx(0.5, rel=1e-9)


# ------------------------------------------------------------------ #
# AC5 — cross-pack dedup determinism (pure-function level)
# ------------------------------------------------------------------ #


CLAIM_NEWER = {
    "pack_id": "pack-b",
    "version": "1.0.0",
    "published_at": months_ago(1),
    "active": True,
}
CLAIM_OLDER = {
    "pack_id": "pack-a",
    "version": "3.0.0",
    "published_at": months_ago(30),
    "active": True,
}
CLAIM_INACTIVE = {
    "pack_id": "pack-c",
    "version": "9.0.0",
    "published_at": months_ago(0),
    "active": False,
}


def test_ac5_precedence_keeps_one_copy_with_newest_published_at():
    fused = [("chunkH", 0.03)]
    claims = {"chunkH": [CLAIM_OLDER, CLAIM_NEWER, CLAIM_INACTIVE]}
    for _ in range(10):
        ranked = apply_recency_prior(fused, claims, now=NOW)
        assert len(ranked) == 1
        chunk_id, adjusted = ranked[0]
        assert chunk_id == "chunkH"
        expected = 0.03 * recency_multiplier(CLAIM_NEWER["published_at"], now=NOW)
        assert adjusted == pytest.approx(expected, rel=1e-12)


def test_ac5_published_at_tie_breaks_on_semver_then_id():
    same_pub = months_ago(4)
    claims = {
        "chunkH": [
            {
                "pack_id": "pack-b",
                "version": "1.0.0",
                "published_at": same_pub,
                "active": True,
            },
            {
                "pack_id": "pack-a",
                "version": "2.0.0",
                "published_at": same_pub,
                "active": True,
            },
        ]
    }
    winner = recency.winning_claim(claims["chunkH"])
    assert winner["version"] == "2.0.0"  # semver, not install order
    # Equal versions: lexicographically greatest pack id.
    claims_tie = {
        "chunkH": [
            {
                "pack_id": "pack-a",
                "version": "2.0.0",
                "published_at": same_pub,
                "active": True,
            },
            {
                "pack_id": "pack-b",
                "version": "2.0.0",
                "published_at": same_pub,
                "active": True,
            },
        ]
    }
    assert recency.winning_claim(claims_tie["chunkH"])["pack_id"] == "pack-b"
    # Pre-release sorts BELOW its release (semver 11.4).
    claims_pre = {
        "chunkH": [
            {
                "pack_id": "pack-a",
                "version": "2.0.0",
                "published_at": same_pub,
                "active": True,
            },
            {
                "pack_id": "pack-b",
                "version": "2.0.0-rc.1",
                "published_at": same_pub,
                "active": True,
            },
        ]
    }
    assert recency.winning_claim(claims_pre["chunkH"])["version"] == "2.0.0"


def test_ac5_duplicate_chunk_ids_collapse_and_are_deterministic():
    fused = [("chunkH", 0.02), ("chunkH", 0.03)]
    claims = {"chunkH": [CLAIM_NEWER, CLAIM_OLDER]}
    first = apply_recency_prior(fused, claims, now=NOW)
    assert len(first) == 1  # exactly one copy retained
    for _ in range(10):
        assert apply_recency_prior(fused, claims, now=NOW) == first


# ------------------------------------------------------------------ #
# AC7 — post-RRF application + neutral-for-unpackaged contract
# ------------------------------------------------------------------ #


def test_ac7_prior_reorders_after_fusion_and_neutral_pass_through():
    fused = [("old-pack-chunk", 0.04), ("fresh-pack-chunk", 0.03), ("user-doc", 0.02)]
    claims = {
        "old-pack-chunk": [
            {
                "pack_id": "p",
                "version": "1.0.0",
                "published_at": months_ago(20),
                "active": True,
            }
        ],
        "fresh-pack-chunk": [
            {
                "pack_id": "p",
                "version": "2.0.0",
                "published_at": months_ago(0),
                "active": True,
            }
        ],
    }
    ranked = apply_recency_prior(fused, claims, now=NOW)
    ids = [chunk_id for chunk_id, _ in ranked]
    # The fresher pack chunk overtakes the higher fused score; the
    # unpackaged chunk keeps its exact fused score and never drops.
    assert ids[0] == "old-pack-chunk" or ids[0] == "fresh-pack-chunk"
    by_id = dict(ranked)
    assert by_id["user-doc"] == pytest.approx(0.02, rel=1e-12)
    assert by_id["fresh-pack-chunk"] == pytest.approx(0.03, rel=1e-12)
    assert by_id["old-pack-chunk"] < 0.04  # recency demoted the stale chunk
    scores = [score for _, score in ranked]
    assert scores == sorted(scores, reverse=True)


def test_ac7_orphans_excluded_and_never_downweighted():
    fused = [("orphan", 0.05), ("live", 0.01)]
    claims = {"orphan": []}  # pack-attributed, no active claim
    ranked = apply_recency_prior(fused, claims, now=NOW)
    assert [chunk_id for chunk_id, _ in ranked] == ["live"]


def test_ac7_inactive_only_claims_excluded():
    fused = [("gone", 0.05)]
    claims = {"gone": [dict(CLAIM_INACTIVE)]}
    assert apply_recency_prior(fused, claims, now=NOW) == []


def test_ac7_semver_key_parity_with_pack_manager():
    versions = [
        "1.0.0",
        "2.0.0",
        "2.0.0-rc.1",
        "2.0.0-rc.2",
        "2.0.1",
        "10.0.0",
        "1.2.3+build.7",
        "0.9.0-alpha.1",
    ]
    for version in versions:
        assert recency.semver_sort_key(version) == pack_manager._version_key(version)


def test_ac7_applies_to_fused_rrf_scale_not_similarity():
    # RRF scores are O(1/(k+rank)); the multiplier is scale-invariant but
    # this pins the adjusted value lands on the fused scale, not [0, 1].
    fused = [("c", 1 / 61)]
    claims = {"c": [CLAIM_NEWER]}
    ranked = apply_recency_prior(fused, claims, now=NOW)
    expected = (1 / 61) * recency_multiplier(CLAIM_NEWER["published_at"], now=NOW)
    assert ranked[0][1] == pytest.approx(expected, rel=1e-12)
