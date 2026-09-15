// D5 acceptance check C1 (issue #81, AC1): the app:// handler serves the
// embedded Storyline player route with the training CSP profile while the
// renderer document keeps the strict policy, and refuses traversal and
// malformed pack ids.
//
// FROZEN SPEC — authored by the independent check author at base d2380bb,
// before any implementation exists. The implementer must make this pass
// without editing it.
//
// Seam contract (extends desktop/main/protocol.ts):
//   export function createAppFileHandler(opts: { root: string; packsDir: string }):
//     (request: Request) => Response | Promise<Response>
//     - `root` stays the renderer root (app://index.html and friends, strict CSP).
//     - `packsDir` is the packs root: `app://training/<packId>/<rest>` must map to
//       `<packsDir>/<packId>/assets/player/<rest>` (PLAYER_ASSETS_PREFIX from
//       packtool/build/pack-json.ts). Pack responses carry the TRAINING CSP
//       profile: script-src must include 'unsafe-inline' (story.html's inline
//       bootstrap is fatal without it — proven in the A8 probe), while every
//       other withSecurityHeaders() discipline (COOP/COEP/CORP, nosniff)
//       still applies.
//     - packId is additionally constrained to PACK_ID_PATTERN
//       ^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$ (packtool/build/pack-json.ts:131).
//       NOTE: underscores and dots ARE legal in that pattern; the negatives
//       below use ids that are genuinely illegal (uppercase, too short,
//       trailing hyphen) — asserting underscore rejection would contradict
//       the pack layout contract.
//     - the main process resolves the packs root from the
//       TRAININGAPP_DESKTOP_PACKS_DIR env var (mirrors
//       TRAININGAPP_DESKTOP_STORE_PATH); defaulting to <userData>/packs is
//       implementation freedom, the env override is contractual (exercised by
//       the e2e checks C2/C3).
//
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias); the
// handler itself is pure (no Electron calls needed for these cases).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppFileHandler } from '../../main/protocol';

const OPMED_STORY = Buffer.from(
  '<!doctype html><html><body>D5-TRAINING-STORY-SENTINEL-opmed</body></html>\n',
  'utf8',
);
const SECOND_STORY = Buffer.from(
  '<!doctype html><html><body>D5-TRAINING-STORY-SENTINEL-second</body></html>\n',
  'utf8',
);
const USER_JS = 'console.log("D5-TRAINING-BRIDGE-SENTINEL");\n';
const SECRET = 'TOP-SECRET-DO-NOT-SERVE-FROM-PACKS';

let root = '';
let packsDir = '';

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'd5-training-route-'));
  // Renderer root: one index.html only — enough to prove the strict policy is
  // untouched by the training profile.
  root = path.join(base, 'renderer-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>renderer index</body></html>');
  // Packs root: two valid pack ids (multi-course readiness, AC5) staged in the
  // pack layout <packId>/assets/player/... plus a secret one level ABOVE the
  // pack dirs that traversal must never reach.
  packsDir = path.join(base, 'packs');
  const opmedPlayer = path.join(packsDir, 'opmed-cdp-mlc', 'assets', 'player');
  mkdirSync(path.join(opmedPlayer, 'story_content'), { recursive: true });
  writeFileSync(path.join(opmedPlayer, 'story.html'), OPMED_STORY);
  writeFileSync(path.join(opmedPlayer, 'story_content', 'user.js'), USER_JS);
  const secondPlayer = path.join(packsDir, 'second.course_pub', 'assets', 'player');
  mkdirSync(secondPlayer, { recursive: true });
  writeFileSync(path.join(secondPlayer, 'story.html'), SECOND_STORY);
  writeFileSync(path.join(packsDir, 'secret.txt'), SECRET);
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

// Build a Request like Electron's protocol.handle delivers (raw url form the
// existing handler parses — see resolveWithinRoot in desktop/main/protocol.ts).
function req(url: string): Request {
  try {
    return new Request(url);
  } catch {
    return { url } as Request;
  }
}

function handler() {
  return createAppFileHandler({ root, packsDir });
}

function statusOf(res: Response): string {
  return `status=${res.status}`;
}

describe('D5 C1: app://training/<packId>/ player route (issue #81 AC1)', () => {
  it('serves app://training/<packId>/story.html from <packsDir>/<packId>/assets/player with the exact pack bytes', async () => {
    const res = await handler()(req('app://training/opmed-cdp-mlc/story.html'));
    expect(
      res.status,
      `training route not served: app://training/opmed-cdp-mlc/story.html returned ${statusOf(res)}; the route must map app://training/<packId>/<rest> -> <packsDir>/<packId>/assets/player/<rest> (packsDir option is contractual)`,
    ).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(OPMED_STORY), 'story.html bytes must be the exact staged sentinel').toBe(true);
  });

  it('answers text/html for the pack document', async () => {
    const res = await handler()(req('app://training/opmed-cdp-mlc/story.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('serves pack subpaths (story_content/) with a JavaScript MIME type', async () => {
    const res = await handler()(req('app://training/opmed-cdp-mlc/story_content/user.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/(javascript|ecmascript)/);
    expect(await res.text()).toBe(USER_JS);
  });

  it('parameterizes by packId (second pack gets its own story bytes)', async () => {
    const res = await handler()(req('app://training/second.course_pub/story.html'));
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(SECOND_STORY)).toBe(true);
  });

  it('uses the TRAINING CSP profile for pack documents: script-src allows unsafe-inline', async () => {
    const res = await handler()(req('app://training/opmed-cdp-mlc/story.html'));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp, 'pack responses must carry a CSP').toContain('script-src');
    expect(
      csp,
      "training profile: story.html's inline bootstrap requires 'unsafe-inline' in script-src for pack documents",
    ).toContain("'unsafe-inline'");
  });

  it('keeps the crossOriginIsolation posture on pack responses (COOP/COEP/CORP)', async () => {
    const res = await handler()(req('app://training/opmed-cdp-mlc/story.html'));
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    // CHECK_WRONG amendment (issue #81 trace): the player frame (host
    // app://training) is embedded by the renderer (host app://index.html) —
    // different hosts under the standard app: scheme, i.e. CROSS-ORIGIN — so
    // the frame response must carry CORP cross-origin to be embeddable at
    // all. CORP same-origin here made Chromium abort the frame load
    // (chrome-error://chromewebdata/) despite the handler's 200.
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps the STRICT renderer policy for app://index.html (no unsafe-inline)', async () => {
    const res = await handler()(req('app://index.html'));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('script-src');
    expect(csp, 'renderer documents must never relax script-src').not.toContain("'unsafe-inline'");
  });

  it('answers 404 for a file that does not exist inside a valid pack', async () => {
    const res = await handler()(req('app://training/opmed-cdp-mlc/nope.js'));
    expect([403, 404]).toContain(res.status);
  });

  it('answers 404/403 for an unknown pack id that is pattern-valid', async () => {
    const res = await handler()(req('app://training/unpublished-pack/story.html'));
    expect([403, 404]).toContain(res.status);
  });

  const TRAVERSALS = [
    'app://training/../secret.txt',
    'app://training/..%2fsecret.txt',
    'app://training/opmed-cdp-mlc/../../../secret.txt',
    'app://training/opmed-cdp-mlc/..%2f..%2f..%2fsecret.txt',
    'app://training/opmed-cdp-mlc/%2e%2e/%2e%2e/secret.txt',
  ];

  it.each(TRAVERSALS)('refuses training-route traversal %s', async (url) => {
    const res = await handler()(req(url));
    expect([403, 404]).toContain(res.status);
    const body = await res.text().catch(() => '');
    expect(body).not.toContain(SECRET);
  });

  const BAD_PACK_IDS = [
    ['app://training/OpMedCourse/story.html', 'uppercase packId'],
    ['app://training/opmed_cds%20lib/story.html', 'percent-encoded space in packId'],
    ['app://training/x/story.html', 'too-short packId (min length 3 per PACK_ID_PATTERN)'],
    ['app://training/bad-/story.html', 'trailing hyphen packId'],
    ['app://training/.hidden/story.html', 'leading dot packId'],
  ] as const;

  it.each(BAD_PACK_IDS)('refuses malformed packId %s (%s)', async (url) => {
    const res = await handler()(req(url));
    expect([403, 404]).toContain(res.status);
    const body = await res.text().catch(() => '');
    expect(body).not.toContain(SECRET);
  });
});
