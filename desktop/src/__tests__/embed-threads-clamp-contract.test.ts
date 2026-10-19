// embed-threads-clamp-contract.test.ts — issue #204 AC6 (batch
// batch-143-203-204-212-213-215): the determinism seam CLAMPS oversized
// TRAININGAPP_DESKTOP_EMBED_THREADS values to the host's parallelism (floor
// 1) instead of forwarding them to the ONNX session. Values at or below the
// core count pass through unchanged; invalid values keep the default-OFF
// contract (undefined, no session_options key).
//
// The frozen filter name `clamp-rejects-oversized` is the check identity
// (issue #204 AC2's row); the semantics are CLAMP, both directions asserted
// below. Named mutant: delete the clamp in embed-threads.ts (restore the raw
// value) — this row must go red.
import { describe, expect, it } from 'vitest';
import { embedSessionOptions } from '../../main/backend/ingest/embed-threads.js';

describe('embed seam clamp (issue #204 AC6)', () => {
  it('clamp-rejects-oversized: oversized pins clamp to coreCount and small values pass through', () => {
    // Oversized → clamped to the injected coreCount (never the raw value).
    const oversized = embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '999999999' }, 4);
    expect(oversized).toEqual({
      intraOpNumThreads: 4,
      interOpNumThreads: 1,
      executionMode: 'sequential',
    });
    const aboveByOne = embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '5' }, 4);
    expect(aboveByOne?.intraOpNumThreads).toBe(4);

    // At/below coreCount → unchanged (the determinism pin is honored).
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '4' }, 4)?.intraOpNumThreads).toBe(4);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '2' }, 4)?.intraOpNumThreads).toBe(2);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '1' }, 4)?.intraOpNumThreads).toBe(1);

    // Floor 1: a degenerate coreCount never yields 0 threads.
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '8' }, 0)?.intraOpNumThreads).toBe(1);
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '8' }, -3)?.intraOpNumThreads).toBe(1);

    // Invalid input keeps the default-OFF contract (clamp must not rescue it).
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: '0' }, 4)).toBeUndefined();
    expect(embedSessionOptions({ TRAININGAPP_DESKTOP_EMBED_THREADS: 'abc' }, 4)).toBeUndefined();
    expect(embedSessionOptions({}, 4)).toBeUndefined();
  });
});
