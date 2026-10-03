/**
 * Tests for SettingsMetrics components (ProgressBar, StatusBadge). SectionCard was
 * retired in Lumen phase 4 (Settings uses SettingsControls.SettingsSection).
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProgressBar, StatusBadge } from '../SettingsMetrics';

describe('ProgressBar', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with correct percentage for normal values', () => {
    render(<ProgressBar value={50} max={100} label="Test Progress" />);
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('renders 0% when value is 0', () => {
    render(<ProgressBar value={0} max={100} label="Empty" />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('renders 0% when value is negative', () => {
    render(<ProgressBar value={-10} max={100} label="Negative" />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('renders 100% when value exceeds max', () => {
    render(<ProgressBar value={150} max={100} label="Overflow" />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('renders 0% when max is 0 and value is positive', () => {
    render(<ProgressBar value={50} max={0} label="Zero Max" />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('renders 0% when both value and max are 0', () => {
    render(<ProgressBar value={0} max={0} label="Zero Both" />);
    // max=0 guard returns 0 to prevent NaN
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('renders correct percentage for partial values', () => {
    render(<ProgressBar value={33} max={100} label="Partial" />);
    expect(screen.getByText('33%')).toBeTruthy();
  });

  it('renders label text', () => {
    render(<ProgressBar value={25} max={100} label="Storage Used" />);
    expect(screen.getByText('Storage Used')).toBeTruthy();
  });

  // Lumen phase 4 (test budget, design-language.md section 6): the tone is a state
  // class on the meter, not an inline background color.
  it('exposes its tone as a state class and its value through ARIA', () => {
    render(<ProgressBar value={60} max={120} label="Color Test" color="success" />);
    const bar = screen.getByRole('progressbar', { name: 'Color Test' });
    expect(bar).toHaveClass('settings-meter', 'settings-meter--success');
    expect(bar).toHaveAttribute('data-tone', 'success');
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).toHaveAttribute('aria-valuemax', '120');
    expect(bar).toHaveTextContent('50%');
  });

  it('the default (primary) tone uses the accent fill: no tone modifier class', () => {
    render(<ProgressBar value={10} label="Accent" />);
    const bar = screen.getByRole('progressbar', { name: 'Accent' });
    expect(bar).toHaveAttribute('data-tone', 'primary');
    expect(bar.className).not.toMatch(/settings-meter--/);
  });

  it('handles custom max value', () => {
    render(<ProgressBar value={75} max={200} label="Custom Max" />);
    expect(screen.getByText('38%')).toBeTruthy();
  });
});

describe('StatusBadge', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Renders all status types', () => {
    it('renders ready status with default label', () => {
      render(<StatusBadge status="ready" />);
      expect(screen.getByText('Ready')).toBeTruthy();
    });

    it('renders not-ready status with default label', () => {
      render(<StatusBadge status="not-ready" />);
      expect(screen.getByText('Not Ready')).toBeTruthy();
    });

    it('renders error status with default label', () => {
      render(<StatusBadge status="error" />);
      expect(screen.getByText('Error')).toBeTruthy();
    });
  });

  describe('Custom label', () => {
    it('renders custom label when provided', () => {
      render(<StatusBadge status="ready" label="Custom Ready" />);
      expect(screen.getByText('Custom Ready')).toBeTruthy();
      expect(screen.queryByText('Ready')).toBeNull();
    });
  });

  describe('Dot visibility', () => {
    it('shows dot by default', () => {
      const { container } = render(<StatusBadge status="ready" showDot={true} />);
      const dot = container.querySelector('span[aria-hidden="true"]');
      expect(dot).toBeTruthy();
      expect(dot?.textContent).toBe('');
    });

    it('hides dot when showDot is false', () => {
      const { container } = render(<StatusBadge status="ready" showDot={false} />);
      const dots = container.querySelectorAll('span[aria-hidden="true"]');
      expect(dots).toHaveLength(0);
    });

    it('hides dot when showDot is explicitly false', () => {
      const { container } = render(<StatusBadge status="error" showDot={false} />);
      const dots = container.querySelectorAll('span[aria-hidden="true"]');
      expect(dots).toHaveLength(0);
    });
  });

  describe('Accessibility', () => {
    it('has role status', () => {
      const { container } = render(<StatusBadge status="ready" />);
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });

    it('has aria-live polite', () => {
      const { container } = render(<StatusBadge status="ready" />);
      expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
    });
  });
});
