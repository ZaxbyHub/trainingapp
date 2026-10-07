/**
 * ErrorBoundary - Catches render errors in children and displays a fallback UI.
 * Used to prevent the entire app from crashing due to component errors.
 */

import { Component, ErrorInfo, ReactNode, useEffect, useRef } from 'react';
import { Banner, Button, Icon } from '../ui';
import './blocking.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /**
   * When any entry changes (shallow, by position) while the fallback is showing, the
   * boundary resets and re-renders its children. Pass the current page so a crash on
   * one page does not stick across navigation (the boundary instance is reused by React).
   */
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * The default crash fallback. It replaces the page (and so the page's own h1), so its
 * title is the h1; on mount focus moves to it (tabIndex -1) so keyboard and screen-reader
 * users land on the failure instead of being dropped to the document start.
 */
function CrashFallback({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <div className="error-fallback">
      <Banner
        tone="danger"
        action={
          <Button variant="primary" onClick={onRetry}>
            <Icon name="rotate-ccw" size={16} />
            Try Again
          </Button>
        }
      >
        <h1 ref={titleRef} tabIndex={-1} className="error-fallback__title">
          Something went wrong
        </h1>
        <p className="error-fallback__message">{message || 'An unexpected error occurred'}</p>
      </Banner>
    </div>
  );
}

/**
 * Error boundary component that catches JavaScript errors in child components.
 * Displays a user-friendly fallback UI with error message and retry option.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error.message);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (!this.state.hasError) return;
    const prev = prevProps.resetKeys ?? [];
    const next = this.props.resetKeys ?? [];
    if (prev.length !== next.length || prev.some((k, i) => !Object.is(k, next[i]))) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Lumen phase 7 (design-language.md section 5: Banner for failures): a danger
      // ui/Banner (role="alert", the one announcement region) in the page, holding the
      // heading, the message and a primary "Try Again" ui/Button. Not a dialog: the
      // rest of the app (navigation) stays usable. No inline styles or JS hover handlers.
      return <CrashFallback message={this.state.error?.message} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
