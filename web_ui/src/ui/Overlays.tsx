import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cx, mergeIds } from './cx';
import { computeTooltipShift } from './tooltip-position';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogBaseProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  /** Action row (right-aligned). */
  footer?: ReactNode;
  /** Use role="alertdialog" for blocking confirmations. */
  alert?: boolean;
  className?: string;
  /**
   * Default true: aria-modal="true". Pass false when the dialog blocks only part of
   * the page and the rest stays operable (the chat-page model gate leaves the shell
   * navigation usable). aria-modal="true" tells assistive tech everything outside is
   * inert, so claiming it there would hide navigation the user can still reach
   * (WAI-ARIA 1.2 dialog pattern). The caller is then responsible for making the
   * covered content inert, and Tab is NOT trapped (a non-modal dialog must let
   * keyboard users reach the rest of the page, here the shell navigation); focus
   * return still applies. modal (default) traps Tab and Shift+Tab at the panel edges.
   */
  modal?: boolean;
  /**
   * Where focus lands on open: 'first' (default) the first focusable control; 'panel'
   * the dialog itself (it is named by the title, so assistive tech reads the title and
   * description) for a dialog whose content should be read before any action is
   * offered; or a ref to a specific control (falls back to the first focusable control
   * while the ref is unset).
   */
  initialFocus?: 'first' | 'panel' | RefObject<HTMLElement | null>;
  /**
   * Heading level of the title: 2 (default) inside a page that already has an h1; 1 for
   * a dialog that IS the whole window (the boot gate: nothing else is rendered).
   */
  headingLevel?: 1 | 2;
  /** data-testid for the dialog panel (the backdrop is always "ui-dialog-backdrop"). */
  testId?: string;
  /** id of the element inside the dialog that describes it (aria-describedby). */
  describedBy?: string;
  /**
   * Default true: a press on the backdrop calls `onClose` (when dismissible). false keeps
   * Escape / explicit actions as the only ways out (the first-run wizard: a stray click
   * outside must not skip setup).
   */
  closeOnBackdrop?: boolean;
}

/**
 * Where the dialog renders. Default: portal to document.body with a fixed, window-wide
 * backdrop on `layer`. `contained`: render in place with an absolute backdrop covering
 * the nearest positioned ancestor, so only that region is blocked; the ancestor must
 * establish a containing block (position: relative) and the Dialog must not sit inside
 * an element the caller makes inert. A contained dialog always stacks at the contained
 * level (200), so `layer` is rejected at compile time rather than silently ignored.
 */
type DialogPlacementProps =
  | {
      contained?: false;
      /**
       * Stacking layer of a window-wide dialog. Order, lowest to highest (see ui.css):
       * contained gates 200 < shell nav drawer 300 < 'default' dialogs 1000 (first-run
       * wizard, confirmations) < 'boot' 1100 (the boot gate: nothing else is usable
       * behind it) < toasts 1200. A desktop model gate is `contained` to the chat page,
       * so it never covers the first-run wizard that fixes it.
       */
      layer?: 'default' | 'boot';
    }
  | {
      contained: true;
      layer?: never;
    };

/**
 * Dismissal. `D` is inferred from the `dismissible` prop (true when omitted):
 * - omitted / `true` / a dynamic boolean: `onClose` is required (the dialog must say
 *   what dismissing does, and a dynamic flag can become true);
 * - a literal `false`: `onClose` is rejected (it could never be called).
 */
type DialogDismissProps<D extends boolean> = {
  /**
   * Default true: Escape and a backdrop press call `onClose`. false is for blocking states
   * with no dismiss path (a missing-model gate): Escape and the backdrop do nothing, and
   * Escape is swallowed (preventDefault + stopPropagation) so it also cannot close
   * anything layered behind. Focus return is unchanged.
   */
  dismissible?: D;
} & ([D] extends [false]
  ? { onClose?: never }
  : {
      /** Called on Escape / backdrop press while dismissible. */
      onClose: () => void;
    });

export type DialogProps<D extends boolean = true> = DialogBaseProps & DialogPlacementProps & DialogDismissProps<D>;

/** Each open dialog panel's opener, so a dialog opened from inside another can fall back to it. */
const dialogOpeners = new WeakMap<Element, HTMLElement | null>();

/** Popup widgets that own Escape while open (Escape closes the popup, not the dialog). */
const ESCAPE_OWNER = '[role="combobox"][aria-expanded="true"], [aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]';

/**
 * role="dialog" (+ aria-modal unless `modal` is false). On open it moves focus into the dialog (first
 * focusable control, else the dialog itself), traps Tab / Shift+Tab (modal only), closes on
 * Escape or backdrop click (unless `dismissible` is false), and returns focus to
 * the previously focused element on close (unless focus has since moved outside the dialog). Rendered in a portal on document.body
 * unless `contained`.
 *
 * Focus stays live while a modal dialog is open: a press on the backdrop never blurs the
 * focused control, and if the focused control inside the panel is removed (a Retry
 * button replaced by a progress panel) focus is re-homed onto the panel, so the Tab trap
 * and Escape keep working.
 */
export function Dialog<D extends boolean = true>(props: DialogProps<D>) {
  const {
    open,
    onClose,
    title,
    children,
    footer,
    alert,
    className,
    modal = true,
    contained = false,
    initialFocus = 'first',
    layer = 'default',
    headingLevel = 2,
    testId,
    describedBy,
    closeOnBackdrop = true,
  } = props;
  const dismissible: boolean = props.dismissible ?? true;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  // Read at open time only; changing it while open must not re-run the focus effect.
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  const modalRef = useRef(modal);
  modalRef.current = modal;

  useEffect(() => {
    if (!open) return undefined;
    returnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) dialogOpeners.set(panel, returnRef.current);
    const wanted = initialFocusRef.current;
    const first =
      wanted === 'panel'
        ? null
        : (wanted !== 'first' ? wanted.current : null) ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    // Re-home focus when the focused control inside a modal panel is removed: browsers
    // (and jsdom) drop focus to <body> without a blur event, which would leave the Tab
    // trap and the panel-scoped Escape handler dead while the dialog stays open. The
    // re-home is deferred one task so a consumer's own re-home effect (the first-run
    // wizard focuses its next primary action) runs first and wins.
    let lastInside: Element | null = panel?.contains(document.activeElement) ? document.activeElement : null;
    let rehomeTimer: ReturnType<typeof setTimeout> | undefined;
    const focusLost = () => {
      const active = document.activeElement;
      return (active === null || active === document.body) && lastInside !== null && !lastInside.isConnected;
    };
    const onFocusIn = (e: FocusEvent) => {
      lastInside = e.target instanceof Element ? e.target : null;
    };
    const observer = new MutationObserver(() => {
      if (!modalRef.current || rehomeTimer !== undefined || !focusLost()) return;
      rehomeTimer = setTimeout(() => {
        rehomeTimer = undefined;
        if (modalRef.current && focusLost() && panel?.isConnected) panel.focus();
      }, 0);
    });
    if (panel) {
      panel.addEventListener('focusin', onFocusIn);
      observer.observe(panel, { childList: true, subtree: true });
    }
    return () => {
      observer.disconnect();
      panel?.removeEventListener('focusin', onFocusIn);
      if (rehomeTimer !== undefined) clearTimeout(rehomeTimer);
      // Return focus to the opener only if focus is still the dialog's to give back: on
      // body/nothing, or inside the panel. A non-modal dialog lets the user Tab into the
      // rest of the page (the shell nav); if focus is already there (or moved by the
      // action that closed the dialog) it must not be yanked back to the opener.
      const active = document.activeElement;
      const ours = active === null || active === document.body || (panel?.contains(active) ?? false);
      let target = returnRef.current;
      returnRef.current = null;
      if (!ours) return;
      // An opener inside a dialog that has since closed is detached: follow that dialog's
      // own opener instead (stacked dialogs closed bottom-first), up to a few levels.
      for (let hops = 0; target && !target.isConnected && hops < 8; hops += 1) {
        const host = target.closest('.ui-dialog');
        target = host ? dialogOpeners.get(host) ?? null : null;
      }
      if (target?.isConnected) {
        target.focus();
        return;
      }
      // No live opener (its row was removed): hand focus to the topmost dialog still open
      // rather than leave it on <body>, outside every dialog's key handling.
      const remaining = Array.from(document.querySelectorAll<HTMLElement>('.ui-dialog')).filter((el) => el !== panel);
      remaining[remaining.length - 1]?.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        // Never let Escape reach anything layered behind the dialog.
        e.stopPropagation();
        if (!dismissible) {
          e.preventDefault();
          return;
        }
        // Escape that a control inside already consumed (a combobox closing its list, an
        // IME cancelling a composition, an open popup menu) must not also close the dialog.
        const target = e.target instanceof Element ? e.target : null;
        if (e.defaultPrevented || e.nativeEvent.defaultPrevented || e.nativeEvent.isComposing || target?.closest(ESCAPE_OWNER)) {
          return;
        }
        onClose?.();
        return;
      }
      // Non-modal: no trap; Tab flows to the rest of the page (inert content is skipped).
      if (e.key !== 'Tab' || !modal) return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    },
    [dismissible, onClose, modal]
  );

  if (!open) return null;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const tree = (
    <div
      className={cx(
        'ui-dialog__backdrop',
        contained && 'ui-dialog__backdrop--contained',
        !contained && layer === 'boot' && 'ui-dialog__backdrop--boot'
      )}
      data-testid="ui-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The backdrop is never a focus target: without this the press blurs the focused
        // control to <body>, outside the panel, and the Tab trap and Escape go dead while
        // the dialog stays open (closeOnBackdrop={false}, or not dismissible).
        e.preventDefault();
        if (dismissible && closeOnBackdrop) {
          onClose?.();
          return;
        }
        const panel = panelRef.current;
        if (modal && panel && !panel.contains(document.activeElement)) panel.focus();
      }}
    >
      <div
        ref={panelRef}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal={modal ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        data-testid={testId}
        tabIndex={-1}
        className={cx('ui-dialog', 'ui-focusable', className)}
        onKeyDown={onKeyDown}
      >
        <Heading id={titleId} className="ui-dialog__title">
          {title}
        </Heading>
        <div className="ui-dialog__body">{children}</div>
        {footer ? <div className="ui-dialog__footer">{footer}</div> : null}
      </div>
    </div>
  );
  return contained ? tree : createPortal(tree, document.body);
}

export interface TooltipProps {
  content: ReactNode;
  /**
   * 'bottom' (default): centred below the trigger, shifted to stay in the viewport.
   * 'end': beside the trigger on its inline-end side (e.g. the shell's icon rail,
   * where a tooltip below would cover the next item).
   * 'top': centred above the trigger, with the same horizontal viewport shift as
   * 'bottom' (for bottom-anchored controls such as the chat composer).
   */
  placement?: 'bottom' | 'end' | 'top';
  /**
   * Default true: while shown, the tooltip's id is added to the trigger's aria-describedby.
   * Pass false when the trigger already has its own persistent description (the tooltip is
   * then a purely visual duplicate and must not be read a second time).
   */
  describe?: boolean;
  /** A single focusable element; it receives aria-describedby. */
  children: ReactElement<{ 'aria-describedby'?: string; 'aria-label'?: string; 'aria-labelledby'?: string }>;
}

/**
 * Shows on hover and keyboard focus; Escape dismisses. Hover/focus-only is by design:
 * the tooltip supplements the trigger's accessible name (WAI-ARIA tooltip pattern) and
 * must never be the only carrier of essential information. A tooltip on a natively
 * disabled control is hover-only (it cannot take focus), so the reason it is disabled
 * must also be stated elsewhere; prefer Button's aria-disabled, which stays focusable.
 */
export function Tooltip({ content, children, placement = 'bottom', describe = true }: TooltipProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const [labelledDuplicate, setLabelledDuplicate] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const labelledBy = children.props['aria-labelledby'];
  // A trigger named via aria-labelledby: resolve the referenced elements' text from the DOM.
  useLayoutEffect(() => {
    let dup = false;
    if (typeof content === 'string' && labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((ref) => document.getElementById(ref)?.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      dup = text === content.trim();
    }
    setLabelledDuplicate(dup);
  });
  // While shown, dismiss when the trigger goes away without a blur/mouseleave event:
  // pointer-down or focus landing outside, or the trigger becoming disabled/disconnected.
  useEffect(() => {
    if (!shown) return;
    const wrap = wrapRef.current;
    const outside = (e: Event) => {
      if (wrap && e.target instanceof Node && !wrap.contains(e.target)) setShown(false);
    };
    const findTrigger = () => (wrap ? Array.from(wrap.children).find((el) => el !== tipRef.current) : undefined);
    // A trigger that is ALREADY disabled when shown keeps its tooltip (the "why is this
    // disabled" pattern); only a transition to disabled while shown dismisses it.
    let wasDisabled = findTrigger()?.matches(':disabled') ?? false;
    const triggerGone = () => {
      // The trigger is the first child that is not the tooltip itself (once the trigger stops
      // rendering, the tooltip span would otherwise be mistaken for it).
      const trigger = findTrigger();
      if (!trigger || !trigger.isConnected) return setShown(false);
      const disabled = trigger.matches(':disabled');
      if (disabled && !wasDisabled) setShown(false);
      wasDisabled = disabled;
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    const observer = new MutationObserver(triggerGone);
    if (wrap) observer.observe(wrap, { attributes: true, attributeFilter: ['disabled'], subtree: true, childList: true });
    triggerGone();
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      observer.disconnect();
    };
  }, [shown]);
  // Keep the tooltip inside the viewport: measure unshifted, then apply the correction.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip || placement === 'end') return;
    tip.style.setProperty('--ui-tooltip-shift', '0px');
    const shift = computeTooltipShift(tip.getBoundingClientRect(), document.documentElement.clientWidth);
    tip.style.setProperty('--ui-tooltip-shift', `${shift}px`);
  }, [shown, content, placement]);
  // When the tooltip text just repeats the trigger's accessible name, do not also
  // expose it as the description (screen readers would announce it twice).
  const duplicatesName = labelledBy
    ? labelledDuplicate // aria-labelledby takes precedence over aria-label in the accessible name
    : typeof content === 'string' && children.props['aria-label'] === content;
  return (
    <span
      ref={wrapRef}
      className="ui-tooltip-wrap"
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && shown) {
          // Consume Escape only when it dismisses the tooltip, so an enclosing Dialog stays open.
          e.stopPropagation();
          setShown(false);
        }
      }}
    >
      {cloneElement(children, { 'aria-describedby': mergeIds(describe && shown && !duplicatesName ? id : undefined, children.props['aria-describedby']) })}
      {shown ? (
        <span ref={tipRef} role="tooltip" id={id} className={cx('ui-tooltip', placement === 'end' && 'ui-tooltip--end', placement === 'top' && 'ui-tooltip--top')}>
          {content}
        </span>
      ) : null}
    </span>
  );
}
