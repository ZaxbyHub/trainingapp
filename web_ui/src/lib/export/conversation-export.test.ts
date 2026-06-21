import { describe, it, expect } from 'vitest';
import { toConversationExport, exportAsJSON, exportAsMarkdown } from './conversation-export';
import type { ChatMessage } from '../../types/chat';

const messages: ChatMessage[] = [
  { id: 's', role: 'system', content: 'hidden', timestamp: 1 },
  { id: 'u', role: 'user', content: 'What is X?', timestamp: 2,
    images: [{ id: 'i1', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', fileName: 'shot.png' }] },
  { id: 'a', role: 'assistant', content: 'X is Y.', timestamp: 3, sources: ['/docs/a.pdf', '/docs/b.txt'] },
];

describe('toConversationExport', () => {
  it('drops system messages and omits raw image bytes', () => {
    const out = toConversationExport(messages);
    expect(out.version).toBe(1);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.find((m) => m.role === 'system')).toBeUndefined();
    const user = out.messages.find((m) => m.role === 'user')!;
    expect(user.images).toEqual([{ fileName: 'shot.png', mimeType: 'image/png' }]);
    // No dataUrl leaks into the export.
    expect(JSON.stringify(out)).not.toContain('base64');
  });

  it('includes assistant sources', () => {
    const out = toConversationExport(messages);
    expect(out.messages.find((m) => m.role === 'assistant')!.sources).toEqual(['/docs/a.pdf', '/docs/b.txt']);
  });
});

describe('exportAsJSON', () => {
  it('produces valid, pretty JSON', () => {
    const json = exportAsJSON(messages);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('\n'); // pretty-printed
  });
});

describe('exportAsMarkdown', () => {
  it('renders You/Assistant headings, content, and basenamed sources', () => {
    const md = exportAsMarkdown(messages);
    expect(md).toContain('## You');
    expect(md).toContain('## Assistant');
    expect(md).toContain('What is X?');
    expect(md).toContain('X is Y.');
    expect(md).toContain('- a.pdf'); // basename, not full path
    expect(md).toContain('- b.txt');
    expect(md).not.toContain('hidden'); // system dropped
    expect(md).toContain('shot.png'); // attachment noted
  });
});
