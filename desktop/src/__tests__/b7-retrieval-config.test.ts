// b7-retrieval-config.test.ts — FROZEN ACCEPTANCE SPEC (issue #65 trace, AC2 / check C2).
//
// This file is a frozen acceptance spec authored by the issue-tracer v3 CHECK
// AUTHOR. It pins the retrieval configuration module the implementer must
// provide at desktop/main/backend/retrieval/config.ts, mirroring the frozen
// defaults + env resolution pattern of desktop/main/backend/ingest/config.ts.
// It must FAIL at the base revision (module does not exist).
//
// FROZEN PRODUCTION CONTRACT (module desktop/main/backend/retrieval/config.ts):
//
//   export interface RetrievalConfig {
//     topK: number;               // retrieval.topK, default 10
//     candidateMultiplier: number;// retrieval.candidateMultiplier, default 3
//     rerank: boolean;            // retrieval.rerank, default true
//     rrfK: number;               // retrieval.rrfK, default 60
//     relevanceFloor: number;     // retrieval.relevanceFloor, CALIBRATED value (not 0.2)
//   }
//   export const DEFAULT_RETRIEVAL_CONFIG: Readonly<RetrievalConfig>;  // Object.freeze'd
//   export function resolveRetrievalConfig(env?: Record<string, string | undefined>): RetrievalConfig;
//   export const RETRIEVAL_TOPK_ENV = 'TRAININGAPP_RETRIEVAL_TOPK';
//   export const RETRIEVAL_CANDIDATE_MULTIPLIER_ENV = 'TRAININGAPP_RETRIEVAL_CANDIDATE_MULTIPLIER';
//   export const RETRIEVAL_RERANK_ENV = 'TRAININGAPP_RETRIEVAL_RERANK';
//   export const RETRIEVAL_RRF_K_ENV = 'TRAININGAPP_RETRIEVAL_RRF_K';
//   export const RETRIEVAL_RELEVANCE_FLOOR_ENV = 'TRAININGAPP_RETRIEVAL_RELEVANCE_FLOOR';
//
// Env parsing rules frozen here:
//   - topK / candidateMultiplier / rrfK: positive integers only ('25' ok;
//     'abc', '0', '-3', '2.5', '' all fall back to that key's default).
//   - rerank: 'true'/'1' -> true, 'false'/'0' -> false, anything else -> default (true).
//   - relevanceFloor: a finite float in [0, 1) ('0.42' ok; 'abc', '-0.1', '1.5' -> default).
//   - Cross-field sanity ALWAYS holds on the resolved config: topK >= 1,
//     candidateMultiplier >= 1, rrfK >= 1, 0 <= relevanceFloor < 1.
//
// The calibrated floor must be RECORDED in docs/adr/0007-relevance-floor-calibration.md
// as a line of the exact form `floor: <float>` (first such line wins), together
// with a `## Procedure` section; the recorded number must equal
// DEFAULT_RETRIEVAL_CONFIG.relevanceFloor exactly and must NOT be 0.2 (the
// browser's un-revalidated value, web_ui rag-orchestrator.ts MIN_CROSS_SCORE).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RETRIEVAL_CONFIG,
  RETRIEVAL_CANDIDATE_MULTIPLIER_ENV,
  RETRIEVAL_RERANK_ENV,
  RETRIEVAL_RRF_K_ENV,
  RETRIEVAL_RELEVANCE_FLOOR_ENV,
  RETRIEVAL_TOPK_ENV,
  resolveRetrievalConfig,
} from '../../main/backend/retrieval/config.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root discovery via the established contracts marker. */
function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const ADR_PATH = path.join(REPO_ROOT, 'docs', 'adr', '0007-relevance-floor-calibration.md');

describe('b7 C2 (AC2): resolveRetrievalConfig frozen defaults', () => {
  it('defaults: topK=10, candidateMultiplier=3, rerank=true, rrfK=60', () => {
    const config = resolveRetrievalConfig({});
    expect(config.topK).toBe(10);
    expect(config.candidateMultiplier).toBe(3);
    expect(config.rerank).toBe(true);
    expect(config.rrfK).toBe(60);
    // The frozen-defaults pattern (mirrors ingest/config.ts DEFAULT_INGEST_CONFIG).
    expect(DEFAULT_RETRIEVAL_CONFIG.topK).toBe(10);
    expect(DEFAULT_RETRIEVAL_CONFIG.candidateMultiplier).toBe(3);
    expect(DEFAULT_RETRIEVAL_CONFIG.rerank).toBe(true);
    expect(DEFAULT_RETRIEVAL_CONFIG.rrfK).toBe(60);
    expect(Object.isFrozen(DEFAULT_RETRIEVAL_CONFIG)).toBe(true);
  });

  it('the env-var names are exactly the documented TRAININGAPP_RETRIEVAL_* keys', () => {
    expect(RETRIEVAL_TOPK_ENV).toBe('TRAININGAPP_RETRIEVAL_TOPK');
    expect(RETRIEVAL_CANDIDATE_MULTIPLIER_ENV).toBe('TRAININGAPP_RETRIEVAL_CANDIDATE_MULTIPLIER');
    expect(RETRIEVAL_RERANK_ENV).toBe('TRAININGAPP_RETRIEVAL_RERANK');
    expect(RETRIEVAL_RRF_K_ENV).toBe('TRAININGAPP_RETRIEVAL_RRF_K');
    expect(RETRIEVAL_RELEVANCE_FLOOR_ENV).toBe('TRAININGAPP_RETRIEVAL_RELEVANCE_FLOOR');
  });
});

describe('b7 C2 (AC2): the calibrated relevance floor (distinct from the browser 0.2)', () => {
  it('the default floor is a number in [0, 1) and is NOT 0.2', () => {
    const floor = DEFAULT_RETRIEVAL_CONFIG.relevanceFloor;
    expect(typeof floor).toBe('number');
    expect(Number.isFinite(floor)).toBe(true);
    expect(floor).toBeGreaterThanOrEqual(0);
    expect(floor).toBeLessThan(1);
    expect(floor).not.toBe(0.2);
    expect(resolveRetrievalConfig({}).relevanceFloor).toBe(floor);
  });

  it('docs/adr/0007-relevance-floor-calibration.md records the same value plus a Procedure section', () => {
    expect(fs.existsSync(ADR_PATH)).toBe(true);
    const contents = fs.readFileSync(ADR_PATH, 'utf8');
    expect(contents).toContain('## Procedure');
    const match = contents.match(/^floor:[ \t]*([0-9]*\.?[0-9]+)[ \t]*$/m);
    expect(match).not.toBeNull();
    const documented = Number.parseFloat(match?.[1] ?? '');
    expect(Number.isFinite(documented)).toBe(true);
    expect(documented).not.toBe(0.2);
    // The ADR number and the shipped default are the SAME double.
    expect(documented).toBe(DEFAULT_RETRIEVAL_CONFIG.relevanceFloor);
  });
});

describe('b7 C2 (AC2): env overrides', () => {
  it('valid values override every key', () => {
    expect(resolveRetrievalConfig({ [RETRIEVAL_TOPK_ENV]: '25' }).topK).toBe(25);
    expect(resolveRetrievalConfig({ [RETRIEVAL_CANDIDATE_MULTIPLIER_ENV]: '7' }).candidateMultiplier).toBe(7);
    expect(resolveRetrievalConfig({ [RETRIEVAL_RRF_K_ENV]: '17' }).rrfK).toBe(17);
    expect(resolveRetrievalConfig({ [RETRIEVAL_RELEVANCE_FLOOR_ENV]: '0.42' }).relevanceFloor).toBe(0.42);
    expect(resolveRetrievalConfig({ [RETRIEVAL_RERANK_ENV]: 'false' }).rerank).toBe(false);
    expect(resolveRetrievalConfig({ [RETRIEVAL_RERANK_ENV]: '0' }).rerank).toBe(false);
    expect(resolveRetrievalConfig({ [RETRIEVAL_RERANK_ENV]: 'true' }).rerank).toBe(true);
    expect(resolveRetrievalConfig({ [RETRIEVAL_RERANK_ENV]: '1' }).rerank).toBe(true);
    // Non-overridden keys keep their defaults in the same resolution.
    const both = resolveRetrievalConfig({ [RETRIEVAL_TOPK_ENV]: '5', [RETRIEVAL_RRF_K_ENV]: '9' });
    expect(both).toMatchObject({ topK: 5, rrfK: 9, candidateMultiplier: 3, rerank: true });
  });

  it('invalid values fall back to that key default (never NaN, never throw)', () => {
    for (const bad of ['abc', '0', '-3', '2.5', '', ' 8', 'null']) {
      expect(resolveRetrievalConfig({ [RETRIEVAL_TOPK_ENV]: bad }).topK).toBe(10);
      expect(resolveRetrievalConfig({ [RETRIEVAL_CANDIDATE_MULTIPLIER_ENV]: bad }).candidateMultiplier).toBe(3);
      expect(resolveRetrievalConfig({ [RETRIEVAL_RRF_K_ENV]: bad }).rrfK).toBe(60);
    }
    for (const bad of ['yes', 'maybe', '', 'TRUE?', 'on']) {
      expect(resolveRetrievalConfig({ [RETRIEVAL_RERANK_ENV]: bad }).rerank).toBe(true);
    }
    for (const bad of ['abc', '-0.1', '1.5', '2', '', 'zero']) {
      expect(resolveRetrievalConfig({ [RETRIEVAL_RELEVANCE_FLOOR_ENV]: bad }).relevanceFloor).toBe(
        DEFAULT_RETRIEVAL_CONFIG.relevanceFloor,
      );
    }
  });

  it('cross-field sanity holds under adversarial env combinations', () => {
    const adversarial = [
      { [RETRIEVAL_TOPK_ENV]: '0', [RETRIEVAL_CANDIDATE_MULTIPLIER_ENV]: '0', [RETRIEVAL_RRF_K_ENV]: '-1' },
      { [RETRIEVAL_TOPK_ENV]: '-999999', [RETRIEVAL_CANDIDATE_MULTIPLIER_ENV]: 'abc' },
      { [RETRIEVAL_TOPK_ENV]: '3.5', [RETRIEVAL_CANDIDATE_MULTIPLIER_ENV]: '2.5' },
      { [RETRIEVAL_RELEVANCE_FLOOR_ENV]: '7', [RETRIEVAL_RRF_K_ENV]: '0' },
    ];
    for (const env of adversarial) {
      const config = resolveRetrievalConfig(env);
      expect(config.topK).toBeGreaterThanOrEqual(1);
      expect(config.candidateMultiplier).toBeGreaterThanOrEqual(1);
      expect(config.rrfK).toBeGreaterThanOrEqual(1);
      expect(config.relevanceFloor).toBeGreaterThanOrEqual(0);
      expect(config.relevanceFloor).toBeLessThan(1);
      expect(typeof config.rerank).toBe('boolean');
    }
  });

  it('resolveRetrievalConfig() with no argument reads process.env without crashing', () => {
    const config = resolveRetrievalConfig();
    expect(config.topK).toBeGreaterThanOrEqual(1);
    expect(config.candidateMultiplier).toBeGreaterThanOrEqual(1);
    expect(config.rrfK).toBeGreaterThanOrEqual(1);
  });
});
