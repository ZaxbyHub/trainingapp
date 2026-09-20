/**
 * Test-only helpers for pack-detection coverage (ADR-0009 PoC, issue #76).
 *
 * jsdom (this version) does not implement `Blob.prototype.arrayBuffer`,
 * which jsdom-run tests need because `isKnowledgePackZip` reads the dropped
 * file's bytes through the same API real browsers provide. The helper
 * attaches a per-instance override built from the very bytes the test passed
 * in — byte-honest (no jsdom internals, no re-encoding) and inert wherever a
 * real `arrayBuffer` exists (e.g. Playwright chromium).
 */

export function fileFromBytes(bytes: Uint8Array, name: string, type = 'application/zip'): File {
  const copy = new Uint8Array(bytes);
  const ownBuffer = copy.slice().buffer as ArrayBuffer;
  const file = new File([copy], name, { type });
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(ownBuffer),
      configurable: true,
    });
  }
  return file;
}
