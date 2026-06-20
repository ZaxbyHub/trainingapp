/**
 * Tests for LLM message content helpers (multimodal).
 */

import { describe, it, expect } from 'vitest';
import { messageContentToText, type LLMContentPart } from './llm';

describe('messageContentToText', () => {
  it('returns plain string content unchanged', () => {
    expect(messageContentToText('hello world')).toBe('hello world');
  });

  it('extracts and joins text parts, dropping image parts', () => {
    const parts: LLMContentPart[] = [
      { type: 'text', text: 'Describe this screenshot:' },
      { type: 'image', data: new ArrayBuffer(8) },
      { type: 'text', text: 'in one sentence.' },
    ];
    expect(messageContentToText(parts)).toBe('Describe this screenshot:\nin one sentence.');
  });

  it('returns empty string when content is only images', () => {
    expect(messageContentToText([{ type: 'image', data: new ArrayBuffer(4) }])).toBe('');
  });
});
