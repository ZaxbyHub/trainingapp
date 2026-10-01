// pack-client.ts — ONE pack interface for both apps (trace
// browser-training-parity AC4/AC7/AC8/AC9). The Packs panel, the Documents
// page and the Training page consume a PackClient; the desktop app backs it
// with its loopback API (ApiClient) plus the preload update bridge, the
// browser app with the origin-private pack store (browser-pack-manager.ts)
// plus the browser update controller. Same UI, same seams; only the
// transport differs.
import { useMemo } from 'react';
import type { ApiClient } from '../api';
import type { InstallPackResult, PackInfo } from '../api/types';
import { isElectron, useDesktopSession } from '../desktop-session';
import { getBrowserPackManager, type StorageReport } from './browser-pack-manager';
import { getUpdatesBridge, type UpdatesBridge } from './pack-update-controller';
import { releaseBrowserTrainingIfEmpty } from './browser-training';

export interface PackClient {
  readonly kind: 'desktop' | 'browser';
  listPacks(): Promise<PackInfo[]>;
  installPack(file: File): Promise<InstallPackResult>;
  removePack(packId: string, version: string): Promise<unknown>;
  rollbackPack(packId: string, version: string): Promise<unknown>;
  /** The signed update channel (absent when the host offers none). */
  readonly updates: UpdatesBridge | undefined;
  /** Browser storage used/available (the browser's origin quota; AC9). */
  storageReport?(): Promise<StorageReport>;
  /** Registry change notifications (installs/removals from this tab). */
  subscribe?(listener: () => void): () => void;
  /** Why this browser cannot install packs, or null (browser app only). */
  capabilityIssue?(): string | null;
}

/** The desktop app: loopback pack API + preload update bridge. */
export function desktopPackClient(apiClient: ApiClient): PackClient {
  return {
    kind: 'desktop',
    listPacks: () => apiClient.listPacks(),
    installPack: (file) => apiClient.installPack(file),
    removePack: (packId, version) => apiClient.removePack(packId, version),
    rollbackPack: (packId, version) => apiClient.rollbackPack(packId, version),
    get updates() {
      return getUpdatesBridge();
    },
  };
}

/** The browser app: origin-private pack store + browser update controller. */
export function browserPackClient(): PackClient {
  const manager = getBrowserPackManager();
  return {
    kind: 'browser',
    listPacks: async () => {
      await manager.collectOrphans();
      return manager.listPacks();
    },
    installPack: (file) => manager.installPack(file),
    removePack: async (packId, version) => {
      const removed = await manager.removePack(packId, version);
      // The last pack is gone: the player-origin worker is unregistered too.
      await releaseBrowserTrainingIfEmpty().catch(() => undefined);
      return removed;
    },
    rollbackPack: (packId, version) => manager.rollbackPack(packId, version),
    get updates() {
      return getUpdatesBridge();
    },
    storageReport: () => manager.storageReport(),
    subscribe: (listener) => manager.subscribe(listener),
    capabilityIssue: () => {
      const missing = manager.missingCapabilities();
      return missing.length === 0
        ? null
        : `This browser cannot install training or knowledge packs (missing ${missing.join(', ')}). Use a current Chrome, Edge or Firefox, or the desktop app.`;
    },
  };
}

/**
 * The PackClient for the current app: the desktop loopback API inside
 * Electron (once the session exists), the browser store otherwise. Returns
 * null inside Electron until the desktop session is ready.
 */
export function usePackClient(): PackClient | null {
  const { session } = useDesktopSession();
  const apiClient = session?.apiClient ?? null;
  // A desktop session exists only inside Electron; without one, Electron is
  // still booting (no client yet) and a plain browser uses its own store.
  const electron = apiClient === null && isElectron();
  return useMemo(() => {
    if (apiClient !== null) return desktopPackClient(apiClient);
    if (electron) return null;
    return browserPackClient();
  }, [electron, apiClient]);
}
