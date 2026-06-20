/**
 * Tests for image attachment validation + downscale math (pure functions).
 */

import { describe, it, expect } from 'vitest';
import {
  validateImageFile,
  fitWithin,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIM,
} from './image-input';

function makeFile(bytes: number, type: string, name = 'shot.png'): File {
  // A File whose reported size is `bytes` (content length matches).
  const blob = new Uint8Array(Math.max(0, bytes));
  return new File([blob], name, { type });
}

describe('validateImageFile', () => {
  it('accepts a normal PNG within limits', () => {
    expect(validateImageFile(makeFile(1024, 'image/png'))).toEqual({ valid: true });
  });

  it('accepts JPEG, WebP, and GIF', () => {
    for (const t of ['image/jpeg', 'image/webp', 'image/gif']) {
      expect(validateImageFile(makeFile(1024, t)).valid).toBe(true);
    }
  });

  it('rejects an unsupported type', () => {
    const r = validateImageFile(makeFile(1024, 'image/bmp'));
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unsupported/i);
  });

  it('rejects a non-image type (e.g. pdf)', () => {
    expect(validateImageFile(makeFile(1024, 'application/pdf')).valid).toBe(false);
  });

  it('rejects an oversized image', () => {
    const r = validateImageFile(makeFile(MAX_IMAGE_BYTES + 1, 'image/png'));
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/too large/i);
  });

  it('rejects an empty file', () => {
    const r = validateImageFile(makeFile(0, 'image/png'));
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/empty/i);
  });

  it('honors custom limits', () => {
    expect(validateImageFile(makeFile(100, 'image/png'), { maxBytes: 50 }).valid).toBe(false);
    expect(validateImageFile(makeFile(100, 'image/svg+xml'), { allowed: ['image/svg+xml'] }).valid).toBe(true);
  });
});

describe('fitWithin', () => {
  it('leaves small images unchanged', () => {
    expect(fitWithin(800, 600, MAX_IMAGE_DIM)).toEqual({ width: 800, height: 600 });
  });

  it('downscales by the longest edge, preserving aspect ratio', () => {
    expect(fitWithin(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
    expect(fitWithin(1024, 2048, 1024)).toEqual({ width: 512, height: 1024 });
  });

  it('never returns a zero dimension', () => {
    const r = fitWithin(4000, 1, 1024);
    expect(r.width).toBe(1024);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});
