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
}

export interface ToastContextValue {
  showToast: (message: string, type: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export const TOAST_DURATION_MS = 5000;
/** Matches --dur-base (lumen-tokens.css); the leaving class fades over this long. */
export const TOAST_EXIT_MS = 200;

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
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Where focus was before it entered a toast, so dismissing a focused toast does not
  // strand focus on the document body.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const showToast = useCallback((message: string, type: ToastTone) => {
    const id = `toast-${nextId.current++}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const noteFocusEntered = useCallback((from: EventTarget | null) => {
    if (from instanceof HTMLElement && !viewportRef.current?.contains(from)) returnFocusRef.current = from;
  }, []);

  const removeToast = useCallback((id: string, hadFocus: boolean) => {
    if (hadFocus) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus();
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
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
      <div ref={viewportRef} className="ui-toast-viewport">
        <div role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions" className="ui-toast-region">
          {polite.map(renderItem)}
        </div>
        <div role="alert" aria-live="assertive" aria-atomic="false" aria-relevant="additions" className="ui-toast-region">
          {assertive.map(renderItem)}
        </div>
      </div>
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

  useEffect(() => {
    start(TOAST_DURATION_MS);
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (exitTimer.current) clearTimeout(exitTimer.current);
    };
  }, [start]);

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
