/**
 * universal-provider-settings-overhaul (AC10/AC11/AC12): the Settings
 * "External model" region.
 *   - browser app: config persists in this browser, the key follows the
 *     Remember rule, Test connection probes the endpoint directly;
 *   - desktop app: every change is a PUT /settings external.* patch, the key
 *     is write-only (never kept in the renderer), and Test connection uses
 *     POST /settings/external/test — NEVER probeExternalEndpoint;
 *   - an airgap build refuses a public URL with role=alert and no request;
 *   - the model-connection id lives on this region (overlay destination).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const probeSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/llm/external-provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/llm/external-provider')>();
  return {
    ...real,
    probeExternalEndpoint: (...args: Parameters<typeof real.probeExternalEndpoint>) => {
      probeSpy.calls += 1;
      return real.probeExternalEndpoint(...args);
    },
  };
});

import { ExternalModelSection } from './ExternalModelSection';
import { DesktopSessionProvider, type DesktopSession } from '../lib/desktop-session';
import { DESKTOP_MODELS_CHANGED_EVENT } from '../lib/desktop-models-events';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../test/desktop-bridge-stub';
import type { ApiClient } from '../lib/api';

const KEY = 'sk-panel-SENTINEL-2468';

function panel(): HTMLElement {
  return screen.getByRole('region', { name: /external model/i });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  probeSpy.calls = 0;
});
afterEach(() => {
  cleanup();
  removeDesktopBridgeStub();
  vi.unstubAllGlobals();
});

describe('browser app', () => {
  test('the region carries the overlay destination id and the seven controls', () => {
    render(<ExternalModelSection id="model-connection" />);
    expect(panel().id).toBe('model-connection');
    const q = within(panel());
    expect(q.getByRole('combobox', { name: /^protocol$/i })).toBeInTheDocument();
    expect(q.getByLabelText(/^base url$/i)).toBeInTheDocument();
    expect(q.getByLabelText(/^api key$/i)).toHaveAttribute('type', 'password');
    expect(q.getByLabelText(/^model$/i)).toBeInTheDocument();
    expect(q.getByRole('button', { name: /^test connection$/i })).toBeInTheDocument();
    expect(q.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
    expect(q.getByRole('checkbox', { name: /^direct chat/i })).not.toBeChecked();
    expect(q.getByText(/stored in this browser/i)).toBeInTheDocument();
  });

  test('Test connection probes the endpoint directly and fills the model list', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'llama-3' }, { id: 'qwen' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://localhost:1234' } });
    fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'qwen' } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    expect(await q.findByRole('status')).toHaveTextContent(/qwen is available/i);
    expect(probeSpy.calls).toBe(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe('http://localhost:1234/v1/models');
    const options = [...panel().querySelectorAll('datalist option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['llama-3', 'qwen']);
  });

  test('a policy-refused URL is an alert and is not saved', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    const base = q.getByLabelText(/^base url$/i);
    fireEvent.change(base, { target: { value: 'http://169.254.169.254' } });
    fireEvent.blur(base);
    expect(await q.findByRole('alert')).toHaveTextContent(/metadata/);
    expect(localStorage.getItem('external-provider-config')).toBeNull();
  });

  test('turning the external model on needs a base URL and a model', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.click(q.getByRole('switch', { name: /^use external model$/i }));
    expect(await q.findByRole('alert')).toHaveTextContent(/base URL and choose a model/i);
    expect(q.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
  });

  test('the key is session-only unless Remember is checked', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i);
    fireEvent.change(key, { target: { value: KEY } });
    fireEvent.blur(key);
    await waitFor(() => expect(sessionStorage.getItem('external-provider-apikey')).toBe(KEY));
    expect(localStorage.getItem('external-provider-apikey')).toBeNull();
    fireEvent.click(q.getByRole('checkbox', { name: /remember api key/i }));
    await waitFor(() => expect(localStorage.getItem('external-provider-apikey')).toBe(KEY));
    expect(sessionStorage.getItem('external-provider-apikey')).toBeNull();
  });
});

describe('desktop app', () => {
  function session(settings: Record<string, unknown> = {}) {
    const updateSettings = vi.fn(async (patch: Record<string, unknown>) => ({ ...settings, ...patch }) as never);
    const testExternalEndpoint = vi.fn(async (_req: Record<string, unknown>) => ({ ok: true, message: 'Connected: m1 is available.', models: ['m1'] }));
    const apiClient = {
      getSettings: vi.fn(async () => settings as never),
      updateSettings,
      testExternalEndpoint,
    } as unknown as ApiClient;
    const s: DesktopSession = {
      baseUrl: 'http://127.0.0.1:4567',
      token: 't',
      mode: 'node',
      apiClient,
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    };
    return { s, updateSettings, testExternalEndpoint };
  }
  const renderDesktop = (s: DesktopSession) =>
    render(
      <DesktopSessionProvider value={{ session: s, models: null, loading: false, error: null }}>
        <ExternalModelSection />
      </DesktopSessionProvider>,
    );

  test('Test connection uses the backend probe route, never the browser probe', async () => {
    installDesktopBridgeStub();
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const { s, testExternalEndpoint } = session();
    renderDesktop(s);
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://192.168.1.20:8000' } });
    fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'm1' } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    expect(await q.findByRole('status')).toHaveTextContent(/m1 is available/);
    expect(testExternalEndpoint).toHaveBeenCalledWith({ protocol: 'openai', baseUrl: 'http://192.168.1.20:8000', model: 'm1' });
    expect(probeSpy.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the key is write-only: PUT once, cleared from the field, never stored in the renderer', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.20:8000' });
    renderDesktop(s);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    fireEvent.change(key, { target: { value: KEY } });
    fireEvent.blur(key);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ 'external.apiKey': KEY }));
    await waitFor(() => expect(key.value).toBe(''));
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain(KEY);
  });

  test('enabling PUTs the connection and announces the engine change', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session();
    const announced = vi.fn();
    window.addEventListener(DESKTOP_MODELS_CHANGED_EVENT, announced);
    renderDesktop(s);
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'https://api.openai.com' } });
    fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'gpt-x' } });
    fireEvent.click(q.getByRole('switch', { name: /^use external model$/i }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        'external.enabled': true,
        'external.protocol': 'openai',
        'external.baseUrl': 'https://api.openai.com',
        'external.model': 'gpt-x',
      }),
    );
    await waitFor(() => expect(announced).toHaveBeenCalled());
    window.removeEventListener(DESKTOP_MODELS_CHANGED_EVENT, announced);
  });

  test('an air-gapped desktop build refuses a public URL with an alert and no backend call', async () => {
    installDesktopBridgeStub();
    const { s, testExternalEndpoint } = session({ 'external.airgap': true });
    renderDesktop(s);
    const q = within(panel());
    await q.findByTestId('external-airgap-notice');
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'https://api.anthropic.com' } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    expect(await q.findByRole('alert')).toHaveTextContent(/air-?gap/i);
    expect(testExternalEndpoint).not.toHaveBeenCalled();
  });

  test('a key bound to another origin is announced, not silently reused', async () => {
    installDesktopBridgeStub();
    const { s } = session({
      'external.baseUrl': 'http://192.168.1.21:8000',
      'external.apiKeySet': false,
      'external.apiKeyBoundOrigin': 'https://api.openai.com',
    });
    renderDesktop(s);
    expect(await within(panel()).findByText(/belongs to https:\/\/api\.openai\.com/)).toBeInTheDocument();
  });
});
