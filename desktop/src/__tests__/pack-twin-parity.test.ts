// pack-twin-parity.test.ts — issue #213 (batch
// batch-143-203-204-212-213-215): the pack-security rules exist in three
// implementations (desktop extractor, packtool verifier, python
// pack_extract.py) plus two comment-coupled semantics mirrors. These pins
// make the duplication executable: a security-relevant change cannot land in
// one implementation and silently not the others.
//
// rows:
//   limits-twin         — zip size/entry/ratio limits + the ratio floor agree
//                         across the three literal homes (numeric evaluation;
//                         the desktop home is pack-archive-rules.ts, NOT the
//                         pack-extract.ts re-exports).
//   signature-gate-twin — the two TS gates the issue names (packtool's
//                         verify.ts gate, implementation in pack-json.ts, and
//                         the install-side pack-extract.ts gate) accept/reject
//                         the SAME fixture matrix.
//   ordering-twin       — each side's validation-phase order satisfies ONE
//                         canonical expectation (never side-vs-side), and
//                         api_server.py::_extract_pack_zip delegates to
//                         pack_extract.safe_extract_pack_zip.
//   multi-key-divergence-pinned — deliberate change-detector for the known
//                         TS↔python key_id-matching divergence (NOT part of
//                         the frozen battery): both TS twins take first-match
//                         while python loops every trusted key sharing the
//                         key_id. Scope: issue #213 says "Out: changing any
//                         limit value or gate semantics", so reconciliation is
//                         filed at closeout as the follow-up ("Follow-up from the
//                         batch PR: reconcile the TS signature gates to
//                         python's all-keys-per-key_id verification"); first-
//                         match is the false-reject side, so TS adopts
//                         python's loop when that lands. This row asserts
//                         today's state so neither side can drift unnoticed.
//
// Named mutants: change VERIFY_MAX_ENTRIES 5000 to 5001 (or one side's
// RATIO_FLOOR_BYTES) -> limits-twin red; flip one TS gate's key-id handling
// -> signature-gate-twin red; reverse either side's validation-phase order
// -> ordering-twin red.
import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_PACKS_MAX_ENTRIES,
  DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
  RATIO_FLOOR_BYTES as DESKTOP_RATIO_FLOOR,
} from '../../main/backend/packs/pack-archive-rules.js';
import {
  safeEntryName,
  DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES as EXTRACT_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_PACKS_MAX_ENTRIES as EXTRACT_MAX_ENTRIES,
  DEFAULT_PACKS_MAX_COMPRESSION_RATIO as EXTRACT_MAX_COMPRESSION_RATIO,
} from '../../main/backend/packs/pack-extract.js';
import {
  canonicalManifestBytes as desktopCanonical,
  verifyPackSignature as desktopVerify,
} from '../../main/backend/packs/pack-extract.js';
import {
  VERIFY_MAX_ENTRIES,
  VERIFY_MAX_UNCOMPRESSED_BYTES,
  VERIFY_MAX_COMPRESSION_RATIO,
} from '../../../packtool/build/zip-safety.js';
import {
  canonicalManifestBytes as packtoolCanonical,
  verifyPackSignature as packtoolVerify,
} from '../../../packtool/build/pack-json.js';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    // Review PRR-024/UCR-04: stop at the checkout root — a marker-less
    // checkout must fail closed, never bind a foreign ancestor's marker.
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const ZIP_SAFETY_SRC = path.join(REPO_ROOT, 'packtool', 'build', 'zip-safety.ts');
const PACK_EXTRACT_SRC = path.join(REPO_ROOT, 'desktop', 'main', 'backend', 'packs', 'pack-extract.ts');
const PACK_JSON_SRC = path.join(REPO_ROOT, 'packtool', 'build', 'pack-json.ts');
const PY_EXTRACT_SRC = path.join(REPO_ROOT, 'pack_extract.py');
const API_SERVER_SRC = path.join(REPO_ROOT, 'api_server.py');

/** Numeric value of a `NAME = <expr>` declaration (TS const or python). */
function numericConst(sourcePath: string, name: string): number {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const matches = [
    ...source.matchAll(new RegExp(`^(?:(?:const|let|var)\\s+)?${name}\\s*=\\s*([^;\\n]+)`, 'gm')),
  ];
  if (matches.length === 0) {
    throw new Error(`${name} not found in ${sourcePath}`);
  }
  // Review PRR-025: EVERY definition must agree — first-occurrence-only
  // would let a second definition site diverge invisibly.
  const values = matches.map((m) => {
    const expr = m[1].trim();
    if (!/^[0-9.\s*+()]+$/.test(expr)) {
      throw new Error(`${name} in ${sourcePath} is not a plain numeric expression: ${expr}`);
    }
    // eslint-disable-next-line no-new-func
    return Number(new Function(`return (${expr});`)());
  });
  const first = values[0];
  for (const v of values) {
    if (v !== first) {
      throw new Error(`${name} in ${sourcePath} has divergent definitions: ${values.join(',')}`);
    }
  }
  return first;
}

describe('pack twin parity (issue #213)', () => {
  it('limits-twin: the zip safety limits agree across the three implementations', () => {
    // Desktop literal home (pack-archive-rules.ts) vs packtool vs python.
    expect(VERIFY_MAX_ENTRIES, 'entry cap: packtool vs desktop').toBe(DEFAULT_PACKS_MAX_ENTRIES);
    expect(VERIFY_MAX_UNCOMPRESSED_BYTES, 'byte cap: packtool vs desktop').toBe(
      DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
    );
    expect(VERIFY_MAX_COMPRESSION_RATIO, 'ratio cap: packtool vs desktop').toBe(
      DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
    );

    const pyUncompressed = numericConst(PY_EXTRACT_SRC, 'DEFAULT_MAX_UNCOMPRESSED_BYTES');
    const pyEntries = numericConst(PY_EXTRACT_SRC, 'DEFAULT_MAX_ENTRIES');
    const pyRatio = numericConst(PY_EXTRACT_SRC, 'DEFAULT_MAX_COMPRESSION_RATIO');
    expect(pyEntries, 'entry cap: python vs desktop').toBe(DEFAULT_PACKS_MAX_ENTRIES);
    expect(pyUncompressed, 'byte cap: python vs desktop').toBe(DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES);
    expect(pyRatio, 'ratio cap: python vs desktop').toBe(DEFAULT_PACKS_MAX_COMPRESSION_RATIO);

    // The AC's named third home is the pack-extract.ts re-export layer
    // (issue #213 claim 1) — pin the re-exported values themselves, so a
    // divergence authored AT the alias line (e.g. re-exporting a different
    // number) reddens here; the literal-home reads above cannot see it.
    expect(EXTRACT_MAX_ENTRIES, 'entry cap: pack-extract re-export vs rules home').toBe(
      DEFAULT_PACKS_MAX_ENTRIES,
    );
    expect(EXTRACT_MAX_UNCOMPRESSED_BYTES, 'byte cap: pack-extract re-export vs rules home').toBe(
      DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
    );
    expect(EXTRACT_MAX_COMPRESSION_RATIO, 'ratio cap: pack-extract re-export vs rules home').toBe(
      DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
    );

    // The ratio-floor trio governs WHEN the ratio cap engages — a one-sided
    // change alters enforcement and must go red here.
    const packtoolFloor = numericConst(ZIP_SAFETY_SRC, 'RATIO_FLOOR_BYTES');
    const pyFloor = numericConst(PY_EXTRACT_SRC, '_RATIO_FLOOR_BYTES');
    expect(packtoolFloor, 'ratio floor: packtool vs desktop').toBe(DESKTOP_RATIO_FLOOR);
    expect(pyFloor, 'ratio floor: python vs desktop').toBe(DESKTOP_RATIO_FLOOR);
  });

  it('signature-gate-twin: both TS signature gates decide the fixture matrix identically', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const otherSpki = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({ pack_id: 'parity-fixture', version: '1.0.0', documents: [] }),
    );
    const canonical = desktopCanonical(manifestBytes);
    const value = cryptoSign(null, canonical, privateKey).toString('base64');

    type Case = { name: string; signature: unknown; keys: Array<{ key_id: string; public_key: string }> };
    const keys = [{ key_id: 'k1', public_key: spki }];
    const cases: Case[] = [
      { name: 'valid signature', signature: { algorithm: 'ed25519', key_id: 'k1', value }, keys },
      { name: 'missing signature block', signature: undefined, keys },
      { name: 'algorithm mismatch', signature: { algorithm: 'rsa', key_id: 'k1', value }, keys },
      { name: 'missing key_id', signature: { algorithm: 'ed25519', value }, keys },
      { name: 'unknown key_id', signature: { algorithm: 'ed25519', key_id: 'nope', value }, keys },
      { name: 'missing value', signature: { algorithm: 'ed25519', key_id: 'k1' }, keys },
      { name: 'bad base64 value', signature: { algorithm: 'ed25519', key_id: 'k1', value: '!!not-base64!!' }, keys },
      {
        name: 'non-ed25519 SPKI in trusted key',
        signature: { algorithm: 'ed25519', key_id: 'k1', value },
        keys: [{ key_id: 'k1', public_key: Buffer.from('not a der key').toString('base64') }],
      },
      {
        // Both TS twins take the FIRST trusted key sharing the key_id, so a
        // signature produced by the second key is refused identically. (The
        // python gate differs — pinned as a documented divergence below.)
        name: 'two trusted keys sharing key_id, signed by the second',
        signature: { algorithm: 'ed25519', key_id: 'k1', value },
        keys: [
          { key_id: 'k1', public_key: otherSpki },
          { key_id: 'k1', public_key: spki },
        ],
      },
    ];

    for (const c of cases) {
      const packtool = packtoolVerify(manifestBytes, c.signature, c.keys);
      const desktop = desktopVerify(manifestBytes, c.signature, c.keys);
      expect(desktop.ok, `${c.name}: verdict parity`).toBe(packtool.ok);
      expect(desktop.detail, `${c.name}: detail parity`).toBe(packtool.detail);
    }
    // The positive case really is positive on both sides (the matrix is not
    // all-refuse), and the multi-key case is refused by both (first-match).
    expect(packtoolVerify(manifestBytes, cases[0].signature, cases[0].keys).ok).toBe(true);
    expect(desktopVerify(manifestBytes, cases[0].signature, cases[0].keys).ok).toBe(true);
    expect(desktopVerify(manifestBytes, cases[8].signature, cases[8].keys).ok).toBe(false);

    // The gate wrappers' optional-signature semantics stay twin-shaped:
    // python skips verification entirely when require_signature is off.
    const py = fs.readFileSync(PY_EXTRACT_SRC, 'utf8');
    expect(py, 'python gate must skip when require_signature is off').toMatch(
      /if not limits\.require_signature:\s*\n\s*return/,
    );
    const verifyTs = fs.readFileSync(path.join(REPO_ROOT, 'packtool', 'build', 'verify.ts'), 'utf8');
    // Review PRR-022 (+ critic round-1): pin the gate's exact CALL-FORM and
    // the positive-polarity requireSignature guard — a looser pair of regexes
    // is satisfied by an inverted condition (`!options?.requireSignature`)
    // and by any argument list.
    const verifyStripped = verifyTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(
      verifyStripped,
      "packtool's gate must invoke verifyPackSignature with the manifest, signature and keys",
    ).toMatch(/verifyPackSignature\(packJsonBytes, rawSignature, trustedKeys\)/);
    expect(
      verifyStripped,
      "packtool's gate must guard the verification behind a positive requireSignature check",
    ).toMatch(/if\s*\(\s*options\?\.requireSignature\s*===\s*true\)/);
  });

  it('ordering-twin: each side validates entry shape before manifest presence', () => {
    // ONE canonical expectation, both sides checked AGAINST it (never
    // side-vs-side): entry-name/duplicate refusals and symlink refusal happen
    // strictly BEFORE the manifest-presence check, so a hostile archive is
    // refused on its shape regardless of what it packs.
    //
    // Anchored on the ordered CALL occurrences inside the extraction flow
    // (reviewer round-1 critical: first-occurrence indexOf on bare names
    // anchored to the function DEFINITIONS, so reversing the phases inside
    // the extractor survived — the call-form literals below appear only in
    // the flow). Named mutant: move the manifest-presence check above the
    // entry-shape loop in either implementation -> this row must go red.
    // Comment-stripped slices anchored at the safest-first flow (review
    // PRR-021): `safeEntryName(entry.name)` also appears in the earlier
    // declared-metadata pre-filter, so a bare indexOf measured the wrong
    // loop — and raw source is comment-satisfiable (the M-C12 class).
    // Multi-syntax stripper (critic round-1: a `#`-only strip is a no-op on
    // the TypeScript slice, whose comments are `//` and `/* */`).
    const stripHash = (t: string): string =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(\/\/|#)[^\n]*/g, '');
    const rawJs = fs.readFileSync(PACK_EXTRACT_SRC, 'utf8');
    const jsIdx = rawJs.indexOf('// Safest-first ordering');
    expect(jsIdx, 'js: safest-first flow must exist').toBeGreaterThan(-1);
    const js = stripHash(rawJs.slice(jsIdx));
    const jsName = js.indexOf('safeEntryName(entry.name)');
    const jsSymlink = js.indexOf('isSymlinkEntry(unixPermissions)');
    const jsManifest = js.indexOf('missingManifestMessage(filename)');
    expect(jsName, 'js: entry-name refusal call present').toBeGreaterThan(-1);
    expect(jsSymlink, 'js: symlink refusal call present').toBeGreaterThan(-1);
    expect(jsManifest, 'js: manifest-presence call present').toBeGreaterThan(-1);
    expect(jsName, 'js: entry-name refusal call precedes manifest presence').toBeLessThan(jsManifest);
    expect(jsSymlink, 'js: symlink refusal call precedes manifest presence').toBeLessThan(jsManifest);
    // The shared rules module owns the JS duplicate-name refusal and is
    // reached through safeEntryName.
    const sharedRules = fs.readFileSync(
      path.join(REPO_ROOT, 'desktop', 'main', 'backend', 'packs', 'pack-archive-rules.ts'),
      'utf8',
    );
    expect(sharedRules, 'js: the shared rules refuse duplicate entry names').toMatch(
      /duplicate archive entry .* is not allowed/,
    );
    expect(safeEntryName('pack.json'), 'sanity: the rules are reachable from the extractor').toBe('pack.json');

    const rawPy = fs.readFileSync(PY_EXTRACT_SRC, 'utf8');
    const pyIdx = rawPy.indexOf('# Safest-first ordering');
    expect(pyIdx, 'py: safest-first flow must exist').toBeGreaterThan(-1);
    const py = stripHash(rawPy.slice(pyIdx));
    const pyName = py.indexOf('safe_entry_name(info.filename)');
    const pyDup = py.indexOf('duplicate archive entry');
    const pySymlink = py.indexOf('_is_symlink_entry(info)');
    const pyManifest = py.indexOf('no pack.json manifest');
    expect(pyName, 'py: entry-name refusal call present').toBeGreaterThan(-1);
    expect(pyDup, 'py: duplicate refusal present').toBeGreaterThan(-1);
    expect(pySymlink, 'py: symlink refusal call present').toBeGreaterThan(-1);
    expect(pyManifest, 'py: manifest-presence check present').toBeGreaterThan(-1);
    expect(pyName, 'py: entry-name refusal precedes manifest presence').toBeLessThan(pyManifest);
    expect(pyDup, 'py: duplicate refusal precedes manifest presence').toBeLessThan(pyManifest);
    expect(pySymlink, 'py: symlink refusal precedes manifest presence').toBeLessThan(pyManifest);

    // The AC names api_server.py::_extract_pack_zip — pin its delegation so a
    // reimplementation there cannot silently skip the safe path. Comment-
    // stripped + call-form regex: a doc comment naming the function must not
    // satisfy the pin (mutation-probe M-C12 killed the comment-satisfiable
    // form; this is the rewritten check).
    const api = fs.readFileSync(API_SERVER_SRC, 'utf8');
    const start = api.indexOf('def _extract_pack_zip');
    const end = api.indexOf('\ndef ', start + 1);
    const rawBody = api.slice(start, end === -1 ? api.length : end);
    const body = rawBody.replace(/#[^\n]*/g, '');
    expect(
      body,
      'api_server must delegate to the python safe extractor (a comment naming it is not a call)',
    ).toMatch(/return\s+safe_extract_pack_zip\(/);
  });

  it('multi-key-divergence-pinned: the known TS-first-match vs python-all-keys divergence stays explicit', () => {
    // Documented divergence (see the file header): NOT part of the frozen
    // battery; this is a change-detector so neither side can drift unnoticed.
    // Reconciliation follow-up: TS adopts python's all-keys-per-key_id loop
    // Review PRR-023: comment-stripped anchors (a doc comment naming the
    // shape must not satisfy the pin) and the direction stated both ways:
    // TS first-match is the FALSE-REJECT side (a second key under a shared
    // key_id is refused); python's all-keys loop is the FALSE-ACCEPT side
    // for a retired key that reuses a key_id. Neither side is silently
    // tightened here — see the reconciliation follow-up.
    const stripHash2 = (t: string): string =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(\/\/|#)[^\n]*/g, '');
    const py = stripHash2(fs.readFileSync(PY_EXTRACT_SRC, 'utf8'));
    expect(py, 'python collects every trusted key sharing the key_id').toMatch(
      /matching = \[key for key in trusted_keys if key\.key_id == key_id\]/,
    );
    expect(py, 'python verifies against each matching key in turn').toMatch(/for key in matching:/);
    const packJson = stripHash2(fs.readFileSync(PACK_JSON_SRC, 'utf8'));
    const packExtract = stripHash2(fs.readFileSync(PACK_EXTRACT_SRC, 'utf8'));
    expect(packJson, 'packtool takes the first matching trusted key').toMatch(/trustedKeys\.find\(/);
    expect(packExtract, 'the install-side gate takes the first matching trusted key').toMatch(
      /trustedKeys\.find\(/,
    );
  });
});
