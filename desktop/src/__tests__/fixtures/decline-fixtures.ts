// #156 shared decline-sentence fixtures (approved plan section 3): ONE
// fixture source for BOTH decline filters — the desktop engine filter
// (desktop/main/backend/inference/decline-filter.ts, via
// t156-decline-filter.test.ts) and the web_ui browser path (wllama service,
// plan section 4b). Both LFM 1.2B models append the same trained-in "did you
// forget to include the document?" artefact when declining, so the captured
// production output and its variants are pinned here verbatim.
//
// The *FILTERED exports carry the filter's exact expected output, including
// the space that precedes a removed artefact sentence (the removal consumes
// the artefact and its trailing whitespace, not the space before it) — pin
// bytes, not intentions.

/** The captured production decline (02-reproduction.md R6), verbatim. */
export const CAPTURED_DECLINE =
  'The provided context does not contain information regarding the maximum permitted annual leave carryover ' +
  'for contractors in the EU. Did you perhaps forget to include the document containing this information? ' +
  'Once you provide the relevant document, I will be able to accurately determine and share the answer.';

/** The captured decline after filtering: marker sentence kept, both artefact
 *  sentences removed (trailing space before the first artefact remains). */
export const CAPTURED_DECLINE_FILTERED =
  'The provided context does not contain information regarding the maximum permitted annual leave carryover ' +
  'for contractors in the EU. ';

/** Same artefact family without the "perhaps" softener. */
export const DECLINE_WITHOUT_PERHAPS =
  'The provided context does not mention the retention period. Did you forget to attach the document with the policy?';

/** ...and its filtered form. */
export const DECLINE_WITHOUT_PERHAPS_FILTERED = 'The provided context does not mention the retention period. ';

/** The "Please provide the relevant document..." artefact family. */
export const DECLINE_PLEASE_PROVIDE =
  'The provided context does not contain the escalation matrix. Please provide the relevant document so I can answer accurately.';

/** ...and its filtered form. */
export const DECLINE_PLEASE_PROVIDE_FILTERED = 'The provided context does not contain the escalation matrix. ';

/** An answerable answer: byte-identical passthrough (no decline marker). */
export const ANSWERABLE_ANSWER =
  'The maximum permitted carryover is 5 days per year, as stated in section 4.2 of the leave policy.';

/** An answerable answer that MENTIONS documents but carries no decline
 *  marker — still byte-identical (the filter is marker-scoped). */
export const ANSWERABLE_MENTIONS_DOCUMENTS =
  'See the uploaded document titled Leave Policy for the details; the answer is 5 days.';
