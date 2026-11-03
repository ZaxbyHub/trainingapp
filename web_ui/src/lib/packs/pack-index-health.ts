/**
 * Boot-time pack index self-heal (#270, frozen check C6).
 *
 * The pack store's `embedded` flag lives in the registry, not in the search
 * indexes: if pack chunks were wiped from the keyword (or vector) index the
 * flag stayed true and the chunks stayed invisible to retrieval forever.
 * `ensurePackIndexHealth` compares every active installed pack against the
 * keyword index at boot, re-indexes the pack's chunks when any are missing,
 * and clears the `embedded` flag so `embedPendingPackChunks` re-embeds the
 * vector side. A zero-chunk pack is healthy by definition and never
 * re-triggers indexing.
 *
 * Ordering contract (PC-8): the boot path runs this BEFORE
 * `embedPendingPackChunks`, so pending records are only enumerated after the
 * flag repairs have landed.
 */

import type { DocumentChunk } from '../../types/document';
import { storedVersionDocs } from './browser-pack-manager';

// pack-ingest is imported DYNAMICALLY inside ensurePackIndexHealth (the same
// lazy pattern browser-pack-manager uses): a static import would pull the
// search indexes and their WASM into every module that only lists packs —
// and into every app-shell test graph. Its REAL types flow from the dynamic
// import, so tsc enforces indexPackKeywords's actual parameter shape
// (PRR-001: the previous local interface + `as unknown as never` cast hid a
// KeywordIndex-instance-where-PackIndexTargets-expected bug that made the
// production repair throw while the mocked spec stayed green).

/** Structural surface ensurePackIndexHealth needs from the pack manager. */
export interface PackHealthManager {
  /** Every active installed version record (embedded flag included). */
  activeRecords(): Promise<Array<{ packId: string; version: string; dir: string; embedded?: boolean }>>;
  readVersionFile(
    record: { packId: string; dir: string },
    segments: readonly string[]
  ): Promise<Uint8Array | null>;
  markEmbedded(packId: string, version: string, embedded: boolean): Promise<void>;
}

/** Keyword-index surface for the presence probe + repair. */
export interface PackHealthKeywordTarget {
  initialize(): Promise<void>;
  isReady(): boolean;
  findChunks(predicate: (meta: { docId: string }) => boolean, limit?: number): unknown[];
  addDocuments(chunks: DocumentChunk[]): void;
  removeByDocId(docId: string): void;
  save(): Promise<void>;
}

/** Vector-index surface for the vector-side wipe probe (AC6 keyword-or-vector). */
export interface PackHealthVectorTarget {
  initialize(): Promise<void>;
  isReady(): boolean;
  hasDocEntries(docId: string): boolean;
}

export interface PackHealthResult {
  checked: number;
  repaired: string[];
}

/** The real keyword index, resolved lazily to keep it off the import path. */
async function defaultKeywordTarget(): Promise<PackHealthKeywordTarget> {
  const mod = await import('../search/keyword-index');
  return mod.getKeywordIndex() as unknown as PackHealthKeywordTarget;
}

/** In-flight health pass (PRR-010): boot and the embedding-service-ready
 * listener can overlap; joiners await the running pass instead of
 * interleaving two repairs of the same packs. */
let healthInFlight: Promise<PackHealthResult> | null = null;

/**
 * Compare active installed packs against the keyword index and repair the
 * gaps. Returns the repaired pack ids (empty when everything is healthy).
 *
 * Single-flight (PRR-010): concurrent calls share one pass — the second
 * caller receives the first pass's result rather than racing its own scan.
 */
export function ensurePackIndexHealth(
  manager: PackHealthManager,
  targets?: { keyword?: PackHealthKeywordTarget; vector?: PackHealthVectorTarget }
): Promise<PackHealthResult> {
  if (healthInFlight !== null) {
    return healthInFlight;
  }
  const run = runEnsurePackIndexHealth(manager, targets).finally(() => {
    if (healthInFlight === run) {
      healthInFlight = null;
    }
  });
  healthInFlight = run;
  return run;
}

async function runEnsurePackIndexHealth(
  manager: PackHealthManager,
  targets?: { keyword?: PackHealthKeywordTarget; vector?: PackHealthVectorTarget }
): Promise<PackHealthResult> {
  const keyword = targets?.keyword ?? (await defaultKeywordTarget());
  const vector =
    targets?.vector ??
    (await (async () => {
      const mod = await import('../search/vector-index');
      return mod.getVectorIndex() as unknown as PackHealthVectorTarget;
    })());
  const ingest = await import('./pack-ingest');
  // IR-21: the boot path can reach this pass BEFORE the app's service-init
  // effect has initialized the keyword index; probing an uninitialized index
  // would read an empty idMapping and diagnose every intact pack as wiped
  // (per-boot full re-embed). initialize() is idempotent.
  await keyword.initialize();
  const repaired: string[] = [];
  let checked = 0;

  for (const record of await manager.activeRecords()) {
    checked++;
    const stored = await storedVersionDocs(
      manager as unknown as Parameters<typeof storedVersionDocs>[0],
      record as unknown as Parameters<typeof storedVersionDocs>[1]
    );
    // Pack files gone (corrupt store / removed underneath us): nothing to
    // heal from; leave the record alone.
    if (stored === null) continue;

    const chunks = ingest.buildPackChunks(stored.manifest, stored.docs);
    // A zero-chunk pack is healthy: no re-trigger on a second health run.
    if (chunks.length === 0) continue;

    const docIds = [...new Set(chunks.map((c) => c.docId).filter((id): id is string => !!id))];
    // AC6: keyword OR vector wipe. A vector-only wipe (keyword intact, vector
    // store lost) is detected through the loaded mapping probe: mapping rows
    // only survive a successful snapshot load.
    let vectorReady = false;
    if (docIds.length > 0) {
      try {
        await vector.initialize();
        vectorReady = vector.isReady();
      } catch {
        vectorReady = false;
      }
    }
    const missing =
      docIds.some((docId) => keyword.findChunks((meta) => meta.docId === docId, 1).length === 0) ||
      (vectorReady && docIds.some((docId) => !vector.hasDocEntries(docId)));
    if (!keyword.isReady()) {
      // Initialization failed (storage unavailable): probing would read an
      // empty mapping — skip this pack rather than mis-diagnose it as wiped.
      continue;
    }
    if (!missing) continue;

    // Repair the keyword side (remove + re-add + save, the install path).
    // The injected keyword target is passed as a { keyword } bundle — the
    // shape indexPackKeywords dereferences (PRR-001).
    try {
      await ingest.indexPackKeywords(stored.manifest, stored.docs, { keyword });
    } catch (repairError) {
      // One pack's repair failure must not abort the health pass for the
      // remaining packs nor skip the boot embed pass (PRR-001 blast radius):
      // leave this record's embedded flag untouched so the next boot retries.
      console.error(
        `[pack-index-health] repair failed for ${record.packId}@${record.version}:`,
        repairError
      );
      continue;
    }
    // Clear the embedded flag so the boot embed pass re-embeds the vector
    // side (embedPackChunks removes by docId first, so no duplicates).
    if (record.embedded === true) {
      await manager.markEmbedded(record.packId, record.version, false);
    }
    repaired.push(`${record.packId}@${record.version}`);
  }

  return { checked, repaired };
}

/**
 * The boot composition (PC-8): the health repairs MUST land before
 * embedPendingPackChunks enumerates pending records — a record whose flag is
 * cleared by the health pass must be visible to the embed enumeration, and a
 * still-deferred health check must not let the embed pass run early.
 */
export async function ensurePackIndexHealthThenEmbed(
  manager: PackHealthManager,
  embed: () => Promise<void>,
  targets?: { keyword?: PackHealthKeywordTarget; vector?: PackHealthVectorTarget }
): Promise<void> {
  try {
    await ensurePackIndexHealth(manager, targets);
  } catch (error) {
    // The health pass must never suppress the embed pass (PRR-001): a read
    // failure here still lets pending pack embeddings run.
    console.error('[pack-index-health] health check failed; embedding anyway:', error);
  }
  await embed();
}
