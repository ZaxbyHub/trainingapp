/**
 * PROPOSED clinical-safety wording (issue #365, WI4). Single source of truth:
 * these constants are quoted VERBATIM in CONFIGURATION.md ("Clinical safety
 * rails (PROPOSED wording)") and in the PR body, and gate on the maintainer's
 * review before merge (issue #365 AC3). Tests pin the rendering against
 * these exports, so a wording change without a sign-off update cannot ship
 * silently.
 */

/** Refusal framing delivered (as a token + complete turn) instead of a RAG
 *  answer when the classifier detects an out-of-scope clinical question. */
export const SAFETY_REFUSAL_TEXT =
  'This training assistant does not provide individual clinical advice. Questions about '
  + 'personal dosing, self-diagnosis, or treatment decisions must be answered by a licensed '
  + 'clinician using authorized clinical resources. Your uploaded training documents and '
  + 'knowledge packs remain available for study questions - ask about the material itself '
  + 'and I will cite it.';

/** Always-on educational disclaimer rendered with every assistant answer
 *  (and on the chat welcome state). */
export const CLINICAL_DISCLAIMER_TEXT =
  'Educational content only. This assistant answers questions about your uploaded training '
  + 'materials; it does not provide medical advice, diagnosis, or dosing guidance. Verify all '
  + 'clinical decisions against authoritative sources and licensed care.';

/** Notice shown in place of the grounding badge on a safety-routed refusal. */
export const SAFETY_NOTICE_TEXT =
  'Clinical-advice request refused. This answer came from the safety branch, not from '
  + 'retrieval or the model.';
