/**
 * C8 (issue #75): packtool verify archive-safety gate — the verifier must
 * enforce the same raw-archive rules as the install paths (traversal entry
 * names incl. drive-relative variants, symlink entries, entry counts, and
 * declared size/ratio limits) even though it never extracts.
 * Constants mirror the frozen C11/C2/C3 drivers.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  assertArchiveSafety,
  VERIFY_MAX_ENTRIES,
} from '../../build/zip-safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKTOOL_ROOT = path.resolve(HERE, '..', '..');

/** Minimal zip writer ported from the frozen C11 driver (exact control
 * over entry names; zlib for deflate) so hostile names survive verbatim. */
import zlib from 'node:zlib';
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
interface ZipEntry { name: string; data: Buffer; method?: number }
function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Array<{ name: Buffer; method: number; crc: number; csize: number; usize: number; offset: number }> = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const payload = e.method === 8 ? zlib.deflateRawSync(e.data, { level: 9 }) : Buffer.from(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(e.method ?? 0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, payload);
    central.push({ name, method: e.method ?? 0, crc, csize: payload.length, usize: e.data.length, offset });
    offset += 30 + name.length + payload.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(c.method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.csize, 20); ch.writeUInt32LE(c.usize, 24);
    ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0o100644, 38); ch.writeUInt32LE(c.offset, 42);
    parts.push(ch, c.name);
    cdSize += 46 + c.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

describe('packtool verify archive safety (issue #75)', () => {
  it('rejects drive-relative traversal entries', () => {
    const zip = buildZip([
      { name: 'pack.json', data: Buffer.from('{"id":"x"}') },
      { name: 'E:../p75escape.txt', data: Buffer.from('pwn') },
    ]);
    const p = path.join(PACKTOOL_ROOT, '.agents-tmp', 'traversal.zip');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zip);
    expect(() => assertArchiveSafety(p)).toThrow(/unsafe archive entry path/);
  });

  it('rejects symlink-mode entries', () => {
    const buf = buildZip([{ name: 'pack.json', data: Buffer.from('{"id":"x"}') }]);
    // single entry: central header starts right before the 22-byte EOCD;
    // external attrs live at offset 38 inside the 46-byte central header
    const cdStart = buf.length - 22 - (46 + 'pack.json'.length);
    buf.writeUInt32LE((0o120777 << 16) >>> 0, cdStart + 38);
    const p = path.join(PACKTOOL_ROOT, '.agents-tmp', 'symlink.zip');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    expect(() => assertArchiveSafety(p)).toThrow(/symlink archive entry/);
  });

  it('rejects archives over the entry cap', () => {
    const entries = [{ name: 'pack.json', data: Buffer.from('{"id":"x"}') }];
    for (let i = 0; i < VERIFY_MAX_ENTRIES; i += 1) {
      entries.push({ name: `docs/f${i}.txt`, data: Buffer.from('x') });
    }
    const zip = buildZip(entries);
    const p = path.join(PACKTOOL_ROOT, '.agents-tmp', 'entries.zip');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zip);
    expect(() => assertArchiveSafety(p)).toThrow(/entry cap/);
  });

  it('refuses ZIP64 markers explicitly', () => {
    const buf = buildZip([{ name: 'pack.json', data: Buffer.from('{"id":"x"}') }]);
    // mark the EOCD total-entry fields as ZIP64 sentinels
    buf.writeUInt16LE(0xffff, buf.length - 22 + 10);
    const p = path.join(PACKTOOL_ROOT, '.agents-tmp', 'zip64.zip');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    expect(() => assertArchiveSafety(p)).toThrow(/ZIP64/);
  });

  it('accepts a normal small archive', () => {
    const zip = buildZip([
      { name: 'pack.json', data: Buffer.from('{"id":"x"}') },
      { name: 'docs/a.json', data: Buffer.from('{"title":"t"}') },
    ]);
    const p = path.join(PACKTOOL_ROOT, '.agents-tmp', 'good.zip');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zip);
    expect(() => assertArchiveSafety(p)).not.toThrow();
  });

  it('end-to-end: verify rejects a valid pack with a hostile extra entry', async () => {
    // Build a minimal valid pack dir, zip it with a hostile extra entry, and
    // run the built CLI. JSZip preserves drive-relative names here.
    (async () => {})();
    const work = path.join(PACKTOOL_ROOT, '.agents-tmp', 'e2e');
    fs.mkdirSync(path.join(work, 'src', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(work, 'src', 'docs', 'a.json'),
      JSON.stringify({ title: 't', text: 'hello' }),
    );
    const build = spawnSync(
      process.execPath,
      [path.join(PACKTOOL_ROOT, 'dist', 'cli.js'), 'build-docs',
        path.join(work, 'src'), '--id', 'p75e2e', '--name', 'p75e2e',
        '--out', path.join(work, 'pack'), '--embedder', 'hash'],
      { encoding: 'utf8' },
    );
    if (build.status !== 0) {
      throw new Error(`build-docs failed: ${build.stderr || build.stdout}`);
    }
    // build-docs --out emits a single zip FILE
    const packArtifact = path.join(work, 'pack');
    const base = await JSZip.loadAsync(fs.readFileSync(packArtifact));
    const evil = new JSZip();
    for (const [name, entry] of Object.entries(base.files)) {
      if (!entry.dir) evil.file(name, await entry.async('nodebuffer'));
    }
    evil.file('E:../p75e2e-escape.txt', 'pwn');
    const evilPath = path.join(work, 'evil.zip');
    // write synchronously through the generated buffer
    return evil.generateAsync({ type: 'nodebuffer' }).then((buf) => {
      fs.writeFileSync(evilPath, buf);
      const verify = spawnSync(
        process.execPath,
        [path.join(PACKTOOL_ROOT, 'dist', 'cli.js'), 'verify', evilPath],
        { encoding: 'utf8' },
      );
      expect(verify.status).not.toBe(0);
      expect(`${verify.stdout}\n${verify.stderr}`).toMatch(/unsafe archive entry path/);
    });
  });
});
