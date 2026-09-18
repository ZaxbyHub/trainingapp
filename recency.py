"""Post-RRF recency prior, cross-pack chunk dedup, and version precedence.

Implements the C4 ranking rules frozen by ADR-0004 ("Recency ranking
(chosen here, implemented in C4/#71)" and "Dedup semantics") and issue #71:

    age_months = (now - published_at) / 30.44 days
    multiplier  = 1.0 - (1.0 - floor) * min(1.0, age_months / floor_months)
    adjusted    = rrf_score * multiplier          (applied AFTER fusion)

Shipping default is the LINEAR form (`packs.recency.floor` 0.85,
`packs.recency.floorMonths` 18); the exponential half-life variant
(`packs.recency.halfLifeMonths`, default 9) is reserved and NOT wired (ADR).

Pure functions only: no store, no I/O, no clocks read here (`now` is
injectable so ranking and its tests are deterministic). The same semantics
are implemented for the Node backend in
desktop/main/backend/retrieval/recency.ts; the semver sort key is pinned to
pack_manager._version_key by tests/test_c4_recency_formula.py parity tests.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

# ADR-0004: the 30.44-day month is part of the pinned formula.
DAYS_PER_MONTH = 30.44
SECONDS_PER_DAY = 86400.0

DEFAULT_FLOOR = 0.85
DEFAULT_FLOOR_MONTHS = 18.0
DEFAULT_HALF_LIFE_MONTHS = 9.0


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def parse_published_at(value: Any) -> Optional[datetime]:
    """Parse an RFC3339 pack `published_at` (or datetime) to aware UTC.

    Returns None for None/empty/unparseable values so callers render the
    neutral multiplier instead of failing a query over bad metadata.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return _as_aware_utc(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        candidate = text.replace("Z", "+00:00") if text.endswith("Z") else text
        try:
            return _as_aware_utc(datetime.fromisoformat(candidate))
        except ValueError:
            return None
    return None


def recency_multiplier(
    published_at: Any = None,
    now: Optional[datetime] = None,
    floor: float = DEFAULT_FLOOR,
    floor_months: float = DEFAULT_FLOOR_MONTHS,
) -> float:
    """Linear recency multiplier r(age_months) per ADR-0004.

    r = 1.0 for age <= 0 (clock skew clamps to fresh); falls linearly from
    1.0 to `floor` across `floor_months`, then holds at `floor`. Missing or
    unparseable `published_at` is neutral (1.0).
    """
    moment = parse_published_at(published_at)
    if moment is None:
        return 1.0
    reference = _as_aware_utc(now) if now is not None else _utc_now()
    age_months = (reference - moment).total_seconds() / (
        DAYS_PER_MONTH * SECONDS_PER_DAY
    )
    if age_months <= 0.0:
        return 1.0
    horizon = float(floor_months) if floor_months else DEFAULT_FLOOR_MONTHS
    fraction = min(1.0, age_months / horizon)
    return 1.0 - (1.0 - float(floor)) * fraction


def semver_sort_key(version: str) -> Tuple[int, int, int, Tuple[int, tuple]]:
    """Semver 2.0.0 section-11 sort key (numeric triple, then pre-release
    ordering per 11.4: numeric identifiers compare numerically and rank
    below alphanumeric ones). Kept in lockstep with
    ``pack_manager._version_key``; parity is asserted by
    tests/test_c4_recency_formula.py so the two cannot drift."""
    core, _, _build = version.partition("+")
    core, _, pre = core.partition("-")
    major_s, minor_s, patch_s = core.split(".")
    major, minor, patch = int(major_s), int(minor_s), int(patch_s)
    if not pre:
        pre_key: Tuple[int, tuple] = (1, ())
    else:
        ids = tuple(
            (0, int(part), "") if part.isdigit() else (1, 0, part)
            for part in pre.split(".")
        )
        pre_key = (0, ids)
    return (major, minor, patch, pre_key)


def _claim_sort_key(claim: Mapping[str, Any]) -> tuple:
    """Precedence key: greater published_at wins, then semver-highest
    version, then lexicographically greatest pack_id (ADR-0004 dedup
    semantics). Published-at ties fall through to the version/id breaks."""
    moment = parse_published_at(claim.get("published_at"))
    epoch = moment.timestamp() if moment is not None else float("-inf")
    version = claim.get("version") or "0.0.0"
    try:
        version_key = semver_sort_key(version)
    except (ValueError, AttributeError):
        version_key = (0, 0, 0, (1, ()))
    pack_id = claim.get("pack_id") or ""
    return (epoch, version_key, pack_id)


def winning_claim(claims: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """The precedence winner among ACTIVE claims (None if there is none).

    Shared by apply_recency_prior and the VectorStore ranking layer so the
    surviving copy's citation attribution comes from the same precedence
    chain (published_at, semver, pack_id) that picked it.
    """
    active = [c for c in claims if c.get("active")]
    if not active:
        return None
    return max(active, key=_claim_sort_key)


def apply_recency_prior(
    fused_results: Sequence[Tuple[str, float]],
    pack_metadata_by_chunk: Optional[Mapping[str, Sequence[Mapping[str, Any]]]] = None,
    now: Optional[datetime] = None,
    floor: float = DEFAULT_FLOOR,
    floor_months: float = DEFAULT_FLOOR_MONTHS,
) -> List[Tuple[str, float]]:
    """Rank fused RRF results under pack version precedence + recency.

    Args:
        fused_results: ``[(chunk_id, rrf_score), ...]`` in fused order.
        pack_metadata_by_chunk: chunk_id -> claims. Each claim carries
            ``pack_id``, ``version``, ``published_at``, ``active``. Semantics:
              * chunk_id absent from the map -> neutral (kept, multiplier
                1.0, never deduped) -- the unpackaged/legacy rule;
              * present with an EMPTY claim list -> inactive-pack orphan,
                dropped (issue #71 version precedence, defense-in-depth);
              * present with claims -> only ACTIVE claims compete; if none
                is active the chunk is dropped; otherwise exactly one copy
                survives, attributed to the precedence winner (greater
                published_at, then semver-highest version, then
                lexicographically greatest pack_id), scored
                ``rrf_score * recency_multiplier(winner.published_at)``.
    Returns:
        ``[(chunk_id, adjusted_score), ...]`` sorted by adjusted score
        descending; ties keep fused (input) order via a stable sort.
    """
    claims_map = pack_metadata_by_chunk or {}
    # Dedup by chunk identity: exactly one copy survives per chunk_id (the
    # highest adjusted copy), first occurrence wins position ties so the
    # re-ranking is deterministic across repeated identical queries (AC5).
    best: Dict[str, Tuple[float, int]] = {}
    order: List[str] = []
    for position, (chunk_id, score) in enumerate(fused_results):
        claims = claims_map.get(chunk_id)
        if claims is None:
            adjusted = score
        else:
            winner = winning_claim(claims)
            if winner is None:
                # Empty list (orphan) or only inactive claims: excluded from
                # the candidate set entirely (never merely down-weighted).
                continue
            multiplier = recency_multiplier(
                winner.get("published_at"),
                now=now,
                floor=floor,
                floor_months=floor_months,
            )
            adjusted = score * multiplier
        if chunk_id not in best:
            best[chunk_id] = (adjusted, position)
            order.append(chunk_id)
        elif adjusted > best[chunk_id][0]:
            best[chunk_id] = (adjusted, best[chunk_id][1])
    survivors = [(chunk_id, best[chunk_id][0]) for chunk_id in order]
    # Stable sort keeps fused order for equal adjusted scores.
    survivors.sort(key=lambda pair: pair[1], reverse=True)
    return survivors
