/**
 * SettingsControls (Lumen phase 4): the markup contract the Settings page relies on
 * and the generic primitives do not expose (see the module header).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsRadioCards, SettingsSection } from './SettingsControls';

describe('SettingsSection', () => {
  it('is a region labelled by an h2 with the EXPLICIT heading id', () => {
    render(
      <SettingsSection title="Storage" headingId="storage-heading" description="Cache management" data-testid="s">
        <p>body</p>
      </SettingsSection>,
    );
    const region = screen.getByRole('region', { name: 'Storage' });
    expect(region).toHaveAttribute('aria-labelledby', 'storage-heading');
    expect(region).toHaveAttribute('data-testid', 's');
    const heading = screen.getByRole('heading', { level: 2, name: 'Storage' });
    expect(heading.id).toBe('storage-heading');
    expect(heading).not.toHaveAttribute('tabindex');
    expect(screen.getByText('Cache management')).toBeInTheDocument();
    expect(region).toContainElement(screen.getByText('body'));
  });

  it('focusableHeading makes the heading a programmatic focus target (tabIndex -1)', () => {
    render(
      <SettingsSection title="External model" headingId="h" focusableHeading id="model-connection">
        <span />
      </SettingsSection>,
    );
    const heading = screen.getByRole('heading', { name: 'External model' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    heading.focus();
    expect(heading).toHaveFocus();
    expect(document.getElementById('model-connection')).toContainElement(heading);
  });
});

const OPTIONS = [
  { value: 'fast', label: 'Fast', description: 'Quick answers', descriptionId: 'rag-fast-desc' },
  { value: 'quality', label: 'Quality', description: 'Best answers', descriptionId: 'rag-quality-desc' },
  { value: 'bare', label: 'Bare' },
] as const;

function renderCards(checked: string, onChange = vi.fn(), onOptionClick?: (v: string) => void) {
  render(
    <SettingsRadioCards<string>
      legend="Select preset"
      name="rag-preset"
      options={OPTIONS}
      isChecked={(v) => v === checked}
      onChange={onChange}
      onOptionClick={onOptionClick}
    />,
  );
  return onChange;
}

describe('SettingsRadioCards', () => {
  it('renders native radios with the given name, values and a hidden legend as the group name', () => {
    renderCards('fast');
    expect(screen.getByRole('group', { name: 'Select preset' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    for (const r of radios) {
      expect(r.tagName).toBe('INPUT');
      expect(r).toHaveAttribute('name', 'rag-preset');
    }
    expect(document.querySelector('input[name="rag-preset"][value="quality"]')).not.toBeNull();
  });

  it('names each radio by its title only and describes it by the fixed description id (a <p>)', () => {
    renderCards('fast');
    const quality = screen.getByRole('radio', { name: 'Quality' });
    expect(quality).toHaveAccessibleDescription('Best answers');
    expect(quality).toHaveAttribute('aria-describedby', 'rag-quality-desc');
    const desc = document.getElementById('rag-quality-desc');
    expect(desc?.tagName).toBe('P');
    // desktop/e2e/settings-layout.spec.ts: the label's first span is the title alone.
    const label = quality.closest('label');
    expect(label?.querySelector('span')?.textContent).toBe('Quality');
    expect(label?.querySelector('p')).toBe(desc);
    // An option without a description has no dangling aria-describedby.
    expect(screen.getByRole('radio', { name: 'Bare' })).not.toHaveAttribute('aria-describedby');
  });

  it('marks the checked card selected (class + native checked), others not', () => {
    renderCards('quality');
    const quality = screen.getByRole('radio', { name: 'Quality' });
    expect(quality).toBeChecked();
    expect(quality.closest('label')).toHaveClass('ui-radio-card', 'ui-selected');
    expect(screen.getByRole('radio', { name: 'Fast' }).closest('label')).not.toHaveClass('ui-selected');
  });

  it('onChange fires once for a newly selected card; onOptionClick fires for an already-checked one', () => {
    const onOptionClick = vi.fn();
    const onChange = renderCards('quality', vi.fn(), onOptionClick);
    fireEvent.click(screen.getByRole('radio', { name: 'Fast' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('fast');
    onChange.mockClear();
    onOptionClick.mockClear();
    // A checked radio fires no change event: only the click hook sees the re-selection.
    fireEvent.click(screen.getByRole('radio', { name: 'Quality' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onOptionClick).toHaveBeenCalledWith('quality');
  });

  it('a checked but disabled option stays focusable (aria-disabled, not native disabled) and is not changed by a click', () => {
    const onChange = vi.fn();
    render(
      <SettingsRadioCards<string>
        legend="Source"
        name="src"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C', disabled: true },
        ]}
        isChecked={(v) => v === 'b'}
        onChange={onChange}
      />,
    );
    const b = screen.getByRole('radio', { name: 'B' });
    expect(b).toBeChecked();
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).not.toHaveAttribute('disabled');
    expect(b.closest('label')).toHaveClass('ui-selected', 'ui-disabled');
    // An unchecked disabled option is natively disabled.
    expect(screen.getByRole('radio', { name: 'C' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'C' })).not.toHaveAttribute('aria-disabled');
    b.focus();
    expect(b).toHaveFocus();
    fireEvent.click(b);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('allows no option to be checked (desktop preset state not read yet)', () => {
    renderCards('none');
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
  });
});
