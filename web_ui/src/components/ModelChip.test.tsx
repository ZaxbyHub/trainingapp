import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ModelChip } from './ModelChip';
import type { ChatModelDescription } from '../lib/chat/model-chip';

/** Anchored match: the sentence exactly once (the Tooltip is describe={false}, so it adds nothing). */
const onceRegExp = (s: string) => ({ asymmetricMatch: (v: unknown) => typeof v === 'string' && v.trim() === s });

const local: ChatModelDescription = {
  kind: 'local',
  source: 'Local',
  model: 'Google Gemma 4 E2B-it',
  host: null,
  detail: 'Runs on this computer in the app (wllama engine).',
  notReady: false,
};

describe('ModelChip', () => {
  it('is a button whose name contains the visible text (label-in-name) and opens settings', () => {
    const onOpen = vi.fn();
    render(<ModelChip description={local} onOpenSettings={onOpen} />);
    const chip = screen.getByRole('button', { name: 'Model: Local · Google Gemma 4 E2B-it. Open model settings' });
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    expect(chip).toHaveAttribute('data-kind', 'local');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('PRR-119: the detail sentence is exposed as the accessible description, not only via title', () => {
    render(<ModelChip description={local} onOpenSettings={() => {}} />);
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveAccessibleDescription(local.detail);
    expect(screen.getByTestId('chat-model-chip-detail')).toHaveAttribute('hidden');
    // The accessible name is unchanged (the hidden node is a description, not part of the name).
    expect(chip).toHaveAccessibleName('Model: Local · Google Gemma 4 E2B-it. Open model settings');
  });

  it('R3-1: focus shows the sentence in a tooltip, the native title is gone, and the description is still exactly the sentence', () => {
    render(<ModelChip description={local} onOpenSettings={() => {}} />);
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).not.toHaveAttribute('title');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(chip);
    expect(screen.getByRole('tooltip')).toHaveTextContent(local.detail);
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(local.detail);
    // Tooltip is describe={false}: described by the hidden node only, once.
    expect(chip).toHaveAccessibleDescription(onceRegExp(local.detail));
  });

  it('PRR-119: the static (no settings link) chip also carries the sentence as its description', () => {
    render(<ModelChip description={local} testId="static-chip" />);
    expect(screen.getByTestId('static-chip')).toHaveAccessibleDescription(local.detail);
  });

  it('names only the mode when there is no reliable model name', () => {
    render(
      <ModelChip
        description={{ kind: 'desktop-external', source: 'External model', model: null, host: null, detail: 'd', notReady: false }}
        onOpenSettings={() => {}}
      />
    );
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveTextContent(/^External model$/);
    expect(chip).toHaveAccessibleName('Model: External model. Open model settings');
  });

  it('not ready: the suffix is in the visible text and the accessible name (label-in-name)', () => {
    render(<ModelChip description={{ ...local, notReady: true }} onOpenSettings={() => {}} />);
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it — not ready');
    expect(chip).toHaveAccessibleName('Model: Local · Google Gemma 4 E2B-it — not ready. Open model settings');
  });

  it('not ready: the suffix is its own non-truncating element, outside the truncating name node', () => {
    render(<ModelChip description={{ ...local, notReady: true }} onOpenSettings={() => {}} />);
    const name = screen.getByTestId('chat-model-chip-name');
    const suffix = screen.getByTestId('chat-model-chip-suffix');
    expect(suffix).toHaveTextContent('— not ready');
    expect(name).not.toContainElement(suffix);
    expect(suffix).not.toContainElement(name);
    expect(name).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    expect(name).not.toHaveTextContent('not ready');
    expect(suffix.className).toBe('chat-model-chip__suffix');
  });

  it('ready: no suffix element', () => {
    render(<ModelChip description={local} onOpenSettings={() => {}} />);
    expect(screen.queryByTestId('chat-model-chip-suffix')).toBeNull();
  });

  it('renders static text (not a button) without an open handler', () => {
    render(<ModelChip description={local} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('chat-model-chip')).toHaveTextContent('Local · Google Gemma 4 E2B-it');
  });
});

// Review F6: credentials in a configured endpoint URL (userinfo, path, query) and a
// stored API key never reach any surface of the chip: text, title, aria-label.
describe('ModelChip never exposes endpoint credentials', () => {
  it('https://user:secret@host/v1?api_key=X with a stored key shows only host + model', async () => {
    const { describeChatModel } = await import('../lib/chat/model-chip');
    const { DEFAULT_EXTERNAL_CONFIG } = await import('../lib/llm/external-provider');
    const endpointPolicy = await import('../lib/llm/endpoint-policy');
    // Keep the endpoint "active" regardless of policy, so the external branch is what
    // is under test (otherwise the chip would fall back to Local and pass vacuously).
    const spy = vi.spyOn(endpointPolicy, 'validateEndpointUrl').mockReturnValue({ ok: true } as ReturnType<
      typeof endpointPolicy.validateEndpointUrl
    >);
    try {
      const d = describeChatModel({
        mode: 'browser-local',
        hasDesktopSession: false,
        desktopModels: null,
        residentProfile: null,
        externalConfig: {
          ...DEFAULT_EXTERNAL_CONFIG,
          enabled: true,
          protocol: 'openai',
          baseUrl: 'https://user:secret@llm.example.com/v1?api_key=X-KEY-IN-QUERY',
          model: 'gpt-x',
          apiKey: 'sk-STORED-KEY-123',
        },
        browserEngine: 'wllama',
        wllamaModelId: 'gemma-4-e2b-it',
        webllmModelId: 'w',
      });
      expect(d.kind).toBe('external');
      render(<ModelChip description={d} onOpenSettings={() => {}} />);
      const chip = screen.getByTestId('chat-model-chip');
      expect(chip).toHaveTextContent('llm.example.com · gpt-x');
      const surfaces = [chip.textContent ?? '', chip.getAttribute('title') ?? '', chip.getAttribute('aria-label') ?? ''];
      for (const surface of surfaces) {
        for (const secret of ['user', 'secret', '/v1', 'api_key', 'X-KEY-IN-QUERY', 'sk-STORED-KEY-123', '@']) {
          expect(surface).not.toContain(secret);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });
});
