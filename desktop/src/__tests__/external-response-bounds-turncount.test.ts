// external-response-bounds-turncount.test.ts — issue #243 acceptance (FROZEN
// acceptance surface, arm's-length authored BEFORE the implementation lands;
// round-2 revision: fixture-module contract + independent methodology control).
// RED at base, GREEN after the fix.
//
// The F-003 closeout legs fail CI-only because their duration is dominated by
// per-event loop turns: the fixture pumps 2731 SSE frames / ~2848 socket
// `data` events one `res.write` at a time, and on the GitHub runner deploy
// 20261015.610+ the per-event cost (~16 ms ≈ the Windows timer tick) paces
// the legs past every sentinel budget. The fix batches many SSE frames into
// each write so the event count collapses by an order of magnitude while
// per-delta cap granularity and the mid-stream cap trip (frame 2731 of 2800,
// 3072-byte deltas) are preserved.
//
// CONTRACT the fix must satisfy (binding; assertions live HERE, not in the
// fixture builder, so the implementer cannot weaken them):
//   desktop/src/__tests__/fixtures/external-cap-fixture.ts exports
//     runStreamingCapLeg(protocol: 'openai' | 'anthropic'): Promise<{
//       dataEvents: number;      // client-side socket 'data' events observed during the leg
//       emittedBytes: number;    // bytes delivered to generateExternal's streamCallback before the cap error
//       failureMessage: string;  // message of the ExternalProviderError the cap raises ('' when the leg wrongly succeeded)
//       requestAborted: boolean; // true when the upstream connection was closed by the client (cap contract)
//     }>
//   The leg keeps the real FRAMES=2800 / DELTA='€'×1024 workload and drives
//   the real generateExternal path (no shortened fixture, no fake client).
//   The shared builder lives in the NON-test fixture module so importing it
//   here does NOT re-register the sibling test file's suite (no duplicate
//   F-003/F-009 workload in full-suite runs — checked by a collection-count
//   probe recorded in 08-test-results.md).
//   Residual (disclosed; independent subject measurement retained as an
//   explicit implementation-review obligation — plan-critic round 2): the
//   subject rows' dataEvents is measured by the export implementation, so a
//   fabricated constant would pass them. The control row below proves the
//   measurement METHODOLOGY (raw-socket 'data' counting against a known-
//   unbatched pump reads ≥ the base-shape bound) independently of the
//   implementer's code; the implementation review must mutation-probe the
//   subject measurement (feed it a fabricated constant -> control relationship
//   and the cap assertions must still bind, and the count source must be shown
//   to read the real consumer connection).
import { describe, expect, it } from 'vitest';

interface StreamingCapLegStats {
  dataEvents: number;
  emittedBytes: number;
  failureMessage: string;
  requestAborted: boolean;
}
type RunStreamingCapLeg = (protocol: 'openai' | 'anthropic') => Promise<StreamingCapLegStats>;

// Dynamic import with a catch so the BASE tree (no fixture module) fails as a
// per-row assertion (`expected 'undefined' to be 'function'`) instead of a
// file-level import error — the frozen driver keys on that exact signature.
let loadFixtureModule: () => Promise<{ runStreamingCapLeg?: RunStreamingCapLeg }>;
try {
  const mod = (await import('./fixtures/external-cap-fixture.js')) as {
    runStreamingCapLeg?: RunStreamingCapLeg;
  };
  loadFixtureModule = async () => mod;
} catch {
  loadFixtureModule = async () => ({});
}

// Base: ~2848 events on the openai leg (one per SSE frame plus drain resumes).
// A batched pump lands at ~100-300 (the floor is total-bytes / 64 KiB reads ≈
// 130 for the 8.5 MB body). 600 rejects the un-fixed shape with >4.7x margin
// while allowing generous batching (writes averaging ≥ ~14 KiB).
const MAX_LEG_DATA_EVENTS = 600;
// The control row's known-unbatched pump must read WELL above this bound —
// this is what makes the methodology discriminating.
const MIN_UNBATCHED_DATA_EVENTS = 600;
const CAP_BYTES = 8 * 1024 * 1024;
const DELTA_BYTES = 3072;

describe('F-003 turncount (issue #243): the 8 MiB cap legs are insensitive to per-event loop-turn pacing', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`turncount: ${protocol} leg delivers the >8 MiB capped stream in collapsed socket data events`, async () => {
      const run = (await loadFixtureModule()).runStreamingCapLeg;
      expect(
        typeof run,
        'fixtures/external-cap-fixture.ts must export runStreamingCapLeg (the #243 fixture-builder contract)',
      ).toBe('function');
      const stats = await (run as RunStreamingCapLeg)(protocol);
      // Cap semantics unchanged: classified server error at the 8 MiB cap...
      expect(stats.failureMessage).toMatch(/an answer larger than 8388608 bytes/);
      // ...tripped mid-stream, within ONE delta of granularity (what the user
      // saw stays at most the cap and never more than one delta under it)...
      expect(stats.emittedBytes).toBeLessThanOrEqual(CAP_BYTES);
      expect(stats.emittedBytes).toBeGreaterThan(CAP_BYTES - DELTA_BYTES);
      // ...and the request is still aborted (the upstream connection goes away).
      expect(stats.requestAborted).toBe(true);
      // THE #243 PIN: the per-event turn count collapsed (~2848 → hundreds).
      expect(
        stats.dataEvents,
        `${protocol} leg must not spend one event-loop turn per SSE frame (base ~2848 socket data events)`,
      ).toBeLessThan(MAX_LEG_DATA_EVENTS);
    }, 120_000);
  }

  it('control: the raw-socket event counter reads the unbatched pump shape at its bound (methodology pin)', async () => {
    // Self-contained negative control, independent of the implementer's code:
    // serve the same byte volume as one res.write per SSE frame (the BASE
    // pump shape), count client-side socket 'data' events, and require the
    // count to be at or above the unbatched bound. If this row ever fails,
    // the subject rows' event-count assertion is not measuring what it
    // claims (same-host socket behavior changed), not that the fix regressed.
    const http = await import('node:http');
    const frames: string[] = [];
    const delta = '€'.repeat(1024); // 3072 UTF-8 bytes, same as the F-003 fixture
    const totalFrames = 2800;
    for (let i = 0; i < totalFrames; i += 1) {
      frames.push(`data: {"delta":"${delta}"}\n\n`);
    }
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const pump = (): void => {
        while (i < frames.length) {
          i += 1;
          if (!res.write(frames[i - 1])) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    let dataEvents = 0;
    let bytesSeen = 0;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'GET' },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            dataEvents += 1;
            bytesSeen += chunk.length;
          });
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
    server.close();
    expect(bytesSeen).toBeGreaterThan(CAP_BYTES);
    expect(
      dataEvents,
      'the one-write-per-frame control pump must read at or above the unbatched event bound — if it does not, the subject rows are not counting real socket data events',
    ).toBeGreaterThanOrEqual(MIN_UNBATCHED_DATA_EVENTS);
  }, 120_000);
});
