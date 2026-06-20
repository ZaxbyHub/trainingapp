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

  useEffect(() => {
    // Trigger entrance animation
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    // Auto-dismiss after 5 seconds
    const dismissTimer = setTimeout(() => {
      setIsLeaving(true);
      exitTimerRef.current = setTimeout(onDismiss, 300); // Wait for exit animation
    }, 5000);

    return () => {
      clearTimeout(dismissTimer);
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
      }
    };
  }, [onDismiss]);

  const getBackgroundColor = () => {
    switch (toast.type) {
      case 'success':
        return 'var(--color-primary)';
      case 'error':
        return 'var(--color-danger)';
      case 'info':
        return 'var(--color-secondary)';
    }
  };

  const handleDismiss = () => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }
    setIsLeaving(true);
    exitTimerRef.current = setTimeout(onDismiss, 300);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleDismiss();
    }
  };

  return (
    <div
      role="alert"
      tabIndex={0}
      aria-label="Dismiss notification"
      style={{
        backgroundColor: getBackgroundColor(),
        color: 'var(--color-text-on-primary)',
        padding: 'var(--spacing-lg) var(--spacing-xl)',
        borderRadius: 'var(--spacing-sm)',
        fontSize: 'var(--font-size-body)',
        fontFamily: 'var(--font-family)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        minWidth: '200px',
        maxWidth: '350px',
        pointerEvents: 'auto',
        cursor: 'pointer',
        opacity: isVisible && !isLeaving ? 1 : 0,
        transform: isVisible && !isLeaving ? 'translateY(0)' : 'translateY(20px)',
        transition: 'opacity 300ms ease, transform 300ms ease',
      }}
      onClick={handleDismiss}
      onKeyDown={handleKeyDown}
    >
      {toast.message}
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
