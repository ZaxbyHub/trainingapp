// #133: versioned managed-layout resolution for the PLAYER route (PackManager
// installs <packs>/<id>/<version>/assets/player/…). Flat layout (packtool zip
// output / frozen d5 contract) stays authoritative when both exist.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppFileHandler } from '../../main/protocol';

let root = '';
let packsDir = '';

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'e133-versioned-'));
  root = path.join(base, 'renderer-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<html></html>');
  packsDir = path.join(base, 'packs');
  // PackManager managed layout: <packs>/<id>/<version>/assets/player/…
  const v = path.join(packsDir, 'opmed-course', '1.0.0', 'assets', 'player');
  mkdirSync(v, { recursive: true });
  writeFileSync(path.join(v, 'story.html'), '<html>e133-versioned-story</html>');
  writeFileSync(path.join(packsDir, 'secret.txt'), 'TOP-SECRET-OUTSIDE-PACK');
});

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }));

const handler = () => createAppFileHandler({ root, packsDir });

describe('versioned managed layout for the player route (#133)', () => {
  it('serves story.html at training/<id>/<version>/story.html', async () => {
    const res = await handler()(new Request('app://training/opmed-course/1.0.0/story.html'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('e133-versioned-story');
  });

  it('keeps the flat layout authoritative when it exists (frozen d5 contract)', async () => {
    const flat = path.join(packsDir, 'flat-pack', 'assets', 'player');
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, 'story.html'), '<html>FLAT-WINS</html>');
    const versioned = path.join(packsDir, 'flat-pack', '2.0.0', 'assets', 'player');
    mkdirSync(versioned, { recursive: true });
    writeFileSync(path.join(versioned, 'story.html'), '<html>VERSIONED-LOSES</html>');
    // Flat candidate for <id>/<rest…> is assets/player/2.0.0/story.html
    // (absent) — but the d5 flat form <id>/story.html must still win:
    const d5 = await handler()(new Request('app://training/flat-pack/story.html'));
    expect(d5.status).toBe(200);
    expect(await d5.text()).toContain('FLAT-WINS');
  });

  it('refuses traversal through the version segment (no content leak)', async () => {
    const escape = await handler()(
      new Request('app://training/opmed-course/1.0.0/%2e%2e/%2e%2e/secret.txt'),
    );
    expect([403, 404]).toContain(escape.status);
    expect(await escape.text()).not.toContain('TOP-SECRET');
  });
});
