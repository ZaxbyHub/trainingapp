import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it("placement 'end' renders beside the trigger and skips the below-trigger viewport shift", async () => {
    render(
      <Tooltip content="Documents" placement="end">
        <button type="button" aria-label="Documents">D</button>
      </Tooltip>
    );
    await userEvent.tab();
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveClass('ui-tooltip', 'ui-tooltip--end');
    expect(tip.style.getPropertyValue('--ui-tooltip-shift')).toBe('');
  });

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

  it('Escape closes only the tooltip, not an enclosing Dialog; with no tooltip shown it closes the Dialog', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Host">
        <Tooltip content="Hint">
          <Button>Trigger</Button>
        </Tooltip>
      </Dialog>
    );
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    trigger.focus();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('merges the child aria-describedby with the tooltip id instead of replacing it', async () => {
    render(
      <>
        <span id="help">Field help</span>
        <Tooltip content="Hint">
          <Button aria-describedby="help">Trigger</Button>
        </Tooltip>
      </>
    );
    const btn = screen.getByRole('button', { name: 'Trigger' });
    expect(btn).toHaveAttribute('aria-describedby', 'help');
    await userEvent.tab();
    expect(btn.getAttribute('aria-describedby')?.split(' ')).toContain('help');
    expect(btn).toHaveAccessibleDescription(/Field help/);
    expect(btn).toHaveAccessibleDescription(/Hint/);
  });

  it('does not expose the tooltip as a description when it repeats the trigger aria-label', async () => {
    render(
      <Tooltip content="Show password">
        <Button aria-label="Show password">i</Button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Show password' });
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Show password'); // still visible
    expect(btn).not.toHaveAttribute('aria-describedby');
  });

  it('does not expose the tooltip as a description when it repeats the text of the aria-labelledby name', async () => {
    render(
      <>
        <span id="lbl-a">Copy</span> <span id="lbl-b">link</span>
        <Tooltip content="Copy link">
          <Button aria-labelledby="lbl-a lbl-b">i</Button>
        </Tooltip>
      </>
    );
    const btn = screen.getByRole('button', { name: 'Copy link' });
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Copy link');
    expect(btn).not.toHaveAttribute('aria-describedby');
  });

  it('still describes an aria-labelledby trigger when the text differs from its name', async () => {
    render(
      <>
        <span id="lbl">Copy</span>
        <Tooltip content="Copies the share link">
          <Button aria-labelledby="lbl">i</Button>
        </Tooltip>
      </>
    );
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveAccessibleDescription('Copies the share link');
  });

  it('dismisses on a pointer-down outside the trigger (hover-shown, no mouseleave)', async () => {
    render(
      <>
        <Tooltip content="Hint">
          <Button>Hover me</Button>
        </Tooltip>
        <p>elsewhere</p>
      </>
    );
    await userEvent.hover(screen.getByRole('button', { name: 'Hover me' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('keeps the tooltip on a pointer-down inside the trigger', async () => {
    render(
      <Tooltip content="Hint">
        <Button>Hover me</Button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Hover me' });
    await userEvent.hover(btn);
    fireEvent.pointerDown(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('dismisses when focus moves elsewhere without a blur on the trigger', async () => {
    render(
      <>
        <Tooltip content="Hint">
          <Button>Hover me</Button>
        </Tooltip>
        <input aria-label="other" />
      </>
    );
    await userEvent.hover(screen.getByRole('button', { name: 'Hover me' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => screen.getByLabelText('other').focus());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows the tooltip for a trigger that is already disabled (the "why is this disabled" pattern)', () => {
    render(
      <Tooltip content="Add a document first">
        <Button disabled>Ask</Button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Ask' });
    // Disabled buttons receive no pointer events; the wrapper span does.
    fireEvent.mouseEnter(btn.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Add a document first');
    expect(btn).toHaveAccessibleDescription('Add a document first');
  });

  it('dismisses when the trigger stops rendering (the tooltip span must not be mistaken for it)', async () => {
    function Maybe({ show }: { show: boolean }) {
      return show ? <Button>Gone soon</Button> : null;
    }
    function Harness() {
      const [show, setShow] = useState(true);
      return (
        <>
          <Tooltip content="Hint">
            {/* Tooltip clones its child: Maybe forwards nothing, which is fine for this case. */}
            <Maybe show={show} />
          </Tooltip>
          <button type="button" onClick={() => setShow(false)}>
            Remove
          </button>
        </>
      );
    }
    render(<Harness />);
    await userEvent.hover(screen.getByRole('button', { name: 'Gone soon' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: 'Gone soon' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('aria-labelledby takes precedence over aria-label for the duplicate decision', async () => {
    render(
      <>
        <span id="lbl">Copy link</span>
        <Tooltip content="Copy">
          <Button aria-labelledby="lbl" aria-label="Copy">
            i
          </Button>
        </Tooltip>
      </>
    );
    const btn = screen.getByRole('button', { name: 'Copy link' });
    await userEvent.tab();
    // The name is "Copy link" (labelledby wins), so "Copy" is NOT a duplicate and still describes.
    expect(btn).toHaveAccessibleDescription('Copy');
  });

  it('dismisses when the focused trigger becomes disabled (browsers fire no blur)', async () => {
    function Harness() {
      const [disabled, setDisabled] = useState(false);
      return (
        <>
          <Tooltip content="Hint">
            <Button disabled={disabled}>Save</Button>
          </Tooltip>
          <button type="button" onClick={() => setDisabled(true)}>
            Disable
          </button>
        </>
      );
    }
    render(<Harness />);
    const save = screen.getByRole('button', { name: 'Save' });
    await userEvent.tab();
    expect(save).toHaveFocus();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    // Programmatic click keeps focus on Save (a user click would blur it and mask the case).
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect(save).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('still describes the trigger when the text differs from its aria-label', async () => {
    render(
      <Tooltip content="Reveals the key on screen">
        <Button aria-label="Show password">i</Button>
      </Tooltip>
    );
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAccessibleDescription('Reveals the key on screen');
  });

  it('applies the viewport-collision shift to the shown tooltip', async () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 398, right: 514, top: 0, bottom: 20, width: 116, height: 20, x: 398, y: 0, toJSON: () => ({}) });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 500 });
    try {
      render(
        <Tooltip content="Edge">
          <Button>Edge</Button>
        </Tooltip>
      );
      await userEvent.tab();
      expect(screen.getByRole('tooltip').style.getPropertyValue('--ui-tooltip-shift')).toBe('-22px');
    } finally {
      spy.mockRestore();
      Reflect.deleteProperty(document.documentElement, 'clientWidth');
    }
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

describe('Tabs edge cases', () => {
  it('does not throw when every tab is disabled', async () => {
    render(
      <Tabs
        label="None"
        value="a"
        onChange={() => {}}
        items={[
          { id: 'a', label: 'A', panel: <p>a</p>, disabled: true },
          { id: 'b', label: 'B', panel: <p>b</p>, disabled: true },
        ]}
      />
    );
    // React reports handler exceptions through window 'error', not as a rejected call.
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      e.preventDefault();
      errors.push(e.error);
    };
    window.addEventListener('error', onError);
    screen.getByRole('tab', { name: 'A' }).focus();
    await userEvent.keyboard('{ArrowRight}{ArrowLeft}{Home}{End}');
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('keeps the tablist reachable when value matches no tab', async () => {
    const onChange = vi.fn();
    render(<Tabs label="Lost" value="nope" onChange={onChange} items={ITEMS} />);
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('tabindex', '-1');
    await userEvent.tab();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('docs'); // no current tab: ArrowRight lands on the first enabled one
  });

  it('falls back to the first ENABLED tab when the first item is disabled', () => {
    render(
      <Tabs
        label="Skip"
        value="zzz"
        onChange={() => {}}
        items={[
          { id: 'x', label: 'X', panel: null, disabled: true },
          { id: 'y', label: 'Y', panel: null },
        ]}
      />
    );
    expect(screen.getByRole('tab', { name: 'Y' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'X' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('Tabs ids', () => {
  it('builds id/aria-controls/aria-labelledby from the index, so ids with whitespace stay valid IDREFs', () => {
    render(
      <Tabs
        label="Odd"
        value="a b"
        onChange={() => {}}
        items={[
          { id: 'a b', label: 'Spaced', panel: <p>one</p> },
          { id: 'c\td', label: 'Tabbed', panel: <p>two</p> },
        ]}
      />
    );
    const tab = screen.getByRole('tab', { name: 'Spaced' });
    expect(tab.id).not.toMatch(/\s/);
    const panel = screen.getByRole('tabpanel', { name: 'Spaced' });
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.id).not.toMatch(/\s/);
    expect(screen.getByRole('tab', { name: 'Tabbed' }).id).not.toMatch(/\s/);
  });
});
