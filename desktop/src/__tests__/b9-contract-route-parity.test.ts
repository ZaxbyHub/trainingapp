// B9 guardrail (issue #67, Phase 4.2): CONTRACT ROUTE PARITY.
//
// Defect class this bites: "a transport capability is declared on one side of
// the contract boundary only". Concretely instantiated twice before this
// guardrail existed:
//   - /status/models existed in NO surface while the renderer needed it
//     (issue #67 C1: 404 at boot);
//   - the desktop route table drifting from the YAML passed every test
//     because nothing compared them at the Node surface (the Python <-> YAML
//     direction is CI's check_contract_drift, which this spec complements).
//
// This spec pins NODE <-> YAML two-way parity: path sets equal in both
// directions and METHOD sets equal per path. The YAML is parsed with a
// minimal indentation-based reader (the contract's structure is regular and
// generated-style; desktop has no YAML dependency by design).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_ROUTES } from '../../main/backend/server';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root discovery via the established contracts marker (b4/b6 convention). */
function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const specPath = path.join(findRepoRoot(THIS_DIR), 'contracts', 'api.openapi.yaml');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** Minimal reader: `  /path:` at indent 2, `    method:` at indent 4. */
function parseSpecPaths(yaml: string): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  let currentPath: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 2 && content.startsWith('/')) {
      currentPath = content.replace(/:.*$/, '');
      paths.set(currentPath, new Set());
      continue;
    }
    if (indent === 4 && currentPath !== null && content.endsWith(':')) {
      const method = content.replace(/:.*$/, '');
      if (HTTP_METHODS.has(method)) paths.get(currentPath)!.add(method.toUpperCase());
    }
  }
  return paths;
}

describe('b9-contract-route-parity: CONTRACT_ROUTES == contracts/api.openapi.yaml', () => {
  const specPaths = parseSpecPaths(readFileSync(specPath, 'utf8'));

  it('the YAML spec parsed and has paths', () => {
    expect(specPaths.size).toBeGreaterThan(0);
  });

  it('every contract path exists in CONTRACT_ROUTES (YAML -> Node)', () => {
    const missingFromNode = [...specPaths.keys()].filter((p) => !CONTRACT_ROUTES.has(p));
    expect(missingFromNode).toEqual([]);
  });

  it('every CONTRACT_ROUTES path exists in the YAML (Node -> YAML)', () => {
    const extraInNode = [...CONTRACT_ROUTES.keys()].filter((p) => !specPaths.has(p));
    expect(extraInNode).toEqual([]);
  });

  it('METHOD sets match exactly per shared path', () => {
    const mismatches: Array<{ path: string; yaml: string[]; node: string[] }> = [];
    for (const [p, nodeRoute] of CONTRACT_ROUTES) {
      const yamlMethods = specPaths.get(p);
      if (yamlMethods === undefined) continue; // covered above
      const nodeMethods = [...nodeRoute].map((m) => m.toUpperCase()).sort();
      const yamlSorted = [...yamlMethods].sort();
      if (JSON.stringify(yamlSorted) !== JSON.stringify(nodeMethods)) {
        mismatches.push({ path: p, yaml: yamlSorted, node: nodeMethods });
      }
    }
    expect(mismatches).toEqual([]);
  });
});
