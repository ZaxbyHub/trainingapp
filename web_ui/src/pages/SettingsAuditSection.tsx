/**
 * Local audit log surface (issue #366, WI5): a bounded, read-only
 * chronological viewer for the local governance audit table + an explicit
 * two-click Clear. NO export control exists - non-exportable is the PROPOSED
 * default policy (retention window, roster, and non-exportability gate on
 * maintainer review; see CONFIGURATION.md "Local audit log (PROPOSED
 * policy)"). Rows carry event class, timestamp, and a stable subject id -
 * never conversation content.
 *
 * Clear follows the clear-cache precedent (SettingsPage two-click confirm):
 * the arming click produces NO event; the confirmed click awaits the purge
 * and then appends exactly one `audit_log_cleared` marker row (inside
 * clearAuditLog). If either operation fails, no success is announced and the
 * viewer refreshes from storage.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import { listAuditEvents, clearAuditLog, AUDIT_VIEWER_ROW_LIMIT, type AuditRow } from '../db/audit';

/** Re-arm timeout for the two-click confirm (matches the clear-cache 3 s). */
export const AUDIT_CLEAR_REARM_MS = 3000;

function formatRowTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function SettingsAuditSection(): React.ReactElement {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [state, setState] = useState<'idle' | 'confirming'>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (rearmTimerRef.current !== null) clearTimeout(rearmTimerRef.current);
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await listAuditEvents(AUDIT_VIEWER_ROW_LIMIT);
      if (mountedRef.current) setRows(next);
    } catch (err) {
      if (mountedRef.current) {
        setFailed(true);
        console.error('[audit] viewer refresh failed', err);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleClearClick = useCallback((): void => {
    if (state === 'idle') {
      // Arming click: produces NO event (plan B4).
      setState('confirming');
      setFailed(false);
      setStatus(null);
      if (rearmTimerRef.current !== null) clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = setTimeout(() => {
        rearmTimerRef.current = null;
        if (mountedRef.current) setState('idle');
      }, AUDIT_CLEAR_REARM_MS);
      return;
    }
    if (rearmTimerRef.current !== null) {
      clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = null;
    }
    setState('idle');
    void (async () => {
      try {
        // Purge + the single audit_log_cleared marker append happen in one
        // transaction inside clearAuditLog (marker AFTER the purge resolves).
        await clearAuditLog();
        if (!mountedRef.current) return;
        setFailed(false);
        setStatus('Audit log cleared.');
      } catch (err) {
        if (!mountedRef.current) return;
        // No success announcement on failure; refresh from storage truth.
        setFailed(true);
        setStatus(null);
        console.error('[audit] clear failed', err);
      }
      await refresh();
    })();
  }, [state, refresh]);

  return (
    <div className="settings-group" data-testid="audit-log-section">
      <p className="settings-label">Local audit log</p>
      <p className="settings-text">
        A bounded, local-only record of governance events (app start/stop, pack installs and
        removals, setting changes, cache clears). It is never exported and stores only event names
        and stable ids - never your documents or conversations.
      </p>
      {rows.length === 0 && !failed ? (
        <p className="settings-text" data-testid="audit-empty">
          No audit events recorded yet.
        </p>
      ) : (
        <table className="settings-audit__table" data-testid="audit-table">
          <caption className="settings-text">
            Showing the {rows.length} most recent events (newest last)
            {failed ? ' - some rows could not be read' : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Subject</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.seq ?? 'r'}-${row.ts}-${row.event}-${row.subject ?? ''}`} data-testid="audit-row">
                <td>{formatRowTime(row.ts)}</td>
                <td>{row.event}</td>
                <td>{row.subject ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="settings-row">
        <Button
          variant="danger"
          size="sm"
          onClick={handleClearClick}
          aria-label={state === 'confirming' ? 'Confirm clearing the audit log' : 'Clear audit log'}
        >
          {state === 'confirming' ? 'Confirm clear' : 'Clear audit log'}
        </Button>
      </div>
      {/* Always-mounted live region (the clear-cache precedent): status text
          changes are announced without remounting the role. */}
      <p role="status" aria-live="polite" className="settings-text" data-testid="audit-status">
        {failed ? 'Could not read or clear the audit log. Try again.' : (status ?? '')}
      </p>
    </div>
  );
}
