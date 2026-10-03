/**
 * useExternalConfig (review round 2): a live, STABLE view of the stored external
 * config. The snapshot must be the same object while nothing changed (otherwise
 * useSyncExternalStore re-renders forever), and must change after a save in this
 * tab or a storage event from another tab.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useExternalConfig } from './use-external-config';
import { saveExternalConfig } from './external-provider';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('useExternalConfig', () => {
  it('returns the same object across re-renders while the stored config is unchanged', () => {
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders += 1;
      return useExternalConfig();
    });
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(renders).toBe(3); // one per render call: no snapshot-driven loop
  });

  it('a save in this tab yields a new snapshot with the saved values', () => {
    const { result } = renderHook(() => useExternalConfig());
    const before = result.current;
    expect(before.enabled).toBe(false);
    act(() => {
      saveExternalConfig({ enabled: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'm1' });
    });
    expect(result.current).not.toBe(before);
    expect(result.current).toMatchObject({ enabled: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'm1' });
  });

  it('an unrelated event that changes nothing keeps the same snapshot', () => {
    const { result } = renderHook(() => useExternalConfig());
    const before = result.current;
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme-preference' }));
    });
    expect(result.current).toBe(before);
  });

  it('a storage event from another tab is picked up', () => {
    const { result } = renderHook(() => useExternalConfig());
    act(() => {
      localStorage.setItem(
        'external-provider-config',
        JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'tab2', grounded: true, rememberKey: false })
      );
      window.dispatchEvent(new StorageEvent('storage', { key: 'external-provider-config' }));
    });
    expect(result.current.model).toBe('tab2');
  });
});
