// b7-recency-hook.test.ts — FROZEN ACCEPTANCE SPEC (issue #65 trace, AC6 / check C6).
//
// This file is a frozen acceptance spec authored by the issue-tracer v3 CHECK
// AUTHOR. It pins the no-op recency hook the implementer must export from
// desktop/main/backend/retrieval/hybrid.ts:
//
//   export function recencyWeight(chunk: unknown): number;
//
// The Knowledge Pack recency logic is OUT of scope for issue #65 (it lands with
// C4/#71); for THIS issue the hook must be provably INERT: it returns EXACTLY
// the number 1 for every input shape — falsy fields, missing fields, weird
// types — without throwing and without reading anything. It must FAIL at the
// base revision (retrieval/hybrid.js does not exist).
import { describe, expect, it } from 'vitest';
import { recencyWeight } from '../../main/backend/retrieval/hybrid.js';

/** Every input shape the hook must survive inertly. */
const INPUTS: unknown[] = [
  undefined,
  null,
  false,
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  42,
  0.5,
  '',
  'chunk',
  '2020-01-01T00:00:00Z',
  Symbol('b7-recency-symbol'),
  BigInt(7),
  [],
  [1, 2, 3],
  ['publishedAt'],
  {},
  Object.create(null),
  Object.freeze({ frozen: true }),
  new Date('2020-06-01T00:00:00Z'),
  new Map([['publishedAt', 'x']]),
  new Set(['publishedAt']),
  () => 'a function',
  { chunkId: 'c1' },
  { text: 'some text' },
  { source: 'docs/a.md' },
  { score: 0.25 },
  { chunkId: 'c1', text: 't', source: 's', score: 1 },
  { publishedAt: '2020-01-01T00:00:00Z' },
  { publishedAt: null },
  { publishedAt: undefined },
  { publishedAt: 0 },
  { publishedAt: 1234567890 },
  { publishedAt: { nested: { deeper: true } } },
  { publishedAt: ['an', 'array'] },
  { pack_id: 'pack-1', supersededAt: null },
  { doc: { path: 'x' }, chunk: { index: 3 }, pack: null },
  { get chunkId() { return 'getter'; } },
  { toString: 7, constructor: 8, valueOf: null },
  new Error('an error object'),
  Promise.resolve('a promise'),
];

describe('b7 C6 (AC6): recencyWeight is inert — exactly 1 for every input shape', () => {
  it('returns the number 1 (strict equality) for every constructed input', () => {
    for (const input of INPUTS) {
      expect(recencyWeight(input)).toBe(1);
    }
  });

  it('returns the number 1 when called with no argument at all', () => {
    expect(recencyWeight()).toBe(1);
  });

  it('returns the number 1 repeatedly (no state, no drift)', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(recencyWeight({ publishedAt: new Date(Date.now() - i * 1000).toISOString() })).toBe(1);
    }
  });
});
