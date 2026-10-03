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
