// @vitest-environment node
/**
 * The app-side byte relay (trace browser-training-parity AC3/AC11). All
 * player-origin enforcement lives here: the shared containment vectors
 * (contracts/training-path-vectors.json, also run against the desktop app://
 * handler), app-state scoping to the open pack, Range 206/416, size-bounded
 * reads inside the opened range, handle lifetime, rate bounding, headers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_RELAY_READ_BYTES,
  RELAY_RATE_LIMIT,
  TrainingRelay,
  buildBrowserTrainingCsp,
  mimeTypeFor,
  parseRange,
  resolveTrainingPath,
  type RelayOpenResponse,
  type RelayReadResponse,
} from '../training-relay';

const VECTORS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'contracts', 'training-path-vectors.json'), 'utf8'),
) as { pack_id: string; files: string[]; vectors: Array<{ id: string; path: string; status: number }> };

const APP = 'http://localhost:4183';

function relayWith(files: Record<string, string>, packId = VECTORS.pack_id, opts: { now?: () => number } = {}) {
  const reads: string[] = [];
  const relay = new TrainingRelay({
    appOrigin: APP,
    readActiveFile: async (id, segments) => {
      reads.push(`${id}:${segments.join('/')}`);
      if (id !== packId) return null;
      const body = files[segments.join('/')];
      return body === undefined ? null : new Blob([body]);
    },
    ...opts,
  });
  return { relay, reads };
}

const open = async (relay: TrainingRelay, p: string, range: string | null = null, id = 1): Promise<RelayOpenResponse> =>
  (await relay.handleRequest({ type: 'open', id, path: p, method: 'GET', range })) as RelayOpenResponse;
const read = async (relay: TrainingRelay, handle: number, offset: number, length: number, id = 2): Promise<RelayReadResponse> =>
  (await relay.handleRequest({ type: 'read', id, handle, offset, length })) as RelayReadResponse;

describe('shared containment vectors (desktop resolveTrainingRequest parity)', () => {
  const files = Object.fromEntries(VECTORS.files.map((f) => [f, `content of ${f}`]));
  it.each(VECTORS.vectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const { relay } = relayWith(files);
    relay.setOpenPack(VECTORS.pack_id);
    const result = await open(relay, `/training${vector.path}`);
    expect(result.status).toBe(vector.status);
  });
});

describe('TrainingRelay scoping and serving', () => {
  const FILES = { 'story.html': '<html>course</html>', 'media/a.mp3': '0123456789' };

  it('serves nothing until a pack is open, and only the open pack', async () => {
    const { relay, reads } = relayWith(FILES);
    expect((await open(relay, '/training/pack-a/story.html')).status).toBe(404);
    relay.setOpenPack('pack-b');
    expect((await open(relay, '/training/pack-a/story.html')).status).toBe(404);
    expect(reads).toEqual([]); // refused before any storage read
    relay.setOpenPack('pack-a');
    const ok = await open(relay, '/training/pack-a/story.html');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('every response carries CORP cross-origin, nosniff, COEP and the training CSP', async () => {
    const { relay } = relayWith(FILES);
    relay.setOpenPack('pack-a');
    for (const p of ['/training/pack-a/story.html', '/training/pack-a/missing.js', '/training/pack-a/..%2fx']) {
      const r = await open(relay, p);
      expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(r.headers['content-security-policy']).toBe(buildBrowserTrainingCsp(APP));
    }
  });

  it('Range: 206 with content-range, suffix range, 416 past the end, full 200 with accept-ranges', async () => {
    const { relay } = relayWith(FILES);
    relay.setOpenPack('pack-a');
    const full = await open(relay, '/training/pack-a/media/a.mp3');
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('audio/mpeg');
    const partial = await open(relay, '/training/pack-a/media/a.mp3', 'bytes=2-5');
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 2-5/10');
    expect(partial.headers['content-length']).toBe('4');
    const bytes = await read(relay, partial.handle!, 2, 4);
    expect(new TextDecoder().decode(bytes.bytes)).toBe('2345');
    const suffix = await open(relay, '/training/pack-a/media/a.mp3', 'bytes=-3');
    expect(suffix.headers['content-range']).toBe('bytes 7-9/10');
    const beyond = await open(relay, '/training/pack-a/media/a.mp3', 'bytes=50-');
    expect(beyond.status).toBe(416);
    expect(beyond.headers['content-range']).toBe('bytes */10');
  });

  it('reads are bounded to the opened range and the per-message cap', async () => {
    const { relay } = relayWith(FILES);
    relay.setOpenPack('pack-a');
    const r = await open(relay, '/training/pack-a/media/a.mp3', 'bytes=2-5');
    expect((await read(relay, r.handle!, 0, 2)).error).toBe('read outside range');
    expect((await read(relay, r.handle!, 2, 8)).error).toBe('read outside range');
    expect((await read(relay, r.handle!, 2, MAX_RELAY_READ_BYTES + 1)).error).toBe('invalid read');
    expect((await read(relay, r.handle!, 2, 0)).error).toBe('invalid read');
    expect((await read(relay, 999, 0, 1)).error).toBe('unknown handle');
  });

  it('closing or switching the open pack invalidates its handles', async () => {
    const { relay } = relayWith(FILES);
    relay.setOpenPack('pack-a');
    const r = await open(relay, '/training/pack-a/media/a.mp3');
    relay.setOpenPack(null);
    expect((await read(relay, r.handle!, 0, 1)).error).toBe('unknown handle');
  });

  it('malformed messages are ignored, oversized paths and odd methods refused', async () => {
    const { relay } = relayWith(FILES);
    relay.setOpenPack('pack-a');
    expect(await relay.handleRequest(null)).toBeNull();
    expect(await relay.handleRequest('x')).toBeNull();
    expect(await relay.handleRequest({ type: 'open', id: -1, path: '/x' })).toBeNull();
    expect(((await relay.handleRequest({ type: 'open', id: 1, path: `/training/pack-a/${'a'.repeat(5000)}`, method: 'GET', range: null })) as RelayOpenResponse).status).toBe(404);
    expect(((await relay.handleRequest({ type: 'open', id: 1, path: '/training/pack-a/story.html', method: 'POST', range: null })) as RelayOpenResponse).status).toBe(405);
  });

  it('rate-bounds requests per window', async () => {
    let now = 0;
    const { relay } = relayWith(FILES, 'pack-a', { now: () => now });
    relay.setOpenPack('pack-a');
    for (let i = 0; i < RELAY_RATE_LIMIT; i += 1) await open(relay, '/training/pack-a/story.html', null, i + 1);
    expect((await open(relay, '/training/pack-a/story.html')).status).toBe(429);
    now += 20_000;
    expect((await open(relay, '/training/pack-a/story.html')).status).toBe(200);
  });

  it('counts requests served for the open pack (first-load detection)', async () => {
    const { relay } = relayWith(FILES);
    relay.setOpenPack('pack-a');
    expect(relay.servedCount()).toBe(0);
    await open(relay, '/training/pack-a/story.html');
    expect(relay.servedCount()).toBe(1);
    relay.setOpenPack('pack-a');
    expect(relay.servedCount()).toBe(0);
  });
});

describe('relay helpers', () => {
  it('resolveTrainingPath returns decoded segments', () => {
    expect(resolveTrainingPath('/training/pack-a/story_content/a%20b.js')).toEqual({ kind: 'file', packId: 'pack-a', segments: ['story_content', 'a b.js'] });
  });

  it('parseRange mirrors desktop serveUnderRoot', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('items=1-2', 10)).toBeNull();
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange('bytes=-100', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 10)).toBe('unsatisfiable');
  });

  it('MIME table covers the Storyline media types', () => {
    expect(mimeTypeFor('a.MP3')).toBe('audio/mpeg');
    expect(mimeTypeFor('a.woff')).toBe('font/woff');
    expect(mimeTypeFor('noext')).toBe('application/octet-stream');
  });

  it('the training CSP restricts connect-src and framing, never allows a wildcard', () => {
    const csp = buildBrowserTrainingCsp(APP);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain(`frame-ancestors 'self' ${APP}`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/\*/);
  });
});
