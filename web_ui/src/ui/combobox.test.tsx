import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, Field, PasswordInput } from './index';

function Harness({ options = ['llama-3', 'qwen-2.5', 'gpt-4.1'], onBlur }: { options?: string[]; onBlur?: () => void }) {
  const [value, setValue] = useState('');
  return (
    <Field label="Model">
      {(c) => <Combobox {...c} value={value} onValueChange={setValue} options={options} onBlur={onBlur} emptyText="No models" />}
    </Field>
  );
}

describe('Combobox (ARIA 1.2 editable combobox, listbox popup)', () => {
  it('is a labelled combobox that controls a listbox, collapsed at rest', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
    expect(list).toHaveAttribute('role', 'listbox');
    expect(list).not.toBeVisible();
  });

  it('ArrowDown opens, arrows move aria-activedescendant (wrapping), Enter picks; focus never leaves the input', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['llama-3', 'qwen-2.5', 'gpt-4.1']);
    // L3: the value matches nothing, so opening highlights nothing (no silent option 0).
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', options[2].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('qwen-2.5');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(input).toHaveFocus();
  });

  it('typing filters (case-insensitive substring) and free text is kept', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.change(input, { target: { value: 'QW' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['qwen-2.5']);
    fireEvent.change(input, { target: { value: 'my-custom-model' } });
    expect(input).toHaveValue('my-custom-model');
    // No match: the empty row is shown, disabled and unselectable.
    const empty = screen.getByRole('option');
    expect(empty).toHaveTextContent('No models');
    expect(empty).toHaveAttribute('aria-disabled', 'true');
  });

  it('when the text equals a suggestion the whole list is offered, with that option selected', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.change(input, { target: { value: 'gpt-4.1' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[2].id);
  });

  it('Escape closes an open list (and is consumed); a closed list lets Escape through', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => outer(e.key)}>
        <Harness />
      </div>,
    );
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(outer).not.toHaveBeenCalledWith('Escape');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(outer).toHaveBeenCalledWith('Escape');
  });

  it('pointer: mousedown on an option picks it without blurring the input', () => {
    const onBlur = vi.fn();
    render(<Harness onBlur={onBlur} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    input.focus();
    fireEvent.click(input);
    const option = screen.getByRole('option', { name: 'llama-3' });
    const notPrevented = fireEvent.mouseDown(option);
    expect(notPrevented).toBe(false); // default prevented: focus stays in the input
    expect(input).toHaveValue('llama-3');
    expect(onBlur).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('with no suggestions and no empty text, it never expands (a plain text field)', () => {
    render(
      <Field label="Model">
        {(c) => <Combobox {...c} value="" onValueChange={() => undefined} options={[]} />}
      </Field>,
    );
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Combobox review round 3 (L3)', () => {
  function Controlled({ options, onPick }: { options: string[]; onPick?: (v: string) => void }) {
    const [value, setValue] = useState('');
    return (
      <Field label="Model">
        {(c) => <Combobox {...c} value={value} onValueChange={setValue} options={options} onPick={onPick} />}
      </Field>
    );
  }

  it('onPick fires for Enter on a highlighted option and for a click, never for typing', () => {
    const onPick = vi.fn();
    render(<Controlled options={['a-model', 'b-model']} onPick={onPick} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.change(input, { target: { value: 'b' } });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('b-model');
    fireEvent.click(input);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'a-model' }));
    expect(onPick).toHaveBeenLastCalledWith('a-model');
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it('a highlight past the end of a shrunk list is dropped (no stale aria-activedescendant)', () => {
    render(<Controlled options={['alpha', 'beta', 'gamma']} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // wraps to the last option (index 2)
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-opt-2$/);
    fireEvent.change(input, { target: { value: 'al' } }); // one option left
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('duplicate option names render as separate rows (index keys)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Controlled options={['same', 'same', 'other']} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['same', 'same', 'other']);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });
});

describe('PasswordInput revealLabel', () => {
  it('names the reveal toggle from revealLabel (default stays "Show password")', () => {
    render(<Field label="API key">{(c) => <PasswordInput {...c} revealLabel="Show API key" />}</Field>);
    expect(screen.getByRole('button', { name: 'Show API key' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Show password' })).toBeNull();
  });
});
