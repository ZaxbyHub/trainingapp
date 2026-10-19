// embed-constants-parity.test.ts — issue #212 (batch
// batch-143-203-204-212-213-215): the embedding-pipeline identity constants
// and the HashEmbedder fixture are duplicated across a package boundary that
// cannot share source (see pack-archive-rules.ts's twin-file note). These
// pins make the duplication executable: every definition site of each
// constant family must agree, and both HashEmbedder twins must derive
// identical vectors — the two packages cannot silently diverge on model
// identity, weight-file detection, or embedding width.
//
// Non-exported copies (STAGED_WEIGHTS_MIN_BYTES in both embedders) are
// source-parsed and evaluated numerically (they are expression-valued:
// `10 * 1024 * 1024`); the tests/test_retrieval_eval_parity.py mirror is
// evaluated the same way. The web_ui twin copy of the archive rules stays
// owned by the existing byte-twin pins (pack-archive-rules-drift.test.ts /
// desktop-twin-drift.test.ts) — scope boundary, not coverage.
//
// Named mutants: change packtool's DEFAULT_EMBEDDING_DIMS 384 to 768 (or any
// one site's value) -> constants-twin-parity red; change one HashEmbedder's
// digest mix -> hashembedder-twin red.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EMBEDDING_MODEL_SUBPATH as DESKTOP_MODEL_SUBPATH,
  ONNX_MODEL_SUBPATH as DESKTOP_ONNX_SUBPATH,
  HashEmbedder as DesktopHashEmbedder,
} from '../../main/backend/ingest/embedder.js';
import { DEFAULT_EMBEDDING_DIMS as STORE_DIMS } from '../../main/backend/store/sqlite-store.js';
import { RERANKER_WEIGHTS_MIN_BYTES } from '../../main/backend/retrieval/reranker.js';
import {
  DEFAULT_EMBEDDING_MODEL_SUBPATH as PACKTOOL_MODEL_SUBPATH,
  ONNX_MODEL_SUBPATH as PACKTOOL_ONNX_SUBPATH,
  DEFAULT_EMBEDDING_DIMS as PACKTOOL_DIMS,
  HashEmbedder as PacktoolHashEmbedder,
} from '../../../packtool/build/embedder.js';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    // Review PRR-024/UCR-04: stop at the checkout root — a marker-less
    // checkout must fail closed, never bind a foreign ancestor's marker.
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

const DESKTOP_EMBEDDER_SRC = path.join(REPO_ROOT, 'desktop', 'main', 'backend', 'ingest', 'embedder.ts');
const PACKTOOL_EMBEDDER_SRC = path.join(REPO_ROOT, 'packtool', 'build', 'embedder.ts');
const PY_PARITY_SRC = path.join(REPO_ROOT, 'tests', 'test_retrieval_eval_parity.py');

/**
 * Numeric value of a top-level `const NAME = <expr>;` declaration. The
 * expression grammar is digits, whitespace, `*`, `+`, `(`, `)` only (every
 * real copy is `10 * 1024 * 1024`), so evaluating it is safe — and a copy
 * that changes to any other shape fails loudly here instead of silently
 * skipping the comparison. EVERY definition of the name in the file must
 * agree (review PRR-025): a first-occurrence-only read would let a second
 * definition site diverge invisibly.
 */
function numericConst(sourcePath: string, name: string): number {
  const source = fs.readFileSync(sourcePath, 'utf8');
  // Accepts TS `const NAME = <expr>;` and the python mirror's bare
  // `NAME = <expr>` assignment (anchored at line start either way).
  const matches = [
    ...source.matchAll(new RegExp(`^(?:(?:const|let|var)\\s+)?${name}\\s*=\\s*([^;\\n]+)`, 'gm')),
  ];
  if (matches.length === 0) {
    throw new Error(`${name} not found in ${sourcePath}`);
  }
  const values = matches.map((m) => {
    const expr = m[1].trim();
    if (!/^[0-9\s*+()]+$/.test(expr)) {
      throw new Error(`${name} in ${sourcePath} is not a plain numeric expression: ${expr}`);
    }
    // eslint-disable-next-line no-new-func
    return Number(new Function(`return (${expr});`)());
  });
  const first = values[0];
  for (const v of values) {
    if (v !== first) {
      throw new Error(`${name} in ${sourcePath} has divergent definitions: ${values.join(',')}`);
    }
  }
  return first;
}

describe('embed constants parity (issue #212)', () => {
  it('constants-twin-parity: every definition site of each constant family agrees', () => {
    // Model identity (two exported sites).
    expect(DESKTOP_MODEL_SUBPATH, 'DEFAULT_EMBEDDING_MODEL_SUBPATH twins').toBe(PACKTOOL_MODEL_SUBPATH);
    expect(DESKTOP_ONNX_SUBPATH, 'ONNX_MODEL_SUBPATH twins').toBe(PACKTOOL_ONNX_SUBPATH);

    // Embedding width (sqlite-store + packtool embedder + HashEmbedder defaults).
    expect(STORE_DIMS, 'DEFAULT_EMBEDDING_DIMS: sqlite-store vs packtool').toBe(PACKTOOL_DIMS);

    // Weights floor family: both embedder copies (source-parsed, expression
    // valued), the python parity-probe mirror, and the reranker sibling.
    const stagedDesktop = numericConst(DESKTOP_EMBEDDER_SRC, 'STAGED_WEIGHTS_MIN_BYTES');
    const stagedPacktool = numericConst(PACKTOOL_EMBEDDER_SRC, 'STAGED_WEIGHTS_MIN_BYTES');
    const stagedPy = numericConst(PY_PARITY_SRC, 'WEIGHTS_MIN_BYTES');
    expect(stagedPacktool, 'STAGED_WEIGHTS_MIN_BYTES twins').toBe(stagedDesktop);
    expect(stagedPy, 'the python parity probe mirrors the weights floor').toBe(stagedDesktop);
    expect(RERANKER_WEIGHTS_MIN_BYTES, 'the reranker weights floor joins the family').toBe(stagedDesktop);
  });

  it('hashembedder-twin: both HashEmbedder implementations derive identical vectors', async () => {
    const texts = ['', 'a', 'hello world', 'trainingapp 混合 test\nline2', 'x'.repeat(1024)];
    for (const text of texts) {
      const [desktop] = await new DesktopHashEmbedder({ dims: 384 }).embed([text]);
      const [packtool] = await new PacktoolHashEmbedder({ dims: 384 }).embed([text]);
      expect(packtool, `vector parity for ${JSON.stringify(text.slice(0, 24))}`).toEqual(desktop);
      expect(desktop).toHaveLength(384);
    }
    // The un-parameterized default width also agrees with the dims family.
    const [defaulted] = await new DesktopHashEmbedder().embed(['width probe']);
    expect(defaulted).toHaveLength(STORE_DIMS);
    const [packtoolDefaulted] = await new PacktoolHashEmbedder().embed(['width probe']);
    expect(packtoolDefaulted).toEqual(defaulted);
  });
});
