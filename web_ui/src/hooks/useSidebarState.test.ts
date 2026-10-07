/**
 * useSidebarState: the persisted sidebar-open state (critic-final-2 D1).
 *
 * Web storage can throw on access (a SecurityError where the browser blocks storage). The state
 * is a convenience, so a throwing read falls back to the width default and a throwing write is
 * ignored; neither may crash the shell into the App-level ErrorBoundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSidebarState } from './useSidebarState';
import { SIDEBAR_OPEN_KEY } from '../lib/storage/persisted-keys';

const originalWidth = window.innerWidth;
const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const blocked = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  setWidth(originalWidth);
  localStorage.clear();
});

describe('useSidebarState', () => {
  it('reads a persisted value and writes changes back', () => {
    setWidth(1440);
    localStorage.setItem(SIDEBAR_OPEN_KEY, 'false');
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    expect(localStorage.getItem(SIDEBAR_OPEN_KEY)).toBe('true');
  });

  it.each([
    [1440, true],
    [800, false],
  ])('a throwing storage read falls back to the width default (innerWidth %i -> open %s)', (width, expected) => {
    setWidth(width);
    // A persisted value that the default would contradict: it must not be what decides.
    localStorage.setItem(SIDEBAR_OPEN_KEY, String(!expected));
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    const { result } = renderHook(() => useSidebarState());
    expect(getItem).toHaveBeenCalledWith(SIDEBAR_OPEN_KEY);
    expect(result.current.isOpen).toBe(expected);
  });

  it('a throwing storage write is ignored: mount and toggle still work', () => {
    setWidth(1440);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.isOpen).toBe(true);
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_OPEN_KEY, 'true');
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);
    expect(setItem).toHaveBeenLastCalledWith(SIDEBAR_OPEN_KEY, 'false');
    act(() => result.current.setOpen(true));
    expect(result.current.isOpen).toBe(true);
  });
});
