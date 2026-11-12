/**
 * #267 (AC8, frozen check C24): per-conversation drafts in the composer —
 * a draftKey switch saves the outgoing draft, shows the stored draft, and
 * reports it through onDraftChange; a remount restores; a send clears;
 * and the sentinel migration (moveDraftIfTargetEmpty — the helper ChatPage
 * owns as the single migration owner) carries the '\u0000new' draft to the
 * adopted conversation id BEFORE hydration would read the store.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChatInput } from './ChatInput';
import { clearDraft, getDraft, moveDraftIfTargetEmpty, setDraft } from '../lib/chat/draft-store';

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

  it('the sentinel migration carries the new-chat draft to the adopted id (single owner: moveDraftIfTargetEmpty)', () => {
    // The user typed under the new-conversation sentinel, then the first turn
    // adopted a real conversation id.
    setDraft(NEW_CONVERSATION_RESERVED_KEY, 'carried to the adopted id');
    expect(moveDraftIfTargetEmpty(NEW_CONVERSATION_RESERVED_KEY, 'conv-9')).toBe(true);
    expect(getDraft('conv-9')).toBe('carried to the adopted id');
    expect(getDraft(NEW_CONVERSATION_RESERVED_KEY)).toBeUndefined();
    // Hydration afterwards (what ChatInput's draftKey effect does) shows it.
    const { textarea } = setup('conv-9');
    expect(textarea().value).toBe('carried to the adopted id');
    clearDraft('conv-9');
  });

  it('no draftKey: no store interaction at all (the legacy mount)', () => {
    const { textarea } = setup(undefined);
    fireEvent.change(textarea(), { target: { value: 'unkeyed' } });
    expect(textarea().value).toBe('unkeyed');
    expect(getDraft('undefined')).toBeUndefined();
  });
});
