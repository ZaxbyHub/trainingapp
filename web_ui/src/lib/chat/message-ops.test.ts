import { describe, it, expect } from 'vitest';
import { messagesForRegenerate } from './message-ops';
import type { ChatMessage } from '../../types/chat';

const ph: ChatMessage = { id: 'new', role: 'assistant', content: '', timestamp: 99, isStreaming: true };
const u = (id: string, c = 'q'): ChatMessage => ({ id, role: 'user', content: c, timestamp: 1 });
const a = (id: string, c = 'ans'): ChatMessage => ({ id, role: 'assistant', content: c, timestamp: 2 });
const sys = (id: string): ChatMessage => ({ id, role: 'system', content: 's', timestamp: 0 });

describe('messagesForRegenerate', () => {
  it('replaces the trailing assistant after the last user', () => {
    const out = messagesForRegenerate([u('u1'), a('a1')], ph);
    expect(out.map((m) => m.id)).toEqual(['u1', 'new']);
  });

  it('drops trailing system + assistant, keeps the user', () => {
    const out = messagesForRegenerate([u('u1'), a('a1'), sys('s1')], ph);
    expect(out.map((m) => m.id)).toEqual(['u1', 'new']);
  });

  it('preserves earlier turns and a leading hidden-messages indicator', () => {
    const out = messagesForRegenerate([sys('hidden'), u('u1'), a('a1'), u('u2'), a('a2')], ph);
    expect(out.map((m) => m.id)).toEqual(['hidden', 'u1', 'a1', 'u2', 'new']);
  });

  it('when the array already ends in a user message, does not over-trim', () => {
    const out = messagesForRegenerate([u('u1'), a('a1'), u('u2')], ph);
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'new']);
  });

  it('appends exactly one placeholder (no user duplication)', () => {
    const out = messagesForRegenerate([u('u1'), a('a1')], ph);
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(out.filter((m) => m.id === 'new')).toHaveLength(1);
  });
});
