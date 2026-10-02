// PR #142 review F-004 (desktop half): the external prompt text lives in a
// self-contained module (string constants only, no imports) that the browser
// app twins byte-for-byte, and the request builder uses exactly those
// constants. The text itself is unchanged from before the move.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_GROUNDED_INSTRUCTION,
  EXTERNAL_GROUNDED_QUESTION_LABEL,
  EXTERNAL_SYSTEM_PROMPT,
} from '../../main/backend/inference/external-prompts';
import * as generator from '../../main/backend/inference/external-generator';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'main', 'backend', 'inference', 'external-prompts.ts');

describe('F-004: external prompt constants', () => {
  it('the module is self-contained: no import or re-export, only exported string constants', () => {
    const source = fs.readFileSync(FILE, 'utf8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*export\s*\{/m);
    expect(source).not.toMatch(/^\s*export\s+\*/m);
    const exported = [...source.matchAll(/^export const (\w+)\s*=/gm)].map((m) => m[1]);
    expect(exported).toEqual(['EXTERNAL_SYSTEM_PROMPT', 'EXTERNAL_GROUNDED_INSTRUCTION', 'EXTERNAL_GROUNDED_QUESTION_LABEL']);
  });

  it('keeps the exact pre-move text', () => {
    expect(EXTERNAL_SYSTEM_PROMPT).toBe(
      "You are TrainingApp's assistant. Answer the user's question directly and concisely. When retrieved context is provided, base your answer on it and say when it does not contain the answer.",
    );
    expect(EXTERNAL_GROUNDED_INSTRUCTION).toBe('Answer the question using the retrieved context when relevant.');
    expect(EXTERNAL_GROUNDED_QUESTION_LABEL).toBe('Question: ');
    // The generator re-export is the same value (existing importers keep working).
    expect(generator.EXTERNAL_SYSTEM_PROMPT).toBe(EXTERNAL_SYSTEM_PROMPT);
  });

  it('the request builder sends exactly these constants', () => {
    const base = { question: 'Q?', contextTexts: ['P1'], airgap: false };
    const openai = generator.buildExternalRequest({ ...base, config: { protocol: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: null } });
    const messages = openai.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: EXTERNAL_SYSTEM_PROMPT });
    expect(messages[1]?.content).toBe(`${EXTERNAL_GROUNDED_INSTRUCTION}\n\n[1] P1\n\n\n${EXTERNAL_GROUNDED_QUESTION_LABEL}Q?`);
    const anthropic = generator.buildExternalRequest({
      ...base,
      config: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: null },
    });
    expect(anthropic.body.system).toBe(EXTERNAL_SYSTEM_PROMPT);
  });
});
