import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { createRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, Tabs, ToastProvider, Tooltip, useToast, type TabItem } from './index';

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

describe('Dialog (blocking-overlay options)', () => {
  it('dismissible=false: Escape does nothing, is default-prevented, and never reaches a parent or window listener', () => {
    const onKeyDown = vi.fn();
    const onWindowKey = vi.fn();
    const onClose = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    const { unmount } = render(
      <div onKeyDown={onKeyDown}>
        <Dialog open alert onClose={() => {}} title="x" />
        {/* @ts-expect-error onClose is rejected with dismissible={false} (it could never be called); kept to pin the runtime too */}
        <Dialog open alert dismissible={false} onClose={onClose} title="Blocked" footer={<Button>Go</Button>} />
      </div>
    );
    // dismissible Dialog without onClose must not throw either.
    const blocked = screen.getByRole('alertdialog', { name: 'Blocked' });
    const go = screen.getByRole('button', { name: 'Go' });
    expect(fireEvent.keyDown(go, { key: 'Escape' })).toBe(false); // preventDefault called
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(blocked).toBeInTheDocument();
    window.removeEventListener('keydown', onWindowKey);
    unmount();
  });

  it('dismissible=false: a backdrop press does not call onClose', () => {
    const onClose = vi.fn();
    // @ts-expect-error onClose is rejected with dismissible={false}; kept to pin the runtime too
    render(<Dialog open dismissible={false} onClose={onClose} title="Blocked" />);
    fireEvent.mouseDown(screen.getByTestId('ui-dialog-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Blocked' })).toBeInTheDocument();
  });

  it('a dismissible dialog must be given onClose (compile-time); without it Escape/backdrop are still safe no-ops', () => {
    // @ts-expect-error onClose is required unless dismissible={false}
    render(<Dialog open title="No handler" footer={<Button>Go</Button>} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Go' }), { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('ui-dialog-backdrop'));
    expect(screen.getByRole('dialog', { name: 'No handler' })).toBeInTheDocument();
  });

  it('closeOnBackdrop=false: a backdrop press does not close, Escape still does', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open closeOnBackdrop={false} onClose={onClose} title="W" footer={<Button>Go</Button>} />);
    fireEvent.mouseDown(screen.getByTestId('ui-dialog-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Go' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Dialog open onClose={onClose} title="W" footer={<Button>Go</Button>} />);
    fireEvent.mouseDown(screen.getByTestId('ui-dialog-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2); // default still closes on backdrop
  });

  it('modal=false does not trap Tab (edge presses are not default-prevented); modal does', () => {
    const { rerender } = render(
      <Dialog open modal={false} dismissible={false} title="P" footer={<><Button>A</Button><Button>B</Button></>} />
    );
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });
    expect(fireEvent.keyDown(a, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(b, { key: 'Tab' })).toBe(true);
    expect(a).toHaveFocus(); // untouched: the browser, not Dialog, moves focus
    rerender(<Dialog open dismissible={false} title="P" footer={<><Button>A</Button><Button>B</Button></>} />);
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'A' }), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'B' }), { key: 'Tab' })).toBe(false);
  });

  it('dismissible=false keeps the focus trap and returns focus on unmount', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Button onClick={() => setOpen(false)}>Lift</Button>
          <Dialog open={open} dismissible={false} title="Gate" footer={<><Button>A</Button><Button>B</Button></>} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });
    expect(a).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    expect(a).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(b).toHaveFocus();
    // Lift the gate from outside (programmatically): focus goes back to the opener.
    fireEvent.click(screen.getByRole('button', { name: 'Lift' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  describe('focus return on close', () => {
    function Host({ modal }: { modal: boolean }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Opener</Button>
          <Button>Elsewhere</Button>
          <Button onClick={() => setOpen(false)}>Lift</Button>
          <Dialog open={open} modal={modal} dismissible={false} title="G" footer={<Button>Inside</Button>} />
        </>
      );
    }

    // The return condition is modal-independent: pin both paths (PRR-151-059).
    it.each([false, true])('modal=%s: focus inside the dialog when it closes returns to the opener', async (modal) => {
      render(<Host modal={modal} />);
      const opener = screen.getByRole('button', { name: 'Opener' });
      await userEvent.click(opener);
      expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
      // Close programmatically while focus is still inside the panel.
      fireEvent.click(screen.getByRole('button', { name: 'Lift' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });

    it('StrictMode: a dialog mounted already open still returns focus to the opener on close', () => {
      // StrictMode's simulated unmount runs the cleanup while focus is inside the (still
      // mounted) panel; the cleanup must hand focus back so the re-run captures the real
      // opener, not a control inside the panel.
      function Mounted({ open }: { open: boolean }) {
        return <Dialog open={open} dismissible={false} modal={false} title="G" footer={<Button>Inside</Button>} />;
      }
      const opener = document.createElement('button');
      opener.textContent = 'Opener';
      document.body.appendChild(opener);
      opener.focus();
      // The opener lives outside RTL's container, so remove it in `finally`: a failure
      // here must not leave a stray button that breaks later tests in this file.
      try {
        const { rerender } = render(
          <React.StrictMode>
            <Mounted open />
          </React.StrictMode>
        );
        expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
        rerender(
          <React.StrictMode>
            <Mounted open={false} />
          </React.StrictMode>
        );
        expect(opener).toHaveFocus();
      } finally {
        opener.remove();
      }
    });

    it.each([false, true])('modal=%s: focus moved outside the dialog is NOT yanked back to the opener', async (modal) => {
      render(<Host modal={modal} />);
      await userEvent.click(screen.getByRole('button', { name: 'Opener' }));
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      elsewhere.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Lift' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Opener' }));
      expect(elsewhere).toHaveFocus(); // stays where the user put it
    });
  });

  it('modal=false omits aria-modal; the default keeps aria-modal="true"', () => {
    const { rerender } = render(<Dialog open modal={false} dismissible={false} title="Partial" />);
    expect(screen.getByRole('dialog', { name: 'Partial' })).not.toHaveAttribute('aria-modal');
    rerender(<Dialog open onClose={() => {}} title="Partial" />);
    expect(screen.getByRole('dialog', { name: 'Partial' })).toHaveAttribute('aria-modal', 'true');
  });

  it('contained renders in place (not in a body portal) with the contained backdrop; default portals to body', () => {
    const { container, rerender } = render(
      <div data-testid="region">
        <Dialog onClose={() => {}} open contained title="Here" />
      </div>
    );
    const region = screen.getByTestId('region');
    const backdrop = screen.getByTestId('ui-dialog-backdrop');
    expect(region.contains(backdrop)).toBe(true);
    expect(container.contains(backdrop)).toBe(true);
    expect(backdrop).toHaveClass('ui-dialog__backdrop--contained');
    rerender(
      <div data-testid="region">
        <Dialog onClose={() => {}} open title="Here" />
      </div>
    );
    const portaled = screen.getByTestId('ui-dialog-backdrop');
    expect(screen.getByTestId('region').contains(portaled)).toBe(false);
    expect(portaled.parentElement).toBe(document.body);
    expect(portaled).not.toHaveClass('ui-dialog__backdrop--contained');
  });

  it("initialFocus: 'first' (default) focuses the first control; 'panel' focuses the dialog itself", () => {
    const { rerender } = render(<Dialog onClose={() => {}} open title="T" footer={<Button>First</Button>} />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    rerender(<Dialog onClose={() => {}} open={false} title="T" />);
    rerender(<Dialog onClose={() => {}} open initialFocus="panel" title="T" footer={<Button>First</Button>} />);
    expect(screen.getByRole('dialog', { name: 'T' })).toHaveFocus();
  });

  it('initialFocus ref: focuses the referenced control; an unset ref falls back to the first control', () => {
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <Dialog
        onClose={() => {}}
        open
        initialFocus={ref}
        title="T"
        footer={
          <>
            <Button>First</Button>
            <button type="button" ref={ref}>
              Target
            </button>
          </>
        }
      />
    );
    expect(screen.getByRole('button', { name: 'Target' })).toHaveFocus();
    rerender(<Dialog onClose={() => {}} open={false} title="T" />);
    rerender(<Dialog onClose={() => {}} open initialFocus={createRef<HTMLElement>()} title="T" footer={<Button>First</Button>} />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('testId is set on the panel', () => {
    render(<Dialog onClose={() => {}} open testId="my-panel" title="T" />);
    expect(screen.getByTestId('my-panel')).toHaveAttribute('role', 'dialog');
  });

  it('layer: boot adds the boot modifier; default and contained do not', () => {
    const { rerender } = render(<Dialog onClose={() => {}} open layer="boot" title="T" />);
    expect(screen.getByTestId('ui-dialog-backdrop')).toHaveClass('ui-dialog__backdrop--boot');
    rerender(<Dialog onClose={() => {}} open title="T" />);
    expect(screen.getByTestId('ui-dialog-backdrop')).not.toHaveClass('ui-dialog__backdrop--boot');
    // @ts-expect-error layer is rejected on a contained dialog; the runtime still ignores it
    rerender(<Dialog onClose={() => {}} open contained layer="boot" title="T" />);
    expect(screen.getByTestId('ui-dialog-backdrop')).not.toHaveClass('ui-dialog__backdrop--boot');
  });

  it('stacking ladder: every z-index in ui.css and toast.css is pinned, strictly ordered, with no ties (PRR-151-019)', () => {
    const css = readFileSync(resolve(__dirname, 'ui.css'), 'utf8');
    const toastCss = readFileSync(resolve(__dirname, 'toast.css'), 'utf8');
    const z = (source: string, selector: string): number => {
      const m = new RegExp(selector.replace(/[.]/g, String.raw`\.`) + String.raw`\s*\{[^}]*z-index:\s*(\d+)`).exec(source);
      if (!m) throw new Error('no z-index for ' + selector);
      return Number(m[1]);
    };
    const ladder = {
      contained: z(css, '.ui-dialog__backdrop--contained'),
      scrim: z(css, '.ui-shell__scrim'),
      drawer: z(css, '.ui-shell--drawer .ui-shell__sidebar'),
      dialog: z(css, '.ui-dialog__backdrop'),
      combobox: z(css, '.ui-combobox__list'),
      tooltip: z(css, '.ui-tooltip'),
      boot: z(css, '.ui-dialog__backdrop--boot'),
      toast: z(toastCss, '.ui-toast-viewport'),
    };
    expect(ladder).toEqual({ contained: 200, scrim: 299, drawer: 300, dialog: 1000, combobox: 1050, tooltip: 1090, boot: 1100, toast: 1200 });
    // Strictly increasing in the order above: no two layers tie (a tie falls back to DOM order).
    const values = Object.values(ladder);
    values.slice(1).forEach((v, i) => expect(v).toBeGreaterThan(values[i]));
    // Nothing else in these stylesheets declares a z-index, so a new layer cannot slip in unpinned.
    expect(css.match(/z-index\s*:/g)).toHaveLength(7);
    expect(toastCss.match(/z-index\s*:/g)).toHaveLength(1);
  });

  it('describedBy sets aria-describedby and the description is exposed', () => {
    render(
      <Dialog onClose={() => {}} open describedBy="why" title="Titled">
        <p id="why">Because.</p>
      </Dialog>
    );
    expect(screen.getByRole('dialog', { name: 'Titled', description: 'Because.' })).toHaveAttribute(
      'aria-describedby',
      'why'
    );
  });
});

describe('Dialog prop types (PRR-151-069 / 052)', () => {
  it('dismissible: omitted / literal / dynamic boolean need onClose; literal false rejects it; contained rejects layer', () => {
    const flag = screen.queryByText('never-rendered') === null; // a runtime boolean, typed `boolean`
    const { unmount } = render(
      <>
        {/* Accepted: a dynamic boolean with onClose (it may become dismissible). */}
        <Dialog open dismissible={flag} onClose={() => {}} title="Dynamic" />
        {/* Accepted: a literal false without onClose. */}
        <Dialog open dismissible={false} title="Blocked" />
        {/* Accepted: contained without a layer, and a window-wide boot layer. */}
        <Dialog open contained onClose={() => {}} title="Contained" />
        <Dialog open layer="boot" onClose={() => {}} title="Boot" />
      </>
    );
    expect(screen.getAllByRole('dialog')).toHaveLength(4);
    unmount();
    // Rejected at compile time (tsc -p tsconfig.test.json fails with TS2578 if any of these
    // stops being an error). Never rendered: these lines exist only for the type checker.
    const rejected = () => (
      <>
        {/* @ts-expect-error a dynamic dismissible still requires onClose */}
        <Dialog open dismissible={flag} title="x" />
        {/* @ts-expect-error a literal true requires onClose */}
        <Dialog open dismissible title="x" />
        {/* @ts-expect-error dismissible={false} never calls onClose, so passing one is a mistake */}
        <Dialog open dismissible={false} onClose={() => {}} title="x" />
        {/* @ts-expect-error a contained dialog stacks at the contained level; layer would be ignored */}
        <Dialog open contained layer="boot" onClose={() => {}} title="x" />
      </>
    );
    expect(typeof rejected).toBe('function');
  });
});

describe('Dialog headingLevel', () => {
  it('defaults to an h2 title; headingLevel={1} renders an h1 that still names the dialog', () => {
    const { rerender } = render(<Dialog open onClose={() => {}} title="Starting" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Starting' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    rerender(<Dialog open onClose={() => {}} headingLevel={1} title="Starting" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Starting' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Starting' })).toBeInTheDocument();
  });
});

describe('Dialog backdrop press keeps focus live (PRR-151-006)', () => {
  function WizardLike({ onClose }: { onClose: () => void }) {
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
          closeOnBackdrop={false}
          title="Setup"
          footer={
            <>
              <Button>Back</Button>
              <Button>Next</Button>
            </>
          }
        />
      </>
    );
  }
  const pressBackdrop = () => userEvent.pointer({ keys: '[MouseLeft]', target: screen.getByTestId('ui-dialog-backdrop') });

  it('closeOnBackdrop={false}: the press does not blur the focused control; Tab still wraps and Escape still closes', async () => {
    const onClose = vi.fn();
    render(<WizardLike onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    const back = screen.getByRole('button', { name: 'Back' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(back).toHaveFocus();
    await pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    expect(back).toHaveFocus(); // not dropped to <body>
    await userEvent.tab();
    expect(next).toHaveFocus();
    await userEvent.tab();
    expect(back).toHaveFocus(); // the trap is still live
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
  });

  it('dismissible={false}: the press keeps focus on the focused control', async () => {
    render(<Dialog open dismissible={false} title="Gate" footer={<Button>Go</Button>} />);
    const go = screen.getByRole('button', { name: 'Go' });
    expect(go).toHaveFocus();
    await pressBackdrop();
    expect(go).toHaveFocus();
  });

  it('a modal whose focus already left the panel gets it back on a backdrop press', async () => {
    render(<Dialog open dismissible={false} title="Gate" footer={<Button>Go</Button>} />);
    act(() => screen.getByRole('button', { name: 'Go' }).blur());
    expect(document.body).toHaveFocus();
    await pressBackdrop();
    expect(screen.getByRole('dialog', { name: 'Gate' })).toHaveFocus();
  });

  it('a press that closes the dialog returns focus to the opener', async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    await pressBackdrop();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe('Dialog re-homes focus when the focused control is removed (PRR-151-016)', () => {
  function RetryGate({ modal = true }: { modal?: boolean }) {
    const [loading, setLoading] = useState(false);
    return (
      <Dialog
        open
        dismissible={false}
        modal={modal}
        title="Boot"
        footer={loading ? undefined : <Button onClick={() => setLoading(true)}>Retry</Button>}
      >
        {loading ? <p>Connecting</p> : <p>Failed</p>}
      </Dialog>
    );
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 20));

  it('modal: Retry unmounting into a zero-focusable panel re-homes focus onto the panel; Tab and Escape stay handled', async () => {
    render(<RetryGate />);
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveFocus();
    await userEvent.click(retry);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const panel = screen.getByRole('dialog', { name: 'Boot' });
    await waitFor(() => expect(panel).toHaveFocus());
    expect(fireEvent.keyDown(panel, { key: 'Tab' })).toBe(false); // trapped: no focusables, stays on the panel
    expect(panel).toHaveFocus();
    expect(fireEvent.keyDown(panel, { key: 'Escape' })).toBe(false); // swallowed by the blocking dialog
  });

  it('non-modal: no re-home (focus may legitimately live outside a non-modal dialog)', async () => {
    render(<RetryGate modal={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await tick();
    expect(document.body).toHaveFocus();
  });

  it('a consumer that re-homes focus itself within the same turn wins over the panel fallback', async () => {
    function Steps() {
      const [done, setDone] = useState(false);
      const finishRef = React.useRef<HTMLButtonElement>(null);
      return (
        <Dialog
          open
          onClose={() => {}}
          title="Wizard"
          footer={
            done ? (
              <Button key="finish" ref={finishRef}>
                Finish
              </Button>
            ) : (
              <Button
                key="complete"
                onClick={() => {
                  setDone(true);
                  // The consumer's own re-home lands after the removal, before the dialog's deferred one.
                  setTimeout(() => finishRef.current?.focus(), 0);
                }}
              >
                Complete
              </Button>
            )
          }
        />
      );
    }
    render(<Steps />);
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    const finish = await screen.findByRole('button', { name: 'Finish' });
    await waitFor(() => expect(finish).toHaveFocus());
    await tick();
    expect(finish).toHaveFocus(); // not pulled back onto the panel
  });
});

describe('Dialog focus return when the opener is gone (PRR-151-037 / 046)', () => {
  it('stacked: inner dialog opened from the outer one, outer closed first; closing the inner lands on the page opener', async () => {
    function Host() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return (
        <>
          <Button onClick={() => setOuter(true)}>Page opener</Button>
          <Dialog open={outer} onClose={() => setOuter(false)} title="Outer" footer={<Button onClick={() => setInner(true)}>More</Button>} />
          <Dialog
            open={inner}
            onClose={() => setInner(false)}
            title="Inner"
            footer={<Button onClick={() => setOuter(false)}>Close outer</Button>}
          />
        </>
      );
    }
    render(<Host />);
    const pageOpener = screen.getByRole('button', { name: 'Page opener' });
    await userEvent.click(pageOpener);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const closeOuter = screen.getByRole('button', { name: 'Close outer' });
    expect(closeOuter).toHaveFocus();
    await userEvent.click(closeOuter); // the inner dialog's opener ("More") is now detached
    expect(screen.queryByRole('dialog', { name: 'Outer' })).toBeNull();
    expect(closeOuter).toHaveFocus(); // the outer's cleanup did not steal focus from the inner
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pageOpener).toHaveFocus();
  });

  it('an opener removed while its dialog is open: focus goes to the topmost dialog still open, not <body>', async () => {
    function Host() {
      const [showOpener, setShowOpener] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          <Dialog open dismissible={false} modal={false} title="Gate" />
          {showOpener ? <Button onClick={() => setOpen(true)}>Row action</Button> : null}
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Confirm"
            footer={
              <Button
                onClick={() => {
                  setShowOpener(false);
                  setOpen(false);
                }}
              >
                Delete row
              </Button>
            }
          />
        </>
      );
    }
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Row action' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Gate' })).toHaveFocus();
  });
});

describe('Dialog Escape owned by a control inside (PRR-151-070)', () => {
  function Host({ onClose, onOuter, children }: { onClose: () => void; onOuter: () => void; children: React.ReactNode }) {
    return (
      <div onKeyDown={onOuter}>
        <Dialog open onClose={onClose} title="Host">
          {children}
        </Dialog>
      </div>
    );
  }

  it('does not close when a child already handled Escape (defaultPrevented), and still does not let it propagate', () => {
    const onClose = vi.fn();
    const onOuter = vi.fn();
    render(
      <Host onClose={onClose} onOuter={onOuter}>
        <input aria-label="widget" onKeyDown={(e) => e.key === 'Escape' && e.preventDefault()} />
      </Host>
    );
    fireEvent.keyDown(screen.getByLabelText('widget'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onOuter).not.toHaveBeenCalled();
  });

  it('does not close on Escape that cancels an IME composition', () => {
    const onClose = vi.fn();
    render(
      <Host onClose={onClose} onOuter={() => {}}>
        <input aria-label="text" />
      </Host>
    );
    fireEvent.keyDown(screen.getByLabelText('text'), { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('text'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close from an expanded combobox or open popup button; closes once collapsed, and from a disclosure button', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Host onClose={onClose} onOuter={() => {}}>
        <input aria-label="pick" role="combobox" aria-expanded="true" aria-controls="lb" />
        <button type="button" aria-haspopup="menu" aria-expanded="true">
          Menu
        </button>
        <button type="button" aria-expanded="true">
          Details
        </button>
      </Host>
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'pick' }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // A plain disclosure (aria-expanded without a popup) does not own Escape.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Details' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Host onClose={onClose} onOuter={() => {}}>
        <input aria-label="pick" role="combobox" aria-expanded="false" aria-controls="lb" />
      </Host>
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'pick' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Dialog + toasts above it (PRR-151-007)', () => {
  // Real ToastProvider: its viewport portals to <body>, above every dialog (z 1200).
  function Toasts({ messages }: { messages: string[] }) {
    const { showToast } = useToast();
    React.useEffect(() => {
      messages.forEach((m) => showToast(m, 'info'));
    }, [messages, showToast]);
    return null;
  }
  type Kind = 'modal' | 'non-modal' | 'none';
  // dialogFirst: the dialog portal is appended before the toast viewport (opened at mount);
  // otherwise it opens afterwards (the app's real order: the viewport mounts with the app).
  function Page({ kind, dialogFirst, messages = ['Saved'] }: { kind: Kind; dialogFirst: boolean; messages?: string[] }) {
    const [open, setOpen] = useState(dialogFirst);
    React.useEffect(() => setOpen(true), []);
    const dialog =
      kind === 'none' ? null : kind === 'modal' ? (
        <Dialog open={open} onClose={() => setOpen(false)} title="Modal" footer={<><Button>First</Button><Button>Last</Button></>} />
      ) : (
        <div style={{ position: 'relative' }}>
          <Dialog open={open} contained modal={false} dismissible={false} title="Gate" footer={<Button>Gate action</Button>} />
        </div>
      );
    return (
      <>
        <Button>Background</Button>
        {dialogFirst ? dialog : null}
        <ToastProvider>
          <Toasts messages={messages} />
          {dialogFirst ? null : dialog}
        </ToastProvider>
      </>
    );
  }
  const dismissButtons = () => screen.getAllByRole('button', { name: 'Dismiss notification' });
  const viewportOf = (el: HTMLElement) => el.closest('.ui-toast-viewport') as HTMLElement;
  const order = [true, false] as const;

  it.each(order)('modal open (dialog portal first=%s): Tab and Shift+Tab from a focused toast land inside the panel', async (dialogFirst) => {
    render(<Page kind="modal" dialogFirst={dialogFirst} />);
    const dismiss = await waitFor(() => dismissButtons()[0]);
    const panel = screen.getByRole('dialog', { name: 'Modal' });
    // Sanity: the page structure really puts the toast outside the panel.
    expect(viewportOf(dismiss).parentElement).toBe(document.body);
    expect(panel.contains(dismiss)).toBe(false);
    act(() => dismiss.focus());
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    act(() => dismiss.focus());
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('modal open: Tab moves between toasts first, and only the last edge goes back into the panel', async () => {
    render(<Page kind="modal" dialogFirst={false} messages={['One', 'Two']} />);
    await waitFor(() => expect(dismissButtons()).toHaveLength(2));
    const [one, two] = dismissButtons();
    act(() => one.focus());
    await userEvent.tab();
    expect(two).toHaveFocus(); // toasts stay reachable from each other
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('two stacked modals: the toast hands focus to the topmost one only', async () => {
    function Stacked() {
      const [inner, setInner] = useState(false);
      React.useEffect(() => setInner(true), []);
      return (
        <ToastProvider>
          <Toasts messages={['Saved']} />
          <Dialog open onClose={() => {}} title="Outer" footer={<Button>Outer action</Button>} />
          <Dialog open={inner} onClose={() => setInner(false)} title="Inner" footer={<Button>Inner action</Button>} />
        </ToastProvider>
      );
    }
    render(<Stacked />);
    const dismiss = await waitFor(() => dismissButtons()[0]);
    await waitFor(() => screen.getByRole('dialog', { name: 'Inner' }));
    act(() => dismiss.focus());
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Inner action' })).toHaveFocus();
  });

  it('topmost: the boot layer wins over document order; a contained modal in page content does not cover a portaled one', async () => {
    function Layers({ boot }: { boot: boolean }) {
      const [later, setLater] = useState(false);
      React.useEffect(() => setLater(true), []);
      return (
        <ToastProvider>
          <Toasts messages={['Saved']} />
          {boot ? <Dialog open layer="boot" onClose={() => {}} title="Boot" footer={<Button>Boot action</Button>} /> : null}
          <Dialog open onClose={() => {}} title="Default" footer={<Button>Default action</Button>} />
          {later ? (
            <div style={{ position: 'relative' }}>
              <Dialog open contained onClose={() => {}} title="Contained" footer={<Button>Contained action</Button>} />
            </div>
          ) : null}
        </ToastProvider>
      );
    }
    const { unmount } = render(<Layers boot />);
    let dismiss = await waitFor(() => dismissButtons()[0]);
    act(() => dismiss.focus());
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Boot action' })).toHaveFocus(); // first in DOM, highest layer
    unmount();
    render(<Layers boot={false} />);
    dismiss = await waitFor(() => dismissButtons()[0]);
    await waitFor(() => screen.getByRole('dialog', { name: 'Contained' }));
    act(() => dismiss.focus());
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Default action' })).toHaveFocus(); // not the contained modal mounted later
  });

  it.each(['non-modal', 'none'] as const)('%s: Tab from a toast is left to the browser (unchanged)', async (kind) => {
    render(<Page kind={kind} dialogFirst={false} />);
    const dismiss = await waitFor(() => dismissButtons()[0]);
    act(() => dismiss.focus());
    // Not intercepted: the keydown is not default-prevented...
    expect(fireEvent.keyDown(dismiss, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(dismiss, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(dismiss).toHaveFocus();
    // ...and the real Tab order is plain document order: Shift+Tab reaches the control
    // before the viewport (the page, or the non-modal gate), Tab leaves the document.
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: kind === 'none' ? 'Background' : 'Gate action' })).toHaveFocus();
    act(() => dismiss.focus());
    await userEvent.tab();
    expect(document.body).toHaveFocus();
  });

  it('dismissing a focused toast over a modal still returns focus to where it came from (toast focus return unchanged)', async () => {
    render(<Page kind="modal" dialogFirst={false} />);
    const dismiss = await waitFor(() => dismissButtons()[0]);
    const last = screen.getByRole('button', { name: 'Last' });
    act(() => last.focus());
    act(() => dismiss.focus()); // entered from inside the panel
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull());
    expect(last).toHaveFocus();
  });
});

describe('Tooltip', () => {
  it('hoverable (WCAG 1.4.13): moving from the trigger onto the tooltip keeps it open; leaving both closes it', () => {
    render(
      <Tooltip content="Detail text">
        <button type="button">Go</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.mouseOver(btn);
    const tip = screen.getByRole('tooltip');
    // Pointer moves trigger -> tooltip (a descendant of the wrapper): stays open.
    fireEvent.mouseOut(btn, { relatedTarget: tip });
    fireEvent.mouseOver(tip, { relatedTarget: btn });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    // Pointer leaves the tooltip for something outside: closes.
    fireEvent.mouseOut(tip, { relatedTarget: document.body });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Escape still dismisses an open (hovered) tooltip', () => {
    render(
      <Tooltip content="Detail text">
        <button type="button">Go</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.mouseOver(btn);
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('describe={false}: the open tooltip has readable text but is not added to the trigger description', () => {
    render(
      <Tooltip content="Extra detail" describe={false}>
        <button type="button" aria-describedby="own">Go</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip')).toHaveAccessibleName('Extra detail');
    expect(btn.getAttribute('aria-describedby')).toBe('own');
  });

  it('default: the open tooltip is added to the trigger description (unchanged behaviour)', () => {
    render(
      <Tooltip content="Extra detail">
        <button type="button">Go</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.focus(btn);
    expect(btn).toHaveAccessibleDescription('Extra detail');
  });

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

  it("placement 'top' renders above the trigger and still clamps horizontally into the viewport", async () => {
    render(
      <Tooltip content="Send message" placement="top">
        <button type="button" aria-label="Send message">S</button>
      </Tooltip>
    );
    // Measured unshifted, the tip overflows a 500px viewport on the right by 14px.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 400, right: 506, top: 0, bottom: 20, width: 106, height: 20, x: 400, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const cw = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(500);
    try {
      await userEvent.tab();
      const tip = screen.getByRole('tooltip');
      expect(tip).toHaveClass('ui-tooltip', 'ui-tooltip--top');
      expect(tip).not.toHaveClass('ui-tooltip--end');
      expect(tip.style.getPropertyValue('--ui-tooltip-shift')).toBe('-14px');
    } finally {
      rect.mockRestore();
      cw.mockRestore();
    }
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
