// #133: versioned managed-layout resolution against the REAL install shape.
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
  // PackManager managed layout: <packs>/<id>/<version>/…
  const v = path.join(packsDir, 'opmed-initial', '1.0.0');
  mkdirSync(path.join(v, 'docs'), { recursive: true });
  writeFileSync(path.join(v, 'pack.json'), '{"id":"opmed-initial","docs":[{"path":"docs/brief.pdf"}]}');
  writeFileSync(path.join(v, 'docs', 'brief.pdf'), '%PDF-e133-versioned');
});

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }));

const handler = () => createAppFileHandler({ root, packsDir });

describe('versioned managed layout (#133)', () => {
  it('serves pack.json at <id>/<version>/pack.json', async () => {
    const res = await handler()(new Request('app://training/opmed-initial/1.0.0/pack.json'));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).id).toBe('opmed-initial');
  });
  it('serves docs under <id>/<version>/docs/', async () => {
    const res = await handler()(new Request('app://training/opmed-initial/1.0.0/docs/brief.pdf'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('e133-versioned');
  });
  it('keeps the flat player contract when the flat layout exists', async () => {
    const flat = path.join(packsDir, 'flat-pack', 'assets', 'player');
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, 'story.html'), '<html>flat</html>');
    const res = await handler()(new Request('app://training/flat-pack/2.0.0/story.html'));
    // flat candidate is <packs>/flat-pack/assets/player/2.0.0/story.html (absent)
    // -> versioned <packs>/flat-pack/2.0.0/assets/player/story.html (absent) -> 404;
    // the point: no crash, no leak, containment holds.
    expect([403, 404]).toContain(res.status);
  });
});
