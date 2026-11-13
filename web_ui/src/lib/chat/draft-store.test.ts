/**
 * #267 (AC7 store, frozen check C23): the in-memory per-conversation draft
 * store — get/set/clear, EMPTY DELETES, and NEVER persisted (no
 * localStorage/sessionStorage writes at all).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { clearDraft, getDraft, moveDraftIfTargetEmpty, setDraft } from './draft-store';

describe('draft-store (#267 AC7)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearDraft('k1');
    clearDraft('k2');
    clearDraft('from');
    clearDraft('to');
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('set/get round-trips a draft', () => {
    expect(getDraft('k1')).toBeUndefined();
    setDraft('k1', 'hello');
    expect(getDraft('k1')).toBe('hello');
  });

  it('setting an EMPTY string deletes the entry (empty deletes)', () => {
    setDraft('k1', 'hello');
    setDraft('k1', '');
    expect(getDraft('k1')).toBeUndefined();
    // And no empty-string value was ever stored.
    setDraft('k2', '');
    expect(getDraft('k2')).toBeUndefined();
  });

  it('clearDraft removes the entry (absent is fine)', () => {
    setDraft('k1', 'hello');
    clearDraft('k1');
    expect(getDraft('k1')).toBeUndefined();
    expect(() => clearDraft('never-set')).not.toThrow();
  });

  it('is synchronous (rapid A→B→C switches observe strict ordering)', () => {
    setDraft('a', 'one');
    setDraft('b', 'two');
    setDraft('a', 'three');
    expect(getDraft('a')).toBe('three');
    expect(getDraft('b')).toBe('two');
  });

  it('NEVER persists: no localStorage or sessionStorage write happens', () => {
    // Storage.prototype is shared by BOTH storage objects, so this one spy
    // sees every setItem on either of them.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setDraft('k1', 'draft text');
    setDraft('k1', '');
    clearDraft('k1');
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  describe('moveDraftIfTargetEmpty (the ONE sentinel-migration owner, AC8)', () => {
    it('moves the sentinel draft onto an EMPTY adopted key and deletes the sentinel', () => {
      setDraft('from', 'typed under new-chat');
      expect(moveDraftIfTargetEmpty('from', 'to')).toBe(true);
      expect(getDraft('to')).toBe('typed under new-chat');
      expect(getDraft('from')).toBeUndefined();
    });

    it('never clobbers an existing draft of the adopted key', () => {
      setDraft('from', 'sentinel draft');
      setDraft('to', 'existing draft');
      expect(moveDraftIfTargetEmpty('from', 'to')).toBe(false);
      expect(getDraft('to')).toBe('existing draft');
      expect(getDraft('from')).toBe('sentinel draft');
    });

    it('a no-op when the source key has no draft', () => {
      expect(moveDraftIfTargetEmpty('from', 'to')).toBe(false);
      expect(getDraft('to')).toBeUndefined();
    });

    it('a no-op when from and to are the same key', () => {
      setDraft('from', 'x');
      expect(moveDraftIfTargetEmpty('from', 'from')).toBe(false);
      expect(getDraft('from')).toBe('x');
    });
  });
});
