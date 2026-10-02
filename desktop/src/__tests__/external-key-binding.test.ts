// PR #142 Stage B RB-001: the API key must never be stored next to an origin
// it was not entered for. The reviewer's probe (a store whose origin set()
// and every delete() fail) left, under the old key-first write order,
// {key: NEW, origin: OLD} in the SecretStore, and the rolled-back engine then
// sent NEW to the OLD host. Pinned here at the ExternalProviderState level:
//   (a) write order — the reviewer's literal fault store never produces the
//       cross-bound pair, checked after EVERY store mutation and through a
//       fresh state over the same store (a restart, where no in-memory flag
//       survives — only the write order protects that case);
//   (b) a fault sequence where commit AND the rollback both throw: the key is
//       not used (null), and a later successful save recovers;
//   (c) fail-closed reads: a store already holding an inconsistent pair whose
//       rollback write fails is not trusted until a key is saved or cleared.
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_KEY_ORIGIN_SECRET,
  EXTERNAL_KEY_SECRET,
  ExternalProviderState,
  type ExternalProviderSettingsState,
} from '../../main/backend/inference/external-provider';
import type { SecretStore } from '../../main/security/secret-store';

const OLD_URL = 'http://127.0.0.1:9/v1';
const NEW_URL = 'http://127.0.0.1:10/v1';
const OLD_ORIGIN = 'http://127.0.0.1:9';
const NEW_ORIGIN = 'http://127.0.0.1:10';
const OLD_KEY = 'Zq7-binding-OLD-KEY-0001';
const NEW_KEY = 'Zq7-binding-NEW-KEY-0002';

interface Faults {
  /** Fail this store call? `op` is 'set' | 'delete', `name` the entry, `n` the 1-based call count of that op. */
  fail: (op: 'set' | 'delete', name: string, n: number) => boolean;
}

/** A Map-backed SecretStore with injectable failures and a mutation log. */
function faultyStore(): {
  store: SecretStore;
  data: Map<string, string>;
  faults: Faults;
  /** Every (key, origin) pair the store held after each successful mutation. */
  history: Array<{ key: string | null; origin: string | null }>;
} {
  const data = new Map<string, string>();
  const faults: Faults = { fail: () => false };
  const history: Array<{ key: string | null; origin: string | null }> = [];
  const counts = { set: 0, delete: 0 };
  const snap = () => history.push({ key: data.get(EXTERNAL_KEY_SECRET) ?? null, origin: data.get(EXTERNAL_KEY_ORIGIN_SECRET) ?? null });
  const store: SecretStore = {
    get: (name) => data.get(name) ?? null,
    set: (name, value) => {
      counts.set += 1;
      if (faults.fail('set', name, counts.set)) throw new Error('secure storage unavailable');
      data.set(name, value);
      snap();
    },
    delete: (name) => {
      counts.delete += 1;
      if (faults.fail('delete', name, counts.delete)) throw new Error('disk gone');
      data.delete(name);
      snap();
    },
  };
  return { store, data, faults, history };
}

function commitOk(state: ExternalProviderState, patch: Record<string, unknown>): void {
  expect(state.validate(patch)).toEqual([]);
  state.commit(patch);
}

/** OLD_KEY saved and bound to OLD_ORIGIN, external model enabled on OLD_URL. */
function baseline(store: SecretStore): ExternalProviderState {
  const state = new ExternalProviderState({ secretStore: store });
  commitOk(state, { 'external.enabled': true, 'external.baseUrl': OLD_URL, 'external.model': 'm1', 'external.apiKey': OLD_KEY });
  expect(state.keyFor(OLD_URL)).toBe(OLD_KEY);
  return state;
}

/** commit, then the rollback the server performs; returns which of them threw. */
function commitThenRollBack(state: ExternalProviderState, patch: Record<string, unknown>): { commitThrew: boolean; restoreThrew: boolean } {
  expect(state.validate(patch)).toEqual([]);
  const before = state.captureState();
  let commitThrew = false;
  let restoreThrew = false;
  try {
    state.commit(patch);
  } catch {
    commitThrew = true;
  }
  try {
    state.restoreState(before);
  } catch {
    restoreThrew = true;
  }
  return { commitThrew, restoreThrew };
}

const CROSS_BOUND = { key: NEW_KEY, origin: OLD_ORIGIN };

describe('RB-001 (a): the key write order never binds the new key to the old origin', () => {
  it("reviewer's fault store (origin set + every delete fail): no step stores {NEW key, OLD origin}, and neither this engine nor a restarted one sends NEW to OLD", () => {
    const { store, data, faults, history } = faultyStore();
    const state = baseline(store);
    history.length = 0;
    faults.fail = (op, name) => op === 'delete' || (op === 'set' && name === EXTERNAL_KEY_ORIGIN_SECRET);

    const outcome = commitThenRollBack(state, { 'external.baseUrl': NEW_URL, 'external.apiKey': NEW_KEY });
    expect(outcome.commitThrew).toBe(true);

    // At no point did the store hold the new key next to the old origin.
    expect(history).not.toContainEqual(CROSS_BOUND);
    expect({ key: data.get(EXTERNAL_KEY_SECRET) ?? null, origin: data.get(EXTERNAL_KEY_ORIGIN_SECRET) ?? null }).not.toEqual(CROSS_BOUND);

    // This engine (rolled back to OLD_URL) never sends NEW to the old host.
    expect(state.keyFor(OLD_URL)).not.toBe(NEW_KEY);
    expect(state.endpoint().baseUrl).toBe(OLD_URL);
    expect(state.endpoint().apiKey).not.toBe(NEW_KEY);

    // A restart over the same store (no in-memory state survives) neither.
    faults.fail = () => false;
    const restarted = new ExternalProviderState({ secretStore: store });
    commitOk(restarted, { 'external.enabled': true, 'external.baseUrl': OLD_URL, 'external.model': 'm1' });
    expect(restarted.keyFor(OLD_URL)).not.toBe(NEW_KEY);
    expect(restarted.endpoint().apiKey).not.toBe(NEW_KEY);
    // With the fixed order nothing was written: the old pair is intact.
    expect(restarted.keyFor(OLD_URL)).toBe(OLD_KEY);
  });

  it('EVERY pattern of failing / succeeding store writes (all 1024 masks over the first 10 mutating calls) leaves no cross-bound pair', () => {
    const MUTATING_CALLS = 10;
    for (let mask = 0; mask < 1 << MUTATING_CALLS; mask += 1) {
      const { store, faults, history } = faultyStore();
      const state = baseline(store);
      history.length = 0;
      // Bit i set: the (i+1)-th mutating call (set or delete) of commit +
      // rollback throws; intermittent patterns included.
      let calls = 0;
      faults.fail = () => {
        const bit = calls;
        calls += 1;
        return bit < MUTATING_CALLS && (mask & (1 << bit)) !== 0;
      };
      commitThenRollBack(state, { 'external.baseUrl': NEW_URL, 'external.apiKey': NEW_KEY });
      expect(calls, `mask=${mask}: more mutating calls than the mask covers`).toBeLessThanOrEqual(MUTATING_CALLS);
      expect(history, `mask=${mask}`).not.toContainEqual(CROSS_BOUND);
      expect(state.keyFor(OLD_URL), `mask=${mask}`).not.toBe(NEW_KEY);
      expect(state.endpoint().apiKey, `mask=${mask}`).not.toBe(NEW_KEY);
      faults.fail = () => false;
      const restarted = new ExternalProviderState({ secretStore: store });
      commitOk(restarted, { 'external.baseUrl': OLD_URL });
      expect(restarted.keyFor(OLD_URL), `mask=${mask} (restart)`).not.toBe(NEW_KEY);
    }
  });
});

describe('RB-001 (b): commit and rollback both throw', () => {
  it('first delete succeeds, then every write fails: keyFor(old) and endpoint().apiKey are null; a later successful save recovers', () => {
    const { store, faults } = faultyStore();
    const state = baseline(store);
    let deletes = 0;
    faults.fail = (op) => {
      if (op === 'delete') {
        deletes += 1;
        return deletes > 1;
      }
      return true;
    };

    const outcome = commitThenRollBack(state, { 'external.baseUrl': NEW_URL, 'external.apiKey': NEW_KEY });
    expect(outcome).toEqual({ commitThrew: true, restoreThrew: true });
    expect(state.endpoint().baseUrl).toBe(OLD_URL);
    expect(state.keyFor(OLD_URL)).toBeNull();
    expect(state.keyFor(NEW_URL)).toBeNull();
    expect(state.endpoint().apiKey).toBeNull();
    expect(state.responseFields()['external.apiKeySet']).toBe(false);

    faults.fail = () => false;
    commitOk(state, { 'external.apiKey': 'Zq7-binding-RE-ENTERED-0003' });
    expect(state.keyFor(OLD_URL)).toBe('Zq7-binding-RE-ENTERED-0003');
  });
});

describe('RB-001 (c): reads fail closed after a rollback write that threw', () => {
  function inconsistent(): { state: ExternalProviderState; data: Map<string, string>; faults: Faults; snapshot: ExternalProviderSettingsState } {
    const { store, data, faults } = faultyStore();
    const state = baseline(store);
    const snapshot = state.captureState(); // wants {OLD_KEY, OLD_ORIGIN}
    // Stand-in for a store left cross-bound by an older build (or a crash).
    data.set(EXTERNAL_KEY_SECRET, NEW_KEY);
    data.set(EXTERNAL_KEY_ORIGIN_SECRET, OLD_ORIGIN);
    expect(state.keyFor(OLD_URL)).toBe(NEW_KEY); // the seeded hazard is live
    return { state, data, faults, snapshot };
  }

  it('a rollback whose key delete throws stops using the stored key until a key is saved', () => {
    const { state, faults, snapshot } = inconsistent();
    faults.fail = (op) => op === 'delete';
    expect(() => state.restoreState(snapshot)).toThrow();
    expect(state.keyFor(OLD_URL)).toBeNull();
    expect(state.endpoint().apiKey).toBeNull();
    expect(state.responseFields()['external.apiKeySet']).toBe(false);
    expect(state.responseFields()['external.apiKeyBoundOrigin']).toBe('');

    // A later successful restore does NOT re-trust the store...
    faults.fail = () => false;
    state.restoreState(state.captureState());
    expect(state.keyFor(OLD_URL)).toBeNull();
    // ...a successful key save does.
    commitOk(state, { 'external.apiKey': 'Zq7-binding-FRESH-0004' });
    expect(state.keyFor(OLD_URL)).toBe('Zq7-binding-FRESH-0004');
  });

  it('a successful key clear also re-trusts the (now empty) store', () => {
    const { state, faults, snapshot } = inconsistent();
    faults.fail = (op) => op === 'delete';
    expect(() => state.restoreState(snapshot)).toThrow();
    faults.fail = () => false;
    commitOk(state, { 'external.apiKey': '' });
    expect(state.keyFor(OLD_URL)).toBeNull();
    commitOk(state, { 'external.apiKey': 'Zq7-binding-AFTER-CLEAR-0005' });
    expect(state.keyFor(OLD_URL)).toBe('Zq7-binding-AFTER-CLEAR-0005');
  });

  it('a restored session-only key stays usable (it lives in memory, not the store)', () => {
    const { state, faults, snapshot } = inconsistent();
    faults.fail = (op) => op === 'delete';
    const withSession: ExternalProviderSettingsState = { ...snapshot, sessionKey: { key: 'Zq7-binding-SESSION-0006', origin: OLD_ORIGIN } };
    expect(() => state.restoreState(withSession)).toThrow();
    expect(state.keyFor(OLD_URL)).toBe('Zq7-binding-SESSION-0006');
  });
});
