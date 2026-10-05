import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Banner } from './Feedback';
import { Button } from './Button';
import { Icon } from './icons';
import { cx } from './cx';
import './toast.css';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastTone;
  /** Bumped when an identical toast is shown again: restarts the auto-dismiss timer. */
  nonce: number;
}

export interface ToastContextValue {
  showToast: (message: string, type: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export const TOAST_DURATION_MS = 5000;
/** Matches --dur-base (lumen-tokens.css); the leaving class fades over this long. */
export const TOAST_EXIT_MS = 200;
/** Visible-toast cap: a burst (e.g. one failure per file) drops the oldest instead of stacking off-screen. */
export const MAX_TOASTS = 5;

const BANNER_TONE = { success: 'success', error: 'danger', info: 'info' } as const;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * WAI-ARIA live-region toasts. A polite status region (success and info) and an
 * assertive alert region (error) are ALWAYS mounted, so assistive tech has
 * registered them before any message is inserted; toasts are added to and removed from
 * those regions and carry no live role of their own (nested live roles would be
 * announced twice). aria-atomic is false so adding one toast does not re-announce the
 * ones already showing. Auto-dismiss pauses while a toast is hovered or holds focus.
 *
 * Order is per region (status first, then alert), not chronological: the two live
 * regions are what make polite and assertive announcements work, so a new error always
 * renders below older success/info toasts. At most MAX_TOASTS show at once (oldest
 * dropped) and an identical message+type already showing is not added again. The
 * viewport is portaled to document.body so no ancestor stacking context can bury it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // The list of record (state mirrors it): showToast must see toasts queued earlier in
  // the same tick, and needs to know which toast the cap drops before React re-renders.
  const toastsRef = useRef<Toast[]>([]);
  const nextId = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Where focus was before it entered a toast, so dismissing a focused toast does not
  // strand focus on the document body.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const showToast = useCallback((message: string, type: ToastTone) => {
    const prev = toastsRef.current;
    let next: Toast[];
    if (prev.some((t) => t.message === message && t.type === type)) {
      // A repeat stays visible for a full duration instead of vanishing on the old timer.
      next = prev.map((t) => (t.message === message && t.type === type ? { ...t, nonce: t.nonce + 1 } : t));
    } else {
      next = [...prev, { id: `toast-${nextId.current++}`, message, type, nonce: 0 }];
      const dropped = next.slice(0, -MAX_TOASTS);
      next = next.slice(-MAX_TOASTS);
      // A dropped toast that holds focus would strand it on <body>: hand it to a survivor.
      for (const d of dropped) {
        const el = viewportRef.current?.querySelector<HTMLElement>(`[data-toast-id="${d.id}"]`);
        if (el?.contains(document.activeElement)) {
          const survivor = viewportRef.current?.querySelector<HTMLElement>(`[data-toast-id="${next[0].id}"] button`);
          survivor?.focus();
        }
      }
    }
    toastsRef.current = next;
    setToasts(next);
  }, []);

  // Focus moving between toasts keeps the recorded target; focus arriving from outside
  // (or from nowhere, e.g. a window refocus) replaces it, so a stale element is never
  // restored on a later dismissal.
  const noteFocusEntered = useCallback((from: EventTarget | null) => {
    if (from instanceof HTMLElement && viewportRef.current?.contains(from)) return;
    returnFocusRef.current = from instanceof HTMLElement ? from : null;
  }, []);

  const removeToast = useCallback((id: string, hadFocus: boolean) => {
    if (hadFocus) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus();
    }
    toastsRef.current = toastsRef.current.filter((t) => t.id !== id);
    setToasts(toastsRef.current);
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);
  const polite = toasts.filter((t) => t.type !== 'error');
  const assertive = toasts.filter((t) => t.type === 'error');
  const renderItem = (t: Toast) => (
    <ToastItem key={t.id} toast={t} onRemove={removeToast} onFocusEntered={noteFocusEntered} />
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
      <div ref={viewportRef} className="ui-toast-viewport">
        <div role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions" className="ui-toast-region">
          {polite.map(renderItem)}
        </div>
        <div role="alert" aria-live="assertive" aria-atomic="false" aria-relevant="additions" className="ui-toast-region">
          {assertive.map(renderItem)}
        </div>
      </div>,
      document.body
      )}
    </ToastContext.Provider>
  );
}

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string, hadFocus: boolean) => void;
  onFocusEntered: (from: EventTarget | null) => void;
}

function ToastItem({ toast, onRemove, onFocusEntered }: ToastItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pause bookkeeping: the remaining time is frozen on hover/focus and resumed on
  // leave/blur, and only resumes once BOTH hover and focus have ended.
  const remaining = useRef(TOAST_DURATION_MS);
  const startedAt = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);

  const finish = useCallback(() => {
    onRemove(toast.id, itemRef.current?.contains(document.activeElement) ?? false);
  }, [onRemove, toast.id]);

  const leave = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    setLeaving(true);
    exitTimer.current = setTimeout(finish, TOAST_EXIT_MS);
  }, [finish]);

  const start = useCallback(
    (ms: number) => {
      startedAt.current = Date.now();
      remaining.current = ms;
      dismissTimer.current = setTimeout(leave, ms);
    },
    [leave]
  );

  const pause = useCallback(() => {
    if (dismissTimer.current === null || leavingRef.current) return;
    clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  }, []);

  const resume = useCallback(() => {
    if (hovered.current || focused.current || dismissTimer.current !== null || leavingRef.current) return;
    start(remaining.current);
  }, [start]);

  // Mount, and again whenever an identical toast is shown (nonce bump): a full duration
  // from now, still paused while hovered or focused.
  useEffect(() => {
    if (leavingRef.current) return;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    remaining.current = TOAST_DURATION_MS;
    // A cursor already resting where the toast appears fires no mouseenter until it moves.
    if (itemRef.current?.matches(':hover')) hovered.current = true;
    if (!hovered.current && !focused.current) start(TOAST_DURATION_MS);
  }, [start, toast.nonce]);

  useEffect(
    () => () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (exitTimer.current) clearTimeout(exitTimer.current);
    },
    []
  );

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) onFocusEntered(e.relatedTarget);
    focused.current = true;
    pause();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    focused.current = false;
    resume();
  };

  return (
    <div
      ref={itemRef}
      data-toast-id={toast.id}
      className={cx('ui-toast', `ui-toast--${toast.type}`, leaving && 'ui-toast--leaving')}
      onMouseEnter={() => {
        hovered.current = true;
        pause();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        resume();
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <Banner
        live={false}
        tone={BANNER_TONE[toast.type]}
        action={
          <Button variant="ghost" size="sm" aria-label="Dismiss notification" onClick={leave}>
            <Icon name="x" size={16} />
          </Button>
        }
      >
        <span className="ui-toast__message">{toast.message}</span>
      </Banner>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
