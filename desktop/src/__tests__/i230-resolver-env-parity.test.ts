// i230-resolver-env-parity.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #232 residual (b) — sub-defect (b) of PR #230’s host lifecycle
// work; reranker/embedder env-injection parity).
//
// AC (DISCRIMINATING): WHEN the host injects a PARTIAL env record into
// resolveRerankerModelDir (naming only TRAININGAPP_DESKTOP_REPO_ROOT), THEN
// THE SYSTEM SHALL keep the ambient TRAININGAPP_RERANKER_MODEL_DIR pin —
// per-key merge over ambient, the same seamEnvRecord contract
// ingest/embed-threads.ts already gives resolveEmbedder (review PRR-011
// parity) — so the resolver still returns the ambient-pinned model dir.
// RED at base, GREEN after the fix.
//
// At base resolveRerankerModelDir does a whole-record substitution
// (`const env = opts.env ?? process.env`), so the partial record drops the
// ambient pin: with the ambient key gone the resolver falls through to its
// later candidates instead of the pinned dir. The embedder keeps ambient
// pins in exactly this situation (resolveEmbedder resolves via
// seamEnvRecord(opts.env)), which is the parity gap this spec pins.
//
// Fixture idiom (e1-manifest-contract.test.ts / i103-degrade-assertions):
// a staged reranker model dir is valid when onnx/model_quantized.onnx (or
// onnx/model.onnx) is at least RERANKER_WEIGHTS_MIN_BYTES — a zero-filled
// temp file of exactly that size satisfies isValidModelDir deterministically
// on every machine. No mocks, no module graph surgery: the resolver is pure
// fs/env.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RERANKER_MODEL_DIR_ENV,
  RERANKER_WEIGHTS_MIN_BYTES,
  resolveRerankerModelDir,
} from '../../main/backend/retrieval/reranker.js';

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('issue 230 reranker resolver env-injection parity with the embedder', () => {
  it(
    'partial-record-keeps-ambient-pin when the host injects only TRAININGAPP_DESKTOP_REPO_ROOT',
    () => {
      // A VALID ambient reranker model dir: onnx/model_quantized.onnx at
      // exactly the weights floor (isValidModelDir is >=).
      const ambientDir = makeTempDir('i230-rerank-ambient-');
      fs.mkdirSync(path.join(ambientDir, 'onnx'), { recursive: true });
      fs.writeFileSync(
        path.join(ambientDir, 'onnx', 'model_quantized.onnx'),
        Buffer.alloc(RERANKER_WEIGHTS_MIN_BYTES),
      );

      // The injected partial record names only the repo root; its value points
      // at a root with NOTHING staged, so it can never win as a candidate —
      // the record's purpose here is solely to be partial.
      const repoRoot = makeTempDir('i230-empty-repo-root-');

      const saved = process.env[RERANKER_MODEL_DIR_ENV];
      try {
        // Seed the ambient pin the same way the ambient seam reads it.
        process.env[RERANKER_MODEL_DIR_ENV] = ambientDir;

        // ANTI-VACUITY GUARD: with NO injection the ambient pin resolves —
        // proving the fixture dir is valid and the ambient seam is live.
        expect(
          resolveRerankerModelDir({}),
          'harness sanity: the ambient pin resolves when nothing is injected',
        ).toBe(ambientDir);

        // THE DISCRIMINATING CALL: a PARTIAL injected record (the exact host
        // shape that names only TRAININGAPP_DESKTOP_REPO_ROOT) must not drop
        // the ambient TRAININGAPP_RERANKER_MODEL_DIR pin.
        const resolved = resolveRerankerModelDir({
          env: { TRAININGAPP_DESKTOP_REPO_ROOT: repoRoot },
        });
        expect(resolved).toBe(ambientDir);
      } finally {
        if (saved === undefined) delete process.env[RERANKER_MODEL_DIR_ENV];
        else process.env[RERANKER_MODEL_DIR_ENV] = saved;
      }
    },
  );

  it('injected-pin-wins when the injected record names a valid absolute model dir', () => {
    const staged = makeTempDir('i230-rerank-injected-');
    fs.mkdirSync(path.join(staged, 'onnx'), { recursive: true });
    fs.writeFileSync(
      path.join(staged, 'onnx', 'model_quantized.onnx'),
      Buffer.alloc(RERANKER_WEIGHTS_MIN_BYTES),
    );
    const saved = process.env[RERANKER_MODEL_DIR_ENV];
    try {
      process.env[RERANKER_MODEL_DIR_ENV] = makeTempDir('i230-rerank-ambient-unused-');
      // The injected record names a VALID model dir explicitly: it must win
      // over the ambient pin (injected strings win per key — the merge is
      // not ambient-preferring).
      expect(
        resolveRerankerModelDir({ env: { TRAININGAPP_RERANKER_MODEL_DIR: staged } }),
        'an explicitly injected absolute pin wins over ambient',
      ).toBe(staged);
    } finally {
      if (saved === undefined) delete process.env[RERANKER_MODEL_DIR_ENV];
      else process.env[RERANKER_MODEL_DIR_ENV] = saved;
    }
  });

  it('injected-pin-containment: a CWD-relative explicit pin is skipped, not resolved against process.cwd', () => {
    const relativePin = path.join('models', 'reranker');
    const saved = process.env[RERANKER_MODEL_DIR_ENV];
    delete process.env[RERANKER_MODEL_DIR_ENV];
    try {
      // issue #232 Scope-In: an explicit value is honored only when
      // ABSOLUTE. A CWD-relative value must be SKIPPED — never resolved
      // against whatever directory the host started in — even though the
      // per-key merge placed it in the merged record (shadowing any ambient
      // pin for that key). No other candidate is staged in this bare-env
      // fixture, so containment means the resolver degrades to null rather
      // than returning the relative path.
      const resolved = resolveRerankerModelDir({
        env: { TRAININGAPP_RERANKER_MODEL_DIR: relativePin },
      });
      expect(resolved, 'a CWD-relative explicit pin must never be returned').not.toBe(relativePin);
      expect(
        resolved === null || path.isAbsolute(resolved),
        'the resolver degrades to null (or an absolute candidate), never a relative dir',
      ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[RERANKER_MODEL_DIR_ENV];
      else process.env[RERANKER_MODEL_DIR_ENV] = saved;
    }
  });
});
