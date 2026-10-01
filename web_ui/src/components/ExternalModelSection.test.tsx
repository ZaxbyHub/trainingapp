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
    const alert = await q.findByRole('alert');
    expect(alert).toHaveTextContent(/cannot be sent in an HTTP header/);
    expect(alert.textContent).not.toContain('SENTINEL');
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain('SENTINEL');
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(q.getByRole('alert')).toHaveTextContent(/cannot be sent in an HTTP header/));
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

  test('a key with a header-invalid character is refused inline and never PUT (F4)', async () => {
    installDesktopBridgeStub();
    const { s, updateSettings } = session({ 'external.baseUrl': 'http://192.168.1.20:8000' });
    renderDesktop(s);
    const q = within(panel());
    const key = q.getByLabelText(/^api key$/i) as HTMLInputElement;
    // (an <input> strips CR/LF itself, so the reachable case is a non-Latin-1 paste)
    fireEvent.change(key, { target: { value: 'sk-INLINE-\u{1F511}-SENTINEL' } });
    fireEvent.blur(key);
    const alert = await q.findByRole('alert');
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
    expect((q.getByLabelText(/^api key$/i) as HTMLInputElement).value).toBe(KEY);
    fireEvent.change(q.getByLabelText(/^base url$/i), { target: { value: b.base } });
    fireEvent.click(q.getByRole('button', { name: /^test connection$/i }));
    await waitFor(() => expect(b.hits).toHaveLength(1));
    expect(keyOf(b.hits[0])).toEqual([undefined, undefined]);
    expect(a.hits).toHaveLength(0);
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
    expect(key.value).toBe(KEY);
    const base = q.getByLabelText(/^base url$/i);
    fireEvent.change(base, { target: { value: b.base } });
    fireEvent.blur(base);
    await waitFor(() => expect(key.value).toBe(''));
    fireEvent.focus(key);
    fireEvent.blur(key);
    fireEvent.click(q.getByRole('checkbox', { name: /remember api key/i }));
    await waitFor(() => expect(localStorage.getItem('external-provider-apikey')).toBe(KEY));
    expect(localStorage.getItem('external-provider-apikey-origin')).toBe(a.base);
    expect(q.getByTestId('external-key-elsewhere')).toHaveTextContent(`Your saved key is for ${a.base}.`);
    // Pointing back at A shows (and uses) the key again.
    fireEvent.change(base, { target: { value: `${a.base}/v1` } });
    fireEvent.blur(base);
    await waitFor(() => expect(key.value).toBe(KEY));
    expect(q.queryByTestId('external-key-elsewhere')).toBeNull();
  });
});
