// GroundingBadge — C5 (issue #72): per-answer provenance badge.
//
// Renders the machine-readable `grounding` value emitted by every answering
// surface (Python API, desktop backend, browser orchestrator) as a small,
// unobtrusive chip on the assistant message. Accessibility contract (issue
// acceptance AC4): the badge is NEVER color-only — each variant pairs visible
// text with a distinct icon shape (circle-check vs globe) and an accessible
// name, so the value stays distinguishable in a grayscale screenshot or for
// screen readers. Lumen phase 5: built on the ui Badge.
import type { Grounding } from '../lib/api/types';
import { Badge, Icon } from '../ui';
import '../pages/chat.css';

const COPY: Record<Grounding, { label: string }> = {
  grounded: { label: 'Grounded in your documents' },
  general: { label: 'General knowledge' },
};

export function GroundingBadge({ grounding }: { grounding: Grounding | undefined | null }) {
  if (grounding !== 'grounded' && grounding !== 'general') return null;
  const copy = COPY[grounding];
  return (
    <Badge
      tone={grounding === 'grounded' ? 'accent' : 'neutral'}
      className="chat-msg__grounding"
      data-grounding={grounding}
      role="status"
      aria-live="polite"
    >
      <Icon name={grounding === 'grounded' ? 'circle-check' : 'globe'} size={14} />
      {/* No aria-label: the visible text IS the accessible name (accName
          computation would otherwise suppress it — PRR-012). */}
      <span>{copy.label}</span>
    </Badge>
  );
}

export default GroundingBadge;
