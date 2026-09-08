import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Acceptance-check wiring for issue #59 (frozen before implementation).
//
// Module type: ESM ("type": "module" in desktop/package.json) — the implementer
// compiles desktop/main and desktop/preload as ESM.
//
// Every `electron` import — from the spec files AND from the production seams
// under desktop/main / desktop/preload once they exist — resolves to the
// in-memory stub at desktop/test/electron-stub.ts, so the acceptance checks
// never require the real Electron binary.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        // Exact match on the bare specifier only; implementations must import
        // from 'electron' (no deep imports).
        find: /^electron$/,
        replacement: path.join(here, 'test', 'electron-stub.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
