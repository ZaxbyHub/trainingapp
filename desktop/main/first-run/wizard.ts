// E2 first-run wizard (issue #85): the state machine.
//
// Pure and Electron-free: inputs are plain values, outputs are plain values.
// The IPC layer (desktop/main/index.ts) orchestrates host/verifier/store
// calls around this module. Step order is issue-pinned:
//   detect-hardware -> select-profile -> verify-manifest -> activate-packs
//   -> licensing-notices -> complete

export const WIZARD_STEPS = [
  'detect-hardware',
  'select-profile',
  'verify-manifest',
  'activate-packs',
  'licensing-notices',
  'complete',
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export type WizardBlockerReason =
  | 'manifest-verify-failed'
  | 'licenses-not-acknowledged'
  | 'profile-not-selected'
  | 'packs-not-active';

export class WizardBlockError extends Error {
  readonly reason: WizardBlockerReason;
  constructor(reason: WizardBlockerReason, detail: string) {
    super(detail);
    this.name = 'WizardBlockError';
    this.reason = reason;
  }
}

export interface CompletionInput {
  selectedProfile: 'quality' | 'fast';
  acknowledgedLicenses: boolean;
  /** Whether the verify-manifest step passed (failures list must be empty when
   *  a manifest was verified; `null` means no manifest was staged — the
   *  fail-closed-vs-degrade decision happened upstream). */
  manifestOk: boolean | null;
  /** Packs the manifest required, minus the ones that ended active. Empty = satisfied. */
  inactiveRequiredPacks: string[];
}

/**
 * The single completion guard: completion is impossible without an explicit
 * profile choice, explicit license acknowledgment, a passed (or explicitly
 * absent) manifest verification, and every manifest-required pack active.
 * Each refusal names the specific unmet gate — never a generic message.
 */
export function assertCanComplete(input: CompletionInput): void {
  if (input.selectedProfile !== 'quality' && input.selectedProfile !== 'fast') {
    throw new WizardBlockError('profile-not-selected', 'select-profile: no profile was selected');
  }
  if (input.manifestOk === false) {
    throw new WizardBlockError(
      'manifest-verify-failed',
      'verify-manifest: integrity verification failed; resolve the named file failures first',
    );
  }
  if (input.inactiveRequiredPacks.length > 0) {
    throw new WizardBlockError(
      'packs-not-active',
      `activate-packs: required packs are not active: ${input.inactiveRequiredPacks.join(', ')}`,
    );
  }
  if (input.acknowledgedLicenses !== true) {
    throw new WizardBlockError(
      'licenses-not-acknowledged',
      'licensing-notices: the license acknowledgment checkbox is required and cannot be skipped',
    );
  }
}

/** True when the operator force-ran (Settings "Re-run setup") — surfaced so
 *  the UI can label the run as a re-run rather than a failure retry. */
export function isRerun(reason: 'not-completed' | 'drift' | 'reset' | 'complete'): boolean {
  return reason === 'reset' || reason === 'drift';
}

/**
 * The fail-closed rule for the manifest at completion time: a packaged install
 * without its manifest is a BROKEN INSTALL (block); a staged manifest must
 * have zero failures (block otherwise); a dev/CI tree with nothing staged has
 * nothing to verify (null = not applicable, completion allowed).
 */
export function manifestCompletionState(options: {
  packaged: boolean;
  staged: boolean;
  failureCount: number;
}): boolean | null {
  if (options.packaged && !options.staged) return false;
  if (options.staged) return options.failureCount === 0;
  return null;
}
