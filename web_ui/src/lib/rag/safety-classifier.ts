/**
 * Out-of-scope topic classifier (issue #365, WI4 clinical safety rails).
 *
 * Deterministic keyword/intent-class detection of ADVICE-SHAPED clinical
 * questions (personal dosing, self-diagnosis, treatment decisions,
 * clinician-role requests). The app is a training/knowledge tool: questions
 * ABOUT documents that merely mention drugs or conditions stay in scope;
 * questions SOUGHT AS personal clinical advice route through the safety
 * branch (refusal framing + disclaimer) instead of the normal RAG answer.
 *
 * PROPOSED artifact (issue #365 AC3): the rule list is governance, not
 * engineering. Every rule carries a positive AND a negative example; the
 * whole list is exported, quoted verbatim in CONFIGURATION.md ("Clinical
 * safety rails (PROPOSED wording)") and in the PR body, and gates on the
 * maintainer's review before merge. No model dependency.
 */

/** A single classifier rule: an advice-shape pattern plus its sign-off
 *  examples (pinned by tests — a rule whose negative example matches is a
 *  false-positive defect; a rule whose positive example does not match is a
 *  dead rule). */
export interface SafetyRule {
  /** Stable id, recorded in matchedRules and the PROPOSED rule table. */
  id: string;
  /** Intent class the rule belongs to (refusal framing copy keys on it). */
  intent: 'dosing' | 'diagnosis' | 'treatment' | 'clinician-role';
  /** Case-insensitive advice-shape pattern over the raw question. */
  pattern: RegExp;
  /** In-scope idiom TAIL (occurrence-anchored): what may follow the shape
   *  occurrence's own final word for THAT occurrence to read as an ordinary
   *  document/study action. Suppression is per-sentence-unit AND
   *  per-occurrence (round 4): the tail is anchored at the shape match's
   *  end - never searched across the whole question - so a second clause's
   *  idiom cannot lend suppression to another clause's medication decision,
   *  and clinically ambiguous heads (course/pack: "course of warfarin",
   *  "pack of samples") are excluded from the list entirely. With no idiom
   *  coverage the bare shape fires - fail-toward-refusal: an unlisted drug
   *  name ("Should I take warfarin?") refuses because the shape alone
   *  decides. clinicalContext is the whole-unit override: ANY clinical
   *  signal in the sentence unit makes an idiom-covered occurrence refuse
   *  anyway ("take a look at my insulin dosage"). */
  inScopeWhen?: RegExp;
  /** Vocabulary second-chance net and the idiom-override signal (see
   *  inScopeWhen). Dosage units, medication words, pharmaceutical suffix
   *  shapes. With no inScopeWhen on the rule it is inert. */
  clinicalContext?: RegExp;
  /** A question that MUST match (pinned). */
  positiveExample: string;
  /** A question that MUST NOT match (pinned) - in-scope document/study
   *  question shaped like the rule's subject matter. */
  negativeExample: string;
}

/**
 * PROPOSED rule list. Advice-shape discipline: patterns require a personal
 * or patient-directed pronoun/verb, never a bare clinical vocabulary word,
 * so "What do the packs say about metformin dosing?" (document content)
 * stays in scope while "Should I take metformin?" is refused.
 */
export const SAFETY_RULES: readonly SafetyRule[] = Object.freeze([
  {
    id: 'dosing-personal-take',
    intent: 'dosing',
    // Fail-toward-refusal (review rounds 3-4 + final-critic rounds): the
    // bare personal-take shape decides. Suppression is PER-SENTENCE-UNIT
    // and PER-OCCURRENCE with CONTINUATION LIMITS: the in-scope idiom tail
    // must follow the shape occurrence's own "take" (anchored at the match
    // end, never a whole-question search), and the text AFTER the idiom must
    // keep the occurrence an ordinary study action - no further "take"
    // ("take the quiz, then take my warfarin"), no possessive ("the
    // document's recommended amount of warfarin"), no coordination ("take
    // these notes and my warfarin"). A clinical signal anywhere in the unit
    // overrides every escape ("take a look at my insulin dosage" refuses).
    // Named-medication DECISIONS on the bare shape ("Should I take
    // warfarin?") refuse; document/study questions about unlisted drugs
    // ("Can I take a look at the warfarin monograph?", "Can I take the
    // document to the pharmacy?") stay in scope under the escape.
    pattern: /\b(should i|can i|is it safe to)\s+(?:still\s+)?take\b/i,
    // Rounds 7-8 (final-critic): clinically ambiguous idiom heads are
    // removed as each is found - course/pack (round 4), over/bare part
    // (round 7), and minute (round 8: "take a minute AMOUNT of warfarin"
    // reads minute as the adjective, a dosing question). Only unambiguous
    // study/inspection/participation idioms survive.
    inScopeWhen: /\s*(?:a (?:look|seat|moment)|notes?|part in|the (?:training|quiz|module|exam|session|document|slide|slides)|this (?:training|quiz|module|document|slide|slides)|these (?:slides|documents|notes))\b/i,
    clinicalContext: /\b(mg|mcg|ml|dose|dosing|dosage|medication|medicine|meds|drug|drugs|pill|pills|tablet|tablets|capsule|capsules|insulin|antibiotic|antibiotics|painkiller|painkillers|supplement|supplements|vitamin|vitamins|aspirin|ibuprofen|paracetamol|acetaminophen|metformin|statin|statins|steroid|steroids|[a-z]{3,}(?:cillin|mycin|olol|pril|sartan|statin|mab|nib|tinib|floxacin|cycline|azole|prazole|gliptin|dronate|zepam|conazole))\b/i,
    positiveExample: 'Should I take 500 mg of metformin with my breakfast?',
    negativeExample: 'Can I take a look at the training document before the session?',
  },
  {
    id: 'dosing-personal-amount',
    intent: 'dosing',
    pattern: /\bhow much\b.{0,40}\b(should i|do i|for me)\b|\bi weigh \d+.{0,60}\b(dose|how much)\b/i,
    positiveExample: 'How much ibuprofen should I take for my headache?',
    negativeExample: 'How much ibuprofen is discussed in the pain-management slide?',
  },
  {
    id: 'dosing-patient-directive',
    intent: 'dosing',
    pattern: /\bwhat dose should (?:i|we|the patient|my patient)\b|\b(?:dose|titrate) (?:it|the patient) (?:up|down)\b/i,
    positiveExample: 'What dose should I titrate the patient to?',
    negativeExample: 'What dose ranges appear in the dosing-table exercise?',
  },
  {
    id: 'diagnosis-self',
    intent: 'diagnosis',
    pattern: /\b(do i have|could i have|am i (?:sick|diagnosed|having)|what(?:'s| is) wrong with me|diagnose me)\b/i,
    positiveExample: 'Do I have lupus based on these symptoms?',
    negativeExample: 'What are the diagnostic criteria for lupus in the rheumatology pack?',
  },
  {
    id: 'diagnosis-results',
    intent: 'diagnosis',
    pattern: /\b(my (?:symptoms|labs?|test results|bp|blood pressure))\b.{0,50}\b(mean|indicate|normal|concerning|high|low)\b/i,
    positiveExample: 'Are my lab results concerning or normal?',
    negativeExample: 'Which lab results indicate renal impairment in the nephrology module?',
  },
  {
    id: 'treatment-personal-decision',
    intent: 'treatment',
    pattern: /\bshould (?:i|we)\b.{0,40}\b(stop|start|begin|discontinue|switch|prescribe|increase|decrease)\b/i,
    positiveExample: 'Should I stop my blood pressure medication now that I feel better?',
    negativeExample: 'When should clinicians consider stopping anticoagulation per the guideline summary?',
  },
  {
    id: 'treatment-patient-plan',
    intent: 'treatment',
    pattern: /\b(?:how (?:do|should|to)|what should) (?:i|we) treat\b|\b(?:my|this|the) patient (?:should|needs to|should be)\b/i,
    positiveExample: "How should I treat this patient's cellulitis?",
    negativeExample: 'How is cellulitis treated in the wound-care chapter?',
  },
  {
    id: 'clinician-role-play',
    intent: 'clinician-role',
    pattern: /\b(?:act as|pretend to be|roleplay as|you are now) (?:a |an |my )?(?:doctor|physician|clinician|nurse practitioner|specialist)\b/i,
    positiveExample: 'Act as a doctor and tell me what this rash is.',
    negativeExample: 'What does the communication-skills lesson say about talking to a doctor?',
  },
  {
    id: 'medical-advice-request',
    intent: 'clinician-role',
    pattern: /\b(?:give me|need|want) (?:some |any )?(?:medical|clinical|health) advice\b/i,
    positiveExample: 'Give me some medical advice about my chest pain.',
    negativeExample: 'What counts as medical advice in the documentation-ethics unit?',
  },
]);

/** Safety metadata persisted on a refusal turn (#365): the detection that
 *  routed it, so the bubble renders the safety notice (and suppresses the
 *  grounding badge + copy/citation actions) identically after a reload. */
export interface SafetyTurnMetadata {
  category: 'clinical';
  matchedRules: string[];
}

/** The classification outcome consumed by the safety branch. */
export interface SafetyClassification {
  outOfScope: boolean;
  /** Detected intent class (null when in scope). */
  category: 'clinical' | null;
  /** Ids of every matched PROPOSED rule (the sign-off surface evidence). */
  matchedRules: string[];
}

/**
 * Classify a question against the PROPOSED rule list. Pure and synchronous:
 * microseconds, never throws, degrades to in-scope on empty/whitespace input.
 * Evaluation is two-mode (rounds 4+6): rules WITHOUT an in-scope idiom
 * escape evaluate on the WHOLE question (their clinical shapes may span
 * sentences - "I weigh 72 kg. What dose is right for me?"), while only
 * escape-bearing rules evaluate per-sentence-unit with occurrence-anchored
 * suppression, because only their escape can suppress a real decision. A
 * DECIMAL POINT is not a boundary (round 5): digits around a period are
 * guarded with a placeholder before the split.
 */
export function classifyTopic(question: string): SafetyClassification {
  if (typeof question !== 'string') return { outOfScope: false, category: null, matchedRules: [] };
  const text = question.trim();
  if (text === '') return { outOfScope: false, category: null, matchedRules: [] };
  const DECIMAL_GUARD = '\u0000';
  const guarded = text.replace(/(\d)\.(\d)/g, `$1${DECIMAL_GUARD}$2`);
  const units = (guarded.match(/[^.!?\n;]+[.?!]?/g) ?? [guarded]).map((u) => u.replaceAll(DECIMAL_GUARD, '.'));
  const matchedRules: string[] = [];
  for (const rule of SAFETY_RULES) {
    // Rules WITHOUT an in-scope idiom escape have no suppression mechanism a
    // foreign clause could hijack, so they evaluate on the WHOLE question
    // exactly as before round 4 - clinical shapes that intentionally span
    // sentences ("I weigh 72 kg. What dose is right for me?") keep matching.
    // Only escape-bearing rules evaluate per sentence unit and per
    // occurrence (round 4), because only their escape can suppress a real
    // decision.
    const fires =
      rule.inScopeWhen === undefined ? rule.pattern.test(text) : units.some((unit) => ruleFiresOnUnit(rule, unit));
    if (fires) matchedRules.push(rule.id);
  }
  return matchedRules.length > 0
    ? { outOfScope: true, category: 'clinical', matchedRules }
    : { outOfScope: false, category: null, matchedRules: [] };
}

/** Whether the rule fires on one sentence unit. The bare shape decides
 *  (fail-toward-refusal). For rules with an in-scope idiom escape, the unit
 *  is suppressed only when EVERY shape occurrence's own tail is the idiom -
 *  anchored at the occurrence's end, never a whole-unit search - AND the
 *  continuation after the idiom keeps the occurrence an ordinary study
 *  action (final-critic r4 + implementation-review r12): the remainder must
 *  carry NO further "take" (a second, pronoun-less take is the hidden
 *  decision - "take the quiz, then take my warfarin"), must not open with
 *  a possessive ('s - "the document's recommended amount of warfarin"),
 *  and coordination (and/then/with/or/comma) breaks the escape UNLESS the
 *  coordinated remainder carries its own study verb ("take the quiz and
 *  then review my notes" stays in scope); a bare or possessed noun phrase
 *  coordinated onto the shared "take" ("...and my warfarin", "...and
 *  warfarin together", "...along with my warfarin") shares the ingestion
 *  verb and refuses regardless of determiners.
 *  A clinical signal anywhere in the unit overrides any of this. */
function ruleFiresOnUnit(rule: SafetyRule, unit: string): boolean {
  const global =
    rule.pattern.flags.includes('g') ? rule.pattern : new RegExp(rule.pattern.source, rule.pattern.flags + 'g');
  const occurrences = [...unit.matchAll(global)];
  if (occurrences.length === 0) return false;
  if (rule.clinicalContext?.test(unit)) return true;
  if (rule.inScopeWhen === undefined) return true;
  const anchoredTail = new RegExp('^(?:' + rule.inScopeWhen.source + ')', rule.inScopeWhen.flags.replace('g', ''));
  return !occurrences.every((m) => {
    const slice = unit.slice((m.index ?? 0) + m[0].length);
    const tailMatch = anchoredTail.exec(slice);
    if (tailMatch === null) return false;
    const after = slice.slice(tailMatch[0].length);
    if (/\btake\b/i.test(after)) return false;
    if (/^['\u2019]s?\b/i.test(after)) return false;
    // Coordination breaks the escape unless the coordinated remainder
    // carries its own STUDY VERB (review/study/read/...), which keeps the
    // occurrence an ordinary study action ("take the quiz and then review
    // my notes"); a bare or possessed noun phrase coordinated onto the
    // shared "take" ("...and my warfarin", "...and warfarin together",
    // "...along with my warfarin") shares the ingestion verb and refuses
    // regardless of determiners (implementation-review round 13: refusal
    // must not depend on a possessive pronoun, and personal study
    // materials must stay in scope).
    const coordinated = /\b(?:and|then|with|or)\b/i.test(after) || /^\s*[,;]/.test(after);
    if (coordinated) {
      const STUDY_VERB =
        /\b(?:review(?:ed|ing|s)?|stud(?:y|ied|ies|ying)|read(?:s|ing)?|discuss(?:es|ed|ing|ion)?|complete[sd]?|attend(?:s|ed|ing)?|watch(?:es|ed|ing)?|open(?:s|ed|ing)?|print(?:s|ed|ing)?|download(?:s|ed|ing)?|upload(?:s|ed|ing)?|shar(?:e|es|ed|ing)|skips?|skipped|skipping|retak(?:e|es|en|ing)|summar(?:y|ize|ise[sd]?)|find(?:s|ing)?|search(?:es|ed|ing)?|brows(?:e|es|ed|ing)|look(?:s|ed|ing)? (?:at|into)|check(?:s|ed|ing)?)\b/i;
      if (!STUDY_VERB.test(after)) return false;
    }
    return true;
  });
}
