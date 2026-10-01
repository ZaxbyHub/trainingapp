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
} from 'react';
import { createPortal } from 'react-dom';
import { mergeIds } from './cx';
import { cx } from './cx';
import { computeTooltipShift } from './tooltip-position';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Action row (right-aligned). */
  footer?: ReactNode;
  /** Use role="alertdialog" for blocking confirmations. */
  alert?: boolean;
  className?: string;
}

/**
 * role="dialog" + aria-modal. On open it moves focus into the dialog (first
 * focusable control, else the dialog itself), traps Tab / Shift+Tab, closes on
 * Escape or backdrop click, and returns focus to the previously focused
 * element on close. Rendered in a portal on document.body.
 */
export function Dialog({ open, onClose, title, children, footer, alert, className }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    returnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      returnRef.current?.focus();
      returnRef.current = null;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
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
    [onClose]
  );

  if (!open) return null;
  return createPortal(
    <div
      className="ui-dialog__backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('ui-dialog', 'ui-focusable', className)}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="ui-dialog__title">
          {title}
        </h2>
        <div className="ui-dialog__body">{children}</div>
        {footer ? <div className="ui-dialog__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element; it receives aria-describedby. */
  children: ReactElement<{ 'aria-describedby'?: string; 'aria-label'?: string }>;
}

/** Shows on hover and keyboard focus; Escape dismisses. */
export function Tooltip({ content, children }: TooltipProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  // Keep the tooltip inside the viewport: measure unshifted, then apply the correction.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) return;
    tip.style.setProperty('--ui-tooltip-shift', '0px');
    const shift = computeTooltipShift(tip.getBoundingClientRect(), document.documentElement.clientWidth);
    tip.style.setProperty('--ui-tooltip-shift', `${shift}px`);
  }, [shown, content]);
  // When the tooltip text just repeats the trigger's accessible name, do not also
  // expose it as the description (screen readers would announce it twice).
  const duplicatesName = typeof content === 'string' && children.props['aria-label'] === content;
  return (
    <span
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
      {cloneElement(children, { 'aria-describedby': mergeIds(shown && !duplicatesName ? id : undefined, children.props['aria-describedby']) })}
      {shown ? (
        <span ref={tipRef} role="tooltip" id={id} className="ui-tooltip">
          {content}
        </span>
      ) : null}
    </span>
  );
}
