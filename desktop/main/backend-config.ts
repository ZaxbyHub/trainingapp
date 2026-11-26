/** Production startup composition: both governance sinks share the live store. */
import path from 'node:path';
import type { BackendHostConfig } from './backend/types.js';
import type { SecretStore } from './security/secret-store.js';
import { createProductionAuditSink, createProductionCustodySink, type CustodyProvider } from './backend/audit-outbox.js';
import { getCurrentStore } from './backend/store/sqlite-store.js';

export interface ProductionEngineOptions {
  userDataPath: string;
  gpuVerdictDir?: string;
  models?: { quality?: string; fast?: string };
  externalProvider: { secretStore: SecretStore; airgap: boolean; auditSink?: CustodyProvider };
}

export interface ProductionStartupOptions {
  userDataPath: string;
  storePath: string;
  externalAirgap: boolean;
  secretStore: SecretStore;
  token: string;
  tokenHeaderName?: string;
  mode?: BackendHostConfig['mode'];
  packsRoot?: string;
  storeBackupsDir?: string;
  models?: { quality?: string; fast?: string };
  allowedOrigins?: string[];
  onIngestProgress?: BackendHostConfig['onIngestProgress'];
  onMemoryEvent?: BackendHostConfig['onMemoryEvent'];
  onStoreCorruption?: BackendHostConfig['onStoreCorruption'];
  onGiveUp?: BackendHostConfig['onGiveUp'];
  onAuditPending?: (payload: { generation: number; pendingCount: number }) => void;
  /** Preserve explicit host fields when the builder is driven as a pure extractor. */
  engine?: BackendHostConfig['engine'];
  env?: BackendHostConfig['env'];
  storeEmbeddingDims?: BackendHostConfig['storeEmbeddingDims'];
  auditSink?: BackendHostConfig['auditSink'];
}

/** Pure field-preserving builder; the custody sink is supplied by startup. */
export function buildProductionEngineOverrides(options: ProductionEngineOptions): ProductionEngineOptions {
  return {
    userDataPath: options.userDataPath,
    ...(options.gpuVerdictDir === undefined ? {} : { gpuVerdictDir: options.gpuVerdictDir }),
    ...(options.models === undefined ? {} : { models: options.models }),
    externalProvider: {
      secretStore: options.externalProvider.secretStore,
      airgap: options.externalProvider.airgap,
      auditSink: options.externalProvider.auditSink,
    },
  };
}

/** Host config half. The pack sink resolves the CURRENT store at emit time. */
export function buildProductionBackendHostConfig(options: ProductionStartupOptions): BackendHostConfig {
  const notify = options.onAuditPending ?? ((): void => {});
  return {
    token: options.token,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.tokenHeaderName === undefined ? {} : { tokenHeaderName: options.tokenHeaderName }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.storeEmbeddingDims === undefined ? {} : { storeEmbeddingDims: options.storeEmbeddingDims }),
    storePath: options.storePath,
    packsRoot: options.packsRoot ?? path.join(path.dirname(options.storePath), 'packs'),
    storeBackupsDir: options.storeBackupsDir ?? path.join(path.dirname(options.storePath), 'backups'),
    auditSink: options.auditSink ?? createProductionAuditSink(() => getCurrentStore(), notify),
    ...(options.onIngestProgress === undefined ? {} : { onIngestProgress: options.onIngestProgress }),
    ...(options.onMemoryEvent === undefined ? {} : { onMemoryEvent: options.onMemoryEvent }),
    ...(options.onStoreCorruption === undefined ? {} : { onStoreCorruption: options.onStoreCorruption }),
    ...(options.onGiveUp === undefined ? {} : { onGiveUp: options.onGiveUp }),
  };
}

/** The ONE startup builder index.ts calls. No resolver/sink argument exists. */
export function buildProductionStartup(options: ProductionStartupOptions): {
  engineOverrides: ProductionEngineOptions;
  hostConfig: BackendHostConfig;
} {
  const notify = options.onAuditPending ?? ((): void => {});
  const auditSink = createProductionCustodySink(() => getCurrentStore(), notify);
  return {
    engineOverrides: buildProductionEngineOverrides({
      userDataPath: options.userDataPath,
      gpuVerdictDir: path.dirname(options.storePath),
      ...(options.models === undefined ? {} : { models: options.models }),
      externalProvider: { secretStore: options.secretStore, airgap: options.externalAirgap, auditSink },
    }),
    hostConfig: buildProductionBackendHostConfig(options),
  };
}
