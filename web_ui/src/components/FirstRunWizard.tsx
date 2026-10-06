/**
 * First-run validation wizard (E2, issue #85).
 *
 * Modal stepper over the issue-pinned state machine:
 *   detect-hardware -> select-profile -> verify-manifest -> activate-packs
 *   -> licensing-notices -> complete
 *
 * Failure behavior is the point of this surface: every failure names the
 * specific file with expected/actual (never a generic "configure an LLM
 * backend"-style message), the license acknowledgment cannot be skipped, and
 * "Skip for now" only dismisses — it never completes, so the wizard re-appears
 * on the next launch until the operator finishes it.
 *
 * Lumen phase 7: built on ui/Dialog (focus trap, Escape, focus return) and
 * ui/Banner (role=alert errors); styles live in first-run.css.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Checkbox, Dialog, Icon, RadioCardGroup } from '../ui';
import {
  activateRequiredPacks,
  completeFirstRun,
  fetchFirstRunStatus,
  onFirstRunReopen,
  onFirstRunRequired,
  type FirstRunStatus,
} from '../lib/first-run';
import {
  clearFirstRunSession,
  getFirstRunSession,
  saveFirstRunSession,
} from './first-run-session';
import './first-run.css';

const WIZARD_STEPS = [
  'detect-hardware',
  'select-profile',
  'verify-manifest',
  'activate-packs',
  'licensing-notices',
  'complete',
] as const;

type Step = (typeof WIZARD_STEPS)[number];

/** Human labels for the step list and the live announcement (PRR-151-068): never the raw slugs. */
const STEP_LABELS: Record<Step, string> = {
  'detect-hardware': 'Hardware check',
  'select-profile': 'Inference profile',
  'verify-manifest': 'File integrity',
  'activate-packs': 'Knowledge packs',
  'licensing-notices': 'Licensing notices',
  complete: 'Setup complete',
};

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

function formatGiB(bytes: number): string {
  return formatBytes(bytes);
}

/**
 * App-mountable gate: fetches first-run status once, listens for the boot
 * push and the Settings "Re-run setup" reopen event, and renders the wizard
 * overlay when a run is needed. Renders nothing in browser mode.
 */
export function FirstRunGate() {
  const [status, setStatus] = useState<FirstRunStatus | null>(null);
  const [open, setOpen] = useState(false);
  // Completion flips the backend to needed=false; without this the status refresh
  // would unmount the wizard before its terminal "Setup complete" step could be read.
  const [finished, setFinished] = useState(false);
  // Wizard sessions (PR #151 final review LOW-4): every open and every close starts
  // a new one. A completion marks `finished` only for the session it was started in
  // and only while that session is still open: Complete's IPC can resolve after the
  // operator pressed Escape (and even after a reopen), and a `finished` latched
  // then would keep a later, NOT completed wizard on screen after a status refresh
  // reports needed=false. The ref is the live session; `session` is the one this
  // render belongs to (captured by onCompleted below).
  const openRef = useRef(false);
  const sessionRef = useRef(0);
  const [session, setSession] = useState(0);
  const setWizardOpen = useCallback((next: boolean): void => {
    if (openRef.current === next) return; // a push while open keeps the session
    openRef.current = next;
    sessionRef.current += 1;
    setSession(sessionRef.current);
    setOpen(next);
    setFinished(false);
  }, []);

  useEffect(() => {
    if (window.desktopApi === undefined) return;
    let cancelled = false;
    const openIfNeeded = (next: FirstRunStatus | null): void => {
      if (cancelled || next === null) return;
      setStatus(next);
      if (next.needed) setWizardOpen(true);
    };
    void fetchFirstRunStatus().then(openIfNeeded);
    const unsubscribePush = onFirstRunRequired((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.needed) setWizardOpen(true);
    });
    const unsubscribeReopen = onFirstRunReopen(() => {
      void fetchFirstRunStatus().then(openIfNeeded);
    });
    return () => {
      cancelled = true;
      unsubscribePush();
      unsubscribeReopen();
    };
  }, [setWizardOpen]);

  if (!open || status === null || (!status.needed && !finished)) return null;
  return (
    <FirstRunWizard
      status={status}
      onClose={() => setWizardOpen(false)}
      onCompleted={() => {
        if (sessionRef.current === session) setFinished(true);
        void fetchFirstRunStatus().then((next) => {
          if (next !== null) setStatus(next);
        });
      }}
      refreshStatus={() => {
        void fetchFirstRunStatus().then((next) => {
          if (next !== null) setStatus(next);
        });
      }}
    />
  );
}

export function FirstRunWizard({
  status,
  onClose,
  onCompleted,
  refreshStatus,
}: {
  status: FirstRunStatus;
  onClose: () => void;
  /** Called after a successful completion so the owner can refresh state. */
  onCompleted: () => void;
  /** Re-fetch the status snapshot (after pack activation changes it). */
  refreshStatus: () => void;
}) {
  // In-session progress survives Escape/Skip + reopen (PRR-151-013); memory only.
  const [resumed] = useState(getFirstRunSession);
  const [stepIndex, setStepIndex] = useState(() =>
    Math.min(Math.max(resumed?.stepIndex ?? 0, 0), WIZARD_STEPS.length - 2),
  );
  // Null until the operator picks: an untouched profile follows the current snapshot's
  // recommendation (also on resume) instead of freezing a stale default.
  const [pickedProfile, setPickedProfile] = useState<'quality' | 'fast' | null>(
    resumed?.pickedProfile ?? null,
  );
  const selectedProfile = pickedProfile ?? status.profile.recommended;
  const [acknowledged, setAcknowledged] = useState(
    resumed?.acknowledged ?? status.state.acknowledgedLicenses,
  );
  const [activation, setActivation] = useState<{
    ran: boolean;
    ok: boolean;
    results: Array<{ id: string; ok: boolean; detail: string }>;
  } | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  // Single-flight guards (PRR-151-014): refs close the double-click window before React
  // re-renders; state drives the disabled look. mountedRef drops late post-unmount updates.
  const [activating, setActivating] = useState(false);
  const [completing, setCompleting] = useState(false);
  const activatingRef = useRef(false);
  const completingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!completed) saveFirstRunSession({ stepIndex, pickedProfile, acknowledged });
  }, [completed, stepIndex, pickedProfile, acknowledged]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Modal keyboard behavior (PRR-003) comes from ui/Dialog: Escape dismisses exactly
  // like "Skip for now" (never completes), Tab is trapped inside the panel, and focus
  // returns to the opener when the wizard unmounts.

  // Dialog's first enabled control is "Skip for now" (Back is disabled on step 0):
  // Enter at launch would dismiss setup. Open on the primary action instead.
  const nextRef = useRef<HTMLButtonElement>(null);

  const step: Step = completed ? 'complete' : WIZARD_STEPS[stepIndex];
  const manifestBlocking =
    (status.manifest.packaged && !status.manifest.staged) || status.manifest.failures.length > 0;
  const inactivePacks = status.packs.required.filter((entry) =>
    // #133 round 8: the backend computes satisfaction per entry (installed+
    // active at this version OR NEWER — a newer zip installed from the
    // Documents page satisfies the manifest). Strict equality soft-locked the
    // Complete button in exactly that state while activation reported
    // "already installed and active". The legacy check remains only as a
    // fallback for status payloads that predate the `satisfied` field.
    entry.satisfied !== undefined
      ? !entry.satisfied
      : !status.packs.installed.some(
          (record) =>
            record.id === entry.id &&
            record.active &&
            (entry.version === undefined || record.version === entry.version),
        ),
  );
  const inactivePackIds = inactivePacks.map((entry) => entry.id);
  const packsSatisfied = inactivePacks.length === 0;
  const completeEnabled =
    selectedProfile !== null && acknowledged && !manifestBlocking && packsSatisfied;

  // A control that unmounts while focused (Complete -> Finish, the activate button once
  // packs are satisfied) or goes natively disabled (Back on step 0) would drop focus to
  // <body>, outside the dialog's key handler: Escape and the Tab trap would stop working.
  // Re-home focus onto the step's primary action (else the dialog itself).
  useEffect(() => {
    const root = rootRef.current;
    const dialog = root?.closest<HTMLElement>('[role="dialog"]');
    // Focus parked on the dialog panel itself (Dialog re-homes there when the focused
    // control is removed) still needs the primary action, so only a focused child counts.
    const active = document.activeElement;
    if (!root || !dialog || (dialog.contains(active) && active !== dialog)) return;
    root
      .querySelector<HTMLElement>(
        '[data-testid="wizard-finish"], [data-testid="wizard-complete"], [data-testid="wizard-next"]',
      )
      ?.focus();
    if (!dialog.contains(document.activeElement)) dialog.focus();
  }, [stepIndex, completed, packsSatisfied]);

  // #133 (AC4): a disabled Complete must NAME its gates — the same
  // WizardBlockerReason vocabulary assertCanComplete returns over IPC, so the
  // operator is never left toggling the checkbox against a silent button.
  const completeBlockedReasons: string[] = [];
  if (manifestBlocking) {
    completeBlockedReasons.push(
      'verify-manifest: integrity verification failed; resolve the named file failures first',
    );
  }
  if (!packsSatisfied) {
    let reason = `activate-packs: required packs are not active: ${inactivePackIds.join(', ')}`;
    if (!status.packs.toolsAvailable) {
      reason += ` (pack lifecycle unavailable: ${status.packs.unavailableReason ?? 'unknown reason'} — reinstall the app or check the logs)`;
    }
    completeBlockedReasons.push(reason);
  }
  if (selectedProfile === null) {
    completeBlockedReasons.push('select-profile: no profile was selected');
  }
  if (!acknowledged) {
    completeBlockedReasons.push(
      'licensing-notices: the license acknowledgment checkbox is required and cannot be skipped',
    );
  }

  const goNext = (): void => setStepIndex((index) => Math.min(index + 1, WIZARD_STEPS.length - 2));
  const goBack = (): void => setStepIndex((index) => Math.max(index - 1, 0));

  const runActivation = async (): Promise<void> => {
    if (activatingRef.current) return;
    activatingRef.current = true;
    setActivating(true);
    try {
      const outcome = await activateRequiredPacks();
      if (!mountedRef.current) return;
      setActivation({ ran: true, ok: outcome.ok, results: outcome.results });
      // The activation changed the pack set — refresh the snapshot so the
      // Complete gate (packsSatisfied) reflects reality.
      if (outcome.ok) refreshStatus();
    } finally {
      activatingRef.current = false;
      if (mountedRef.current) setActivating(false);
    }
  };

  const runComplete = async (): Promise<void> => {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    setCompleteError(null);
    try {
      const outcome = await completeFirstRun({
        selectedProfile,
        acknowledgedLicenses: acknowledged,
      });
      if (outcome.ok) {
        // Completion is recorded: drop the in-memory progress even if the wizard was
        // skipped while this call was in flight, and always tell the owner.
        clearFirstRunSession();
        if (mountedRef.current) setCompleted(true);
        onCompleted();
      } else if (mountedRef.current) {
        setCompleteError(outcome.detail ?? 'completion refused');
      }
    } finally {
      completingRef.current = false;
      if (mountedRef.current) setCompleting(false);
    }
  };

  // Persistent polite live region (PRR-151-004): a step change swaps the sibling content
  // without moving focus (the stable Next button stays focused), so announce it here.
  const announcement =
    step === 'complete'
      ? STEP_LABELS.complete
      : `Step ${stepIndex + 1} of ${WIZARD_STEPS.length - 1}: ${STEP_LABELS[step]}`;

  const stepState = (index: number): 'done' | 'current' | 'todo' =>
    completed || index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'todo';

  // Native `disabled` (what the e2e suite and tests assert) plus aria-disabled, which is
  // what gives ui/Button its disabled look.
  const off = (disabled: boolean) => (disabled ? { disabled: true, 'aria-disabled': true as const } : {});

  return (
    <Dialog
      open
      onClose={onClose}
      title={status.rerun ? 'Re-run setup' : 'Welcome to TrainingApp'}
      className="first-run-dialog"
      // The desktop e2e suite addresses the whole dialog (title included) as `first-run-wizard`.
      testId="first-run-wizard"
      initialFocus={nextRef}
      // A stray click outside must not skip setup (Escape and "Skip for now" still do).
      closeOnBackdrop={false}
    >
      <div ref={rootRef} className="first-run">
        <p className="first-run__lede">
          {status.rerun && status.reason === 'drift'
            ? 'A packaged file changed since setup last ran — verify your installation.'
            : 'A short, deterministic setup: hardware check, profile choice, file integrity, packs, and licenses.'}
        </p>

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="ui-visually-hidden"
          data-testid="wizard-announcer"
        >
          {announcement}
        </div>

        <ol className="first-run__steps" data-testid="wizard-steps" aria-label="Setup steps">
          {WIZARD_STEPS.map((name, index) => {
            const state = stepState(index);
            return (
              <li
                key={name}
                className={`first-run__step first-run__step--${state}`}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                {STEP_LABELS[name]}
                {state === 'done' ? <span className="ui-visually-hidden"> (done)</span> : null}
              </li>
            );
          })}
        </ol>

        {step === 'detect-hardware' && (
          <section className="first-run__section" data-testid="step-detect-hardware">
            <h3 className="first-run__heading">Hardware</h3>
            <p className="first-run__text">
              Free RAM measured: <strong>{formatGiB(status.hardware.freeBytes)}</strong>
              {status.profile.models.quality !== null && (
                <>
                  {' '}· Quality model: {status.profile.models.quality.path} ({formatGiB(status.profile.models.quality.bytes)})
                </>
              )}
              {status.profile.models.fast !== null && (
                <>
                  {' '}· Fast model: {status.profile.models.fast.path} ({formatGiB(status.profile.models.fast.bytes)})
                </>
              )}
            </p>
          </section>
        )}

        {step === 'select-profile' && (
          <section className="first-run__section" data-testid="step-select-profile">
            <h3 className="first-run__heading">Choose an inference profile</h3>
            {status.profile.warning !== null && (
              <div data-testid="profile-warning">
                <Banner tone="warning">{status.profile.warning.detail}</Banner>
              </div>
            )}
            <RadioCardGroup
              legend="Inference profile"
              hideLegend
              value={selectedProfile}
              onChange={(value) => setPickedProfile(value === 'fast' ? 'fast' : 'quality')}
              options={[
                {
                  value: 'quality',
                  label: `Quality ${status.profile.warning !== null ? '(override — may not fit in free RAM)' : '(recommended)'}`,
                  testId: 'profile-quality',
                },
                { value: 'fast', label: 'Fast', testId: 'profile-fast' },
              ]}
            />
            <p className="first-run__hint">
              Context size {status.profile.contextSize}. Estimates use the measured model size + KV cache + load overhead.
            </p>
          </section>
        )}

        {step === 'verify-manifest' && (
          <section className="first-run__section" data-testid="step-verify-manifest">
            <h3 className="first-run__heading">File integrity</h3>
            {!status.manifest.staged && !status.manifest.packaged && (
              <p className="first-run__text">
                No integrity manifest is staged in this development tree — verification is not applicable here.
              </p>
            )}
            {!status.manifest.staged && status.manifest.packaged && (
              <Banner tone="danger">
                This packaged installation is missing its integrity manifest (resources/manifest.json). Reinstall the app.
              </Banner>
            )}
            {status.manifest.staged && status.manifest.failures.length === 0 && (
              <p className="first-run__text">
                All {status.manifest.verifiedCount} required file(s) verified against sha256.
              </p>
            )}
            {status.manifest.failures.length > 0 && (
              <>
                <Banner tone="danger">
                  Integrity verification failed for {status.manifest.failures.length} file(s):
                </Banner>
                <div className="first-run__table-wrap">
                  <table className="first-run__table" data-testid="manifest-failures">
                    <thead>
                      <tr>
                        <th scope="col">File</th>
                        <th scope="col">Reason</th>
                        <th scope="col">Expected</th>
                        <th scope="col">Actual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.manifest.failures.map((failure) => (
                        <tr key={`${failure.path}:${failure.reason}`}>
                          <td>{failure.path}</td>
                          <td>{failure.reason}</td>
                          <td>{failure.expected}</td>
                          <td>{failure.actual}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}

        {step === 'activate-packs' && (
          <section className="first-run__section" data-testid="step-activate-packs">
            <h3 className="first-run__heading">Knowledge packs</h3>
            {!status.packs.toolsAvailable && (
              <Banner tone="danger">
                Pack lifecycle is unavailable in this session ({status.packs.unavailableReason ?? 'unknown reason'}) —
                completion requires the knowledge packs. Reinstall the application or check the logs if this persists.
              </Banner>
            )}
            {status.packs.toolsAvailable && status.packs.required.length === 0 && (
              <p className="first-run__text">No packs are required by the manifest.</p>
            )}
            {status.packs.toolsAvailable && status.packs.required.length > 0 && (
              <>
                <ul className="first-run__list">
                  {status.packs.required.map((entry) => {
                    const installedRow = status.packs.installed.find((r) => r.id === entry.id && r.active);
                    // Round-8 semantics: the backend's satisfied verdict accepts a
                    // NEWER installed pack (>=). When the versions differ but the
                    // entry is satisfied, say so — otherwise the manifest-pinned
                    // version reads as if the user's newer pack was rejected.
                    const satisfies =
                      entry.satisfied !== undefined
                        ? entry.satisfied
                        : installedRow !== undefined &&
                          (entry.version === undefined || installedRow.version === entry.version);
                    return (
                      <li key={entry.id}>
                        {entry.id}
                        {entry.version !== undefined ? `@${entry.version}` : ''} —{' '}
                        {installedRow !== undefined ? 'active' : 'not active'}
                        {satisfies &&
                        installedRow !== undefined &&
                        entry.version !== undefined &&
                        installedRow.version !== entry.version
                          ? ` (your installed ${installedRow.version} satisfies the manifest)`
                          : ''}
                      </li>
                    );
                  })}
                </ul>
                {packsSatisfied ? (
                  <p className="first-run__text">All required packs are active.</p>
                ) : (
                  <div>
                    <Button
                      variant="primary"
                      onClick={() => void runActivation()}
                      {...off(activating)}
                      data-testid="activate-packs-button"
                    >
                      Install and activate required packs
                    </Button>
                  </div>
                )}
                {activation !== null && activation.results.length > 0 && (
                  <ul className="first-run__list">
                    {activation.results.map((result) =>
                      result.ok ? (
                        <li key={result.id}>
                          {result.id}: {result.detail}
                        </li>
                      ) : (
                        <li key={result.id} className="first-run__result--failed">
                          <Icon name="circle-alert" size={14} className="first-run__result-icon" />
                          <span>
                            <span className="ui-visually-hidden">Failed: </span>
                            {result.id}: {result.detail}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </>
            )}
          </section>
        )}

        {step === 'licensing-notices' && (
          <section className="first-run__section" data-testid="step-licensing-notices">
            <h3 className="first-run__heading">Licensing notices</h3>
            {status.licenses.available ? (
              <pre className="first-run__license" tabIndex={0} role="region" aria-label="Licensing notices text">
                {status.licenses.content}
              </pre>
            ) : (
              <p className="first-run__text">
                Model and pack licenses ship with the installer (docs/licenses.md). By continuing you
                acknowledge the license terms of every bundled model and knowledge pack.
              </p>
            )}
            <Checkbox
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              data-testid="license-ack"
              label="I have read and acknowledge the licensing notices"
            />
          </section>
        )}

        {step === 'complete' && (
          <section className="first-run__section" data-testid="step-complete">
            <h3 className="first-run__heading">Setup complete</h3>
            <p className="first-run__text">
              Profile <strong>{selectedProfile}</strong> selected; licensing acknowledged
              {status.manifest.staged ? `; ${status.manifest.verifiedCount} file(s) verified` : ''}.
            </p>
          </section>
        )}

        {completeError !== null && (
          <div data-testid="complete-error">
            <Banner tone="danger">{completeError}</Banner>
          </div>
        )}

        {completeBlockedReasons.length > 0 && (
          <div id="wizard-complete-blocked-reasons" data-testid="complete-blocked-reasons">
            <Banner tone="warning" title="Setup cannot complete yet — resolve the named gates:">
              <ul className="first-run__gates">
                {completeBlockedReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Banner>
          </div>
        )}

        <div className="first-run__actions">
          {completed ? (
            <span />
          ) : (
            <Button onClick={goBack} {...off(stepIndex === 0 || completing)}>
              Back
            </Button>
          )}
          <span className="first-run__actions-end">
            {!completed && (
              <Button onClick={onClose} data-testid="first-run-skip">
                Skip for now
              </Button>
            )}
            {!completed && stepIndex < WIZARD_STEPS.length - 2 && (
              <Button ref={nextRef} variant="primary" onClick={goNext} data-testid="wizard-next">
                Next
              </Button>
            )}
            {!completed && stepIndex === WIZARD_STEPS.length - 2 && (
              <Button
                variant="primary"
                onClick={() => void runComplete()}
                {...off(!completeEnabled || completing)}
                data-testid="wizard-complete"
                aria-describedby={completeEnabled ? undefined : 'wizard-complete-blocked-reasons'}
              >
                Complete setup
              </Button>
            )}
            {completed && (
              <Button variant="primary" onClick={onClose} data-testid="wizard-finish">
                Finish
              </Button>
            )}
          </span>
        </div>
        {!completed && (
          <p className="first-run__hint">
            Skipping only closes the wizard — nothing is completed, and setup will open again on the next launch.
          </p>
        )}
      </div>
    </Dialog>
  );
}
