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
    // Suite-wide deadline ceiling. The PR #159 review proposed REMOVING this
    // (PRR-028) on the grounds that the diff already carried 14 per-test
    // budgets, and a local run at the 5s default was green. CI disagreed, and
    // CI is the authority: `c4-recency-pipeline.test.ts` ("attributes the
    // semver winner when two versions are both active") and
    // `d6-learn-kernel.test.ts` ("caps results at MAX_LEARN_RESULTS") both
    // timed out at 5000ms on the runner while running 6.8s and 5.7s. Those
    // suites are untouched by this change; the ceiling is what they depend on
    // when the machine is loaded. Restored deliberately, with the earlier
    // rationale - "several inference tests construct a model per query" -
    // corrected, because no desktop test constructs a real model.
    testTimeout: 30_000,
  },
});
