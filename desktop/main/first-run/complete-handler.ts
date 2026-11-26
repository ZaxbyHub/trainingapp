/** First-run completion handler and Electron registration adapter (#373). */

export type FirstRunCompleteResult =
  | { ok: true }
  | { ok: false; detail: string; reason?: string };

export interface FirstRunCompleteDeps {
  completeWizard(payload: { selectedProfile: 'quality' | 'fast'; acknowledgedLicenses: boolean }): Promise<void> | void;
  backendHost?: {
    applyEngineSettings?: (
      patch: Record<string, unknown>,
    ) => Promise<{ ok: true } | { ok: false; status: number; detail: string }> | { ok: true } | { ok: false; status: number; detail: string };
  } | null;
  engine?: { warmup?: () => void | Promise<void> } | null;
}

/** Build the payload-only product. Electron's event argument is removed by the adapter below. */
export function buildFirstRunCompleteHandler(
  deps: FirstRunCompleteDeps,
): (payload: unknown) => Promise<FirstRunCompleteResult> {
  return async (payload: unknown): Promise<FirstRunCompleteResult> => {
    try {
      const request = (typeof payload === 'object' && payload !== null ? payload : {}) as {
        selectedProfile?: unknown;
        acknowledgedLicenses?: unknown;
      };
      const selectedProfile =
        request.selectedProfile === 'quality' || request.selectedProfile === 'fast'
          ? request.selectedProfile
          : null;
      if (selectedProfile === null) {
        return {
          ok: false,
          detail: 'select-profile: no profile was selected',
          reason: 'profile-not-selected',
        };
      }
      const acknowledgedLicenses = request.acknowledgedLicenses === true;
      await deps.completeWizard({ selectedProfile, acknowledgedLicenses });

      // AWAIT before reading `.ok`: the old synchronous read treated the
      // Promise object as a successful apply and warmed up too early.
      const applied = await deps.backendHost?.applyEngineSettings?.({
        'inference.profile': selectedProfile,
      });
      if (applied !== undefined && !applied.ok) {
        console.error(
          `[trainingapp-desktop] first-run profile could not be applied to the engine: ${applied.detail}`,
        );
      } else {
        await Promise.resolve(deps.engine?.warmup?.()).catch(() => {});
      }
      return { ok: true };
    } catch (error) {
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error && typeof error.reason === 'string'
          ? error.reason
          : undefined;
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        ...(reason === undefined ? {} : { reason }),
      };
    }
  };
}

/** Register exactly one real Electron `(event, payload)` handler. */
export function registerFirstRunCompleteIpc(
  ipc: { handle(channel: string, callback: unknown): void },
  deps: FirstRunCompleteDeps,
): void {
  const handler = buildFirstRunCompleteHandler(deps);
  ipc.handle('desktop:first-run:complete', (_event: unknown, payload: unknown) => handler(payload));
}
