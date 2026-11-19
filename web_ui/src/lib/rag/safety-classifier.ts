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
    pattern: /\b(should i|can i|is it safe to)\s+(?:still\s+)?take\b/i,
    positiveExample: 'Should I take 500 mg of metformin with my breakfast?',
    negativeExample: 'What do the training materials say about taking metformin with food?',
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
 */
export function classifyTopic(question: string): SafetyClassification {
  if (typeof question !== 'string') return { outOfScope: false, category: null, matchedRules: [] };
  const text = question.trim();
  if (text === '') return { outOfScope: false, category: null, matchedRules: [] };
  const matchedRules: string[] = [];
  for (const rule of SAFETY_RULES) {
    if (rule.pattern.test(text)) matchedRules.push(rule.id);
  }
  return matchedRules.length > 0
    ? { outOfScope: true, category: 'clinical', matchedRules }
    : { outOfScope: false, category: null, matchedRules: [] };
}
