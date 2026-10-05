/**
 * In-session first-run wizard progress (PRR-151-013).
 *
 * Escape / "Skip for now" unmounts the wizard, which used to discard the profile
 * choice, the ticked license acknowledgment and the step position. This module-level
 * store keeps them in memory for the rest of the renderer session so a reopen
 * resumes where the operator left off. Deliberately NOT persisted: nothing is
 * written to disk or storage, a restart starts fresh, and license acceptance is still
 * only ever recorded by completeFirstRun on Finish. Cleared as soon as completion
 * succeeds so a later re-run starts from the status snapshot again.
 */
export interface FirstRunSession {
  stepIndex: number;
  /** Only set once the operator explicitly picked a profile; null follows the status recommendation. */
  pickedProfile: 'quality' | 'fast' | null;
  acknowledged: boolean;
}

let session: FirstRunSession | null = null;

export const getFirstRunSession = (): FirstRunSession | null => session;

export const saveFirstRunSession = (next: FirstRunSession): void => {
  session = next;
};

export const clearFirstRunSession = (): void => {
  session = null;
};
