/**
 * Shared db/index stand-in wiring for the fake-dexie integration suites
 * (issue #367 amendment, PC-9 existing-test updates).
 *
 * The REAL `migrationReady` closes over the REAL Dexie singleton: its
 * openDbByName compares the requested name against the real db.name and
 * otherwise constructs the REAL DocQADatabase (Dexie) — in jsdom that open
 * fails with MissingAPIError. Suites that replace the `db` export with the
 * in-memory stand-in therefore re-route ONLY the first-open entry gate
 * through this helper: `migrateUnderLock`, `requireKeyForWrite` and the
 * whole key-state matrix stay the REAL implementations and run over the
 * fake tables (fake-dexie's `transaction` is the documented sequential
 * stand-in).
 */
import { FakeDocQADatabase } from './fake-dexie';
import type { DocQADatabase } from '../db/index';

type DbIndexModule = typeof import('../db/index');

/** Structural stand-in type: only `name` is needed by the gate re-route. */
interface FakeDbLike {
  name: string;
}

export function fakeDbIndexModule(
  actual: DbIndexModule,
  db: FakeDbLike,
): DbIndexModule {
  // Per-name memoized first-open gate, mirroring migrationReady's own
  // memoization (a rejected entry is dropped so a corrected key can retry).
  const readyStates = new Map<string, Promise<void>>();

  function migrationReady(name?: string): Promise<void> {
    const key = name ?? db.name;
    const existing = readyStates.get(key);
    if (existing !== undefined) return existing;
    const target =
      key === db.name
        ? (db as unknown as DocQADatabase)
        : (new FakeDocQADatabase(key) as unknown as DocQADatabase);
    const run = actual.migrateUnderLock(target);
    const tracked = run.then(
      () => undefined,
      (error: unknown) => {
        if (readyStates.get(key) === tracked) readyStates.delete(key);
        throw error;
      },
    );
    readyStates.set(key, tracked);
    return tracked;
  }

  return {
    ...actual,
    DocQADatabase: FakeDocQADatabase as unknown as DbIndexModule['DocQADatabase'],
    db: db as unknown as DbIndexModule['db'],
    migrationReady,
  };
}
