/**
 * Sidebar footer connection chip (design-language.md section 5): honest per mode,
 * deep-links to Settings > model connection, icon-only with a tooltip in the 64px
 * rail, closes the drawer on navigation, and never exposes endpoint credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';

vi.mock('../lib/inference', () => ({ useInferenceMode: vi.fn() }));
vi.mock('../lib/desktop-session', () => ({ isElectron: vi.fn(() => false), useDesktopSession: vi.fn() }));
vi.mock('../lib/llm/web-llm-service', () => ({ WEBLLM_DEFAULT_MODEL_ID: 'Llama-3.2-3B-Instruct-q4f16_1-MLC' }));

import { SidebarConnectionChip } from './SidebarConnectionChip';
import { AppShell, DRAWER_MEDIA_QUERY } from '../ui';
import * as inference from '../lib/inference';
import * as desktop from '../lib/desktop-session';
import * as endpointPolicy from '../lib/llm/endpoint-policy';
import { focusSettingsSection, MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';
import { saveExternalConfig } from '../lib/llm/external-provider';
import { clearSessionSettings, clearUserSettings } from '../lib/storage/persisted-keys';
import type { ModelStatus } from '../lib/api/types';

function setMode(mode: 'browser-local' | 'api', browserEngine: 'wllama' | 'webllm' = 'wllama') {
  vi.mocked(inference.useInferenceMode).mockReturnValue({ mode, browserEngine, isModelReady: true } as unknown as ReturnType<
    typeof inference.useInferenceMode
  >);
}
function setModelReady(isModelReady: boolean, mode: 'browser-local' | 'api' = 'browser-local') {
  vi.mocked(inference.useInferenceMode).mockReturnValue({ mode, browserEngine: 'wllama', isModelReady } as unknown as ReturnType<
    typeof inference.useInferenceMode
  >);
}
function setDesktop(models: Partial<ModelStatus> | null, electron = true) {
  vi.mocked(desktop.isElectron).mockReturnValue(electron);
  vi.mocked(desktop.useDesktopSession).mockReturnValue({
    session: models ? ({ baseUrl: 'http://127.0.0.1:4567' } as never) : null,
    models: models as ModelStatus | null,
    loading: false,
    error: null,
  });
}

let mediaRestore: (() => void) | null = null;
function stubMatchMedia(drawer: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === DRAWER_MEDIA_QUERY ? drawer : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  mediaRestore = () => {
    window.matchMedia = original;
  };
}

function Shell({ collapsed = false, onOpen = vi.fn() }: { collapsed?: boolean; onOpen?: () => void }) {
  const [c, setC] = useState(collapsed);
  return (
    <AppShell productName="TrainingApp" collapsed={c} onToggleCollapsed={() => setC((v) => !v)} sidebar={<SidebarConnectionChip onOpenModelSettings={onOpen} />}>
      <h1>page</h1>
    </AppShell>
  );
}

beforeEach(() => {
  localStorage.clear();
  stubMatchMedia(false);
  setMode('browser-local');
  setDesktop(null, false);
});
afterEach(() => {
  cleanup();
  mediaRestore?.();
  vi.restoreAllMocks();
});

describe('SidebarConnectionChip', () => {
  it('browser app, local wllama: names the packaged model; click opens model settings', () => {
    const onOpen = vi.fn();
    render(<Shell onOpen={onOpen} />);
    const chip = screen.getByTestId('sidebar-model-chip');
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    expect(chip).toHaveAccessibleName('Model: Local · Google Gemma 4 E2B-it. Open model settings');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('browser app, local WebLLM', () => {
    setMode('browser-local', 'webllm');
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('Local · Llama-3.2-3B-Instruct-q4f16_1-MLC');
  });

  it('browser app, external endpoint: host + model, and no credential reaches any surface', () => {
    vi.spyOn(endpointPolicy, 'validateEndpointUrl').mockReturnValue({ ok: true } as ReturnType<
      typeof endpointPolicy.validateEndpointUrl
    >);
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({
        enabled: true,
        protocol: 'openai',
        baseUrl: 'https://user:secret@llm.example.com/v1?api_key=QKEY',
        model: 'gpt-x',
        grounded: true,
        rememberKey: true,
      })
    );
    localStorage.setItem('external-provider-apikey', 'sk-STORED-1');
    render(<Shell />);
    const chip = screen.getByTestId('sidebar-model-chip');
    expect(chip).toHaveAttribute('data-kind', 'external');
    expect(chip).toHaveTextContent('llm.example.com · gpt-x');
    for (const surface of [chip.textContent ?? '', chip.getAttribute('title') ?? '', chip.getAttribute('aria-label') ?? '']) {
      for (const secret of ['user', 'secret', '/v1', 'api_key', 'QKEY', 'sk-STORED-1', '@']) {
        expect(surface).not.toContain(secret);
      }
    }
  });

  it('desktop app, backend on an external engine: the mode only (stale browser config ignored)', () => {
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:1234', model: 'stale', grounded: true })
    );
    setDesktop({ engine: 'external', profile: 'quality', models: { quality: { present: false }, fast: { present: false } } });
    render(<Shell />);
    const chip = screen.getByTestId('sidebar-model-chip');
    expect(chip).toHaveAttribute('data-kind', 'desktop-external');
    expect(chip).toHaveTextContent(/^External model$/);
  });

  it('desktop api mode, llama.cpp: the /status/models profile', () => {
    setMode('api');
    setDesktop({ engine: 'llama.cpp', profile: 'fast', models: { quality: { present: true }, fast: { present: true } } });
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('Desktop · Fast profile');
  });

  it('desktop api mode without model status: the mode only', () => {
    setMode('api');
    setDesktop(null);
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent(/^Desktop backend$/);
  });

  it('64px rail: an icon-only button whose tooltip (beside the rail) carries the chip text', () => {
    const onOpen = vi.fn();
    render(<Shell collapsed onOpen={onOpen} />);
    expect(screen.queryByTestId('sidebar-model-chip')).toBeNull();
    const btn = screen.getByRole('button', { name: 'Model: Local · Google Gemma 4 E2B-it. Open model settings' });
    expect(btn.textContent).toBe('');
    fireEvent.focus(btn);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Model: Local · Google Gemma 4 E2B-it');
    expect(tip).toHaveClass('ui-tooltip--end');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('PRR-119: the detail sentence is a described-by node in both the expanded chip and the rail button', () => {
    const { unmount } = render(<Shell />);
    const chip = screen.getByTestId('sidebar-model-chip');
    const sentence = screen.getByTestId('sidebar-model-chip-detail').textContent ?? '';
    expect(sentence.length).toBeGreaterThan(0);
    expect(chip).toHaveAccessibleDescription(sentence);
    unmount();

    render(<Shell collapsed />);
    const btn = screen.getByRole('button', { name: 'Model: Local · Google Gemma 4 E2B-it. Open model settings' });
    const railSentence = screen.getByTestId('sidebar-model-chip-detail');
    expect(railSentence).toHaveAttribute('hidden');
    expect(railSentence.textContent).toBe(sentence);
    expect(btn).toHaveAccessibleDescription(sentence);
  });

  it('drawer (<= 768px): choosing the chip opens settings and closes the drawer', () => {
    mediaRestore?.();
    stubMatchMedia(true);
    const onOpen = vi.fn();
    render(<Shell onOpen={onOpen} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    });
    const chip = screen.getByTestId('sidebar-model-chip');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The drawer closes (its sidebar is hidden; the menu button reports collapsed).
    expect(chip.closest('[hidden]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  // Review round 2 (MEDIUM): the sidebar stays mounted while the user edits the
  // endpoint in Settings, so the chip must follow saves without a remount.
  it('updates when the endpoint is saved while the chip stays mounted (same tab)', () => {
    render(<Shell />);
    const chip = screen.getByTestId('sidebar-model-chip');
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    act(() => {
      saveExternalConfig({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'model-two' });
    });
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('127.0.0.1:1234 · model-two');
    act(() => {
      saveExternalConfig({ enabled: false });
    });
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('Local · Google Gemma 4 E2B-it');
  });

  it('updates when another tab changes the stored config (storage event)', () => {
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    act(() => {
      localStorage.setItem(
        'external-provider-config',
        JSON.stringify({ enabled: true, protocol: 'anthropic', baseUrl: 'http://127.0.0.1:8080', model: 'other-tab', grounded: true, rememberKey: false })
      );
      window.dispatchEvent(new StorageEvent('storage', { key: 'external-provider-config' }));
    });
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('127.0.0.1:8080 · other-tab');
  });

  // Final-critic note: Settings > Clear Cache removes the external config; the chip
  // must reflect that immediately, not only after the post-clear reload.
  it('reverts to the local model as soon as Clear Cache removes the external config', () => {
    saveExternalConfig({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'cached-model' });
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('127.0.0.1:1234 · cached-model');
    act(() => {
      clearUserSettings();
      clearSessionSettings();
    });
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('Local · Google Gemma 4 E2B-it');
  });
});

/**
 * Review L1: in drawer layouts the destination's heading must end up focused, not
 * <main>. Real AppShell + real chip; the destination mimics SettingsPage (mounts the
 * model-connection section and focuses its heading from its own effect, via the
 * shared focusSettingsSection helper SettingsPage also uses).
 */
function SettingsDestination({ request }: { request: number }) {
  useEffect(() => {
    focusSettingsSection(MODEL_CONNECTION_SECTION_ID);
  }, [request]);
  return (
    <section id={MODEL_CONNECTION_SECTION_ID}>
      <h2 tabIndex={-1}>Model &amp; connection</h2>
    </section>
  );
}
function ShellWithDestination({ failToFocus = false }: { failToFocus?: boolean }) {
  const [request, setRequest] = useState(0);
  return (
    <AppShell
      productName="TrainingApp"
      collapsed={false}
      onToggleCollapsed={() => {}}
      sidebar={<SidebarConnectionChip onOpenModelSettings={() => setRequest((n) => n + 1)} />}
    >
      {request > 0 && !failToFocus ? <SettingsDestination request={request} /> : <h1>page</h1>}
    </AppShell>
  );
}

describe('SidebarConnectionChip drawer focus (review L1)', () => {
  it('drawer: clicking the chip leaves focus on the Model & connection heading, not <main>', () => {
    mediaRestore?.();
    stubMatchMedia(true);
    render(<ShellWithDestination />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-model-chip'));
    });
    const heading = screen.getByRole('heading', { name: 'Model & connection' });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement?.tagName).not.toBe('MAIN');
  });

  it('drawer: falls back to <main> when the destination section is not rendered (phase 3 behaviour)', () => {
    mediaRestore?.();
    stubMatchMedia(true);
    render(<ShellWithDestination failToFocus />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-model-chip'));
    });
    expect(document.activeElement?.tagName).toBe('MAIN');
  });
});

describe('SidebarConnectionChip readiness (review L4)', () => {
  it('browser local, model not ready: says so in the text and the accessible name (label-in-name)', () => {
    setModelReady(false);
    render(<Shell />);
    const chip = screen.getByTestId('sidebar-model-chip');
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it — not ready');
    expect(chip).toHaveAccessibleName('Model: Local · Google Gemma 4 E2B-it — not ready. Open model settings');
  });

  it('browser local, model ready: unchanged text', () => {
    setModelReady(true);
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent(/^Local · Google Gemma 4 E2B-it$/);
  });

  it('desktop, no staged model for a real engine: not ready; external engine: never', () => {
    setMode('api');
    setDesktop({ engine: 'llama.cpp', profile: 'fast', models: { quality: { present: false }, fast: { present: false } } });
    const { unmount } = render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent('Desktop · Fast profile — not ready');
    unmount();
    setDesktop({ engine: 'external', profile: 'fast', models: { quality: { present: false }, fast: { present: false } } });
    render(<Shell />);
    expect(screen.getByTestId('sidebar-model-chip')).toHaveTextContent(/^External model$/);
  });

  it('rail: the not-ready state reaches the button name and tooltip', () => {
    setModelReady(false);
    render(<Shell collapsed />);
    const btn = screen.getByRole('button', { name: 'Model: Local · Google Gemma 4 E2B-it — not ready. Open model settings' });
    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Model: Local · Google Gemma 4 E2B-it — not ready');
  });
});

