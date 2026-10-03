/**
 * AppShell + SideNav (docs/design/design-language.md sections 3.5, 5; phase 3):
 * roles, labels, the active item, keyboard navigation, desktop collapse, and the
 * <= 768px overlay drawer with its focus management. Role/state assertions only.
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell, DRAWER_MEDIA_QUERY, SideNav, type SideNavItem } from './index';

const ITEMS: readonly SideNavItem[] = [
  { id: 'chat', label: 'Chat', icon: 'message-square' },
  { id: 'documents', label: 'Documents', icon: 'file-text' },
  { id: 'training', label: 'Training', icon: 'layers' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** matchMedia stub whose DRAWER query matches `drawer`; `set()` fires a change event. */
function stubMatchMedia(drawer: boolean) {
  let matches = drawer;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === DRAWER_MEDIA_QUERY ? matches : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      act(() => listeners.forEach((cb) => cb()));
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

function Harness({
  initialCollapsed = false,
  onNavigate = () => {},
  onToggle = () => {},
}: {
  initialCollapsed?: boolean;
  onNavigate?: (id: string) => void;
  onToggle?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [page, setPage] = useState('chat');
  return (
    <AppShell
      productName="TrainingApp"
      collapsed={collapsed}
      onToggleCollapsed={() => {
        onToggle();
        setCollapsed((c) => !c);
      }}
      sidebar={
        <SideNav
          label="Main navigation"
          items={ITEMS}
          activeId={page}
          onNavigate={(id) => {
            onNavigate(id);
            setPage(id);
          }}
        />
      }
    >
      <h1>{page} page</h1>
    </AppShell>
  );
}

let media: ReturnType<typeof stubMatchMedia> | null = null;
afterEach(() => {
  cleanup();
  media?.restore();
  media = null;
});

describe('AppShell (desktop, > 768px)', () => {
  it('renders the product name, a labelled nav with the four destinations, and <main>', () => {
    render(<Harness />);
    expect(screen.getByText('TrainingApp')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Chat',
      'Documents',
      'Training',
      'Settings',
    ]);
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'chat page' })).toBeInTheDocument();
    // No drawer chrome at desktop widths.
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marks exactly the active item with aria-current="page" and the selected state', () => {
    render(<Harness />);
    const current = screen.getAllByRole('button', { current: 'page' });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Chat');
    expect(current[0]).toHaveClass('ui-selected');

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    expect(screen.getByRole('button', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Chat' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Chat' })).not.toHaveClass('ui-selected');
    expect(screen.getByRole('heading', { name: 'documents page' })).toBeInTheDocument();
  });

  it('calls onNavigate with the item id', () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Training' }));
    expect(onNavigate).toHaveBeenCalledWith('training');
  });

  it('every nav item is in the Tab order; ArrowDown/ArrowUp/Home/End move focus and wrap', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const [chat, documents, training, settings] = within(nav).getAllByRole('button');
    chat.focus();
    await user.tab();
    expect(documents).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(training).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(chat).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(settings).toHaveFocus(); // wraps to the end
    await user.keyboard('{ArrowDown}');
    expect(chat).toHaveFocus(); // wraps to the start
    await user.keyboard('{End}');
    expect(settings).toHaveFocus();
    await user.keyboard('{Home}');
    expect(chat).toHaveFocus();
    // Arrow keys only move focus; they never navigate.
    expect(chat).toHaveAttribute('aria-current', 'page');
  });

  it('collapses to the icon rail and back; names stay the plain labels', () => {
    const onToggle = vi.fn();
    const { container } = render(<Harness onToggle={onToggle} />);
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapse);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.ui-shell')).toHaveClass('ui-shell--collapsed');
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    // Labels are visually hidden in the rail, but the accessible names are unchanged.
    const chat = screen.getByRole('button', { name: 'Chat' });
    expect(within(chat).getByText('Chat')).toHaveClass('ui-visually-hidden');
    expect(screen.getByText('TrainingApp')).toHaveClass('ui-visually-hidden');

    fireEvent.click(expand);
    expect(container.querySelector('.ui-shell')).not.toHaveClass('ui-shell--collapsed');
    expect(within(screen.getByRole('button', { name: 'Chat' })).getByText('Chat')).not.toHaveClass(
      'ui-visually-hidden'
    );
  });

  it('in the rail, a nav item shows its label as a tooltip on keyboard focus', async () => {
    const user = userEvent.setup();
    render(<Harness initialCollapsed />);
    screen.getByRole('button', { name: 'Expand sidebar' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Chat');
    // Beside the rail, not below it (a tooltip below would cover the next item).
    expect(screen.getByRole('tooltip')).toHaveClass('ui-tooltip--end');
  });
});

describe('AppShell drawer (<= 768px)', () => {
  it('hides the sidebar behind a menu button in a top bar', () => {
    media = stubMatchMedia(true);
    const { container } = render(<Harness initialCollapsed />);
    expect(container.querySelector('.ui-shell')).toHaveClass('ui-shell--drawer');
    // The persisted desktop collapse state never applies to the drawer.
    expect(container.querySelector('.ui-shell')).not.toHaveClass('ui-shell--collapsed');
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('opens as a modal dialog and focuses the active destination', () => {
    media = stubMatchMedia(true);
    render(<Harness />);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(menu).toHaveAttribute('aria-controls', dialog.id);
    expect(within(dialog).getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Chat' })).toHaveFocus();
  });

  it('traps Tab inside the drawer', async () => {
    const user = userEvent.setup();
    media = stubMatchMedia(true);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    const close = within(dialog).getByRole('button', { name: 'Close navigation' });
    const settings = within(dialog).getByRole('button', { name: 'Settings' });
    settings.focus();
    await user.tab();
    expect(close).toHaveFocus(); // wrapped from the last control to the first
    await user.tab({ shift: true });
    expect(settings).toHaveFocus(); // and back
  });

  it('Escape closes it and returns focus to the menu button', async () => {
    const user = userEvent.setup();
    media = stubMatchMedia(true);
    render(<Harness />);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(menu);
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
  });

  it('the close button and the scrim both dismiss it', () => {
    media = stubMatchMedia(true);
    const { container } = render(<Harness />);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menu).toHaveFocus();

    fireEvent.click(menu);
    const scrim = container.querySelector('.ui-shell__scrim');
    expect(scrim).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(scrim as Element);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('choosing a destination navigates, closes the drawer, and moves focus to <main>', () => {
    const onNavigate = vi.fn();
    media = stubMatchMedia(true);
    render(<Harness onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveFocus();
    expect(within(main).getByRole('heading', { name: 'settings page' })).toBeInTheDocument();
    // <main> is only a programmatic focus target: tabindex goes away on blur.
    act(() => main.blur());
    expect(main).not.toHaveAttribute('tabindex');
  });

  it('widening past the breakpoint drops the open drawer and restores the sidebar', () => {
    media = stubMatchMedia(true);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
    media.set(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    // Narrowing again starts closed (the drawer state is never persisted).
    media.set(true);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });
});
