// e5-update-apply.test.ts — E5 (issue #88) supplementary coverage for the
// applyPackUpdate composition and the baked-key guardrail.
//
// Lives OUTSIDE the frozen acceptance files (the frozen C2-C5 checks own the
// contract seam). This suite covers what the plan's R3 coverage statement
// promises: the download-verify-install composition (refusal paths included)
// and that the build-time-baked feed key parses as an ed25519 SPKI key.
import { describe, expect, it, vi } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  applyPackUpdate,
  checkAppUpdateVerified,
  runUpdateCheck,
  UPDATE_FEED_PUBLIC_KEY,
  type FeedVersionEntry,
  type PackFeedDocument,
  type PackUpdateCandidate,
  type TrustedKey,
} from '../../main/update-checker.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

function makeTrusted(): { keys: TrustedKey[]; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keys: [{ key_id: 'apply-test', public_key: Buffer.from(der).toString('base64') }],
    privateKey,
  };
}

const CANDIDATE: PackUpdateCandidate = {
  packId: 'bundled-min',
  currentVersion: '1.0.0',
  availableVersion: '2.0.0',
  publishedAt: '2026-09-27T00:00:00Z',
  downloadUrl: 'https://example.invalid/bundled-min-2.0.0.zip',
  sha256: '',
  sizeBytes: 0,
};

describe('e5 apply composition + baked key guardrail (issue #88)', () => {
  it('guardrail: the baked UPDATE_FEED_PUBLIC_KEY parses as an ed25519 SPKI key', () => {
    const key = createPublicKey({
      key: Buffer.from(UPDATE_FEED_PUBLIC_KEY.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(UPDATE_FEED_PUBLIC_KEY.key_id.length).toBeGreaterThan(0);
  });

  it('applies a verified update: download -> verify -> install', async () => {
    const { keys, privateKey } = makeTrusted();
    const artifact = new Uint8Array(Buffer.from('apply-test artifact bytes', 'utf8'));
    const digest = sha256Hex(artifact);
    const entry: FeedVersionEntry = {
      version: '2.0.0',
      published_at: '2026-09-27T00:00:00Z',
      sha256: digest,
      size_bytes: artifact.byteLength,
      download_url: CANDIDATE.downloadUrl,
      signature: {
        algorithm: 'ed25519',
        key_id: 'apply-test',
        value: sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
      },
    };
    const candidate: PackUpdateCandidate = { ...CANDIDATE, sizeBytes: artifact.byteLength };
    const downloadArtifact = vi.fn(async () => artifact);
    const installPack = vi.fn(async () => ({ version: '2.0.0' }));
    const result = await applyPackUpdate(candidate, entry, { downloadArtifact, installPack }, keys);
    expect(result.applied).toBe(true);
    expect(result.version).toBe('2.0.0');
    expect(downloadArtifact).toHaveBeenCalledWith(candidate.downloadUrl, artifact.byteLength);
    expect(installPack).toHaveBeenCalledTimes(1);
  });

  it('refuses a mutated artifact and never reaches the installer', async () => {
    const { keys, privateKey } = makeTrusted();
    const artifact = new Uint8Array(Buffer.from('apply-test artifact bytes', 'utf8'));
    const digest = sha256Hex(artifact);
    const entry: FeedVersionEntry = {
      version: '2.0.0',
      published_at: '2026-09-27T00:00:00Z',
      sha256: digest,
      size_bytes: artifact.byteLength,
      download_url: CANDIDATE.downloadUrl,
      signature: {
        algorithm: 'ed25519',
        key_id: 'apply-test',
        value: sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
      },
    };
    const mutated = new Uint8Array(artifact);
    mutated[0] = (mutated[0] ?? 0) ^ 0xff;
    const installPack = vi.fn(async () => ({ version: '2.0.0' }));
    const result = await applyPackUpdate(
      CANDIDATE,
      entry,
      { downloadArtifact: vi.fn(async () => mutated), installPack },
      keys,
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/refused/i);
    expect(installPack).not.toHaveBeenCalled();
  });

  it('refuses when the artifact length differs from the feed-declared size', async () => {
    const { keys } = makeTrusted();
    const installPack = vi.fn(async () => ({ version: '2.0.0' }));
    const result = await applyPackUpdate(
      CANDIDATE,
      {
        version: '2.0.0',
        published_at: '2026-09-27T00:00:00Z',
        sha256: 'a'.repeat(64),
        size_bytes: 424242,
        download_url: CANDIDATE.downloadUrl,
      },
      {
        downloadArtifact: vi.fn(async () => new Uint8Array(10)),
        installPack,
      },
      keys,
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/refused|size|digest/i);
    expect(installPack).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Review round 1 (finding 4): the runUpdateCheck REFUSAL branch, and the
// verified app-update diff (finding 1). Supplements the frozen floor.
// ============================================================================

function signedFeedDocument(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  keyId: string,
): PackFeedDocument {
  const artifact = new Uint8Array(Buffer.from('refusal-branch artifact', 'utf8'));
  const digest = sha256Hex(artifact);
  return {
    schema_version: 1,
    packs: [
      {
        pack_id: 'bundled-min',
        versions: [
          {
            version: '2.0.0',
            published_at: '2026-09-27T00:00:00Z',
            sha256: digest,
            size_bytes: artifact.byteLength,
            download_url: 'https://example.invalid/bundled-min-2.0.0.zip',
            signature: {
              algorithm: 'ed25519',
              key_id: keyId,
              value: sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
            },
          },
        ],
      },
    ],
  };
}

describe('e5 runUpdateCheck refusal branch + verified app diff (issue #88)', () => {
  it('routes an untrusted winning entry to refused, never to candidates', async () => {
    const untrusted = makeTrusted();
    const feed = signedFeedDocument(untrusted.privateKey, untrusted.keys[0]?.key_id ?? 'untrusted');
    const fetchFeed = vi.fn(async () => JSON.stringify(feed));
    const outcome = await runUpdateCheck(
      { optIn: true, feedUrl: 'https://example.invalid/feed.json' },
      [{ packId: 'bundled-min', version: '1.0.0' }],
      { fetchFeed },
      makeTrusted().keys, // a DIFFERENT keypair: the signature must not verify
    );
    expect(outcome.skipped).toBe(false);
    if (outcome.skipped) throw new Error('expected a live check');
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]?.packId).toBe('bundled-min');
    expect(outcome.refused[0]?.version).toBe('2.0.0');
    expect(outcome.refused[0]?.reason.length).toBeGreaterThan(0);
  });

  it('checkAppUpdateVerified: signs the notice only with a trusted signature; untrusted yields null', () => {
    const trusted = makeTrusted();
    const artifact = new Uint8Array(Buffer.from('app installer bytes', 'utf8'));
    const digest = sha256Hex(artifact);
    const appEntry = {
      version: '3.1.0',
      published_at: '2026-09-27T00:00:00Z',
      sha256: digest,
      size_bytes: artifact.byteLength,
      download_url: 'https://example.invalid/Setup-3.1.0.exe',
      signature: {
        algorithm: 'ed25519',
        key_id: trusted.keys[0]?.key_id ?? 'trusted',
        value: sign(null, Buffer.from(digest, 'utf8'), trusted.privateKey).toString('base64'),
      },
    };
    const feed: PackFeedDocument = { schema_version: 1, packs: [], app: { versions: [appEntry] } };

    const verified = checkAppUpdateVerified(feed, '3.0.0', trusted.keys);
    expect(verified?.availableVersion).toBe('3.1.0');
    expect(verified?.downloadUrl).toBe('https://example.invalid/Setup-3.1.0.exe');

    // Untrusted key: NO notice at all (an unverifiable link is never shown).
    const stranger = makeTrusted();
    expect(checkAppUpdateVerified(feed, '3.0.0', stranger.keys)).toBeNull();
    // Older-or-equal versions: null.
    expect(checkAppUpdateVerified(feed, '3.1.0', trusted.keys)).toBeNull();
    // No app section: null.
    expect(checkAppUpdateVerified({ schema_version: 1, packs: [] }, '3.0.0', trusted.keys)).toBeNull();
  });
});
