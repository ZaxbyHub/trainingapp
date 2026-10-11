// #156: deterministic decline-sentence filter for the LFM 1.2B models.
//
// Browser twin of desktop/main/backend/inference/decline-filter.ts — the two
// files must stay byte-for-byte equivalent in DECLINE_MARKER, the three
// DECLINE_ARTEFACT_SENTENCES patterns, and filterDeclineSentences, so the
// desktop llama.cpp path and the browser wllama path (issue #156) filter the
// same sentences. Keep both in lockstep when either changes.
//
// Both LFM2-1.2B-RAG and LFM2.5-1.2B-Instruct append trained-in "did you
//
//
// Both LFM2-1.2B-RAG and LFM2.5-1.2B-Instruct append trained-in "did you
// forget to include/attach the document?" sentences when declining a
// not-in-sources question. The benchmark measured this as trained-in
// behaviour that prompting does not remove (issue #156, comment 2), with 0
// hits on any answerable question — so a filter scoped to decline-shaped
// answers is safe on the measured data and is the issue's prescribed fix.
//
// Scope guard: the artefact sentences are removed ONLY when the answer
// already contains a decline marker (the model stating the sources do not
// contain the answer). Answerable answers pass through byte-identical —
// pinned by tests on both sides.

/** Sentence-shaped decline markers: the model stating the evidence is absent. */
const DECLINE_MARKER =
  /does not (?:contain|mention|include|provide)|not (?:mentioned|found|contained) in|cannot (?:be )?found in|no information (?:about|on|regarding)|isn'?t (?:mentioned |provided )?in the (?:provided |retrieved )?context/i;

/** The trained-in artefact sentence families, observed in captured output.
 *  The tail is bounded AND colon-free (PRR-104): an unbounded tail deleted
 *  real answer content when an artefact lead-in shared a sentence with it —
 *  the tail cannot cross `:`, `;`, or a sentence terminator, so a
 *  colon-joined real answer survives. */
const DECLINE_ARTEFACT_SENTENCES = [
  // "Did you perhaps forget to include the document containing this
  // information?" / "did you forget to attach the document?"
  /Did you (?:perhaps )?forget to (?:include|attach)[^.!?\n:;]{0,120}?[.!?](?:\s|$)/gi,
  // "Once you provide the relevant document, I will be able to ..."
  /(?:Once|When) you (?:provide|attach|share|include) the (?:relevant )?document[^.!?\n:;]{0,120}?[.!?](?:\s|$)/gi,
  // "Please provide/attach the relevant document ..."
  /Please (?:provide|attach|include|share) the (?:relevant )?document[^.!?\n:;]{0,120}?[.!?](?:\s|$)/gi,
];

/**
 * Remove the trained-in decline artefact sentences from a model answer.
 * Byte-identical passthrough for anything that is not decline-shaped.
 * PRR-103 guard: if filtering would erase the whole answer (a marker clause
 * embedded inside an artefact-family sentence), return the original — an
 * unexplained empty bubble is worse than an imperfect decline.
 */
export function filterDeclineSentences(text: string): string {
  if (text.length === 0) return text;
  if (!DECLINE_MARKER.test(text)) return text;
  let out = text;
  for (const pattern of DECLINE_ARTEFACT_SENTENCES) {
    out = out.replace(pattern, '');
  }
  if (out.trim() === '' && text.trim() !== '') return text;
  return out;
}
