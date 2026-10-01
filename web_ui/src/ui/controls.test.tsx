import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  PasswordInput,
  RadioCardGroup,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
  ICON_NAMES,
  Icon,
} from './index';

describe('Button', () => {
  it('is a native button defaulting to type=button and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('loading sets aria-busy + aria-disabled and blocks activation', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Saving' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('aria-disabled stays focusable but does not activate', async () => {
    const onClick = vi.fn();
    render(
      <Button aria-disabled="true" onClick={onClick}>
        Nope
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Nope' });
    await userEvent.tab();
    expect(btn).toHaveFocus();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies the variant class', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('ui-button--danger');
  });
});

describe('IconButton', () => {
  it('exposes its aria-label as accessible name and tooltip, icon is decorative', () => {
    render(<IconButton icon="plus" aria-label="New chat" />);
    const btn = screen.getByRole('button', { name: 'New chat' });
    expect(btn).toHaveAttribute('title', 'New chat');
    expect(btn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Icon', () => {
  it('renders every curated icon as an aria-hidden currentColor svg', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(svg?.children.length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe('Field', () => {
  it('associates label, help, and error with the control', () => {
    render(
      <Field label="API key" help="Stored locally" error="Required">
        {(c) => <TextInput {...c} />}
      </Field>
    );
    const input = screen.getByLabelText('API key');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Stored locally Required');
  });

  it('omits aria-invalid and describedby when there is no help or error', () => {
    render(<Field label="Name">{(c) => <TextInput {...c} />}</Field>);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('works with Select', async () => {
    render(
      <Field label="Protocol">
        {(c) => (
          <Select {...c} defaultValue="a">
            <option value="a">OpenAI-compatible</option>
            <option value="b">Anthropic-compatible</option>
          </Select>
        )}
      </Field>
    );
    const select = screen.getByRole('combobox', { name: 'Protocol' });
    await userEvent.selectOptions(select, 'b');
    expect(select).toHaveValue('b');
  });
});

describe('PasswordInput', () => {
  it('reveals and re-masks via a labelled toggle with aria-pressed', async () => {
    render(
      <Field label="Key">{(c) => <PasswordInput {...c} defaultValue="s3cret" />}</Field>
    );
    const input = screen.getByLabelText('Key');
    expect(input).toHaveAttribute('type', 'password');
    // The accessible name stays constant; state is conveyed by aria-pressed only.
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Switch and Checkbox', () => {
  it('Switch is a native checkbox with role=switch and a described label', async () => {
    const onChange = vi.fn();
    render(<Switch label="Use my documents" description="Grounded answers" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Use my documents' }); // exact: description excluded from the name
    expect(sw.tagName).toBe('INPUT');
    expect(sw).toHaveAttribute('type', 'checkbox');
    expect(sw).toHaveAccessibleDescription('Grounded answers');
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sw).toBeChecked();
  });

  it('Switch toggles with the keyboard', async () => {
    render(<Switch label="Telemetry" />);
    await userEvent.tab();
    expect(screen.getByRole('switch', { name: 'Telemetry' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('switch', { name: 'Telemetry' })).toBeChecked();
  });

  it('Checkbox exposes role=checkbox', async () => {
    render(<Checkbox label="Remember me" />);
    const cb = screen.getByRole('checkbox', { name: 'Remember me' });
    await userEvent.click(cb);
    expect(cb).toBeChecked();
  });
});

const OPTIONS = [
  { value: 'local', label: 'Built-in model', description: 'Runs on this device' },
  { value: 'server', label: 'Local or network server' },
  { value: 'cloud', label: 'Cloud provider', disabled: true },
];

function Controlled({ Group }: { Group: typeof SegmentedControl | typeof RadioCardGroup }) {
  const [v, setV] = useState('local');
  return <Group legend="Generator source" options={OPTIONS} value={v} onChange={setV} />;
}

describe.each([
  ['SegmentedControl', SegmentedControl],
  ['RadioCardGroup', RadioCardGroup],
])('%s', (_name, Group) => {
  it('is a fieldset/legend group of native radios', () => {
    render(<Controlled Group={Group} />);
    expect(screen.getByRole('group', { name: 'Generator source' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Built-in model/ })).toBeChecked();
  });

  it('changes selection on click and arrow keys, and respects disabled', async () => {
    render(<Controlled Group={Group} />);
    await userEvent.click(screen.getByRole('radio', { name: /Local or network server/ }));
    expect(screen.getByRole('radio', { name: /Local or network server/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Built-in model/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Cloud provider/ })).toBeDisabled();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: /Built-in model/ })).toBeChecked();
  });
});

describe('Switch and Checkbox caller ARIA', () => {
  it('merges caller aria-labelledby/aria-describedby ids with its own', () => {
    render(
      <>
        <span id="ext-label">Extra label</span>
        <span id="ext-err">Extra error</span>
        <Switch label="Sync" description="Keeps devices equal" aria-labelledby="ext-label" aria-describedby="ext-err" />
        <Checkbox label="Agree" description="Terms" aria-labelledby="ext-label" aria-describedby="ext-err" />
      </>
    );
    for (const role of ['switch', 'checkbox'] as const) {
      const el = screen.getByRole(role);
      expect(el).toHaveAccessibleName(/Extra label/);
      expect(el).toHaveAccessibleName(/(Sync|Agree)/);
      expect(el.getAttribute('aria-describedby')?.split(' ')).toContain('ext-err');
      expect(el).toHaveAccessibleDescription(/Extra error/);
      expect(el).toHaveAccessibleDescription(/(Keeps devices equal|Terms)/);
    }
  });

  it('keeps a caller aria-describedby when there is no description prop', () => {
    render(
      <>
        <span id="ext-err">Required</span>
        <Switch label="Sync" aria-describedby="ext-err" />
      </>
    );
    expect(screen.getByRole('switch')).toHaveAttribute('aria-describedby', 'ext-err');
  });
});

describe('RadioCardGroup ids', () => {
  it('keeps name and description wiring for option values containing whitespace', () => {
    render(
      <RadioCardGroup
        legend="Engine"
        value="a b"
        onChange={() => {}}
        options={[
          { value: 'a b', label: 'Spaced', description: 'Has a space' },
          { value: 'c	d', label: 'Tabbed', description: 'Has a tab' },
        ]}
      />
    );
    const spaced = screen.getByRole('radio', { name: 'Spaced' });
    expect(spaced).toHaveAccessibleDescription('Has a space');
    expect(spaced.getAttribute('aria-describedby')).not.toMatch(/\s/);
    expect(spaced.getAttribute('aria-labelledby')).not.toMatch(/\s/);
    expect(screen.getByRole('radio', { name: 'Tabbed' })).toHaveAccessibleDescription('Has a tab');
  });
});

describe('RadioCardGroup selection cue', () => {
  it('radio accessible name is the label only; description is the description', () => {
    render(<Controlled Group={RadioCardGroup} />);
    const r = screen.getByRole('radio', { name: 'Built-in model' });
    expect(r).toHaveAccessibleDescription('Runs on this device');
  });

  it('marks the checked card with the non-color .ui-selected hook', () => {
    render(<Controlled Group={RadioCardGroup} />);
    const checked = screen.getByRole('radio', { name: /Built-in model/ });
    expect(checked.closest('label')).toHaveClass('ui-selected');
    expect(screen.getByRole('radio', { name: /Local or network server/ }).closest('label')).not.toHaveClass(
      'ui-selected'
    );
  });
});
