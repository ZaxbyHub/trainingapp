/**
 * LoadingSkeleton Tests
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, test, expect } from 'vitest';
import { LoadingSkeleton } from './LoadingSkeleton';

describe('LoadingSkeleton', () => {
  test('Renders text variant by default', () => {
    render(<LoadingSkeleton />);
    
    const skeleton = screen.getByRole('status');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  test('Renders all 4 variants (text, card, avatar, button)', () => {
    const variants: Array<'text' | 'card' | 'avatar' | 'button'> = ['text', 'card', 'avatar', 'button'];
    
    for (const variant of variants) {
      const { unmount } = render(<LoadingSkeleton variant={variant} />);
      const skeleton = screen.getByRole('status');
      expect(skeleton).toBeInTheDocument();
      expect(skeleton).toHaveAttribute('aria-busy', 'true');
      expect(skeleton.firstChild).toBeInTheDocument();
      unmount();
    }
  });

  test('aria-busy is set to true', () => {
    const { container } = render(<LoadingSkeleton variant="text" />);
    const skeleton = container.querySelector('[role="status"]');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  test('Count prop renders multiple skeletons', () => {
    render(<LoadingSkeleton variant="text" count={3} />);
    
    const skeleton = screen.getByRole('status');
    // With count=3, there should be 3 child skeleton elements
    const children = skeleton.children;
    expect(children.length).toBe(3);
  });

  test('Single count renders one skeleton without wrapper', () => {
    render(<LoadingSkeleton variant="text" count={1} />);
    
    const skeleton = screen.getByRole('status');
    const children = skeleton.children;
    expect(children.length).toBe(1);
  });

  test('Custom width applied to skeleton', () => {
    render(<LoadingSkeleton variant="text" width="200px" />);
    
    const skeleton = screen.getByRole('status');
    const skeletonChild = skeleton.firstChild as HTMLElement;
    expect(skeletonChild.style.width).toBe('200px');
  });

  test('Custom height applied to skeleton', () => {
    render(<LoadingSkeleton variant="text" height="30px" />);
    
    const skeleton = screen.getByRole('status');
    const skeletonChild = skeleton.firstChild as HTMLElement;
    expect(skeletonChild.style.height).toBe('30px');
  });

  test('Custom width and height both applied', () => {
    render(<LoadingSkeleton variant="card" width="300px" height="200px" />);
    
    const skeleton = screen.getByRole('status');
    const skeletonChild = skeleton.firstChild as HTMLElement;
    expect(skeletonChild.style.width).toBe('300px');
    expect(skeletonChild.style.height).toBe('200px');
  });

  test('Aria-label is set correctly', () => {
    render(<LoadingSkeleton ariaLabel="Custom loading label" />);
    
    const skeleton = screen.getByRole('status');
    expect(skeleton).toHaveAttribute('aria-label', 'Custom loading label');
  });

  test('Card variant has correct border-radius', () => {
    render(<LoadingSkeleton variant="card" width="100px" height="100px" />);
    
    const skeleton = screen.getByRole('status');
    const skeletonChild = skeleton.firstChild as HTMLElement;
    expect(skeletonChild.style.borderRadius).toBe('8px');
  });

  test('Avatar variant is circular', () => {
    render(<LoadingSkeleton variant="avatar" size="48px" />);
    
    const skeleton = screen.getByRole('status');
    const skeletonChild = skeleton.firstChild as HTMLElement;
    expect(skeletonChild.style.borderRadius).toBe('50%');
  });

  test('Button variant has correct height', () => {
    render(<LoadingSkeleton variant="button" />);
    
    const skeleton = screen.getByRole('status');
    const skeletonChild = skeleton.firstChild as HTMLElement;
    expect(skeletonChild.style.height).toBe('36px');
  });
});
