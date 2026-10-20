/**
 * i173-renderer-freshness.test.ts — issue #173 AC1.
 *
 * `desktop/package.json`'s `build` invokes
 * `scripts/stage-installer-resources.mjs --skip-renderer-copy`, so
 * `copyRenderer()` — and the missing-`web_ui/dist` guard inside it — never ran
 * on the very path that produces the footgun. `build` then succeeded silently
 * and packaged whatever renderer happened to be on disk, possibly one many
 * builds old: a working-looking installer whose UI does not match the tree.
 *
 * Two properties are pinned here, and the second is the one that matters:
 *
 *   1. the check DETECTS a missing/stale renderer, and
 *   2. it is EVALUATED ON EVERY INVOCATION, ahead of the --skip-renderer-copy
 *      branch. A guard that only executes on the path the mistake avoids is not
 *      a guard, and property 1 alone would happily pass against a check wired
 *      back inside copyRenderer().
 *
 * The placement property is pinned by reading the source (property 2 cannot be
 * observed through the return value alone, since the function does not care
 * where it is called from), and the detection property by driving the function
 * against real temp trees with real mtimes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererFreshnessProblem } from '../../scripts/stage-installer-resources.mjs';

const SCRIPT_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'stage-installer-resources.mjs',
);

const HOUR = 60 * 60 * 1000;

interface Tree {
  root: string;
  rendererDir: string;
  webUiDist: string;
}

/** Build a root with a dist and a renderer, stamped `rendererAgeH` and
 *  `distAgeH` hours in the past respectively. */
function makeTree({ rendererAgeH, distAgeH, renderer = true }: { rendererAgeH?: number; distAgeH: number; renderer?: boolean }): Tree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i173-freshness-'));
  const rendererDir = path.join(root, 'desktop', 'renderer');
  const webUiDist = path.join(root, 'web_ui', 'dist');
  fs.mkdirSync(webUiDist, { recursive: true });
  fs.writeFileSync(path.join(webUiDist, 'index.html'), '<html>dist</html>');
  const now = Date.now();
  fs.utimesSync(path.join(webUiDist, 'index.html'), new Date(now - distAgeH * HOUR), new Date(now - distAgeH * HOUR));
  if (renderer) {
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, 'index.html'), '<html>renderer</html>');
    fs.utimesSync(
      path.join(rendererDir, 'index.html'),
      new Date(now - (rendererAgeH ?? 0) * HOUR),
      new Date(now - (rendererAgeH ?? 0) * HOUR),
    );
  }
  return { root, rendererDir, webUiDist };
}

function clean(tree: Tree): void {
  fs.rmSync(tree.root, { recursive: true, force: true });
}

describe('rendererFreshnessProblem — detection (issue #173 AC1)', () => {
  it('refuses when --skip-renderer-copy is passed and the renderer does not exist', () => {
    const tree = makeTree({ renderer: false, distAgeH: 1 });
    try {
      const problem = rendererFreshnessProblem({
        skipRendererCopy: true,
        rendererDir: tree.rendererDir,
        webUiDist: tree.webUiDist,
        repoRoot: tree.root,
      });
      expect(problem).not.toBeNull();
      expect(problem).toContain('does not exist');
      expect(problem).toContain('no renderer at all');
    } finally {
      clean(tree);
    }
  });

  it('refuses a STALE renderer: present, but dist holds a newer file', () => {
    // The dangerous half. Detecting mere absence would wave this through, and it
    // ships an installer that looks fine and does not match the tree.
    const tree = makeTree({ rendererAgeH: 10, distAgeH: 1 });
    try {
      const problem = rendererFreshnessProblem({
        skipRendererCopy: true,
        rendererDir: tree.rendererDir,
        webUiDist: tree.webUiDist,
        repoRoot: tree.root,
      });
      expect(problem).not.toBeNull();
      expect(problem).toContain('STALE');
      expect(problem).toContain('desktop\\renderer'.replace('\\', path.sep));
    } finally {
      clean(tree);
    }
  });

  it('allows a renderer NEWER than the dist', () => {
    const tree = makeTree({ rendererAgeH: 1, distAgeH: 10 });
    try {
      expect(
        rendererFreshnessProblem({
          skipRendererCopy: true,
          rendererDir: tree.rendererDir,
          webUiDist: tree.webUiDist,
          repoRoot: tree.root,
        }),
      ).toBeNull();
    } finally {
      clean(tree);
    }
  });

  it('allows a FRESH renderer (no file in dist newer than the renderer)', () => {
    // Not vacuous: the stale case above uses the same shape with one number
    // swapped, so the guard keys on the comparison and not on "a renderer
    // exists".
    const tree = makeTree({ rendererAgeH: 1, distAgeH: 1 });
    try {
      expect(
        rendererFreshnessProblem({
          skipRendererCopy: true,
          rendererDir: tree.rendererDir,
          webUiDist: tree.webUiDist,
          repoRoot: tree.root,
        }),
      ).toBeNull();
    } finally {
      clean(tree);
    }
  });

  it('returns null when there is no web_ui/dist to compare against', () => {
    // A machine that only ever builds the desktop bundle must not be forced
    // into a web_ui build it has no reason to run.
    const tree = makeTree({ rendererAgeH: 1, distAgeH: 1 });
    try {
      fs.rmSync(tree.webUiDist, { recursive: true, force: true });
      expect(
        rendererFreshnessProblem({
          skipRendererCopy: true,
          rendererDir: tree.rendererDir,
          webUiDist: tree.webUiDist,
          repoRoot: tree.root,
        }),
      ).toBeNull();
    } finally {
      clean(tree);
    }
  });

  it('reports nothing when the copy will actually happen', () => {
    // copyRenderer() recreates the renderer wholesale, so absence and staleness
    // are both about to be resolved. A missing renderer must NOT fail here.
    const tree = makeTree({ renderer: false, distAgeH: 1 });
    try {
      expect(
        rendererFreshnessProblem({
          skipRendererCopy: false,
          rendererDir: tree.rendererDir,
          webUiDist: tree.webUiDist,
          repoRoot: tree.root,
        }),
      ).toBeNull();
    } finally {
      clean(tree);
    }
  });

  it('ignores dist/models/ when judging freshness', () => {
    // copyRenderer() excludes staged weight dirs, so a multi-GB model tree must
    // not be able to make the renderer look stale (nor make the walk slow).
    const tree = makeTree({ rendererAgeH: 1, distAgeH: 1 });
    try {
      const models = path.join(tree.webUiDist, 'models');
      fs.mkdirSync(models, { recursive: true });
      const blob = path.join(models, 'model.onnx');
      fs.writeFileSync(blob, 'weights');
      const future = new Date(Date.now());
      fs.utimesSync(blob, future, future);
      expect(
        rendererFreshnessProblem({
          skipRendererCopy: true,
          rendererDir: tree.rendererDir,
          webUiDist: tree.webUiDist,
          repoRoot: tree.root,
        }),
      ).toBeNull();
    } finally {
      clean(tree);
    }
  });
});

describe('the freshness check is wired AHEAD of the skip branch (issue #173 AC1)', () => {
  const source = fs.readFileSync(SCRIPT_SRC, 'utf8');

  it('package.json `build` really does pass --skip-renderer-copy (the premise)', () => {
    // If this ever stops being true the whole issue is moot, so the premise is
    // pinned rather than assumed.
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(SCRIPT_SRC), '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toContain('--skip-renderer-copy');
    expect(pkg.scripts['desktop:build']).not.toContain('--skip-renderer-copy');
  });

  it('is called before `if (!args.skipRendererCopy) copyRenderer()`', () => {
    const call = source.indexOf('rendererFreshnessProblem({');
    const branch = source.indexOf('if (!args.skipRendererCopy) copyRenderer();');
    expect(call, 'the freshness check must be called from the staging path').toBeGreaterThan(-1);
    expect(branch, 'the skip branch must still exist').toBeGreaterThan(-1);
    expect(call, 'the freshness check must precede the skip branch').toBeLessThan(branch);
  });

  it('the existing missing-dist guard is still inside copyRenderer(), not the only guard', () => {
    // Belt and braces are fine; the point is that the freshness check is NOT
    // solely inside the skipped branch.
    const fnStart = source.indexOf('function copyRenderer()');
    const guard = source.indexOf('web_ui/dist is missing', fnStart);
    expect(guard).toBeGreaterThan(fnStart);
  });

  it('is NOT only reachable from inside copyRenderer()', () => {
    // The regression this pins: someone "simplifying" by moving the check into
    // the copy path would leave every detection test above still green.
    const fnStart = source.indexOf('function copyRenderer()');
    const fnEnd = source.indexOf('\nfunction ', fnStart + 10);
    const body = source.slice(fnStart, fnEnd === -1 ? source.length : fnEnd);
    expect(body).not.toContain('rendererFreshnessProblem');
  });
});
