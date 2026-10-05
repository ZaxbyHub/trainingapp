/**
 * Lumen phase 7: the composer re-measures its auto-resize height once web fonts are
 * ready. Measured against the fallback font a narrow placeholder fits on one line;
 * without the re-measure the composer stays one line tall and the real font's second
 * line is clipped (visible in the chat-empty @ 500px baseline when the boot screen did
 * not preload the 400 weight).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { fonts?: unknown }).fonts;
});

function setup() {
  let scrollHeight = 40; // one line, as measured against the fallback font
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
  let resolveFonts: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveFonts = resolve;
  });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
  return {
    setScrollHeight: (n: number) => {
      scrollHeight = n;
    },
    resolveFonts,
  };
}

describe('ChatInput font-ready re-measure', () => {
  it('re-measures the textarea height when document.fonts.ready resolves', async () => {
    const ctl = setup();
    render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    expect(textarea.style.height).toBe('40px'); // measured with the fallback font
    ctl.setScrollHeight(64); // the real font wraps the placeholder to two lines
    await act(async () => {
      ctl.resolveFonts();
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('64px');
  });

  it('does not touch the textarea after unmount when fonts resolve late', async () => {
    const ctl = setup();
    const { unmount } = render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    unmount();
    ctl.setScrollHeight(64);
    await act(async () => {
      ctl.resolveFonts();
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('40px');
  });

  it('is a no-op where document.fonts is unavailable (jsdom, older engines)', () => {
    render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    expect(screen.getByLabelText('Message input')).toBeInTheDocument();
  });
});
