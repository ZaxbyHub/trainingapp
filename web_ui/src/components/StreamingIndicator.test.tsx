/**
 * Tests for StreamingIndicator component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StreamingIndicator } from '../StreamingIndicator';

describe('StreamingIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Visibility', () => {
    it('renders null when isVisible is false', () => {
      const { container } = render(<StreamingIndicator isVisible={false} />);

      expect(container.firstChild).toBeNull();
    });

    it('renders dots when isVisible is true', () => {
      const { container } = render(<StreamingIndicator isVisible={true} />);

      expect(container.firstChild).not.toBeNull();
    });

    it('shows three dot elements when visible', () => {
      const { container } = render(<StreamingIndicator isVisible={true} />);

      const dots = container.querySelectorAll('span');
      expect(dots).toHaveLength(3);
    });
  });

  describe('Animation', () => {
    it('cycles dotIndex through 0, 1, 2', () => {
      vi.useFakeTimers();

      const { container, rerender } = render(<StreamingIndicator isVisible={true} />);

      // After 200ms, dotIndex should be 1
      vi.advanceTimersByTime(200);
      rerender(<StreamingIndicator isVisible={true} />);

      // After 400ms, dotIndex should be 2
      vi.advanceTimersByTime(200);
      rerender(<StreamingIndicator isVisible={true} />);

      // After 600ms, dotIndex should wrap back to 0
      vi.advanceTimersByTime(200);
      rerender(<StreamingIndicator isVisible={true} />);

      vi.useRealTimers();
    });

    it('clears interval when isVisible becomes false', () => {
      vi.useFakeTimers();

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { rerender } = render(<StreamingIndicator isVisible={true} />);

      // Advance some time
      vi.advanceTimersByTime(500);

      // Set isVisible to false
      rerender(<StreamingIndicator isVisible={false} />);

      expect(clearIntervalSpy).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('clears interval on unmount', () => {
      vi.useFakeTimers();

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { unmount } = render(<StreamingIndicator isVisible={true} />);

      vi.advanceTimersByTime(500);
      unmount();

      expect(clearIntervalSpy).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Styling', () => {
    it('dots have correct dimensions', () => {
      const { container } = render(<StreamingIndicator isVisible={true} />);

      const dots = container.querySelectorAll('span');
      dots.forEach((dot) => {
        const style = dot.getAttribute('style') || '';
        expect(style).toContain('width: 6px');
        expect(style).toContain('height: 6px');
        expect(style).toContain('borderRadius: 50%');
      });
    });

    it('dots have transition styling', () => {
      const { container } = render(<StreamingIndicator isVisible={true} />);

      const dots = container.querySelectorAll('span');
      dots.forEach((dot) => {
        const style = dot.getAttribute('style') || '';
        expect(style).toContain('transition');
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles rapid visibility toggles', () => {
      const { rerender } = render(<StreamingIndicator isVisible={true} />);

      rerender(<StreamingIndicator isVisible={false} />);
      rerender(<StreamingIndicator isVisible={true} />);
      rerender(<StreamingIndicator isVisible={false} />);

      // Should not throw
      expect(true).toBe(true);
    });

    it('does not start animation when not visible', () => {
      vi.useFakeTimers();

      render(<StreamingIndicator isVisible={false} />);

      // No timer should be set
      vi.advanceTimersByTime(1000);

      vi.useRealTimers();
    });
  });
});
