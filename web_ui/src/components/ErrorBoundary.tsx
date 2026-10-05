/**
 * ErrorBoundary - Catches render errors in children and displays a fallback UI.
 * Used to prevent the entire app from crashing due to component errors.
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import { Banner, Button, Icon } from '../ui';
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

      // Lumen phase 7 (design-language.md section 5: Banner for failures): a danger
      // ui/Banner (role="alert", the one announcement region) in the page, holding the
      // heading, the message and a primary "Try Again" ui/Button. Not a dialog: the
      // rest of the app (navigation) stays usable. No inline styles or JS hover handlers.
      return (
        <div className="error-fallback">
          <Banner
            tone="danger"
            action={
              <Button variant="primary" onClick={this.handleRetry}>
                <Icon name="rotate-ccw" size={16} />
                Try Again
              </Button>
            }
          >
            <h2 className="error-fallback__title">Something went wrong</h2>
            <p className="error-fallback__message">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
          </Banner>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
