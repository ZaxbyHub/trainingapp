// Schema-mirror drift guard (trace browser-training-parity AC1/AC8).
//
// web_ui carries no ajv, so the browser mirrors contracts/pack.schema.json
// (web_ui/src/lib/packs/pack-manifest.ts validateManifestSchema) and
// contracts/pack-feed.schema.json (web_ui/src/lib/packs/pack-update-browser.ts
// validateFeedDocument) by hand. This suite runs a generated battery of valid
// documents and single-field mutations through BOTH the browser mirror and
// ajv compiled from the REAL schema files (the same ajv options desktop uses)
// and fails on any verdict difference.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateManifestSchema } from '../../../web_ui/src/lib/packs/pack-manifest';
import { validateFeedDocument } from '../../../web_ui/src/lib/packs/pack-update-browser';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const Ajv2020 = require_('ajv/dist/2020') as new (opts: object) => { compile(schema: object): (data: unknown) => boolean };
const addFormats = require_('ajv-formats') as (ajv: unknown) => unknown;

function compile(file: string): (data: unknown) => boolean {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(repo, 'contracts', file), 'utf8')) as object);
}

type Doc = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Every single-step mutation of `doc`: delete, retype, and stress each field (recursive). */
function mutations(doc: unknown, depth = 0): unknown[] {
  const out: unknown[] = [];
  const stress: unknown[] = [null, 0, -1, 1, 1.5, '', 'x', '😀😀', true, [], {}, 'a'.repeat(201), 2 ** 53, 52428801, 'https://ok.example/x', 'http://no.example/x'];
  if (Array.isArray(doc)) {
    out.push([]);
    if (doc.length > 0) {
      out.push([...doc, doc[0]]);
      for (const inner of depth < 4 ? mutations(doc[0], depth + 1) : []) out.push([inner, ...doc.slice(1)]);
    }
    return out;
  }
  if (typeof doc === 'object' && doc !== null) {
    const obj = doc as Doc;
    out.push({ ...obj, unexpected: 1 });
    for (const key of Object.keys(obj)) {
      const without = { ...obj };
      delete without[key];
      out.push(without);
      for (const value of stress) out.push({ ...obj, [key]: value });
      if (depth < 4) for (const inner of mutations(obj[key], depth + 1)) out.push({ ...obj, [key]: inner });
    }
    return out;
  }
  return out;
}

const VALID_MANIFEST: Doc = {
  id: 'storyline-nav-fixture',
  name: 'Storyline Nav Fixture',
  version: '1.0.0-rc.1+build.5',
  published_at: '2026-09-30T00:00:00Z',
  source_class: 'training',
  supersedes: ['storyline-nav-fixture@0.9.0'],
  embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
  chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
  docs: [{ path: 'docs/slide-001-5rN4PvXJM5d.json', sha256: 'a'.repeat(64), title: 'Welcome', mime: 'application/json', published_at: '2026-09-30T12:00:00.5+02:00' }],
  index: { path: 'index.sqlite', schema_version: 3, sqlite_vec_version: '0.1.9' },
  signature: { algorithm: 'ed25519', value: 'AAAA', key_id: 'k', note: 'extra ok' },
};

const VALID_FEED: Doc = {
  schema_version: 1,
  generated_at: '2026-09-30T00:00:00Z',
  packs: [
    {
      pack_id: 'storyline-nav-fixture',
      versions: [
        {
          version: '1.1.0',
          published_at: '2026-09-30T00:00:00Z',
          sha256: 'b'.repeat(64),
          size_bytes: 2048,
          download_url: 'https://updates.example/p.zip',
          supersedes: ['storyline-nav-fixture@1.0.0'],
          signature: { algorithm: 'ed25519', key_id: 'k', value: 'QUJD' },
        },
      ],
    },
  ],
  app: {
    versions: [
      {
        version: '2.0.0',
        published_at: '2026-09-30T00:00:00Z',
        sha256: 'c'.repeat(64),
        size_bytes: 4096,
        download_url: 'https://updates.example/app.exe',
        notes_url: 'https://updates.example/notes',
        signature: { algorithm: 'ed25519', key_id: 'k', value: 'QUJD' },
      },
    ],
  },
};

const DATE_TIMES = [
  '2026-09-30T00:00:00Z', '2026-09-30t00:00:00z', '2026-09-30 00:00:00Z', '2026-02-29T00:00:00Z', '2024-02-29T00:00:00Z',
  '2026-13-01T00:00:00Z', '2026-09-31T00:00:00Z', '2026-09-30T24:00:00Z', '2026-09-30T23:59:60Z', '2026-09-30T23:59:60+01:00',
  '2026-09-30T00:00:00', '2026-09-30T00:00:00.123456+05:30', '2026-09-30T00:00:00+0530', '2026-09-30', 'yesterday', '2026-09-30T00:00:00+24:00',
];

describe('browser schema mirrors agree with ajv on the real schema files', () => {
  it('pack.schema.json: every generated manifest gets the same verdict', () => {
    const ajv = compile('pack.schema.json');
    const docs: unknown[] = [VALID_MANIFEST, ...mutations(VALID_MANIFEST)];
    for (const dt of DATE_TIMES) docs.push({ ...clone(VALID_MANIFEST), published_at: dt });
    let accepted = 0;
    const diverged: string[] = [];
    for (const doc of docs) {
      const want = ajv(doc);
      if (want) accepted += 1;
      if (validateManifestSchema(doc) !== want) diverged.push(`${JSON.stringify(doc).slice(0, 240)} (ajv ${want})`);
    }
    expect(docs.length).toBeGreaterThan(300);
    expect(accepted).toBeGreaterThan(5);
    expect(diverged, diverged.slice(0, 5).join('\n')).toEqual([]);
  });

  it('pack-feed.schema.json: every generated feed gets the same verdict', () => {
    const ajv = compile('pack-feed.schema.json');
    const docs: unknown[] = [VALID_FEED, ...mutations(VALID_FEED)];
    for (const dt of DATE_TIMES) docs.push({ ...clone(VALID_FEED), generated_at: dt });
    let accepted = 0;
    const diverged: string[] = [];
    for (const doc of docs) {
      const want = ajv(doc);
      if (want) accepted += 1;
      if (validateFeedDocument(doc).ok !== want) diverged.push(`${JSON.stringify(doc).slice(0, 240)} (ajv ${want})`);
    }
    expect(docs.length).toBeGreaterThan(300);
    expect(accepted).toBeGreaterThan(5);
    expect(diverged, diverged.slice(0, 5).join('\n')).toEqual([]);
  });
});
