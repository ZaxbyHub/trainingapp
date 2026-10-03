/**
 * universal-provider-settings-overhaul (AC10/AC11/AC12): the Settings
 * "Model & connection" region (Lumen phase 4, design-language.md section 5): the
 * generator source (Built-in model / Local or network server / Cloud provider)
 * and, for a server source, the connection form.
 *   - browser app: config persists in this browser, the key follows the
 *     Remember rule, Test connection probes the endpoint directly;
 *   - desktop app: every change is a PUT /settings external.* patch, the key
 *     is write-only (never kept in the renderer), and Test connection uses
 *     POST /settings/external/test — NEVER probeExternalEndpoint;
 *   - an airgap build refuses a public URL with a message in the assertive live
 *     region (aria-live, no role=alert: that would announce twice) and no request;
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
import { ApiError } from '../lib/api/types';

const KEY = 'sk-panel-SENTINEL-2468';

/**
 * The Model & connection region. The connection form shows only for a server
 * generator source, so when it is collapsed (Built-in model) this chooses "Local or
 * network server" first, as a user would. Choosing a source never saves anything
 * (egress still needs "Use external model"); the source tests below pin that.
 */
function panel(): HTMLElement {
  const region = screen.getByRole('region', { name: /^model & connection$/i });
  if (within(region).queryByLabelText(/^base url$/i) === null) {
    fireEvent.click(within(region).getByRole('radio', { name: /^local or network server$/i }));
  }
  return region;
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
    // "Use my documents (grounded)": on by default (Direct chat off).
    expect(q.getByRole('switch', { name: /^use my documents \(grounded\)$/i })).toBeChecked();
    expect(q.getByRole('button', { name: /^show api key$/i })).toHaveAttribute('aria-pressed', 'false');
    // M4: the browser note says plainly how the key is stored (Remember off by default).
    expect(q.getByText(/kept for this browser session only, unencrypted: any script running on this site can read it/i)).toBeInTheDocument();
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
    await waitFor(() => expect(q.getByTestId('external-status')).toHaveTextContent(/qwen is available/i));
    expect(probeSpy.calls).toBe(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe('http://localhost:1234/v1/models');
    // The model Combobox offers the endpoint's list (ARIA 1.2 listbox popup).
    const model = q.getByRole('combobox', { name: /^model$/i });
    fireEvent.keyDown(model, { key: 'ArrowDown' });
    const list = q.getByRole('listbox');
    expect(model).toHaveAttribute('aria-controls', list.id);
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['llama-3', 'qwen']);
  });

  test('a policy-refused URL is an alert and is not saved', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    const base = q.getByLabelText(/^base url$/i);
    fireEvent.change(base, { target: { value: 'http://169.254.169.254' } });
    fireEvent.blur(base);
    await waitFor(() => expect(q.getByTestId('external-problem')).toHaveTextContent(/metadata/));
    expect(localStorage.getItem('external-provider-config')).toBeNull();
  });

  test('turning the external model on needs a base URL and a model', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.click(q.getByRole('switch', { name: /^use external model$/i }));
    await waitFor(() => expect(q.getByTestId('external-problem')).toHaveTextContent(/base URL and choose a model/i));
    expect(q.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
  });

  test('the key is session-only unless Remember is checked', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    // (review round 2: a key is saved only together with a valid base URL)
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://localhost:1234' } });
    fireEvent.blur(q.getByLabelText(/^base url$/i));
    const key = q.getByLabelText(/^api key$/i);
    fireEvent.change(key, { target: { value: KEY } });
    fireEvent.blur(key);
    await waitFor(() => expect(sessionStorage.getItem('external-provider-apikey')).toBe(KEY));
    expect(localStorage.getItem('external-provider-apikey')).toBeNull();
    fireEvent.click(q.getByRole('checkbox', { name: /remember api key/i }));
    await waitFor(() => expect(localStorage.getItem('external-provider-apikey')).toBe(KEY));
    expect(sessionStorage.getItem('external-provider-apikey')).toBeNull();
  });

  // Review round 1 (F4): inline validation of a key that cannot travel in an
  // HTTP header; it is never saved and never echoed.
  test('a key with a header-invalid character is refused inline and never stored', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://localhost:1234' } });
    fireEvent.blur(q.getByLabelText(/^base url$/i));
    const key = q.getByLabelText(/^api key$/i);
    fireEvent.change(key, { target: { value: 'sk-INLINE-☃-SENTINEL' } });
    fireEvent.blur(key);
    const alert = q.getByTestId('external-problem');
    await waitFor(() => expect(alert).not.toBeEmptyDOMElement());
    expect(alert).toHaveTextContent(/cannot be sent in an HTTP header/);
    expect(alert.textContent).not.toContain('SENTINEL');
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain('SENTINEL');
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(q.getByTestId('external-problem')).toHaveTextContent(/cannot be sent in an HTTP header/));
    expect(fetchSpy).not.toHaveBeenCalled();
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

  // Review M3: the desktop key note follows apiKeyPersisted and never contradicts itself.
  test('M3: a saved key in OS secure storage is described as such (and never as session-only)', async () => {
    installDesktopBridgeStub();
    const { s } = session({ 'external.baseUrl': 'http://192.168.1.20:8000', 'external.apiKeySet': true, 'external.apiKeyPersisted': true });
    renderDesktop(s);
    const q = within(panel());
    await waitFor(() => expect(q.getByText(/a key is saved using your operating system's secure storage/i)).toBeInTheDocument());
    expect(q.queryByText(/session only/i)).toBeNull();
  });

  test('M3: a key kept in memory is described as session-only without inventing a cause (and never as stored securely)', async () => {
    installDesktopBridgeStub();
    const { s } = session({ 'external.baseUrl': 'http://192.168.1.20:8000', 'external.apiKeySet': true, 'external.apiKeyPersisted': false });
    renderDesktop(s);
    const q = within(panel());
    await waitFor(() => expect(q.getByText(/set for this session only and is not saved/i)).toBeInTheDocument());
    expect(q.queryByText(/secure storage/i)).toBeNull();
    expect(q.queryByText(/encrypted/i)).toBeNull();
  });

  test('M3: with a memory-only store and no key here, a new key is announced as session-only and not saved', async () => {
    installDesktopBridgeStub();
    const { s } = session({ 'external.baseUrl': 'http://192.168.1.20:8000', 'external.apiKeySet': false, 'external.apiKeyPersisted': false });
    renderDesktop(s);
    const q = within(panel());
    await waitFor(() =>
      expect(q.getByText(/a key you enter will be kept only for this session and not saved/i)).toBeInTheDocument(),
    );
    expect(q.queryByText(/unavailable/i)).toBeNull();
  });

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
    await waitFor(() => expect(q.getByTestId('external-status')).toHaveTextContent(/m1 is available/));
    expect(testExternalEndpoint).toHaveBeenCalledWith({ protocol: 'openai', baseUrl: 'http://192.168.1.20:8000', model: 'm1' });
    expect(probeSpy.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the key is write-only: PUT once, cleared from the field, never stored in the renderer', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.20:8000' });
    renderDesktop(s);
    const q = within(panel());
    await waitFor(() => expect((q.getByLabelText(/^base url$/i) as HTMLInputElement).value).toBe('http://192.168.1.20:8000'));
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    fireEvent.change(key, { target: { value: KEY } });
    fireEvent.blur(key);
    // Review round 2 (R2-F1): the key is PUT together with the URL shown, in one patch.
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ 'external.baseUrl': 'http://192.168.1.20:8000', 'external.apiKey': KEY }),
    );
    expect(updateSettings.mock.calls.some(([body]) => 'external.apiKey' in body && !('external.baseUrl' in body))).toBe(false);
    await waitFor(() => expect(key.value).toBe(''));
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain(KEY);
  });

  // Review round 2 (R2-F1): a key typed while the shown URL is refused or
  // empty is never PUT on its own (the backend would bind it to the stored
  // URL C), never PUT with C, and never tested against C.
  for (const shown of ['http://api.openai.com/v1', ''] as const) {
    test(`a key typed while the Base URL shows ${shown === '' ? 'nothing' : 'a refused URL'} is held; other saves reset the URL to C and drop it`, async () => {
      installDesktopBridgeStub();
      const { s, updateSettings, testExternalEndpoint } = session({
        'external.baseUrl': 'http://192.168.1.50:8080',
        'external.enabled': true,
        'external.model': 'm',
      });
      renderDesktop(s);
      const q = within(panel());
      const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
      await waitFor(() => expect(base.value).toBe('http://192.168.1.50:8080'));
      fireEvent.change(base, { target: { value: shown } });
      fireEvent.blur(base);
      const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
      fireEvent.change(key, { target: { value: KEY } });
      fireEvent.blur(key);
      expect(await q.findByTestId('external-key-held')).toHaveTextContent(/saved together with the next valid base URL/);
      // Saves of other fields: the backend answer puts C back in the field,
      // so the typed key is dropped (fail closed) and the user is told.
      fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'm2' } });
      fireEvent.blur(q.getByLabelText(/^model$/i));
      await waitFor(() => expect(base.value).toBe('http://192.168.1.50:8080'));
      expect(key.value).toBe('');
      expect(await q.findByTestId('external-key-dropped')).toBeInTheDocument();
      fireEvent.change(q.getByRole('combobox', { name: /^protocol$/i }), { target: { value: 'anthropic' } });
      fireEvent.click(q.getByRole('switch', { name: /^use my documents/i }));
      await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ 'external.grounded': false }));
      // Key blur and Test against C: nothing carries the key.
      fireEvent.focus(key);
      fireEvent.blur(key);
      fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
      await waitFor(() => expect(testExternalEndpoint).toHaveBeenCalled());
      expect(updateSettings.mock.calls.some(([body]) => 'external.apiKey' in body)).toBe(false);
      for (const [req] of testExternalEndpoint.mock.calls) expect(req).not.toHaveProperty('apiKey');
    });

    test(`a held key (typed while the Base URL shows ${shown === '' ? 'nothing' : 'a refused URL'}) is PUT only together with the next valid URL`, async () => {
      installDesktopBridgeStub();
      const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.enabled': true, 'external.model': 'm' });
      renderDesktop(s);
      const q = within(panel());
      const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
      await waitFor(() => expect(base.value).toBe('http://192.168.1.50:8080'));
      fireEvent.change(base, { target: { value: shown } });
      fireEvent.blur(base);
      const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
      fireEvent.change(key, { target: { value: KEY } });
      fireEvent.blur(key);
      await q.findByTestId('external-key-held');
      expect(updateSettings).not.toHaveBeenCalled();
      fireEvent.change(base, { target: { value: 'http://192.168.1.77:8000' } });
      fireEvent.blur(base);
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ 'external.baseUrl': 'http://192.168.1.77:8000', 'external.apiKey': KEY }),
      );
      expect(updateSettings.mock.calls.filter(([body]) => 'external.apiKey' in body)).toHaveLength(1);
    });
  }

  test('a key typed before the first settings load arrives is dropped when the stored URL C fills the field', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings, testExternalEndpoint } = session({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm' });
    let release: (v: unknown) => void = () => undefined;
    const late = new Promise((resolve) => {
      release = resolve;
    });
    (s.apiClient as unknown as { getSettings: () => Promise<unknown> }).getSettings = () => late;
    renderDesktop(s);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    fireEvent.change(key, { target: { value: KEY } });
    fireEvent.blur(key);
    await q.findByTestId('external-key-held');
    release({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm' });
    await waitFor(() => expect((q.getByLabelText(/^base url$/i) as HTMLInputElement).value).toBe('http://192.168.1.50:8080'));
    expect(key.value).toBe('');
    fireEvent.focus(key);
    fireEvent.blur(key);
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(testExternalEndpoint).toHaveBeenCalled());
    expect(updateSettings.mock.calls.some(([body]) => 'external.apiKey' in body)).toBe(false);
    for (const [req] of testExternalEndpoint.mock.calls) expect(req).not.toHaveProperty('apiKey');
  });

  // Review round 3 (R3-N1): a stale settings snapshot never repaints an older
  // base URL over a newer PUT, so the next blur cannot PUT the old URL back.
  test('a settings load that resolves after a PUT does not repaint the stale URL (and nothing PUTs it back)', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm' });
    let release: (v: unknown) => void = () => undefined;
    const late = new Promise((resolve) => {
      release = resolve;
    });
    (s.apiClient as unknown as { getSettings: () => Promise<unknown> }).getSettings = () => late;
    renderDesktop(s);
    const q = within(panel());
    const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
    fireEvent.change(base, { target: { value: 'http://192.168.1.77:8000' } });
    fireEvent.blur(base);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ 'external.baseUrl': 'http://192.168.1.77:8000' }));
    await waitFor(() => expect(base.value).toBe('http://192.168.1.77:8000'));
    release({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm' });
    await new Promise((r) => setTimeout(r, 50));
    expect(base.value).toBe('http://192.168.1.77:8000');
    fireEvent.blur(base);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings.mock.calls.some(([body]) => body['external.baseUrl'] === 'http://192.168.1.50:8080')).toBe(false);
  });

  // Final critic FC2: a PUT refused while the first GET is still in flight
  // must not leave the panel on its defaults (switch OFF while the backend
  // generates externally): the panel re-reads the backend.
  test('a refused PUT before the first settings load arrives still shows the backend state', async () => {
    installDesktopBridgeStub();
    const backend = {
      'external.enabled': true,
      'external.protocol': 'anthropic',
      'external.baseUrl': 'https://api.anthropic.com',
      'external.model': 'claude-x',
      'external.apiKeySet': true,
      'external.apiKeyBoundOrigin': 'https://api.anthropic.com',
      'external.airgap': true,
    };
    const { s, updateSettings } = session(backend);
    let release: (v: unknown) => void = () => undefined;
    const first = new Promise((resolve) => {
      release = resolve;
    });
    let gets = 0;
    (s.apiClient as unknown as { getSettings: () => Promise<unknown> }).getSettings = () => {
      gets += 1;
      return gets === 1 ? first : Promise.resolve(backend);
    };
    updateSettings.mockImplementation(async () => {
      throw new Error('external.baseUrl: Endpoint refused (airgap-public)');
    });
    renderDesktop(s);
    const q = within(panel());
    const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
    fireEvent.change(base, { target: { value: 'https://api.openai.com' } });
    fireEvent.blur(base);
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    release(backend);
    await waitFor(() => expect(q.getByRole('switch', { name: /^use external model$/i })).toBeChecked());
    expect((q.getByRole('combobox', { name: /^protocol$/i }) as HTMLSelectElement).value).toBe('anthropic');
    expect(q.getByTestId('external-airgap-notice')).toBeInTheDocument();
    expect(gets).toBe(2);
  });

  test('PUT answers arriving out of order: only the latest PUT repaints the panel', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm' });
    const delays = [90, 10];
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      const wait = delays.shift() ?? 0;
      await new Promise((r) => setTimeout(r, wait));
      return { 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm', ...patch } as never;
    });
    renderDesktop(s);
    const q = within(panel());
    const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
    await waitFor(() => expect(base.value).toBe('http://192.168.1.50:8080'));
    fireEvent.change(base, { target: { value: 'http://192.168.1.77:8000' } });
    fireEvent.blur(base);
    fireEvent.change(base, { target: { value: 'http://192.168.1.88:8000' } });
    fireEvent.blur(base);
    await new Promise((r) => setTimeout(r, 200));
    expect(base.value).toBe('http://192.168.1.88:8000');
  });

  test('Test connection sends a typed key only for the origin it was typed for', async () => {
    installDesktopBridgeStub();
    const { s, testExternalEndpoint } = session({ 'external.baseUrl': 'http://192.168.1.50:8080', 'external.model': 'm' });
    renderDesktop(s);
    const q = within(panel());
    const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
    await waitFor(() => expect(base.value).toBe('http://192.168.1.50:8080'));
    fireEvent.change(base, { target: { value: 'http://api.openai.com/v1' } });
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    fireEvent.change(key, { target: { value: KEY } });
    // URL edited back to C without blurring the key field: the key was typed for another origin.
    fireEvent.change(base, { target: { value: 'http://192.168.1.50:8080' } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(testExternalEndpoint).toHaveBeenCalled());
    for (const [req] of testExternalEndpoint.mock.calls) expect(req).not.toHaveProperty('apiKey');
  });

  test('a key with a header-invalid character is refused inline and never PUT (F4)', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.20:8000' });
    renderDesktop(s);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    // (an <input> strips CR/LF itself, so the reachable case is a non-Latin-1 paste)
    fireEvent.change(key, { target: { value: 'sk-INLINE-\u{1F511}-SENTINEL' } });
    fireEvent.blur(key);
    const alert = q.getByTestId('external-problem');
    await waitFor(() => expect(alert).not.toBeEmptyDOMElement());
    expect(alert).toHaveTextContent(/cannot be sent in an HTTP header/);
    expect(alert.textContent).not.toContain('SENTINEL');
    expect(updateSettings).not.toHaveBeenCalled();
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
    await waitFor(() => expect(q.getByTestId('external-problem')).toHaveTextContent(/air-?gap/i));
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
    // Same copy in both apps (review round 1 F2 parity).
    expect(
      await within(panel()).findByText('Your saved key is for https://api.openai.com. Enter the key for this server to use it.'),
    ).toBeInTheDocument();
  });
});

// Review round 1 (F2): browser key-origin binding, end to end through the
// panel against real local endpoints. The saved key is never shown, tested or
// sent for another origin; re-entering it binds it to the new origin.
describe('browser app: key-origin binding (F2)', () => {
  interface Hit {
    url: string;
    headers: import('node:http').IncomingHttpHeaders;
  }
  const open: import('node:http').Server[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const s = open.pop() as import('node:http').Server;
      (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
  async function endpoint(): Promise<{ base: string; hits: Hit[] }> {
    const http = await import('node:http');
    const hits: Hit[] = [];
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push({ url: req.url ?? '', headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm' }] }));
      });
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    open.push(s);
    return { base: `http://127.0.0.1:${(s.address() as import('node:net').AddressInfo).port}`, hits };
  }
  const KEY2 = 'sk-panel-SECOND-1357';
  const keyOf = (h: Hit | undefined) => [h?.headers.authorization, h?.headers['x-api-key']];

  for (const protocol of ['openai', 'anthropic'] as const) {
    test(`${protocol}: A -> B hides the key, Test connection sends none to B, re-entry rebinds to B`, async () => {
      const a = await endpoint();
      const b = await endpoint();
      render(<ExternalModelSection />);
      const q = within(panel());
      if (protocol === 'anthropic') {
        fireEvent.change(q.getByRole('combobox', { name: /^protocol$/i }), { target: { value: 'anthropic' } });
      }
      const sent = (k: string) => (protocol === 'openai' ? [`Bearer ${k}`, undefined] : [undefined, k]);
      const base = q.getByLabelText(/^base url$/i);
      const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
      const testButton = q.getByRole('button', { name: /^test connection$/i });
      fireEvent.change(base, { target: { value: a.base } });
      fireEvent.blur(base);
      fireEvent.change(key, { target: { value: KEY } });
      fireEvent.blur(key);
      await waitFor(() => expect(sessionStorage.getItem('external-provider-apikey-origin')).toBe(a.base));
      fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'm' } });
      fireEvent.click(testButton);
      await waitFor(() => expect(a.hits).toHaveLength(1));
      expect(keyOf(a.hits[0])).toEqual(sent(KEY));
      await waitFor(() => expect(testButton).not.toBeDisabled());

      // Point the panel at B: the saved key is hidden, announced, and not sent.
      fireEvent.change(base, { target: { value: b.base } });
      fireEvent.blur(base);
      expect(await q.findByText(`Your saved key is for ${a.base}. Enter the key for this server to use it.`)).toBeInTheDocument();
      expect(key.value).toBe('');
      fireEvent.click(testButton);
      await waitFor(() => expect(b.hits).toHaveLength(1));
      expect(keyOf(b.hits[0])).toEqual([undefined, undefined]);
      await waitFor(() => expect(testButton).not.toBeDisabled());
      // The saved key was kept (not deleted, not rebound to B).
      expect(sessionStorage.getItem('external-provider-apikey')).toBe(KEY);
      expect(sessionStorage.getItem('external-provider-apikey-origin')).toBe(a.base);

      // Re-entering a key binds it to B.
      fireEvent.change(key, { target: { value: KEY2 } });
      fireEvent.blur(key);
      await waitFor(() => expect(sessionStorage.getItem('external-provider-apikey-origin')).toBe(b.base));
      await waitFor(() => expect(q.queryByTestId('external-key-elsewhere')).toBeNull());
      fireEvent.click(testButton);
      await waitFor(() => expect(b.hits).toHaveLength(2));
      expect(keyOf(b.hits[1])).toEqual(sent(KEY2));
      await waitFor(() => expect(testButton).not.toBeDisabled());

      // Back to A: KEY2 belongs to B now, so A gets nothing.
      fireEvent.change(base, { target: { value: a.base } });
      fireEvent.blur(base);
      expect(await q.findByText(`Your saved key is for ${b.base}. Enter the key for this server to use it.`)).toBeInTheDocument();
      fireEvent.click(testButton);
      await waitFor(() => expect(a.hits).toHaveLength(2));
      expect(keyOf(a.hits[1])).toEqual([undefined, undefined]);
    });
  }

  test('Test connection right after editing the URL (no blur yet) does not send the shown key to the new origin', async () => {
    const a = await endpoint();
    const b = await endpoint();
    localStorage.setItem('external-provider-config', JSON.stringify({ protocol: 'openai', baseUrl: a.base, model: 'm', rememberKey: true }));
    localStorage.setItem('external-provider-apikey-origin', a.base);
    localStorage.setItem('external-provider-apikey', KEY);
    render(<ExternalModelSection />);
    const q = within(panel());
    // L1: the saved key is never written into the field's DOM value.
    expect((q.getByLabelText(/^api key$/i) as HTMLInputElement).value).toBe('');
    expect(q.getByTestId('external-key-saved')).toBeInTheDocument();
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: b.base } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(b.hits).toHaveLength(1));
    expect(keyOf(b.hits[0])).toEqual([undefined, undefined]);
    expect(a.hits).toHaveLength(0);
  });

  // Review round 2 (R2-F1): end to end against a real endpoint C that is the
  // SAVED base URL. A key typed while the Base URL field shows a refused or an
  // empty URL is never saved, so neither generation nor anything else sends it
  // to C; it is saved only together with the next valid URL shown.
  for (const protocol of ['openai', 'anthropic'] as const) {
    for (const shown of ['http://api.openai.com/v1', ''] as const) {
      test(`${protocol}: a key typed while the URL field shows ${shown === '' ? 'nothing' : 'a refused URL'} never reaches the saved endpoint C`, async () => {
        const c = await endpoint();
        const d = await endpoint();
        localStorage.setItem(
          'external-provider-config',
          JSON.stringify({ enabled: true, protocol, baseUrl: c.base, model: 'm', rememberKey: false }),
        );
        render(<ExternalModelSection />);
        const q = within(panel());
        const base = q.getByLabelText(/^base url$/i);
        fireEvent.change(base, { target: { value: shown } });
        fireEvent.blur(base);
        const key = q.getByLabelText(/^api key$/i);
        fireEvent.change(key, { target: { value: KEY } });
        fireEvent.blur(key);
        expect(await q.findByTestId('external-key-held')).toBeInTheDocument();
        // Every other save the reviewer used to bind the key to C.
        fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'm' } });
        fireEvent.blur(q.getByLabelText(/^model$/i));
        fireEvent.click(q.getByRole('checkbox', { name: /remember api key/i }));
        fireEvent.click(q.getByRole('switch', { name: /^use my documents/i }));
        expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
        // Generation through the saved configuration (endpoint C).
        const ext = await import('../lib/llm/external-provider');
        const svc = ext.createExternalLLMService(ext.loadExternalConfig());
        expect(svc).not.toBeNull();
        await (svc as NonNullable<typeof svc>).generateComplete([{ role: 'user', content: 'hi' }]).catch(() => '');
        expect(c.hits.length).toBeGreaterThan(0);
        for (const h of c.hits) expect(keyOf(h)).toEqual([undefined, undefined]);
        // A valid URL shown: saved together, bound to D only.
        fireEvent.change(base, { target: { value: d.base } });
        fireEvent.blur(base);
        await waitFor(() => expect(ext.keyForBaseUrl(d.base)).toBe(KEY));
        expect(ext.keyForBaseUrl(c.base)).toBe('');
        expect(q.queryByTestId('external-key-held')).toBeNull();
      });
    }
  }

  test('tabbing through the key field while a refused URL is shown does not re-save (or un-bind) the key', async () => {
    const a = await endpoint();
    const b = await endpoint();
    localStorage.setItem('external-provider-config', JSON.stringify({ protocol: 'openai', baseUrl: a.base, model: 'm', rememberKey: true }));
    localStorage.setItem('external-provider-apikey-origin', a.base);
    localStorage.setItem('external-provider-apikey', KEY);
    render(<ExternalModelSection />);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    const base = q.getByLabelText(/^base url$/i);
    expect(key.value).toBe('');
    expect(q.getByTestId('external-key-saved')).toBeInTheDocument();
    fireEvent.change(base, { target: { value: 'http://169.254.169.254' } });
    fireEvent.blur(base);
    await waitFor(() => expect(q.getByTestId('external-problem')).toHaveTextContent(/metadata/));
    fireEvent.focus(key);
    fireEvent.blur(key);
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe(a.base);
    fireEvent.change(base, { target: { value: b.base } });
    fireEvent.blur(base);
    await waitFor(() => expect(q.queryByTestId('external-key-saved')).toBeNull());
    expect(key.value).toBe('');
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe(a.base);
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(b.hits).toHaveLength(1));
    expect(keyOf(b.hits[0])).toEqual([undefined, undefined]);
  });

  test('tab-through and the Remember toggle never rebind a key that belongs to another origin', async () => {
    const a = await endpoint();
    const b = await endpoint();
    localStorage.setItem('external-provider-config', JSON.stringify({ protocol: 'openai', baseUrl: a.base, model: 'm', rememberKey: false }));
    sessionStorage.setItem('external-provider-apikey-origin', a.base);
    sessionStorage.setItem('external-provider-apikey', KEY);
    render(<ExternalModelSection />);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    expect(key.value).toBe('');
    expect(q.getByTestId('external-key-saved')).toBeInTheDocument();
    const base = q.getByLabelText(/^base url$/i);
    fireEvent.change(base, { target: { value: b.base } });
    fireEvent.blur(base);
    await waitFor(() => expect(q.queryByTestId('external-key-saved')).toBeNull());
    fireEvent.focus(key);
    fireEvent.blur(key);
    fireEvent.click(q.getByRole('checkbox', { name: /remember api key/i }));
    await waitFor(() => expect(localStorage.getItem('external-provider-apikey')).toBe(KEY));
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe(a.base);
    expect(q.getByTestId('external-key-elsewhere')).toHaveTextContent(`Your saved key is for ${a.base}.`);
    // Pointing back at A shows (and uses) the key again.
    fireEvent.change(base, { target: { value: `${a.base}/v1` } });
    fireEvent.blur(base);
    await waitFor(() => expect(q.getByTestId('external-key-saved')).toBeInTheDocument());
    expect(key.value).toBe('');
    expect(q.queryByTestId('external-key-elsewhere')).toBeNull();
  });
});

// Review round 5 (R5-N1): the re-GET issued after a refused desktop save must
// not repaint a stale snapshot over a newer successful save (mirrors the
// reviewer's probe B). The fake backend snapshots its state when each GET
// starts, so the delayed re-GET answers with the OLD URL C.
describe('desktop app: stale re-GET after a refused save (R5-N1)', () => {
  const C = 'http://192.168.1.50:8080';
  const B = 'http://10.0.0.9:1234';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('a successful save issued while the re-GET is in flight wins; the stale URL is never shown or PUT back', async () => {
    installDesktopBridgeStub();
    const backend: Record<string, unknown> = { 'external.baseUrl': C, 'external.model': 'm', 'external.enabled': true };
    const getDelays = [80, 120]; // initial GET (discarded), then the delayed re-GET
    let gets = 0;
    let puts = 0;
    const putBodies: Array<Record<string, unknown>> = [];
    const apiClient = {
      getSettings: vi.fn(async () => {
        gets += 1;
        const snapshot = { ...backend };
        await wait(getDelays[gets - 1] ?? 10);
        return snapshot as never;
      }),
      updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
        puts += 1;
        putBodies.push(patch);
        if (puts === 1) throw new Error('422: refused');
        Object.assign(backend, patch);
        return { ...backend } as never;
      }),
      testExternalEndpoint: vi.fn(async () => ({ ok: true, message: 'ok', models: [] })),
    } as unknown as ApiClient;
    const s: DesktopSession = { baseUrl: 'http://127.0.0.1:4567', token: 't', mode: 'node', apiClient, sseUrl: () => 'x' };
    render(
      <DesktopSessionProvider value={{ session: s, models: null, loading: false, error: null }}>
        <ExternalModelSection />
      </DesktopSessionProvider>,
    );
    const q = within(panel());
    // 1) A refused save before any snapshot was applied -> re-GET (delayed 120 ms).
    const model = q.getByLabelText(/^model$/i);
    fireEvent.change(model, { target: { value: 'x' } });
    fireEvent.blur(model);
    await waitFor(() => expect(gets).toBe(2));
    // 2) While the re-GET is in flight, a successful save of URL B.
    const base = q.getByLabelText(/^base url$/i) as HTMLInputElement;
    fireEvent.change(base, { target: { value: B } });
    fireEvent.blur(base);
    await waitFor(() => expect(putBodies).toContainEqual({ 'external.baseUrl': B }));
    // 3) The delayed re-GET answers with the stale URL C: it must be ignored.
    await wait(250);
    expect(base.value).toBe(B);
    // 4) A later URL blur PUTs B again, never C.
    fireEvent.blur(base);
    await waitFor(() => expect(puts).toBe(3));
    expect(base.value).toBe(B);
    expect(putBodies.some((body) => body['external.baseUrl'] === C)).toBe(false);
  });
});

describe('generator source (Lumen phase 4, design-language.md section 5)', () => {
  const region = () => screen.getByRole('region', { name: /^model & connection$/i });

  test('Built-in model by default: the connection form collapses to one muted line and the built-in slot shows', () => {
    render(<ExternalModelSection id="model-connection" builtIn={<p>BUILT-IN SETTINGS</p>} />);
    const q = within(region());
    expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
    expect(q.getByText('BUILT-IN SETTINGS')).toBeInTheDocument();
    expect(q.getByTestId('external-not-applicable')).toHaveTextContent(/no external model server is used/i);
    expect(q.queryByLabelText(/^base url$/i)).toBeNull();
    expect(q.queryByRole('switch', { name: /^use external model$/i })).toBeNull();
  });

  test('choosing a server source shows the form but saves nothing and starts no egress', () => {
    render(<ExternalModelSection builtIn={<p>BUILT-IN SETTINGS</p>} />);
    const q = within(region());
    fireEvent.click(q.getByRole('radio', { name: /^cloud provider$/i }));
    expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
    // M2: egress is still off, so the built-in model answers and its settings stay.
    expect(q.getByText('BUILT-IN SETTINGS')).toBeInTheDocument();
    expect(q.getByTestId('builtin-still-answering')).toBeInTheDocument();
    expect(q.getByLabelText(/^base url$/i)).toHaveAttribute('placeholder', 'https://api.openai.com');
    expect(q.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
    expect(q.getByTestId('external-usage-state')).toHaveTextContent(/not in use yet/i);
    expect(localStorage.getItem('external-provider-config')).toBeNull();
  });

  test('an enabled endpoint opens on its own source (public host = Cloud provider); Built-in turns egress off', async () => {
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-x', grounded: true }),
    );
    render(<ExternalModelSection />);
    const q = within(region());
    expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
    expect(q.getByRole('switch', { name: /^use external model$/i })).toBeChecked();
    expect(q.getByTestId('external-usage-state')).toHaveTextContent(/answers come from this server/i);
    fireEvent.click(q.getByRole('radio', { name: /^built-in model$/i }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('external-provider-config') ?? '{}').enabled).toBe(false));
    expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
    // The saved connection is kept (only egress is off).
    expect(JSON.parse(localStorage.getItem('external-provider-config') ?? '{}').baseUrl).toBe('https://api.openai.com');
  });

  test('the section notice (e.g. the desktop settings error) shows for EVERY generator source', () => {
    render(<ExternalModelSection builtIn={<p>BUILT-IN</p>} notice={<p role="alert">Settings error: boom</p>} />);
    const q = within(region());
    expect(q.getByRole('alert')).toHaveTextContent('Settings error: boom');
    fireEvent.click(q.getByRole('radio', { name: /^cloud provider$/i }));
    expect(q.getByRole('alert')).toHaveTextContent('Settings error: boom');
  });

  test('typing in Base URL while egress is on never flips the source; the saved URL does', async () => {
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-x', grounded: true }),
    );
    render(<ExternalModelSection />);
    const q = within(region());
    const base = q.getByLabelText(/^base url$/i);
    expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
    // Mid-edit values (empty, then a loopback URL) do not move the radio.
    fireEvent.change(base, { target: { value: '' } });
    expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
    fireEvent.change(base, { target: { value: 'http://localhost:1234' } });
    expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
    // Saving it (blur) reclassifies: a loopback server is a local server.
    fireEvent.blur(base);
    await waitFor(() => expect(q.getByRole('radio', { name: /^local or network server$/i })).toBeChecked());
  });

  test('a failed connection test names its cause in the Banner title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://localhost:1234' } });
    fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'm' } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    const alert = q.getByTestId('external-problem');
    await waitFor(() => expect(alert).not.toBeEmptyDOMElement());
    expect(alert).toHaveTextContent(/the server refused the api key/i);
    // A setting problem (policy refusal) is titled as such, not as a connection cause.
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://169.254.169.254' } });
    fireEvent.blur(q.getByLabelText(/^base url$/i));
    await waitFor(() => expect(q.getByTestId('external-problem')).toHaveTextContent(/check this setting/i));
  });
});

describe('review round 3 (M4, L1, L2, L3, L5, L7)', () => {
  const region = () => screen.getByRole('region', { name: /^model & connection$/i });

  test('M4: with Remember on, the note says the key is saved unencrypted and readable by scripts on this site', () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.click(q.getByRole('checkbox', { name: /remember api key/i }));
    expect(
      q.getByText(/with remember on, the key is saved in this browser unencrypted: any script running on this site can read it/i),
    ).toBeInTheDocument();
  });

  test('L1: a saved browser key never reaches the DOM value, and emptying a typed key keeps the saved one', async () => {
    localStorage.setItem('external-provider-config', JSON.stringify({ protocol: 'openai', baseUrl: 'http://localhost:1234', model: 'm', rememberKey: true }));
    localStorage.setItem('external-provider-apikey-origin', 'http://localhost:1234');
    localStorage.setItem('external-provider-apikey', KEY);
    const { container } = render(<ExternalModelSection />);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    expect(key.value).toBe('');
    expect(container.innerHTML).not.toContain(KEY);
    expect(q.getByTestId('external-key-saved')).toBeInTheDocument();
    expect(key).toHaveAttribute('placeholder', 'Saved');
    // Typing then erasing is "no new key", never an accidental delete.
    fireEvent.change(key, { target: { value: 'sk-x' } });
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.blur(key);
    await waitFor(() => expect(q.getByTestId('external-key-saved')).toBeInTheDocument());
    expect(localStorage.getItem('external-provider-apikey')).toBe(KEY);
    // Clear saved key is the explicit way to forget it.
    fireEvent.click(q.getByRole('button', { name: /^clear saved key$/i }));
    await waitFor(() => expect(localStorage.getItem('external-provider-apikey')).toBeNull());
    expect(q.queryByTestId('external-key-saved')).toBeNull();
  });

  test('L2: while egress is on, the other server type is locked so the radio never contradicts the live endpoint', async () => {
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://localhost:1234', model: 'm', grounded: true }),
    );
    render(<ExternalModelSection />);
    const q = within(region());
    expect(q.getByRole('radio', { name: /^local or network server$/i })).toBeChecked();
    expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeDisabled();
    expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeEnabled();
    fireEvent.click(q.getByRole('switch', { name: /^use external model$/i }));
    await waitFor(() => expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeEnabled());
  });

  test('L3: a model picked from the list is saved at once (Enter), not only on blur', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'llama-3' }, { id: 'qwen' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    render(<ExternalModelSection />);
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://localhost:1234' } });
    fireEvent.blur(q.getByLabelText(/^base url$/i));
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(q.getByTestId('external-status')).toHaveTextContent(/available|connected|models/i));
    const model = q.getByRole('combobox', { name: /^model$/i });
    model.focus();
    fireEvent.keyDown(model, { key: 'ArrowDown' });
    fireEvent.keyDown(model, { key: 'ArrowDown' });
    fireEvent.keyDown(model, { key: 'ArrowDown' });
    fireEvent.keyDown(model, { key: 'Enter' });
    expect(model).toHaveValue('qwen');
    expect(model).toHaveFocus();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('external-provider-config') ?? '{}').model).toBe('qwen'));
  });

  test('L5: Test connection says it contacts the server once, with the key', () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    expect(q.getByTestId('external-test-note')).toHaveTextContent(
      /contacts this server once \(from this browser\), with your api key if one is set/i,
    );
  });

  test('L7/L-b: the feedback live regions are always mounted, with a constant aria-live and no role', async () => {
    render(<ExternalModelSection />);
    const q = within(panel());
    const live = region().querySelectorAll('.settings-live');
    expect(live).toHaveLength(2);
    expect(live[0]).toHaveAttribute('aria-live', 'polite');
    expect(live[1]).toHaveAttribute('aria-live', 'assertive');
    for (const el of live) {
      expect(el).toHaveAttribute('aria-atomic', 'true');
      expect(el).not.toHaveAttribute('role');
    }
    fireEvent.click(q.getByRole('switch', { name: /^use external model$/i }));
    await waitFor(() => expect(live[1]).toHaveTextContent(/base URL and choose a model/i));
    // Same element, still no role (no double announcement), and the Banner adds none.
    expect(region().querySelectorAll('.settings-live')[1]).toBe(live[1]);
    expect(live[1]).not.toHaveAttribute('role');
    expect(live[1].querySelector('[role]')).toBeNull();
  });

  test('N2: the feedback regions sit right after the connection form, before the built-in settings', () => {
    render(<ExternalModelSection builtIn={<p data-testid="builtin-marker">BUILT-IN</p>} />);
    const q = within(panel());
    const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const testButton = q.getByRole('button', { name: /^test connection$/i });
    const status = q.getByTestId('external-status');
    const problem = q.getByTestId('external-problem');
    const builtIn = q.getByTestId('builtin-marker');
    expect(before(testButton, status)).toBe(true);
    expect(before(status, problem)).toBe(true);
    expect(before(problem, builtIn)).toBe(true);
    // Nothing but the grounded switch (end of the form) separates them from the form.
    const form = q.getByRole('group', { name: /^server connection$/i });
    expect(form.nextElementSibling).toBe(status);
    expect(status.nextElementSibling).toBe(problem);
  });
});

describe('review L1/L6 (final critic)', () => {
  const region = () => screen.getByRole('region', { name: /^model & connection$/i });

  function desktopSession(settings: Record<string, unknown>, testExternalEndpoint: (req: Record<string, unknown>) => Promise<never>) {
    const apiClient = {
      getSettings: vi.fn(async () => settings as never),
      updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ ...settings, ...patch }) as never),
      testExternalEndpoint,
    } as unknown as ApiClient;
    const s: DesktopSession = { baseUrl: 'http://127.0.0.1:4567', token: 't', mode: 'node', apiClient, sseUrl: () => 'x' };
    return s;
  }
  const renderWith = (s: DesktopSession | null) =>
    render(
      <DesktopSessionProvider value={{ session: s, models: null, loading: false, error: null }}>
        <ExternalModelSection />
      </DesktopSessionProvider>,
    );
  async function runTest(): Promise<HTMLElement> {
    const q = within(panel());
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: 'http://192.168.1.20:8000' } });
    fireEvent.change(q.getByLabelText(/^model$/i), { target: { value: 'm1' } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    const problem = q.getByTestId('external-problem');
    await waitFor(() => expect(problem).not.toBeEmptyDOMElement());
    return problem;
  }

  test('L1: a desktop backend that is not ready is titled as unavailable, not as an unreachable server', async () => {
    installDesktopBridgeStub();
    renderWith(null);
    const problem = await runTest();
    expect(problem).toHaveTextContent(/the desktop backend is not available/i);
    expect(problem).not.toHaveTextContent(/server not reachable/i);
  });

  test('L1: a backend refusal (4xx) is titled as a refusal, not as an unreachable server', async () => {
    installDesktopBridgeStub();
    renderWith(desktopSession({}, () => Promise.reject(new ApiError(403, 'Not supported by this backend engine'))));
    const problem = await runTest();
    expect(problem).toHaveTextContent(/the desktop backend refused the test/i);
    expect(problem).toHaveTextContent(/not supported by this backend engine/i);
    expect(problem).not.toHaveTextContent(/server not reachable/i);
  });

  test('L1: only a transport failure (fetch TypeError, ApiError status 0) is titled Server not reachable', async () => {
    installDesktopBridgeStub();
    renderWith(desktopSession({}, () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await runTest()).toHaveTextContent(/server not reachable/i);
    cleanup();
    renderWith(desktopSession({}, () => Promise.reject(new ApiError(0, 'Network unavailable'))));
    expect(await runTest()).toHaveTextContent(/server not reachable/i);
  });

  test('L1: an unclassified thrown error is titled as a failed test, not as a network problem', async () => {
    installDesktopBridgeStub();
    renderWith(desktopSession({}, () => Promise.reject(new Error('boom'))));
    const problem = await runTest();
    expect(problem).toHaveTextContent(/connection test failed/i);
    expect(problem).not.toHaveTextContent(/server not reachable/i);
  });

  test('N2: a backend 5xx is titled as a failure to run the test; a 4xx stays a refusal', async () => {
    installDesktopBridgeStub();
    renderWith(desktopSession({}, () => Promise.reject(new ApiError(500, 'internal error'))));
    const failed = await runTest();
    expect(failed).toHaveTextContent(/the desktop backend failed to run the test/i);
    expect(failed).not.toHaveTextContent(/refused the test/i);
    cleanup();
    renderWith(desktopSession({}, () => Promise.reject(new ApiError(400, 'bad request'))));
    expect(await runTest()).toHaveTextContent(/the desktop backend refused the test/i);
  });

  // L6 (rework): the radio always matches the generator that actually answers.
  const saveBrowser = (cfg: Record<string, unknown>) =>
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: false, protocol: 'openai', baseUrl: '', model: '', grounded: true, ...cfg }),
    );
  /** Stubs fetch; callers assert it was never called. */
  const noFetch = () => {
    const spy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', spy);
    return spy;
  };
  const storedConfig = (): Record<string, unknown> => JSON.parse(localStorage.getItem('external-provider-config') ?? '{}');

  test('L6: a Cloud provider entered but never enabled reloads on Built-in model and names the saved server', async () => {
    const first = render(<ExternalModelSection />);
    let q = within(region());
    fireEvent.click(q.getByRole('radio', { name: /^cloud provider$/i }));
    const base = q.getByLabelText(/^base url$/i);
    fireEvent.change(base, { target: { value: 'https://api.openai.com/v1/secret-path' } });
    fireEvent.blur(base);
    await waitFor(() => expect(storedConfig().baseUrl).toBe('https://api.openai.com/v1/secret-path'));
    first.unmount();
    const fetchSpy = noFetch();
    render(<ExternalModelSection />);
    q = within(region());
    expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
    const note = q.getByTestId('external-saved-not-in-use');
    expect(note).toHaveTextContent('A Cloud provider is saved but not in use (https://api.openai.com). Choose it to edit or switch it on.');
    expect(note).not.toHaveTextContent(/secret-path/);
    expect(q.queryByLabelText(/^base url$/i)).toBeNull();
    expect(storedConfig().enabled).not.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeSpy.calls).toBe(0);
  });

  test('L6: a saved private-network URL that is not enabled reloads on Built-in model and says Local or network server', () => {
    saveBrowser({ baseUrl: 'http://192.168.1.20:11434' });
    const fetchSpy = noFetch();
    render(<ExternalModelSection />);
    const q = within(region());
    expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
    expect(q.getByTestId('external-saved-not-in-use')).toHaveTextContent(
      'A Local or network server is saved but not in use (http://192.168.1.20:11434). Choose it to edit or switch it on.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeSpy.calls).toBe(0);
  });

  test('L6: explicitly choosing Built-in after configuring an enabled server reloads on Built-in model', async () => {
    saveBrowser({ enabled: true, baseUrl: 'https://api.openai.com', model: 'gpt-x' });
    const first = render(<ExternalModelSection />);
    fireEvent.click(within(region()).getByRole('radio', { name: /^built-in model$/i }));
    await waitFor(() => expect(storedConfig().enabled).toBe(false));
    first.unmount();
    const fetchSpy = noFetch();
    render(<ExternalModelSection />);
    const q = within(region());
    expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
    expect(q.getByTestId('external-saved-not-in-use')).toHaveTextContent(/cloud provider is saved but not in use \(https:\/\/api\.openai\.com\)/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeSpy.calls).toBe(0);
  });

  test('L6: an enabled external model reloads on its own source and shows no saved-not-in-use line', () => {
    saveBrowser({ enabled: true, baseUrl: 'https://api.openai.com', model: 'gpt-x' });
    const fetchSpy = noFetch();
    render(<ExternalModelSection />);
    expect(within(region()).getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
    expect(within(region()).queryByTestId('external-saved-not-in-use')).toBeNull();
    cleanup();
    saveBrowser({ enabled: true, baseUrl: 'http://localhost:1234', model: 'm' });
    render(<ExternalModelSection />);
    expect(within(region()).getByRole('radio', { name: /^local or network server$/i })).toBeChecked();
    expect(within(region()).queryByTestId('external-saved-not-in-use')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeSpy.calls).toBe(0);
  });

  test('L6: with nothing saved the section opens on Built-in model without a saved-not-in-use line', () => {
    render(<ExternalModelSection />);
    expect(within(region()).getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
    expect(within(region()).queryByTestId('external-saved-not-in-use')).toBeNull();
  });

  test('L6: choosing the saved source from the saved-not-in-use state restores URL, model and grounded, enabling nothing', () => {
    saveBrowser({ baseUrl: 'https://api.openai.com', model: 'gpt-x', grounded: false });
    const fetchSpy = noFetch();
    render(<ExternalModelSection />);
    const q = within(region());
    fireEvent.click(q.getByRole('radio', { name: /^cloud provider$/i }));
    expect(q.getByLabelText(/^base url$/i)).toHaveValue('https://api.openai.com');
    expect(q.getByLabelText(/^model$/i)).toHaveValue('gpt-x');
    expect(q.getByRole('switch', { name: /^use my documents/i })).not.toBeChecked();
    expect(q.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
    expect(storedConfig().enabled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeSpy.calls).toBe(0);
  });

  describe('desktop first snapshot', () => {
    const snap = (settings: Record<string, unknown>) => desktopSession(settings, () => Promise.reject(new Error('unused')));
    /** Waits until the first snapshot has been applied (the saved base URL is in the draft or the note shows). */
    const snapshotApplied = async (s: DesktopSession) => {
      await waitFor(() => expect(s.apiClient.getSettings).toHaveBeenCalled());
      await waitFor(() => expect(within(region()).queryByTestId('external-saved-not-in-use')).not.toBeNull());
    };

    test('a saved but never enabled Cloud provider opens on Built-in model with the saved-not-in-use line', async () => {
      installDesktopBridgeStub();
      const fetchSpy = noFetch();
      const s = snap({ 'external.enabled': false, 'external.baseUrl': 'https://api.anthropic.com', 'external.protocol': 'anthropic' });
      renderWith(s);
      await snapshotApplied(s);
      const q = within(region());
      expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
      expect(q.getByTestId('external-saved-not-in-use')).toHaveTextContent(
        'A Cloud provider is saved but not in use (https://api.anthropic.com). Choose it to edit or switch it on.',
      );
      expect(s.apiClient.updateSettings).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(probeSpy.calls).toBe(0);
    });

    test('explicit Built-in after configuring an enabled server reopens on Built-in model', async () => {
      installDesktopBridgeStub();
      const fetchSpy = noFetch();
      const saved = { 'external.enabled': true, 'external.baseUrl': 'https://api.openai.com', 'external.model': 'gpt-x' };
      const first = snap(saved);
      const view = renderWith(first);
      await waitFor(() => expect(within(region()).getByRole('radio', { name: /^cloud provider$/i })).toBeChecked());
      fireEvent.click(within(region()).getByRole('radio', { name: /^built-in model$/i }));
      await waitFor(() => expect(first.apiClient.updateSettings).toHaveBeenCalledWith({ 'external.enabled': false }));
      view.unmount();
      // Reload: the backend now answers with egress off and the URL kept.
      const second = snap({ ...saved, 'external.enabled': false });
      renderWith(second);
      await snapshotApplied(second);
      expect(within(region()).getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
      expect(second.apiClient.updateSettings).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(probeSpy.calls).toBe(0);
    });

    test('an enabled external model opens on its own source', async () => {
      installDesktopBridgeStub();
      const fetchSpy = noFetch();
      const s = snap({ 'external.enabled': true, 'external.baseUrl': 'http://192.168.1.20:8000', 'external.model': 'm1' });
      renderWith(s);
      await waitFor(() => expect(within(region()).getByRole('radio', { name: /^local or network server$/i })).toBeChecked());
      expect(within(region()).queryByTestId('external-saved-not-in-use')).toBeNull();
      expect(s.apiClient.updateSettings).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(probeSpy.calls).toBe(0);
    });

    test('choosing the saved source restores the saved URL, model and grounded settings', async () => {
      installDesktopBridgeStub();
      const fetchSpy = noFetch();
      const s = snap({
        'external.enabled': false,
        'external.baseUrl': 'http://192.168.1.20:8000',
        'external.model': 'm1',
        'external.grounded': false,
      });
      renderWith(s);
      await snapshotApplied(s);
      const q = within(region());
      fireEvent.click(q.getByRole('radio', { name: /^local or network server$/i }));
      expect(q.getByLabelText(/^base url$/i)).toHaveValue('http://192.168.1.20:8000');
      expect(q.getByLabelText(/^model$/i)).toHaveValue('m1');
      expect(q.getByRole('switch', { name: /^use my documents/i })).not.toBeChecked();
      expect(q.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
      expect(s.apiClient.updateSettings).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(probeSpy.calls).toBe(0);
    });

    test('N1: a source picked before the first snapshot arrives is not overridden by it', async () => {
      installDesktopBridgeStub();
      let release: (v: never) => void = () => undefined;
      const pending = new Promise<never>((resolve) => {
        release = resolve;
      });
      const s = snap({});
      (s.apiClient.getSettings as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => pending);
      renderWith(s);
      const q = within(region());
      fireEvent.click(q.getByRole('radio', { name: /^cloud provider$/i }));
      expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
      release({ 'external.enabled': false, 'external.baseUrl': 'http://192.168.1.20:8000' } as never);
      await waitFor(() => expect(q.getByLabelText(/^base url$/i)).toHaveValue('http://192.168.1.20:8000'));
      expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeChecked();
      expect(q.getByRole('radio', { name: /^built-in model$/i })).not.toBeChecked();
      expect(s.apiClient.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe('N3: air-gapped build', () => {
    test('a saved public URL (not enabled) shows Built-in model; Cloud stays disabled and never selected', async () => {
      installDesktopBridgeStub();
      const fetchSpy = noFetch();
      const s = desktopSession(
        { 'external.enabled': false, 'external.baseUrl': 'https://api.openai.com', 'external.airgap': true },
        () => Promise.reject(new Error('unused')),
      );
      renderWith(s);
      const q = within(region());
      await waitFor(() => expect(q.getByTestId('external-airgap-notice')).toBeInTheDocument());
      const cloud = q.getByRole('radio', { name: /^cloud provider$/i });
      expect(cloud).toBeDisabled();
      expect(cloud).not.toBeChecked();
      expect(q.getByRole('radio', { name: /^built-in model$/i })).toBeChecked();
      expect(q.getByTestId('external-saved-not-in-use')).toHaveTextContent(/cannot be used in this air-gapped build/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(probeSpy.calls).toBe(0);
    });

    test('an enabled public URL shows the form under Local or network server; Cloud stays disabled and unselected', async () => {
      installDesktopBridgeStub();
      const s = desktopSession(
        { 'external.enabled': true, 'external.baseUrl': 'https://api.openai.com', 'external.model': 'gpt-x', 'external.airgap': true },
        () => Promise.reject(new Error('unused')),
      );
      renderWith(s);
      const q = within(region());
      await waitFor(() => expect(q.getByRole('switch', { name: /^use external model$/i })).toBeChecked());
      expect(q.getByRole('radio', { name: /^cloud provider$/i })).toBeDisabled();
      expect(q.getByRole('radio', { name: /^cloud provider$/i })).not.toBeChecked();
      expect(q.getByRole('radio', { name: /^local or network server$/i })).toBeChecked();
      // The switch is reachable, so the user can turn the refused endpoint off.
      fireEvent.click(q.getByRole('switch', { name: /^use external model$/i }));
      await waitFor(() => expect(s.apiClient.updateSettings).toHaveBeenCalledWith({ 'external.enabled': false }));
    });
  });
});
