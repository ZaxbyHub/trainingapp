/**
 * Settings metrics (Lumen phase 4): the labelled meter and the status badge used by
 * the Settings page, built on the ui/ classes (`ui-progress`, `ui-badge`). Lumen
 * tokens only (components/settings-hygiene.test.ts). The former SectionCard was
 * retired with the phase-4 migration: Settings uses one section style
 * (SettingsControls.SettingsSection).
 */
import { Badge, Icon, type IconName } from '../ui';
import './settings.css';

export type MeterTone = 'success' | 'warning' | 'danger' | 'info' | 'primary';

export interface ProgressBarProps {
  value: number;
  max?: number;
  label: string;
  /** Fill tone; 'primary' is the accent fill. */
  color?: MeterTone;
  className?: string;
}

/**
 * A meter with its label and percentage written out (the fill is never the only
 * cue). role="progressbar" sits on the whole meter, so the label is part of it.
 */
export function ProgressBar({ value, max = 100, label, color = 'primary', className = '' }: ProgressBarProps) {
  const percentage = max > 0 ? Math.min(Math.max(Math.round((value / max) * 100), 0), 100) : 0;
  const classes = ['settings-meter', color === 'primary' ? '' : `settings-meter--${color}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      data-tone={color}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div className="settings-meter__head">
        <span>{label}</span>
        <span className="settings-meter__value">{percentage}%</span>
      </div>
      <div className="ui-progress">
        <div className="ui-progress__fill" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

export type StatusType = 'ready' | 'not-ready' | 'error';

export interface StatusBadgeProps {
  status: StatusType;
  label?: string;
  /** Leading status icon (its shape repeats the state, so color is never the only cue). */
  showDot?: boolean;
}

const STATUS_TONE = { ready: 'success', 'not-ready': 'warning', error: 'danger' } as const;
const STATUS_ICON: Record<StatusType, IconName> = {
  ready: 'circle-check',
  'not-ready': 'triangle-alert',
  error: 'circle-alert',
};
const DEFAULT_LABEL: Record<StatusType, string> = { ready: 'Ready', 'not-ready': 'Not Ready', error: 'Error' };

export function StatusBadge({ status, label, showDot = true }: StatusBadgeProps) {
  return (
    <Badge
      tone={STATUS_TONE[status]}
      role="status"
      aria-live="polite"
      data-status={status}
      className="settings-status-badge"
    >
      {showDot && (
        <span aria-hidden="true" className="settings-status-badge__icon">
          <Icon name={STATUS_ICON[status]} size={12} />
        </span>
      )}
      {label || DEFAULT_LABEL[status]}
    </Badge>
  );
}
