/**
 * Frozen acceptance checks (trace 35-residuals-chat-ux) for ZaxbyHub/
 * trainingapp#35 residual C4 — copy affordance payloads on chat messages.
 *
 * Checks authored at arm's length against the AC behavior contracts:
 *
 * - C1 / AC1 (DISCRIMINATING): activating the Copy action on a settled
 *   assistant message writes a PLAIN-TEXT rendition of the message to the
 *   clipboard. The rendition is pinned exactly for a fixture that contains
 *   heading, emphasis, inline-code, link, fenced-code, table, and list
 *   shapes, and it carries none of that fixture's markdown syntax.
 *
 * - C2 / AC2 (DISCRIMINATING): a copy-source action reachable on the same
 *   assistant message writes the raw markdown source byte-identical to
 *   `message.content`. The source action must be DISTINCT from the default
 *   Copy affordance, and the default Copy must NOT itself write the raw
 *   markdown source (otherwise AC1 would be unfalsifiable). The check is
 *   written implementation-agnostically: it enumerates every button rendered
 *   on the message and asks (a) does the default Copy (/copy message/i)
 *   write anything other than the raw source, and (b) does SOME OTHER button
 *   write the raw source. At base the only raw writer IS the default Copy, so
 *   both (a) and (b) fail.
 *
 * - C3 / AC3 (PRESERVING): user-message Copy still writes `message.content`
 *   exactly; CodeBlock copy still writes the extracted code text without the
 *   fences; a settled empty assistant message still renders no copy button.
 *
 * Pinned plain-text rendition rules for the fixture below (this IS the
 * contract the implementation must satisfy):
 *   - a heading contributes its text without the `#` marker;
 *   - emphasis/strong/inline code contribute their inner text;
 *   - a link contributes its anchor text only;
 *   - a fenced code block contributes its code lines verbatim, without the
 *     fences and without the language tag;
 *   - a table contributes one line per row with the cell texts joined by a
 *     single space (no pipes, no separator row);
 *   - list items contribute their text, one per line, without the `- `
 *     marker;
 *   - blocks are separated by a single blank line.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageBubble } from './ChatMessageBubble';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { ChatMessage } from '../types/chat';

// Clipboard mock (mirrors ChatMessageBubble.test.tsx).
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
  configurable: true,
});

/** Pinned markdown fixture: heading + emphasis + inline code + link +
 *  fenced code + table + list (the shapes AC1 names). */
const MARKDOWN_FIXTURE = [
  '# Release Notes',
  '',
  'Some **bold** and *italic* emphasis with `inline code`.',
  '',
  'See the [docs site](https://example.com/docs) for details.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| Column | Value |',
  '| ------ | ----- |',
  '| alpha  | one   |',
  '| beta   | two   |',
  '',
  '- first item',
  '- second item',
].join('\n');

/** The exact plain-text rendition of MARKDOWN_FIXTURE (see the rules in the
 *  file header). None of the fixture's markdown syntax survives. */
const PLAIN_TEXT_RENDITION = [
  'Release Notes',
  '',
  'Some bold and italic emphasis with inline code.',
  '',
  'See the docs site for details.',
  '',
  'const answer = 42;',
  '',
  'Column Value',
  'alpha one',
  'beta two',
  '',
  'first item',
  'second item',
].join('\n');

/** Fixture for the CodeBlock leg of C3. */
const CODE_BLOCK_FIXTURE = 'Intro line:\n\n```ts\nconst x = 1;\nconst y = 2;\n```';

const assistantFixture = (): ChatMessage => ({
  id: 'a-md-fixture',
  role: 'assistant',
  content: MARKDOWN_FIXTURE,
  timestamp: Date.now(),
});

describe('#35 C4 copy affordances (frozen acceptance)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('c1-plaintext-copy: default Copy on a settled assistant message writes the pinned plain-text rendition, not markdown', async () => {
    render(<ChatMessageBubble message={assistantFixture()} />);

    fireEvent.click(screen.getByRole('button', { name: /copy message/i }));

    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);
    });
    const payload = mockClipboard.writeText.mock.calls[0]?.[0] ?? '';

    // Guard first so a base failure reads "payload still carries markdown
    // syntax" rather than a wall-of-diff.
    expect(
      payload,
      'clipboard payload still carries markdown syntax (bold/inline-code markers, link syntax, table pipes, heading markers, list markers, or code fences)'
    ).not.toMatch(/\*\*|`|\]\(|\||^#{1,6}\s/m);
    expect(
      payload,
      'default Copy must write the exact pinned plain-text rendition of the fixture'
    ).toBe(PLAIN_TEXT_RENDITION);
  });

  it('c2-source-copy: a copy-source action DISTINCT from the default Copy writes the raw markdown source byte-identical to message.content', async () => {
    const message = assistantFixture();

    // Discover every button rendered on the message, with its initial
    // accessible name (labels may change after activation, e.g. "Copied!").
    const discovery = render(<ChatMessageBubble message={message} />);
    const initialNames = Array.from(discovery.container.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? b.textContent ?? ''
    );
    discovery.unmount();
    expect(initialNames.length).toBeGreaterThan(0);

    const isDefaultCopy = (name: string) => /copy message/i.test(name);
    expect(
      initialNames.some((n) => isDefaultCopy(n)),
      'the default Copy affordance must remain reachable'
    ).toBe(true);

    // Activate each discovered button on a fresh render and record whether it
    // writes the raw markdown source (=== message.content).
    const rounds: Array<{ name: string; wroteRaw: boolean }> = [];
    for (let i = 0; i < initialNames.length; i += 1) {
      mockClipboard.writeText.mockClear();
      const page = render(<ChatMessageBubble message={message} />);
      const buttons = page.container.querySelectorAll('button');
      expect(buttons.length).toBe(initialNames.length);
      fireEvent.click(buttons[i]);
      await act(async () => {
        // flush the async clipboard handler's microtasks
      });
      const wroteRaw = mockClipboard.writeText.mock.calls.some((c) => c[0] === MARKDOWN_FIXTURE);
      rounds.push({ name: initialNames[i], wroteRaw });
      page.unmount();
    }

    const defaultRounds = rounds.filter((r) => isDefaultCopy(r.name));
    expect(defaultRounds.length, 'exactly one default Copy affordance is expected').toBe(1);
    expect(
      defaultRounds[0].wroteRaw,
      'the default Copy must write the plain-text rendition, NOT the raw markdown source (see c1-plaintext-copy)'
    ).toBe(false);
    expect(
      rounds.some((r) => !isDefaultCopy(r.name) && r.wroteRaw),
      'no copy-source action distinct from the default Copy writes the raw markdown source byte-identical to message.content'
    ).toBe(true);
  });

  it('c3-preserving-copy: user Copy exact, CodeBlock copy without fences, empty assistant message has no Copy', async () => {
    // Leg 1 — user-message Copy still writes message.content exactly.
    const user: ChatMessage = {
      id: 'u-plain',
      role: 'user',
      content: 'Plain user text - copy me exactly.',
      timestamp: Date.now(),
    };
    render(<ChatMessageBubble message={user} />);
    fireEvent.click(screen.getByRole('button', { name: /copy message/i }));
    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);
    });
    expect(mockClipboard.writeText).toHaveBeenCalledWith('Plain user text - copy me exactly.');
    cleanup();

    // Leg 2 — CodeBlock copy writes the extracted code text, no fences.
    mockClipboard.writeText.mockClear();
    render(<MarkdownRenderer content={CODE_BLOCK_FIXTURE} />);
    fireEvent.click(screen.getByRole('button', { name: /copy code to clipboard/i }));
    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);
    });
    expect(mockClipboard.writeText).toHaveBeenCalledWith('const x = 1;\nconst y = 2;');
    cleanup();

    // Leg 3 — a settled empty assistant message renders no copy affordance.
    const empty: ChatMessage = { id: 'a-empty', role: 'assistant', content: '', timestamp: Date.now() };
    render(<ChatMessageBubble message={empty} />);
    expect(screen.queryByRole('button', { name: /copy message/i })).toBeNull();
  });
});
