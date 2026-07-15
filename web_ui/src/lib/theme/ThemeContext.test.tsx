/**
 * ThemeContext tests — issue #24 F5.
 *
 * Covers the new `setTheme(mode)` API and the 'system' mode behavior:
 * - setTheme('light'/'dark') persists an explicit preference and applies it.
 * - setTheme('system') CLEARS the stored preference so the media-query
 *   listener follows OS changes (the bug: toggleTheme re-wrote the key).
 * - The media-query listener updates theme when no explicit preference is
 *   stored, and does NOT override an explicit preference.
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ThemeProvider, useTheme } from './ThemeContext';

// A consumer that exposes the context value via a test handle.
let contextValue: ReturnType<typeof useTheme> | null = null;
function ContextProbe(): React.ReactElement {
  contextValue = useTheme();
  return <div data-testid="probe">{contextValue.theme}</div>;
}

function renderProvider(): ReturnType<typeof render> {
  contextValue = null;
  return render(
    <ThemeProvider>
      <ContextProbe />
    </ThemeProvider>
  );
}

describe('ThemeContext — setTheme + system mode (issue #24 F5)', () => {
  let matchMediaListeners: ((e: MediaQueryListEvent) => void)[];
  let matches: boolean;

  beforeEach(() => {
    matchMediaListeners = [];
    matches = false; // OS preference = light by default
    localStorage.clear();

    // Provide a controllable matchMedia mock so tests can toggle the OS
    // preference and dispatch change events.
    window.matchMedia = ((query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_event: string, listener: EventListener) => {
        matchMediaListeners.push(listener as (e: MediaQueryListEvent) => void);
      },
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    contextValue = null;
  });

  /** Simulate the OS color scheme changing. */
  function setOsPreference(isDark: boolean) {
    matches = isDark;
    const event = { matches: isDark } as MediaQueryListEvent;
    for (const listener of matchMediaListeners) {
      listener(event);
    }
  }

  test('setTheme("dark") persists and applies dark theme', () => {
    renderProvider();
    expect(contextValue!.theme).toBe('light');
    expect(contextValue!.themePreference).toBe('system');

    act(() => {
      contextValue!.setTheme('dark');
    });

    expect(contextValue!.theme).toBe('dark');
    expect(contextValue!.themePreference).toBe('dark');
    expect(localStorage.getItem('theme-preference')).toBe('dark');
  });

  test('setTheme("light") persists and applies light theme', () => {
    // Start with OS = dark so light is a real change.
    matches = true;
    renderProvider();
    expect(contextValue!.theme).toBe('dark');

    act(() => {
      contextValue!.setTheme('light');
    });

    expect(contextValue!.theme).toBe('light');
    expect(contextValue!.themePreference).toBe('light');
    expect(localStorage.getItem('theme-preference')).toBe('light');
  });

  test('setTheme("system") clears the stored preference', () => {
    renderProvider();
    // Set an explicit preference first.
    act(() => {
      contextValue!.setTheme('dark');
    });
    expect(localStorage.getItem('theme-preference')).toBe('dark');

    // Switch to system — must REMOVE the stored key.
    act(() => {
      contextValue!.setTheme('system');
    });

    expect(localStorage.getItem('theme-preference')).toBeNull();
    expect(contextValue!.themePreference).toBe('system');
  });

  test('system mode follows OS preference changes', () => {
    renderProvider();
    // No explicit preference — should be in system mode.
    expect(contextValue!.themePreference).toBe('system');
    expect(contextValue!.theme).toBe('light'); // OS = light

    // OS switches to dark — theme should follow.
    act(() => {
      setOsPreference(true);
    });
    expect(contextValue!.theme).toBe('dark');

    // OS switches back to light.
    act(() => {
      setOsPreference(false);
    });
    expect(contextValue!.theme).toBe('light');
  });

  test('explicit preference overrides OS preference changes', () => {
    renderProvider();
    // Set explicit dark.
    act(() => {
      contextValue!.setTheme('dark');
    });
    expect(contextValue!.theme).toBe('dark');

    // OS switches to light — theme must NOT follow (explicit preference stored).
    act(() => {
      setOsPreference(false);
    });
    expect(contextValue!.theme).toBe('dark');
    expect(contextValue!.themePreference).toBe('dark');
  });

  test('initial load with no stored preference uses OS preference', () => {
    matches = true; // OS = dark
    renderProvider();
    expect(contextValue!.theme).toBe('dark');
    expect(contextValue!.themePreference).toBe('system');
  });

  test('initial load with a stored preference uses it over OS', () => {
    localStorage.setItem('theme-preference', 'light');
    matches = true; // OS = dark, but stored = light
    renderProvider();
    expect(contextValue!.theme).toBe('light');
    expect(contextValue!.themePreference).toBe('light');
  });

  test('data-theme attribute reflects the applied theme', () => {
    renderProvider();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    act(() => {
      contextValue!.setTheme('dark');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('useTheme throws when used outside ThemeProvider', () => {
    // Suppress the expected error output.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ContextProbe />)).toThrow('useTheme must be used within a ThemeProvider');
    spy.mockRestore();
  });
});
