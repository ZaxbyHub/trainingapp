import { useEffect, useRef } from 'react';
import { INACTIVITY_DEFAULT_MIN } from '../lib/session/inactivity';
import { startInactivityWatch } from '../lib/session/inactivity';
import { INACTIVITY_TIMEOUT_KEY } from '../lib/storage/persisted-keys';
import { anyHandlerBusy } from '../lib/session/session-clear';

/**
 * Start the workstation inactivity watch only after conversation boot replay has
 * settled. The watch holds the session-active lock in SHARED mode at startup;
 * starting it before replay would make the booting tab block its own EXCLUSIVE
 * replay until the inactivity threshold elapsed.
 */
export function useInactivityAutoClear(ready: boolean, onCleared: () => void): void {
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;

  useEffect(() => {
    if (!ready) return;
    const watch = startInactivityWatch({
      getThresholdMin: () => {
        try {
          const raw = localStorage.getItem(INACTIVITY_TIMEOUT_KEY);
          if (raw === null) return INACTIVITY_DEFAULT_MIN;
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : INACTIVITY_DEFAULT_MIN;
        } catch {
          return INACTIVITY_DEFAULT_MIN;
        }
      },
      isBusy: () => anyHandlerBusy(),
      onCleared: () => onClearedRef.current(),
    });
    return () => watch.stop();
  }, [ready]);
}
