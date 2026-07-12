/**
 * Tests for the Git-LFS pointer detection helper (scripts/lib/lfs-detect.mjs).
 *
 * Regression coverage for issue #20 finding #2: prepare-models must FAIL LOUDLY
 * (non-zero exit) when a required weight file is an LFS pointer stub instead of
 * the real binary, rather than silently copying garbage into public/models/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLfsPointer, LFS_POINTER_PREFIX } from './lfs-detect.mjs';

describe('isLfsPointer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lfs-detect-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects a real Git-LFS pointer stub', () => {
    const file = join(dir, 'model.onnx');
    // A realistic pointer: the header line + oid + size, ~134 bytes.
    writeFileSync(
      file,
      `${LFS_POINTER_PREFIX}\noid sha256:828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35\nsize 133093490\n`
    );
    expect(isLfsPointer(file)).toBe(true);
  });

  it('returns false for a real ONNX binary (protobuf header)', () => {
    const file = join(dir, 'model.onnx');
    // ONNX files start with the protobuf marker 0x08, not the LFS header.
    writeFileSync(file, Buffer.from([0x08, 0x05, 0x12, 0x0b, ...Buffer.from('ir_version')]));
    expect(isLfsPointer(file)).toBe(false);
  });

  it('returns false for a real GGUF file (magic 0x46554747 "GGUF")', () => {
    const file = join(dir, 'model.gguf');
    writeFileSync(file, Buffer.from([0x47, 0x47, 0x55, 0x46, 0x03, 0x00, 0x00, 0x00]));
    expect(isLfsPointer(file)).toBe(false);
  });

  it('returns false for arbitrary text content', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"vocab_size": 30522}');
    expect(isLfsPointer(file)).toBe(false);
  });

  it('returns false for a file shorter than the LFS header', () => {
    const file = join(dir, 'tiny.bin');
    writeFileSync(file, 'version');
    expect(isLfsPointer(file)).toBe(false);
  });

  it('returns false when the file does not exist', () => {
    expect(isLfsPointer(join(dir, 'nope.onnx'))).toBe(false);
  });
});
