// e5-update-network.test.ts — E5 (issue #88) network-hardening coverage
// (review F-011/F-012/F-013/PRR-014/PRR-015): the previously untested
// fetch/redirect/cap/clamp path, the schema-validation rejection branch, and
// the production validateFeedDocument seam.
//
// Strategy: stub globalThis.fetch so the REAL fetchFeedText /
// downloadArtifactBytes / validateFeedDocument / runUpdateCheck production
// code runs against scripted responses. No other production seam is mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PACK_ARTIFACT_BYTES,
  fetchFeedText,
  downloadArtifactBytes,
  runUpdateCheck,
  validateFeedDocument,
  type FeedVersionEntry,
  type TrustedKey,
} from '../../main/update-checker.js';

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;
const fetchMock = vi.fn<FetchMock>();

function installFetchMock(): void {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;
}

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

function jsonResponse(body: string, url = 'https://example.invalid/feed.json'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  // NOTE: Response.url is read-only; the redirect/https assertions below use
  // scripted Response objects with explicit url via Object.defineProperty.
}

function responseWith(
  body: BodyInit | null,
  opts: { status?: number; headers?: Record<string, string>; url?: string } = {},
): Response {
  const response = new Response(body, { status: opts.status ?? 200, headers: opts.headers });
  if (opts.url !== undefined) {
    Object.defineProperty(response, 'url', { value: opts.url });
  }
  return response;
}

const TRUSTED: TrustedKey[] = [];

describe('e5 network hardening (review F-011/F-012/F-013)', () => {
  afterEach(() => {
    installFetchMock();
  });

  it('fetchFeedText refuses a non-https feed URL before any request', async () => {
    installFetchMock();
    await expect(fetchFeedText('http://example.invalid/feed.json')).rejects.toThrow(/non-https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchFeedText refuses an INTERMEDIATE redirect hop to http before requesting it', async () => {
    installFetchMock();
    // First hop returns a redirect to http:// — fetchHttpsOnly must refuse
    // BEFORE issuing the second request.
    fetchMock.mockImplementationOnce(async () =>
      responseWith(null, {
        status: 302,
        headers: { location: 'http://example.invalid/feed.json' },
      }),
    );
    await expect(fetchFeedText('https://example.invalid/feed.json')).rejects.toThrow(/non-https/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetchFeedText follows an https redirect chain and reads the body', async () => {
    installFetchMock();
    fetchMock
      .mockImplementationOnce(async () =>
        responseWith(null, {
          status: 302,
          headers: { location: 'https://cdn.example.invalid/pack-feed.json' },
        }),
      )
      .mockImplementationOnce(async () =>
        jsonResponse(JSON.stringify({ schema_version: 1, packs: [] }), 'https://cdn.example.invalid/pack-feed.json'),
      );
    const text = await fetchFeedText('https://example.invalid/feed.json');
    expect(JSON.parse(text).schema_version).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetchFeedText caps the body at 5 MiB (content-length pre-rejection)', async () => {
    installFetchMock();
    fetchMock.mockImplementationOnce(async () =>
      responseWith('{}', {
        headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
      }),
    );
    await expect(fetchFeedText('https://example.invalid/feed.json')).rejects.toThrow(/cap/);
  });

  it('downloadArtifactBytes refuses non-https and rejects size mismatch', async () => {
    installFetchMock();
    await expect(downloadArtifactBytes('http://example.invalid/a.zip', 10)).rejects.toThrow(/non-https/);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementationOnce(async () =>
      responseWith(new Uint8Array(5).fill(1)),
    );
    await expect(downloadArtifactBytes('https://example.invalid/a.zip', 10)).rejects.toThrow(/size mismatch/);
  });

  it('downloadArtifactBytes clamps the read cap to MAX_PACK_ARTIFACT_BYTES (F-012)', async () => {
    installFetchMock();
    // An entry declaring far more than the 50 MiB consumer limit must be
    // capped at MAX_PACK_ARTIFACT_BYTES, never buffered to the declared size.
    expect(MAX_PACK_ARTIFACT_BYTES).toBe(52_428_800);
    fetchMock.mockImplementationOnce(async () => {
      // Stream 60 MiB? Too heavy for a unit test — instead declare a huge
      // content-length and verify the PRE-CHECK rejects before any body read.
      return responseWith(null, {
        headers: { 'content-length': String(MAX_PACK_ARTIFACT_BYTES + 1) },
      });
    });
    await expect(
      downloadArtifactBytes('https://example.invalid/huge.zip', MAX_PACK_ARTIFACT_BYTES + 1),
    ).rejects.toThrow(/cap/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downloadArtifactBytes refuses an intermediate http redirect hop (F-013)', async () => {
    installFetchMock();
    fetchMock.mockImplementationOnce(async () =>
      responseWith(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:9/a.zip' },
      }),
    );
    await expect(downloadArtifactBytes('https://example.invalid/a.zip', 10)).rejects.toThrow(/non-https/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('e5 schema-validation rejection + production loader (PRR-014/PRR-015)', () => {
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('validateFeedDocument (production seam) accepts a valid doc and rejects an invalid one', () => {
    const good = {
      schema_version: 1,
      packs: [
        {
          pack_id: 'a',
          versions: [
            {
              version: '2.0.0',
              published_at: '2026-09-28T00:00:00Z',
              sha256: 'a'.repeat(64),
              size_bytes: 10,
              download_url: 'https://example.invalid/a.zip',
              signature: { algorithm: 'ed25519', key_id: 'k', value: 'AAAA' },
            },
          ],
        },
      ],
    };
    expect(validateFeedDocument(good).ok).toBe(true);
    expect(validateFeedDocument({ schema_version: 'one', packs: [] }).ok).toBe(false);
    expect(validateFeedDocument({}).ok).toBe(false);
  });

  it('runUpdateCheck reports a NEWER feed schema with an upgrade-guidance error (F-010/PRR-010)', async () => {
    installFetchMock();
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(JSON.stringify({ schema_version: 2, packs: [] })),
    );
    const outcome = await runUpdateCheck(
      { optIn: true, feedUrl: 'https://example.invalid/feed.json' },
      [{ packId: 'a', version: '1.0.0' }],
      { fetchFeed: (url) => fetchMock(url as string).then((r) => r.text()) },
      TRUSTED,
    );
    expect(outcome.skipped).toBe(false);
    if (outcome.skipped) throw new Error('expected a live check');
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.error).toMatch(/newer than this app supports/);
  });

  it('runUpdateCheck surfaces the generic schema-violation error for a malformed feed (PRR-014)', async () => {
    installFetchMock();
    // Valid JSON, but sha256 is not 64-hex: ajv rejects -> generic detail.
    const bad = {
      schema_version: 1,
      packs: [
        {
          pack_id: 'a',
          versions: [
            {
              version: '2.0.0',
              published_at: '2026-09-28T00:00:00Z',
              sha256: 'not-64-hex',
              size_bytes: 10,
              download_url: 'https://example.invalid/a.zip',
              signature: { algorithm: 'ed25519', key_id: 'k', value: 'AAAA' },
            },
          ],
        },
      ],
    };
    fetchMock.mockImplementationOnce(async () => jsonResponse(JSON.stringify(bad)));
    const outcome = await runUpdateCheck(
      { optIn: true, feedUrl: 'https://example.invalid/feed.json' },
      [{ packId: 'a', version: '1.0.0' }],
      { fetchFeed: (url) => fetchMock(url as string).then((r) => r.text()) },
      TRUSTED,
    );
    expect(outcome.skipped).toBe(false);
    if (outcome.skipped) throw new Error('expected a live check');
    expect(outcome.error).toMatch(/does not satisfy contracts\/pack-feed\.schema\.json/);
  });
});

describe('e5 diff semantics: phantom-update + duplicate pack_id (F-004/F-007)', () => {
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('checkPackUpdates diffs against the HIGHEST installed version, not a superseded row', async () => {
    const { checkPackUpdates } = await import('../../main/update-checker.js');
    const entry = (version: string, sha: string): FeedVersionEntry => ({
      version,
      published_at: '2026-09-28T00:00:00Z',
      sha256: sha,
      size_bytes: 10,
      download_url: `https://example.invalid/${version}.zip`,
    });
    // Installed retains the superseded 1.0.0 alongside active 2.0.0; a feed
    // offering 1.5.0 must NOT resurrect an "update" (phantom-update, F-004).
    expect(
      checkPackUpdates(
        [
          { packId: 'a', version: '1.0.0' },
          { packId: 'a', version: '2.0.0' },
        ],
        { schema_version: 1, packs: [{ pack_id: 'a', versions: [entry('1.5.0', 'a'.repeat(64))] }] },
      ),
    ).toHaveLength(0);
    // A genuinely newer version still surfaces exactly once.
    const candidates = checkPackUpdates(
      [
        { packId: 'a', version: '1.0.0' },
        { packId: 'a', version: '2.0.0' },
      ],
      { schema_version: 1, packs: [{ pack_id: 'a', versions: [entry('2.1.0', 'b'.repeat(64))] }] },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.currentVersion).toBe('2.0.0');
  });

  it('duplicate pack_id entries in a feed merge into ONE candidate (F-007)', async () => {
    const { checkPackUpdates } = await import('../../main/update-checker.js');
    const entry = (version: string, sha: string): FeedVersionEntry => ({
      version,
      published_at: '2026-09-28T00:00:00Z',
      sha256: sha,
      size_bytes: 10,
      download_url: `https://example.invalid/${version}.zip`,
    });
    const candidates = checkPackUpdates(
      [{ packId: 'a', version: '1.0.0' }],
      {
        schema_version: 1,
        packs: [
          { pack_id: 'a', versions: [entry('2.0.0', 'a'.repeat(64))] },
          { pack_id: 'a', versions: [entry('3.0.0', 'b'.repeat(64))] },
        ],
      },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.availableVersion).toBe('3.0.0');
  });

  it('pre-release IDENTIFIERS order correctly: rc.2 surfaces over installed rc.1 (F-005)', async () => {
    const { checkPackUpdates } = await import('../../main/update-checker.js');
    const entry = (version: string, sha: string): FeedVersionEntry => ({
      version,
      published_at: '2026-09-28T00:00:00Z',
      sha256: sha,
      size_bytes: 10,
      download_url: `https://example.invalid/${version}.zip`,
    });
    // The old comparator kept only a pre flag: rc.1 vs rc.2 compared EQUAL
    // and the update never surfaced. It must now.
    const candidates = checkPackUpdates(
      [{ packId: 'a', version: '2.0.0-rc.1' }],
      { schema_version: 1, packs: [{ pack_id: 'a', versions: [entry('2.0.0-rc.2', 'c'.repeat(64))] }] },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.availableVersion).toBe('2.0.0-rc.2');
    // Releases still sort above their own pre-releases, and numeric
    // identifiers compare numerically (rc.9 < rc.10, not text-ordered).
    expect(
      checkPackUpdates(
        [{ packId: 'a', version: '2.0.0-rc.9' }],
        { schema_version: 1, packs: [{ pack_id: 'a', versions: [entry('2.0.0-rc.10', 'd'.repeat(64))] }] },
      ),
    ).toHaveLength(1);
  });
});
