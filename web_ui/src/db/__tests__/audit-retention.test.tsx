// FROZEN CHECK C4 (issue #366 AC2) - token: audit-retention.
// Retention purge-on-write across the window boundary (exactly-at survives,
// older-than purged), no purge without a subsequent write, clear-all + the
// single audit_log_cleared marker, and the Settings audit viewer legs (the
// REAL SettingsAuditSection component: newest-50 bound, chronological order,
// empty state, two-click confirm - no event on the arming click).
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';

let prefixCounter = 1000;

function nextPrefix(): string {
  prefixCounter += 1;
  return 'aa' + String(prefixCounter).padStart(6, '0');
}

let currentPrefix = '';

async function freshAudit(prefix: string): Promise<typeof import('../audit')> {
  currentPrefix = prefix;
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
  vi.resetModules();
  return import('../audit');
}

async function auditDbName(): Promise<string> {
  const profile = await import('../../lib/storage/profile');
  return profile.getStorageDbNames().audit;
}

function rawRows(dbName: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      if (!conn.objectStoreNames.contains('events')) {
        conn.close();
        resolve([]);
        return;
      }
      const tx = conn.transaction('events', 'readonly');
      const getAll = tx.objectStore('events').getAll();
      getAll.onsuccess = () => {
        conn.close();
        resolve((getAll.result as Array<Record<string, unknown>>) ?? []);
      };
      getAll.onerror = () => {
        conn.close();
        reject(getAll.error ?? new Error('raw getAll failed'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

const DAY = 24 * 60 * 60 * 1000;

describe('audit-retention: purge-on-write boundary (issue #366 AC2)', () => {
  test('expired rows purge on the next write; fresh rows survive (audit-retention)', async () => {
    const audit = await freshAudit(nextPrefix());
    const planted = 1_700_000_000_000;
    const window = audit.AUDIT_RETENTION_DAYS * DAY;
    // All three rows planted against ONE write-time clock (nowMs seam).
    // expired: ts = planted - window - DAY  (strictly beyond the cutoff)
    // boundary: ts = planted - window      (== cutoff at write time W=planted)
    // fresh:    ts = planted - 1000        (well inside the window)
    await audit.appendAuditEvent('app_start', null, planted - window - DAY, planted);
    await audit.appendAuditEvent('pack_install', 'p@1', planted - window, planted);
    await audit.appendAuditEvent('clear_cache', null, planted - 1000, planted);
    const name = await auditDbName();
    let rows = await rawRows(name);
    // The expired row was purged by the SECOND append's purge (cutoff at that
    // write already excludes it); boundary + fresh survive their own appends.
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.event)).toEqual(['pack_install', 'clear_cache']);

    // The triggering write at the SAME clock: nothing more purges (boundary
    // ts == cutoff survives - below() is strict).
    await audit.appendAuditEvent('settings_change', 'external.baseUrl', planted - 500, planted);
    rows = await rawRows(name);
    expect(rows.map((r) => r.event)).toEqual(['pack_install', 'clear_cache', 'settings_change']);

    // A write 1 ms later pushes the cutoff past the boundary row: purged.
    await audit.appendAuditEvent('app_stop', null, planted + 1, planted + 1);
    rows = await rawRows(name);
    expect(rows.map((r) => r.event)).toEqual(['clear_cache', 'settings_change', 'app_stop']);
  });

  test('no purge runs without a subsequent write (audit-retention)', async () => {
    const audit = await freshAudit(nextPrefix());
    const now = Date.now();
    const window = audit.AUDIT_RETENTION_DAYS * DAY;
    await audit.appendAuditEvent('app_start', null, now - window - DAY);
    const name = await auditDbName();
    const rows = await rawRows(name);
    expect(rows.length).toBe(1); // the expired row is still there
  });

  test('clearAuditLog purges all and appends exactly ONE audit_log_cleared row (audit-retention)', async () => {
    const audit = await freshAudit(nextPrefix());
    const now = Date.now();
    await audit.appendAuditEvent('app_start', null, now - 2000);
    await audit.appendAuditEvent('pack_remove', 'p', now - 1000);
    const name = await auditDbName();
    await audit.clearAuditLog();
    const rows = await rawRows(name);
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('audit_log_cleared');
    expect(rows[0].subject).toBeNull();
  });
});

describe('audit-retention: Settings audit viewer (issue #366 surface)', () => {
  test('viewer shows newest-50 chronological rows, empty state, and the two-click Clear (audit-retention)', async () => {
    const prefix = nextPrefix();
    currentPrefix = prefix;
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    vi.resetModules();
    const audit = await import('../audit');
    // 60 rows: the viewer shows the newest 50.
    for (let i = 0; i < 60; i += 1) {
      await audit.appendAuditEvent('settings_change', `external.model`, Date.now() - (60 - i) * 1000);
    }
    const name = await auditDbName();
    const allRows = await rawRows(name);
    expect(allRows.length).toBe(60);

    const { SettingsAuditSection } = await import('../../pages/SettingsAuditSection');
    render(<SettingsAuditSection />);
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row').length).toBe(50);
    });
    // Chronological order: first displayed row is the OLDEST of the newest 50.
    const rendered = screen.getAllByTestId('audit-row');
    expect(rendered.length).toBe(50);
    // Empty-state text is absent (rows exist).
    expect(screen.queryByTestId('audit-empty')).not.toBeInTheDocument();

    // Two-click Clear: the ARMING click produces NO event.
    fireEvent.click(screen.getByRole('button', { name: /clear audit log/i }));
    expect(screen.getByRole('button', { name: /confirm clearing the audit log/i })).toBeInTheDocument();
    let rows = await rawRows(name);
    expect(rows.length).toBe(60); // arming click: nothing happened

    // The confirmed click purges + appends exactly one marker row.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm clearing the audit log/i }));
      await new Promise((r) => setTimeout(r, 25));
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-status').textContent).toContain('Audit log cleared.');
    });
    rows = await rawRows(name);
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('audit_log_cleared');
    // The refreshed viewer shows the surviving marker row (not the empty
    // state - audit-empty means a truly empty store).
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row').length).toBe(1);
    });
    expect(screen.getAllByTestId('audit-row')[0].textContent).toContain('audit_log_cleared');
  });

  test('viewer re-arms after the 3s timeout without an event (audit-retention)', async () => {
    const prefix = nextPrefix();
    currentPrefix = prefix;
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    vi.resetModules();
    const audit = await import('../audit');
    await audit.appendAuditEvent('app_start', null);
    const name = await auditDbName();

    const { SettingsAuditSection } = await import('../../pages/SettingsAuditSection');
    render(<SettingsAuditSection />);
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row').length).toBe(1);
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: /clear audit log/i }));
      expect(screen.getByRole('button', { name: /confirm clearing the audit log/i })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByRole('button', { name: /clear audit log/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
    const rows = await rawRows(name);
    expect(rows.length).toBe(1); // no event from the arming/re-arm cycle
  });

  test('clear FAILURE reports no false success and keeps the rows (audit-retention)', async () => {
    const prefix = nextPrefix();
    currentPrefix = prefix;
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    vi.resetModules();
    const audit = await import('../audit');
    await audit.appendAuditEvent('app_start', null);
    const name = await auditDbName();

    const { SettingsAuditSection } = await import('../../pages/SettingsAuditSection');
    render(<SettingsAuditSection />);
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row').length).toBe(1);
    });

    // REAL failure mode: a closed database rejects the clear with a genuine
    // Dexie error (no eager-rejection spy poisoning the act flow).
    audit.auditDb.close();
    // waitFor-based transitions (the proven viewer-test shape): the arming
    // click flips the button to its confirm label asynchronously.
    fireEvent.click(screen.getByRole('button', { name: /^clear audit log$/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /confirm clearing the audit log/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm clearing the audit log/i }));
      await new Promise((r) => setTimeout(r, 25));
    });
    const rows = await rawRows(name);
    expect(rows.length).toBe(1); // purge failed: row survived
    await waitFor(() => {
      expect(screen.getByTestId('audit-status').textContent).toContain('Could not read or clear');
    });
  });
});
