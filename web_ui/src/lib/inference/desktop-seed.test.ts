/**
 * Persistence guardrails for the desktop inference-mode seeding (trace
 * external-llm-provider-settings, AC1's "persisted across restarts" clause):
 * a saved 'provider' mode must survive the desktop re-seed, while every other
 * persisted mode keeps the B9 boot-into-backend behavior.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { seedInferenceModeForDesktop } from './desktop-seed';

const KEY = 'inference-mode';

describe('seedInferenceModeForDesktop', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('a persisted provider mode survives the re-seed (providerConfig intact)', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        mode: 'provider',
        serverUrl: 'http://127.0.0.1:1',
        browserEngine: 'wllama',
        ragPreset: 'quality',
        providerConfig: { baseUrl: 'http://127.0.0.1:8080', model: 'local-model' },
      })
    );
    seedInferenceModeForDesktop('http://127.0.0.1:54321');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.mode).toBe('provider');
    // The loopback URL still rotates (it belongs to api mode).
    expect(stored.serverUrl).toBe('http://127.0.0.1:54321');
    expect(stored.providerConfig).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      model: 'local-model',
    });
  });

  test('other persisted modes still boot into the desktop backend (B9 behavior)', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ mode: 'browser-local', serverUrl: 'http://127.0.0.1:1' })
    );
    seedInferenceModeForDesktop('http://127.0.0.1:54321');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.mode).toBe('api');
    expect(stored.serverUrl).toBe('http://127.0.0.1:54321');
  });

  test('an empty store boots into the desktop backend', () => {
    seedInferenceModeForDesktop('http://127.0.0.1:54321');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.mode).toBe('api');
  });

  test('provider mode with missing providerConfig still survives (send surfaces a clear error)', () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'provider' }));
    seedInferenceModeForDesktop('http://127.0.0.1:54321');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.mode).toBe('provider');
  });
});
