import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

interface ToastProviderProps {
  children: React.ReactNode;
}

const TOAST_DURATION_MS = 5000;
const EXIT_ANIMATION_MS = 300;

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    const id = `toast-${toastIdRef.current++}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        style={{
          position: 'fixed',
          bottom: 'var(--spacing-xl)',
          right: 'var(--spacing-xl)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-md)',
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onDismiss={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: () => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remaining time + deadline support pausing on hover/focus and resuming on
  // leave/blur without resetting the full duration each time.
  const remainingRef = useRef<number>(TOAST_DURATION_MS);
  const deadlineRef = useRef<number>(0);

  const scheduleDismiss = useCallback((delay: number) => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
    }
    deadlineRef.current = Date.now() + delay;
    remainingRef.current = delay;
    dismissTimerRef.current = setTimeout(() => {
      setIsLeaving(true);
      exitTimerRef.current = setTimeout(onDismiss, EXIT_ANIMATION_MS);
    }, delay);
  }, [onDismiss]);

  useEffect(() => {
    // Trigger entrance animation
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    scheduleDismiss(TOAST_DURATION_MS);

    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, [scheduleDismiss]);

  const pauseAutoDismiss = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    // Freeze the remaining time so resume continues from where it left off.
    remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
  }, []);

  const resumeAutoDismiss = useCallback(() => {
    scheduleDismiss(remainingRef.current);
  }, [scheduleDismiss]);

  // AA-compliant backgrounds with white text (verified ratios, both themes):
  // success 5.02:1, info 5.93:1, error 4.98:1.
  const getBackgroundColor = () => {
    switch (toast.type) {
      case 'success':
        return 'var(--color-success-strong)';
      case 'error':
        return 'var(--color-danger)';
      case 'info':
        return 'var(--color-info-strong)';
    }
  };

  const handleDismiss = () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
    }
    setIsLeaving(true);
    exitTimerRef.current = setTimeout(onDismiss, EXIT_ANIMATION_MS);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleDismiss();
    }
  };

  // role: assertive for errors (time-sensitive), polite status otherwise.
  const role = toast.type === 'error' ? 'alert' : 'status';

  return (
    <div
      role={role}
      tabIndex={0}
      onMouseEnter={pauseAutoDismiss}
      onMouseLeave={resumeAutoDismiss}
      onFocus={pauseAutoDismiss}
      onBlur={resumeAutoDismiss}
      style={{
        backgroundColor: getBackgroundColor(),
        color: 'var(--color-text-on-primary)',
        padding: 'var(--spacing-lg) var(--spacing-xl)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--font-size-body)',
        fontFamily: 'var(--font-family)',
        boxShadow: 'var(--shadow-md)',
        minWidth: '200px',
        maxWidth: '350px',
        pointerEvents: 'auto',
        cursor: 'pointer',
        opacity: isVisible && !isLeaving ? 1 : 0,
        transform: isVisible && !isLeaving ? 'translateY(0)' : 'translateY(20px)',
        transition: 'opacity 300ms ease, transform 300ms ease',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--spacing-sm)',
      }}
      onClick={handleDismiss}
      onKeyDown={handleKeyDown}
    >
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleDismiss();
        }}
        aria-label="Dismiss notification"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 'var(--font-size-body)',
          lineHeight: 1,
          padding: 0,
          flexShrink: 0,
          opacity: 0.8,
        }}
      >
        ✕
      </button>
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
