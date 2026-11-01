/**
 * SettingsProfileSection — the shared-workstation profile surface (issue #34
 * item 6p; plan R2/R3-5/R4-4/R4-5/R5-5): the registered-profile list with
 * runtime Switch (two-click confirm), create-new, explicit Adopt/Delete rows
 * for unregistered orphan prefixes (the ONLY route to an unregistered
 * namespace's data — automatic merging is retired), the fail-closed
 * corrupt-registry recovery (reset re-registers ONLY the current profile),
 * and the "Adopt legacy conversation history" action (R5-2/R7-1: the
 * pre-profile shared conversations db).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui';
import { SettingsSubsection } from '../components/SettingsControls';
import {
  deleteNamespace,
  getProfilePrefix,
  listRegisteredProfiles,
  listStalePrefixes,
  registerProfile,
  resetProfileRegistry,
} from '../lib/storage/profile';
import {
  adoptLegacyConversationsForCurrentProfile,
  createProfile,
  switchProfile,
  type LegacyAdoptionOutcome,
  type ProfileSwitchResult,
} from '../lib/storage/profile-switch';

function switchFailureMessage(reason: Exclude<ProfileSwitchResult, { switched: true }>['reason']): string {
  switch (reason) {
    case 'invalid-prefix':
      return 'That profile id is not valid.';
    case 'already-active':
      return 'That profile is already active.';
    case 'not-registered':
      return 'That profile is not registered on this workstation.';
    case 'registration-failed':
      return 'Could not register the profile — the profile registry is unreadable.';
    case 'storage-unavailable':
      return 'Browser storage is unavailable, so the switch could not be saved.';
    return 'The switch failed.';
  }
}

export function SettingsProfileSection(): React.ReactElement {
  const [registry, setRegistry] = useState(() => listRegisteredProfiles());
  const [orphans, setOrphans] = useState<string[]>([]);
  const [confirmingPrefix, setConfirmingPrefix] = useState<string | null>(null);
  const [deletingPrefix, setDeletingPrefix] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyResult, setLegacyResult] = useState<LegacyAdoptionOutcome | null>(null);
  const [registryResetArmed, setRegistryResetArmed] = useState(false);

  const current = getProfilePrefix();

  const refresh = useCallback(async () => {
    setRegistry(listRegisteredProfiles());
    try {
      setOrphans(await listStalePrefixes());
    } catch {
      setOrphans([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSwitch = (prefix: string): void => {
    setError(null);
    setNotice(null);
    if (confirmingPrefix === prefix) {
      const result = switchProfile(prefix);
      if (!result.switched) setError(switchFailureMessage(result.reason));
      return;
    }
    setConfirmingPrefix(prefix);
  };

  const handleCreate = (): void => {
    setError(null);
    setNotice(null);
    const created = createProfile();
    if (created.error !== undefined || created.prefix === undefined) {
      setError(created.error ?? 'Could not create the profile.');
      return;
    }
    const result = switchProfile(created.prefix);
    if (!result.switched) {
      setError(switchFailureMessage(result.reason));
      void refresh();
      return;
    }
    setNotice(`Switched to the new profile ${created.prefix}.`);
  };

  const handleAdoptOrphan = (prefix: string): void => {
    setError(null);
    setNotice(null);
    if (!registerProfile(prefix)) {
      setError('Could not register that profile — the profile registry is unreadable.');
      return;
    }
    setNotice(`Profile ${prefix} registered. Switch to it to use its data.`);
    void refresh();
  };

  const handleDeleteOrphan = (prefix: string): void => {
    setError(null);
    setNotice(null);
    if (deletingPrefix === prefix) {
      void deleteNamespace(prefix).then(() => {
        setNotice(`Deleted the orphaned data of ${prefix}.`);
        setDeletingPrefix(null);
        void refresh();
      });
      return;
    }
    setDeletingPrefix(prefix);
  };

  const handleLegacyAdopt = async (): Promise<void> => {
    setError(null);
    setLegacyResult(null);
    setLegacyBusy(true);
    try {
      setLegacyResult(await adoptLegacyConversationsForCurrentProfile());
    } finally {
      setLegacyBusy(false);
    }
  };

  const handleRegistryReset = (): void => {
    setError(null);
    setNotice(null);
    if (registryResetArmed) {
      if (resetProfileRegistry()) {
        setNotice('Profile registry reset. Only the current profile is registered; colleagues can adopt theirs below.');
        setRegistryResetArmed(false);
        void refresh();
      } else {
        setError('The registry reset failed — the registry remains unreadable and destructive operations stay refused.');
      }
      return;
    }
    setRegistryResetArmed(true);
  };

  return (
    <SettingsSubsection title="Profile data" headingId="profile-data-heading" data-testid="profile-data-section">
      <p className="settings-text" data-testid="profile-current">
        Active profile:{' '}
        <code className="settings-code" data-testid="active-profile-value">
          {current}
        </code>
        . Each profile keeps its own documents, indexes
        and conversations on this workstation.
      </p>

      {registry.healthy ? (
        <>
          <div className="settings-group" data-testid="profile-list">
            <p className="settings-label">Registered profiles</p>
            {registry.profiles.length === 0 ? (
              <p className="settings-text">No other profiles are registered.</p>
            ) : (
              <ul className="settings-list">
                {registry.profiles.map((prefix) => (
                  <li key={prefix} data-testid={`profile-row-${prefix}`}>
                    <code className="settings-code" data-testid="profile-registry-name">
                      {prefix}
                    </code>
                    {prefix === current ? (
                      <span className="settings-text"> (active)</span>
                    ) : (
                      <>
                        {' '}
                        <Button
                          variant={confirmingPrefix === prefix ? 'danger' : 'secondary'}
                          size="sm"
                          data-testid={`profile-switch-${prefix}`}
                          onClick={() => handleSwitch(prefix)}
                        >
                          {confirmingPrefix === prefix ? 'Click again to confirm switch' : 'Switch'}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="settings-row">
              <Button variant="secondary" size="sm" data-testid="profile-create" onClick={handleCreate}>
                Create and switch to a new profile
              </Button>
              <span className="settings-text">Mints a fresh, empty profile namespace.</span>
            </div>
          </div>

          <div className="settings-group" data-testid="profile-orphans">
            <p className="settings-label">Orphaned data</p>
            {orphans.length === 0 ? (
              <p className="settings-text">No unregistered orphan namespaces were found.</p>
            ) : (
              <ul className="settings-list">
                {orphans.map((prefix) => (
                  <li key={prefix} data-testid={`orphan-row-${prefix}`}>
                    <code className="settings-code">{prefix}</code>{' '}
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid={`orphan-adopt-${prefix}`}
                      onClick={() => handleAdoptOrphan(prefix)}
                    >
                      Adopt
                    </Button>{' '}
                    <Button
                      variant={deletingPrefix === prefix ? 'danger' : 'secondary'}
                      size="sm"
                      data-testid={`orphan-delete-${prefix}`}
                      onClick={() => handleDeleteOrphan(prefix)}
                    >
                      {deletingPrefix === prefix ? 'Click again to confirm delete' : 'Delete'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="settings-text">
              Adopt registers an orphan namespace as a switchable profile (its data stays in place). Adopting never
              merges or moves data. Delete permanently removes that namespace&apos;s documents and indexes.
            </p>
          </div>

          <div className="settings-group" data-testid="profile-legacy-adopt">
            <p className="settings-label">Legacy conversation history</p>
            <p className="settings-text">
              Versions before profiles kept one shared conversation history. The first profile to open the app after
              the update adopts it; alternatively adopt it into THIS profile explicitly.
            </p>
            <Button
              variant="secondary"
              size="sm"
              data-testid="legacy-adopt-button"
              loading={legacyBusy}
              disabled={legacyBusy}
              onClick={() => void handleLegacyAdopt()}
            >
              {legacyBusy ? 'Adopting…' : 'Adopt legacy conversation history'}
            </Button>
            {legacyResult !== null && (
              <p
                className={
                  legacyResult.status === 'refused'
                    ? 'settings-text settings-tone--danger'
                    : 'settings-text settings-tone--success'
                }
                data-testid="legacy-adopt-result"
              >
                {legacyResult.status === 'adopted' && `Adopted ${legacyResult.count} legacy conversations.`}
                {legacyResult.status === 'already-done' && 'The legacy history was already adopted.'}
                {legacyResult.status === 'nothing-to-adopt' && 'There is no legacy conversation history to adopt.'}
                {legacyResult.status === 'refused' && legacyResult.message}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="settings-well settings-well--danger" data-testid="profile-registry-corrupt">
          <p className="settings-text settings-tone--danger">
            Profile registry is unreadable. Switching and every destructive operation are refused until the registry
            is reset.
          </p>
          <p className="settings-text">
            Resetting clears the registry and re-registers ONLY the current profile. Colleagues&apos; profiles become
            unregistered and appear below as adoptable orphans — their data is never deleted by the reset.
          </p>
          <Button
            variant={registryResetArmed ? 'danger' : 'secondary'}
            size="sm"
            data-testid="profile-registry-reset"
            onClick={handleRegistryReset}
          >
            {registryResetArmed ? 'Click again to confirm reset' : 'Reset profile registry'}
          </Button>
        </div>
      )}

      {error !== null && (
        <p className="settings-text settings-tone--danger" role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="settings-text settings-tone--success" role="status">
          {notice}
        </p>
      )}
    </SettingsSubsection>
  );
}
