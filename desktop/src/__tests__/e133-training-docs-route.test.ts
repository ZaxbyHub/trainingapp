/**
 * e133-training-docs-route.test.ts — issue #133 guardrail: the reserved
 * app://training route serves a DOCUMENT pack's own files, not only the
 * Storyline player assets, so the Training tab can read the built-in
 * knowledge content.
 *
 * Routes pinned (widening of resolveTrainingRequest, mirroring d5's
 * discipline — decode/traversal/pattern refusals must keep holding):
 *   - app://training/<packDir>/pack.json → <packsDir>/<packDir>/pack.json
 *   - app://training/<packDir>/docs/<rel> → <packsDir>/<packDir>/docs/<rel>
 *   - player assets keep their existing mapping (unchanged, covered by d5)
 * Containment: docs/.. escapes and paths outside the pack dir are refused.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppFileHandler } from '../../main/protocol';

const PACK_MANIFEST = JSON.stringify({
  id: 'opmed-initial',
  version: '1.0.0',
  docs: [
    { path: 'docs/brief.pdf', title: 'Brief', mime: 'application/pdf' },
    { path: 'docs/nested/manual.docx', title: 'Manual', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ],
});
const PDF_BYTES = '%PDF-1.4 e133-docs-sentinel\n';
const DOCX_BYTES = 'e133-docx-sentinel';
const SECRET = 'TOP-SECRET-OUTSIDE-PACK';

let root = '';
let packsDir = '';

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'e133-docs-route-'));
  root = path.join(base, 'renderer-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<html></html>');
  packsDir = path.join(base, 'packs');
  const packDir = path.join(packsDir, 'opmed-initial-1.0.0');
  mkdirSync(path.join(packDir, 'docs', 'nested'), { recursive: true });
  writeFileSync(path.join(packDir, 'pack.json'), PACK_MANIFEST);
  writeFileSync(path.join(packDir, 'docs', 'brief.pdf'), PDF_BYTES);
  writeFileSync(path.join(packDir, 'docs', 'nested', 'manual.docx'), DOCX_BYTES);
  writeFileSync(path.join(packsDir, 'secret.txt'), SECRET);
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

const handler = () => createAppFileHandler({ root, packsDir });

describe('app://training document-pack routes (#133)', () => {
  it('serves the pack manifest at <packDir>/pack.json', async () => {
    const res = await handler()(new Request('app://training/opmed-initial-1.0.0/pack.json'));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as { id: string; docs: unknown[] };
    expect(parsed.id).toBe('opmed-initial');
    expect(parsed.docs).toHaveLength(2);
  });

  it('serves pack documents under docs/ (nested paths included)', async () => {
    const pdf = await handler()(new Request('app://training/opmed-initial-1.0.0/docs/brief.pdf'));
    expect(pdf.status).toBe(200);
    expect(await pdf.text()).toContain('e133-docs-sentinel');
    const docx = await handler()(
      new Request('app://training/opmed-initial-1.0.0/docs/nested/manual.docx'),
    );
    expect(docx.status).toBe(200);
    expect(await docx.text()).toBe(DOCX_BYTES);
  });

  it('still refuses traversal through the docs prefix (no content leak)', async () => {
    // Percent-encoded dots survive Request-URL normalization (the raw '../'
    // form is collapsed by the URL parser before the handler runs) — this is
    // the shape the handler's decode-then-refuse discipline must catch. d5's
    // convention: the URL parser may legitimately pre-collapse a form into a
    // 404 path, so the pinned property is REFUSAL (403/404) + no leak.
    const escape = await handler()(
      new Request('app://training/opmed-initial-1.0.0/docs/%2e%2e/%2e%2e/secret.txt'),
    );
    expect([403, 404]).toContain(escape.status);
    expect(await escape.text()).not.toContain('TOP-SECRET');
    const dotSegment = await handler()(
      new Request('app://training/opmed-initial-1.0.0/docs/%2e'),
    );
    expect([403, 404]).toContain(dotSegment.status);
    // The file the traversal targeted must NOT be reachable by any of these
    // forms — belt and braces for the actual security property.
    const direct = await handler()(new Request('app://training/secret.txt'));
    expect(direct.status).toBe(404);
    expect(await direct.text()).not.toContain('TOP-SECRET');
  });

  it('keeps the player-assets mapping for non-docs paths', async () => {
    // No assets/player dir staged in this fixture — the request must resolve
    // UNDER the (nonexistent) assets/player path and 404, never fall back to
    // serving the pack root or docs.
    const res = await handler()(new Request('app://training/opmed-initial-1.0.0/story.html'));
    expect(res.status).toBe(404);
  });
});
