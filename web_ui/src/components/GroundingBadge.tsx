// GroundingBadge — C5 (issue #72): per-answer provenance badge.
//
// Renders the machine-readable `grounding` value emitted by every answering
// surface (Python API, desktop backend, browser orchestrator) as a small,
// unobtrusive chip on the assistant message. Accessibility contract (issue
// acceptance AC4): the badge is NEVER color-only — each variant pairs visible
// text with a distinct inline-SVG icon shape and an accessible name, so the
// value stays distinguishable in a grayscale screenshot or for screen readers.
import type { Grounding } from '../lib/api/types';

const COPY: Record<Grounding, { label: string; ariaLabel: string }> = {
  grounded: { label: 'Grounded in your documents', ariaLabel: 'Answer grounded in your documents' },
  general: { label: 'General knowledge', ariaLabel: 'Answer from general knowledge — no document evidence' },
};

/** Distinct glyph shapes (not color) carry the variant: a check-dot for
 *  grounded, a globe for general. aria-hidden — the text carries the name. */
function BadgeIcon({ variant }: { variant: Grounding }) {
  const shared = {
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    'aria-hidden': true as const,
    focusable: false as const,
    style: { flexShrink: 0 },
  };
  if (variant === 'grounded') {
    return (
      <svg {...shared}>
        {/* filled circle with a cut-out check: reads as a "verified" mark */}
        <path
          d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.1 4.7-3.8 4.6a.8.8 0 0 1-1.2.05L4.3 8.5l1-1 1.2 1.2 3.3-4 1.3 1Z"
          fill="currentColor"
          fillRule="evenodd"
        />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      {/* globe: circle + meridian strokes read as "world knowledge" */}
      <path
        d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5c.9 0 1.9 1.9 2.1 4.7H5.9C6.1 4.4 7.1 2.5 8 2.5ZM4.4 4.3A8.9 8.9 0 0 0 4.4 7H2.1a5.6 5.6 0 0 1 2.3-2.7Zm-.3 4.2h.3c.1 1 .3 1.9.6 2.7A5.6 5.6 0 0 1 4.1 8.5Zm1.8 0h4.2C9.9 11.3 8.9 13.5 8 13.5c-.9 0-1.9-2.2-2.1-5Zm5.4 0h.3a8.9 8.9 0 0 0-.3 2.7 5.6 5.6 0 0 1-2.7 2.3c.4-.8.6-1.7.7-2.7h2.3Zm.3-1.5a8.9 8.9 0 0 0-.3-2.7 5.6 5.6 0 0 1 2.4 2.7h-2.1Zm-1-4.2a5.6 5.6 0 0 1 2.4 2.7h-2.3a8.9 8.9 0 0 0-.6-2.7c.2-.1.4-.1.5 0Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function GroundingBadge({ grounding }: { grounding: Grounding | undefined | null }) {
  if (grounding !== 'grounded' && grounding !== 'general') return null;
  const copy = COPY[grounding];
  return (
    <span
      role="status"
      aria-label={copy.ariaLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'calc(var(--spacing-xs) + 2px)',
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid var(--color-border, #d0d0d0)',
        fontSize: 'var(--font-size-caption)',
        color: 'var(--color-text-muted)',
        backgroundColor: 'transparent',
      }}
    >
      <BadgeIcon variant={grounding} />
      <span>{copy.label}</span>
    </span>
  );
}

export default GroundingBadge;
