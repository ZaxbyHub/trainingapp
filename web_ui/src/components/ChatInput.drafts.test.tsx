/**
 * #267 (AC8, frozen check C24): per-conversation drafts in the composer —
 * a draftKey switch saves the outgoing draft, shows the stored draft, and
 * reports it through onDraftChange; a remount restores; a send clears;
 * and the sentinel migration (moveDraftIfTargetEmpty — the helper ChatInput
 * owns as the single migration owner) carries the '\u0000new' draft to the
 * adopted conversation id BEFORE hydration would read the store.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChatInput } from './ChatInput';
import { clearDraft, getDraft, setDraft } from '../lib/chat/draft-store';

const NEW_CONVERSATION_RESERVED_KEY = '\u0000new';

function setup(draftKey: string | undefined, onDraftChange?: (text: string) => void) {
  const onSend = vi.fn();
  const view = render(
    <ChatInput
      onSend={onSend}
      isLoading={false}
      onCancel={vi.fn()}
      draftKey={draftKey}
      onDraftChange={onDraftChange}
    />,
  );
  const textarea = () => screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
  return { onSend, textarea, view };
}

describe('ChatInput per-conversation drafts (#267 AC8)', () => {
  beforeEach(() => {
    cleanup();
    clearDraft('conv-1');
    clearDraft('conv-2');
    clearDraft(NEW_CONVERSATION_RESERVED_KEY);
  });
  afterEach(() => {
    cleanup();
    clearDraft('conv-1');
    clearDraft('conv-2');
    clearDraft(NEW_CONVERSATION_RESERVED_KEY);
  });

  it('edits are stored under the draftKey and a key switch SAVES the outgoing draft + SHOWS the stored one', () => {
    setDraft('conv-2', 'conversation two draft');
    const onDraftChange = vi.fn();
    const { textarea, view } = setup('conv-1', onDraftChange);
    fireEvent.change(textarea(), { target: { value: 'conv one typing' } });
    expect(getDraft('conv-1')).toBe('conv one typing');

    // Switch conversations.
    view.rerender(
      <ChatInput
        onSend={vi.fn()}
        isLoading={false}
        onCancel={vi.fn()}
        draftKey="conv-2"
        onDraftChange={onDraftChange}
      />,
    );
    // The outgoing draft was saved; the stored draft is displayed and
    // reported through onDraftChange.
    expect(getDraft('conv-1')).toBe('conv one typing');
    expect(textarea().value).toBe('conversation two draft');
    expect(onDraftChange).toHaveBeenCalledWith('conversation two draft');

    // And back: the outgoing conv-2 draft is intact, conv-1's is restored.
    view.rerender(
      <ChatInput
        onSend={vi.fn()}
        isLoading={false}
        onCancel={vi.fn()}
        draftKey="conv-1"
        onDraftChange={onDraftChange}
      />,
    );
    expect(getDraft('conv-2')).toBe('conversation two draft');
    expect(textarea().value).toBe('conv one typing');
  });

  it('a remount restores the stored draft (element reuse across conversations)', () => {
    setDraft('conv-1', 'restored on remount');
    const first = setup('conv-1');
    expect(first.textarea().value).toBe('restored on remount');
    first.view.unmount();
    const second = setup('conv-1');
    expect(second.textarea().value).toBe('restored on remount');
  });

  it('sending clears the stored draft', () => {
    const { textarea } = setup('conv-1');
    fireEvent.change(textarea(), { target: { value: 'send me' } });
    expect(getDraft('conv-1')).toBe('send me');
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    expect(getDraft('conv-1')).toBeUndefined();
    expect(textarea().value).toBe('');
  });

  it('the sentinel migration carries the new-chat draft to the adopted id THROUGH the component (review r1: production call site pinned)', () => {
    // The user typed under the new-conversation sentinel, then the first turn
    // adopted a real conversation id: the composer's key-switch handler must
    // move the sentinel draft onto the adopted key before hydration. This
    // leg exercises the production call inside ChatInput (not the helper
    // directly), so deleting the moveDraftIfTargetEmpty call there goes RED.
    // Review r2 (COR-1): the migration is gated on the ADOPTION signal — the
    // rerender carries adoptedDraftKey="conv-9", exactly what ChatPage sets
    // (batched) when a first turn adopts its id.
    setDraft(NEW_CONVERSATION_RESERVED_KEY, 'carried to the adopted id');
    const onDraftChange = vi.fn();
    const { onSend, textarea, view } = setup(NEW_CONVERSATION_RESERVED_KEY, onDraftChange);
    expect(textarea().value).toBe('carried to the adopted id');
    view.rerender(
      <ChatInput
        onSend={onSend}
        isLoading={false}
        onCancel={vi.fn()}
        draftKey="conv-9"
        adoptedDraftKey="conv-9"
        onDraftChange={onDraftChange}
      />,
    );
    expect(textarea().value).toBe('carried to the adopted id');
    expect(getDraft('conv-9')).toBe('carried to the adopted id');
    expect(getDraft(NEW_CONVERSATION_RESERVED_KEY)).toBeUndefined();
    clearDraft('conv-9');
  });

  it('WITHOUT the adoption signal a key switch away from the sentinel does NOT migrate (COR-1: selecting an existing conversation keeps the sentinel draft)', () => {
    // The user typed under the new-conversation sentinel, then SELECTED an
    // existing conversation (conv-2) — ChatPage changes currentConversationId
    // WITHOUT adopting anything, so no adoptedDraftKey accompanies the switch.
    // The sentinel's draft must stay under the sentinel (it is the new-chat
    // draft, not conv-2's), and the composer shows conv-2's own draft.
    setDraft(NEW_CONVERSATION_RESERVED_KEY, 'stranded on purpose: not conv-2 content');
    const onDraftChange = vi.fn();
    const { textarea, view } = setup(NEW_CONVERSATION_RESERVED_KEY, onDraftChange);
    expect(textarea().value).toBe('stranded on purpose: not conv-2 content');
    view.rerender(
      <ChatInput
        onSend={vi.fn()}
        isLoading={false}
        onCancel={vi.fn()}
        draftKey="conv-2"
        onDraftChange={onDraftChange}
      />,
    );
    // The sentinel draft did NOT travel: it stays under the sentinel key.
    expect(getDraft(NEW_CONVERSATION_RESERVED_KEY)).toBe('stranded on purpose: not conv-2 content');
    expect(getDraft('conv-2')).toBeUndefined();
    // And the composer hydrated conv-2's own (empty) draft.
    expect(textarea().value).toBe('');
    expect(onDraftChange).toHaveBeenCalledWith('');
  });

  it('the adoption is ONE-SHOT: a stale adoptedDraftKey after New chat cannot re-arm the migration (delta review r2)', () => {
    // Full user flow: draft A under the sentinel -> first turn adopts conv-9
    // (carry fires) -> New chat -> draft B typed under the sentinel -> the
    // user re-selects conv-9 from history while a STALE adoptedDraftKey is
    // still set (a parent that has not cleared it yet). The adoption was
    // already consumed, so the migration must NOT fire: draft B stays under
    // the sentinel and conv-9 keeps its carried draft A.
    setDraft(NEW_CONVERSATION_RESERVED_KEY, 'draft A for the first turn');
    const { onSend, textarea, view } = setup(NEW_CONVERSATION_RESERVED_KEY);
    view.rerender(
      <ChatInput onSend={onSend} isLoading={false} onCancel={vi.fn()} draftKey="conv-9" adoptedDraftKey="conv-9" onDraftChange={vi.fn()} />,
    );
    expect(textarea().value).toBe('draft A for the first turn');
    expect(getDraft('conv-9')).toBe('draft A for the first turn');
    // New chat: back to the sentinel (a stale parent still carries the old
    // adoptedDraftKey), and the user types a new draft there.
    view.rerender(
      <ChatInput onSend={onSend} isLoading={false} onCancel={vi.fn()} draftKey={NEW_CONVERSATION_RESERVED_KEY} adoptedDraftKey="conv-9" onDraftChange={vi.fn()} />,
    );
    expect(textarea().value).toBe('');
    view.rerender(
      <ChatInput onSend={onSend} isLoading={false} onCancel={vi.fn()} draftKey={NEW_CONVERSATION_RESERVED_KEY} adoptedDraftKey="conv-9" onDraftChange={vi.fn()} />,
    );
    fireEvent.change(textarea(), { target: { value: 'draft B typed after New chat' } });
    expect(getDraft(NEW_CONVERSATION_RESERVED_KEY)).toBe('draft B typed after New chat');
    // Re-select conv-9 with the STALE adoption signal: the adoption was
    // consumed, so B stays under the sentinel.
    view.rerender(
      <ChatInput onSend={onSend} isLoading={false} onCancel={vi.fn()} draftKey="conv-9" adoptedDraftKey="conv-9" onDraftChange={vi.fn()} />,
    );
    expect(textarea().value).toBe('draft A for the first turn');
    expect(getDraft('conv-9')).toBe('draft A for the first turn');
    expect(getDraft(NEW_CONVERSATION_RESERVED_KEY)).toBe('draft B typed after New chat');
    clearDraft('conv-9');
    clearDraft(NEW_CONVERSATION_RESERVED_KEY);
  });

  it('no draftKey: no store interaction at all (the legacy mount)', async () => {
    // TST-11: strengthen beyond the store's observable state — spy the store
    // module's setDraft export (Vitest keeps named imports live, so ChatInput's
    // writes go through the spy) and assert typing on an unkeyed mount NEVER
    // writes the store.
    const store = await import('../lib/chat/draft-store');
    const setDraftSpy = vi.spyOn(store, 'setDraft');
    try {
      const { textarea } = setup(undefined);
      fireEvent.change(textarea(), { target: { value: 'unkeyed' } });
      expect(textarea().value).toBe('unkeyed');
      expect(getDraft('undefined')).toBeUndefined();
      expect(setDraftSpy).not.toHaveBeenCalled();
    } finally {
      setDraftSpy.mockRestore();
    }
  });
});
