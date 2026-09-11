// b8-telemetry-route.test.ts — FROZEN ACCEPTANCE SPEC (issue #66 trace, AC7 / S7, check C1).
//
// Pins GET /telemetry/memory on the REAL guarded server booted exactly like
// the b3 spec boots it (createBackendServer + createLoopbackGuard + StubEngine,
// node mode). RED AT BASE: the route is absent from CONTRACT_ROUTES
// (desktop/main/backend/server.ts) and from contracts/api.openapi.yaml, so the
// guarded request answers 404 and the first assertion below fails with a
// 404-vs-200 reason. That failure IS the acceptance evidence for the missing
// observability surface.
//
// This file deliberately imports ONLY modules that already exist at the base
// revision (server / engine / loopback-guard). It must NEVER import a
// desktop/main/backend/memory/* module — it has to RUN (and fail with the 404
// evidence) on the pre-fix tree.
//
// FROZEN ROUTE CONTRACT the implementer must add (server.ts CONTRACT_ROUTES +
// contracts/api.openapi.yaml version bump, token-guarded like every route —
// it reveals process memory, so NOT /health-style unauthenticated):
//
//   GET /telemetry/memory
//     -> 200, content-type application/json, body:
//     {
//       "snapshot": {
//         "chromiumRssMb":         number,  // >= 0, finite
//         "llmRssMb":              number,  // >= 0, finite
//         "embeddingSessionRssMb": number,  // >= 0, finite
//         "rerankerSessionRssMb":  number,  // >= 0, finite
//         "sqliteRssMb":           number,  // >= 0, finite
//         "systemFreeMb":          number,  // >= 0, finite; systemTotalMb >= systemFreeMb
//         "systemTotalMb":         number   // >= 0, finite
//       },
//       "downgrade": {
//         "effectiveProfile": "quality" | "fast",   // B4 profile vocabulary
//         "downgraded":       boolean
//       }
//     }
//   - no transport token -> 401 (the B3 guard stays in front of the route);
//   - a non-GET method on the known path -> 405 (route-table semantics).
//
// The snapshot numbers are MB (1 MB = 1024 * 1024 bytes) and come from the
// memory/telemetry.ts MemorySnapshot (issue S1); the downgrade state comes
// from the memory/budget.ts pressure monitor (issue S2/S6).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server.js';
import { StubEngine } from '../../main/backend/engine.js';
import { createLoopbackGuard } from '../../main/security/loopback-guard.js';

const TOKEN = 'b8-telemetry-spec-token';
const TOKEN_HEADER = 'x-desktop-token';

let server: http.Server;
let port = 0;

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

beforeAll(async () => {
  // The telemetry option is an INLINE STRUCTURAL STUB (a plain provider
  // function returning the C1 response shape; zero new imports): it decouples
  // this file's TRANSPORT conformance pin (route exists -> 200, guard -> 401,
  // non-GET -> 405; red at base with the exact 404-vs-200 assertion) from the
  // PROVIDER shape, which b8-wiring.test.ts item 9 pins against the real
  // createMemoryTelemetry. Keeping the stub inline keeps the file
  // BASE-RUNNABLE (C1 is the only DISCRIMINATING row) and lets C9's
  // no-telemetry 503 arm coexist: no provider wired -> 503, provider wired ->
  // 200, regardless of who built the provider.
  server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine: new StubEngine(),
    telemetry: () => ({
      snapshot: {
        chromiumRssMb: 0,
        llmRssMb: 0,
        embeddingSessionRssMb: 0,
        rerankerSessionRssMb: 0,
        sqliteRssMb: 0,
        systemFreeMb: 0,
        systemTotalMb: 0,
      },
      downgrade: { effectiveProfile: 'quality', downgraded: false },
    }),
  });
  port = await listenOnRandomPort(server);
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const SNAPSHOT_NUMERIC_FIELDS = [
  'chromiumRssMb',
  'llmRssMb',
  'embeddingSessionRssMb',
  'rerankerSessionRssMb',
  'sqliteRssMb',
  'systemFreeMb',
  'systemTotalMb',
] as const;

interface TelemetryMemoryBody {
  snapshot?: Record<string, unknown>;
  downgrade?: { effectiveProfile?: unknown; downgraded?: unknown };
}

describe('b8 C1 (AC7/S7): GET /telemetry/memory on the guarded server', () => {
  it(
    'answers 200 with the documented snapshot + downgrade state (RED at base: the route 404s)',
    async () => {
      const response = await fetch(url('/telemetry/memory'), { headers: { [TOKEN_HEADER]: TOKEN } });
      // RED AT BASE: /telemetry/memory is not in CONTRACT_ROUTES, so this
      // fails as "expected ... to be 200" with received 404 until S7 lands.
      expect(response.status, 'GET /telemetry/memory must exist on the guarded contract surface').toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');

      const body = (await response.json()) as TelemetryMemoryBody;
      expect(body, 'route body must be a JSON object').toBeTypeOf('object');

      // The current snapshot under exactly one documented key: "snapshot".
      expect(body.snapshot, 'body.snapshot must exist (the current MemorySnapshot, S1)').toBeTypeOf('object');
      for (const field of SNAPSHOT_NUMERIC_FIELDS) {
        const value = body.snapshot?.[field];
        expect(value, `snapshot.${field} must be a number`).toBeTypeOf('number');
        expect(Number.isFinite(value as number), `snapshot.${field} must be finite`).toBe(true);
        expect(value as number, `snapshot.${field} must be non-negative`).toBeGreaterThanOrEqual(0);
      }
      expect(
        body.snapshot?.systemTotalMb as number,
        'systemTotalMb must be >= systemFreeMb',
      ).toBeGreaterThanOrEqual(body.snapshot?.systemFreeMb as number);

      // The downgrade state under exactly one documented key: "downgrade",
      // naming the effective inference profile with B4's vocabulary.
      expect(body.downgrade, 'body.downgrade must exist (the pressure/downgrade state, S2/S6)').toBeTypeOf('object');
      expect(body.downgrade?.effectiveProfile, 'downgrade.effectiveProfile must be a string').toBeTypeOf('string');
      expect(
        ['quality', 'fast'],
        'downgrade.effectiveProfile must be one of the B4 profile names',
      ).toContain(body.downgrade?.effectiveProfile);
      expect(body.downgrade?.downgraded, 'downgrade.downgraded must be a boolean').toBeTypeOf('boolean');
    },
    20_000,
  );

  it(
    'stays behind the loopback guard (no token -> 401) and a non-GET method gets 405',
    async () => {
      // The guard runs before routing, so this half already passes at base —
      // the route must never weaken the B3 guardrail when it is added.
      const unauthorized = await fetch(url('/telemetry/memory'));
      expect(unauthorized.status).toBe(401);
      // Known path + wrong method is route-table semantics (CONTRACT_ROUTES).
      const wrongMethod = await fetch(url('/telemetry/memory'), {
        method: 'POST',
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      expect(wrongMethod.status).toBe(405);
    },
    20_000,
  );
});
