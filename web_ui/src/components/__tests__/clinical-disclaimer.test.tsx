// FROZEN CHECK C2 (issue #365 AC2) - token: clinical-disclaimer.
// The always-on clinical disclaimer element renders with EVERY assistant
// answer (normal, streamed, abstain, error) and on the chat welcome state;
// user/system messages carry none; the wording is the PROPOSED constant.
import React from 'react';
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageBubble } from '../ChatMessageBubble';
import { ChatMessageList } from '../ChatMessageList';
import { CLINICAL_DISCLAIMER_TEXT } from '../../lib/rag/safety-notice';
import type { ChatMessage } from '../../types/chat';

const DISCLAIMER_TESTID = 'clinical-disclaimer';

function renderBubble(message: ChatMessage): void {
  render(<ChatMessageBubble message={message} />);
}

const BASE: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  content: 'The training pack describes the standard procedure.',
  timestamp: Date.now(),
};

describe('clinical-disclaimer (issue #365 AC2)', () => {
  test('renders the PROPOSED wording under a normal assistant answer (clinical-disclaimer)', () => {
    renderBubble(BASE);
    const el = screen.getByTestId(DISCLAIMER_TESTID);
    expect(el).toBeInTheDocument();
    expect(el.textContent).toBe(CLINICAL_DISCLAIMER_TEXT);
    expect(screen.getByText(/The training pack describes/)).toBeInTheDocument();
  });

  test('renders with a STREAMING assistant message (clinical-disclaimer)', () => {
    renderBubble({ ...BASE, content: 'partial answer…', isStreaming: true });
    expect(screen.getByTestId(DISCLAIMER_TESTID)).toBeInTheDocument();
  });

  test('renders with an ABSTAIN assistant message (clinical-disclaimer)', () => {
    renderBubble({ ...BASE, content: '', abstain: true, abstainReason: 'insufficient_evidence' });
    expect(screen.getByTestId(DISCLAIMER_TESTID)).toBeInTheDocument();
  });

  test('renders with an ERRORED assistant message (clinical-disclaimer)', () => {
    renderBubble({ ...BASE, content: '', error: 'generation failed' });
    expect(screen.getByTestId(DISCLAIMER_TESTID)).toBeInTheDocument();
  });

  test('renders with a SAFETY-ROUTED refusal (clinical-disclaimer)', () => {
    renderBubble({
      ...BASE,
      content: 'This training assistant does not provide individual clinical advice.',
      safety: { category: 'clinical', matchedRules: ['dosing-personal-take'] },
      grounding: 'general',
    });
    expect(screen.getByTestId(DISCLAIMER_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId('safety-notice')).toBeInTheDocument();
    expect(screen.queryByText('General knowledge')).not.toBeInTheDocument();
  });

  test('renders on NO user or system message (clinical-disclaimer)', () => {
    const { unmount } = render(
      <React.Fragment>
        <ChatMessageBubble message={{ id: 'u1', role: 'user', content: 'question?', timestamp: Date.now() }} />
      </React.Fragment>,
    );
    expect(screen.queryByTestId(DISCLAIMER_TESTID)).not.toBeInTheDocument();
    unmount();
    render(<ChatMessageBubble message={{ id: 's1', role: 'system', content: 'sys', timestamp: Date.now() }} />);
    expect(screen.queryByTestId(DISCLAIMER_TESTID)).not.toBeInTheDocument();
  });

  test('renders on the chat welcome state (empty thread) (clinical-disclaimer)', () => {
    render(
      <ChatMessageList
        messages={[]}
        isStreaming={false}
      />,
    );
    expect(screen.getByTestId(DISCLAIMER_TESTID)).toBeInTheDocument();
  });
});
