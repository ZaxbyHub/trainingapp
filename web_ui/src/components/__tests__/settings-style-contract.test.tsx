/**
 * AC8 (issue #41 D1) — PRESERVING style-contract guard for the Settings radio
 * groups.
 *
 * RED at base? No: this guard is GREEN at base and must STAY green after the
 * fix. The original D1 defect (React "Removing a style property during
 * rerender" warnings from mixed shorthand/non-shorthand border style objects —
 * `border: '2px solid transparent'` on unselected radios vs a `borderColor`
 * longhand on selected ones) was removed by the Lumen phase 4 settings
 * redesign (82f5bc42): radio rendering moved into `SettingsRadioCards`
 * (web_ui/src/components/SettingsControls.tsx) and the inline style objects
 * were replaced by `ui-radio-card*` CSS classes. This spec freezes that good
 * state so a reintroduced mixed style object (border shorthand + borderColor
 * longhand on the same rendered element, or across a rerender flip) fails the
 * suite again.
 *
 * Render-surface choice: `SettingsRadioCards` IS the extracted component that
 * now owns every Settings radio group render, so rendering it directly (two
 * groups, driven through selected and unselected states in both directions)
 * exercises the whole D1 surface without mounting the SettingsPage data model.
 *
 * Success anchor (consumed by repro check C8's --expect):
 *   anchor present: style-contract clean
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsRadioCards } from '../SettingsControls';

/**
 * The React dev-build warning family for shorthand/longhand style mixing. Any
 * one substring identifies the contract violation ("Removing a style property
 * during rerender (borderColor) when a conflicting property is set (border)
 * can lead to styling bugs ...").
 */
const STYLE_WARNING_PATTERN =
  /Removing a style property|a style property during rerender|can lead to styling bugs/;

/** Spy console.error/console.warn and collect only style-contract warnings. */
function spyOnStyleWarnings() {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return {
    styleWarnings(): string[] {
      const calls = [...errorSpy.mock.calls, ...warnSpy.mock.calls];
      return calls
        .map((args) => args.map((arg) => String(arg)).join(' '))
        .filter((text) => STYLE_WARNING_PATTERN.test(text));
    },
    restore() {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

type QualityValue = 'quality' | 'balanced' | 'speed';
const qualityOptions: readonly { value: QualityValue; label: ReactNode; description: ReactNode }[] = [
  { value: 'quality', label: 'Quality', description: 'Best retrieval quality' },
  { value: 'balanced', label: 'Balanced', description: 'Default mix of speed and quality' },
  { value: 'speed', label: 'Speed', description: 'Fastest responses' },
];

type LaunchValue = 'system' | 'light' | 'dark';
const launchOptions: readonly { value: LaunchValue; label: ReactNode }[] = [
  { value: 'system', label: 'Follow system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function QualityGroup({ selected }: { selected: QualityValue | null }) {
  return (
    <SettingsRadioCards
      legend="Response Quality preset"
      name="rag-preset"
      options={qualityOptions}
      isChecked={(value) => value === selected}
      onChange={() => undefined}
    />
  );
}

function LaunchGroup({ selected }: { selected: LaunchValue | null }) {
  return (
    <SettingsRadioCards
      legend="Launch mode"
      name="launch-mode"
      options={launchOptions}
      isChecked={(value) => value === selected}
      onChange={() => undefined}
    />
  );
}

describe('Settings radio-card style contract (AC8, issue #41 D1)', () => {
  it('renders the radio groups through selection flips without any React style warning', () => {
    const spy = spyOnStyleWarnings();
    try {
      // Group 1 starts with an option checked; group 2 starts fully unselected
      // (the exact D1 configuration where unselected cards carried the
      // `border` shorthand and the selected card the `borderColor` longhand).
      const view = render(
        <>
          <QualityGroup selected="balanced" />
          <LaunchGroup selected={null} />
        </>
      );

      // Non-vacuous render proof: both groups' native radios are in the
      // accessibility tree, with the expected initial checked states.
      expect(screen.getAllByRole('radio')).toHaveLength(6);
      expect(screen.getByRole('radio', { name: 'Balanced' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Follow system' })).not.toBeChecked();

      // Drive every option of both groups through unselected -> selected and
      // selected -> unselected rerenders; the historical warning fired on
      // exactly these rerender transitions.
      view.rerender(
        <>
          <QualityGroup selected="quality" />
          <LaunchGroup selected="dark" />
        </>
      );
      view.rerender(
        <>
          <QualityGroup selected="speed" />
          <LaunchGroup selected="light" />
        </>
      );
      view.rerender(
        <>
          <QualityGroup selected={null} />
          <LaunchGroup selected={null} />
        </>
      );
      expect(screen.getByRole('radio', { name: 'Speed' })).not.toBeChecked();

      const warnings = spy.styleWarnings();
      expect(
        warnings,
        `AC8 violation: React emitted style-contract warnings for the Settings radio groups: ${warnings.join(' | ')}`
      ).toEqual([]);

      // Success anchor consumed by repro check C8 (--expect).
      console.log('anchor present: style-contract clean');
    } finally {
      spy.restore();
    }
  });

  it('spy sensitivity control: a reintroduced mixed border style object trips the warning', () => {
    // Negative control proving the guard above is not vacuous: if someone
    // reintroduces the D1 inline styles (border shorthand + borderColor
    // longhand on the same rendered element), React's dev build must warn and
    // this file must fail. If this control ever stops firing, the spy wiring
    // (not the component) has rotted and this spec must be repaired.
    function D1RegressionProbe({ mixed }: { mixed: boolean }) {
      return (
        <div
          data-testid="d1-probe"
          style={
            mixed
              ? { border: '2px solid transparent', borderColor: 'var(--ui-accent)' }
              : { border: '2px solid transparent' }
          }
        >
          probe
        </div>
      );
    }

    const spy = spyOnStyleWarnings();
    try {
      const probe = render(<D1RegressionProbe mixed />);
      expect(screen.getByTestId('d1-probe')).toBeInTheDocument();
      // Drop the longhand while the conflicting shorthand remains set — the
      // exact rerender shape that produced the original D1 warning.
      probe.rerender(<D1RegressionProbe mixed={false} />);

      const warnings = spy.styleWarnings();
      expect(
        warnings.length,
        'AC8 spy-sensitivity control failed: the mixed border/borderColor probe did NOT trip a React style warning — the zero-warnings assertion above would be vacuous. Repair the spy wiring.'
      ).toBeGreaterThan(0);
    } finally {
      spy.restore();
    }
  });
});
