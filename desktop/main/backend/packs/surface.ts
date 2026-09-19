// C7 (issue #74): the Node host's PackSurface adapter over PackManager.
// One mapping used by BOTH the Electron host wiring (backend/index.ts) and
// the /packs route tests, so the tests exercise the exact production wiring.
import fs from 'node:fs';
import type { InstallPackResponse, PackInfo, PackSurface } from '../types.js';
import type { PackManager } from '../store/pack-manager.js';
import { extractPackZip } from './zip-install.js';

export function createPackSurface(manager: PackManager): PackSurface {
  return {
    list: async (): Promise<PackInfo[]> =>
      (await manager.listInstalled()).map((record) => ({
        pack_id: record.packId,
        version: record.version,
        name: record.name,
        source_class: record.sourceClass,
        published_at: record.publishedAt,
        active: record.active,
        supersedes: record.supersedes,
      })),
    installZip: async (zip, filename): Promise<InstallPackResponse> => {
      const dir = await extractPackZip(zip, filename);
      try {
        const result = await manager.install(dir);
        return {
          pack_id: result.packId,
          version: result.version,
          docs_installed: result.docsInstalled,
          chunks_added: result.chunksAdded,
          superseded: result.superseded,
          warnings: result.warnings,
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    rollback: (packId, toVersion) => manager.rollback(packId, toVersion),
    remove: (packId, version) => manager.remove(packId, version),
  };
}
