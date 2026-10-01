import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { cx } from './cx';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

/** Text is always rendered (no color-only status). */
export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return <span {...rest} className={cx('ui-badge', `ui-badge--${tone}`, className)} />;
}

const STATUS_ICON: Record<Exclude<Tone, 'neutral' | 'accent'>, IconName> = {
  success: 'circle-check',
  warning: 'triangle-alert',
  danger: 'circle-alert',
  info: 'info',
};

/** Badge with a leading icon so status never relies on color alone. */
export function StatusPill({
  status,
  children,
  className,
}: {
  status: Exclude<Tone, 'neutral' | 'accent'>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={status} className={cx('ui-status-pill', className)}>
      <Icon name={STATUS_ICON[status]} size={14} />
      {children}
    </Badge>
  );
}

export interface BannerProps {
  tone?: Exclude<Tone, 'neutral' | 'accent'>;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** role="alert" for danger/warning (interrupting), role="status" otherwise. */
export function Banner({ tone = 'info', title, children, action, className }: BannerProps) {
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
  return (
    <div role={role} className={cx('ui-banner', `ui-banner--${tone}`, className)}>
      <Icon name={STATUS_ICON[tone]} className="ui-banner__icon" />
      <div className="ui-banner__body">
        {title ? <p className="ui-banner__title">{title}</p> : null}
        {children ? <div className="ui-banner__text">{children}</div> : null}
      </div>
      {action ? <div className="ui-banner__action">{action}</div> : null}
    </div>
  );
}

/** Purely decorative placeholder; hidden from assistive tech. */
export function Skeleton({ width, height = 16, className }: { width?: number | string; height?: number | string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('ui-skeleton', className)}
      style={{ width, height }}
    />
  );
}

export interface ProgressBarProps {
  label: string;
  /** Omit for indeterminate. */
  value?: number;
  max?: number;
  className?: string;
}

export function ProgressBar({ label, value, max = 100, className }: ProgressBarProps) {
  const determinate = value !== undefined;
  const pct = determinate ? Math.min(100, Math.max(0, (value / max) * 100)) : undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={determinate ? value : undefined}
      className={cx('ui-progress', !determinate && 'ui-progress--indeterminate', className)}
    >
      <div className="ui-progress__fill" style={determinate ? { width: `${pct}%` } : undefined} />
    </div>
  );
}

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd {...rest} className={cx('ui-kbd', className)} />;
}
