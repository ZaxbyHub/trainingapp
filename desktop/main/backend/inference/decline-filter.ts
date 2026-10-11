// #156: deterministic decline-sentence filter for the LFM 1.2B models.
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

/** The trained-in artefact sentence families, observed in captured output. */
const DECLINE_ARTEFACT_SENTENCES = [
  // "Did you perhaps forget to include the document containing this
  // information?" / "did you forget to attach the document?"
  /Did you (?:perhaps )?forget to (?:include|attach)[^.!?\n]*[.!?](?:\s|$)/gi,
  // "Once you provide the relevant document, I will be able to ..."
  /(?:Once|When) you (?:provide|attach|share|include) the (?:relevant )?document[^.!?\n]*[.!?](?:\s|$)/gi,
  // "Please provide/attach the relevant document ..."
  /Please (?:provide|attach|include|share) the (?:relevant )?document[^.!?\n]*[.!?](?:\s|$)/gi,
];

/**
 * Remove the trained-in decline artefact sentences from a model answer.
 * Byte-identical passthrough for anything that is not decline-shaped.
 */
export function filterDeclineSentences(text: string): string {
  if (text.length === 0) return text;
  if (!DECLINE_MARKER.test(text)) return text;
  let out = text;
  for (const pattern of DECLINE_ARTEFACT_SENTENCES) {
    out = out.replace(pattern, '');
  }
  return out;
}
