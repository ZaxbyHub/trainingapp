import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ModelChip } from './ModelChip';
import type { ChatModelDescription } from '../lib/chat/model-chip';

const local: ChatModelDescription = {
  kind: 'local',
  source: 'Local',
  model: 'Google Gemma 4 E2B-it',
  host: null,
  detail: 'Runs on this computer in the app (wllama engine).',
};

describe('ModelChip', () => {
  it('is a button whose name contains the visible text (label-in-name) and opens settings', () => {
    const onOpen = vi.fn();
    render(<ModelChip description={local} onOpenSettings={onOpen} />);
    const chip = screen.getByRole('button', { name: 'Model: Local · Google Gemma 4 E2B-it. Open model settings' });
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    expect(chip).toHaveAttribute('title', local.detail);
    expect(chip).toHaveAttribute('data-kind', 'local');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('names only the mode when there is no reliable model name', () => {
    render(
      <ModelChip
        description={{ kind: 'desktop-external', source: 'External model', model: null, host: null, detail: 'd' }}
        onOpenSettings={() => {}}
      />
    );
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveTextContent(/^External model$/);
    expect(chip).toHaveAccessibleName('Model: External model. Open model settings');
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
