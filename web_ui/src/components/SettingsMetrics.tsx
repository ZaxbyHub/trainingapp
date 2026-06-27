import React from 'react';

interface ProgressBarProps {
  value: number;
  max?: number;
  label: string;
  color?: 'success' | 'warning' | 'danger' | 'info' | 'primary';
  className?: string;
}

export function ProgressBar({ value, max = 100, label, color = 'primary', className = '' }: ProgressBarProps) {
  const percentage = max > 0 ? Math.min(Math.max(Math.round((value / max) * 100), 0), 100) : 0;
  const colorMap: Record<string, string> = {
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    danger: 'var(--color-danger)',
    info: 'var(--color-info)',
    primary: 'var(--color-primary)',
  };
  return (
    <div className={className} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}
      style={{ width: '100%', marginBottom: 'var(--spacing-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--spacing-xs)', fontSize: 'var(--font-size-caption)', fontFamily: 'var(--font-family)', color: 'var(--color-text-muted)' }}>
        <span>{label}</span>
        <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>{percentage}%</span>
      </div>
      <div style={{ height: '12px', backgroundColor: 'var(--color-bubble-system)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${percentage}%`, backgroundColor: colorMap[color], transition: 'width 400ms cubic-bezier(0.4, 0, 0.2, 1)', borderRadius: 'var(--radius-sm)' }} />
      </div>
    </div>
  );
}

type StatusType = 'ready' | 'not-ready' | 'error';

interface StatusBadgeProps {
  status: StatusType;
  label?: string;
  showDot?: boolean;
}

export function StatusBadge({ status, label, showDot = true }: StatusBadgeProps) {
  const config: Record<StatusType, { color: string; text: string }> = {
    ready: { color: 'var(--color-success)', text: 'var(--color-success)' },
    'not-ready': { color: 'var(--color-warning)', text: 'var(--color-warning)' },
    error: { color: 'var(--color-danger)', text: 'var(--color-danger)' },
  };
  const { color, text } = config[status];
  const displayLabel = label || ({ ready: 'Ready', 'not-ready': 'Not Ready', error: 'Error' }[status]);
  return (
    <span role="status" aria-live="polite"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)', padding: '2px 10px', backgroundColor: 'var(--color-surface)', border: `1px solid ${color}`, borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-caption)', fontFamily: 'var(--font-family)', fontWeight: 600, color: text, lineHeight: 1.4 }}>
      {showDot && <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: color, borderRadius: '50%' }} aria-hidden="true" />}
      {displayLabel}
    </span>
  );
}

interface SectionCardProps {
  children: React.ReactNode;
  title: string;
  id?: string;
  description?: string;
}

export function SectionCard({ children, title, id, description }: SectionCardProps) {
  return (
    <section style={{ backgroundColor: 'var(--color-surface)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: 'var(--spacing-lg)', border: '1px solid var(--color-bubble-system)', marginBottom: 'var(--spacing-xxl)' }} aria-labelledby={id}>
      <h2 id={id} style={{ fontSize: 'var(--font-size-h2)', fontFamily: 'var(--font-family)', fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 var(--spacing-md) 0', paddingBottom: 'var(--spacing-sm)', borderBottom: '1px solid var(--color-bubble-system)' }}>{title}</h2>
      {description && <p style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-text-muted)', margin: '0 0 var(--spacing-lg) 0', lineHeight: 'var(--line-height-body)' }}>{description}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>{children}</div>
    </section>
  );
}
