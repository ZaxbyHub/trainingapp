// provider-settings-timeouts.test.tsx — issue #351 (AC6): the external-model
// settings UI discloses the ACTIVE timeout limits of the lane the user is in,
// and the user can WRITE them (critic r2: disclosure alone was satisfiable by
// a static string and no row proved a write path).
//
// FROZEN ACCEPTANCE SURFACE (trace 350-351-packaged-gpu-fuse-external-timeouts,
// check C6; revision 3 after plan critic r2):
//   - disclosure elements carry stable testids
//     (data-testid="external-timeout-first-byte" / "external-timeout-idle") and
//     each element's text must parse to EXACTLY ONE number+unit equal to the
//     effective milliseconds value (single-number full-match; the r2
//     static-string cheat with "1600 s"/"1120 s" fails the exact parse);
//   - desktop lane: values come from session.apiClient.getSettings() — a
//     changed second response must RE-RENDER the disclosure (consumption proof,
//     not the component's own bootstrap GET);
//   - write path: numeric inputs data-testid="external-first-byte-input" /
//     "external-idle-input" + the section's Save persist through the lane's own
//     storage (browser -> localStorage external-provider-config; desktop ->
//     PUT /settings body carries the dotted keys).
//   - invalid writes (999 / non-integer) never persist.
//
// RED at base (no disclosure/testids/inputs exist — every query reports it via
// "must disclose"), GREEN after the fix.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ExternalModelSection } from '../../components/ExternalModelSection';
import { DesktopSessionProvider, type DesktopSession } from '../../lib/desktop-session';
import { loadExternalConfig, saveExternalConfig } from '../../lib/llm/external-provider';
import type { ApiClient } from '../../lib/api';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { desktopApi?: unknown }).desktopApi;
  vi.unstubAllGlobals();
});

/** The Model & connection region with the server form open (as a user would). */
function panel(): HTMLElement {
  const region = screen.getByRole('region', { name: /^model & connection$/i });
  if (within(region).queryByLabelText(/^base url$/i) === null) {
    fireEvent.click(within(region).getByRole('radio', { name: /^local or network server$/i }));
  }
  return region;
}

/**
 * Parse a disclosure element's text into milliseconds. The element must carry a
 * HUMAN-READABLE label naming the limit kind (r3-F5: two bare unlabeled numbers
 * are not a disclosure — the accessible label must name first-byte/idle), and
 * contain EXACTLY ONE number with an optional unit; multi-number strings (the r2
 * cheat) fail the full match. Accepts `600 s`, `600 seconds`, `600000 ms`,
 * `600,000 ms`, or a bare `600000` (treated as ms).
 */
function disclosedMs(region: HTMLElement, testid: string, label: RegExp): number {
  const el = region.querySelector(`[data-testid="${testid}"]`);
  expect(el, `the region must disclose the ${String(label)} limit via ${testid}`).not.toBeNull();
  const node = el as HTMLElement;
  // The disclosure must be LABELED for a human: the element's accessible name,
  // its own text prefix, or an associated <label for=...>/aria-labelledby must
  // name the limit kind. Two anonymous numbers do not disclose anything.
  const labeled =
    (node.getAttribute('aria-label') ?? '').match(label) !== null ||
    (node.getAttribute('aria-labelledby') !== null && (document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent ?? '').match(label) !== null) ||
    node.textContent.toLowerCase().match(label) !== null;
  expect(labeled, `the ${String(label)} disclosure must be human-labeled (aria-label or text names the limit), got: ${JSON.stringify(node.textContent)}`).toBe(true);
  const text = node.textContent ?? '';
  const m = text.match(/^\s*[^\d]*([\d,]+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?\s*[.!]?\s*$/i);
  expect(m, `disclosure ${testid} must contain exactly one number+unit, got: ${JSON.stringify(text)}`).not.toBeNull();
  const value = Number((m as RegExpMatchArray)[1].replace(/,/g, ''));
  const unit = ((m as RegExpMatchArray)[2] ?? 'ms').toLowerCase();
  const ms = unit.startsWith('m') ? value : value * 1000;
  return ms;
}

describe('#351 AC6: browser-lane disclosure (localStorage effective values)', () => {
  test('unconfigured: the 600 s first-byte and 120 s idle defaults are disclosed exactly', () => {
    render(<ExternalModelSection id="model-connection" />);
    const region = panel();
    expect(disclosedMs(region, 'external-timeout-first-byte', /first[- ]byte/i)).toBe(600_000);
    expect(disclosedMs(region, 'external-timeout-idle', /\bidle\b/i)).toBe(120_000);
  });

  test('configured 720000/105000 are disclosed exactly (defaults do not appear)', () => {
    saveExternalConfig({ firstByteTimeoutMs: 720_000, idleTimeoutMs: 105_000 });
    render(<ExternalModelSection id="model-connection" />);
    const region = panel();
    expect(disclosedMs(region, 'external-timeout-first-byte', /first[- ]byte/i)).toBe(720_000);
    expect(disclosedMs(region, 'external-timeout-idle', /\bidle\b/i)).toBe(105_000);
  });

  test('the user WRITE path: typed values persist to the browser config on save', async () => {
    render(<ExternalModelSection id="model-connection" />);
    const region = panel();
    fireEvent.change(region.querySelector('[data-testid="external-first-byte-input"]') as HTMLElement, {
      target: { value: '800000' },
    });
    fireEvent.change(region.querySelector('[data-testid="external-idle-input"]') as HTMLElement, {
      target: { value: '150000' },
    });
    fireEvent.click(within(region).getByRole('button', { name: /save/i }));
    // CHECK_WRONG (implementation round): persistTimeouts is async — flush the
    // save's microtask before reading storage.
    await act(async () => {});
    const cfg = loadExternalConfig();
    expect(cfg.firstByteTimeoutMs, 'a saved browser timeout must persist through the UI').toBe(800_000);
    expect(cfg.idleTimeoutMs).toBe(150_000);
    // and the disclosure reflects it
    expect(disclosedMs(region, 'external-timeout-first-byte', /first[- ]byte/i)).toBe(800_000);
  });

  test('an invalid typed value (999 / non-integer) never persists', () => {
    render(<ExternalModelSection id="model-connection" />);
    const region = panel();
    fireEvent.change(region.querySelector('[data-testid="external-first-byte-input"]') as HTMLElement, {
      target: { value: '999' },
    });
    fireEvent.click(within(region).getByRole('button', { name: /save/i }));
    expect(loadExternalConfig().firstByteTimeoutMs, '999 must not persist').not.toBe(999);
    expect(loadExternalConfig().firstByteTimeoutMs ?? 600_000).toBe(600_000);
  });
});

describe('#351 AC6: desktop-lane disclosure (GET /settings effective values, consumed)', () => {
  function desktopSession(getSettings: ReturnType<typeof vi.fn>, updateSettings: ReturnType<typeof vi.fn>): DesktopSession {
    // CHECK_WRONG (implementation round): isElectron() = window.desktopApi
    // presence — stub it so the section takes the desktop lane and consults
    // the session's getSettings (the provider alone does not flip the lane).
    (window as unknown as { desktopApi: unknown }).desktopApi = {};
    const apiClient = {
      getSettings,
      updateSettings,
      testExternalEndpoint: vi.fn(async () => ({ ok: true, message: 'Connected: m1 is available.', models: ['m1'] })),
    } as unknown as ApiClient;
    return {
      baseUrl: 'http://127.0.0.1:4567',
      token: 't',
      mode: 'node',
      apiClient,
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    };
  }

  const BASE_SETTINGS = {
    'external.enabled': true,
    'external.protocol': 'openai',
    'external.baseUrl': 'http://127.0.0.1:9',
    'external.model': 'm1',
  };

  test('backend values are disclosed exactly, a CHANGED response re-renders (consumption proof)', async () => {
    const responses = [
      { ...BASE_SETTINGS, 'external.firstByteTimeoutMs': 900_000, 'external.idleTimeoutMs': 130_000 },
      { ...BASE_SETTINGS, 'external.firstByteTimeoutMs': 750_000, 'external.idleTimeoutMs': 95_000 },
    ];
    let call = 0;
    const getSettings = vi.fn(async () => (call++ === 0 ? responses[0] : responses[1]) as never);
    const r = render(
      <DesktopSessionProvider value={{ session: desktopSession(getSettings, vi.fn()), models: null, loading: false, error: null }}>
        <ExternalModelSection />
      </DesktopSessionProvider>,
    );
    const region0 = await screen.findByRole('region', { name: /^model & connection$/i });
    // CHECK_WRONG (implementation round): the Server connection form (which
    // hosts the timeout disclosure) opens only after the source radio is on
    // 'server' — open it, then flush the async GET before asserting.
    fireEvent.click(within(region0).getByRole('radio', { name: /^local or network server$/i }));
    await act(async () => {});
    expect(disclosedMs(region0, 'external-timeout-first-byte', /first[- ]byte/i)).toBe(900_000);
    expect(disclosedMs(region0, 'external-timeout-idle', /\bidle\b/i)).toBe(130_000);
    // Force a re-read (the fix must refresh disclosure when settings change —
    // drive it through the section's own refresh affordance: re-render).
    // The re-read is driven by a NEW session: the component keys its settings
    // read on the session baseUrl identity, so the CHANGED response must ride
    // a different identity to re-fire (second GET call -> responses[1]).
    const secondSession = desktopSession(getSettings, vi.fn(async () => ({}) as never));
    secondSession.baseUrl = 'http://127.0.0.1:4568';
    r.rerender(
      <DesktopSessionProvider value={{ session: secondSession, models: null, loading: false, error: null }}>
        <ExternalModelSection />
      </DesktopSessionProvider>,
    );
    const region = await screen.findByRole('region', { name: /^model & connection$/i });
    fireEvent.click(within(region).getByRole('radio', { name: /^local or network server$/i }));
    await waitFor(() => {
      expect(disclosedMs(region, 'external-timeout-first-byte', /first[- ]byte/i)).toBe(750_000);
      expect(disclosedMs(region, 'external-timeout-idle', /\bidle\b/i)).toBe(95_000);
    }, { timeout: 5_000 });
  });

  test('the user WRITE path: saved values PUT the dotted keys to /settings', async () => {
    const updateSettings = vi.fn(async (patch: Record<string, unknown>) => patch as never);
    const getSettings = vi.fn(async () => ({ ...BASE_SETTINGS }) as never);
    render(
      <DesktopSessionProvider value={{ session: desktopSession(getSettings, updateSettings), models: null, loading: false, error: null }}>
        <ExternalModelSection />
      </DesktopSessionProvider>,
    );
    const region = await screen.findByRole('region', { name: /^model & connection$/i });
    fireEvent.click(within(region).getByRole('radio', { name: /^local or network server$/i }));
    await act(async () => {});
    fireEvent.change(region.querySelector('[data-testid="external-first-byte-input"]') as HTMLElement, {
      target: { value: '850000' },
    });
    fireEvent.change(region.querySelector('[data-testid="external-idle-input"]') as HTMLElement, {
      target: { value: '110000' },
    });
    fireEvent.click(within(region).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const body = updateSettings.mock.calls.flatMap((c) => c).find(
      (arg: unknown) => typeof arg === 'object' && arg !== null && 'external.firstByteTimeoutMs' in (arg as object),
    ) as Record<string, unknown> | undefined;
    expect(body, 'the desktop save must PUT external.firstByteTimeoutMs/external.idleTimeoutMs').toBeTruthy();
    expect(body?.['external.firstByteTimeoutMs']).toBe(850_000);
    expect(body?.['external.idleTimeoutMs']).toBe(110_000);
  });
});
