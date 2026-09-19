// learn.ts — ask-time Learn-panel assembly (D6/#82).
//
// Joins the retrieval-cited chunk ids against the #80 links table and the
// docs table to build the learn[] payload: direct training-slide hits plus
// linked slides of cited doc chunks, deduped by slide (highest score wins,
// direct preferred on ties), ranked descending, capped at MAX_LEARN_RESULTS.
//
// The kernel MIRRORS learn_panel.py and web_ui/src/lib/rag/learn-kernel.ts
// (repo precedent: the desktop cannot import the Python module or the web_ui
// package; D4 pinned the same pattern with mirrored golden tests) — keep the
// three in lockstep.
//
// C5 (issue #72) landed the grounding field: the assembler takes it as an
// optional input and "general" yields [] (mirrors learn_panel.py:93 and
// web_ui/src/lib/rag/learn-kernel.ts).
import fs from 'node:fs';
import path from 'node:path';
import { queryLinksForChunks, slideIdFromDocPath, type LinksDb } from './store/links.js';
import type { CitedChunk, Grounding, LearnResultRow } from './types.js';

export const MAX_LEARN_RESULTS = 5;

/** Structural subset of better-sqlite3 this module needs. */
interface DocRow {
  chunk_id: string;
  id: string;
  source_class: string;
  path: string;
  title: string | null;
  pack_id: string | null;
}

interface SlideMeta {
  title: string | null;
  section: string | null;
  snippet: string | null;
}

/** Read title/section/on-screen snippet from the slide doc JSON on disk. */
function readSlideMeta(packsRoot: string | null | undefined, packId: string | null, docPath: string): SlideMeta | null {
  if (!packsRoot || !packId) return null;
  // Containment (defense-in-depth; protocol.ts discipline): the resolved path
  // must stay inside packsRoot even if a stored docPath ever carried `..` or
  // was absolute. Failure to contain = no metadata, never a wrong-file read.
  const packsRootAbs = path.resolve(packsRoot);
  const resolved = path.resolve(packsRootAbs, packId, docPath);
  if (!resolved.startsWith(packsRootAbs + path.sep)) return null;
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const onScreen = typeof parsed.on_screen_text === 'string' ? parsed.on_screen_text.trim() : '';
    return {
      title: typeof parsed.slide_title === 'string' ? (parsed.slide_title as string) : null,
      section: typeof parsed.section_title === 'string' ? (parsed.section_title as string) : null,
      snippet: onScreen.length > 0 ? onScreen.slice(0, 120) : null,
    };
  } catch {
    // Metadata enrichment is best-effort: a missing/unreadable pack file
    // degrades to store-derived titles, never fails the response.
    return null;
  }
}

export interface AssembleLearnOptions {
  /** Closed store (null) means learn cannot be computed -> the field is omitted. */
  db: LinksDb | null;
  cited: CitedChunk[];
  packsRoot?: string | null;
  maxResults?: number;
  /**
   * C5 (issue #72): the answer's grounded/general provenance. "general"
   * suppresses every row (contract: learn is empty when grounding is
   * "general"); omitted keeps the pre-C5 behavior.
   */
  grounding?: Grounding | null;
}

/**
 * Build learn[] rows for one answer. Pure failure-tolerant: any store or
 * disk error yields null (callers omit the field) rather than failing /ask.
 */
export function assembleLearnResults(options: AssembleLearnOptions): LearnResultRow[] | null {
  const { cited, packsRoot } = options;
  const db = options.db;
  const maxResults = options.maxResults ?? MAX_LEARN_RESULTS;
  if (db === null) return null;
  // C5 (issue #72): no qualifying evidence -> nothing to learn from.
  if (options.grounding === 'general') return [];
  if (cited.length === 0) return [];
  try {
    const placeholders = cited.map(() => '?').join(', ');
    const citedIds = cited.map((c) => c.chunkId);
    const citedScores = new Map(cited.map((c) => [c.chunkId, c.score]));

    const docRows = db
      .prepare(
        `SELECT c.id AS chunk_id, d.id, d.source_class, d.path, d.title, d.pack_id
         FROM chunks c JOIN docs d ON d.id = c.doc_id
         WHERE c.id IN (${placeholders})`,
      )
      .all(...citedIds) as DocRow[];

    // direct: the cited chunk IS a training-slide document.
    // linked: the cited chunks' top-3 linked slides from the #80 links table.
    const linkedRows = queryLinksForChunks(db, citedIds);

    // Resolve slide metadata for every referenced slide_id (direct + linked).
    const directSlideIds = new Set(
      docRows
        .filter((d) => d.source_class === 'training')
        .map((d) => slideIdFromDocPath(d.path))
        .filter((id): id is string => id !== null),
    );
    const linkedSlideIds = new Set(linkedRows.map((r) => r.slide_id));
    const slideDocs = new Map<string, { doc: DocRow; meta: SlideMeta | null }>();
    for (const slideId of new Set([...directSlideIds, ...linkedSlideIds])) {
      const row = db
        .prepare(
          `SELECT id, source_class, path, title, pack_id FROM docs
           WHERE source_class = 'training' AND path LIKE ? LIMIT 1`,
        )
        .get(`docs/slide-%-${slideId}.json`) as DocRow | undefined;
      if (row !== undefined) {
        slideDocs.set(slideId, { doc: row, meta: readSlideMeta(packsRoot, row.pack_id, row.path) });
      }
    }

    const best = new Map<string, LearnResultRow>();
    const offer = (row: LearnResultRow): void => {
      const current = best.get(row.slide_id);
      const prefer =
        current === undefined ||
        row.score > current.score ||
        (row.score === current.score && row.reason === 'direct' && current.reason !== 'direct');
      if (prefer) {
        if (current !== undefined && row.snippet === undefined && current.snippet !== undefined) {
          row.snippet = current.snippet;
        }
        best.set(row.slide_id, row);
      }
    };

    for (const doc of docRows) {
      if (doc.source_class !== 'training') continue;
      const slideId = slideIdFromDocPath(doc.path);
      if (slideId === null) continue;
      const entry = slideDocs.get(slideId);
      const meta = entry?.meta ?? null;
      offer({
        slide_id: slideId,
        title: meta?.title ?? doc.title ?? slideId,
        section: meta?.section ?? '',
        score: citedScores.get(doc.chunk_id) ?? 0,
        reason: 'direct',
        ...(meta?.snippet !== null && meta?.snippet !== undefined ? { snippet: meta.snippet } : {}),
        ...(doc.pack_id !== null ? { pack_id: doc.pack_id } : {}),
      });
    }

    for (const link of linkedRows) {
      const entry = slideDocs.get(link.slide_id);
      const meta = entry?.meta ?? null;
      const doc = entry?.doc ?? null;
      offer({
        slide_id: link.slide_id,
        title: meta?.title ?? doc?.title ?? link.slide_id,
        section: meta?.section ?? '',
        score: link.score,
        reason: 'linked',
        ...(meta?.snippet !== null && meta?.snippet !== undefined ? { snippet: meta.snippet } : {}),
        ...(doc?.pack_id != null ? { pack_id: doc.pack_id } : {}),
      });
    }

    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
  } catch (err) {
    console.error(
      `[trainingapp-backend] learn assembly failed (learn omitted): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
