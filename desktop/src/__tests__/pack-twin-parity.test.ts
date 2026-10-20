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
//   duplicate-key-id-refused — REPLACES the former
//                         `multi-key-divergence-pinned` row (PR #224), which
//                         pinned today's TS-first-match vs python-all-keys
//                         divergence as a documented, deliberate state.
//                         Resolved by issue #225's decision: rather than pick
//                         a winner, a trusted keyset carrying two entries under
//                         one key_id is a CONFIGURATION ERROR, refused at
//                         config load and again at the gate, in every
//                         implementation. First-match was the false-reject
//                         side and python's loop the false-accept side; making
//                         the ambiguous case unreachable removes the need to
//                         choose. Pins FOUR implementations, not the three the
//                         issue named: web_ui/src/lib/packs/pack-verify.ts is a
//                         live fourth copy of the gate. A second row pins the
//                         PRESERVING half — with unique key_ids, verification
//                         direction is unchanged on all four.
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
const WEB_UI_VERIFY_SRC = path.join(REPO_ROOT, 'web_ui', 'src', 'lib', 'packs', 'pack-verify.ts');
const WEB_UI_POLICY_SRC = path.join(REPO_ROOT, 'web_ui', 'src', 'lib', 'packs', 'pack-policy.ts');

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

  it('duplicate-key-id-refused: every gate refuses an ambiguous trusted keyset (issue #225)', () => {
    // Replaces the `multi-key-divergence-pinned` row (PR #224). The divergence
    // is gone: rather than pick a winner between TS first-match and python's
    // all-keys loop, a trusted keyset with two entries under one key_id is now
    // a CONFIGURATION ERROR refused by every gate. The ambiguous case that
    // produced the disagreement is unreachable, so the two sides never have to
    // agree about it.
    //
    // The decision named three implementations. This row pins FOUR: web_ui's
    // pack-verify.ts is a live fourth copy (imported by pack-update-browser.ts,
    // pack-policy.ts and pack-manifest.ts, with its own signature-vector tests),
    // and leaving it first-match would have recreated the twin drift this row
    // exists to prevent.
    //
    // Comment-stripped anchors, per review PRR-023: a doc comment NAMING the
    // shape must not satisfy the pin, so every source is stripped first.
    const stripHash2 = (t: string): string =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(\/\/|#)[^\n]*/g, '');

    // The helper itself, present and equivalent in all four implementations.
    // Checked as three separable properties rather than one literal regex, so a
    // python-vs-TS syntax difference (`def`/`return None` vs
    // `function`/`return null`) is not mistaken for a missing guard — and so a
    // helper that merely EXISTS cannot satisfy the row.
    const DEF_RE = /(?:def|function)\s+duplicate_?[Tt]rusted_?[Kk]ey_?[Ii]d\s*\(/;
    const SEEN_RE = /seen\s*[:=]\s*(?:new Set|Set\[)/;
    const RETURNS_RE = /return\s+key\.key_id\b/;
    const NULL_RE = /return\s+(?:null|None)\s*;?\s*$/m;

    const gates: Array<[string, string, string]> = [
      ['python', PY_EXTRACT_SRC, stripHash2(fs.readFileSync(PY_EXTRACT_SRC, 'utf8'))],
      ['packtool', PACK_JSON_SRC, stripHash2(fs.readFileSync(PACK_JSON_SRC, 'utf8'))],
      ['desktop', PACK_EXTRACT_SRC, stripHash2(fs.readFileSync(PACK_EXTRACT_SRC, 'utf8'))],
      ['web_ui', WEB_UI_VERIFY_SRC, stripHash2(fs.readFileSync(WEB_UI_VERIFY_SRC, 'utf8'))],
    ];
    for (const [name, sourcePath, source] of gates) {
      expect(source, `${name} (${sourcePath}) must define duplicateTrustedKeyId`).toMatch(DEF_RE);
      expect(source, `${name} must accumulate seen key_ids in a set`).toMatch(SEEN_RE);
      expect(source, `${name} must return the repeated key_id`).toMatch(RETURNS_RE);
      expect(source, `${name} must return null/None when every key_id is unique`).toMatch(NULL_RE);
      // ...and must CALL it inside verifyPackSignature, before any key lookup,
      // so an ambiguous keyset is never reported as a bad pack. Slicing from
      // the gate's own definition (not from the top of the file) is what keeps
      // the helper's own body from satisfying the "calls it" check.
      const verifyStart = source.search(/(?:def|function)\s+verify_?[Pp]ack_?[Ss]ignature\s*\(/);
      expect(verifyStart, `${name} must still define its signature gate`).toBeGreaterThan(-1);
      const verifyBody = source.slice(verifyStart);
      const dupCall = verifyBody.search(/duplicate_?[Tt]rusted_?[Kk]ey_?[Ii]d\(\s*trusted_?[Kk]eys\s*\)/);
      expect(dupCall, `${name} gate must call duplicateTrustedKeyId`).toBeGreaterThan(-1);
      const findCall = verifyBody.search(/trustedKeys\.find\(|trusted_keys if key\.key_id/);
      expect(
        findCall === -1 || dupCall < findCall,
        `${name} must refuse a duplicate key_id BEFORE its key lookup (dup@${dupCall}, find@${findCall})`,
      );
    }

    // Config-load refusals exist wherever there IS a config-load site. packtool
    // takes trustedKeys as a caller-supplied option and has none, so its gate
    // check above is the enforcement, not a repeat.
    const py = stripHash2(fs.readFileSync(PY_EXTRACT_SRC, 'utf8'));
    expect(py, 'python refuses a duplicate key_id at config load').toMatch(
      /duplicate = duplicate_trusted_key_id\(keys\)/,
    );
    const desktop = stripHash2(fs.readFileSync(PACK_EXTRACT_SRC, 'utf8'));
    expect(desktop, 'desktop refuses a duplicate key_id at env config load').toMatch(
      /duplicateTrustedKeyId\(keys\)/,
    );
    const policy = stripHash2(fs.readFileSync(WEB_UI_POLICY_SRC, 'utf8'));
    expect(policy, 'web_ui refuses a duplicate key_id at config load').toMatch(
      /duplicateTrustedKeyId\(keys\)/,
    );
  });

  it('duplicate-key-id-refused: verification direction is unchanged when every key_id is unique', () => {
    // PRESERVING half of issue #225's decision. The duplicate refusal must not
    // have moved the normal case: with unique key_ids, a signature made by the
    // trusted key still verifies on all four, and a key_id that is simply not
    // trusted is still refused. python keeps its all-keys loop (now
    // unreachable with more than one match); the TS twins keep first-match.
    const stripHash2 = (t: string): string =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(\/\/|#)[^\n]*/g, '');
    const py = stripHash2(fs.readFileSync(PY_EXTRACT_SRC, 'utf8'));
    expect(py, 'python still collects every trusted key sharing the key_id').toMatch(
      /matching = \[key for key in trusted_keys if key\.key_id == key_id\]/,
    );
    expect(py, 'python still verifies against each matching key in turn').toMatch(/for key in matching:/);
    for (const [name, sourcePath] of [
      ['packtool', PACK_JSON_SRC],
      ['desktop', PACK_EXTRACT_SRC],
      ['web_ui', WEB_UI_VERIFY_SRC],
    ] as Array<[string, string]>) {
      const source = stripHash2(fs.readFileSync(sourcePath, 'utf8'));
      expect(source, `${name} still selects the matching trusted key by key_id`).toMatch(
        /trustedKeys\.find\(/,
      );
    }
  });
});
