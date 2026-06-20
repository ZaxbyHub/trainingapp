/**
 * ErrorBoundary Tests
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, test, expect, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  // Spy on console.error to verify error logging
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    consoleSpy.mockClear();
  });

  test('Renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Child Content</div>
      </ErrorBoundary>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('Child Content');
  });

  test('Shows fallback UI when child throws', () => {
    const ThrowError = (): null => {
      throw new Error('Test error message');
    };

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>
    );

    // Default fallback shows error message
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Test error message')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  test('Custom fallback is rendered when provided', () => {
    const ThrowError = (): null => {
      throw new Error('Custom error');
    };

    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom Fallback</div>}>
        <ThrowError />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('Retry button resets error state', () => {
    let throwError = true;
    const Child = (): null => {
      if (throwError) {
        throw new Error('Child error');
      }
      return <div data-testid="recovered-child">Recovered</div>;
    };

    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );

    // Initially shows error
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Child error')).toBeInTheDocument();

    // Click retry button - this resets error state to hasError=false
    // But since Child still throws, it will re-trigger the boundary
    // So we need to also stop the child from throwing
    const retryButton = screen.getByRole('button', { name: /try again/i });
    
    // After clicking retry, if child still throws it will error again
    // So we stop the error first, then click retry
    throwError = false;
    fireEvent.click(retryButton);

    // After retry, error should be reset and children render
    // Since throwError=false now, the child renders successfully
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('recovered-child')).toBeInTheDocument();
  });

  test('Logs error to console via onError callback', () => {
    const onError = vi.fn();
    const ThrowError = (): null => {
      throw new Error('Callback test error');
    };

    render(
      <ErrorBoundary onError={onError}>
        <ThrowError />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.any(Object)
    );
    expect(onError.mock.calls[0][0].message).toBe('Callback test error');
  });

  test('Logs error to console via console.error', () => {
    const ThrowError = (): null => {
      throw new Error('Console log test');
    };

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>
    );

    // componentDidCatch calls console.error with the error
    expect(consoleSpy).toHaveBeenCalled();
  });
});
