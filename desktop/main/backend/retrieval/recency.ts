// retrieval/recency.ts — post-RRF recency prior, cross-pack chunk dedup, and
// version precedence (C4, issue #71).
//
// Implements the ranking rules frozen by ADR-0004 ("Recency ranking (chosen
// here, implemented in C4/#71)" and "Dedup semantics"):
//
//   ageMonths  = (now - publishedAt) / 30.44 days
//   multiplier = 1.0 - (1.0 - floor) * min(1.0, ageMonths / floorMonths)
//   adjusted   = rrfScore * multiplier        (applied AFTER fusion)
//
// The shipping default is the LINEAR form (packs.recency.floor 0.85,
// packs.recency.floorMonths 18); the exponential half-life variant
// (packs.recency.halfLifeMonths, default 9) is reserved and NOT wired. The
// same semantics live in the Python backend's recency.py — the two MUST NOT
// diverge (ADR-0004 amendment). Semver precedence reuses the PackManager
// comparator (store/pack-manager.ts versionKey) so there is one algorithm.

/** One active pack's claim on a chunk (from the packs/docs join). */
export interface PackClaim {
  packId: string;
  version: string;
  /** Pack manifest publishedAt (RFC3339); null on pre-C4 rows -> neutral. */
  publishedAt: string | null;
  active: boolean;
}

export interface RecencyPriorOptions {
  /** Supply a fixed clock for deterministic ranking/tests. */
  now?: Date;
  /** packs.recency.floor (default 0.85). */
  floor?: number;
  /** packs.recency.floorMonths (default 18). */
  floorMonths?: number;
}

export const DEFAULT_RECENCY_FLOOR = 0.85;
export const DEFAULT_RECENCY_FLOOR_MONTHS = 18;
/** ADR-0004: the 30.44-day month is part of the pinned formula. */
export const DAYS_PER_MONTH = 30.44;

/**
 * Linear recency multiplier r(ageMonths). age <= 0 clamps to fresh (1.0);
 * a missing/unparseable publishedAt is neutral (1.0). Falls linearly from
 * 1.0 to `floor` across `floorMonths`, then holds at the floor.
 */
export function recencyMultiplier(
  publishedAt: string | null | undefined,
  options: RecencyPriorOptions = {},
): number {
  const moment = publishedAtTime(publishedAt);
  if (!Number.isFinite(moment)) return 1;
  const nowMs = (options.now ?? new Date()).getTime();
  const ageMonths = (nowMs - moment) / (DAYS_PER_MONTH * 24 * 60 * 60 * 1000);
  if (ageMonths <= 0) return 1;
  const horizon = options.floorMonths ?? DEFAULT_RECENCY_FLOOR_MONTHS;
  const fraction = Math.min(1, ageMonths / horizon);
  return 1 - (1 - (options.floor ?? DEFAULT_RECENCY_FLOOR)) * fraction;
}

/**
 * Epoch-ms for a pack publishedAt, matching Python parse_published_at:
 * timezone-less ISO datetimes are treated as UTC (Python assigns UTC to
 * naive values) and missing/invalid values map to -Infinity so claim
 * precedence can never promote an unparseable timestamp (Python parity:
 * recency.py _claim_sort_key).
 */
export function publishedAtTime(
  publishedAt: string | null | undefined,
): number {
  if (!publishedAt) return Number.NEGATIVE_INFINITY;
  const text = publishedAt.trim();
  if (!text) return Number.NEGATIVE_INFINITY;
  // Date-only forms ("2024-01-01") are UTC per the JS spec; datetimes
  // without an explicit offset get a Z appended so they parse as UTC too.
  const normalized =
    /[Zz]$|[+-]\d{2}:?\d{2}$/.test(text) || !/T/i.test(text)
      ? text
      : `${text}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Precedence winner among ACTIVE claims: greater publishedAt, then
 * semver-highest version (PackManager comparator — a pre-release sorts below
 * its release), then lexicographically greatest packId (ADR-0004 dedup
 * semantics). Non-active claims never compete.
 */
export function precedenceWinner(claims: readonly PackClaim[]): PackClaim | null {
  const active = claims.filter((claim) => claim.active);
  if (active.length === 0) return null;
  return active.reduce((best, claim) => {
    const bestTime = publishedAtTime(best.publishedAt);
    const claimTime = publishedAtTime(claim.publishedAt);
    if (claimTime !== bestTime) return claimTime > bestTime ? claim : best;
    const versionCmp = safeVersionCompare(claim.version, best.version);
    if (versionCmp !== 0) return versionCmp > 0 ? claim : best;
    return (claim.packId ?? '') > (best.packId ?? '') ? claim : best;
  });
}

/**
 * Rank fused RRF results under pack version precedence + recency.
 *
 * `packMetadataByChunk` maps chunkId -> claims for that chunk:
 *  - chunk absent from the map: NEUTRAL — kept at its fused score, never
 *    deduped (the unpackaged/legacy rule);
 *  - present with an EMPTY claim list: inactive-pack orphan — EXCLUDED from
 *    the candidate set entirely (never merely down-weighted; issue #71 AC2);
 *  - present with claims: only ACTIVE claims compete; no active claim drops
 *    the chunk; otherwise exactly one copy survives, attributed to the
 *    precedence winner, scored `rrfScore * recencyMultiplier(winner)`.
 *
 * Returns `[chunkId, adjustedScore]` sorted by adjusted score DESCENDING,
 * stable on input order for ties, so repeated identical queries rank
 * identically (issue #71 AC5 determinism).
 */
export function applyRecencyPrior(
  fused: ReadonlyArray<readonly [string, number]>,
  packMetadataByChunk: ReadonlyMap<string, readonly PackClaim[]> | null,
  options: RecencyPriorOptions = {},
): Array<[string, number]> {
  // Dedup by chunk identity: exactly one copy survives per chunkId (the
  // highest adjusted copy), first occurrence wins position ties, so the
  // re-ranking is deterministic across repeated identical queries (AC5) —
  // kept in lockstep with the Python apply_recency_prior.
  const best = new Map<string, number>();
  const order: string[] = [];
  for (const [chunkId, score] of fused) {
    const claims = packMetadataByChunk?.get(chunkId);
    let adjusted = score;
    if (claims !== undefined) {
      const winner = precedenceWinner(claims);
      if (winner === null) continue; // orphan / inactive-only: excluded
      adjusted = score * recencyMultiplier(winner.publishedAt, options);
    }
    if (!best.has(chunkId)) {
      best.set(chunkId, adjusted);
      order.push(chunkId);
    } else if (adjusted > (best.get(chunkId) as number)) {
      best.set(chunkId, adjusted);
    }
  }
  const survivors: Array<[string, number]> = order.map((chunkId) => [
    chunkId,
    best.get(chunkId) as number,
  ]);
  survivors.sort((a, b) => b[1] - a[1]);
  return survivors;
}

/**
 * Semver compare that cannot throw into the retrieval path: claims come from
 * the packs table (schema-validated at install), but a malformed row must
 * degrade to "oldest" instead of failing a query.
 */
function safeVersionCompare(a: string, b: string): number {
  try {
    return compareVersionKeys(versionKey(a), versionKey(b));
  } catch {
    return 0;
  }
}

// Imported last for readability; the comparator is the single semver
// authority in the backend (store/pack-manager.ts).
import { compareVersionKeys, versionKey } from '../store/pack-manager.js';
