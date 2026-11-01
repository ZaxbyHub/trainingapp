/**
 * profile-switch (issue #34 item 6p, AC5, check C5): runtime profile
 * switching. One behavior per test. The C5 contract:
 *   1. switchProfile(target) persists the target under the PROFILE_KEY
 *      semantics ('doc-qa-profile-id', validated against the same
 *      lowercase-alphanumeric shape getProfilePrefix enforces) and triggers
 *      the app reload;
 *   2. after the switch, getStorageDbNames() re-resolves to the TARGET
 *      profile's prefixed storage names;
 *   3. the prior profile's conversations are not carried over — the new
 *      prefix's conversation store resolves to a DIFFERENT database name,
 *      never the previous profile's records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY, REGISTERED_PROFILES_KEY } from './persisted-keys';
import { getProfilePrefix, getStorageDbNames, registerProfile } from './profile';
import { listProfiles, switchProfile } from './profile-switch';

const PREFIX_A = 'profilea';
const PREFIX_B = 'profileb';

const realLocation = window.location;

function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, protocol: 'http:', origin: 'http://localhost', reload },
  });
  return reload;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, PREFIX_A);
  localStorage.setItem(REGISTERED_PROFILES_KEY, JSON.stringify([PREFIX_A, PREFIX_B]));
  stubReload();
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('switchProfile (C5-1: PROFILE_KEY semantics + reload)', () => {
  it('persists the target prefix under doc-qa-profile-id and reloads', () => {
    const reload = stubReload();
    const result = switchProfile(PREFIX_B);
    expect(result).toEqual({ switched: true });
    expect(localStorage.getItem(PROFILE_KEY)).toBe(PREFIX_B);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid prefix shape (not registered, never written)', () => {
    const result = switchProfile('Bad/Prefix');
    expect(result).toEqual({ switched: false, reason: 'invalid-prefix' });
    expect(localStorage.getItem(PROFILE_KEY)).toBe(PREFIX_A);
  });

  it('refuses the current profile', () => {
    const result = switchProfile(PREFIX_A);
    expect(result).toEqual({ switched: false, reason: 'already-active' });
    expect(localStorage.getItem(PROFILE_KEY)).toBe(PREFIX_A);
  });

  it('refuses an unregistered target without registerIfNew', () => {
    const result = switchProfile('unknown1');
    expect(result).toEqual({ switched: false, reason: 'not-registered' });
    expect(localStorage.getItem(PROFILE_KEY)).toBe(PREFIX_A);
  });

  it('registers an explicitly-new target when registerIfNew is set', () => {
    const result = switchProfile('brandnw1', { registerIfNew: true });
    expect(result).toEqual({ switched: true });
    expect(localStorage.getItem(PROFILE_KEY)).toBe('brandnw1');
    const registered = JSON.parse(localStorage.getItem(REGISTERED_PROFILES_KEY) ?? '[]') as string[];
    expect(registered).toContain('brandnw1');
  });
});

describe('switchProfile (C5-2: storage names re-resolve to the target)', () => {
  it('getStorageDbNames() carries the new prefix on every name after the switch', () => {
    const before = getStorageDbNames();
    expect(before.conversations).toBe(`${PREFIX_A}-doc-qa-conversations`);
    switchProfile(PREFIX_B);
    const after = getStorageDbNames();
    expect(Object.values(after).every((name) => name.startsWith(`${PREFIX_B}-`))).toBe(true);
    expect(after.documents).toBe(`${PREFIX_B}-doc-qa-documents`);
    expect(after.vectorMapping).toBe(`${PREFIX_B}-doc-qa-indexes`);
    expect(after.vector).toBe(`${PREFIX_B}-doc-qa-index`);
    expect(after.keyword).toBe(`${PREFIX_B}-doc-qa-keywords`);
    expect(getProfilePrefix()).toBe(PREFIX_B);
  });
});

describe('switchProfile (C5-3: prior conversations never carried over)', () => {
  it('the new prefix resolves a different conversations database, never the prior profile records', () => {
    const before = getStorageDbNames();
    switchProfile(PREFIX_B);
    const after = getStorageDbNames();
    expect(after.conversations).toBe(`${PREFIX_B}-doc-qa-conversations`);
    expect(after.conversations).not.toBe(before.conversations);
    // The prior profile's store is untouched under its own name: a read of
    // the OLD name never serves the new profile and vice versa.
    expect(before.conversations).toBe(`${PREFIX_A}-doc-qa-conversations`);
  });
});

describe('listProfiles (registry-based discovery)', () => {
  it('returns the registered profiles from the registry, not enumeration', () => {
    const { profiles, healthy } = listProfiles();
    expect(healthy).toBe(true);
    expect(profiles).toEqual([PREFIX_A, PREFIX_B]);
  });

  it('reflects a newly registered profile', () => {
    expect(registerProfile('newprof')).toBe(true);
    expect(listProfiles().profiles).toContain('newprof');
  });
});
