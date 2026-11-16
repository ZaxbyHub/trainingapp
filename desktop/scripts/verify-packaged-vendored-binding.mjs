#!/usr/bin/env node
// verify-packaged-vendored-binding.mjs — issue #350 packaged-bytes gate.
//
// Review finding dependencies-build-release-001 (swarm-pr-review run
// pr-review-pr352-20261115, critic-UPHELD and WIDENED): nothing tied the
// PACKAGED bytes to the vendored patch. PRISTINE.sha256 deliberately pins the
// UNPATCHED upstream hash, the dev-time drift row compares the INSTALLED file
// (not the archive), and the only executed packaged proof was a one-off local
// asar extraction. The critic widened the impact: a silently-dropped files[]
// remap ships an app whose getLlama import fails, yet the GPU-less smoke still
// passes (the probe child posts ok:false and exits 0) — so a missing remap
// could ship green.
//
// This gate extracts the remapped module from the packaged app.asar and
// byte-compares it with the repo's vendored copy. It fails on a missing
// archive, a missing entry, or any byte difference.
//
// Dependency-free by design: @electron/asar is only transitively hoisted into
// node_modules (never declared), so a committed CI gate must not require it.
// The asar layout read here is [uint32 payloadSize][uint32 jsonLength][JSON
// header][file data]; each file entry carries {offset, size} relative to the
// data start (verified against @electron/asar's own reader in
// desktop/src/__tests__/verify-packaged-vendored-binding.test.ts).
//
// Usage: node desktop/scripts/verify-packaged-vendored-binding.mjs [asarPath]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ASAR = path.join(desktopRoot, 'desktop-release', 'win-unpacked', 'resources', 'app.asar');
const ENTRY = 'node_modules/node-llama-cpp/dist/bindings/utils/testBindingBinary.js';
const VENDOR = path.join(desktopRoot, 'vendor', 'node-llama-cpp', 'testBindingBinary.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Read one file entry out of an asar archive without any dependency. */
function readAsarFile(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(8);
    if (fs.readSync(fd, prefix, 0, 8, null) !== 8) {
      throw new Error('unable to read the asar header size');
    }
    // Layout: [uint32 4][uint32 headerPayloadSize][pickled header JSON][file data].
    // The header payload is a pickled string: [uint32 jsonLength][JSON bytes].
    // Offsets in the JSON are relative to the data start and may be strings.
    const payloadSize = prefix.readUInt32LE(4);
    const payload = Buffer.alloc(payloadSize);
    if (fs.readSync(fd, payload, 0, payloadSize, 8) !== payloadSize) {
      throw new Error('unable to read the asar header');
    }
    const jsonLength = payload.readUInt32LE(4);
    const header = JSON.parse(payload.subarray(8, 8 + jsonLength).toString('utf8'));
    // Archives written on Windows carry backslash-separated keys; normalize
    // both sides so one reader works for every platform's archive.
    const normalize = (node) => {
      const out = {};
      for (const [key, value] of Object.entries(node.files ?? {})) {
        out[key.replace(/\\/g, '/')] = value.files ? normalize(value) : value;
      }
      return out;
    };
    let node = normalize(header);
    for (const part of entryPath.split(/[\\/]+/).filter(Boolean)) {
      const next = node[part];
      if (next === undefined) throw new Error(`entry not found in the archive: ${entryPath}`);
      node = next;
    }
    const offset = typeof node.offset === 'string' ? Number(node.offset) : node.offset;
    const size = typeof node.size === 'string' ? Number(node.size) : node.size;
    if (!Number.isFinite(offset) || !Number.isFinite(size)) {
      throw new Error(`entry is not a regular file: ${entryPath}`);
    }
    const dataStart = 8 + payloadSize;
    const buf = Buffer.alloc(size);
    if (fs.readSync(fd, buf, 0, size, dataStart + offset) !== size) {
      throw new Error('short read while extracting the entry');
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

const asarPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ASAR;
let failed = false;
const fail = (message) => {
  console.error(`vendored-binding-check: ${message}`);
  failed = true;
};

if (!fs.existsSync(asarPath)) fail(`packaged app.asar not found at ${asarPath} (run the desktop build first)`);
if (!fs.existsSync(VENDOR)) fail(`vendored copy not found at ${VENDOR}`);

if (!failed) {
  let packaged;
  try {
    packaged = readAsarFile(asarPath, ENTRY);
  } catch (err) {
    fail(`${ENTRY} is missing from ${asarPath}: ${err.message}`);
  }
  if (packaged !== undefined) {
    const expected = fs.readFileSync(VENDOR);
    if (sha256(packaged) !== sha256(expected)) {
      fail(
        `packaged bytes differ from the vendored copy (packaged sha256 ${sha256(packaged)}, ` +
        `vendored ${sha256(expected)}) — the electron-builder files[] remap is not shipping the patch`,
      );
    } else {
      console.log(`vendored-binding-check: the packaged ${ENTRY} byte-matches the repo copy (sha256 ${sha256(packaged)})`);
    }
  }
}

process.exit(failed ? 1 : 0);
