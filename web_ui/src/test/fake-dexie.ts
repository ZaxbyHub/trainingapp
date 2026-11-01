/**
 * fake-dexie — an in-memory stand-in for the Dexie surface db/conv-protocol
 * and db/conversations use (the repo carries no fake-indexeddb dependency;
 * this follows the db/conversations.test.ts mocking convention, extended to
 * the meta table, bulkPut/clear and per-name database instances). Installed
 * by integration suites via `vi.mock('../db/index', ...)`.
 *
 * Not a real IndexedDB: transactions are sequential, not atomic — the epoch
 * RE-READ inside each gated transaction still orders every interleaving the
 * suites assert; true cross-process atomicity is the browser's job.
 */
import { getStorageDbNames } from '../lib/storage/profile';

type Row = Record<string, unknown>;

const clone = <T,>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

/** Lazy Dexie Collection stand-in (filter-then-limit, until-before-read). */
interface FakePlan {
  source: () => Row[];
  offset: number;
  limit: number;
  until?: (row: Row) => boolean;
  filters: Array<(row: Row) => boolean>;
}

function collection(plan: FakePlan) {
  return {
    reverse: () => collection({ ...plan, source: () => [...plan.source()].reverse() }),
    offset: (n: number) => collection({ ...plan, offset: n }),
    limit: (n: number) => collection({ ...plan, limit: n }),
    until: (fn: (row: Row) => boolean) => collection({ ...plan, until: fn }),
    filter: (fn: (row: Row) => boolean) => collection({ ...plan, filters: [...plan.filters, fn] }),
    toArray: async () => {
      const out: Row[] = [];
      let skipped = 0;
      for (const row of plan.source()) {
        if (plan.until && plan.until(row)) break;
        if (!plan.filters.every((f) => f(row))) continue;
        if (skipped < plan.offset) {
          skipped += 1;
          continue;
        }
        out.push(row);
        if (out.length >= plan.limit) break;
      }
      return out.map((row) => clone(row));
    },
  };
}

export class FakeTable {
  rows: Map<string, Row>;
  private readonly keyPath: string;

  constructor(keyPath: string, rows?: Map<string, Row>) {
    this.keyPath = keyPath;
    this.rows = rows ?? new Map();
  }

  async get(key: string): Promise<Row | undefined> {
    const row = this.rows.get(String(key));
    return row === undefined ? undefined : clone(row);
  }

  async put(value: Row): Promise<string> {
    const key = String(value[this.keyPath]);
    this.rows.set(key, clone(value));
    return key;
  }

  async add(value: Row): Promise<string> {
    const key = String(value[this.keyPath]);
    if (this.rows.has(key)) throw new Error(`ConstraintError: key ${key} already exists`);
    this.rows.set(key, clone(value));
    return key;
  }

  async update(key: string, changes: Row): Promise<number> {
    const row = this.rows.get(String(key));
    if (row === undefined) return 0;
    Object.assign(row, clone(changes));
    return 1;
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(String(key));
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async toArray(): Promise<Row[]> {
    return [...this.rows.values()].map((row) => clone(row));
  }

  async bulkPut(values: Row[]): Promise<void> {
    for (const value of values) await this.put(value);
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }

  orderBy(key: string) {
    return collection({
      source: () => [...this.rows.values()].sort((a, b) => Number(a[key]) - Number(b[key])),
      offset: 0,
      limit: Number.POSITIVE_INFINITY,
      filters: [],
    });
  }
}

interface DatabaseState {
  conversations: FakeTable;
  meta: FakeTable;
}

const databases = new Map<string, DatabaseState>();

function stateFor(name: string): DatabaseState {
  let state = databases.get(name);
  if (state === undefined) {
    state = { conversations: new FakeTable('id'), meta: new FakeTable('key') };
    databases.set(name, state);
  }
  return state;
}

/** The DocQADatabase stand-in: one shared state per database NAME. */
export class FakeDocQADatabase {
  private readonly explicitName?: string;

  constructor(name?: string) {
    this.explicitName = name;
  }

  /**
   * The default (no-argument) instance resolves the CURRENT profile's
   * conversations name on every access — the mock singleton is created at
   * import time, before tests pin the profile prefix.
   */
  get name(): string {
    return this.explicitName ?? getStorageDbNames().conversations;
  }

  /** Lazy: always the CURRENT state for this name (resetFakeDexie-safe). */
  get conversations(): FakeTable {
    return stateFor(this.name).conversations;
  }

  get meta(): FakeTable {
    return stateFor(this.name).meta;
  }

  /** Sequential (non-atomic) transaction stand-in; runs the callback. */
  transaction(_mode: string, ...rest: unknown[]): Promise<unknown> {
    const callback = rest[rest.length - 1] as () => unknown;
    return Promise.resolve(callback());
  }

  close(): void {
    /* connections are shared state in the fake */
  }

  async delete(): Promise<void> {
    databases.delete(this.name);
  }
}

/** Drop every fake database (test isolation). */
export function resetFakeDexie(): void {
  databases.clear();
}

/** The live rows of a named conversations table (assertion helper). */
export function conversationsOf(name: string): Row[] {
  const state = databases.get(name);
  return state === undefined ? [] : [...state.conversations.rows.values()];
}

/** The live meta rows of a named table (assertion helper). */
export function metaOf(name: string): Map<string, Row> {
  const state = stateFor(name);
  return state.meta.rows;
}
