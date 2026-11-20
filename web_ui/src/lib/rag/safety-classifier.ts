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
    // Fail-toward-refusal (review rounds 3-18): the bare personal-take
    // shape decides. Suppression is PER-OCCURRENCE on the WHOLE question:
    // the in-scope idiom tail must follow the shape occurrence's own
    // "take" (anchored at the match end), and every word after the idiom
    // must be a known study/locative word (see CONTINUATION_VOCAB) - any
    // drug name, verb, personal pronoun, coordinator, or unknown token
    // refuses. A clinical signal anywhere overrides every escape ("take a
    // look at my insulin dosage" refuses). Named-medication DECISIONS on
    // the bare shape ("Should I take warfarin?") refuse; document/study
    // questions about unlisted drugs ("Can I take a look at the warfarin
    // monograph?", "Can I take the document to the pharmacy?") stay in
    // scope under the escape.
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
 * Every rule evaluates on the WHOLE question (round 18: the per-unit system
 * was removed - sentence/newline/semicolon boundaries let a coordinated
 * dosing clause hide in a shape-less fragment). Escape-bearing rules
 * suppress only when EVERY shape occurrence's continuation after the idiom
 * is a known study/locative phrase (see isSafeContinuation); any unknown
 * word - a drug name, a verb, a coordinator, a personal pronoun - refuses.
 */
export function classifyTopic(question: string): SafetyClassification {
  if (typeof question !== 'string') return { outOfScope: false, category: null, matchedRules: [] };
  const text = question.trim();
  if (text === '') return { outOfScope: false, category: null, matchedRules: [] };
  const matchedRules: string[] = [];
  for (const rule of SAFETY_RULES) {
    if (ruleFiresOnText(rule, text)) matchedRules.push(rule.id);
  }
  return matchedRules.length > 0
    ? { outOfScope: true, category: 'clinical', matchedRules }
    : { outOfScope: false, category: null, matchedRules: [] };
}

/** Whether the rule fires on the whole question. The bare shape decides
 *  (fail-toward-refusal). For rules with an in-scope idiom escape, the rule
 *  is suppressed only when EVERY shape occurrence's own continuation after
 *  the idiom is a known study/locative phrase (round 18 allowlist, the
 *  convergence of rounds 12-17: every coordinator blocklist - personal
 *  markers, study verbs, coordinator word lists - was bypassed by the next
 *  coordinated form, so the check is INVERTED to a vocabulary allowlist; a
 *  clinical signal anywhere overrides any of this). */
function ruleFiresOnText(rule: SafetyRule, text: string): boolean {
  const global =
    rule.pattern.flags.includes('g') ? rule.pattern : new RegExp(rule.pattern.source, rule.pattern.flags + 'g');
  const occurrences = [...text.matchAll(global)];
  if (occurrences.length === 0) return false;
  if (rule.clinicalContext?.test(text)) return true;
  if (rule.inScopeWhen === undefined) return true;
  const anchoredTail = new RegExp('^(?:' + rule.inScopeWhen.source + ')', rule.inScopeWhen.flags.replace('g', ''));
  return !occurrences.every((m) => {
    const slice = text.slice((m.index ?? 0) + m[0].length);
    const tailMatch = anchoredTail.exec(slice);
    if (tailMatch === null) return false;
    return isSafeContinuation(slice.slice(tailMatch[0].length));
  });
}

/** Known study/locative words that may appear after an idiom occurrence
 *  without turning it into a medication decision: determiners, locative
 *  prepositions, and study-material nouns. Any OTHER word in the
 *  continuation - a drug name, a verb ("review"), a personal pronoun ("my"),
 *  a coordinator ("and", "along", "plus", "together"), or any unknown token
 *  ("&", "+", "/") - breaks the escape and refuses (fail-toward-refusal).
 *  After a locative preposition arbitrary nouns are accepted, so document
 *  questions about unlisted drugs ("...at the warfarin monograph?") stay in
 *  scope while "...and warfarin together?" refuses (the coordinator is
 *  checked BEFORE the preposition admits unknown words). */
const CONTINUATION_VOCAB = new Set([
  'the',
  'this',
  'these',
  'a',
  'an',
  'to',
  'at',
  'in',
  'on',
  'for',
  'about',
  'before',
  'after',
  'during',
  'from',
  'of',
  'document',
  'documents',
  'pack',
  'packs',
  'slide',
  'slides',
  'training',
  'quiz',
  'module',
  'exam',
  'session',
  'sessions',
  'notes',
  'chapter',
  'section',
  'manual',
  'guide',
  'guides',
  'handout',
  'course',
  'lesson',
  'lessons',
  'video',
  'recording',
  'deck',
  'archive',
  'library',
  'portal',
  'dashboard',
  'transcript',
  'script',
  'exercise',
  'assignment',
  'curriculum',
  'diagram',
  'appendix',
  'home',
  'offline',
]);
const CONTINUATION_PREPS = new Set(['to', 'at', 'in', 'on', 'for', 'about', 'before', 'after', 'during', 'from', 'of']);
const CONTINUATION_COORDINATORS = /\b(?:and|then|with|or|along|plus|besides|alongside|also|together|too)\b/i;

/** Whether every word in the continuation is a known study/locative word;
 *  after the first locative preposition arbitrary (unknown) nouns are
 *  accepted, but a coordinator anywhere refuses first. */
function isSafeContinuation(after: string): boolean {
  if (CONTINUATION_COORDINATORS.test(after)) return false;
  if (/\btake\b/i.test(after)) return false;
  const words = after
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  let inPrepPhrase = false;
  for (const word of words) {
    if (CONTINUATION_PREPS.has(word) && !inPrepPhrase) {
      inPrepPhrase = true;
      continue;
    }
    if (inPrepPhrase) continue;
    if (!CONTINUATION_VOCAB.has(word)) return false;
  }
  return true;
}
