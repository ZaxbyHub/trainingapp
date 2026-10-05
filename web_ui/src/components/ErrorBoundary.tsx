/**
 * ErrorBoundary - Catches render errors in children and displays a fallback UI.
 * Used to prevent the entire app from crashing due to component errors.
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import { Button, EmptyState, Icon } from '../ui';
import './blocking.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
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

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Lumen phase 7: ui/EmptyState (title as the heading) + ui/Button, inside
      // one role="alert" region so the failure is announced once. No inline
      // styles or JS hover handlers: the Button owns its states in CSS.
      return (
        <div role="alert" className="error-fallback">
          <EmptyState
            icon="circle-alert"
            title="Something went wrong"
            description={this.state.error?.message || 'An unexpected error occurred'}
            action={
              <Button variant="primary" onClick={this.handleRetry}>
                <Icon name="rotate-ccw" size={16} />
                Try Again
              </Button>
            }
          />
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
