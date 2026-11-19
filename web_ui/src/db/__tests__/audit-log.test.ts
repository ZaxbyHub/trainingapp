// FROZEN CHECK C3 (issue #366 AC1) - token: audit-log.
// The local audit log: append shape (event, ts, subject - never conversation
// content), REAL-producer legs driving the actual commit points (browser pack
// install/remove, external-settings persistence seam with per-key commit
// outcomes, updates.optIn persisted marker on both runtimes), exact per-key
// subject rows, and the audit-write-failure isolation contract.
//
// Harness: the repo's fake-indexeddb recipe (file-scoped fake-indexeddb/auto
// + per-test UNIQUE profile prefix + vi.resetModules + dynamic import AFTER
// the prefix is pinned - the audit singleton captures its DB name at import).
import 'fake-indexeddb/auto';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';

let prefixCounter = 0;

/** EXACTLY 8 lowercase-alnum chars (the profile prefix shape regex). */
function nextPrefix(): string {
  prefixCounter += 1;
  return 'aa' + String(prefixCounter).padStart(6, '0');
}

type AuditModule = typeof import('../audit');
type ProviderModule = typeof import('../../lib/llm/external-provider');

/** The audit db name comes from the SAME source the singleton used. */
async function auditDbName(prefix: string): Promise<string> {
  localStorage.setItem(PROFILE_KEY, prefix);
  const profile = await import('../../lib/storage/profile');
  return profile.getStorageDbNames().audit;
}

let currentPrefix = '';

async function freshAudit(prefix: string): Promise<AuditModule> {
  currentPrefix = prefix;
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
  vi.resetModules();
  return import('../audit');
}

/** RAW read of every row in the audit events store, bypassing Dexie. */
function rawAuditRows(dbName: string): Promise<Array<Record<string, unknown>>> {
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

const CONV_CANARY = 'CONV-CANARY-zk41Xq patient says take 500mg daily';
const URL_CANARY = 'http://127.0.0.1:9876/v1-canary-endpoint';
const KEY_CANARY = 'sk-canary-do-not-log-77a1f9';

describe('audit-log: writer shape (issue #366 AC1)', () => {
  test('append stores (event, ts, subject) exactly; subject is a stable id (audit-log)', async () => {
    const audit = await freshAudit(nextPrefix());
    const before = Date.now();
    await audit.appendAuditEvent('app_start', null);
    await audit.appendAuditEvent('settings_change', 'external.baseUrl');
    const rows = await rawAuditRows(await auditDbName(currentPrefix));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(typeof row.ts).toBe('number');
      expect((row.ts as number) >= before).toBe(true);
      expect(['app_start', 'settings_change']).toContain(row.event);
      expect(typeof row.subject === 'string' || row.subject === null).toBe(true);
    }
    const subjects = rows.map((r) => String(r.subject)).sort();
    expect(subjects).toEqual(['external.baseUrl', 'null']);
  });

  test('raw table contains NO conversation-content canary ever (audit-log)', async () => {
    const audit = await freshAudit(nextPrefix());
    await audit.appendAuditEvent('app_start', null);
    await audit.appendAuditEvent('clear_cache', null);
    const raw = JSON.stringify(
      await rawAuditRows(await auditDbName(currentPrefix)),
    );
    expect(raw).not.toContain(CONV_CANARY);
    expect(raw).not.toContain('500mg');
  });
});

describe('audit-log: real producer legs (issue #366 AC1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('saveExternalConfig emits one row per INCLUDED changed key; storage failure -> no row (audit-log)', async () => {
    const prefix = nextPrefix();
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    vi.resetModules();
    const provider = (await import('../../lib/llm/external-provider')) as unknown as ProviderModule;
    const audit = (await import('../audit')) as AuditModule;

    provider.saveExternalConfig({
      enabled: true,
      protocol: 'anthropic',
      baseUrl: URL_CANARY,
      model: 'claude-local',
      grounded: false,
    });
    let rows = await rawAuditRows(await auditDbName(prefix));
    const subjects = rows.filter((r) => r.event === 'settings_change').map((r) => r.subject).sort();
    expect(subjects).toEqual([
      'external.baseUrl',
      'external.enabled',
      'external.grounded',
      'external.model',
      'external.protocol',
    ]);
    // NO-LEAK: URL/API-key VALUES never land; only the key names.
    expect(JSON.stringify(rows)).not.toContain(URL_CANARY);
    expect(JSON.stringify(rows)).not.toContain(KEY_CANARY);

    // Unchanged re-save produces NO rows (effective-value discipline).
    provider.saveExternalConfig({ baseUrl: URL_CANARY });
    rows = await rawAuditRows(await auditDbName(prefix));
    expect(rows.filter((r) => r.event === 'settings_change').length).toBe(5);

    // Failed config write via a REAL failing-storage global (vi.stubGlobal
    // replaces globalThis.localStorage, so the provider's setItem throws
    // deterministically; getItem/removeItem delegate to the real storage so
    // the before-snapshot still reads).
    const real = localStorage;
    const failing = new Map<string, string>(Object.entries({ ...real }));
    vi.stubGlobal(
      'localStorage',
      {
        getItem: (k: string) => failing.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (k === 'external-provider-config') throw new Error('quota');
          failing.set(k, v);
        },
        removeItem: (k: string) => {
          failing.delete(k);
        },
        clear: () => failing.clear(),
        key: (i: number) => Array.from(failing.keys())[i] ?? null,
        get length() {
          return failing.size;
        },
      } as Storage,
    );
    try {
      const failedOutcome = provider.saveExternalConfig({ model: 'changed-model' });
      expect(failedOutcome.configPersisted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
      localStorage.setItem(PROFILE_KEY, prefix);
    }
    rows = await rawAuditRows(await auditDbName(prefix));
    expect(rows.filter((r) => r.event === 'settings_change').length).toBe(5);
  });

  test('updates.optIn: persisted marker on both runtimes; failed check still one row (audit-log)', async () => {
    const prefix = nextPrefix();
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    vi.resetModules();
    const controllerMod = (await import('../../lib/packs/pack-update-controller')) as unknown as {
      BrowserUpdatesController: new (deps: Record<string, unknown>) => {
        setUpdateOptIn(enabled: boolean): Promise<{ ok: boolean; persisted?: true }>;
      };
      recordUpdateOptInAudit: (result: { ok: boolean; persisted?: true } | undefined) => void;
    };
    const audit = (await import('../audit')) as AuditModule;

    // Browser runtime: opt-in whose follow-up check FAILS still persists.
    const failingController = new controllerMod.BrowserUpdatesController({
      manager: () => ({ listPacks: async () => [], installPack: async () => ({ packId: '', version: '' }) }),
      fetchFeed: async () => {
        throw new Error('feed unreachable');
      },
      downloadArtifact: async () => new Uint8Array(),
      trustedKeys: () => [],
      storage: () => localStorage,
      airgap: false,
      now: () => new Date(),
    });
    const result = await failingController.setUpdateOptIn(true);
    expect(result.ok).toBe(false); // check failed...
    expect(result.persisted).toBe(true); // ...but persistence committed.
    controllerMod.recordUpdateOptInAudit(result);
    let rows = await rawAuditRows(await auditDbName(prefix));
    const optInRows = rows.filter((r) => r.event === 'settings_change' && r.subject === 'updates.optIn');
    expect(optInRows.length).toBe(1);

    // Nullable storage (no-op write) -> NO persisted marker, NO row.
    const noStorageController = new controllerMod.BrowserUpdatesController({
      manager: () => ({ listPacks: async () => [], installPack: async () => ({ packId: '', version: '' }) }),
      fetchFeed: async () => '[]',
      downloadArtifact: async () => new Uint8Array(),
      trustedKeys: () => [],
      storage: () => null,
      airgap: false,
      now: () => new Date(),
    });
    const noStorageResult = await noStorageController.setUpdateOptIn(true);
    expect(noStorageResult.persisted).toBeUndefined();
    controllerMod.recordUpdateOptInAudit(noStorageResult);
    rows = await rawAuditRows(await auditDbName(prefix));
    expect(rows.filter((r) => r.subject === 'updates.optIn').length).toBe(1);
  });

  test('audit-write failure is swallowed; the audited operation proceeds (audit-log)', async () => {
    const prefix = nextPrefix();
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    vi.resetModules();
    const audit = (await import('../audit')) as AuditModule;
    vi.spyOn(audit.auditDb, 'transaction').mockRejectedValue(new Error('idb down'));
    await expect(audit.recordAuditEvent('clear_cache', null)).resolves.toBeUndefined();
    // The recording promise never rejects and the caller flow survives.
    vi.mocked(audit.auditDb.transaction).mockRestore?.();
    await expect(audit.appendAuditEvent('app_start', null)).resolves.toBeUndefined();
  });
});
