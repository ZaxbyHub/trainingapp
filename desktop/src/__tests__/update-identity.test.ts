// update-identity.test.ts — the post-install identity check of
// applyPackUpdate (issue #278, AC7 / Fix A3).
//
// RED at base, GREEN after the fix. A verified download can still be
// installed as a DIFFERENT pack (or version) by the loopback install leg;
// applyPackUpdate must compare the installed identity against the requested
// candidate and return applied:false with a reason naming BOTH identities
// and disclosing that removal of the substituted pack is left to the caller.
// Legs: a stub installPack dependency, and the REAL loopbackPackInstaller
// parsing pack_id from the loopback route's response.
import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  applyPackUpdate,
  loopbackPackInstaller,
  type FeedVersionEntry,
  type PackUpdateCandidate,
  type TrustedKey,
} from '../../main/update-checker.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

function makeTrusted(): {
  keys: TrustedKey[];
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keys: [{ key_id: 'identity-test', public_key: Buffer.from(der).toString('base64') }],
    privateKey,
  };
}

const CANDIDATE: PackUpdateCandidate = {
  packId: 'wanted-pack',
  currentVersion: '1.0.0',
  availableVersion: '2.0.0',
  publishedAt: '2026-09-27T00:00:00Z',
  downloadUrl: 'https://example.invalid/wanted-pack-2.0.0.zip',
  sha256: '',
  sizeBytes: 0,
};

function signedEntryFor(
  artifact: Uint8Array,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): FeedVersionEntry {
  const digest = sha256Hex(artifact);
  return {
    version: '2.0.0',
    published_at: '2026-09-27T00:00:00Z',
    sha256: digest,
    size_bytes: artifact.byteLength,
    download_url: CANDIDATE.downloadUrl,
    signature: {
      algorithm: 'ed25519',
      key_id: 'identity-test',
      value: sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
    },
  };
}

describe('update apply identity check (issue #278)', () => {
  it('stub installer: a substituted identity returns applied:false naming both identities', async () => {
    const { keys, privateKey } = makeTrusted();
    const artifact = new Uint8Array(Buffer.from('identity-test artifact bytes', 'utf8'));
    const entry = signedEntryFor(artifact, privateKey);
    const downloadArtifact = vi.fn(async () => artifact);
    const installPack = vi.fn(async () => ({ packId: 'impostor-pack', version: '9.9.9' }));

    const result = await applyPackUpdate(CANDIDATE, entry, { downloadArtifact, installPack }, keys);

    expect(installPack).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(false);
    expect(result.version).toBe('9.9.9');
    expect(result.reason).toContain('wanted-pack@2.0.0');
    expect(result.reason).toContain('impostor-pack@9.9.9');
    expect(result.reason).toMatch(/removal of the substituted pack is left to the caller/);
  });

  it('loopback installer: parses pack_id from the route response and the mismatch is reported', async () => {
    const { keys, privateKey } = makeTrusted();
    const artifact = new Uint8Array(Buffer.from('loopback identity artifact', 'utf8'));
    const entry = signedEntryFor(artifact, privateKey);

    let sawToken = false;
    const server: Server = createServer((req, res) => {
      sawToken = req.headers['x-test-token'] === 'launch-token';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          pack_id: 'shipped-pack',
          version: '1.2.3',
          docs_installed: 1,
          chunks_added: 1,
          superseded: [],
          warnings: [],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
      expect(address !== null && typeof address === 'object').toBe(true);
      const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
      const installer = loopbackPackInstaller(baseUrl, 'launch-token', 'x-test-token');

      // The production install leg returns the route's identity verbatim
      // (pack_id is required by the OpenAPI InstallPackResponse).
      const installed = await installer(artifact, 'wanted-pack-2.0.0.zip');
      expect(installed).toEqual({ packId: 'shipped-pack', version: '1.2.3' });
      expect(sawToken).toBe(true);

      const result = await applyPackUpdate(CANDIDATE, entry, {
        downloadArtifact: vi.fn(async () => artifact),
        installPack: installer,
      }, keys);
      expect(result.applied).toBe(false);
      expect(result.version).toBe('1.2.3');
      expect(result.reason).toContain('wanted-pack@2.0.0');
      expect(result.reason).toContain('shipped-pack@1.2.3');
      expect(result.reason).toMatch(/removal of the substituted pack is left to the caller/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('guardrail: the widened ApplyUpdateDeps.installPack contract carries packId (matching identity still applies)', async () => {
    const { keys, privateKey } = makeTrusted();
    const artifact = new Uint8Array(Buffer.from('identity-match artifact', 'utf8'));
    const entry = signedEntryFor(artifact, privateKey);
    const installPack = vi.fn(async () => ({ packId: 'wanted-pack', version: '2.0.0' }));
    const result = await applyPackUpdate(
      CANDIDATE,
      entry,
      { downloadArtifact: vi.fn(async () => artifact), installPack },
      keys,
    );
    expect(result.applied).toBe(true);
    expect(result.version).toBe('2.0.0');
    expect(result.reason).toBeUndefined();
  });
});
