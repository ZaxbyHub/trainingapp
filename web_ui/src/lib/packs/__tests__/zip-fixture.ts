// Test-only raw zip writer (node:zlib). JSZip normalizes hostile entry names
// away, so attack archives are written byte by byte. Mirrors the writer in
// desktop/src/__tests__/c8-pack-security.test.ts.
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

export function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export interface RawEntry {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8 | number;
  externalAttrs?: number;
  /** Spoof the central-directory uncompressed size. */
  declaredUncompressed?: number;
  /** Spoof the central-directory compressed size. */
  declaredCompressed?: number;
  /** General-purpose flags (bit 0 = encrypted). */
  flags?: number;
  /** Replace the stored payload bytes (e.g. corrupt deflate data). */
  payloadOverride?: Uint8Array;
  /** Host system byte of "version made by" (0 DOS, 3 UNIX). */
  madeBy?: number;
}

export interface RawZipOptions {
  /** Bytes prepended to the archive (self-extracting prefix). */
  prefix?: Uint8Array;
  /** Override EOCD fields to model ZIP64 markers. */
  eocdEntriesOverride?: number;
  zip64Locator?: boolean;
  comment?: string;
}

const enc = new TextEncoder();
const bytesOf = (d: Uint8Array | string): Uint8Array => (typeof d === 'string' ? enc.encode(d) : d);

export function buildRawZip(entries: RawEntry[], options: RawZipOptions = {}): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const prefix = Buffer.from(options.prefix ?? new Uint8Array());
  let offset = 0;
  const records: Array<{ name: Buffer; e: RawEntry; crc: number; csize: number; usize: number; offset: number; method: number }> = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.method ?? 0;
    const data = Buffer.from(bytesOf(e.data));
    const payload = e.payloadOverride
      ? Buffer.from(e.payloadOverride)
      : method === 8
        ? zlib.deflateRawSync(data, { level: 9 })
        : data;
    const crc = crc32(data);
    const usize = e.declaredUncompressed ?? data.length;
    const csize = e.declaredCompressed ?? payload.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, name, payload);
    records.push({ name, e, crc, csize, usize, offset, method });
    offset += 30 + name.length + payload.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const r of records) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(((r.e.madeBy ?? 0) << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(r.e.flags ?? 0, 8);
    ch.writeUInt16LE(r.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(r.crc, 16);
    ch.writeUInt32LE(r.csize, 20);
    ch.writeUInt32LE(r.usize, 24);
    ch.writeUInt16LE(r.name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(r.e.externalAttrs ?? ((0o100644 << 16) >>> 0), 38);
    ch.writeUInt32LE(r.offset, 42);
    central.push(ch, r.name);
    cdSize += 46 + r.name.length;
  }
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const tail: Buffer[] = [];
  if (options.zip64Locator) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    tail.push(locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = options.eocdEntriesOverride ?? records.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  // With a zip64 locator inserted, the CD is followed by 20 extra bytes; the
  // declared CD size still covers only the headers.
  eocd.writeUInt32LE(cdSize + (options.zip64Locator ? 20 : 0), 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([prefix, ...parts, ...central, ...tail, eocd, comment]));
}

export const PACK_JSON_STUB = JSON.stringify({ id: 'stub', version: '1.0.0', docs: [] });

/** A minimal archive with a root pack.json plus `extra` entries. */
export function packWith(extra: RawEntry[], options: RawZipOptions = {}): Uint8Array<ArrayBuffer> {
  return buildRawZip([{ name: 'pack.json', data: PACK_JSON_STUB }, ...extra], options);
}
