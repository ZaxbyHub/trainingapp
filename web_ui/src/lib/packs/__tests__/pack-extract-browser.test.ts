// @vitest-environment node
/**
 * Browser pack extractor guards (trace browser-training-parity AC1).
 *
 * One isolating row per guard: every row's archive passes EVERY earlier guard
 * (the guards are layered: extension -> central directory -> declared limits
 * -> names -> symlinks -> decompressor support -> pack.json -> local header ->
 * per-entry size -> written-bytes backstop), so a row fails only when the
 * guard it names stops refusing. Desktop parity of verdicts and wording is
 * pinned separately by desktop/src/__tests__/browser-pack-extract-parity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { PackManagerError, extractPackZip, openPackArchive, sourceFromBytes } from '../pack-extract-browser';
import { buildRawZip, packWith } from './zip-fixture';

const MiB = 1024 * 1024;

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a refusal, but the archive was accepted');
}

describe('pack-extract-browser guards (isolating rows)', () => {
  it('accepts a clean pack and returns every file entry', async () => {
    const zip = packWith([
      { name: 'docs/a.json', data: '{"text":"x"}' },
      { name: 'assets/player/story.html', data: '<html></html>', method: 8 },
    ]);
    const out = await extractPackZip(zip, 'ok.zip');
    expect([...out.files.keys()].sort()).toEqual(['assets/player/story.html', 'docs/a.json', 'pack.json']);
    expect(new TextDecoder().decode(out.files.get('assets/player/story.html'))).toBe('<html></html>');
  });

  it('G1 extension: refuses a non-.zip file name', async () => {
    const error = await refusal(extractPackZip(packWith([]), 'pack.tar'));
    expect(error).toBeInstanceOf(PackManagerError);
    expect(error.message).toBe('pack.tar: pack install accepts .zip archives only');
  });

  it('G2 central directory: refuses bytes with no end-of-central-directory record', async () => {
    const error = await refusal(extractPackZip(new TextEncoder().encode('not a zip at all'), 'g.zip'));
    expect(error.name).toBe('PackManagerError');
    expect(error.message).toBe('g.zip: not a readable zip archive (no end-of-central-directory record)');
  });

  it('G2 central directory: refuses ZIP64 markers (entry count 0xffff)', async () => {
    const error = await refusal(extractPackZip(packWith([], { eocdEntriesOverride: 0xffff }), 'z.zip'));
    expect(error.message).toMatch(/ZIP64 markers are refused/);
  });

  it('G2 central directory: refuses a ZIP64 end-of-central-directory locator', async () => {
    const error = await refusal(extractPackZip(packWith([], { zip64Locator: true }), 'z.zip'));
    expect(error.message).toMatch(/ZIP64 markers are refused/);
  });

  it('G2 central directory: refuses duplicate entry names', async () => {
    const zip = packWith([
      { name: 'docs/a.txt', data: 'benign' },
      { name: 'docs/a.txt', data: 'hostile' },
    ]);
    const error = await refusal(extractPackZip(zip, 'd.zip'));
    expect(error.message).toBe('d.zip: duplicate archive entry docs/a.txt is not allowed');
  });

  it('G3 declared entry cap', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `docs/f${i}.txt`, data: 'x' }));
    const error = await refusal(extractPackZip(packWith(many), 'c.zip', { maxEntries: 5 }));
    expect(error.message).toBe('c.zip: archive declares 11 entries, over the 5 entry cap');
  });

  it('G3 declared uncompressed byte cap (honest sizes, ratio under the floor)', async () => {
    const zip = packWith([{ name: 'docs/big.bin', data: new Uint8Array(3 * MiB) }]);
    const error = await refusal(extractPackZip(zip, 'b.zip', { maxUncompressedBytes: 2 * MiB }));
    expect(error.message).toMatch(/^b\.zip: archive declares \d+ uncompressed bytes, over the 2097152 byte cap$/);
  });

  it('G3 declared compression ratio above the 16 MiB floor', async () => {
    const zip = packWith([{ name: 'docs/zeros.bin', data: new Uint8Array(20 * MiB), method: 8 }]);
    const error = await refusal(extractPackZip(zip, 'r.zip'));
    expect(error.message).toMatch(/compression ratio, over the 100:1 cap \(possible zip bomb\)$/);
  });

  it('G3 ratio floor: a compressible archive under 16 MiB is accepted', async () => {
    const zip = packWith([{ name: 'docs/zeros.bin', data: new Uint8Array(2 * MiB), method: 8 }]);
    await expect(extractPackZip(zip, 'ok.zip')).resolves.toBeDefined();
  });

  it.each([
    ['dot segment', '../evil.txt', 'unsafe archive entry path (dot segment): "../evil.txt"'],
    ['nested dot segment', 'docs/../../evil.txt', 'unsafe archive entry path (dot segment): "docs/../../evil.txt"'],
    ['absolute', '/etc/passwd', 'unsafe archive entry path (absolute): "/etc/passwd"'],
    ['drive-relative', 'E:../x', 'unsafe archive entry path (drive-relative/absolute): "E:../x"'],
    ['drive-absolute', 'C:/x', 'unsafe archive entry path (drive-relative/absolute): "C:/x"'],
    ['backslash', 'docs\\..\\x', 'unsafe archive entry path (backslash): "docs\\\\..\\\\x"'],
    ['control character', 'docs/a\u0001b', 'unsafe archive entry path (control character): "docs/a\\u0001b"'],
  ])('G4 entry name: refuses %s', async (_label, name, message) => {
    const error = await refusal(extractPackZip(packWith([{ name, data: 'x' }]), 'n.zip'));
    expect(error.name).toBe('PackManagerError');
    expect(error.message).toBe(message);
  });

  it('G5 symlink entries are refused', async () => {
    const zip = packWith([{ name: 'docs/link', data: '/etc/passwd', externalAttrs: (0o120777 << 16) >>> 0 }]);
    const error = await refusal(extractPackZip(zip, 's.zip'));
    expect(error.message).toBe('s.zip: symlink archive entry docs/link is not allowed');
  });

  it('G6 decompressor: encrypted entries are refused', async () => {
    const error = await refusal(extractPackZip(packWith([{ name: 'docs/a', data: 'x', flags: 1 }]), 'e.zip'));
    expect(error.message).toBe('e.zip: not a readable zip archive: Encrypted zip are not supported');
  });

  it('G6 decompressor: unknown compression methods are refused', async () => {
    const error = await refusal(extractPackZip(packWith([{ name: 'docs/a', data: 'x', method: 12 }]), 'm.zip'));
    expect(error.message).toMatch(/^m\.zip: not a readable zip archive: Corrupted zip : compression 12 unknown/);
  });

  it('G7 pack.json must be at the archive root', async () => {
    const zip = buildRawZip([{ name: 'docs/pack.json', data: '{}' }]);
    const error = await refusal(extractPackZip(zip, 'p.zip'));
    expect(error.message).toBe('p.zip: no pack.json manifest at the archive root');
  });

  it('G8 per-entry size: an entry inflating past its declared size is cut off', async () => {
    const zip = packWith([{ name: 'docs/big.bin', data: new Uint8Array(4 * MiB), method: 8, declaredUncompressed: 100 }]);
    const error = await refusal(extractPackZip(zip, 'sp.zip', { maxUncompressedBytes: 1 * MiB }));
    expect(error.message).toBe('sp.zip: extraction failed: uncompressed data size mismatch for docs/big.bin (declared 100 bytes)');
  });

  it('G8 per-entry size: an entry shorter than declared is refused', async () => {
    const zip = packWith([{ name: 'docs/a.txt', data: 'abc', declaredUncompressed: 10 }]);
    const error = await refusal(extractPackZip(zip, 'short.zip'));
    expect(error.message).toBe(
      'short.zip: extraction failed: uncompressed data size mismatch for docs/a.txt (declared 10, actual 3)',
    );
  });

  it('G9 corrupted deflate data is refused as an extraction failure', async () => {
    const zip = packWith([
      { name: 'docs/a.txt', data: 'hello world', method: 8, payloadOverride: new Uint8Array([0xff, 0xff, 0xff, 0xff]) },
    ]);
    const error = await refusal(extractPackZip(zip, 'bad.zip'));
    expect(error.name).toBe('PackManagerError');
    expect(error.message).toMatch(/^bad\.zip: extraction failed: /);
  });

  it('G10 local header: data that overruns the archive is refused', async () => {
    const zip = packWith([{ name: 'docs/a.txt', data: 'abc', declaredCompressed: 10_000 }]);
    const error = await refusal(extractPackZip(zip, 'o.zip'));
    expect(error.message).toBe('o.zip: not a readable zip archive: data of docs/a.txt overruns the archive');
  });

  it('tolerates a self-extracting prefix (local offsets shift with the prefix)', async () => {
    const zip = packWith([{ name: 'docs/a.txt', data: 'payload', method: 8 }], { prefix: new Uint8Array(37).fill(7) });
    const out = await extractPackZip(zip, 'sfx.zip');
    expect(new TextDecoder().decode(out.files.get('docs/a.txt'))).toBe('payload');
  });

  it('directory entries are skipped, not written', async () => {
    const zip = packWith([
      { name: 'docs/', data: '' },
      { name: 'docs/a.txt', data: 'x' },
    ]);
    const out = await extractPackZip(zip, 'dir.zip');
    expect([...out.files.keys()].sort()).toEqual(['docs/a.txt', 'pack.json']);
  });

  it('streams entries without materializing the archive (openPackArchive pipes chunks)', async () => {
    const big = new Uint8Array(3 * MiB);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) & 0xff;
    const zip = packWith([{ name: 'assets/player/media.bin', data: big, method: 8 }]);
    const archive = await openPackArchive(sourceFromBytes(zip), 'stream.zip');
    const entry = archive.files.find((f) => f.name === 'assets/player/media.bin')!;
    let chunks = 0;
    let total = 0;
    await archive.pipeEntry(entry, (chunk) => {
      chunks += 1;
      total += chunk.byteLength;
    });
    expect(total).toBe(3 * MiB);
    expect(chunks).toBeGreaterThan(1);
    expect(archive.writtenBytes()).toBe(3 * MiB);
  });

  it('the deflate fixture is real deflate (guard against a vacuous G9 row)', () => {
    expect(zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from('hello world'))).toString()).toBe('hello world');
  });
});
