/**
 * profile-switch — runtime profile switching (issue #34 item 6p, AC5, check
 * C5; plan R2/R4-5/R5-5).
 *
 * A profile exists for switching purposes only when it is REGISTERED in the
 * localStorage registry (lib/storage/profile.ts — discovery never depends on
 * `indexedDB.databases()`, so it works on non-enumerating browsers like
 * Firefox). switchProfile guards the target (valid prefix shape, not the
 * current profile, registered — or explicitly new via registerIfNew), writes
 * the PROFILE_KEY semantics and reloads; every profile-scoped store
 * (documents, indexes, conversations — getStorageDbNames) then re-resolves
 * under the target prefix, so the prior profile's conversations cannot carry
 * over (they live in a different database).
 */

import { PROFILE_KEY } from './persisted-keys';
import {
  getProfilePrefix,
  isRegisteredProfile,
  listRegisteredProfiles,
  newProfilePrefix,
  registerProfile,
  type RegisteredProfiles,
} from './profile';
import { adoptLegacyConversations } from '../../db/conv-protocol';

/** Same prefix shape getProfilePrefix enforces (DB_NAME regex window). */
export const PROFILE_PREFIX_SHAPE = /^[a-z0-9]{3,8}$/;

export type ProfileSwitchResult =
  | { switched: true }
  | { switched: false; reason: 'invalid-prefix' | 'already-active' | 'not-registered' | 'registration-failed' | 'storage-unavailable' };

/** Registered profiles (registry-based; healthy:false flags corruption). */
export function listProfiles(): RegisteredProfiles {
  return listRegisteredProfiles();
}

/**
 * Switch the app to `target`: validate the prefix shape, refuse the current
 * profile and unregistered targets (unless registerIfNew — the Settings
 * create-new flow), write PROFILE_KEY and reload the app into the target
 * profile's namespaced storage.
 */
export function switchProfile(target: string, options?: { registerIfNew?: boolean }): ProfileSwitchResult {
  if (typeof target !== 'string' || !PROFILE_PREFIX_SHAPE.test(target)) {
    return { switched: false, reason: 'invalid-prefix' };
  }
  const current = getProfilePrefix();
  if (target === current) {
    return { switched: false, reason: 'already-active' };
  }
  const registered = isRegisteredProfile(target);
  if (!registered && options?.registerIfNew !== true) {
    return { switched: false, reason: 'not-registered' };
  }
  if (!registered && !registerProfile(target)) {
    // e.g. an unhealthy (corrupt) registry: recovery is the explicit reset.
    return { switched: false, reason: 'registration-failed' };
  }
  try {
    if (typeof localStorage === 'undefined') return { switched: false, reason: 'storage-unavailable' };
    localStorage.setItem(PROFILE_KEY, target);
  } catch {
    return { switched: false, reason: 'storage-unavailable' };
  }
  // The reload re-resolves every profile-scoped store (getStorageDbNames)
  // under the target prefix.
  if (typeof location !== 'undefined' && typeof location.reload === 'function') {
    location.reload();
  }
  return { switched: true };
}

/**
 * Mint and register a brand-new profile (Settings create-new flow). The
 * caller switches to it via switchProfile(prefix).
 */
export function createProfile(): { prefix?: string; error?: string } {
  const prefix = newProfilePrefix();
  if (!registerProfile(prefix)) {
    return { error: 'Could not register the new profile (the profile registry is unreadable).' };
  }
  return { prefix };
}

export type LegacyAdoptionOutcome =
  | { status: 'adopted'; count: number }
  | { status: 'already-done' }
  | { status: 'nothing-to-adopt' }
  | { status: 'refused'; message: string };

/**
 * Settings "Adopt legacy conversation history" wrapper (R5-2/R7-1): adopts
 * the pre-profile SHARED conversations db into the CURRENT profile.
 * PRR-115 (PR #264 review): NO Web Locks refusal — the claim protocol is
 * lock-free BY DESIGN (plan R5-2: the IndexedDB-atomic claim row in the
 * legacy db itself arbitrates concurrent adoptions; Web Locks only gate the
 * AUTOMATIC boot adoption). The manual action works on origins without Web
 * Locks; every failure outcome keeps its user-visible message.
 */
export async function adoptLegacyConversationsForCurrentProfile(): Promise<LegacyAdoptionOutcome> {
  const result = await adoptLegacyConversations(getProfilePrefix());
  if (result.outcome === 'adopted') return { status: 'adopted', count: result.count };
  if (result.outcome === 'already-done') return { status: 'already-done' };
  if (result.outcome === 'nothing-to-adopt') return { status: 'nothing-to-adopt' };
  if (result.reason === 'in-flight') {
    return {
      status: 'refused',
      message: `An adoption is already in flight${result.inFlightTarget !== undefined ? ` (profile ${result.inFlightTarget})` : ''}. Try again once it completes.`,
    };
  }
  return {
    status: 'refused',
    message: 'This profile already has conversations, so the shared history was not adopted into it.',
  };
}
