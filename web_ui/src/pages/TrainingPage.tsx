/**
 * TrainingPage — production mount for the embedded Storyline player
 * (issue #81, D5). The pack to open comes from the `pack` query parameter of
 * the current location (e.g. app://index.html?pack=opmed-cdp-mlc), with the
 * Learn panel (D6, issue #82) able to deep-link here: an `initialPackId`
 * prop (lifted navigation target from chat) takes precedence, and a
 * `pendingSlideId` is passed to the player as its initialSlideId so the
 * auto-jump fires exactly once, after the pack resolves.
 */
import { useMemo } from 'react';
import { TrainingPlayer } from '../components/TrainingPlayer';

export interface TrainingPageProps {
  /** D6 (issue #82): pack from the lifted chat navigation target. */
  initialPackId?: string;
  /** D6 (issue #82): slide to jump to once a pack is open. */
  pendingSlideId?: string;
}

export function TrainingPage({ initialPackId, pendingSlideId }: TrainingPageProps) {
  const packId = useMemo(() => {
    if (initialPackId !== undefined && initialPackId !== '') return initialPackId;
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('pack') ?? '';
  }, [initialPackId]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: 'var(--spacing-md)',
        gap: 'var(--spacing-sm)',
      }}
    >
      {packId === '' ? (
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-family)',
            fontSize: 'var(--font-size-body)',
          }}
        >
          No training pack selected. Open a pack with ?pack=&lt;packId&gt;.
        </div>
      ) : (
        <TrainingPlayer packId={packId} initialSlideId={pendingSlideId} />
      )}
    </div>
  );
}
