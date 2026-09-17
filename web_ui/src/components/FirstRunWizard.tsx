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
 */
import { useEffect, useRef, useState } from 'react';
import {
  activateRequiredPacks,
  completeFirstRun,
  fetchFirstRunStatus,
  onFirstRunReopen,
  onFirstRunRequired,
  type FirstRunStatus,
} from '../lib/first-run';

const WIZARD_STEPS = [
  'detect-hardware',
  'select-profile',
  'verify-manifest',
  'activate-packs',
  'licensing-notices',
  'complete',
] as const;

type Step = (typeof WIZARD_STEPS)[number];

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(0, 0, 0, 0.55)',
};

const panelStyle: React.CSSProperties = {
  width: 'min(720px, 92vw)',
  maxHeight: '86vh',
  overflowY: 'auto',
  backgroundColor: 'var(--color-bg-surface, #1e1e1e)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border, #444)',
  borderRadius: 'var(--radius-md, 8px)',
  padding: 'var(--spacing-xl, 24px)',
  fontFamily: 'var(--font-family)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-lg, 16px)',
};

const stepRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--spacing-sm, 8px)',
  flexWrap: 'wrap',
};

const stepChip = (state: 'done' | 'current' | 'todo'): React.CSSProperties => ({
  padding: '2px 10px',
  borderRadius: 999,
  fontSize: 'var(--font-size-caption, 12px)',
  border: '1px solid',
  borderColor:
    state === 'current'
      ? 'var(--color-primary, #4a9eff)'
      : state === 'done'
        ? 'var(--color-success, #4caf50)'
        : 'var(--color-border, #444)',
  color:
    state === 'current'
      ? 'var(--color-primary, #4a9eff)'
      : state === 'done'
        ? 'var(--color-success, #4caf50)'
        : 'var(--color-text-muted, #999)',
});

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 'var(--spacing-md, 12px)',
  marginTop: 'var(--spacing-md, 12px)',
};

const failureTableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse' as const,
  fontSize: 'var(--font-size-caption, 12px)',
};

const cellStyle: React.CSSProperties = {
  border: '1px solid var(--color-border, #444)',
  padding: '4px 8px',
  textAlign: 'left' as const,
  wordBreak: 'break-all' as const,
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

  useEffect(() => {
    if (window.desktopApi === undefined) return;
    let cancelled = false;
    const openIfNeeded = (next: FirstRunStatus | null): void => {
      if (cancelled || next === null) return;
      setStatus(next);
      if (next.needed) setOpen(true);
    };
    void fetchFirstRunStatus().then(openIfNeeded);
    const unsubscribePush = onFirstRunRequired((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.needed) setOpen(true);
    });
    const unsubscribeReopen = onFirstRunReopen(() => {
      void fetchFirstRunStatus().then(openIfNeeded);
    });
    return () => {
      cancelled = true;
      unsubscribePush();
      unsubscribeReopen();
    };
  }, []);

  if (!open || status === null || !status.needed) return null;
  return (
    <FirstRunWizard
      status={status}
      onClose={() => setOpen(false)}
      onCompleted={() => {
        void fetchFirstRunStatus().then((next) => setStatus(next));
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
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedProfile, setSelectedProfile] = useState<'quality' | 'fast'>(
    status.profile.recommended,
  );
  const [acknowledged, setAcknowledged] = useState(status.state.acknowledgedLicenses);
  const [activation, setActivation] = useState<{
    ran: boolean;
    ok: boolean;
    results: Array<{ id: string; ok: boolean; detail: string }>;
  } | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Modal keyboard behavior (PRR-003): Escape dismisses exactly like
  // "Skip for now" (never completes), and Tab is trapped inside the panel.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (active === null || !panel.contains(active) || (event.shiftKey && active === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const step: Step = completed ? 'complete' : WIZARD_STEPS[stepIndex];
  const manifestBlocking =
    (status.manifest.packaged && !status.manifest.staged) || status.manifest.failures.length > 0;
  const inactivePacks = status.packs.required.filter(
    (entry) =>
      !status.packs.installed.some(
        (record) =>
          record.id === entry.id &&
          record.active &&
          (entry.version === undefined || record.version === entry.version),
      ),
  );
  const packsSatisfied = inactivePacks.length === 0;
  const completeEnabled =
    selectedProfile !== null && acknowledged && !manifestBlocking && packsSatisfied;

  const goNext = (): void => setStepIndex((index) => Math.min(index + 1, WIZARD_STEPS.length - 2));
  const goBack = (): void => setStepIndex((index) => Math.max(index - 1, 0));

  const runActivation = async (): Promise<void> => {
    const outcome = await activateRequiredPacks();
    setActivation({ ran: true, ok: outcome.ok, results: outcome.results });
    // The activation changed the pack set — refresh the snapshot so the
    // Complete gate (packsSatisfied) reflects reality.
    if (outcome.ok) refreshStatus();
  };

  const runComplete = async (): Promise<void> => {
    setCompleteError(null);
    const outcome = await completeFirstRun({
      selectedProfile,
      acknowledgedLicenses: acknowledged,
    });
    if (outcome.ok) {
      setCompleted(true);
      onCompleted();
    } else {
      setCompleteError(outcome.detail ?? 'completion refused');
    }
  };

  return (
    <div style={overlayStyle} data-testid="first-run-wizard" role="dialog" aria-modal="true" aria-label="First-run setup">
      <div ref={panelRef} style={panelStyle} tabIndex={-1}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--font-size-title, 20px)' }}>
            {status.rerun ? 'Re-run setup' : 'Welcome to TrainingApp'}
          </h2>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted, #999)', fontSize: 'var(--font-size-caption, 12px)' }}>
            {status.rerun && status.reason === 'drift'
              ? 'A packaged file changed since setup last ran — verify your installation.'
              : 'A short, deterministic setup: hardware check, profile choice, file integrity, packs, and licenses.'}
          </p>
        </div>

        <div style={stepRowStyle} data-testid="wizard-steps">
          {WIZARD_STEPS.map((name, index) => (
            <span key={name} style={stepChip(completed || index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'todo')}>
              {name}
            </span>
          ))}
        </div>

        {step === 'detect-hardware' && (
          <section data-testid="step-detect-hardware">
            <h3 style={{ margin: '0 0 8px' }}>Hardware</h3>
            <p style={{ margin: 0 }}>
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
          <section data-testid="step-select-profile">
            <h3 style={{ margin: '0 0 8px' }}>Choose an inference profile</h3>
            {status.profile.warning !== null && (
              <p role="alert" data-testid="profile-warning" style={{ margin: '0 0 8px', color: 'var(--color-warning-strong, #eab308)' }}>
                {status.profile.warning.detail}
              </p>
            )}
            <label style={{ display: 'block', margin: '4px 0' }}>
              <input
                type="radio"
                name="first-run-profile"
                checked={selectedProfile === 'quality'}
                onChange={() => setSelectedProfile('quality')}
                data-testid="profile-quality"
              />{' '}
              Quality {status.profile.warning !== null ? '(override — may not fit in free RAM)' : '(recommended)'}
            </label>
            <label style={{ display: 'block', margin: '4px 0' }}>
              <input
                type="radio"
                name="first-run-profile"
                checked={selectedProfile === 'fast'}
                onChange={() => setSelectedProfile('fast')}
                data-testid="profile-fast"
              />{' '}
              Fast
            </label>
            <p style={{ margin: '8px 0 0', color: 'var(--color-text-muted, #999)', fontSize: 'var(--font-size-caption, 12px)' }}>
              Context size {status.profile.contextSize}. Estimates use the measured model size + KV cache + load overhead.
            </p>
          </section>
        )}

        {step === 'verify-manifest' && (
          <section data-testid="step-verify-manifest">
            <h3 style={{ margin: '0 0 8px' }}>File integrity</h3>
            {!status.manifest.staged && !status.manifest.packaged && (
              <p style={{ margin: 0 }}>
                No integrity manifest is staged in this development tree — verification is not applicable here.
              </p>
            )}
            {!status.manifest.staged && status.manifest.packaged && (
              <p role="alert" style={{ margin: 0, color: 'var(--color-danger, #d32f2f)' }}>
                This packaged installation is missing its integrity manifest (resources/manifest.json). Reinstall the app.
              </p>
            )}
            {status.manifest.staged && status.manifest.failures.length === 0 && (
              <p style={{ margin: 0 }}>
                All {status.manifest.verifiedCount} required file(s) verified against sha256.
              </p>
            )}
            {status.manifest.failures.length > 0 && (
              <>
                <p role="alert" style={{ margin: '0 0 8px', color: 'var(--color-danger, #d32f2f)' }}>
                  Integrity verification failed for {status.manifest.failures.length} file(s):
                </p>
                <table style={failureTableStyle} data-testid="manifest-failures">
                  <thead>
                    <tr>
                      <th style={cellStyle}>File</th>
                      <th style={cellStyle}>Reason</th>
                      <th style={cellStyle}>Expected</th>
                      <th style={cellStyle}>Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.manifest.failures.map((failure) => (
                      <tr key={`${failure.path}:${failure.reason}`}>
                        <td style={cellStyle}>{failure.path}</td>
                        <td style={cellStyle}>{failure.reason}</td>
                        <td style={cellStyle}>{failure.expected}</td>
                        <td style={cellStyle}>{failure.actual}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}

        {step === 'activate-packs' && (
          <section data-testid="step-activate-packs">
            <h3 style={{ margin: '0 0 8px' }}>Knowledge packs</h3>
            {!status.packs.toolsAvailable && (
              <p style={{ margin: 0 }}>Pack lifecycle is unavailable in this session.</p>
            )}
            {status.packs.toolsAvailable && status.packs.required.length === 0 && (
              <p style={{ margin: 0 }}>No packs are required by the manifest.</p>
            )}
            {status.packs.toolsAvailable && status.packs.required.length > 0 && (
              <>
                <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
                  {status.packs.required.map((entry) => (
                    <li key={entry.id}>
                      {entry.id}
                      {entry.version !== undefined ? `@${entry.version}` : ''} —{' '}
                      {status.packs.installed.some((r) => r.id === entry.id && r.active) ? 'active' : 'not active'}
                    </li>
                  ))}
                </ul>
                {packsSatisfied ? (
                  <p style={{ margin: 0 }}>All required packs are active.</p>
                ) : (
                  <button type="button" onClick={() => void runActivation()} data-testid="activate-packs-button">
                    Install and activate required packs
                  </button>
                )}
                {activation !== null && activation.results.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 'var(--font-size-caption, 12px)' }}>
                    {activation.results.map((result) => (
                      <li key={result.id} style={{ color: result.ok ? 'inherit' : 'var(--color-danger, #d32f2f)' }}>
                        {result.id}: {result.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}

        {step === 'licensing-notices' && (
          <section data-testid="step-licensing-notices">
            <h3 style={{ margin: '0 0 8px' }}>Licensing notices</h3>
            {status.licenses.available ? (
              <pre
                style={{
                  maxHeight: 180,
                  overflowY: 'auto',
                  border: '1px solid var(--color-border, #444)',
                  padding: 8,
                  whiteSpace: 'pre-wrap',
                  fontSize: 'var(--font-size-caption, 12px)',
                }}
              >
                {status.licenses.content}
              </pre>
            ) : (
              <p style={{ margin: '0 0 8px' }}>
                Model and pack licenses ship with the installer (docs/licenses.md). By continuing you
                acknowledge the license terms of every bundled model and knowledge pack.
              </p>
            )}
            <label style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                data-testid="license-ack"
              />{' '}
              I have read and acknowledge the licensing notices
            </label>
          </section>
        )}

        {step === 'complete' && (
          <section data-testid="step-complete">
            <h3 style={{ margin: '0 0 8px' }}>Setup complete</h3>
            <p style={{ margin: 0 }}>
              Profile <strong>{selectedProfile}</strong> selected; licensing acknowledged
              {status.manifest.staged ? `; ${status.manifest.verifiedCount} file(s) verified` : ''}.
            </p>
          </section>
        )}

        {completeError !== null && (
          <p role="alert" style={{ margin: 0, color: 'var(--color-danger, #d32f2f)' }} data-testid="complete-error">
            {completeError}
          </p>
        )}

        <div style={buttonRowStyle}>
          {completed ? (
            <span />
          ) : (
            <button type="button" onClick={goBack} disabled={stepIndex === 0}>
              Back
            </button>
          )}
          <span style={{ display: 'flex', gap: 8 }}>
            {!completed && (
              <button type="button" onClick={onClose} data-testid="first-run-skip">
                Skip for now
              </button>
            )}
            {!completed && stepIndex < WIZARD_STEPS.length - 2 && (
              <button type="button" onClick={goNext} data-testid="wizard-next">
                Next
              </button>
            )}
            {!completed && stepIndex === WIZARD_STEPS.length - 2 && (
              <button
                type="button"
                onClick={() => void runComplete()}
                disabled={!completeEnabled}
                data-testid="wizard-complete"
              >
                Complete setup
              </button>
            )}
            {completed && (
              <button type="button" onClick={onClose} data-testid="wizard-finish">
                Finish
              </button>
            )}
          </span>
        </div>
        {!completed && (
          <p style={{ margin: 0, color: 'var(--color-text-muted, #999)', fontSize: 'var(--font-size-caption, 12px)' }}>
            Skipping only closes the wizard — nothing is completed, and setup will open again on the next launch.
          </p>
        )}
      </div>
    </div>
  );
}
