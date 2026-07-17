/**
 * Format a timestamp as a relative-time label ("Just now", "3m ago", …).
 *
 * @param timestamp - The reference time (ms epoch, or an ISO/parsable string).
 * @param now - Optional override for "now" (ms epoch). Used by ChatMessageList's
 *   60s ticker (S8) so a re-render with a new `now` recomputes the label even
 *   though ChatMessageBubble is React.memo'd. Defaults to Date.now().
 */
export function formatRelativeTime(timestamp: string | number, now: number = Date.now()): string {
  const then = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  if (!then || isNaN(then)) return '';
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
