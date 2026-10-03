import React, { createContext, useContext, useEffect, useState } from 'react';
import { THEME_PREFERENCE_KEY } from '../storage/persisted-keys';

export type ThemeMode = 'light' | 'dark';

/**
 * The user's theme preference. `'system'` means "follow the OS preference" —
 * no explicit value is persisted, so the media-query listener can react to
 * OS-level changes. `'light'`/`'dark'` are explicit persisted preferences.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** The currently-applied theme (always a concrete 'light' or 'dark'). */
  theme: ThemeMode;
  /** The user's preference: an explicit 'light'/'dark', or 'system' (follow OS). */
  themePreference: ThemePreference;
  /** Set an explicit theme preference. 'system' clears the stored preference. */
  setTheme: (mode: ThemePreference) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getSystemPreference(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(THEME_PREFERENCE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable (Safari private mode, restricted iframe, quota exceeded)
  }
  return null;
}

/**
 * index.html declares one <meta name="theme-color"> per OS color scheme. When
 * the in-app theme overrides the OS preference, the OS-matched meta would tint
 * the browser chrome with the wrong theme, so every theme-color meta is set to
 * the applied theme's --bg-surface (read from CSS, so the value stays a Lumen
 * token rather than a literal here). When the token does not resolve to a
 * color (no stylesheet, or jsdom), the metas are left alone.
 */
export function syncThemeColorMeta(): void {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return;
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim();
  // Browsers substitute var() in a custom property's computed value; an
  // unresolved reference (jsdom) is not a usable color.
  if (surface === '' || surface.includes('var(')) return;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', surface);
  });
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // NOTE: the internal state setter is named `setThemeState` (not `setTheme`)
  // so the context-value function `setTheme` (below) does not shadow it.
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = getStoredPreference();
    return stored ?? getSystemPreference();
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    syncThemeColorMeta();
  }, [theme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Only follow OS changes when NO explicit preference is stored — an
      // explicit 'light'/'dark' must override the OS setting. 'system' mode
      // keeps localStorage empty so this listener stays active.
      const stored = getStoredPreference();
      if (stored === null) {
        setThemeState(e.matches ? 'dark' : 'light');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Derive the user's preference from the persisted value: an explicit
  // 'light'/'dark' if stored, otherwise 'system'. Read fresh each render —
  // cheap (one localStorage getItem), and keeps the context value in sync
  // immediately after setTheme writes/removes the key.
  const themePreference: ThemePreference = getStoredPreference() ?? 'system';

  const setTheme = (mode: ThemePreference) => {
    if (mode === 'system') {
      // Clear the explicit preference so the media-query listener takes over
      // and the app follows future OS-preference changes. Do NOT persist —
      // a stored value here would defeat the entire point of 'system'.
      try {
        localStorage.removeItem(THEME_PREFERENCE_KEY);
      } catch {
        // localStorage unavailable; theme still updates in memory
      }
      setThemeState(getSystemPreference());
    } else {
      // Explicit preference: persist and apply.
      try {
        localStorage.setItem(THEME_PREFERENCE_KEY, mode);
      } catch {
        // localStorage unavailable; theme still updates in memory
      }
      setThemeState(mode);
    }
  };

  const value: ThemeContextValue = {
    theme,
    themePreference,
    setTheme,
    isDark: theme === 'dark',
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
