// schema-substitution.test.ts — issue #100 defect class 4 pin for packtool.
//
// packtool's local loadSchemaSql (build/index-writer.ts) carried an
// unreachable token-mismatch guard byte-identical to the desktop store's
// (split/join removes every occurrence before the includes check could fire);
// both were deleted together. This test pins the substitution itself:
// every __EMBEDDING_DIMS__ occurrence (vec0 width + meta seed) is replaced.
import { describe, expect, it } from 'vitest';
import { loadSchemaSql, findRepoRoot } from '../../build/index-writer';

describe('packtool loadSchemaSql substitution (issue #100 class 4)', () => {
  it('replaces every __EMBEDDING_DIMS__ occurrence with the requested dims', () => {
    const repoRoot = findRepoRoot(process.cwd());
    expect(repoRoot, 'repo root with contracts/store.schema.sql not found').toBeDefined();
    const sql = loadSchemaSql(repoRoot as string, 8);
    expect(sql).not.toContain('__EMBEDDING_DIMS__');
    // Both DDL-body occurrences: the vec0 width and the meta embedding_dims seed.
    expect(sql).toContain('float[8]');
    expect(sql).toContain(`('embedding_dims', '8')`);
  });
});
