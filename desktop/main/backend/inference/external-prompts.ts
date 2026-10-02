// Prompt text sent to an external model endpoint (universal-provider-settings-
// overhaul, AC12 parity; PR #142 review F-004).
//
// Self-contained on purpose: plain string constants only, no imports. The
// browser app keeps a byte-identical twin and a drift test that reads THIS
// file as text, so any edit here must land in the twin in the same change.
// The local llama.cpp prompt is separate and unaffected.

/** The system prompt sent to an external model (both protocols). */
export const EXTERNAL_SYSTEM_PROMPT =
  "You are TrainingApp's assistant. Answer the user's question directly and concisely. When retrieved context is provided, base your answer on it and say when it does not contain the answer.";

/** The instruction that opens a grounded user turn (before the numbered passages). */
export const EXTERNAL_GROUNDED_INSTRUCTION = 'Answer the question using the retrieved context when relevant.';

/** The label that introduces the question after the passages in a grounded user turn. */
export const EXTERNAL_GROUNDED_QUESTION_LABEL = 'Question: ';
