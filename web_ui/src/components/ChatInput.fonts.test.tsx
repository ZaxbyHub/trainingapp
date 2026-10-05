/**
 * Lumen phase 7: the composer re-measures its auto-resize height once web fonts are
 * ready. Measured against the fallback font a narrow placeholder fits on one line;
 * without the re-measure the composer stays one line tall and the real font's second
 * line is clipped (visible in the chat-empty @ 500px baseline when the boot screen did
 * not preload the 400 weight).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  const fonts = new EventTarget() as EventTarget & { ready: Promise<void> };
  fonts.ready = ready;
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  return {
    fonts,
    setScrollHeight: (n: number) => {
      scrollHeight = n;
    },
    resolveFonts,
  };
}

describe('ChatInput font-ready re-measure', () => {
  it('re-measures only when document.fonts.ready resolves (not on its own)', async () => {
    const ctl = setup();
    const { rerender } = render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    expect(textarea.style.height).toBe('40px'); // measured with the fallback font
    ctl.setScrollHeight(64); // the real font wraps the placeholder to two lines
    rerender(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('40px'); // nothing else re-measures
    await act(async () => {
      ctl.resolveFonts();
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('64px'); // fonts.ready did
  });

  it('a fonts.ready that resolves after unmount is harmless (the measure is a no-op without the textarea)', async () => {
    const ctl = setup();
    const { unmount } = render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    unmount();
    ctl.setScrollHeight(64);
    await act(async () => {
      ctl.resolveFonts();
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('40px'); // the detached node was never re-measured
  });

  it('re-measures on every document.fonts loadingdone (lazily fetched subsets), and stops after unmount', async () => {
    const ctl = setup();
    const { unmount } = render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    await act(async () => {
      ctl.resolveFonts();
      await Promise.resolve();
    });
    ctl.setScrollHeight(64);
    act(() => {
      ctl.fonts.dispatchEvent(new Event('loadingdone'));
    });
    expect(textarea.style.height).toBe('64px');
    unmount();
    ctl.setScrollHeight(100);
    act(() => {
      ctl.fonts.dispatchEvent(new Event('loadingdone'));
    });
    expect(textarea.style.height).toBe('64px'); // listener removed with the component
  });

  it('re-measures once fonts are ready after a paste', async () => {
    const ctl = setup();
    render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    await act(async () => {
      ctl.resolveFonts();
      await Promise.resolve();
    });
    ctl.setScrollHeight(64);
    expect(textarea.style.height).toBe('40px');
    await act(async () => {
      fireEvent.paste(textarea);
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('64px');
  });

  it('is a no-op where document.fonts is unavailable (jsdom, older engines): nothing re-measures', async () => {
    let scrollHeight = 40;
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
    const { rerender } = render(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    expect(textarea.style.height).toBe('40px');
    scrollHeight = 64;
    rerender(<ChatInput onSend={() => {}} isLoading={false} onCancel={() => {}} />);
    await act(async () => {
      fireEvent.paste(textarea);
      await Promise.resolve();
    });
    expect(textarea.style.height).toBe('40px'); // no fonts API, so no font-driven re-measure
  });
});
