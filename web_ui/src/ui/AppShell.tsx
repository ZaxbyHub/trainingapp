import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { IconButton } from './Button';
import { Icon, type IconName } from './icons';
import { Tooltip } from './Overlays';
import { cx } from './cx';

/**
 * Drawer breakpoint (docs/design/design-language.md section 3.5): at 768 CSS px
 * and below the sidebar becomes an overlay drawer opened from a top bar. The
 * switch is JS-driven (this query sets the `ui-shell--drawer` class); ui.css has
 * no matching media query to keep in sync.
 */
export const DRAWER_MEDIA_QUERY = '(max-width: 768px)';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focusable controls inside `root`, excluding anything in an inert subtree
 * (e.g. the sidebar's stale search results while a search is pending): the
 * browser skips those, so a Tab trap that counted them would compute the wrong
 * first/last control and let Tab escape.
 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]'));
}

function queryMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query)?.matches === true;
}

/** Live `matchMedia` result; false where matchMedia is unavailable. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => queryMatches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    if (!mql) return undefined;
    const onChange = () => setMatches(mql.matches === true);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener?.(onChange);
    return () => mql.removeListener?.(onChange);
  }, [query]);
  return matches;
}

export type DrawerCloseReason = 'navigate' | 'dismiss';

interface AppShellContextValue {
  /** True when the desktop sidebar is collapsed to its 64px icon rail. */
  collapsed: boolean;
  /** True when the sidebar renders as an overlay drawer (<= 768px). */
  drawer: boolean;
  /**
   * Close the drawer (no-op outside drawer mode). 'navigate' moves focus to
   * the main region (the user went somewhere); 'dismiss' returns it to the
   * menu button that opened the drawer.
   */
  closeDrawer: (reason: DrawerCloseReason) => void;
}

const AppShellContext = createContext<AppShellContextValue>({
  collapsed: false,
  drawer: false,
  closeDrawer: () => {},
});

/** Shell state for sidebar content (outside an AppShell: expanded, not a drawer). */
export function useAppShell(): AppShellContextValue {
  return useContext(AppShellContext);
}

/** The product mark: an accent tile with the book glyph. Decorative. */
export function ProductMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="ui-shell__mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="ui-shell__mark-tile" width="24" height="24" rx="6" />
      <Icon name="book-open" className="ui-shell__mark-glyph" x={4.5} y={4.5} size={15} strokeWidth={2.75} />
    </svg>
  );
}

function Brand({ productName, nameHidden }: { productName: string; nameHidden?: boolean }) {
  return (
    <span className="ui-shell__brand">
      <ProductMark />
      <span className={nameHidden ? 'ui-visually-hidden' : 'ui-shell__name'}>{productName}</span>
    </span>
  );
}

export interface AppShellProps {
  /** The one product name (design-language.md section 5), shown next to the mark. */
  productName: string;
  /** Sidebar body: navigation and lists, rendered below the brand row. */
  sidebar: ReactNode;
  /** Page content, rendered in <main>. */
  children: ReactNode;
  /** Desktop (> 768px) collapse state: true = 64px icon rail. Persisted by the caller. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * Application frame (design-language.md sections 3.5 and 5): a 260px sidebar
 * that collapses to a 64px rail above 768px, and an overlay drawer opened from
 * a top bar at 768px and below. The drawer is a modal dialog: focus moves to the
 * active navigation item on open, Tab is trapped inside it, Escape or the scrim
 * closes it, and focus returns to the menu button (dismiss) or to <main>
 * (navigation). While it is open the top bar and <main> are inert. Narrowing
 * the window while the sidebar holds focus moves focus to the menu button.
 * Main is the single page scroller.
 */
export function AppShell({ productName, sidebar, children, collapsed, onToggleCollapsed }: AppShellProps) {
  const drawer = useMediaQuery(DRAWER_MEDIA_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarId = useId();
  const menuButtonId = useId();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  // Whether keyboard focus is (or was, until a re-render removed the focused
  // node) inside the sidebar. A focused element that React REMOUNTS (rail ->
  // drawer drops the rail tooltips) is removed without a focusout, so
  // document.activeElement alone cannot tell us focus was there.
  const sidebarFocusRef = useRef(false);
  /** Same idea for the drawer-mode top bar (its menu button unmounts on widening). */
  const topbarFocusRef = useRef(false);
  const pendingFocus = useRef<DrawerCloseReason | null>(null);

  /**
   * Focus <main> as a programmatic target only: tabindex is removed again on
   * blur so a click in the page body never parks focus on <main>.
   */
  const focusMain = () => {
    const main = mainRef.current;
    if (!main) return;
    main.setAttribute('tabindex', '-1');
    main.focus({ preventScroll: true });
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  };

  // Leaving drawer mode (window widened) drops any open drawer.
  useEffect(() => {
    if (!drawer) setDrawerOpen(false);
  }, [drawer]);

  const closeDrawer = useCallback(
    (reason: DrawerCloseReason) => {
      if (!drawer) return;
      pendingFocus.current = reason;
      setDrawerOpen(false);
    },
    [drawer]
  );

  // Narrowing into drawer mode hides the sidebar. If it held focus, the focus
  // would fall to <body>; hand it to the menu button that re-opens the nav.
  // Layout effect: runs after `hidden` is applied but before the browser's
  // focus fixup, so document.activeElement still names the hidden control.
  useLayoutEffect(() => {
    const panel = sidebarRef.current;
    const active = document.activeElement;
    const atBody = active === null || active === document.body;
    if (drawer) {
      const lostToBody = atBody && sidebarFocusRef.current;
      if ((panel && panel.contains(active)) || lostToBody) {
        document.getElementById(menuButtonId)?.focus();
      }
      return;
    }
    // Widening out of drawer mode (PR #147 PRR-020): the top bar unmounts and,
    // when the desktop sidebar is the icon rail, the nav buttons remount, so
    // focus that was in the drawer or on the menu button falls to <body>. Hand
    // it to the active destination (or <main> if there is none).
    if (atBody && (sidebarFocusRef.current || topbarFocusRef.current)) {
      const target = panel?.querySelector<HTMLElement>('nav [aria-current="page"]');
      if (target) target.focus();
      else focusMain();
    }
    topbarFocusRef.current = false;
    // Only the drawer-mode transitions matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);

  useEffect(() => {
    // While the drawer is open, everything behind it (the top bar and <main>,
    // including any overlay rendered inside <main>) is inert: unreachable by
    // Tab, pointer and assistive tech. Set via the DOM because React 18 has no
    // typed `inert` prop. Cleared BEFORE focus is restored below, since an
    // inert element cannot take focus.
    for (const el of [mainRef.current, topbarRef.current]) {
      if (!el) continue;
      if (drawerOpen) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
    if (drawerOpen) {
      const panel = sidebarRef.current;
      const target =
        panel?.querySelector<HTMLElement>('nav [aria-current="page"]') ?? (panel ? focusablesIn(panel)[0] : undefined);
      target?.focus();
      return;
    }
    const reason = pendingFocus.current;
    pendingFocus.current = null;
    if (reason === 'dismiss') {
      document.getElementById(menuButtonId)?.focus();
    } else if (reason === 'navigate') {
      focusMain();
    }
  }, [drawerOpen, menuButtonId]);

  const onDrawerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDrawer('dismiss');
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = sidebarRef.current;
    if (!panel) return;
    const items = focusablesIn(panel);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const railed = !drawer && collapsed;
  const context = useMemo<AppShellContextValue>(
    () => ({ collapsed: railed, drawer, closeDrawer }),
    [railed, drawer, closeDrawer]
  );

  return (
    <AppShellContext.Provider value={context}>
      <div className={cx('ui-shell', railed && 'ui-shell--collapsed', drawer && 'ui-shell--drawer')}>
        {drawer ? (
          <header
            ref={topbarRef}
            className="ui-shell__topbar"
            onFocus={() => {
              topbarFocusRef.current = true;
            }}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to ? !e.currentTarget.contains(to) : e.target.isConnected) topbarFocusRef.current = false;
            }}
          >
            <IconButton
              id={menuButtonId}
              icon="menu"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              aria-controls={sidebarId}
              onClick={() => setDrawerOpen(true)}
            />
            <Brand productName={productName} />
          </header>
        ) : null}
        {drawer && drawerOpen ? (
          <div className="ui-shell__scrim" aria-hidden="true" onClick={() => closeDrawer('dismiss')} />
        ) : null}
        <div
          id={sidebarId}
          ref={sidebarRef}
          className="ui-shell__sidebar"
          hidden={drawer && !drawerOpen}
          {...(drawer ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Navigation' } : {})}
          onKeyDown={drawer ? onDrawerKeyDown : undefined}
          onFocus={() => {
            sidebarFocusRef.current = true;
          }}
          onBlur={(e) => {
            // A real move elsewhere (to another element, or to <body> while the
            // blurred control is still rendered, e.g. a click on blank page).
            const to = e.relatedTarget as Node | null;
            if (to ? !e.currentTarget.contains(to) : e.target.isConnected) sidebarFocusRef.current = false;
          }}
        >
          <div className="ui-shell__head">
            <Brand productName={productName} nameHidden={railed} />
            {drawer ? (
              <IconButton icon="x" aria-label="Close navigation" onClick={() => closeDrawer('dismiss')} />
            ) : (
              <IconButton
                icon={collapsed ? 'chevron-right' : 'chevron-left'}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
                aria-controls={sidebarId}
                onClick={onToggleCollapsed}
              />
            )}
          </div>
          {sidebar}
        </div>
        <main ref={mainRef} className="ui-shell__main">
          {children}
        </main>
      </div>
    </AppShellContext.Provider>
  );
}

export interface SideNavItem {
  id: string;
  label: string;
  icon: IconName;
}

export interface SideNavProps {
  /** Accessible name of the <nav> landmark. */
  label: string;
  items: readonly SideNavItem[];
  activeId: string;
  onNavigate: (id: string) => void;
}

/**
 * Primary navigation. Each destination is a native button (Tab reaches every
 * item); ArrowUp/ArrowDown/Home/End additionally move focus within the list.
 * The active item carries aria-current="page" plus the selected treatment
 * (tint, accent text, 3px indicator). In the icon rail the label is visually
 * hidden and shown as a tooltip; the accessible name is always the label.
 */
export function SideNav({ label, items, activeId, onNavigate }: SideNavProps) {
  const { collapsed, drawer, closeDrawer } = useAppShell();
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.ui-shell__nav-item') ?? []);
    const index = buttons.findIndex((b) => b === document.activeElement);
    if (index < 0 || buttons.length === 0) return;
    e.preventDefault();
    const last = buttons.length - 1;
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowDown' ? (index === last ? 0 : index + 1) : index === 0 ? last : index - 1;
    buttons[next].focus();
  };

  return (
    <nav aria-label={label} className="ui-shell__nav">
      <ul ref={listRef} className="ui-shell__nav-list" onKeyDown={onKeyDown}>
        {items.map((item) => {
          const active = item.id === activeId;
          const button = (
            <button
              type="button"
              className={cx('ui-shell__nav-item', 'ui-focusable', active && 'ui-selected')}
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              onClick={() => {
                onNavigate(item.id);
                if (drawer) closeDrawer('navigate');
              }}
            >
              <Icon name={item.icon} />
              <span className={collapsed ? 'ui-visually-hidden' : 'ui-shell__nav-label'}>{item.label}</span>
            </button>
          );
          return (
            <li key={item.id}>
              {collapsed ? (
                <Tooltip content={item.label} placement="end">
                  {button}
                </Tooltip>
              ) : (
                button
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
