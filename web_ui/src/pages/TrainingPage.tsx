/**
 * TrainingPage — production mount for the embedded Storyline player
 * (issue #81, D5). The pack to open comes from the `pack` query parameter of
 * the current location (e.g. app://index.html?pack=opmed-cdp-mlc); the Learn
 * panel (D6, issue #82) will replace this page's navigation surface and link
 * here with deep links.
 */
import { useMemo } from 'react';
import { TrainingPlayer } from '../components/TrainingPlayer';

export function TrainingPage() {
  const packId = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('pack') ?? '';
  }, []);

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
        <TrainingPlayer packId={packId} />
      )}
    </div>
  );
}
