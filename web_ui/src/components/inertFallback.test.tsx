/**
 * PR #151 review PRR-151-018: the chat gates' `inert` boundary must hold in an
 * engine without native `inert` (jsdom is one, so this exercises the fallback for
 * real), and the fallback must stay out of the way where `inert` is native.
 */
import React, { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { supportsNativeInert, useInertFallback } from './inertFallback';

function Harness({ active, extra = false }: { active: boolean; extra?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useInertFallback(ref, active);
  return (
    <>
      <button type="button">Before</button>
      <div ref={ref} className="covered">
        <section aria-hidden="false" data-testid="section">
          <button type="button">Plain</button>
          <button type="button" tabIndex={0}>
            Zero
          </button>
          <span tabIndex={-1} data-testid="minus-one">
            Programmatic only
          </span>
          <textarea aria-label="Composer" />
          {extra && <button type="button">Late</button>}
        </section>
        <p data-testid="para">Text</p>
      </div>
      <button type="button">After</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { inert?: boolean }).inert;
});

describe('useInertFallback (PRR-151-018)', () => {
  it('jsdom has no native inert, so these tests run the fallback for real', () => {
    expect(supportsNativeInert()).toBe(false);
  });

  it('while active: covered focusables leave the Tab order and the covered subtree leaves the a11y tree', async () => {
    const user = userEvent.setup();
    render(<Harness active />);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    // aria-hidden on each wrapper CHILD (not the display:contents wrapper itself).
    expect(screen.getByTestId('section')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('para')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('.covered')).not.toHaveAttribute('aria-hidden');
    expect(screen.queryByRole('button', { name: 'Plain' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Composer' })).toBeNull();
  });

  it('on release every original attribute is restored EXACTLY (absent, "0", "-1", aria-hidden="false")', () => {
    const { rerender } = render(<Harness active />);
    rerender(<Harness active={false} />);
    const plain = screen.getByRole('button', { name: 'Plain' });
    expect(plain).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('button', { name: 'Zero' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('minus-one')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('textbox', { name: 'Composer' })).not.toHaveAttribute('tabindex');
    expect(screen.getByTestId('section')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('para')).not.toHaveAttribute('aria-hidden');
    expect(document.querySelectorAll('[data-inert-fallback-tabindex], [data-inert-fallback-aria-hidden]')).toHaveLength(0);
  });

  it('a focusable mounted while the gate is up is covered too', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness active />);
    rerender(<Harness active extra />);
    // MutationObserver callbacks are microtasks.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Late', hidden: true })).toHaveAttribute('tabindex', '-1');
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('is a no-op where inert is native (the attribute already does the work)', () => {
    Object.defineProperty(HTMLElement.prototype, 'inert', { configurable: true, value: false, writable: true });
    expect(supportsNativeInert()).toBe(true);
    render(<Harness active />);
    expect(screen.getByRole('button', { name: 'Plain' })).not.toHaveAttribute('tabindex');
    expect(screen.getByTestId('section')).toHaveAttribute('aria-hidden', 'false');
    expect(document.querySelectorAll('[data-inert-fallback-tabindex]')).toHaveLength(0);
  });
});
