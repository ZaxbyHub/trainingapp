import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, Tabs, Tooltip, type TabItem } from './index';

function DialogHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Confirm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary">OK</Button>
          </>
        }
      >
        Are you sure?
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="Hidden" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a modal dialog named by its title', async () => {
    render(<DialogHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Are you sure?');
  });

  it('alert renders role=alertdialog', () => {
    render(<Dialog open alert onClose={() => {}} title="Model not ready" />);
    expect(screen.getByRole('alertdialog', { name: 'Model not ready' })).toBeInTheDocument();
  });

  it('moves focus in on open, traps Tab and Shift+Tab, returns focus on close', async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const ok = screen.getByRole('button', { name: 'OK' });
    expect(cancel).toHaveFocus();
    await userEvent.tab();
    expect(ok).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus(); // wrapped, not escaped to the page
    await userEvent.tab({ shift: true });
    expect(ok).toHaveFocus(); // wrapped backwards
    await userEvent.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Escape calls onClose and closes; focus returns to the opener', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('backdrop click closes but clicks inside the panel do not', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(screen.getByText('Are you sure?'));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
    await userEvent.pointer({ keys: '[MouseLeft]', target: backdrop });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the panel itself when it has no focusable content', () => {
    render(<Dialog open onClose={() => {}} title="Info" />);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});

describe('Tooltip', () => {
  it('appears on keyboard focus, describes the trigger, and Escape dismisses', async () => {
    render(
      <Tooltip content="Copy to clipboard">
        <Button>Copy</Button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Copy' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await userEvent.tab();
    expect(btn).toHaveFocus();
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Copy to clipboard');
    expect(btn).toHaveAccessibleDescription('Copy to clipboard');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('appears on hover and hides on leave', async () => {
    render(
      <Tooltip content="Hint">
        <Button>Hover me</Button>
      </Tooltip>
    );
    await userEvent.hover(screen.getByRole('button', { name: 'Hover me' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await userEvent.unhover(screen.getByRole('button', { name: 'Hover me' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

const ITEMS: TabItem[] = [
  { id: 'docs', label: 'Documents', panel: <p>docs panel</p> },
  { id: 'packs', label: 'Training packs', panel: <p>packs panel</p> },
  { id: 'off', label: 'Disabled', panel: <p>never</p>, disabled: true },
  { id: 'more', label: 'More', panel: <p>more panel</p> },
];

function TabsHarness() {
  const [v, setV] = useState('docs');
  return <Tabs label="Library" items={ITEMS} value={v} onChange={setV} />;
}

describe('Tabs', () => {
  it('exposes tablist/tab/tabpanel with selection and roving tabindex', () => {
    render(<TabsHarness />);
    expect(screen.getByRole('tablist', { name: 'Library' })).toBeInTheDocument();
    const docs = screen.getByRole('tab', { name: 'Documents' });
    const packs = screen.getByRole('tab', { name: 'Training packs' });
    expect(docs).toHaveAttribute('aria-selected', 'true');
    expect(docs).toHaveAttribute('tabindex', '0');
    expect(packs).toHaveAttribute('aria-selected', 'false');
    expect(packs).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel', { name: 'Documents' });
    expect(panel).toHaveTextContent('docs panel');
    expect(docs).toHaveAttribute('aria-controls', panel.id);
  });

  it('click activates a tab and swaps the panel', async () => {
    render(<TabsHarness />);
    await userEvent.click(screen.getByRole('tab', { name: 'Training packs' }));
    expect(screen.getByRole('tabpanel', { name: 'Training packs' })).toHaveTextContent('packs panel');
    expect(screen.queryByText('docs panel')).not.toBeInTheDocument();
  });

  it('arrow keys, Home and End move selection and focus, skipping disabled tabs', async () => {
    render(<TabsHarness />);
    await userEvent.tab();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'More' })).toHaveFocus(); // skipped "Disabled"
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveFocus(); // wraps
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'More' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'More' })).toHaveFocus(); // wraps backwards
  });

  it('a disabled tab does not activate on click', async () => {
    render(<TabsHarness />);
    await userEvent.click(screen.getByRole('tab', { name: 'Disabled' }));
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  });
});
