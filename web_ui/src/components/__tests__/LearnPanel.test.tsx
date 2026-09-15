/**
 * LearnPanel component tests (issue #82, D6) — FROZEN check C8.
 *
 * Asserts the Learn panel renders "Section > Slide title" rows with
 * snippets and that clicking "Open in training" invokes the navigation
 * callback with the correct slide id (spy — the jump primitive itself is
 * TrainingPlayer's, covered by its own suite and the desktop e2e).
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LearnPanel } from '../LearnPanel';
import type { LearnResult } from '../../lib/api/types';

const SAMPLE: LearnResult[] = [
  {
    slide_id: '5rN4PvXJM5d',
    title: 'Welcome',
    section: 'Course Introduction',
    score: 0.91,
    reason: 'direct',
    snippet: 'Start / OpMed CDP MicroLearning Companion',
  },
  {
    slide_id: '6RdggQhakWc',
    title: 'Slides And Charts',
    section: '',
    score: 0.55,
    reason: 'linked',
  },
];

describe('LearnPanel', () => {
  test('renders section > title rows with snippets', () => {
    render(<LearnPanel learn={SAMPLE} />);
    expect(screen.getByText(/Course Introduction > Welcome/)).toBeDefined();
    expect(screen.getByText(/Slides And Charts/)).toBeDefined();
    expect(screen.getByText(/OpMed CDP MicroLearning Companion/)).toBeDefined();
    const region = screen.getByRole('region', { name: /learn panel/i });
    expect(region).toBeDefined();
  });

  test('Open in training invokes onOpenTraining with the correct slide id', () => {
    const onOpenTraining = vi.fn();
    render(<LearnPanel learn={SAMPLE} onOpenTraining={onOpenTraining} />);
    const buttons = screen.getAllByRole('button', { name: /open in training/i });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]);
    expect(onOpenTraining).toHaveBeenCalledTimes(1);
    expect(onOpenTraining).toHaveBeenCalledWith({ packId: undefined, slideId: '5rN4PvXJM5d' });

    fireEvent.click(buttons[1]);
    expect(onOpenTraining).toHaveBeenCalledWith({ packId: undefined, slideId: '6RdggQhakWc' });
  });

  test('forwards the pack id when the learn result carries one', () => {
    const onOpenTraining = vi.fn();
    const withPack: LearnResult[] = [{ ...SAMPLE[0], pack_id: 'opmed-cdp-mlc' }];
    render(<LearnPanel learn={withPack} onOpenTraining={onOpenTraining} />);
    fireEvent.click(screen.getByRole('button', { name: /open in training/i }));
    expect(onOpenTraining).toHaveBeenCalledWith({ packId: 'opmed-cdp-mlc', slideId: '5rN4PvXJM5d' });
  });

  test('renders nothing for an empty learn array', () => {
    const { container } = render(<LearnPanel learn={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
