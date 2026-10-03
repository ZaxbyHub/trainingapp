// Shared training-route containment vectors, desktop leg (trace
// browser-training-parity AC3). contracts/training-path-vectors.json is run
// identically by the browser relay (web_ui/src/lib/packs/__tests__/training-relay.test.ts):
// the desktop app:// handler and the browser relay must give the same status
// for every raw path. A plain object stands in for the Request so the RAW
// (un-normalized) path reaches resolveTrainingRequest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppFileHandler } from '../../main/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(here, '..', '..', '..', 'contracts', 'training-path-vectors.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as {
  pack_id: string;
  files: string[];
  vectors: Array<{ id: string; path: string; status: number }>;
};

let tmp: string;
let handler: (request: Request) => Promise<Response>;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-vectors-'));
  const root = path.join(tmp, 'renderer');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>app shell</html>');
  for (const rel of data.files) {
    const target = path.join(tmp, 'packs', data.pack_id, 'assets', 'player', ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `content of ${rel}`);
  }
  handler = createAppFileHandler({ root, packsDir: path.join(tmp, 'packs') });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('contracts/training-path-vectors.json (desktop app:// handler)', () => {
  // it.each over an empty corpus registers zero tests and passes green, so the
  // corpus must prove it is non-empty and well-shaped (PR 144 review F12).
  it('has served and refused vectors and the expected keys (not vacuous)', () => {
    expect(typeof data.pack_id).toBe('string');
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.vectors.length).toBeGreaterThan(0);
    for (const v of data.vectors) {
      expect(typeof v.id).toBe('string');
      expect(typeof v.path).toBe('string');
      expect(typeof v.status).toBe('number');
    }
    expect(data.vectors.some((v) => v.status === 200)).toBe(true);
    expect(data.vectors.some((v) => v.status !== 200)).toBe(true);
  });

  it.each(data.vectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const request = { url: `app://training${vector.path}`, headers: new Headers() } as unknown as Request;
    const response = await handler(request);
    expect(response.status).toBe(vector.status);
    if (vector.status === 200) {
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(await response.text()).toMatch(/^content of /);
    }
  });
});
