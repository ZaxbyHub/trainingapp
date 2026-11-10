// i320-pack-extract-out-of-main.test.ts — FROZEN ACCEPTANCE SPEC (issue #320
// AC3 / check C3, trace 320-269-parse-isolation-chat-integrity), authored by
// the issue-tracer ARM'S-LENGTH CHECK AUTHOR at base 5d1f7338, BEFORE any fix
// (maintainer decision 2026-11-09, trace ac3-decision-comment.md: "migrate
// pack-extract in this PR").
//
// AMENDED (CHECK_WRONG reason recorded by the check author, plan-critic round
// 15, Revision 17 R17-1..R17-6; the amendment record lives in the trace's
// anchor receipts): the round-15 critic executed three escapes against the
// original C3 — (1) P2's REGEX load inventory could not see an
// inline-commented dynamic import() of pack-manager, a createRequire alias,
// module.require, a re-export or an escaped specifier (repro/
// critic-round15-c3-probes.out:2-5), and the malicious child passed every C1
// check green (critic-round15-c1-dynamic-import-head.out); (2) an abruptly
// killed child stranded its temp output with no owner (probes :6-8) and
// pid+Date.now() temp naming collided (:9); (3) P4 pinned only six refusal
// classes of the twenty-seven the c8/parity floors pin, no real PID evidence,
// no forced-source leg, no concurrency leg, and report `code` had no
// consumer. Revision 17 rewrites those sections; everything not named in
// R17-1..R17-6 keeps its original frozen wording. C3 remains SELF-CONTAINED:
// the AST load inventory below is C1's logic re-implemented locally (C1 does
// not export it; copying the logic is the sanctioned route — no C1 edit).
//
// AMENDED AGAIN (CHECK_WRONG reason recorded by the check author, plan-critic
// round 16, Revision 18 R18-1..R18-6): the round-16 critic executed four
// escapes against the Revision-17 C3 — (1) P12 required returning an external
// reported directory UNCHANGED (next === adopted), directly contradicting
// P3/P9's required move of <work>/out into a fresh returned dir, and P10's
// stub success leg fed a foreign dir, so NO implementation could satisfy the
// spec and no wrong-dir rejection leg existed (a test-passing runner could
// adopt any directory a child named); (2) launch refusal was exercised only
// for its error text with no workspace-cleanup assertion, and the real
// crash/deadline children created no partial output (the round-15 loss
// scenario was untested); (3) P1a's exact-callee TEXT check was bypassed by a
// local alias that really received the fourth argument
// (repro/critic-round16-probes.out:1: findings:[], observed:4); (4) P2's deny
// regex did not normalize `node:`, so a same-PID `node:vm` execution produced
// ZERO findings (probes:4) — C1 SRC-3 backstops it, but C3's own
// self-contained rule was false; plus (5) the supplied typecheck evidence
// misclassified a genuine toBe arity error at line 2503 as a planned
// four-argument API contrast, and (6) the runner inventory omitted C1's
// frozen `nodeForkPackWorker` export. Revision 18 rewrites those sections;
// everything not named in R18-1..R18-6 keeps its Revision-17 wording.
//
// AMENDED A THIRD TIME (CHECK_WRONG reason recorded by the check author,
// plan-critic round 17, Revision 19 R19-1..R19-3): the round-17 critic
// executed two false-greens against the Revision-18 C3 — (1) P1a skipped
// every path beginning backend/packs/pack-extract plus zip-install.ts, so a
// four-argument call through a LOCAL ALIAS inside pack-extract.ts's own body
// executed in production with ZERO findings (the alias really observed four
// arguments) while the declaration binding was never seeded into directNames,
// and merely deleting the exclusion would still have missed it
// (repro/critic-round17-probes.out:3: findings:[], directCalls:1, observed:4);
// (2) every frozen wrong-dir fixture had a basename OTHER than `out`, so a
// parent comparing only path.basename(report.dir) passed every frozen leg yet
// ACCEPTED a foreign directory whose basename was also `out` — adopted it,
// removed the workspace, and consumed the foreign tree (probes :6-8). R19-1
// therefore drops EVERY P1a path exclusion (pure declaration/re-export
// positions stay legal; the declaration module's local binding is seeded so
// a local alias is caught exactly like an imported one) and freezes
// four-argument regressions inside both previously excluded modules; R19-2
// freezes the FULL-PATH dir identity (a same-basename foreign `<fresh-root>/
// out` report is malformed like any other wrong dir) plus a demonstration leg
// proving a basename-only parent fails it; R19-3 re-audited the remaining
// contract wording — parent-created work/out, FRESH parent adoption, and
// diagnostic-only report codes were already the Revision-18 wording, and no
// passage saying the child picks its own temporary output or exposes public
// PackManagerError codes remains in this spec (the plan/summary corrections
// live in 05-fix-plan.md / 01-issue-summary.md, outside this frozen check).
// Everything not named in R19-1..R19-3 keeps its Revision-18 wording.
//
// AMENDED A FOURTH TIME (CHECK_WRONG reason recorded by the check author,
// plan-critic round 18, Revision 20 R20-1..R20-2): the round-18 critic
// executed two more false-greens against the Revision-19 C3 — (1) P1a bound
// neither NAMESPACE imports nor call-form loads, and its element-access arm
// accepted only StringLiteral keys, so `import * as pack` followed by
// pack[method](...) or pack[`extractPackZip`](...) delivered a production
// FOURTH argument with ZERO findings while the direct-call anti-vacuity
// stayed green (repro/critic-round18-probes.out:4-6; C1 INV-5b is a separate
// backstop, not satisfaction of C3's own EMPTY rule — the same distinction
// round 16 made for node:vm). R20-1 therefore makes every NAMESPACE runtime
// reference to either pack module a finding by ITSELF: a namespace import
// of pack-extract.ts / zip-install.ts, or a call-form load of them
// (import(), require(), member.require(), createRequire()() shapes), fires
// a NAMESPACE finding with an EMPTY allowed set (the base tree has zero
// such references), so every member reference on that binding — computed
// keys included — rides the import/load finding and needs no member-level
// tracking; (2) the R19-2 demonstration and the mirror's planned runner
// validated the report dir with path.resolve equality, which ACCEPTS a
// non-identical lexical alias <work>/child-created/../out and ADOPTS it
// (probes:7-9) while rejecting every frozen foreign shape. R20-2 therefore
// freezes the predicate as EXACT STRING IDENTITY — report.dir === args[1]
// as a literal comparison with NO normalization — adds a lexical-alias
// rejection leg, and the demonstration now proves a RESOLVED-PATH parent
// FAILS it. Everything not named in R20-1..R20-2 keeps its Revision-19
// wording.
//
// AMENDED A FIFTH TIME (CHECK_WRONG reason recorded by the check author,
// plan-critic round 19, Revision 21 R21-1..R21-2): the round-19 critic
// executed two more P1a false-greens against the Revision-20 C3 — (1) P1a
// resolved namespace imports only when their OWN specifier named
// pack-extract.ts / zip-install.ts and never inspected ExportDeclaration
// nodes, so a THIRD module with `export * from './zip-install.js'` (or the
// `export * as pack from ...` spelling), consumed through a namespace
// import of the THIRD module, delivered a computed FOUR-argument
// extractPackZip call with ZERO findings (repro/critic-round19-probes.out:
// 4-5: status 0, OBSERVED_ARGS=4, findings:[]; a C1 owner-edge backstop is
// independent and cannot satisfy C3's own EMPTY rule — the same distinction
// rounds 16/18 made). R21-1 therefore adds the EXPORT-FROM rule: any
// `export ... from`, `export * from`, `export * as ns from` or named
// `export { X } from` declaration whose source resolves to either pack
// module, scanned in EVERY desktop/main module, is a finding with an EMPTY
// allowed set — the ONE legal position is zip-install.ts re-exporting FROM
// pack-extract.ts the exact FROZEN export list pinned in p1aScanSource (the
// base tree's only pack export-from; the names are pinned so a renamed or
// new spelling inside the seam is a finding too); (2) the call-form arm
// recognized only an immediate createRequire(...)('...') call or a callee
// literally named require/member.require, so an ordinary `const req =
// createRequire(import.meta.url); req('./zip-install.js')` — a BOUND loader
// — followed by a Proxy-wrapped namespace and a Symbol.toPrimitive computed
// key delivered four arguments with ZERO findings (probes:6). R21-2
// therefore ports C1's loader alias machinery into P1a (re-implemented
// locally, like every C3 layer — C1 exports nothing): a binding initialized
// from a createRequire(...) call, from a require identifier or a
// member.require, from a `{ require: ... }` destructure, or transitively
// from another alias — createRequire itself may arrive renamed by import —
// is a LOADER ALIAS whose calls are call-form loads under the same
// resolution rule as a direct require, whatever the local callee spelling;
// the base tree's five createRequire sites (update-checker.ts and
// store/{backup,recovery,sqlite-store,pack-manager}.ts) resolve
// ajv/ajv-formats/better-sqlite3/sqlite-vec — non-pack specifiers — and
// stay GREEN. Everything not named in R21-1..R21-2 keeps its Revision-20
// wording.
//
// AMENDED A SIXTH TIME (CHECK_WRONG reason recorded by the check author,
// plan-critic round 20, Revision 22 R22-1): the round-20 critic executed
// one more P1a false-green against the Revision-21 C3 — the EXPORT-FROM
// seam check collected only each ExportSpecifier's EXPORTED name
// (el.name.text) and tested SUBSET membership in frozenSeamExports, so
// `extractPackZip as isZipFilename` inside zip-install.ts (the exported
// spelling is itself frozen) was accepted while the SOURCE binding is
// extractPackZip; a consumer's ordinary `import { isZipFilename } from
// './zip-install.js'` bound NOTHING (the import walk compared only
// extractPackZip spellings), so a plain four-argument identifier call
// through the alias executed with ZERO tree-wide findings
// (repro/critic-round20-probes.out:3: real Node ESM status 0,
// OBSERVED_ARGS=4, findings:[], directCalls:1, seamReExports:1; the
// renamed-to-NON-frozen openPack control was already red, isolating the
// miss to aliases that REUSE another frozen name). R22-1 therefore
// freezes the seam as EXACT 21-PAIR IDENTITY: every export-list element
// is classified by BOTH names — source (el.propertyName ?? el.name).text
// and exported el.name.text — and the declaration's pair set must EQUAL
// the frozen identity-pair set derived from the 21-name list (a renamed
// spelling to another frozen name, a renamed-to-non-frozen spelling, a
// MISSING frozen name, or an extra spelling is a finding; wholly
// type-only export-froms elide as before, and the type-only markers
// inside the mixed seam list ride the pair set). The consumer-binding
// walk is fixed symmetrically: an imported element from the seam whose
// REMOTE name resolves, through the scanned tree's CURRENT seam export
// map, to extractPackZip binds that local name as an imported ALIAS
// (NON-DIRECT at the import, NON-DIRECT + ARITY at any call) — after
// the seam fix itself this matters for detection completeness in the
// synthetic heads (the seam violation is already a finding; the
// consumer binding names the four-argument call). Frozen regressions:
// the executed alias-to-another-frozen-name seam rewrite plus a
// four-argument consumer call through the aliased exported name, and
// the exact-set discriminator (the seam export list missing one frozen
// name — all remaining pairs frozen, which subset membership alone
// accepted); negatives: the REAL frozen seam stays green and counted
// (seamReExports === 1 proves the frozen pair set EQUALS the real
// seam's pairs — the anti-vacuity), and an ordinary frozen-name import
// from the real seam binds nothing. Everything not named in R22-1 keeps
// its Revision-21 wording.
//
// AMENDED A SEVENTH TIME (CHECK_WRONG reason recorded by the check author,
// plan Revision 23 R23-1..R23-3, STRUCTURAL — terminates the round-17..20
// amendment loop; user instruction 2026-11-09: "you need to resolve the
// issues once and for all"): plan-critic rounds 17, 18, 19 and 20 each
// executed another spelling-escape past the P1a production-arity
// enumeration — a LOCAL ALIAS inside pack-extract.ts's own body (round 17,
// repro/critic-round17-probes.out:3), NAMESPACE/computed-key member calls
// (round 18, critic-round18-probes.out:4-6), a THIRD-MODULE `export *` /
// `export * as` re-export plus a BOUND createRequire loader alias
// (round 19, critic-round19-probes.out:4-6), and a SEAM ALIAS reusing a
// frozen exported name (round 20, critic-round20-probes.out:3) — and every
// fix ENLARGED the enumeration, which is exactly why it could never
// terminate: statically enumerating every spelling of a reference to an
// optional FOURTH PARAMETER is unbounded. Revision 23 removes the need for
// the enumeration instead of extending it: the public extractPackZip
// signature gets NO fourth parameter (exactly today's base signature), so
// TypeScript itself rejects EVERY four-argument call — direct, aliased
// (`const p = extractPackZip`), namespaced (pack.extractPackZip,
// pack[method], pack[`extractPackZip`]), computed, re-exported or
// bound-loaded — with TS2554 at the desktop CI typecheck (tsc --noEmit),
// because every alias of the binding carries its type; that typecheck IS
// the arity enforcement and REMAINS A GATE (R23-2c). The test-only
// controls (timeoutMs, childPath) move onto the runner module:
// pack-worker.ts exports extractPackZipWithOptions(zip, filename, limits,
// opts) (R23-1), the deadline/childPath/forced-source legs call it on the
// runner (R23-3), and P1a is REPLACED by (a) an AST SIGNATURE PIN —
// pack-extract.ts's declared FunctionDeclaration extractPackZip has
// exactly 3 parameters with the frozen names (zip, filename, limits), any
// change a finding; (b) a DIRECT-CALL rule on the three frozen C1 INV-5b
// importer modules of pack-worker.ts (backend/packs/pack-extract.ts,
// index.ts, backend/index.ts): none may CALL extractPackZipWithOptions —
// no alias enumeration, because the import edges themselves are frozen by
// C1 and any NEW import edge of pack-worker.ts fails C1 outright, so an
// in-importer alias would still ride an already-frozen edge this rule
// polices; and (c) the CI-typecheck header note. The ENTIRE
// alias/namespace/export-from/seam-pair-identity/loader-fixpoint machinery
// and ALL its regressions (the P1A_REGRESSIONS zoo, frozenSeamExports,
// frozenSeamIdentityPairs) are DELETED as dead weight: C1's INV-5a frozen
// export surfaces remain the SINGLE source of truth for the zip-install.ts
// seam, and C1's INV-5b remains the single source of truth for the
// runner's import edges. Everything not named in R23-1..R23-3 keeps its
// Revision-22 wording.
//
// AMENDED AN EIGHTH TIME (CHECK_WRONG reason recorded by the check author,
// plan Revision 24 R24-1..R24-3, responding to plan-critic round 21's two
// Critical findings plus one metadata finding; evidence repro/
// critic-round21-structural-probes.mjs/.out): Revision 23 deleted the
// spelling enumeration but left the OPTIONS SINK on the production runner.
// This spec's own runner contract still declared extractPackZipOutOfProcess
// (..., opts?), and P1a banned only the extractPackZipWithOptions spelling
// while COUNTING extractPackZipOutOfProcess calls without reading their
// argument count. The critic's faithful planned head — public bridge
// exactly three parameters, repo-configured tsc exit 0, P1a findings:[]
// (repro/critic-round21-structural-probes.out:2-12) — passed an
// environment-gated FOUR-argument production call
// extractPackZipOutOfProcess(zip, filename, resolved, { timeoutMs: 5,
// childPath: 'env-production-child.js' }) inside pack-extract.ts and
// OBSERVED the options delivered at runtime (runnerArgc: 4), no alias,
// any-cast, computed key, new import or new export involved. R24-1
// therefore makes the production surface OPTIONS-FREE:
// extractPackZipOutOfProcess is frozen at EXACTLY THREE declared parameters
// (zipBytes, filename, limits) with NO opts, and it and the four-parameter
// test-side extractPackZipWithOptions both delegate to an UNEXPORTED
// options-aware core runPackExtraction(zipBytes, filename, limits, opts) in
// pack-worker.ts; P1a pins BOTH exported signatures (plus the core's
// unexported shape) and its direct-call rule now ALSO rejects any direct
// call of extractPackZipOutOfProcess whose argument count is not 3, with
// the executed four-argument regression inside the frozen importers.
// R24-2 WITHDRAWS Revision 23's universal TS-enforcement claim (kept
// verbatim above as history): the critic's executed counterexamples — a
// BOUND createRequire loader returns any (no TS2554), an EXPLICIT any
// alias erases the type (no TS2554), Reflect.apply enforces no tuple arity
// (no TS2554), and tsc does not check every extension C1 scans (an
// UNCHECKED .js consumer executed a four-argument call; probes :14-41) —
// refute "the compiler closes the entire class". The corrected closure
// argument: safety rests on the OPTIONS-FREE PRODUCTION SURFACE — no
// production-reachable exported function under desktop/main accepts the
// test controls, so no spelling can DELIVER them, because JavaScript
// ignores extra arguments to a 3-parameter function (the fourth argument
// is inert at runtime whatever the spelling or the file's typecheck
// status; the new runtime demonstration leg executes this); TypeScript is
// retained ONLY as a typed-call gate. No enumeration is restored. R24-3
// (metadata): the exact checkpoint-manifest rows carrying this amendment
// are recorded by the coordinator at freeze time and are deliberately NOT
// hardcoded here — the seventh amendment's "rows 71-76" prose was a count
// error against a manifest ending at row 74 (round-21 metadata finding),
// and this block does not repeat the mistake. Everything not named in
// R24-1..R24-3 keeps its Revision-23 wording.
//
// AMENDED A NINTH TIME (CHECK_WRONG reason recorded by the check author,
// plan Revision 25 R25-1, responding to plan-critic round 22's single
// executed Critical finding; evidence repro/critic-round22-delegation-probe.
// mjs/.out): THREE DECLARED PARAMETERS DO NOT MAKE EXTRA ARGUMENTS INERT
// WHEN THE WRAPPER BODY READS arguments[3]. Revision 24 pinned both
// exported runner signatures and the unexported core, but
// runnerSignatureFindingsOf checked export modifiers and parameter lists
// only — it never inspected either wrapper's body. The critic's exact
// mutant (the pinned three-parameter production export whose body does
// `const opts = (arguments[3] as PackExtractOptions | undefined) ?? {};
// return await runPackExtraction(zipBytes, filename, limits, opts);`, with
// the four-parameter WithOptions export and the unexported
// four-parameter core all conformant, fed by a bridge delivering through
// Reflect.apply) passed the R24 pin with findings:[] and repo-shaped tsc
// exit 0 while its runtime delivered BOTH controls — {timeoutMs: 5,
// childPath: 'env-production-child.js'} (environment-gated delivery) and
// {timeoutMs: 7, childPath: 'hidden-production-child.js'}
// (hidden-fourth-argument delivery), with the ordinary three-argument call
// on defaults and a working WithOptions control (probes :2-15,
// FALSE_GREEN_DEMONSTRATED=1). The supplied inertness legs did not
// contradict this: they hardcoded a conformant lookalike wrapper and
// executed that fixture, not the actual exported runner the pin admits.
// R25-1 therefore makes the WRAPPER BODIES part of the pin (inside
// runnerSignatureFindingsOf itself, so every historical probe extraction
// list stays valid): extractPackZipOutOfProcess's body must be EXACTLY the
// default-only delegation — a single `return [await] runPackExtraction(
// zipBytes, filename, limits, {})` built from its OWN three named
// parameters and the LITERAL empty object — and extractPackZipWithOptions's
// body must be the same single-return delegation passing its OWN opts
// binding; ANY `arguments` reference, ANY `this` reference, any rest
// parameter, any parameter count other than pinned, or ANY other statement
// in either exported wrapper's body is a finding (the unexported core must
// exist and stay unexported, as at R24). The demonstration leg now
// executes the WRAPPERS OF THE PINNED SYNTHETIC RUNNER SOURCE ITSELF (the
// simulated planned head this spec and the trace mirror freeze — only the
// unexported core's body is instrumented) with a POISON fourth argument,
// and at head binds the REAL exported runner through this spec's static
// import for the identical drill; the frozen regressions carry the
// critic's exact mutant (both delivery variants) and both Reflect delivery
// routes as RED. No spelling enumeration is restored. Everything not named
// in R25-1 keeps its Revision-24 wording.
//
// It extends the #319/#320 defect class to the LAST untrusted parse still
// inside the privileged process: pack zip EXTRACTION (JSZip over attacker
// supplied upload bytes, desktop/main/backend/packs/pack-extract.ts). The
// extraction must move behind the registered launcher seam (the #289
// GPU-probe / #319 workbook / #320 document pattern), so a poisoned pack zip
// can crash or wedge only a child OS process — never the Electron main
// process that holds the store, the launch token and the filesystem.
//
// RED AT BASE (5d1f7338): this file statically imports
// desktop/main/backend/packs/pack-worker.js and pack-extract-child.js, which
// do not exist until the fix lands — the whole file fails to load with an
// import-resolution error, which IS the acceptance evidence for the missing
// isolation surface. The source-only legs (P1/P2) also fail at base on their
// own content pins (pack-extract.ts still loads jszip and calls .loadAsync;
// the child module does not exist).
//
// PRESERVING FLOOR (R17-3): the existing c8-pack-security.test.ts (13 tests)
// and browser-pack-extract-parity.test.ts (27 vectors) call the SAME public
// extractPackZip and pin its refusal classes and byte-identical messages;
// both suites must run UNCHANGED at the migrated head and stay 13/13 and
// 27/27 — the implementer's 08 evidence file MUST record those head counts
// (spawning vitest on those files from inside this spec is NOT possible
// inside a vitest worker, so the obligation is pinned here and the full
// refusal surface is round-tripped through the real child by P4 itself).
// The extract-then-verify ORDERING (extraction precedes the Ed25519 gate,
// which is opt-in and default-off) is unchanged and OUT of AC3's scope.
//
// FROZEN PRODUCTION CONTRACT
//
// Bridge — desktop/main/backend/packs/pack-extract.ts keeps the PUBLIC entry
// (surface.ts:26 and the browser-parity suite call it unchanged):
//
//   export async function extractPackZip(
//     zip: Uint8Array,
//     filename: string,
//     limits?: Partial<PackSecurityLimits>,
//   ): Promise<string>;
//
//   EXACTLY THREE PARAMETERS — NO opts (R23-1; R24-1 extends the same
//   options-free rule to the production runner export): this is exactly
//   the base 5d1f7338 signature, nothing added. The three-argument call
//   shape and the resolved-dir return value are unchanged.
//
//   THE CLOSURE ARGUMENT (R24-2 — REPLACES Revision 23's withdrawn
//   universal compiler claim): safety rests on the OPTIONS-FREE PRODUCTION
//   SURFACE. NO production-reachable exported function under desktop/main
//   accepts the test controls — this bridge declares no fourth parameter,
//   the runner's extractPackZipOutOfProcess is 3-parameter options-free
//   (R24-1), and the options-aware core is UNEXPORTED — so no call
//   spelling, direct or aliased, namespaced or computed, re-exported,
//   bound-loaded, any-typed or Reflect-applied, can DELIVER them:
//   JavaScript ignores extra arguments to a 3-parameter function, so a
//   supplied fourth argument is INERT at runtime regardless of the call's
//   spelling or the file's typecheck status (the R24-1 runtime
//   demonstration leg inside P1a executes exactly this).
//   TypeScript is retained ONLY as a TYPED-CALL GATE: on typed spellings
//   (direct, aliased, namespace/computed, re-exported) a four-argument
//   call is TS2554 ("Expected 2-3 arguments, but got 4") at the desktop CI
//   typecheck (tsc --noEmit; the demonstration leg inside P1a executes
//   those shapes against the compiler). The gate's HONEST BOUNDARY — the
//   round-21 critic's executed config-edge rows
//   (repro/critic-round21-structural-probes.out:14-41), listed here so the
//   narrowed claim cannot regress into overclaiming:
//     * a BOUND createRequire loader returns any, so its calls are NOT
//       arity-checked (no TS2554);
//     * an EXPLICIT any alias erases the binding's type (no TS2554);
//     * Reflect.apply accepts an ArrayLike argument list without tuple
//       arity (no TS2554);
//     * tsc does not check every extension C1 scans — desktop/tsconfig.json
//       includes only main/**/*.ts with allowJs/checkJs false, and an
//       UNCHECKED .js consumer executed a four-argument call.
//   Those rows deliver nothing under the options-free surface — which is
//   the structural point, not a spelling list. The
//   deadline/childPath/forced-source legs therefore do NOT run through a
//   fourth parameter on the public bridge — they call the runner's own
//   options variant (extractPackZipWithOptions below), so there is no
//   test-only back door on any production surface to leak. The bridge
//   performs NO zip parsing at all: it resolves the limits
//   (resolvePackLimits(process.env, limits)) and delegates to the runner
//   with EXACTLY three arguments.
//
// PARENT-OWNED PER-CALL WORKSPACE (R17-2 — the round-15 abrupt-death fix).
// Every extraction gets ONE workspace directory the PARENT creates with
//   fs.mkdtempSync(path.join(os.tmpdir(), 'pack-extract-'))
// — unique by construction; pid+Date.now() naming is FORBIDDEN (the critic's
// probe observed 1000 calls collide to 1 unique name). Layout:
//     <work>/input.zip   the parent writes the received bytes
//     <work>/out/        the CHILD extracts into it (the child never chooses
//                        its own temp dir; it receives the absolute out path)
//   ON SUCCESS the parent moves <work>/out to a FRESH mkdtempSync directory
//   (os.tmpdir(), 'pack-install-') and returns THAT path — so surface.ts:40's
//   cleanup ownership of the returned dir is exactly what it is at base — and
//   removes the workspace.
//   ON EVERY NON-SUCCESS PATH — write failure, launch refusal/throw,
//   report-derived failure ({ok:false} rethrow), crash/no-report exit,
//   deadline kill, terminate-on-stop, malformed report, oversize report, and
//   a post-report hang killed at the deadline — the parent removes the WHOLE
//   workspace (recursive). Because the parent knows the path before launch,
//   an abrupt child death can no longer strand output; P9 is a matrix over
//   every path above asserting the workspace no longer exists. Temp-disk
//   cost: up to the route cap (50 MB, server.ts:33) per concurrent upload in
//   flight — documented in the PR body, cap unchanged.
//
// Parent-side runner — desktop/main/backend/packs/pack-worker.ts (mirrors
// backend/ingest/xlsx-worker.ts with pack names):
//
//   export interface PackWorkerChild {            // same surface as XlsxWorkerChild
//     on(event: 'message', cb: (message: unknown) => void): unknown;
//     on(event: 'exit', cb: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
//     on(event: 'error', cb: (...args: unknown[]) => void): unknown;
//     kill(): unknown;
//     readonly pid?: number | undefined;
//     readonly stderr?: NodeJS.ReadableStream | null;
//   }
//   export type PackWorkerForkFn = (modulePath: string, args: string[]) => PackWorkerChild;
//
//   export const DEFAULT_PACK_TIMEOUT_MS = 120_000;
//   export function nodeForkPackWorker(
//     modulePath: string, args: string[],
//   ): PackWorkerChild;
//     // R18-6: the node child_process fork used when nothing is registered and
//     // the process is NOT Electron — the fallback resolvePackWorkerForkFn
//     // returns. C1's frozen planned export list for the pack runner
//     // (i320-doc-parsers-out-of-main.test.ts:1399-1404) names it explicitly;
//     // the C3 and C1 inventories agree on the 7-name base surface
//     // (DEFAULT_PACK_TIMEOUT_MS, nodeForkPackWorker, setPackWorkerForkFn,
//     // resolvePackWorkerForkFn, packWorkerChildPath, terminatePackWorkers,
//     // extractPackZipOutOfProcess) PLUS the R23-1 eighth name below — the
//     // runner's options variant extractPackZipWithOptions, the single
//     // test-control surface (C1's planned list carries the matching
//     // amendment when the fix lands; the name is frozen here). The R24-1
//     // options-aware core runPackExtraction is UNEXPORTED and deliberately
//     // NOT on the frozen surface.
//   export function setPackWorkerForkFn(fn: PackWorkerForkFn | null): void;
//   export function resolvePackWorkerForkFn(insideElectron?: boolean): PackWorkerForkFn | null;
//   export function terminatePackWorkers(): void;   // NodeBackendHost.stop() calls it
//   export function packWorkerChildPath(): string;  // compiled pack-extract-child.js beside
//                                                   // the module, else the .ts sibling
//   export async function extractPackZipOutOfProcess(
//     zipBytes: Uint8Array,          // the raw upload bytes; the RUNNER owns the
//                                    // workspace: mkdtemp, write input.zip, launch,
//                                    // adopt/move/clean per the contract above
//     filename: string,
//     limits: PackSecurityLimits,    // RESOLVED by the bridge; never raw overrides
//   ): Promise<string>;
//     // R24-1 (round-21 finding 1): EXACTLY THREE declared parameters, NO
//     // opts — the PRODUCTION runner export is OPTIONS-FREE. It delegates
//     // to the UNEXPORTED options-aware core below with the default
//     // resolution (opts {}), so the core applies DEFAULT_PACK_TIMEOUT_MS
//     // and packWorkerChildPath(); the delegation is built from the three
//     // declared parameters ONLY, which is why extra call arguments are
//     // INERT at runtime (the R24-1 demonstration leg executes this). P1a
//     // pins this signature AND rejects every direct call of it whose
//     // argument count is not 3. R25-1 (round-22 finding): the delegation
//     // BODY is pinned too — exactly one return statement of the core
//     // call with the OWN three parameters and the literal {}, and no
//     // arguments-object or this reference anywhere in the wrapper body
//     // (three declared parameters alone do not discard arguments[3]).
//   async function runPackExtraction(
//     zipBytes: Uint8Array,          // the UNEXPORTED options-aware CORE (R24-1)
//                                    // that BOTH exported entries delegate to. It
//                                    // owns the whole workspace/lifecycle
//                                    // contract; opts is the ONLY place timeoutMs
//                                    // / childPath can enter, and it is reachable
//                                    // ONLY through extractPackZipWithOptions
//                                    // (test-control) or the runner's own
//                                    // defaults — never through a
//                                    // production-reachable exported function.
//     filename: string,
//     limits: PackSecurityLimits,
//     opts: { timeoutMs?: number; childPath?: string } = {},
//   ): Promise<string>;
//   export async function extractPackZipWithOptions(
//     zipBytes: Uint8Array,          // R23-1: the RUNNER's own options variant —
//                                    // the ONLY 4-parameter EXPORTED entry in the
//                                    // pack surface, TEST-CONTROL ONLY (deadline,
//                                    // childPath, forced-source legs). R24-1: it
//                                    // delegates to the SAME unexported
//                                    // runPackExtraction core — NEVER to
//                                    // extractPackZipOutOfProcess (a four-argument
//                                    // delegation would be the exact shape P1a's
//                                    // arity arm exists to forbid) — and it takes
//                                    // the SAME OPTIONAL limits shape the public
//                                    // bridge takes (limits?:
//                                    // Partial<PackSecurityLimits>) — the
//                                    // variant itself runs the bridge's
//                                    // resolvePackLimits step when limits is
//                                    // absent or partial, so a test leg passing
//                                    // undefined gets env+defaults exactly as
//                                    // extractPackZip(zip, filename) would. The
//                                    // PUBLIC bridge pack-extract.ts NEVER
//                                    // grows a fourth parameter; C1's frozen
//                                    // INV-5b import-edge set means exactly
//                                    // THREE modules may import this runner
//                                    // (pack-extract.ts, index.ts,
//                                    // backend/index.ts) — NONE of the three
//                                    // may CALL extractPackZipWithOptions, and
//                                    // NONE may call extractPackZipOutOfProcess
//                                    // with any argument count other than 3
//                                    // (P1a's direct-call rule below; any NEW
//                                    // import edge of pack-worker.ts fails C1
//                                    // outright, so a fourth caller cannot exist
//                                    // without a C1 finding first).
//
//   The launcher is resolved PER CALL: registered override -> node
//   child_process fork outside Electron -> REFUSAL (reject with the
//   `pack worker: ` prefix, never an in-process fallback) inside Electron
//   with nothing registered. It is invoked as
//   launcher(childPath, [absZipPath, absOutDir, filename, limitsJson])
//   — argv roles below; childPath defaults to packWorkerChildPath(). The
//   runner settles ON EXIT (a report alone never settles); a non-zero exit
//   with no report rejects naming the exit code; a clean exit with no report
//   rejects within the 500 ms grace; the deadline (default
//   DEFAULT_PACK_TIMEOUT_MS) kills once, then once more after the 2 s grace
//   (the node launcher maps kill #1 to SIGTERM and later kills to SIGKILL).
//   A serialized report over 16 MiB rejects with the prefix and kills the
//   child. A report-derived {ok:false} rejection is a PackManagerError
//   carrying the child's `error` VERBATIM; every runner-fabricated rejection
//   (launch refusal, launch throw, crash, no report, malformed/oversize
//   report, deadline, termination, write failure) is a plain Error carrying
//   the `pack worker: ` prefix. terminatePackWorkers() kills every live child
//   this module launched and rejects each in-flight extraction with
//   `pack worker: terminated by host shutdown`.
//
//   ARGV ROLES (frozen; positional, all four ALWAYS present):
//     argv[0]  absZipPath   — ABSOLUTE path of <work>/input.zip.
//     argv[1]  absOutDir    — ABSOLUTE path of <work>/out (PARENT-created;
//                             the child writes into it, never beneath a path
//                             of its own choosing). Deriving `out` from the
//                             zip path was REJECTED so the workspace layout
//                             stays an explicit contract input a wrong-argv
//                             child cannot silently repoint.
//     argv[2]  filename     — the ORIGINAL upload filename, VERBATIM. Every
//                             frozen refusal message embeds it ("many.zip:
//                             archive declares 150 entries, ..."); it is
//                             data, not a flag.
//     argv[3]  limitsJson   — JSON.stringify of the RESOLVED limits
//                             {maxUncompressedBytes, maxEntries,
//                             maxCompressionRatio}. The PARENT resolves
//                             env+overrides so the child stays config-free;
//                             one JSON token instead of positional numerics.
//   WHY POSITIONAL, not the #319 trailing-numeric-role scheme: the xlsx child
//   has ONE optional numeric cap (role-decodable from the last element); the
//   pack child's heterogeneous inputs include an arbitrary user filename, and
//   a trailing-numeric parse is ambiguous the moment a filename happens to be
//   all digits. Fixed positions are deterministic; paths and filenames with
//   spaces/quotes/unicode/leading dashes ride an argv array (no shell
//   interpretation — the round-15 ARGV-ROUNDTRIP probe passed all three
//   shapes exactly). A shorter/longer argv reports
//   {ok:false, error:'pack worker: ...'} and exits non-zero.
//
//   PID VISIBILITY (R17-4): the runner forwards the launched child's `pid`
//   from the fork handle on the PackWorkerChild surface it returns (Electron
//   utilityProcess and node fork both carry it; the fake children in this
//   spec expose it where relevant). NO production report field is added for
//   it — the report contract below stays as small as it was, and the spec
//   reads the pid off the registered launcher's child handle. The child
//   reporting its own process.pid in the report is the DISCLOSED fallback if
//   a launcher surface ever lacks pid; the runner-owner documents which one
//   ships. Either way a real-fork success leg asserts childPid !== parentPid
//   (P5b) — an in-process runner cannot fake a different OS pid.
//
// Child entry — desktop/main/backend/packs/pack-extract-child.ts:
//
//   export const PACK_WORKER_ERROR_PREFIX = 'pack worker: ';
//   export async function runPackChildMain(
//     argv: string[],
//     channel?: { postMessage(message: unknown): void },
//   ): Promise<number>;
//
//   The extraction pipeline moves INTO the child (logic moved, not vanished):
//   ZIP32 central-directory pre-filter (parseCentralDirectory +
//   enforceDeclaredLimits from ./pack-archive-rules.ts), raw entry-name
//   validation + symlink refusal, JSZip load + per-entry name/symlink
//   re-validation, pack.json root-manifest presence, resolved-path
//   containment per entry, per-entry writes under the written-bytes backstop
//   — into the GIVEN absOutDir, never a self-chosen temp dir. On a
//   child-detected failure the child MAY remove its partial out dir (belt and
//   braces); the PARENT workspace cleanup is the OWNER and must never depend
//   on the child cooperating (the round-15 kill probe left a real partial
//   tree behind). Exactly ONE report over IPC, then exit:
//     { ok: true,  dir: string }                // EXACTLY the absOutDir the parent
//                                               // passed (the launcher's args[1])
//     { ok: false, code: string, error: string }
//
//   REPORT-DIR PROVENANCE (R18-1 — the round-16 finding-1 fix): the success
//   report's `dir` MUST be exactly the outDir the parent passed — the
//   launcher's args[1]. The parent validates that identity against the
//   already-known out path BEFORE any adoption and treats a report naming
//   ANY other directory as a MALFORMED report: reject with the
//   `pack worker: ` prefix, remove the WHOLE workspace, and never touch the
//   reported foreign tree (no adoption, no move, no delete — the foreign
//   directory survives byte-for-byte). On the conformant report the parent
//   ALWAYS moves that dir into a FRESH mkdtempSync directory (os.tmpdir(),
//   'pack-install-') and returns the fresh path — never the workspace path,
//   never a child-named path. A STRICT implementation (reject any
//   dir !== args[1]) satisfies every success leg below; a lenient one (move
//   whatever is reported) fails P8's wrong-dir row, P9's dedicated wrong-dir
//   leg and wrong-dir matrix row, P10's invalid-fixture leg and P12's
//   unrelated-directory leg.
//   FULL-PATH IDENTITY (R19-2 — the round-17 finding-2 fix): the validated
//   identity is the WHOLE absolute path, never a basename comparison. Every
//   frozen foreign fixture above has a basename OTHER than `out`, so a parent
//   that compares only path.basename(report.dir) === path.basename(args[1])
//   passes all of them yet accepts a FOREIGN directory whose basename is also
//   `out` — adopting it, removing the workspace, and consuming the foreign
//   tree (the critic's executed probe did exactly that). A report dir that
//   equals args[1] only by basename — a foreign <fresh-root>/out while
//   args[1] is <work>/out — is therefore MALFORMED exactly like any other
//   wrong dir: `pack worker: ` prefix rejection, whole-workspace removal, and
//   byte-for-byte preservation of the foreign tree. C3 freezes that
//   same-basename foreign-out leg in P9 and a demonstration leg proving a
//   BASENAME-ONLY parent FAILS it while the full-path parent passes.
//   EXACT STRING IDENTITY (R20-2 — the round-18 finding-2 fix): the
//   validated identity is a LITERAL string comparison, report.dir ===
//   args[1], with NO normalization of either side — no path.resolve, no
//   path.normalize, no realpath. A report dir that RESOLVES to args[1] but
//   is not the identical string — the lexical alias <work>/child-created/
//   ../out — is MALFORMED exactly like any other wrong dir: `pack worker: `
//   prefix rejection, whole-workspace removal, and NOTHING adopted (a
//   resolved-path parent accepts and adopts it — the critic's executed
//   probe did exactly that). C3 freezes the lexical-alias rejection leg in
//   P9 and a demonstration leg proving a RESOLVED-PATH parent FAILS it
//   while the exact-identity parent passes.
//   `code` is DIAGNOSTIC-ONLY (R17-6): a stable non-empty machine string the
//   parent MAY log and NEVER surfaces — PackManagerError (pack-manager.ts:
//   139-144) has NO public code field, and no public contract consumes one.
//   `error` is the FINAL PackManagerError message text, UNPREFIXED (the
//   parent rethrows it verbatim, and the c8/parity suites pin those messages
//   byte-for-byte — a child-side `pack worker: ` prefix would corrupt them).
//   C3 asserts class + name + message and NEVER a public code.
//
//   IMPORT GRAPH (frozen, R17-1): the child's transitive LOCAL closure may
//   contain ONLY pack-extract-child.ts itself and pack-archive-rules.ts. Any
//   other local module, any edge into store/**, and any bare package other
//   than jszip or a classified Node built-in is a finding. In particular the
//   child NEVER imports pack-manager.ts (pack-manager.ts:47 ->
//   sqlite-store.ts -> better-sqlite3/sqlite-vec native addons at
//   sqlite-store.ts:51-59). The child has no PackManagerError import: its
//   refusal factory throws plain Errors carrying the frozen MESSAGES; only
//   the PARENT wraps a report-derived failure in new PackManagerError(error)
//   (same name, same message, no code).
//
//   SHARED RULES IMPORT SHAPE (R17-4, verified empirically by the check
//   author at base with TS 5.9.3 on Node 24.16.0 in a throwaway tree —
//   repro/critic-round17-ts-experiment.out): the child imports the sibling
//   with the EXPLICIT TS EXTENSION,
//       import { ... } from './pack-archive-rules.ts';
//   enabled by desktop/tsconfig.json gaining
//       "allowImportingTsExtensions": true,
//       "rewriteRelativeImportExtensions": true
//   The two options are a PAIR: alone, allowImportingTsExtensions forces
//   noEmit/emitDeclarationOnly (tsc refuses with TS5096 — measured, leg C);
//   WITH rewriteRelativeImportExtensions, EMITTING compiles fine and rewrites
//   the relative specifier (leg A1).
//   VERIFIED FACTS (all measured, not assumed):
//     * tsc -p with the pair on and NO noEmit compiled and EMITTED the child
//       with './rules.js' (rewritten from '.ts'; the real dist is
//       "type":"module" ESM, so it lands as from './pack-archive-rules.js')
//       and rules.js beside it — the compiled dist layout still works; the
//       compiled child RAN (leg A2).
//     * the REAL desktop/main tree at base typechecks with the two options
//       added: ZERO errors (leg D) — the tsconfig change is inert for every
//       existing file; only the planned child spells '.ts'.
//     * `node file.ts` (the plain-spawn source fallback xlsx-worker.ts uses
//       for .ts childPaths: `nodeSpawn(process.execPath, [modulePath,
//       ...args])`) LOADS './pack-archive-rules.ts' natively — Node 24 type
//       stripping resolves the explicit .ts specifier directly; the
//       source-tree child ran and imported the real shared rules with a
//       distinct pid (leg A3).
//     * the reverse direction (importing './x.js' from a .ts file under type
//       stripping) still FAILS with ERR_MODULE_NOT_FOUND — the critic's
//       round-15 TS-FALLBACK probe, reproduced as leg B — which is exactly
//       why the specifier is pinned as '.ts'.
//   So the rules stay SHARED (never vendored) and both launch shapes work
//   with ONE specifier; the byte-identical-copy fallback the plan named is
//   NOT used.
//
// Bootstrap — desktop/main/index.ts registers, inside app.whenReady, BESIDE
// the xlsx registration:
//   setPackWorkerForkFn((modulePath, args) => utilityProcess.fork(modulePath, args,
//     { stdio: ['ignore', 'ignore', 'pipe'], serviceName: 'TrainingApp pack extractor' }))
//
// Stop — desktop/main/backend/index.ts NodeBackendHost.stop() calls
// terminatePackWorkers() beside terminateXlsxWorkers(), so no pack child
// outlives the host.
//
// FROZEN REFUSAL ROUND-TRIP TABLE (R17-3). Every refusal the two preserving
// suites pin, re-pinned through the REAL node-fork child with the SAME
// assertion style those suites use — exact message where they pin exact,
// class-only where they do. Sources: browser-pack-extract-parity.test.ts:53-84
// (Vector.exact) and c8-pack-security.test.ts (toMatch on stable fragments):
//
// VECTOR COUNT (R18-6, recounted after the Revision-18 edits — the header
// number MUST match this table and the P4 legs): the first P4 leg round-trips
// 22 REFUSAL VECTORS — 19 exact-message (non-.zip filename; not a zip; entry
// cap; declared byte cap; declared ratio; dot segment; nested dot segment;
// single dot segment; absolute path; drive-relative; drive-absolute;
// backslash; control char C0; DEL char 0x7f; symlink entry; duplicate entry;
// ZIP64 EOCD-sentinel arm; ZIP64 locator arm; missing manifest) plus 3
// class-only (spoofed declared size; encrypted entry; unknown compression) —
// and 6 ACCEPT CONTROLS (ok-small, ok-deflated, ok-dir-entry, ratio-floor-ok,
// sfx-prefix-ok, and the c8 zip-comment accept) = 28 real forks. The second
// leg adds 10 more forks (2 caps + 1 symlink + 2 ZIP64 arms + 4 traversal +
// the 2500-entry accept). The earlier 21-refusal-rows amendment prose was a
// count error (round-16 finding 6); the true count is 22.
//
//   case                      style       exact message / pinned fragment
//   ------------------------- ----------- --------------------------------
//   non-.zip filename         exact       "<f>: pack install accepts .zip
//                                          archives only"            [parity non-zip-extension; c8 uses toMatch(/accepts \.zip archives only/)]
//   not a zip                 exact       "<f>: not a readable zip archive (no end-of-central-directory record)"
//   entry cap                 exact       "<f>: archive declares N entries, over the C entry cap"
//                                          [parity entry-cap exact; c8 toMatch(/entry cap/)]
//   declared byte cap         exact       "<f>: archive declares N uncompressed bytes, over the C byte cap"
//                                          [parity byte-cap exact; c8 toMatch(/byte cap|compression ratio/)]
//   declared ratio            exact       "<f>: archive declares a R:1 compression ratio, over the C:1 cap (possible zip bomb)"
//   dot segment               exact       'unsafe archive entry path (dot segment): "<name>"'
//   nested/single dot segment exact       same wording ('../evil.txt', 'docs/./a.txt')
//   absolute path             exact       'unsafe archive entry path (absolute): "/etc/passwd"'
//   drive-relative/absolute   exact       'unsafe archive entry path (drive-relative/absolute): "E:../x"' / '"C:/x"'
//   backslash                 exact       'unsafe archive entry path (backslash): "<name>"'
//   control char (C0)         exact       'unsafe archive entry path (control character): "docs/a<0x01>b"'
//   DEL char (0x7f)           exact       'unsafe archive entry path (control character): "docs/a<0x7f>b"'
//   symlink entry             exact       "<f>: symlink archive entry <name> is not allowed"
//   duplicate entry           exact       "<f>: duplicate archive entry <name> is not allowed"
//   ZIP64 entry-count marker  exact       "<f>: ZIP64 markers are refused; pack archives above 4 GiB / 65535 entries are not accepted"
//                                          [parity exact; c8 toMatch(/4 GiB \/ 65535/) — BOTH arms: EOCD sentinel AND locator splice]
//   missing manifest          exact       "<f>: no pack.json manifest at the archive root"
//   spoofed declared size     class-only  PackManagerError, /extraction failed|mismatch/ (JSZip-internals text; parity marks exact:false)
//   encrypted entry           class-only  PackManagerError, /not a readable zip archive/ (parity exact:false)
//   unknown compression       class-only  PackManagerError, /not a readable zip archive/ (parity exact:false)
//   ACCEPT controls           accepted    ok-small, ok-deflated, ok-dir-entry, ratio-floor-ok, sfx-prefix-ok (parity), zip-comment + 2500-entry default (c8)
//   traversal containment     on-disk     c8 style: nothing lands at either candidate escape path
//
//   The on-disk messages above were captured at base 5d1f7338 by running the
//   two suites' own vector sets through the CURRENT in-main extractPackZip
//   (repro capture scripts; the exact texts are byte-identical desktop and
//   browser at base — the parity suite proves that on every run).
//
// PARITY GOLDEN PROVENANCE (captured NOW at base 5d1f7338 by the trace repro
// scripts, from the CURRENT in-main extractPackZip over the committed
// fixture):
//   generator  .agents/issue-traces/320-269-parse-isolation-chat-integrity/repro/gen-pack-extract-fixture.mjs
//   capture    .agents/issue-traces/320-269-parse-isolation-chat-integrity/repro/capture-pack-extract-golden.mjs
//   fixture    contracts/fixtures/pack-extract-parity/parity-pack.zip
//              sha256 76cf0b2219b33e83b8de8479c67fc6a08186f91feb7adb9bc9c18ec6768681fc
//   golden     contracts/fixtures/pack-extract-parity/golden.manifest.json
//              sha256 bddbfa48f5a3e16f88999f39a5cc1ea8159d2840cf5221e7dccbc689ada49e59
//   commands (from the repo root):
//     node .agents/issue-traces/320-269-parse-isolation-chat-integrity/repro/gen-pack-extract-fixture.mjs \
//       contracts/fixtures/pack-extract-parity/parity-pack.zip
//     node .agents/issue-traces/320-269-parse-isolation-chat-integrity/repro/capture-pack-extract-golden.mjs \
//       contracts/fixtures/pack-extract-parity/parity-pack.zip \
//       contracts/fixtures/pack-extract-parity/golden.manifest.json
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fork, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import ts from 'typescript';
import { app, utilityProcess, FakeUtilityProcess, __resetElectronStub } from 'electron';
import { NodeBackendHost } from '../../main/backend/index.js';
import { StubEngine } from '../../main/backend/engine.js';
import { bootstrap } from '../../main/index';
import { __resetTransportSecurityForTests } from '../../main/security/index';
import { extractPackZip } from '../../main/backend/packs/pack-extract.js';
import { PackManagerError } from '../../main/backend/store/pack-manager.js';
import {
  DEFAULT_PACK_TIMEOUT_MS,
  extractPackZipOutOfProcess,
  extractPackZipWithOptions,
  nodeForkPackWorker,
  packWorkerChildPath,
  resolvePackWorkerForkFn,
  setPackWorkerForkFn,
  terminatePackWorkers,
  type PackWorkerChild,
} from '../../main/backend/packs/pack-worker.js';
import { PACK_WORKER_ERROR_PREFIX, runPackChildMain } from '../../main/backend/packs/pack-extract-child.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = path.resolve(THIS_DIR, '../../main');
const PACKS_DIR = path.join(MAIN_DIR, 'backend', 'packs');
const EXTRACT_SOURCE = path.join(PACKS_DIR, 'pack-extract.ts');
const CHILD_SOURCE = path.join(PACKS_DIR, 'pack-extract-child.ts');
const RUNNER_SOURCE = path.join(PACKS_DIR, 'pack-worker.ts');
const SURFACE_SOURCE = path.join(PACKS_DIR, 'surface.ts');
const ZIP_INSTALL_SOURCE = path.join(PACKS_DIR, 'zip-install.ts');
const MAIN_INDEX_SOURCE = path.join(MAIN_DIR, 'index.ts');
const BACKEND_INDEX_SOURCE = path.join(MAIN_DIR, 'backend', 'index.ts');
const PARITY_DIR = path.resolve(THIS_DIR, '../../../contracts/fixtures/pack-extract-parity');
const PARITY_ZIP = path.join(PARITY_DIR, 'parity-pack.zip');
const PARITY_GOLDEN = path.join(PARITY_DIR, 'golden.manifest.json');
/** Provenance pins (see the header's golden block). */
const FIXTURE_ZIP_SHA256 = '76cf0b2219b33e83b8de8479c67fc6a08186f91feb7adb9bc9c18ec6768681fc';
const GOLDEN_SHA256 = 'bddbfa48f5a3e16f88999f39a5cc1ea8159d2840cf5221e7dccbc689ada49e59';
/** The report-derived / runner-fabricated rejection prefix. */
const WORKER_PREFIX = /^pack worker:/;
const SERVICE_NAME = 'TrainingApp pack extractor';
const CHILD_RELATIVE = 'backend/packs/pack-extract-child.ts';
const RULES_RELATIVE = 'backend/packs/pack-archive-rules.ts';
/** The ONLY local modules the pack child's transitive closure may contain. */
const ALLOWED_LOCAL_CLOSURE = new Set<string>([CHILD_RELATIVE, RULES_RELATIVE]);
/** The ONLY bare packages the closure may load (jszip) — plus built-ins. */
const ALLOWED_BARE = new Set<string>(['jszip']);
/** The out dir basename inside the parent-owned workspace. */
const WORKSPACE_OUT_BASENAME = 'out';
/** The workspace input zip basename. */
const WORKSPACE_INPUT_BASENAME = 'input.zip';
/** Workspace directories observed by fake-seam legs, cleaned defensively. */
const seenWorkspaces: string[] = [];

// The frozen cap constants (identical to c8-pack-security.test.ts).
const BOMB_CAP_BYTES = 4 * 1024 * 1024;
const BOMB_PAYLOAD_BYTES = 6 * 1024 * 1024;
const BOMB_RATIO_CAP = 10;
const ENTRY_CAP = 100;
const ENTRY_CAP_ARCHIVE_ENTRIES = 150;
const RATIO_BOMB_BYTES = 20 * 1024 * 1024;
const DEFAULT_LIMITS = { maxUncompressedBytes: 2147483648, maxEntries: 5000, maxCompressionRatio: 100 };
/** Backslash as a computed value: the spec's own source must not carry a
 *  '\\'-spelled hostile name that a textual scanner of THIS file trips on. */
const BS = String.fromCharCode(92);

/** Every source extension the main-process tree can carry. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];
/** jszip LOAD forms (whitespace-tolerant) plus the JSZip parse entry point. */
const JSZIP_LOAD_PATTERN =
  /from\s*['"]jszip['"]|import\s*\(\s*['"]jszip['"]\s*\)|require\s*\(\s*['"]jszip['"]\s*\)/;
const LOAD_ASYNC_PATTERN = /\.loadAsync\s*\(/;

const sha256 = (b: Buffer | Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-worker-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setPackWorkerForkFn(null);
  terminatePackWorkers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
  while (seenWorkspaces.length > 0) {
    const dir = seenWorkspaces.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Remove block comments and FULL-LINE // comments (never strips code). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every source file (SOURCE_EXTENSIONS) under a directory, recursively. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** Bound a promise so a broken runner fails the test instead of hanging it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`spec guard: no settle within ${ms}ms`)), ms);
    }),
  ]);
}

/** Poll until fn returns truthy (the gpu-probe spec's waitFor pattern). */
async function waitFor<T>(fn: () => T | undefined | null | false, description: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null && value !== false) return value as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function relToMain(file: string): string {
  return path.relative(MAIN_DIR, file).split(path.sep).join('/');
}

/** ScriptKind by extension: TSX for .tsx, JS for .js/.mjs/.cjs, TS for .ts/.mts/.cts (C1's helper). */
function scriptKindFor(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

interface FakeChild {
  listeners: Record<string, Array<(value: unknown) => void>>;
  delivered: unknown[];
  killCalls: number;
  pid?: number;
  on(event: string, cb: (value: unknown) => void): FakeChild;
  kill(): boolean;
  emit(event: string, value: unknown): void;
}

function makeFakeChild(pid?: number): FakeChild {
  const child: FakeChild = {
    listeners: {},
    delivered: [],
    killCalls: 0,
    ...(pid === undefined ? {} : { pid }),
    on(event, cb) {
      (child.listeners[event] ??= []).push(cb);
      return child;
    },
    kill() {
      child.killCalls += 1;
      return true;
    },
    emit(event, value) {
      if (event === 'message') child.delivered.push(value);
      for (const cb of child.listeners[event] ?? []) cb(value);
    },
  };
  return child;
}

// ------------------------------------------------------------------ //
// hand-rolled store-only zip writer (exact control over entry names,
// methods and external attributes — JSZip normalizes hostile names away on
// load, so attack archives must bypass it). Copied from c8-pack-security
// (which copied the frozen #75 node driver), so bytes match bit for bit.
// ------------------------------------------------------------------ //
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
  for (let i = 0; i < buf.length; i += 1) c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface RawZipEntry {
  name: string;
  data: Buffer;
  method?: number;
  /** Raw 32-bit external attributes (unix mode << 16). */
  externalAttrs?: number;
  /** General-purpose flags (bit 0 = encrypted). */
  flags?: number;
  /** Spoof the central-directory uncompressed size (parity suite shape). */
  declaredUncompressed?: number;
}

/** Options mirroring the parity suite's RawZipOptions (the arms P4 uses). */
interface RawZipOptions {
  /** Override EOCD entry-count fields to model the ZIP64 sentinel. */
  eocdEntriesOverride?: number;
  /** Splice a ZIP64 EOCD locator record before the EOCD. */
  zip64Locator?: boolean;
}

function buildRawZip(entries: RawZipEntry[], opts: RawZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Array<{ name: Buffer; method: number; crc: number; csize: number; usize: number; offset: number; externalAttrs: number; flags: number; declaredUsized: boolean }> = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const payload = e.method === 8 ? zlibDeflateRaw(e.data) : Buffer.from(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(e.method ?? 0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, payload);
    const externalAttrs = e.externalAttrs ?? (0o100644 << 16) >>> 0;
    central.push({
      name, method: e.method ?? 0, crc, csize: payload.length, usize: e.data.length, offset, externalAttrs,
      flags: e.flags ?? 0, declaredUsized: e.declaredUncompressed !== undefined,
    });
    offset += 30 + name.length + payload.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(c.flags, 8);
    ch.writeUInt16LE(c.method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.csize, 20);
    ch.writeUInt32LE(c.declaredUsized && c.usize !== 0 ? (c.usize > 0 ? 100 : 0) : c.usize, 24);
    ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(c.externalAttrs, 38); ch.writeUInt32LE(c.offset, 42);
    parts.push(ch, c.name);
    cdSize += 46 + c.name.length;
  }
  const locator = opts.zip64Locator ? zip64LocatorRecord() : Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  const count = opts.eocdEntriesOverride ?? central.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(locator, eocd);
  return Buffer.concat(parts);
}

/** A ZIP64 EOCD locator record (immediately precedes the EOCD when present). */
function zip64LocatorRecord(): Buffer {
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  return loc;
}

function zlibDeflateRaw(data: Buffer): Buffer {
  return zlib.deflateRawSync(data, { level: 9 });
}

const PACK_JSON_STUB = Buffer.from(JSON.stringify({ id: 'stub', version: '1.0.0', docs: [] }));

function fillerEntries(count: number, prefix = 'docs/f'): RawZipEntry[] {
  const out: RawZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ name: `${prefix}${String(i).padStart(4, '0')}.txt`, data: Buffer.from('x'), method: 0 });
  }
  return out;
}

/** A minimal VALID pack archive (manifest + one doc) for success paths. */
function smallPackZipBytes(): Buffer {
  return buildRawZip([
    { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
    { name: 'docs/a.txt', data: Buffer.from('pack child parity probe'), method: 0 },
  ]);
}

/** Remove probe files a botched extraction could have planted (defensive). */
function cleanupEscapeCandidates(names: string[]): void {
  for (const name of names) {
    const candidates = new Set<string>([path.resolve(name)]);
    try {
      candidates.add(path.resolve(path.join(...name.split('/'))));
    } catch {
      /* ignore */
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
  }
}

/**
 * Spec-owned CommonJS child that writes PARTIAL OUTPUT into the out dir the
 * parent passed, then exits 2 with NO report — the abrupt-death-with-partial-
 * output shape (R18-2): the whole workspace, partial output included, must be
 * gone afterwards. Under the node fork the launcher's args ride
 * process.argv.slice(2), so the out dir (launcher args[1]) is process.argv[3].
 */
function writeCrashChild(dir: string): string {
  const source = [
    "'use strict';",
    'const fs = require("node:fs");',
    'const outDir = process.argv[3];',
    'fs.mkdirSync(outDir, { recursive: true });',
    'fs.writeFileSync(require("node:path").join(outDir, "partial.txt"), "partial crash output");',
    'process.exit(2);',
    '',
  ].join('\n');
  const file = path.join(dir, 'fixture-pack-crash-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * Spec-owned CommonJS child that writes PARTIAL OUTPUT into the parent-passed
 * out dir and then NEVER exits and NEVER reports (the deadline shape, R18-2):
 * killed at the deadline with the partial tree still on disk, and the whole
 * workspace must be gone afterwards.
 */
function writeNeverExitingChild(dir: string): string {
  const source = [
    "'use strict';",
    'const fs = require("node:fs");',
    'const outDir = process.argv[3];',
    'fs.mkdirSync(outDir, { recursive: true });',
    'fs.writeFileSync(require("node:path").join(outDir, "partial.txt"), "partial hung output");',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
  const file = path.join(dir, 'fixture-pack-hung-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * Spec-owned CommonJS child that WRITES a partial tree into the out dir the
 * PARENT passed (launcher args[1] === process.argv[3] under the node fork —
 * R18-1: the conformant report shape), posts that exact dir, then HANGS (the
 * post-report-hang shape: a report alone must not settle the runner, killed
 * at the deadline, workspace still owed).
 */
function writeReportThenHangChild(dir: string): string {
  const source = [
    "'use strict';",
    'const fs = require("node:fs");',
    'const outDir = process.argv[3];',
    'fs.mkdirSync(outDir, { recursive: true });',
    'fs.writeFileSync(require("node:path").join(outDir, "partial.txt"), "partial");',
    'if (typeof process.send === "function") process.send({ ok: true, dir: outDir });',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
  const file = path.join(dir, 'fixture-pack-report-hang-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/** Relative posix path -> sha256 for every FILE under dir (recursive, sorted). */
function treeManifest(dir: string): Array<{ path: string; sha256: string }> {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = (rel: string): void => {
    const abs = rel === '' ? dir : path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile()) files.push({ path: relPath, sha256: sha256(fs.readFileSync(path.join(dir, relPath))) });
    }
  };
  walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** Extract the workspace dir the launcher's argv names (argv[0] = input.zip). */
function workspaceOfArgs(args: string[] | undefined): string | undefined {
  const zipPath = args?.[0];
  if (typeof zipPath !== 'string' || zipPath.length === 0) return undefined;
  return path.dirname(path.resolve(zipPath));
}

/** Record a workspace for defensive afterEach cleanup and return it. */
function trackWorkspace(args: string[] | undefined): string | undefined {
  const work = workspaceOfArgs(args);
  if (work !== undefined) seenWorkspaces.push(work);
  return work;
}

// ==================================================================== //
// P1 — no zip parsing left in the packs surface except the child        //
// ==================================================================== //
describe('#320 AC3 P1: no jszip load or .loadAsync remains under backend/packs except the child', () => {
  it('every packs/** source except pack-extract-child.ts is parser-free; the child has them; the public seam survives', () => {
    const files = listSourceFiles(PACKS_DIR);
    // Anti-vacuity: the scan covers the real packs surface.
    expect(files.length).toBeGreaterThan(3);
    const relatives = files.map((file) => path.relative(MAIN_DIR, file).split(path.sep).join('/'));
    for (const expected of [
      'backend/packs/pack-extract.ts',
      'backend/packs/pack-archive-rules.ts',
      'backend/packs/zip-install.ts',
      'backend/packs/surface.ts',
      CHILD_RELATIVE,
      'backend/packs/pack-worker.ts',
    ]) {
      expect(relatives, `the packs surface must still contain ${expected}`).toContain(expected);
    }

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(MAIN_DIR, file).split(path.sep).join('/');
      if (rel === CHILD_RELATIVE) continue;
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      if (JSZIP_LOAD_PATTERN.test(source) || LOAD_ASYNC_PATTERN.test(source)) violations.push(rel);
    }
    expect(violations, 'only the pack child may load jszip or call .loadAsync').toEqual([]);

    // Anti-vacuity: the parse moved into the child module, it did not vanish.
    const child = stripComments(fs.readFileSync(CHILD_SOURCE, 'utf8'));
    expect(child).toMatch(JSZIP_LOAD_PATTERN);
    expect(child).toMatch(LOAD_ASYNC_PATTERN);

    // Anti-gaming: the public bridge and its historical importers survive.
    const extract = stripComments(fs.readFileSync(EXTRACT_SOURCE, 'utf8'));
    expect(extract).toContain('export async function extractPackZip');
    expect(stripComments(fs.readFileSync(ZIP_INSTALL_SOURCE, 'utf8'))).toContain('extractPackZip');

    // The runner module exists and owns the seam names.
    expect(stripComments(fs.readFileSync(RUNNER_SOURCE, 'utf8'))).toContain('export function setPackWorkerForkFn');
  });
});

// ==================================================================== //
// P1a — production arity (R23-2 as AMENDED by R24-1/R24-2; still REPLACES //
// the R17-5..R22-1 machinery): the public extractPackZip signature has   //
// NO fourth parameter AND the PRODUCTION runner export is OPTIONS-FREE — //
// extractPackZipOutOfProcess is exactly 3 parameters (zipBytes,          //
// filename, limits) delegating to the UNEXPORTED options-aware core      //
// runPackExtraction, and extractPackZipWithOptions (exactly 4            //
// parameters) delegates to the same core. SAFETY = THE OPTIONS-FREE      //
// PRODUCTION SURFACE (R24-2): no production-reachable exported function  //
// under desktop/main accepts the test controls, so no call spelling can  //
// DELIVER them — JavaScript ignores extra arguments to a 3-parameter     //
// function (the R24-1 runtime demonstration leg executes exactly that).  //
// TypeScript is a TYPED-CALL GATE ONLY (TS2554 on typed spellings); its  //
// honest boundary — bound createRequire (any), explicit any,            //
// Reflect.apply (no tuple arity), unchecked .js consumers, all INERT     //
// under the options-free surface — is frozen in the header. C3 pins BOTH //
// exported runner signatures and the unexported core (the RUNNER-        //
// SIGNATURE pin) and polices the runner's frozen importer set with the   //
// direct-call rule: no extractPackZipWithOptions call, and no            //
// extractPackZipOutOfProcess call with an argument count other than 3.   //
// The desktop CI typecheck (tsc --noEmit) remains a gate for typed       //
// calls. The rounds-17..20 enumeration (local aliases, namespace/        //
// computed keys, export-from seams, seam pair identity, loader           //
// fixpoints) and its regression zoo stay DELETED: enumerating spellings  //
// of a reference to an optional fourth parameter was unbounded — and     //
// R24 needs no enumeration either, because there is no parameter to      //
// reference. C1's INV-5a frozen export surfaces remain the SINGLE       //
// source of truth for the zip-install.ts seam; C1's INV-5b remains the   //
// single source of truth for pack-worker.ts's import edges.             //
// R25-1 (plan-critic round 22 — the executed false-green in repro/       //
// critic-round22-delegation-probe.mjs/.out): THREE DECLARED PARAMETERS   //
// DO NOT DISCARD arguments[3] — the pinned 3-parameter production        //
// wrapper's body can still read it, and the critic's exact mutant        //
// (WithOptions, the unexported core and all signatures conformant)       //
// delivered BOTH runtime controls ({timeoutMs: 5, childPath:            //
// 'env-production-child.js'} env-gated; {timeoutMs: 7, childPath:       //
// 'hidden-production-child.js'} hidden) with findings:[] and tsc exit   //
// 0. The WRAPPER BODIES are therefore part of the RUNNER-SIGNATURE      //
// pin: each exported wrapper's body must be EXACTLY the single-return    //
// delegation to the core built from its OWN parameters — the LITERAL     //
// {} for extractPackZipOutOfProcess, its OWN opts binding for           //
// extractPackZipWithOptions — with NO arguments-object reference, NO     //
// this reference, no rest parameter and no other statement. The         //
// demonstration leg executes the pinned synthetic runner's wrapper      //
// bodies themselves (and, at head, the REAL exported runner) against    //
// a POISON fourth argument.                                             //
// ==================================================================== //
describe('#320 AC3 P1a: extractPackZip is declared with EXACTLY 3 parameters (zip, filename, limits); the runner exports the 3-parameter OPTIONS-FREE extractPackZipOutOfProcess and the 4-parameter extractPackZipWithOptions backed by the UNEXPORTED runPackExtraction core, with BOTH exported wrappers\' BODIES pinned to the exact default-only/opts delegations (R25-1: no arguments object, no this, no other statement); no frozen importer of pack-worker.ts calls extractPackZipWithOptions or passes extractPackZipOutOfProcess an argument count other than 3', () => {
  /** R23-2a: the frozen parameter names of the public bridge signature. */
  const FROZEN_PARAM_NAMES = ['zip', 'filename', 'limits'] as const;
  /** R23-2b: C1 INV-5b's frozen importers of pack-worker.ts (read-only
   *  reference — the EDGE SET is C1's; C3 only polices calls inside it).
   *  Any NEW import edge of pack-worker.ts fails C1 outright, so a fourth
   *  importer cannot exist without a C1 finding first. */
  const FROZEN_RUNNER_IMPORTERS = [
    'backend/packs/pack-extract.ts',
    'index.ts',
    'backend/index.ts',
  ] as const;
  /** The bridge module (the signature pin's target). */
  const BRIDGE_REL = 'backend/packs/pack-extract.ts';
  /** R24-1: the runner module (the runner signature pin's target). */
  const RUNNER_REL = 'backend/packs/pack-worker.ts';
  /** R24-1: the frozen declared parameters of the OPTIONS-FREE production
   *  runner export — NO opts parameter exists on it. */
  const FROZEN_RUNNER_EXPORT_PARAMS = ['zipBytes', 'filename', 'limits'] as const;
  /** R24-1: the frozen declared parameters of the runner's TEST-CONTROL
   *  options variant (the only 4-parameter exported entry). */
  const FROZEN_RUNNER_WITH_OPTIONS_PARAMS = ['zipBytes', 'filename', 'limits', 'opts'] as const;
  /** R24-1: the frozen declared parameters of the UNEXPORTED options-aware
   *  core both exported entries delegate to. */
  const FROZEN_RUNNER_CORE_PARAMS = ['zipBytes', 'filename', 'limits', 'opts'] as const;

  /** The first declared FunctionDeclaration named extractPackZip in one
   *  source, or undefined when the module does not declare it. */
  function extractPackZipDeclaration(source: string, fileName = BRIDGE_REL): ts.FunctionDeclaration | undefined {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
    let found: ts.FunctionDeclaration | undefined;
    const walk = (node: ts.Node): void => {
      if (found === undefined && ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === 'extractPackZip') {
        found = node;
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return found;
  }

  /** R23-2a — the SIGNATURE PIN over one module's source: when the module
   *  declares extractPackZip, the declared FunctionDeclaration must have
   *  EXACTLY 3 parameters with the frozen names (zip, filename, limits),
   *  no rest parameter, exactly one declaration, and the export keyword.
   *  ANY change — a fourth parameter, a renamed parameter, a rest
   *  parameter, a duplicated or unexported declaration — is a finding
   *  naming the module and the rule. This pin is the COMPILER'S PREMISE:
   *  while it holds, tsc --noEmit rejects every four-argument call shape
   *  in desktop/main with TS2554 (the demonstration leg executes that
   *  closure below); if the signature drifts, this leg goes red BEFORE a
   *  drifted head could ever typecheck. */
  function signatureFindingsOf(rel: string, source: string): string[] {
    const findings: string[] = [];
    const declarations: ts.FunctionDeclaration[] = [];
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === 'extractPackZip') declarations.push(node);
      ts.forEachChild(node, collect);
    };
    collect(sf);
    if (declarations.length === 0) return findings; // presence is pinned by the real-tree leg
    if (declarations.length > 1) {
      findings.push(`${rel}: SIGNATURE extractPackZip must be declared exactly once (found ${declarations.length} FunctionDeclarations)`);
    }
    const declaration = declarations[0];
    if (declaration === undefined) return findings;
    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
      (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);
    if (!hasModifier(declaration, ts.SyntaxKind.ExportKeyword)) {
      findings.push(`${rel}: SIGNATURE extractPackZip must stay an EXPORTED FunctionDeclaration`);
    }
    const params = declaration.parameters;
    const names = params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '<non-identifier>'));
    if (
      params.length !== FROZEN_PARAM_NAMES.length ||
      names.some((name, i) => name !== FROZEN_PARAM_NAMES[i]) ||
      params.some((p) => p.dotDotDotToken !== undefined)
    ) {
      findings.push(
        `${rel}: SIGNATURE extractPackZip must be declared with EXACTLY 3 parameters (${FROZEN_PARAM_NAMES.join(', ')}) — found [${names.join(', ')}]`,
      );
    }
    return findings;
  }

  /** R24-1 + R25-1 — the RUNNER SIGNATURE-AND-BODY PIN: when the runner
   *  module is present in the scanned tree, BOTH exported extraction
   *  entries, the UNEXPORTED options-aware core AND THE TWO EXPORTED
   *  WRAPPERS' BODIES are pinned:
   *    extractPackZipOutOfProcess  EXPORTED, exactly 3 parameters
   *                                (zipBytes, filename, limits) — NO opts;
   *                                BODY = EXACTLY the default-only
   *                                delegation, one `return [await]
   *                                runPackExtraction(zipBytes, filename,
   *                                limits, {})` built from the wrapper's
   *                                OWN three named parameters and the
   *                                LITERAL empty object;
   *    extractPackZipWithOptions   EXPORTED, exactly 4 parameters
   *                                (zipBytes, filename, limits, opts);
   *                                BODY = the same single-return delegation
   *                                passing the wrapper's OWN opts binding
   *                                as the fourth argument;
   *    runPackExtraction           the UNEXPORTED options-aware core both
   *                                delegate to, exactly 4 parameters
   *                                (zipBytes, filename, limits, opts).
   *  This is the wiring the round-21 critic found missing ("signatureFindingsOf
   *  is not wired to the production runner's declaration"): the R23 contract
   *  still declared opts? on the production export, so an environment-gated
   *  four-argument call of it delivered the test controls at runtime with
   *  tsc exit 0 and P1a findings:[] (repro/critic-round21-structural-probes.
   *  out:2-12). R24 pinned the declared shapes; the round-22 critic then
   *  executed the FALSE GREEN R24 left open (repro/critic-round22-
   *  delegation-probe.mjs/.out): THREE DECLARED PARAMETERS DO NOT DISCARD
   *  arguments[3] — a non-arrow FunctionDeclaration can still read it — so
   *  the exact 3-parameter mutant whose body reads `const opts =
   *  (arguments[3] as PackExtractOptions | undefined) ?? {}` and forwards
   *  it passed this pin with findings:[] and tsc exit 0 while its runtime
   *  delivered {timeoutMs: 5, childPath: 'env-production-child.js'}
   *  (env-gated Reflect.apply route) and {timeoutMs: 7, childPath:
   *  'hidden-production-child.js'} (hidden-fourth-argument Reflect.apply
   *  route). R25-1 therefore pins the BODIES INSIDE this same function
   *  (deliberately NOT a new sibling declaration: every historical probe
   *  extracts this function BY NAME, and the amendment must keep those
   *  extraction lists valid): any `arguments` reference, any `this`
   *  reference, any rest parameter, any parameter count other than
   *  pinned, any statement other than the single delegation return, or a
   *  delegation argument other than the wrapper's OWN parameters (plus
   *  the literal {} / the opts binding in the fourth slot) is a finding.
   *  An ABSENT runner module pins nothing here: its PRESENCE is pinned by
   *  this spec's static import of pack-worker.js (the whole spec is RED
   *  at base while it is missing) and by the real-tree leg below. */
  function runnerSignatureFindingsOf(rel: string, source: string): string[] {
    const findings: string[] = [];
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
      (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);
    /** R25-1: a short description of one delegation argument for findings. */
    const argText = (arg: ts.Expression): string => {
      if (ts.isIdentifier(arg)) return arg.text;
      if (ts.isObjectLiteralExpression(arg)) return arg.properties.length === 0 ? '{}' : '{...}';
      return `<${ts.SyntaxKind[arg.kind] ?? arg.kind}>`;
    };
    /** R25-1 — the BODY PIN for one exported wrapper: the declaration body
     *  must be EXACTLY the delegation — a single return statement of the
     *  core call — built from the wrapper's OWN named parameters, with the
     *  pinned fourth argument (the LITERAL empty object for the
     *  options-free export; the opts binding for the options variant) and
     *  NO arguments-object or this reference anywhere in the body. The
     *  third (limits) argument of the options variant is not pinned to a
     *  single spelling: it is the limits channel, never an options
     *  channel — the options-aware control surface can enter ONLY through
     *  the fourth argument, which IS pinned. */
    const pinBody = (declaration: ts.FunctionDeclaration, label: string, ownParams: readonly string[], fourth: 'empty-object' | 'opts-binding'): void => {
      const body = declaration.body;
      if (body === undefined) {
        findings.push(`${rel}: RUNNER-BODY ${label} must have a body (the R25-1 delegation pin needs the declaration body)`);
        return;
      }
      let argumentsRefs = 0;
      let thisRefs = 0;
      const scan = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'arguments') argumentsRefs += 1;
        // TS 5.9 has no isThisExpression guard: an expression-position
        // `this` parses as the ThisKeyword token kind.
        if (node.kind === ts.SyntaxKind.ThisKeyword) thisRefs += 1;
        ts.forEachChild(node, scan);
      };
      scan(body);
      if (argumentsRefs > 0) {
        findings.push(
          `${rel}: RUNNER-BODY ${label} must not reference the arguments object (R25-1: a 3-parameter function can still read arguments[3] — the round-22 executed mutant delivered the test controls through exactly this) — found ${argumentsRefs} reference(s)`,
        );
      }
      if (thisRefs > 0) {
        findings.push(`${rel}: RUNNER-BODY ${label} must not reference this (R25-1: no this-based option flow) — found ${thisRefs} reference(s)`);
      }
      const only = body.statements.length === 1 ? body.statements[0] : undefined;
      if (only === undefined || !ts.isReturnStatement(only)) {
        findings.push(
          `${rel}: RUNNER-BODY ${label} must be EXACTLY the delegation — a single return statement calling the core with the wrapper's own named parameters${fourth === 'empty-object' ? ' and the literal empty object' : ' and its opts binding'} — found ${body.statements.length} statement(s)`,
        );
        return;
      }
      let returned = only.expression;
      if (returned !== undefined && ts.isAwaitExpression(returned)) returned = returned.expression;
      if (returned === undefined || !ts.isCallExpression(returned) || !ts.isIdentifier(returned.expression) || returned.expression.text !== 'runPackExtraction') {
        findings.push(
          `${rel}: RUNNER-BODY ${label} must delegate to the UNEXPORTED core runPackExtraction (the single returned expression must be the core call) — found ${returned === undefined ? 'no returned expression' : `<${ts.SyntaxKind[returned.kind] ?? returned.kind}>`}`,
        );
        return;
      }
      const args = returned.arguments;
      if (args.length !== 4) {
        findings.push(
          `${rel}: RUNNER-BODY ${label} must pass EXACTLY 4 arguments to the core (${[...ownParams, fourth === 'empty-object' ? '{}' : 'opts'].join(', ')}) — found ${args.length}: [${args.map(argText).join(', ')}]`,
        );
        return;
      }
      // The options-free export pins ALL THREE of its own parameters
      // (nothing else may feed the core). The options variant pins its
      // first two (zipBytes, filename); its third (limits) argument may be
      // the bare binding or the bridge-equivalent resolvePackLimits(...)
      // resolution — limits is not an options channel, and the ONLY
      // options channel (the fourth slot) is pinned below.
      const pinnedLeading = fourth === 'empty-object' ? 3 : 2;
      for (let i = 0; i < pinnedLeading; i += 1) {
        const arg = args[i];
        if (arg === undefined || !ts.isIdentifier(arg) || arg.text !== ownParams[i]) {
          findings.push(
            `${rel}: RUNNER-BODY ${label} must pass its OWN parameters (${ownParams.slice(0, pinnedLeading).join(', ')}) as the delegation's leading arguments — found [${args.map(argText).join(', ')}]`,
          );
          return;
        }
      }
      const fourthArg = args[3];
      if (fourth === 'empty-object') {
        if (fourthArg === undefined || !ts.isObjectLiteralExpression(fourthArg) || fourthArg.properties.length !== 0) {
          findings.push(
            `${rel}: RUNNER-BODY ${label} must pass the LITERAL EMPTY OBJECT {} as the delegation's fourth argument (the default-only resolution — DEFAULT_PACK_TIMEOUT_MS + packWorkerChildPath(), never caller-supplied options) — found ${fourthArg === undefined ? 'nothing' : argText(fourthArg)}`,
          );
        }
      } else if (fourthArg === undefined || !ts.isIdentifier(fourthArg) || fourthArg.text !== 'opts') {
        findings.push(
          `${rel}: RUNNER-BODY ${label} must pass its OWN opts binding as the delegation's fourth argument (the only sanctioned options channel) — found ${fourthArg === undefined ? 'nothing' : argText(fourthArg)}`,
        );
      }
    };
    const pin = (name: string, frozen: readonly string[], exported: boolean, label: string, delegation: 'default-only' | 'opts-binding' | undefined): void => {
      const declarations: ts.FunctionDeclaration[] = [];
      const collect = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === name) declarations.push(node);
        ts.forEachChild(node, collect);
      };
      collect(sf);
      if (declarations.length === 0) {
        findings.push(`${rel}: RUNNER-SIGNATURE ${label} is missing from the runner module`);
        return;
      }
      if (declarations.length > 1) {
        findings.push(`${rel}: RUNNER-SIGNATURE ${label} must be declared exactly once (found ${declarations.length} FunctionDeclarations)`);
      }
      const declaration = declarations[0];
      if (declaration === undefined) return;
      if (hasModifier(declaration, ts.SyntaxKind.ExportKeyword) !== exported) {
        findings.push(
          exported
            ? `${rel}: RUNNER-SIGNATURE ${label} must stay an EXPORTED FunctionDeclaration`
            : `${rel}: RUNNER-SIGNATURE ${label} must stay UNEXPORTED (the options-aware core is not part of the frozen 8-name surface)`,
        );
      }
      const params = declaration.parameters;
      const names = params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '<non-identifier>'));
      if (
        params.length !== frozen.length ||
        names.some((name2, i) => name2 !== frozen[i]) ||
        params.some((p) => p.dotDotDotToken !== undefined)
      ) {
        findings.push(
          `${rel}: RUNNER-SIGNATURE ${label} must be declared with EXACTLY ${frozen.length} parameters (${frozen.join(', ')}) — found [${names.join(', ')}]`,
        );
      }
      // R25-1: for a uniquely declared EXPORTED wrapper, the BODY is part
      // of the pin (the core's body is not pinned — it owns the whole
      // lifecycle contract; a duplicate declaration is already a finding).
      if (delegation !== undefined && declarations.length === 1 && declaration.body !== undefined) {
        pinBody(declaration, label, frozen, delegation === 'default-only' ? 'empty-object' : 'opts-binding');
      }
    };
    pin('extractPackZipOutOfProcess', FROZEN_RUNNER_EXPORT_PARAMS, true, 'extractPackZipOutOfProcess', 'default-only');
    pin('extractPackZipWithOptions', FROZEN_RUNNER_WITH_OPTIONS_PARAMS, true, 'extractPackZipWithOptions', 'opts-binding');
    pin('runPackExtraction', FROZEN_RUNNER_CORE_PARAMS, false, 'runPackExtraction (the unexported options-aware core)', undefined);
    return findings;
  }

  /** R23-2b + R24-1 — the DIRECT-CALL rule over a tree: within C1 INV-5b's
   *  three frozen importer modules of pack-worker.ts,
   *    (a) ANY CallExpression whose callee is the identifier
   *        extractPackZipWithOptions is a finding (the runner's options
   *        variant is TEST-CONTROL ONLY; production traffic rides
   *        extractPackZipOutOfProcess);
   *    (b) R24-1: ANY DIRECT call of extractPackZipOutOfProcess whose
   *        argument count is NOT 3 is a finding — the production export is
   *        options-free, so the round-21 critic's executed
   *        environment-gated FOUR-argument call (timeoutMs/childPath
   *        supplied; repro/critic-round21-structural-probes.out:2-12) is
   *        RED here, not merely counted.
   *  NO alias enumeration: the import edges of pack-worker.ts are frozen by
   *  C1, so every name that could reach either entry already rides one of
   *  these three policed edges — and with the R24-1 options-free signature
   *  even a NON-direct delivery is inert (the R24-1 demonstration leg).
   *  Also counts the LEGAL direct 3-argument calls of
   *  extractPackZipOutOfProcess in the same modules (anti-vacuity: the
   *  bridge's production edge is seen and stays legal). */
  function runnerOptionsFindingsOfTree(tree: ReadonlyMap<string, string>): { findings: string[]; runnerCalls: number } {
    const findings: string[] = [];
    let runnerCalls = 0;
    for (const rel of FROZEN_RUNNER_IMPORTERS) {
      const source = tree.get(rel);
      if (source === undefined) {
        findings.push(`${rel}: FROZEN-IMPORTER the C1 INV-5b importer module is missing from the scanned tree`);
        continue;
      }
      const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (node.expression.text === 'extractPackZipWithOptions') {
            findings.push(
              `${rel}: DIRECT-CALL of extractPackZipWithOptions (the runner's options variant is test-control only; no frozen importer of pack-worker.ts may call it — found a call with ${node.arguments.length} argument(s))`,
            );
          } else if (node.expression.text === 'extractPackZipOutOfProcess') {
            runnerCalls += 1;
            if (node.arguments.length !== 3) {
              findings.push(
                `${rel}: DIRECT-CALL-ARITY extractPackZipOutOfProcess must be called with EXACTLY 3 arguments (the production runner export is options-free, R24-1) — found a call with ${node.arguments.length} argument(s)`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return { findings, runnerCalls };
  }

  /** All three rules over one tree (the P1a aggregate): the bridge
   *  signature pin, the runner signature pin (R24-1) and the direct-call
   *  rule. An ABSENT runner module adds no finding — its presence is
   *  pinned by this spec's static import of pack-worker.js (the whole
   *  spec is RED at base while it is missing) and by the real-tree leg —
   *  so a base-tree scan stays green while the file genuinely does not
   *  exist pre-fix. */
  function p1aFindingsOfTree(tree: ReadonlyMap<string, string>): { findings: string[]; runnerCalls: number } {
    const bridgeSource = tree.get(BRIDGE_REL);
    const findings =
      bridgeSource === undefined
        ? [`${BRIDGE_REL}: FROZEN-BRIDGE the public bridge module is missing from the scanned tree`]
        : signatureFindingsOf(BRIDGE_REL, bridgeSource);
    const runnerSource = tree.get(RUNNER_REL);
    const runnerFindings = runnerSource === undefined ? [] : runnerSignatureFindingsOf(RUNNER_REL, runnerSource);
    const rule = runnerOptionsFindingsOfTree(tree);
    return { findings: [...findings, ...runnerFindings, ...rule.findings], runnerCalls: rule.runnerCalls };
  }

  /** AST-offset splice of the REAL declaration text (line-ending agnostic):
   *  'add-opts' inserts a fourth `opts?` parameter after `limits`;
   *  'rename-limits' renames the third parameter identifier to `options`.
   *  Used by the frozen signature regressions — a TEXT anchor would need
   *  CRLF/LF foreknowledge the real tree does not promise (the base file
   *  is CRLF; the `limits?:` line alone also occurs on resolvePackLimits
   *  at pack-extract.ts:227, so no single-line anchor is unique). */
  function mutateDeclarationText(source: string, mutation: 'add-opts' | 'rename-limits'): string {
    const sf = ts.createSourceFile(BRIDGE_REL, source, ts.ScriptTarget.Latest, true, scriptKindFor(BRIDGE_REL));
    const declaration = extractPackZipDeclaration(source);
    if (declaration === undefined) throw new Error('the declaration must exist for the mutation');
    if (mutation === 'add-opts') {
      const last = declaration.parameters[declaration.parameters.length - 1];
      if (last === undefined) throw new Error('the declaration must have parameters');
      return `${source.slice(0, last.end)},\n  opts?: { timeoutMs?: number; childPath?: string }${source.slice(last.end)}`;
    }
    const limitsParam = declaration.parameters[2];
    if (limitsParam === undefined || !ts.isIdentifier(limitsParam.name)) {
      throw new Error('the third parameter must be the identifier limits');
    }
    const start = limitsParam.name.getStart(sf);
    return `${source.slice(0, start)}options${source.slice(start + limitsParam.name.text.length)}`;
  }

  it('the REAL tree: the declared extractPackZip has EXACTLY 3 parameters named (zip, filename, limits); the runner exports the OPTIONS-FREE 3-parameter extractPackZipOutOfProcess and the 4-parameter extractPackZipWithOptions backed by the UNEXPORTED runPackExtraction core, with BOTH exported wrappers\' bodies pinned to the exact default-only/opts delegations (R25-1: no arguments object, no this, no other statement); no frozen importer calls the options variant or passes the production export an argument count other than 3; the production caller keeps its 3-arg shape', () => {
    expect(fs.existsSync(EXTRACT_SOURCE), 'the bridge must exist').toBe(true);
    expect(fs.existsSync(RUNNER_SOURCE), 'the runner must exist (R24-1: the runner signature pin has a target)').toBe(true);
    const tree = new Map<string, string>();
    for (const file of listSourceFiles(MAIN_DIR)) tree.set(relToMain(file), fs.readFileSync(file, 'utf8'));
    expect(tree.size).toBeGreaterThan(10); // anti-vacuity: the real tree is really loaded
    const scan = p1aFindingsOfTree(tree);
    expect(scan.findings, 'the signature pins hold and no frozen importer calls the options variant or violates the production arity').toEqual([]);
    // The declarations are really present and really parsed (anti-vacuity).
    const declaration = extractPackZipDeclaration(tree.get(BRIDGE_REL) as string);
    expect(declaration, 'pack-extract.ts really declares the FunctionDeclaration extractPackZip').toBeDefined();
    expect(declaration?.parameters.length).toBe(3);
    expect(tree.get(RUNNER_REL), 'pack-worker.ts is really in the scanned tree (the runner pin is non-vacuous)').toBeDefined();
    // The known production caller keeps its 3-arg shape textually too.
    const surface = stripComments(fs.readFileSync(SURFACE_SOURCE, 'utf8'));
    expect(surface).toContain('await extractPackZip(zip, filename, {');
  });

  // ---- R24-1 synthetic runner sources (the planted runner regressions).
  // CONFORMANT_R24_RUNNER carries the frozen R24-1 shape verbatim; the
  // drift rows below plant the named deviation into that text via
  // runnerPlant(). The plants are SCANNED, never executed.
  const CONFORMANT_R24_RUNNER = [
    'export interface PackExtractOptions { timeoutMs?: number; childPath?: string; }',
    'export interface PackSecurityLimits { maxUncompressedBytes: number; maxEntries: number; maxCompressionRatio: number; }',
    'export async function extractPackZipOutOfProcess(',
    '  zipBytes: Uint8Array,',
    '  filename: string,',
    '  limits: PackSecurityLimits,',
    '): Promise<string> {',
    '  return await runPackExtraction(zipBytes, filename, limits, {});',
    '}',
    'export async function extractPackZipWithOptions(',
    '  zipBytes: Uint8Array,',
    '  filename: string,',
    '  limits?: Partial<PackSecurityLimits>,',
    '  opts?: PackExtractOptions,',
    '): Promise<string> {',
    '  return await runPackExtraction(zipBytes, filename, resolvePackLimits(process.env, limits), opts);',
    '}',
    'async function runPackExtraction(',
    '  zipBytes: Uint8Array,',
    '  filename: string,',
    '  limits: PackSecurityLimits,',
    '  opts: PackExtractOptions = {},',
    '): Promise<string> {',
    '  return filename;',
    '}',
  ].join('\n');

  /** The named R24-1/R25-1 runner drift shapes, planted into the conformant
   *  synthetic runner (single anchored splices of OUR OWN text, so the
   *  anchors are exact by construction). The R25-1 body rows plant the
   *  round-22 critic's executed mutant bodies into the conformant source. */
  function runnerPlant(mutation: 'conformant' | 'opts-on-export' | 'with-options-arity' | 'core-exported' | 'core-missing' | 'arguments-body-critic' | 'arguments-body-env' | 'this-body'): string {
    switch (mutation) {
      case 'conformant':
        return CONFORMANT_R24_RUNNER;
      case 'opts-on-export':
        // The Revision-23 contract shape the round-21 critic executed: the
        // production export re-gains a fourth opts parameter.
        return CONFORMANT_R24_RUNNER.replace(
          '  limits: PackSecurityLimits,\n): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, limits, {});',
          '  limits: PackSecurityLimits,\n  opts?: PackExtractOptions,\n): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, limits, opts);',
        );
      case 'with-options-arity':
        // The options variant loses its fourth parameter.
        return CONFORMANT_R24_RUNNER.replace(
          '  limits?: Partial<PackSecurityLimits>,\n  opts?: PackExtractOptions,\n): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, resolvePackLimits(process.env, limits), opts);',
          '  limits?: Partial<PackSecurityLimits>,\n): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, resolvePackLimits(process.env, limits), {});',
        );
      case 'core-exported':
        return CONFORMANT_R24_RUNNER.replace('async function runPackExtraction(', 'export async function runPackExtraction(');
      case 'core-missing':
        return CONFORMANT_R24_RUNNER.replace(
          '\nasync function runPackExtraction(\n  zipBytes: Uint8Array,\n  filename: string,\n  limits: PackSecurityLimits,\n  opts: PackExtractOptions = {},\n): Promise<string> {\n  return filename;\n}',
          '',
        );
      case 'arguments-body-critic':
        // R25-1: the round-22 critic's EXACT mutant body (repro/
        // critic-round22-delegation-probe.mjs:85-92) planted into the
        // conformant source — the pinned three-parameter production export
        // whose body reads arguments[3] and forwards it to the core (the
        // hidden-fourth-argument delivery variant; every declared shape
        // stays conformant, which is exactly why the R24 shape-only pin
        // was green on it).
        return CONFORMANT_R24_RUNNER.replace(
          '): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, limits, {});\n}',
          '): Promise<string> {\n  const opts = (arguments[3] as PackExtractOptions | undefined) ?? {};\n  return await runPackExtraction(zipBytes, filename, limits, opts);\n}',
        );
      case 'arguments-body-env':
        // R25-1: the environment-gated delivery variant planted INSIDE the
        // production wrapper body (the probe's other runtime row delivered
        // {timeoutMs: 5, childPath: 'env-production-child.js'}).
        return CONFORMANT_R24_RUNNER.replace(
          '): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, limits, {});\n}',
          "): Promise<string> {\n  if (process.env.TRAININGAPP_R24_ARGUMENTS_PROBE === '1') {\n    return await runPackExtraction(zipBytes, filename, limits, arguments[3] as PackExtractOptions);\n  }\n  return await runPackExtraction(zipBytes, filename, limits, {});\n}",
        );
      case 'this-body':
        // R25-1: a this-based option flow in the production wrapper (the
        // arguments-object's sibling escape the round-22 finding names).
        return CONFORMANT_R24_RUNNER.replace(
          '): Promise<string> {\n  return await runPackExtraction(zipBytes, filename, limits, {});\n}',
          '): Promise<string> {\n  const opts = (this as unknown as { hiddenOpts?: PackExtractOptions }).hiddenOpts ?? {};\n  return await runPackExtraction(zipBytes, filename, limits, opts);\n}',
        );
    }
  }

  /** R25-1: the round-22 critic's EXACT probe runner, VERBATIM (repro/
   *  critic-round22-delegation-probe.mjs:69-101): every declared shape is
   *  R24-conformant (3-parameter production export, 4-parameter
   *  WithOptions, unexported 4-parameter core) — the production wrapper's
   *  BODY reads arguments[3] and forwards it. Under the R24 shape-only pin
   *  this exact source produced findings:[] with tsc exit 0 while its
   *  runtime delivered both controls. */
  const R22_CRITIC_RUNNER = [
    'export interface PackSecurityLimits { maxEntries?: number; maxUncompressedBytes?: number; maxCompressionRatio?: number; }',
    'export interface PackExtractOptions { timeoutMs?: number; childPath?: string; }',
    'export const DEFAULT_PACK_TIMEOUT_MS = 120_000;',
    'export function nodeForkPackWorker(): null { return null; }',
    'export function setPackWorkerForkFn(): void {}',
    'export function resolvePackWorkerForkFn(): null { return null; }',
    'export function terminatePackWorkers(): void {}',
    "export function packWorkerChildPath(): string { return 'default-pack-extract-child.js'; }",
    'async function runPackExtraction(',
    '  zipBytes: Uint8Array,',
    '  filename: string,',
    '  limits: Partial<PackSecurityLimits>,',
    '  opts: PackExtractOptions = {},',
    '): Promise<string> {',
    '  return JSON.stringify({ filename, zip: zipBytes.length, limits, resolved: { timeoutMs: opts.timeoutMs ?? DEFAULT_PACK_TIMEOUT_MS, childPath: opts.childPath ?? packWorkerChildPath() } });',
    '}',
    'export async function extractPackZipOutOfProcess(',
    '  zipBytes: Uint8Array,',
    '  filename: string,',
    '  limits: Partial<PackSecurityLimits>,',
    '): Promise<string> {',
    '  const opts = (arguments[3] as PackExtractOptions | undefined) ?? {};',
    '  return await runPackExtraction(zipBytes, filename, limits, opts);',
    '}',
    'export async function extractPackZipWithOptions(',
    '  zipBytes: Uint8Array,',
    '  filename: string,',
    '  limits?: Partial<PackSecurityLimits>,',
    '  opts?: PackExtractOptions,',
    '): Promise<string> {',
    '  return await runPackExtraction(zipBytes, filename, limits ?? {}, opts);',
    '}',
  ].join('\n');

  /** R25-1: the round-22 critic's EXACT probe bridge, VERBATIM (repro/
   *  critic-round22-delegation-probe.mjs:56-67) — carrying BOTH Reflect
   *  delivery routes: the environment-gated Reflect.apply delivery of
   *  {timeoutMs: 5, childPath: 'env-production-child.js'} and the hidden
   *  arguments[3] Reflect.apply delivery. It contains NO direct
   *  four-argument call (its only direct runner call is the legal
   *  three-argument one), so the DIRECT-CALL-ARITY arm cannot fire on it —
   *  the RUNNER-BODY pin is what must catch the mutant this bridge feeds.
   *  The bridge's own public signature is 3-parameter conformant. */
  const R22_CRITIC_BRIDGE = [
    "import { extractPackZipOutOfProcess } from './pack-worker.js';",
    'export interface PackSecurityLimits { maxEntries?: number; maxUncompressedBytes?: number; maxCompressionRatio?: number; }',
    'interface Opts { timeoutMs?: number; childPath?: string; }',
    'export async function extractPackZip(zip: Uint8Array, filename: string, limits?: Partial<PackSecurityLimits>): Promise<string> {',
    '  const resolved = limits ?? {};',
    "  if (process.env.TRAININGAPP_R24_ARGUMENTS_PROBE === '1') {",
    "    return Reflect.apply(extractPackZipOutOfProcess, undefined, [zip, filename, resolved, { timeoutMs: 5, childPath: 'env-production-child.js' }]);",
    '  }',
    '  const hidden = arguments[3] as Opts | undefined;',
    '  if (hidden !== undefined) return Reflect.apply(extractPackZipOutOfProcess, undefined, [zip, filename, resolved, hidden]);',
    '  return extractPackZipOutOfProcess(zip, filename, resolved);',
    '}',
  ].join('\n');

  // ---- FROZEN REGRESSIONS (R23-2a/R23-2b + R24-1): the rules fire on
  // their exact drift shapes, naming the module and the rule. The signature
  // rows rewrite the REAL declaration (replace: the anchor must occur
  // exactly once); the direct-call rows append the executed probe call into
  // each of the three frozen importer modules in turn — proving every one
  // of the three is really scanned; the runner rows PLANT a synthetic
  // pack-worker.ts carrying the named deviation. The negative rows pin the
  // LEGAL shapes: the bridge's three-argument extractPackZipOutOfProcess
  // production edge stays green and is counted, and the conformant R24-1
  // runner passes the runner pin.
  const P1A_REGRESSIONS: Array<{
    id: string;
    /** Mutate the real tree; undefined module = fresh consumer file. */
    importerRel: string;
    mutateSignature?: 'add-opts' | 'rename-limits';
    append?: string;
    /** R24-1: replace the scanned runner module with a synthetic plant. */
    plantRunner?: string;
    /** R25-1: also replace the scanned bridge module with a synthetic plant
     *  (the round-22 probe tree replaces BOTH policed modules). */
    plantBridge?: string;
    mustMention: string[];
    mustNotMention?: string[];
    /** Negative rows pin the legal-seam count (extractPackZipOutOfProcess calls). */
    runnerCallsDelta?: number;
  }> = [
    {
      // The historical defect class, stated once: a fourth parameter on the
      // public signature (the R17..R22 rounds' entire subject). The splice is
      // an AST-OFFSET mutation of the REAL declaration (line-ending agnostic;
      // the `limits?:` text alone also occurs on resolvePackLimits at
      // pack-extract.ts:227, so no single-line anchor is unique).
      id: 'FOURTH PARAMETER on the real declaration (opts?: ...) — the SIGNATURE pin fires naming the module and the found parameter list',
      importerRel: 'backend/packs/pack-extract.ts',
      mutateSignature: 'add-opts',
      mustMention: [
        'backend/packs/pack-extract.ts: SIGNATURE extractPackZip must be declared with EXACTLY 3 parameters (zip, filename, limits) — found [zip, filename, limits, opts]',
      ],
    },
    {
      id: 'RENAMED parameter (limits -> options) — the SIGNATURE pin fires on the frozen names',
      importerRel: 'backend/packs/pack-extract.ts',
      mutateSignature: 'rename-limits',
      mustMention: [
        'backend/packs/pack-extract.ts: SIGNATURE extractPackZip must be declared with EXACTLY 3 parameters (zip, filename, limits) — found [zip, filename, options]',
      ],
    },
    {
      // The runner-side rule, one row per frozen importer — each module is
      // really scanned (a rule that skipped any of the three would pass its
      // row's importer green).
      id: 'DIRECT extractPackZipWithOptions call inside pack-extract.ts (the bridge importer) — the DIRECT-CALL rule fires naming the module',
      importerRel: 'backend/packs/pack-extract.ts',
      append: [
        "if (process.env.TRAININGAPP_R23_PROBE === '1') {",
        "  void extractPackZipWithOptions(new Uint8Array(), 'production.zip', undefined, { timeoutMs: 5 });",
        '}',
      ].join('\n'),
      mustMention: [
        "backend/packs/pack-extract.ts: DIRECT-CALL of extractPackZipWithOptions (the runner's options variant is test-control only; no frozen importer of pack-worker.ts may call it — found a call with 4 argument(s))",
      ],
    },
    {
      id: 'DIRECT extractPackZipWithOptions call inside index.ts (the bootstrap importer) — the DIRECT-CALL rule fires naming the module',
      importerRel: 'index.ts',
      append: [
        "if (process.env.TRAININGAPP_R23_PROBE === '1') {",
        "  void extractPackZipWithOptions(new Uint8Array(), 'production.zip', undefined, { timeoutMs: 5 });",
        '}',
      ].join('\n'),
      mustMention: [
        "index.ts: DIRECT-CALL of extractPackZipWithOptions (the runner's options variant is test-control only; no frozen importer of pack-worker.ts may call it — found a call with 4 argument(s))",
      ],
    },
    {
      id: 'DIRECT extractPackZipWithOptions call inside backend/index.ts (the stop-wiring importer) — the DIRECT-CALL rule fires naming the module',
      importerRel: 'backend/index.ts',
      append: [
        "if (process.env.TRAININGAPP_R23_PROBE === '1') {",
        "  void extractPackZipWithOptions(new Uint8Array(), 'production.zip', undefined, { timeoutMs: 5 });",
        '}',
      ].join('\n'),
      mustMention: [
        "backend/index.ts: DIRECT-CALL of extractPackZipWithOptions (the runner's options variant is test-control only; no frozen importer of pack-worker.ts may call it — found a call with 4 argument(s))",
      ],
    },
    {
      // R24-1: the round-21 critic's EXECUTED escape (finding 1) — the
      // environment-gated production branch calling the runner's
      // options-capable export DIRECTLY with four arguments. Under the R23
      // rules this exact tree was GREEN (tsc exit 0, P1a findings:[],
      // runnerArgc 4 at runtime — repro/critic-round21-structural-probes.
      // out:2-12); the arity arm makes it RED.
      id: 'DIRECT FOUR-ARGUMENT extractPackZipOutOfProcess call inside pack-extract.ts (the round-21 critic probe shape, timeoutMs/childPath supplied) — the DIRECT-CALL-ARITY arm fires',
      importerRel: 'backend/packs/pack-extract.ts',
      append: [
        "if (process.env.TRAININGAPP_R24_PROBE === '1') {",
        '  void extractPackZipOutOfProcess(new Uint8Array(), \'production.zip\', { maxUncompressedBytes: 1, maxEntries: 1, maxCompressionRatio: 1 }, { timeoutMs: 5, childPath: \'env-production-child.js\' });',
        '}',
      ].join('\n'),
      mustMention: [
        "backend/packs/pack-extract.ts: DIRECT-CALL-ARITY extractPackZipOutOfProcess must be called with EXACTLY 3 arguments (the production runner export is options-free, R24-1) — found a call with 4 argument(s)",
      ],
    },
    {
      id: 'DIRECT FOUR-ARGUMENT extractPackZipOutOfProcess call inside index.ts (the bootstrap importer) — the DIRECT-CALL-ARITY arm fires',
      importerRel: 'index.ts',
      append: [
        "if (process.env.TRAININGAPP_R24_PROBE === '1') {",
        '  void extractPackZipOutOfProcess(new Uint8Array(), \'production.zip\', { maxUncompressedBytes: 1, maxEntries: 1, maxCompressionRatio: 1 }, { timeoutMs: 5, childPath: \'env-production-child.js\' });',
        '}',
      ].join('\n'),
      mustMention: [
        "index.ts: DIRECT-CALL-ARITY extractPackZipOutOfProcess must be called with EXACTLY 3 arguments (the production runner export is options-free, R24-1) — found a call with 4 argument(s)",
      ],
    },
    {
      id: 'DIRECT FOUR-ARGUMENT extractPackZipOutOfProcess call inside backend/index.ts (the stop-wiring importer) — the DIRECT-CALL-ARITY arm fires',
      importerRel: 'backend/index.ts',
      append: [
        "if (process.env.TRAININGAPP_R24_PROBE === '1') {",
        '  void extractPackZipOutOfProcess(new Uint8Array(), \'production.zip\', { maxUncompressedBytes: 1, maxEntries: 1, maxCompressionRatio: 1 }, { timeoutMs: 5, childPath: \'env-production-child.js\' });',
        '}',
      ].join('\n'),
      mustMention: [
        "backend/index.ts: DIRECT-CALL-ARITY extractPackZipOutOfProcess must be called with EXACTLY 3 arguments (the production runner export is options-free, R24-1) — found a call with 4 argument(s)",
      ],
    },
    {
      // R24-1: the RUNNER SIGNATURE pin on the exploited contract shape —
      // the production export re-gaining the fourth opts parameter this
      // spec's Revision-23 contract carried.
      id: 'RUNNER SIGNATURE: extractPackZipOutOfProcess re-gains a fourth opts parameter (the Revision-23 contract shape the round-21 critic executed) — the RUNNER-SIGNATURE pin fires naming the module and the found parameter list',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('opts-on-export'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-SIGNATURE extractPackZipOutOfProcess must be declared with EXACTLY 3 parameters (zipBytes, filename, limits) — found [zipBytes, filename, limits, opts]',
      ],
    },
    {
      id: 'RUNNER SIGNATURE: extractPackZipWithOptions loses its fourth parameter — the RUNNER-SIGNATURE pin fires on the options variant',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('with-options-arity'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-SIGNATURE extractPackZipWithOptions must be declared with EXACTLY 4 parameters (zipBytes, filename, limits, opts) — found [zipBytes, filename, limits]',
      ],
    },
    {
      id: 'RUNNER SIGNATURE: the options-aware core runPackExtraction is EXPORTED — the RUNNER-SIGNATURE pin fires (the core must stay off the frozen 8-name surface)',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('core-exported'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-SIGNATURE runPackExtraction (the unexported options-aware core) must stay UNEXPORTED (the options-aware core is not part of the frozen 8-name surface)',
      ],
    },
    {
      id: 'RUNNER SIGNATURE: the options-aware core runPackExtraction is DELETED (both exports delegate to nothing) — the RUNNER-SIGNATURE pin fires',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('core-missing'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-SIGNATURE runPackExtraction (the unexported options-aware core) is missing from the runner module',
      ],
    },
    {
      // R25-1 (round-22 finding): the critic's EXACT three-parameter
      // arguments[3] mutant runner — every declared shape R24-conformant,
      // so the R24 shape-only pin returned findings:[] for exactly this
      // source while its runtime delivered the hidden-fourth-argument
      // control ({timeoutMs: 7, childPath: 'hidden-production-child.js'}).
      // The RUNNER-BODY pin fires on BOTH the arguments reference and the
      // non-delegation body.
      id: 'RUNNER BODY: the round-22 critic EXACT three-parameter arguments[3] mutant runner (the hidden-fourth-argument delivery variant — its runtime row delivered {timeoutMs:7, childPath:hidden-production-child.js} with P1a findings:[] and tsc exit 0) — the RUNNER-BODY pin fires on the arguments reference AND the non-delegation body',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: R22_CRITIC_RUNNER,
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must not reference the arguments object (R25-1: a 3-parameter function can still read arguments[3] — the round-22 executed mutant delivered the test controls through exactly this) — found 1 reference(s)',
        "backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must be EXACTLY the delegation — a single return statement calling the core with the wrapper's own named parameters and the literal empty object — found 2 statement(s)",
      ],
    },
    {
      // R25-1: BOTH Reflect delivery routes — the critic's FULL round-22
      // probe tree: the exact mutant runner fed by the exact probe bridge
      // (the environment-gated Reflect.apply delivery AND the
      // hidden-arguments Reflect.apply delivery). The bridge carries NO
      // direct four-argument call, so the DIRECT-CALL-ARITY arm cannot
      // fire on it — the RUNNER-BODY pin is what makes the tree red.
      id: 'RUNNER BODY + BOTH REFLECT DELIVERY ROUTES: the critic full round-22 probe tree (the env-gated Reflect.apply delivery of {timeoutMs:5,childPath:env-production-child.js} AND the hidden arguments[3] Reflect.apply delivery, against the exact mutant runner) — the RUNNER-BODY pin fires; the arity arm does not (no direct four-argument call exists anywhere in the tree)',
      importerRel: 'backend/packs/pack-extract.ts',
      plantBridge: R22_CRITIC_BRIDGE,
      plantRunner: R22_CRITIC_RUNNER,
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must not reference the arguments object',
      ],
      mustNotMention: ['DIRECT-CALL-ARITY'],
    },
    {
      // R25-1: the hidden-fourth-argument delivery variant planted into the
      // conformant synthetic runner (the critic mutant body verbatim).
      id: 'RUNNER BODY: the hidden-fourth-argument delivery variant planted into the conformant synthetic runner (the critic mutant body verbatim) — the RUNNER-BODY pin fires on the arguments reference AND the non-delegation body',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('arguments-body-critic'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must not reference the arguments object',
        "backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must be EXACTLY the delegation — a single return statement calling the core with the wrapper's own named parameters and the literal empty object — found 2 statement(s)",
      ],
    },
    {
      // R25-1: the environment-gated delivery variant planted INSIDE the
      // production wrapper body (the probe's other runtime row delivered
      // {timeoutMs: 5, childPath: 'env-production-child.js'}).
      id: 'RUNNER BODY: the environment-gated arguments[3] delivery variant inside the production wrapper (forwarded under TRAININGAPP_R24_ARGUMENTS_PROBE — the probe\'s other runtime row) — the RUNNER-BODY pin fires',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('arguments-body-env'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must not reference the arguments object',
      ],
    },
    {
      // R25-1: the this-based sibling of the arguments escape.
      id: 'RUNNER BODY: a this-based option flow in the production wrapper (this.hiddenOpts forwarded to the core) — the RUNNER-BODY pin fires on the this reference AND the non-delegation body',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('this-body'),
      mustMention: [
        'backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must not reference this (R25-1: no this-based option flow) — found 1 reference(s)',
        "backend/packs/pack-worker.ts: RUNNER-BODY extractPackZipOutOfProcess must be EXACTLY the delegation — a single return statement calling the core with the wrapper's own named parameters and the literal empty object — found 2 statement(s)",
      ],
    },
    {
      // R24-1/R25-1 negative: the conformant synthetic runner passes the
      // pin — signatures AND the exact default-only/opts delegation bodies.
      id: 'NEGATIVE: a CONFORMANT R24-1/R25-1 runner (3-parameter options-free extractPackZipOutOfProcess + 4-parameter extractPackZipWithOptions + UNEXPORTED runPackExtraction core, both wrapper bodies the exact pinned delegations) stays GREEN under the RUNNER-SIGNATURE-AND-BODY pin',
      importerRel: 'backend/packs/pack-extract.ts',
      plantRunner: runnerPlant('conformant'),
      mustMention: [],
    },
    {
      // The negative: the production edge of the runner (the bridge's
      // extractPackZipOutOfProcess delegation, 3 args) stays LEGAL and is
      // counted — the rule polices the options variant, not the runner.
      id: 'NEGATIVE: the bridge appending a LEGAL extractPackZipOutOfProcess three-argument call stays GREEN and is counted (runnerCalls + 1)',
      importerRel: 'backend/packs/pack-extract.ts',
      append: [
        'export async function r23LegalRunnerEdge(zip: Uint8Array, filename: string): Promise<string> {',
        '  return await extractPackZipOutOfProcess(zip, filename, { maxUncompressedBytes: 1, maxEntries: 1, maxCompressionRatio: 1 });',
        '}',
      ].join('\n'),
      mustMention: [],
      runnerCallsDelta: 1,
    },
  ];

  it.each(P1A_REGRESSIONS.map((row) => [row.id, row] as const))(
    'frozen regression: %s',
    (_id, row) => {
      const tree = new Map<string, string>();
      for (const file of listSourceFiles(MAIN_DIR)) tree.set(relToMain(file), fs.readFileSync(file, 'utf8'));
      const base = p1aFindingsOfTree(tree);
      expect(base.findings, 'the unmodified real tree is green').toEqual([]);
      const current = tree.get(row.importerRel);
      expect(current, `${row.importerRel} must exist in the real tree`).toBeDefined();
      if (row.mutateSignature !== undefined) {
        // The mutation is an AST-offset splice of the REAL declaration —
        // it fails loudly when the declaration moved or changed shape.
        const before = (current as string).length;
        const mutated = mutateDeclarationText(current as string, row.mutateSignature);
        expect(mutated.length, 'the mutation really changed the declaration text').not.toBe(before);
        tree.set(row.importerRel, mutated);
      }
      if (row.append !== undefined) {
        tree.set(row.importerRel, `${current as string}\n${row.append}\n`);
      }
      if (row.plantRunner !== undefined) {
        // R24-1: the row plants a synthetic runner module (the planted
        // text is really different from the real head runner for every
        // drift row — the assertions below prove the plant took effect).
        tree.set(RUNNER_REL, row.plantRunner);
      }
      if (row.plantBridge !== undefined) {
        // R25-1: the row also plants a synthetic bridge module (the
        // round-22 probe tree replaces BOTH policed modules; the planted
        // bridge is signature-conformant and carries only Reflect routes).
        tree.set(BRIDGE_REL, row.plantBridge);
      }
      const scan = p1aFindingsOfTree(tree);
      const joined = scan.findings.join('\n');
      for (const needle of row.mustMention) {
        expect(joined, `findings must mention [${needle}]: ${joined}`).toContain(needle);
      }
      for (const banned of row.mustNotMention ?? []) {
        expect(joined, `findings must NOT mention [${banned}]: ${joined}`).not.toContain(banned);
      }
      if (row.mustMention.length === 0) {
        expect(scan.findings, 'the negative row stays GREEN').toEqual([]);
      }
      if (row.runnerCallsDelta !== undefined) {
        expect(scan.runnerCalls, 'the legal runner edge is really counted').toBe(base.runnerCalls + row.runnerCallsDelta);
      }
    },
  );

  // ---- R24-2 DEMONSTRATION (executed): the typed-call gate and its HONEST
  // BOUNDARY (reframes the R23-2 leg — TS2554 is the gate's SCOPE, not the
  // safety claim). In a throwaway synthetic tree carrying the pinned
  // 3-parameter signature, the compiler rejects the TYPED four-argument
  // spellings — (i) DIRECT, (ii) ALIASED (const p = extractPackZip;
  // p(z, f, l, o)) and (iii) NAMESPACE computed-key (pack[k](z, f, l, o))
  // — each exactly TS2554 ("Expected 2-3 arguments, but got 4"), while the
  // conformant two/three-argument control compiles clean. The gate's
  // boundary, executed in the SAME program under the repo's NodeNext
  // options: a BOUND createRequire loader (NodeRequire's call signature
  // returns any), an EXPLICIT ANY alias, and Reflect.apply (ArrayLike, no
  // tuple arity) produce NO TS2554 — and tsc does not check every
  // extension C1 scans: desktop/tsconfig.json includes only main/**/*.ts
  // with allowJs/checkJs false, so the standalone unchecked .js consumer
  // on disk is NOT in the program at all (the round-21 critic EXECUTED
  // that consumer's four-argument call — repro/
  // critic-round21-structural-probes.out:23-41). SAFETY does not rest on
  // this gate: it rests on the options-free production surface, whose
  // runtime inertness the R24-1 demonstration leg below executes. The
  // scoped-tsc twin of the typed rows is repro/r23-tsc-arity-demo.out.
  it('R23-2/R24-2 demonstration: TYPED four-argument spellings (DIRECT, ALIASED, NAMESPACE computed-key) are each exactly one TS2554 under the pinned 3-parameter signature — while bound createRequire, an explicit any alias and Reflect.apply produce NO TS2554 and a standalone .js consumer is absent from the program entirely: the compiler is the typed-call gate, not the safety claim', () => {
    const dir = makeTempDir();
    // The repo's module shape (type:module + NodeNext), so the honest-
    // boundary rows run under the same compiler options the critic used.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const bridge = [
      'export interface PackSecurityLimits {',
      '  maxUncompressedBytes?: number;',
      '  maxEntries?: number;',
      '  maxCompressionRatio?: number;',
      '}',
      'export async function extractPackZip(',
      '  zip: Uint8Array,',
      '  filename: string,',
      '  limits?: Partial<PackSecurityLimits>,',
      '): Promise<string> {',
      "  return `${filename}:${zip.length}:${JSON.stringify(limits ?? {})}`;",
      '}',
    ].join('\n');
    // The pin accepts exactly this shape...
    expect(signatureFindingsOf('demo/bridge.ts', bridge)).toEqual([]);
    // ...and rejects the drifted 4-parameter shape (the premise guard).
    expect(signatureFindingsOf('demo/bridge.ts', bridge.replace('  limits?: Partial<PackSecurityLimits>,', '  limits?: Partial<PackSecurityLimits>,\n  opts?: { timeoutMs?: number },'))).toContain(
      'demo/bridge.ts: SIGNATURE extractPackZip must be declared with EXACTLY 3 parameters (zip, filename, limits) — found [zip, filename, limits, opts]',
    );
    const files: Array<[string, string]> = [
      ['bridge.ts', bridge],
      [
        'direct.ts',
        [
          "import { extractPackZip } from './bridge.js';",
          'export const direct: Promise<string> = extractPackZip(new Uint8Array(), "p.zip", undefined, { timeoutMs: 5 });',
        ].join('\n'),
      ],
      [
        'alias.ts',
        [
          "import { extractPackZip } from './bridge.js';",
          'const p = extractPackZip;',
          'export const aliased: Promise<string> = p(new Uint8Array(), "p.zip", undefined, { timeoutMs: 5 });',
        ].join('\n'),
      ],
      [
        'namespace.ts',
        [
          "import * as pack from './bridge.js';",
          "const k = 'extractPackZip';",
          'export const namespaced: Promise<string> = pack[k](new Uint8Array(), "p.zip", undefined, { timeoutMs: 5 });',
        ].join('\n'),
      ],
      [
        // The honest boundary, row by row (the critic's config-edge
        // evidence, executed here under the same pinned signature).
        'bound-loader.ts',
        [
          "import { createRequire } from 'node:module';",
          "import { extractPackZip } from './bridge.js';",
          'const req = createRequire(import.meta.url);',
          "const pack = req('./bridge.js');",
          'export const boundLoader: unknown = pack.extractPackZip(new Uint8Array(), "p.zip", undefined, { timeoutMs: 5 });',
        ].join('\n'),
      ],
      [
        'any-alias.ts',
        [
          "import { extractPackZip } from './bridge.js';",
          'const p: any = extractPackZip;',
          'export const anyAliased: unknown = p(new Uint8Array(), "p.zip", undefined, { timeoutMs: 5 });',
        ].join('\n'),
      ],
      [
        'reflect.ts',
        [
          "import { extractPackZip } from './bridge.js';",
          'export const reflected: Promise<string> = Reflect.apply(extractPackZip, undefined, [new Uint8Array(), "p.zip", undefined, { timeoutMs: 5 }]);',
        ].join('\n'),
      ],
      [
        'control.ts',
        [
          "import { extractPackZip } from './bridge.js';",
          'export const twoArg: Promise<string> = extractPackZip(new Uint8Array(), "p.zip");',
          'export const threeArg: Promise<string> = extractPackZip(new Uint8Array(), "p.zip", { maxEntries: 2 });',
        ].join('\n'),
      ],
    ];
    const rootNames: string[] = [];
    for (const [name, source] of files) {
      const full = path.join(dir, name);
      fs.writeFileSync(full, source);
      rootNames.push(full);
    }
    // The unchecked .js consumer exists ON DISK but is NOT a rootName and
    // is NOT matched by desktop's main/**/*.ts include (allowJs false) —
    // the compiler never sees it.
    const uncheckedJs = [
      "import { extractPackZip } from './bridge.js';",
      'export const jsConsumer = extractPackZip(new Uint8Array(), "p.zip", undefined, { childPath: "js-production-child.js" });',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'unchecked.js'), uncheckedJs);
    const program = ts.createProgram(rootNames, {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ['node'],
      typeRoots: [path.resolve(THIS_DIR, '../../../node_modules/@types')],
      noEmit: true,
      skipLibCheck: true,
    });
    const arityErrorsOf = (name: string): string[] => {
      const sf = program.getSourceFile(path.join(dir, name));
      expect(sf, `${name} must be in the program`).toBeDefined();
      return (program.getSemanticDiagnostics(sf as ts.SourceFile) ?? [])
        .filter((d) => d.code === 2554)
        .map((d) => (typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText));
    };
    for (const name of ['direct.ts', 'alias.ts', 'namespace.ts']) {
      const errors = arityErrorsOf(name);
      expect(errors, `${name}: the TYPED four-argument call is a TS2554 compile error under the 3-parameter signature (the gate's scope)`).toEqual([
        'Expected 2-3 arguments, but got 4.',
      ]);
    }
    for (const name of ['bound-loader.ts', 'any-alias.ts', 'reflect.ts']) {
      expect(arityErrorsOf(name), `${name}: NO TS2554 — the honest boundary of the typed-call gate (any-typed loader / erased type / no tuple arity); runtime safety is the options-free surface, not this gate`).toEqual([]);
    }
    expect(arityErrorsOf('control.ts'), 'the conformant two/three-argument control compiles clean').toEqual([]);
    expect(fs.existsSync(path.join(dir, 'unchecked.js')), 'the unchecked .js consumer exists on disk').toBe(true);
    expect(
      program.getSourceFile(path.join(dir, 'unchecked.js')),
      'the standalone .js consumer is ABSENT from the program (include main/**/*.ts, allowJs false) — tsc does not check every extension C1 scans; the round-21 critic executed this exact file shape and observed the four-argument call',
    ).toBeUndefined();
  });

  // ---- R24-1/R25-1 DEMONSTRATION (executed): the structural point — the
  // runtime INERTNESS of extra arguments to the options-free 3-parameter
  // export — now pinned to the ACTUAL planned wrapper bodies, not a
  // hardcoded lookalike (the round-22 finding: the R24 leg "hardcodes the
  // conformant local wrapper ... and tests only that fixture"). The
  // SIMULATED PLANNED HEAD RUNNER is derived from this spec's own pinned
  // synthetic runner source (CONFORMANT_R24_RUNNER — the same wrapper
  // bodies the trace mirror's simulated head carries): both exported
  // wrappers are transpiled and executed VERBATIM in a real node child
  // process; only the UNEXPORTED core's body is instrumented (a single
  // anchored splice of our own text) to record every resolution
  // (timeoutMs/childPath), the launcher payload it builds (the four
  // positional child argv roles) and the RAW opts it received. The poison
  // drill: the delivery spellings that escape the typed-call gate (an
  // any-typed alias and Reflect.apply — the round-21 honest boundary, and
  // the exact routes the round-22 critic drove) hand the production
  // export a POISON fourth argument (a marker object carrying
  // timeoutMs/childPath/marker); every recorded resolution must be the
  // DEFAULTS with the poison NOWHERE in the resolution or the child argv,
  // and the core must have received the literal {} — while the SAME poison
  // through extractPackZipWithOptions DOES deliver. At HEAD the identical
  // drill runs against the REAL exported runner: the static import at the
  // top of this file is the real binding once pack-worker.ts exists (at
  // base this whole file is RED on that missing import — the acceptance
  // evidence — and the base-executed twin of this leg is the trace
  // mirror's R25 block, repro/scan-selfcheck-v2-r25.out, which spawns the
  // same simulated planned-head shape in real node processes).
  it('R24-1/R25-1 demonstration: a POISON fourth argument to the 3-parameter options-free export is INERT — the executed wrappers are the pinned synthetic runner bodies themselves (the any-typed-alias and Reflect.apply poison deliveries all resolve the DEFAULT timeout/childPath and the four-role child argv with the marker NOWHERE, the core receiving the literal {}; only the 4-parameter extractPackZipWithOptions delivers the same poison), and at head the real exported runner passes the identical drill through the recorded launch seam', async () => {
    // Premise: the pinned synthetic runner really satisfies the amended
    // pin — signature AND body — so the executed wrappers ARE the shapes
    // the walker admits (and nothing looser).
    expect(runnerSignatureFindingsOf(RUNNER_REL, CONFORMANT_R24_RUNNER), 'the pinned synthetic runner is conformant under the R25-1 signature-AND-body pin').toEqual([]);
    const POISON_MARKER = 'R25-POISON-4b71';
    const DEFAULTS = { timeoutMs: 120_000, childPath: 'default-pack-extract-child.js' };
    const dir = makeTempDir();
    // The instrumented core: the UNEXPORTED core's body is the ONLY splice
    // (the anchor is unique by construction — the core is the only
    // declaration whose body is `return filename;`); the two EXPORTED
    // wrapper declarations stay verbatim. They are the shapes under test.
    const instrumented = CONFORMANT_R24_RUNNER.replace(
      '): Promise<string> {\n  return filename;\n}',
      [
        '): Promise<string> {',
        '  const resolved = { timeoutMs: opts.timeoutMs ?? DEFAULT_PACK_TIMEOUT_MS, childPath: opts.childPath ?? DEFAULT_CHILD };',
        '  const childArgv = [`${filename}.work/input.zip`, `${filename}.work/out`, filename, JSON.stringify(limits)];',
        '  resolutions.push({ resolved, childArgv, receivedOpts: opts });',
        '  return filename;',
        '}',
      ].join('\n'),
    );
    expect(instrumented, 'the core instrumentation splice really applied').not.toBe(CONFORMANT_R24_RUNNER);
    // Test scaffolding the scanned (never executed) synthetic source
    // deliberately omits: the limits resolver the WithOptions wrapper
    // names, and the recorded-resolution module state.
    const scaffold = [
      'export const DEFAULT_PACK_TIMEOUT_MS = 120_000;',
      "const DEFAULT_CHILD = 'default-pack-extract-child.js';",
      'export const resolutions: unknown[] = [];',
      'function resolvePackLimits(env: NodeJS.ProcessEnv, limits?: Partial<PackSecurityLimits>): PackSecurityLimits {',
      '  void env;',
      '  return {',
      '    maxUncompressedBytes: limits?.maxUncompressedBytes ?? 2147483648,',
      '    maxEntries: limits?.maxEntries ?? 5000,',
      '    maxCompressionRatio: limits?.maxCompressionRatio ?? 100,',
      '  };',
      '}',
      '',
    ].join('\n');
    const moduleJs = ts.transpileModule(scaffold + instrumented, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    fs.writeFileSync(path.join(dir, 'simulated-planned-head-runner.mjs'), moduleJs);
    const consumer = [
      "import { extractPackZipOutOfProcess, extractPackZipWithOptions, resolutions } from './simulated-planned-head-runner.mjs';",
      `const POISON = { timeoutMs: 50, childPath: "poison-child.js", marker: "${POISON_MARKER}" };`,
      'const limits = { maxUncompressedBytes: 1, maxEntries: 1, maxCompressionRatio: 1 };',
      '// the delivery spellings that escape the typed-call gate (round 21),',
      '// driven exactly as the round-22 critic drove them:',
      'const anyAlias = extractPackZipOutOfProcess;',
      'await anyAlias(new Uint8Array([1]), "poison-any.zip", limits, POISON);',
      'await Reflect.apply(extractPackZipOutOfProcess, undefined, [new Uint8Array([2]), "poison-reflect.zip", limits, POISON]);',
      '// the control: the ONLY surface that can deliver.',
      'await extractPackZipWithOptions(new Uint8Array([3]), "poison-control.zip", limits, POISON);',
      'console.log("R25_INERTNESS=" + JSON.stringify(resolutions));',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'consumer.mjs'), consumer);
    const run = spawnSync(process.execPath, [path.join(dir, 'consumer.mjs')], { encoding: 'utf8' });
    expect(run.status, `the simulated planned head runs in a real node child${run.stderr.trim() ? `: ${run.stderr.trim()}` : ''}`).toBe(0);
    const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('R25_INERTNESS='));
    expect(line, 'the consumer printed the recorded resolutions').toBeDefined();
    const recorded = JSON.parse((line ?? '').slice('R25_INERTNESS='.length)) as Array<{
      resolved: { timeoutMs: number; childPath: string };
      childArgv: string[];
      receivedOpts: unknown;
    }>;
    expect(recorded, 'exactly three resolutions: two poison deliveries + the control').toHaveLength(3);
    for (const r of recorded.slice(0, 2)) {
      expect(r.resolved, 'a poison delivery resolves the DEFAULT timeout/childPath — the fourth argument is inert').toEqual(DEFAULTS);
      expect(r.receivedOpts, 'the core received the literal {} the wrapper passed — never the poison').toEqual({});
      expect(r.childArgv, 'the child argv is the four positional roles — the poison never enters it').toHaveLength(4);
    }
    expect(
      JSON.stringify(recorded.slice(0, 2)),
      'the poison marker appears NOWHERE in the wrapper-driven resolutions or the child argv',
    ).not.toContain(POISON_MARKER);
    expect(recorded[2]?.resolved, 'the WithOptions control DELIVERS the same poison').toEqual({ timeoutMs: 50, childPath: 'poison-child.js' });
    expect(JSON.stringify(recorded[2]?.receivedOpts), 'the control received the poison itself').toContain(POISON_MARKER);

    // ---- the REAL-runner binding (HEAD): the identical poison drill
    // against the REAL exported runner — extractPackZipOutOfProcess and
    // extractPackZipWithOptions at the top of this file ARE the real
    // module's bindings once pack-worker.ts exists (at base the whole
    // spec is RED on that missing import). The recorded launch seam
    // observes what the real core resolved: the DEFAULT child path
    // (never the poison's), the four positional argv roles, and the
    // poison NOWHERE in the launch; the WithOptions control with the
    // same poison childPath DOES launch it — the test surface works.
    expect(fs.existsSync(RUNNER_SOURCE), 'at head the runner module exists and this leg binds the REAL exported runner').toBe(true);
    const launches: Array<{ modulePath: string; args: string[] }> = [];
    const fakeChildren: FakeChild[] = [];
    setPackWorkerForkFn((modulePath: string, args: string[]) => {
      launches.push({ modulePath, args });
      const child = makeFakeChild();
      fakeChildren.push(child);
      return child;
    });
    const deliver = (): void => {
      const child = fakeChildren[launches.length - 1];
      const args = launches[launches.length - 1]?.args;
      if (child === undefined || args === undefined || (child.listeners.message ?? []).length === 0) return;
      // A fake successful child: reports exactly the parent-passed out dir.
      trackWorkspace(args);
      child.emit('message', { ok: true, dir: args[1] });
      child.emit('exit', 0);
    };
    const timer = setInterval(deliver, 10);
    try {
      const realLimits = { maxUncompressedBytes: 2147483648, maxEntries: 5000, maxCompressionRatio: 100 };
      const realAny = extractPackZipOutOfProcess as (
        zipBytes: Uint8Array,
        filename: string,
        limits: unknown,
        ...rest: unknown[]
      ) => Promise<string>;
      await within(
        realAny(new Uint8Array([1, 2, 3, 4]), 'real-poison.zip', realLimits, {
          timeoutMs: 50,
          childPath: 'poison-child.js',
          marker: POISON_MARKER,
        }),
        15_000,
      );
      expect(launches, 'the real export launched exactly one child').toHaveLength(1);
      expect(launches[0]?.modulePath, 'the real core resolved the DEFAULT child path — never the poison childPath').toBe(packWorkerChildPath());
      expect(launches[0]?.modulePath).not.toBe('poison-child.js');
      expect(launches[0]?.args, 'the real child argv is the four positional roles').toHaveLength(4);
      expect(launches[0]?.args[2]).toBe('real-poison.zip');
      expect(JSON.stringify(launches), 'the poison marker appears NOWHERE in the real launch (argv or module path)').not.toContain(POISON_MARKER);
      // The control on the REAL runner: the same poison childPath through
      // extractPackZipWithOptions DOES reach the launch — delivery works,
      // and only through the four-parameter options variant.
      await within(
        extractPackZipWithOptions(new Uint8Array([1, 2, 3, 4]), 'real-control.zip', realLimits, {
          childPath: 'poison-child.js',
          timeoutMs: 120_000,
        }),
        15_000,
      );
      expect(launches, 'the control launched exactly one more child').toHaveLength(2);
      expect(launches[1]?.modulePath, 'the WithOptions control DELIVERS the poison childPath on the real runner').toBe('poison-child.js');
    } finally {
      clearInterval(timer);
      setPackWorkerForkFn(null);
    }
  });
});

// ==================================================================== //
// P2 — the child's import graph cannot reach the store (R17-1: the      //
// C1-equivalent AST load inventory + actual local resolution, replacing //
// the round-15 regex collector the critic executed three escapes past)  //
// ==================================================================== //
describe('#320 AC3 P2: the pack child import graph excludes pack-manager/sqlite-store/better-sqlite3/sqlite-vec', () => {
  // ---- the AST load-site inventory (C1's amendment-(h) logic, copied; C1
  // exports nothing, and C3 must stay self-contained). Every RUNTIME
  // module-load route is inventoried with the specifier module resolution
  // actually sees (the AST's COOKED string value): static import (incl.
  // side-effect), export-from, import=require, dynamic import() — INCLUDING
  // one whose specifier sits on its own line behind an inline comment —
  // require(), member.require(), module['require'], module[computed], a
  // createRequire(...) result called directly, and any identifier bound in
  // the same file to a require function (a createRequire result or an alias
  // of require / module.require, closed transitively). Escaped and
  // String.raw specifiers decode to the cooked/raw text. Type-only imports
  // are elided and do not count; a side-effect import and `import {} from`
  // COUNT (fail closed).
  /** Specifier sentinel for a load site whose module specifier is not a static string. */
  const COMPUTED = '<COMPUTED>';

  interface LoadSite {
    file: string;
    form: string;
    specifier: string;
    fragment: string;
  }

  // scriptKindFor is MODULE-SCOPE (P1a's AST pass uses it too, before this
  // describe block); it is C1's amendment-(h) helper verbatim.

  function unwrapExpression(node: ts.Expression): ts.Expression {
    let e = node;
    for (;;) {
      if (
        ts.isParenthesizedExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isSatisfiesExpression(e) ||
        ts.isNonNullExpression(e) ||
        ts.isTypeAssertionExpression(e)
      ) {
        e = e.expression;
      } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        e = e.right;
      } else {
        return e;
      }
    }
  }

  function staticSpecifier(arg: ts.Expression | undefined, sf: ts.SourceFile): string {
    if (arg === undefined) return COMPUTED;
    const e = unwrapExpression(arg);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (
      ts.isTaggedTemplateExpression(e) &&
      ts.isNoSubstitutionTemplateLiteral(e.template) &&
      ts.isPropertyAccessExpression(e.tag) &&
      ts.isIdentifier(e.tag.expression) &&
      e.tag.expression.text === 'String' &&
      e.tag.name.text === 'raw'
    ) {
      return e.template.getText(sf).slice(1, -1);
    }
    return COMPUTED;
  }

  function importIsTypeOnly(decl: ts.ImportDeclaration): boolean {
    const clause = decl.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name !== undefined) return false;
    const named = clause.namedBindings;
    return named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
  }

  function exportIsTypeOnly(decl: ts.ExportDeclaration): boolean {
    if (decl.isTypeOnly) return true;
    const clause = decl.exportClause;
    return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
  }

  function loadSitesInSource(source: string, fileName: string): LoadSite[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
    const sites: LoadSite[] = [];

    const requireFns = new Set<string>(['require']);
    const createRequireFns = new Set<string>(['createRequire']);
    const isCreateRequireCall = (node: ts.Expression): boolean => {
      const e = unwrapExpression(node);
      if (!ts.isCallExpression(e)) return false;
      const callee = unwrapExpression(e.expression);
      return (
        (ts.isIdentifier(callee) && createRequireFns.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire')
      );
    };
    const bindings: Array<{ local: string; key?: string; init?: ts.Expression }> = [];
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        bindings.push({ local: node.name.text, init: node.initializer });
      } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) bindings.push({ local: node.name.text, key: key.text });
      } else if (ts.isImportSpecifier(node)) {
        bindings.push({ local: node.name.text, key: (node.propertyName ?? node.name).text });
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
    for (let grew = true; grew; ) {
      grew = false;
      for (const { local, key, init } of bindings) {
        let target: Set<string> | null = null;
        if (key === 'require') target = requireFns;
        else if (key === 'createRequire') target = createRequireFns;
        else if (init !== undefined) {
          const e = unwrapExpression(init);
          if (isCreateRequireCall(e)) target = requireFns;
          else if (ts.isIdentifier(e) && requireFns.has(e.text)) target = requireFns;
          else if (ts.isIdentifier(e) && createRequireFns.has(e.text)) target = createRequireFns;
          else if (ts.isPropertyAccessExpression(e) && e.name.text === 'require') target = requireFns;
          else if (ts.isPropertyAccessExpression(e) && e.name.text === 'createRequire') target = createRequireFns;
        }
        if (target !== null && !target.has(local)) {
          target.add(local);
          grew = true;
        }
      }
    }

    const loadCallForm = (calleeNode: ts.Expression): string | null => {
      if (calleeNode.kind === ts.SyntaxKind.ImportKeyword) return 'import()';
      const callee = unwrapExpression(calleeNode);
      if (ts.isIdentifier(callee)) {
        if (!requireFns.has(callee.text)) return null;
        return callee.text === 'require' ? 'require()' : 'alias()';
      }
      if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'require' ? 'member.require()' : null;
      if (ts.isElementAccessExpression(callee)) {
        const key = staticSpecifier(callee.argumentExpression, sf);
        if (key === 'require') return 'member[require]()';
        const receiver = unwrapExpression(callee.expression);
        if (key === COMPUTED && ts.isIdentifier(receiver) && receiver.text === 'module') return 'module[computed]()';
        return null;
      }
      if (isCreateRequireCall(callee)) return 'createRequire()()';
      return null;
    };
    const add = (node: ts.Node, form: string, specifier: string): void => {
      const fragment = node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80);
      sites.push({ file: fileName, form, specifier, fragment });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        if (!importIsTypeOnly(node)) add(node, 'import', staticSpecifier(node.moduleSpecifier, sf));
      } else if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier !== undefined && !exportIsTypeOnly(node)) {
          add(node, 'export-from', staticSpecifier(node.moduleSpecifier, sf));
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
          add(node, 'import=require', staticSpecifier(node.moduleReference.expression, sf));
        }
      } else if (ts.isCallExpression(node)) {
        const form = loadCallForm(node.expression);
        if (form !== null) add(node, form, staticSpecifier(node.arguments[0], sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return sites;
  }

  /** Resolve a relative specifier against its importer the way the compiled +
   *  source layouts do: the exact path, its .js->.ts twin, its .ts->(same),
   *  extensionless source extensions, then directory index files. */
  function resolveRelative(importer: string, spec: string): string | null {
    const base = path.dirname(importer);
    const candidates = [spec];
    if (/\.js$/i.test(spec)) candidates.push(spec.replace(/\.js$/i, '.ts'));
    if (path.extname(spec) === '') for (const ext of SOURCE_EXTENSIONS) candidates.push(spec + ext);
    for (const candidate of candidates) {
      const full = path.resolve(base, candidate);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    }
    // directory index
    for (const candidate of candidates) {
      const dir = path.resolve(base, candidate);
      try {
        if (fs.statSync(dir).isDirectory()) {
          for (const index of ['index.ts', 'index.js', 'index.mjs', 'index.cjs']) {
            const idx = path.join(dir, index);
            if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
          }
        }
      } catch {
        /* not a directory */
      }
    }
    return null;
  }

  // ---- C1's COMPLETE built-in classification, EXACTLY MIRRORED (R18-4). The
  // round-16 critic executed a same-PID `node:vm` escape because the
  // Revision-17 deny regex tested the RAW specifier ('node:vm' does not match
  // /^(module|vm|...)$/ — repro/critic-round16-probes.out:4: findings:[],
  // vmPid === parentPid). C1 does not export its table, so C3 mirrors it:
  // the 11 IN-PROCESS-EXEC built-ins are findings EVEN WHEN node:-PREFIXED;
  // child_process/cluster are OUT-OF-PROCESS (code runs in another OS
  // process — allowed, #320's own property); every other built-in is INERT
  // (allowed). node:test/reporters is INERT (C1's header note (t)
  // disagreement with the plan); the node:-only keys (node:test,
  // node:sqlite) never load unprefixed ('test'/'sqlite' are userland names —
  // module.isBuiltin verified false), so only their prefixed spellings are
  // classified here.
  const PACK_IN_PROCESS_EXEC_BUILTINS = new Set([
    'vm',
    'worker_threads',
    'module',
    'inspector',
    'inspector/promises',
    'repl',
    'wasi',
    'v8',
    'node:test',
    'node:sqlite',
    'process',
  ]);
  const PACK_OUT_OF_PROCESS_BUILTINS = new Set(['child_process', 'cluster']);
  const KNOWN_BUILTINS = new Set(builtinModules);
  /** C1's canonicalBuiltinId, mirrored: an exact known key; a node:-prefixed
   *  spelling of an UNPREFIXED known key normalises to it ('node:vm' ->
   *  'vm', 'node:inspector/promises' -> 'inspector/promises'); anything else
   *  is not a built-in. Case-sensitive, like Node. */
  function canonicalPackBuiltinId(spec: string): string | null {
    if (KNOWN_BUILTINS.has(spec)) return spec;
    if (spec.startsWith('node:')) {
      const stripped = spec.slice('node:'.length);
      if (KNOWN_BUILTINS.has(stripped)) return stripped;
    }
    return null;
  }

  /** The walk result: findings over a tree (file-rel -> source). */
  function graphFindingsOfTree(tree: ReadonlyMap<string, string>): string[] {
    const findings: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ rel: string; source: string }> = [
      { rel: CHILD_RELATIVE, source: tree.get(CHILD_RELATIVE) as string },
    ];
    if (tree.get(CHILD_RELATIVE) === undefined) return [`missing child module ${CHILD_RELATIVE}`];
    while (queue.length > 0) {
      const item = queue.shift() as { rel: string; source: string };
      if (seen.has(item.rel)) continue;
      seen.add(item.rel);
      if (!ALLOWED_LOCAL_CLOSURE.has(item.rel)) {
        findings.push(`local module outside the allowed closure: ${item.rel}`);
      }
      for (const site of loadSitesInSource(item.source, item.rel)) {
        if (site.specifier === COMPUTED) {
          findings.push(`${item.rel} [${site.form}] COMPUTED specifier: ${site.fragment}`);
          continue;
        }
        const spec = site.specifier.replace(/\\/g, '/');
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const resolved = resolveRelative(path.join(MAIN_DIR, item.rel), site.specifier);
          if (resolved === null) {
            findings.push(`${item.rel} [${site.form}] unresolved relative specifier ${site.specifier}`);
            continue;
          }
          if (!resolved.startsWith(MAIN_DIR + path.sep)) {
            findings.push(`${item.rel} [${site.form}] ${site.specifier} leaves desktop/main -> ${resolved}`);
            continue;
          }
          const rel = relToMain(resolved);
          if (/^backend\/store\//.test(rel) || /pack-manager|sqlite-store|sqlite-vec/.test(rel)) {
            findings.push(`${item.rel} [${site.form}] reaches the store: ${site.specifier} -> ${rel}`);
          }
          if (!seen.has(rel)) queue.push({ rel, source: tree.get(rel) ?? fs.readFileSync(resolved, 'utf8') });
        } else if (canonicalPackBuiltinId(spec) !== null) {
          // C1's classification, mirrored (R18-4): IN-PROCESS-EXEC built-ins
          // are findings EVEN under their node:-prefixed spelling; the
          // OUT-OF-PROCESS pair (child_process/cluster) and every inert
          // built-in stay allowed.
          const canon = canonicalPackBuiltinId(spec) as string;
          if (PACK_IN_PROCESS_EXEC_BUILTINS.has(canon)) {
            findings.push(`${item.rel} [${site.form}] loads the in-process-exec built-in ${canon} (spelled '${spec}')`);
          }
        } else if (ALLOWED_BARE.has(spec)) {
          // jszip: the sanctioned parser, only inside the child
        } else {
          findings.push(`${item.rel} [${site.form}] forbidden bare package ${spec} (${site.fragment})`);
        }
      }
    }
    if (!seen.has(RULES_RELATIVE)) {
      findings.push(`the child must import the shared pack-archive-rules module (closure: ${[...seen].sort().join(', ')})`);
    }
    return findings;
  }

  it('the transitive LOCAL closure is exactly {pack-extract-child.ts, pack-archive-rules.ts}; no store edge; only jszip + classified built-ins', () => {
    expect(fs.existsSync(CHILD_SOURCE), 'the pack child module must exist').toBe(true);
    const tree = new Map<string, string>();
    tree.set(CHILD_RELATIVE, fs.readFileSync(CHILD_SOURCE, 'utf8'));
    const findings = graphFindingsOfTree(tree);
    // The full finding list is empty (fail closed on EVERY route).
    expect(findings, 'the pack child import graph is confined').toEqual([]);
  });

  // ---- FROZEN REGRESSIONS (R17-1): each shape below is the exact escape the
  // round-15 critic EXECUTED past the old regex P2; each must make a
  // synthetic planned head RED under the walk above.
  const MALICIOUS_HEAD_VERBATIM = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { enforceDeclaredLimits, parseCentralDirectory } from './pack-archive-rules.ts';",
    "export const PACK_WORKER_ERROR_PREFIX = 'pack worker: ';",
    'async function readEntries(zipPath: string): Promise<string[]> {',
    "  const JSZip = (await import('jszip')).default;",
    '  const loaded = await JSZip.loadAsync(fs.readFileSync(zipPath));',
    '  return Object.keys(loaded.files);',
    '}',
    'export async function runPackChildMain(argv: string[], channel?: { postMessage(m: unknown): void }): Promise<number> {',
    "  const { PackManagerError } = await import( // P2 does not collect this form",
    "    '../store/pack-manager.js');",
    '  const zipPath = argv[0] as string;',
    '  const filename = argv[2] as string;',
    "  const fail = (message: string): Error => new PackManagerError(message);",
    '  const declared = parseCentralDirectory(fs.readFileSync(zipPath), filename, fail).entries;',
    '  enforceDeclaredLimits(declared, { maxUncompressedBytes: 1 << 31, maxEntries: declared.length, maxCompressionRatio: 100 }, filename, fail);',
    '  const entries = await readEntries(zipPath);',
    '  const outDir = argv[1] as string;',
    '  channel?.postMessage({ ok: true, dir: outDir, entries: entries.length });',
    '  return 0;',
    '}',
  ].join('\n');

  interface RegressionRow {
    id: string;
    /** The malicious child body under test. */
    source: string;
    /** Every finding fragment the walk MUST produce (substring match). */
    mustMention: string[];
  }

  const REGRESSIONS: RegressionRow[] = [
    {
      // The critic's round-15 malicious head VERBATIM (the inline-comment
      // dynamic import of pack-manager that passed all 1185 C1 checks).
      id: 'round-15-malicious-head-verbatim (inline-comment dynamic import of pack-manager)',
      source: MALICIOUS_HEAD_VERBATIM,
      mustMention: ['reaches the store', 'pack-manager'],
    },
    {
      id: 'createRequire alias',
      source: [
        "import fs from 'node:fs';",
        "import { createRequire } from 'node:module';",
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        'const load = createRequire(import.meta.url);',
        "const { PackManagerError } = load('../store/pack-manager.js');",
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: ['alias()', 'reaches the store'],
    },
    {
      id: 'module.require',
      source: [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        "const { PackManagerError } = module.require('../store/pack-manager.js');",
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: ['member.require()', 'reaches the store'],
    },
    {
      id: 're-export of pack-manager',
      source: [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        "export { PackManagerError } from '../store/pack-manager.js';",
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: ['export-from', 'reaches the store'],
    },
    {
      id: 'escaped specifier (hex-coded ../store escape)',
      source: [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        "const { PackManagerError } = require('.\\u002e\\u002fstore\\u002fpack-manager.js');",
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: ['require()', 'reaches the store'],
    },
    {
      id: 'bare native package (better-sqlite3)',
      source: [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        "const db = require('better-sqlite3');",
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: ['forbidden bare package better-sqlite3'],
    },
    {
      id: 'computed specifier',
      source: [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        "const target = String.fromCharCode(46, 46, 47) + 'store/pack-manager.js';",
        'const mod = await import(target);',
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: ['COMPUTED specifier'],
    },
    {
      // R18-4: the round-16 same-PID escape — node:-prefixed IN-PROCESS-EXEC
      // built-ins the Revision-17 deny regex let through (probes :4). The
      // exact three required forms: dynamic import('node:vm'),
      // require('node:worker_threads'), await import('node:module').
      id: 'node:-prefixed in-process-exec built-ins: import(node:vm), require(node:worker_threads), await import(node:module)',
      source: [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        "const vmMod = await import('node:vm');",
        "const wt = require('node:worker_threads');",
        "const mod = await import('node:module');",
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n'),
      mustMention: [
        'in-process-exec built-in vm',
        'in-process-exec built-in worker_threads',
        'in-process-exec built-in module',
      ],
    },
  ];

  it.each(REGRESSIONS.map((row) => [row.id, row] as const))(
    'frozen regression: %s turns the planned head RED',
    (_id, row) => {
      const tree = new Map<string, string>();
      tree.set(CHILD_RELATIVE, row.source);
      const findings = graphFindingsOfTree(tree);
      expect(findings.length, `the regression must produce findings (got none)`).toBeGreaterThan(0);
      const joined = findings.join('\n');
      for (const needle of row.mustMention) {
        expect(joined, `findings must mention ${needle}: ${joined}`).toContain(needle);
      }
    },
  );

  it('the built-in classification mirrors C1 exactly: every IN-PROCESS-EXEC built-in (bare AND node:-prefixed) is a finding; child_process/cluster (OUT-OF-PROCESS) and inert built-ins are not', () => {
    const childWithLoads = (loads: string[]): string =>
      [
        "import { parseCentralDirectory } from './pack-archive-rules.ts';",
        ...loads,
        'export async function runPackChildMain(argv: string[]): Promise<number> { return 0; }',
      ].join('\n');
    const findingsOfLoads = (loads: string[]): string => {
      const tree = new Map<string, string>();
      tree.set(CHILD_RELATIVE, childWithLoads(loads));
      return graphFindingsOfTree(tree).join('\n');
    };
    // Every IN-PROCESS-EXEC built-in, under EVERY spelling that loads it:
    // bare (canonical) and node:-prefixed for the unprefixed keys; the
    // node:-only keys (node:test, node:sqlite) have no bare spelling.
    for (const id of PACK_IN_PROCESS_EXEC_BUILTINS) {
      const spellings = id.startsWith('node:') ? [id] : [id, `node:${id}`];
      for (const spec of spellings) {
        expect(
          findingsOfLoads([`const m = require('${spec}');`]),
          `${spec} must be an in-process-exec finding (canonical ${id})`,
        ).toContain(`loads the in-process-exec built-in ${id}`);
      }
    }
    // OUT-OF-PROCESS (C1's class for these two): allowed — code runs in a
    // SEPARATE OS process, which is #320's own property, not a violation.
    for (const id of PACK_OUT_OF_PROCESS_BUILTINS) {
      for (const spec of [id, `node:${id}`]) {
        expect(findingsOfLoads([`const m = require('${spec}');`]), `${spec} is OUT-OF-PROCESS: allowed`).not.toContain('in-process-exec');
      }
    }
    // INERT controls, including C1's noted disagreement: node:test/reporters
    // is INERT (its reporters load and run nothing).
    for (const spec of ['node:fs', 'node:path', 'node:zlib', 'node:os', 'node:test/reporters']) {
      expect(findingsOfLoads([`const m = require('${spec}');`]), `${spec} is INERT: allowed`).not.toContain('in-process-exec');
    }
    // The mirror of C1's canonical rule: a node:-only key spelled bare names
    // a USERLAND package (module.isBuiltin('test') === false), so it lands in
    // the forbidden-bare branch, NOT the exec branch.
    expect(findingsOfLoads(["const t = require('test');"]), 'bare test is a userland package').toContain('forbidden bare package test');
    expect(findingsOfLoads(["const s = require('sqlite');"]), 'bare sqlite is a userland package').toContain('forbidden bare package sqlite');
  });

  it('self-test: the PLANNED head (the mirror shape) is GREEN under the same walk', () => {
    const plannedChild = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { enforceDeclaredLimits, enforceEntryNames, expandsBeyondCapMessage, missingManifestMessage, notZipMessage, parseCentralDirectory, symlinkEntryMessage, isZipFilename, checkEntryName, type FailFactory } from './pack-archive-rules.ts';",
      "export const PACK_WORKER_ERROR_PREFIX = 'pack worker: ';",
      'const fail: FailFactory = (message: string): Error => new Error(message);',
      'export async function runPackChildMain(argv: string[], channel?: { postMessage(m: unknown): void }): Promise<number> {',
      '  const [zipPath, outDir, filename, limitsJson] = argv as [string, string, string, string];',
      '  const limits = JSON.parse(limitsJson);',
      '  if (!isZipFilename(filename)) { channel?.postMessage({ ok: false, code: "not-zip", error: notZipMessage(filename) }); return 1; }',
      '  const raw = fs.readFileSync(zipPath);',
      '  const declared = parseCentralDirectory(raw, filename, fail).entries;',
      '  enforceDeclaredLimits(declared, limits, filename, fail);',
      '  enforceEntryNames(declared, filename, fail);',
      "  const JSZip = (await import('jszip')).default;",
      '  const loaded = await JSZip.loadAsync(raw);',
      '  // R18-1: the success report names EXACTLY the parent-passed out dir (argv[1]);',
      '  // any other dir is a malformed report the parent rejects (workspace removed,',
      '  // foreign tree untouched) before any adoption.',
      '  channel?.postMessage({ ok: true, dir: outDir });',
      '  return 0;',
      '}',
    ].join('\n');
    const tree = new Map<string, string>();
    tree.set(CHILD_RELATIVE, plannedChild);
    tree.set(RULES_RELATIVE, fs.readFileSync(path.join(PACKS_DIR, 'pack-archive-rules.ts'), 'utf8'));
    expect(graphFindingsOfTree(tree)).toEqual([]);
  });
});

// ==================================================================== //
// P3 — the public extractPackZip bridges through the registered seam     //
// ==================================================================== //
describe('#320 AC3 P3: public extractPackZip launches the child through the registered seam and adopts {ok:true, dir}', () => {
  it('bridges bytes -> workspace(input.zip) -> launcher(zipPath, outDir, filename, limitsJson) -> moved dir', { timeout: 180_000 }, async () => {
    const fakeChild = makeFakeChild();
    const calls: Array<{ modulePath: string; args: string[] }> = [];
    setPackWorkerForkFn((modulePath, args) => {
      calls.push({ modulePath, args });
      return fakeChild;
    });

    let stateAtLaunch: {
      workspaceExists: boolean;
      outDirExists: boolean;
      inputBytes: Buffer;
      tmpBefore: string[];
    } | undefined;
    const script = setInterval(() => {
      const call = calls[0];
      if (call === undefined || (fakeChild.listeners.message ?? []).length === 0) return;
      clearInterval(script);
      const work = trackWorkspace(call.args);
      // The parent created the workspace + out dir and wrote the bytes BEFORE
      // the launcher ran (the R17-2 ownership precondition).
      stateAtLaunch = {
        workspaceExists: work !== undefined && fs.existsSync(work),
        outDirExists: call.args[1] !== undefined && fs.existsSync(call.args[1] as string),
        inputBytes: fs.readFileSync(call.args[0] as string),
        tmpBefore: fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-install-')),
      };
      // A fake successful child: it "extracts" into the GIVEN out dir and
      // reports it; the parent must then MOVE out -> fresh pack-install- dir.
      fs.writeFileSync(path.join(call.args[1] as string, 'pack.json'), PACK_JSON_STUB);
      fakeChild.emit('message', { ok: true, dir: call.args[1] });
      fakeChild.emit('exit', 0);
    }, 10);

    const limits = { maxUncompressedBytes: BOMB_CAP_BYTES, maxEntries: ENTRY_CAP, maxCompressionRatio: BOMB_RATIO_CAP };
    let result: string;
    try {
      result = await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'bridge.zip', limits), 10_000);
    } finally {
      clearInterval(script);
    }

    // Exactly one launch, through the REGISTERED seam (never node's fork).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modulePath).toBe(packWorkerChildPath());
    // argv roles: [absZipPath, absOutDir, filename, limitsJson].
    expect(calls[0]?.args).toHaveLength(4);
    expect(path.isAbsolute(calls[0]?.args[0] ?? '')).toBe(true);
    expect(path.isAbsolute(calls[0]?.args[1] ?? '')).toBe(true);
    expect(stateAtLaunch?.workspaceExists, 'the parent-owned workspace must exist at launch').toBe(true);
    expect(stateAtLaunch?.outDirExists, 'the parent-created out dir must exist at launch').toBe(true);
    expect(Buffer.compare(stateAtLaunch?.inputBytes ?? Buffer.alloc(0), smallPackZipBytes())).toBe(0);
    expect(calls[0]?.args[2]).toBe('bridge.zip');
    const parsedLimits = JSON.parse(calls[0]?.args[3] ?? '{}') as Record<string, unknown>;
    expect(parsedLimits).toEqual({
      maxUncompressedBytes: BOMB_CAP_BYTES,
      maxEntries: ENTRY_CAP,
      maxCompressionRatio: BOMB_RATIO_CAP,
    });
    // Exactly one report was delivered and consumed.
    expect(fakeChild.delivered).toHaveLength(1);
    // The SUCCESS move contract (R18-1): the returned dir is a FRESH
    // pack-install-* dir carrying the extracted TREE (byte-identical), NOT
    // the workspace out dir and not the workspace path; the workspace is
    // gone.
    expect(typeof result).toBe('string');
    expect(path.isAbsolute(result)).toBe(true);
    const work = workspaceOfArgs(calls[0]?.args);
    expect(work, 'the workspace must be removed after the success move').toBeDefined();
    expect(fs.existsSync(work as string)).toBe(false);
    expect(result).not.toBe(calls[0]?.args[1]);
    expect(result).not.toBe(work);
    expect(path.basename(result)).toMatch(/^pack-install-/);
    expect(fs.existsSync(path.join(result, 'pack.json'))).toBe(true);
    expect(Buffer.compare(fs.readFileSync(path.join(result, 'pack.json')), PACK_JSON_STUB), 'the moved tree content is correct').toBe(0);
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-install-'));
    expect(tmpAfter.length).toBeGreaterThan((stateAtLaunch?.tmpBefore ?? []).length);
    fs.rmSync(result, { recursive: true, force: true });
  });

  it('resolution order: registered -> node fork outside Electron -> refusal inside Electron (never in-process)', { timeout: 180_000 }, async () => {
    setPackWorkerForkFn(null);
    const outside = resolvePackWorkerForkFn(false);
    expect(typeof outside).toBe('function');
    expect(resolvePackWorkerForkFn(true)).toBeNull();
    expect(DEFAULT_PACK_TIMEOUT_MS).toBe(120_000);
    // R18-6: C1's frozen planned export list requires nodeForkPackWorker —
    // the node fork the resolver returns outside Electron.
    expect(typeof nodeForkPackWorker, 'the runner must export nodeForkPackWorker (C1 inventory)').toBe('function');

    // The refusal is REACHABLE through the public entry: pretend this process
    // is Electron with no launcher registered; the runner must reject with
    // the prefix, never parse in-process.
    const versions = process.versions as { electron?: string };
    const had = Object.prototype.hasOwnProperty.call(versions, 'electron');
    const previous = versions.electron;
    versions.electron = '31.0.0-spec';
    let failure: unknown;
    try {
      await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'refuse.zip'), 5_000);
    } catch (err) {
      failure = err;
    } finally {
      if (had) versions.electron = previous;
      else delete versions.electron;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(WORKER_PREFIX);
    expect((failure as Error).message).toMatch(/refus/i);
  });
});

// ==================================================================== //
// P4 — the COMPLETE refusal round-trip through the REAL node-fork child  //
// (R17-3: every case both preserving suites pin, same assertion style)  //
// ==================================================================== //
describe('#320 AC3 P4: every c8/parity refusal round-trips through the REAL child to the same PackManagerError', () => {
  // Set-up shared by both legs below: the REAL node launcher, wrapped so the
  // spec can count launches.
  function registerRealLauncher(): { launches: () => number } {
    setPackWorkerForkFn(null);
    const realFork = resolvePackWorkerForkFn(false);
    expect(typeof realFork).toBe('function');
    let launched = 0;
    setPackWorkerForkFn((modulePath: string, args: string[]) => {
      launched += 1;
      const cp = fork(modulePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
      const onAny = (event: string, cb: (value: unknown) => void): unknown => {
        (cp as unknown as { on(e: string, l: (...a: unknown[]) => void): unknown }).on(event, cb as never);
        return cp;
      };
      return {
        on: onAny as unknown as PackWorkerChild['on'],
        kill: (): unknown => cp.kill(),
        get pid(): number | undefined {
          return cp.pid;
        },
        get stderr(): NodeJS.ReadableStream | null {
          return cp.stderr;
        },
      } satisfies PackWorkerChild;
    });
    return { launches: () => launched };
  }

  /** One refusal round-trip: rejects PackManagerError with `message`. */
  async function expectRefusal(
    zip: Buffer,
    filename: string,
    exact?: string,
    fragment?: RegExp,
    limits?: Record<string, number>,
  ): Promise<void> {
    let failure: unknown;
    try {
      await within(
        extractPackZipWithOptions(new Uint8Array(zip), filename, limits, { timeoutMs: 120_000 }),
        150_000,
      );
    } catch (err) {
      failure = err;
    }
    expect(failure, `${filename} must reject`).toBeInstanceOf(PackManagerError);
    expect((failure as Error).name).toBe('PackManagerError');
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    if (exact !== undefined) expect(message).toBe(exact);
    if (fragment !== undefined) expect(message).toMatch(fragment);
  }

  it('the parity-suite vector set, verbatim: exact messages where parity pins exact, class-only where it does not', { timeout: 180_000 }, async () => {
    const counter = registerRealLauncher();
    const MiB = 1024 * 1024;
    const packWith = (extra: RawZipEntry[], opts?: RawZipOptions): Buffer =>
      buildRawZip([{ name: 'pack.json', data: PACK_JSON_STUB, method: 0 }, ...extra], opts);

    // ---- ACCEPT controls (parity pins these ACCEPTED; migration-relevant) ----
    const accepted: Array<{ id: string; zip: Buffer; filename: string; probe: string }> = [
      { id: 'ok-small', zip: packWith([{ name: 'docs/a.json', data: Buffer.from('{"text":"x"}'), method: 0 }]), filename: 'ok-small.zip', probe: 'docs/a.json' },
      { id: 'ok-deflated', zip: packWith([{ name: 'assets/player/story.html', data: Buffer.from('<html>'.repeat(500)), method: 8 }]), filename: 'ok-deflated.zip', probe: 'assets/player/story.html' },
      { id: 'ok-dir-entry', zip: packWith([{ name: 'docs/', data: Buffer.alloc(0), method: 0 }, { name: 'docs/a.txt', data: Buffer.from('x'), method: 0 }]), filename: 'ok-dir-entry.zip', probe: 'docs/a.txt' },
      { id: 'ratio-floor-ok', zip: packWith([{ name: 'docs/zeros.bin', data: Buffer.alloc(2 * MiB), method: 8 }]), filename: 'ratio-floor-ok.zip', probe: 'docs/zeros.bin' },
      { id: 'sfx-prefix-ok', zip: buildRawZipSfx(), filename: 'sfx-prefix-ok.zip', probe: 'docs/a.txt' },
    ];
    for (const vec of accepted) {
      const dir = await within(extractPackZipWithOptions(new Uint8Array(vec.zip), vec.filename, DEFAULT_LIMITS, { timeoutMs: 120_000 }), 150_000);
      expect(fs.existsSync(path.join(dir, vec.probe)), `${vec.id} must extract ${vec.probe}`).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // ---- EXACT-message refusals (parity exact:true) ----
    await expectRefusal(packWith([{ name: '../evil.txt', data: Buffer.from('x'), method: 0 }]), 'dot-segment.zip',
      `unsafe archive entry path (dot segment): ${JSON.stringify('../evil.txt')}`);
    await expectRefusal(packWith([{ name: 'docs/../../evil.txt', data: Buffer.from('x'), method: 0 }]), 'nested-dot-segment.zip',
      `unsafe archive entry path (dot segment): ${JSON.stringify('docs/../../evil.txt')}`);
    await expectRefusal(packWith([{ name: 'docs/./a.txt', data: Buffer.from('x'), method: 0 }]), 'single-dot-segment.zip',
      `unsafe archive entry path (dot segment): ${JSON.stringify('docs/./a.txt')}`);
    await expectRefusal(packWith([{ name: '/etc/passwd', data: Buffer.from('x'), method: 0 }]), 'absolute.zip',
      `unsafe archive entry path (absolute): ${JSON.stringify('/etc/passwd')}`);
    await expectRefusal(packWith([{ name: 'E:../x', data: Buffer.from('x'), method: 0 }]), 'drive-relative.zip',
      `unsafe archive entry path (drive-relative/absolute): ${JSON.stringify('E:../x')}`);
    await expectRefusal(packWith([{ name: 'C:/x', data: Buffer.from('x'), method: 0 }]), 'drive-absolute.zip',
      `unsafe archive entry path (drive-relative/absolute): ${JSON.stringify('C:/x')}`);
    await expectRefusal(packWith([{ name: ['docs', '..', 'x'].join(BS), data: Buffer.from('x'), method: 0 }]), 'backslash.zip',
      `unsafe archive entry path (backslash): ${JSON.stringify(['docs', '..', 'x'].join(BS))}`);
    await expectRefusal(packWith([{ name: 'docs/a' + String.fromCharCode(0x01) + 'b', data: Buffer.from('x'), method: 0 }]), 'control-char.zip',
      `unsafe archive entry path (control character): ${JSON.stringify('docs/a' + String.fromCharCode(0x01) + 'b')}`);
    await expectRefusal(packWith([{ name: 'docs/a' + String.fromCharCode(0x7f) + 'b', data: Buffer.from('x'), method: 0 }]), 'del-char.zip',
      `unsafe archive entry path (control character): ${JSON.stringify('docs/a' + String.fromCharCode(0x7f) + 'b')}`);
    await expectRefusal(
      packWith([{ name: 'docs/link', data: Buffer.from('/etc/passwd'), method: 0, externalAttrs: (0o120777 << 16) >>> 0 }]),
      'symlink.zip',
      'symlink.zip: symlink archive entry docs/link is not allowed',
    );
    await expectRefusal(
      packWith([{ name: 'docs/a.txt', data: Buffer.from('1'), method: 0 }, { name: 'docs/a.txt', data: Buffer.from('2'), method: 0 }]),
      'duplicate-name.zip',
      'duplicate-name.zip: duplicate archive entry docs/a.txt is not allowed',
    );
    await expectRefusal(
      packWith(Array.from({ length: 12 }, (_unused, i) => ({ name: `docs/f${i}.txt`, data: Buffer.from('x'), method: 0 }))),
      'entry-cap.zip',
      'entry-cap.zip: archive declares 13 entries, over the 10 entry cap',
      undefined,
      { maxUncompressedBytes: 2147483648, maxEntries: 10, maxCompressionRatio: 100 },
    );
    await expectRefusal(
      packWith([{ name: 'docs/big.bin', data: Buffer.alloc(3 * MiB), method: 0 }]),
      'byte-cap.zip',
      'byte-cap.zip: archive declares 3145769 uncompressed bytes, over the 2097152 byte cap',
      undefined,
      { maxUncompressedBytes: 2 * MiB, maxEntries: 5000, maxCompressionRatio: 100 },
    );
    await expectRefusal(
      packWith([{ name: 'docs/zeros.bin', data: Buffer.alloc(20 * MiB), method: 8 }]),
      'ratio-bomb.zip',
      'ratio-bomb.zip: archive declares a 1026.6:1 compression ratio, over the 100:1 cap (possible zip bomb)',
    );
    await expectRefusal(
      packWith([], { eocdEntriesOverride: 0xffff }),
      'zip64-entry-count.zip',
      'zip64-entry-count.zip: ZIP64 markers are refused; pack archives above 4 GiB / 65535 entries are not accepted',
    );
    await expectRefusal(
      packWith([], { zip64Locator: true }),
      'zip64-locator.zip',
      'zip64-locator.zip: ZIP64 markers are refused; pack archives above 4 GiB / 65535 entries are not accepted',
    );
    await expectRefusal(
      buildRawZip([{ name: 'docs/a.md', data: Buffer.from('x'), method: 0 }]),
      'missing-manifest.zip',
      'missing-manifest.zip: no pack.json manifest at the archive root',
    );
    await expectRefusal(
      Buffer.from('plain text, not an archive', 'utf8'),
      'not-a-zip.zip',
      'not-a-zip.zip: not a readable zip archive (no end-of-central-directory record)',
    );
    await expectRefusal(packWith([]), 'pack.tar', 'pack.tar: pack install accepts .zip archives only');

    // ---- CLASS-ONLY refusals (parity exact:false: the message text comes
    // from JSZip internals and is not part of the frozen contract) ----
    await expectRefusal(
      packWith([{ name: 'docs/big.bin', data: Buffer.alloc(4 * MiB), method: 8, declaredUncompressed: 100 }]),
      'spoofed-declared-size.zip',
      undefined,
      /extraction failed|not a readable zip archive/,
      { maxUncompressedBytes: 1 * MiB, maxEntries: 5000, maxCompressionRatio: 100 },
    );
    await expectRefusal(
      packWith([{ name: 'docs/a.txt', data: Buffer.from('x'), method: 0, flags: 1 }]),
      'encrypted.zip',
      undefined,
      /not a readable zip archive/,
    );
    await expectRefusal(
      packWith([{ name: 'docs/a.txt', data: Buffer.from('x'), method: 12 }]),
      'unknown-method.zip',
      undefined,
      /not a readable zip archive/,
    );

    // ---- c8 accept controls ----
    const commentDir = await within(
      extractPackZipWithOptions(new Uint8Array(buildRawZipWithComment()), 'comment.zip', undefined, { timeoutMs: 120_000 }), 150_000);
    expect(fs.existsSync(path.join(commentDir, 'docs', 'a.txt'))).toBe(true);
    fs.rmSync(commentDir, { recursive: true, force: true });

    // Every refusal AND accept went through a REAL forked child:
    // 5 parity accepts + 19 exact refusals + 3 class-only refusals + the c8
    // comment accept = 28 real forks (the child-provenance count).
    expect(counter.launches()).toBe(accepted.length + 19 + 3 + 1);
  }, 600_000);

  it('the c8 traversal matrix + on-disk containment, both ZIP64 arms, and the c8 cap constants', { timeout: 180_000 }, async () => {
    const counter = registerRealLauncher();
    const base = [{ name: 'pack.json', data: PACK_JSON_STUB, method: 0 }];

    // The c8 bomb under the frozen 4 MiB cap / ratio 10 (c8 style: the exact
    // declared-bytes message was captured at base).
    await expectRefusal(
      buildRawZip([...base, { name: 'docs/bomb.bin', data: Buffer.alloc(BOMB_PAYLOAD_BYTES), method: 8 }]),
      'bomb.zip',
      undefined,
      /byte cap|compression ratio/,
      { maxUncompressedBytes: BOMB_CAP_BYTES, maxEntries: 5000, maxCompressionRatio: BOMB_RATIO_CAP },
    );
    // The c8 entry cap: 150 entries under 100.
    await expectRefusal(
      buildRawZip([...base, ...fillerEntries(ENTRY_CAP_ARCHIVE_ENTRIES - 1)]),
      'many.zip',
      'many.zip: archive declares 150 entries, over the 100 entry cap',
      undefined,
      { maxUncompressedBytes: 2147483648, maxEntries: ENTRY_CAP, maxCompressionRatio: 100 },
    );
    // c8 symlink spelling.
    await expectRefusal(
      buildRawZip([
        ...base,
        { name: 'docs/link.txt', data: Buffer.from('../../outside-target', 'utf8'), method: 0, externalAttrs: (0o120777 << 16) >>> 0 },
      ]),
      'symlink.zip',
      'symlink.zip: symlink archive entry docs/link.txt is not allowed',
    );
    // Both c8 ZIP64 arms (the sentinel EOCD counts and the locator splice).
    await expectRefusal(
      buildRawZip(base, { eocdEntriesOverride: 0xffff }),
      'zip64.zip',
      undefined,
      /4 GiB \/ 65535/,
    );
    const normal = buildRawZip(base);
    const spliced = Buffer.concat([normal.subarray(0, normal.length - 22), zip64LocatorRecord(), normal.subarray(normal.length - 22)]);
    await expectRefusal(spliced, 'zip64.zip', undefined, /4 GiB \/ 65535/);

    // The traversal matrix: same refusal, plus on-disk containment.
    const traversalNames = [
      'E:../i320c3-drive-rel.txt',
      'C:/i320c3-drive-abs.txt',
      '../../i320c3-dotdot.txt',
      `docs/..${BS}i320c3-backslash.txt`,
    ];
    for (const name of traversalNames) {
      cleanupEscapeCandidates([name]);
      const zip = buildRawZip([...base, { name, data: Buffer.from('x'), method: 0 }]);
      await expectRefusal(zip, 'probe.zip', undefined, /unsafe archive entry path/);
      for (const candidate of [path.resolve(name), path.resolve(path.join(...name.split('/')))]) {
        expect(fs.existsSync(candidate), `nothing may land at ${candidate}`).toBe(false);
      }
    }

    // The c8 default-cap accept control: 2500 entries at the 5000 default.
    const dir = await within(
      extractPackZipWithOptions(new Uint8Array(buildRawZip([...base, ...fillerEntries(2499)])), 'default-entries.zip', undefined, { timeoutMs: 180_000 }),
      240_000,
    );
    expect(fs.readdirSync(path.join(dir, 'docs')).length).toBe(2499);
    fs.rmSync(dir, { recursive: true, force: true });

    // 2 caps + 1 symlink + 2 zip64 + 4 traversal + 1 accept = 10 real forks.
    expect(counter.launches()).toBe(10);
  }, 600_000);

  it('the child entry itself (runPackChildMain, in-process) reports the same verdicts', { timeout: 180_000 }, async () => {
    const limitsJson = JSON.stringify(DEFAULT_LIMITS);
    const posted: unknown[] = [];
    const channel = { postMessage: (message: unknown): void => void posted.push(message) };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-extract-'));
    seenWorkspaces.push(work);
    const input = path.join(work, WORKSPACE_INPUT_BASENAME);
    fs.writeFileSync(input, fs.readFileSync(PARITY_ZIP));
    const outDir = path.join(work, WORKSPACE_OUT_BASENAME);
    fs.mkdirSync(outDir, { recursive: true });

    // Success over the committed fixture: {ok:true, dir} with pack.json inside.
    const code = await runPackChildMain([input, outDir, 'parity-pack.zip', limitsJson], channel);
    expect(code).toBe(0);
    expect(posted).toHaveLength(1);
    const report = posted[0] as { ok?: unknown; dir?: unknown };
    expect(report.ok).toBe(true);
    expect(report.dir).toBe(outDir);
    expect(fs.existsSync(path.join(outDir, 'pack.json'))).toBe(true);

    // Refusal: non-zip filename -> the frozen message, child-reported. The
    // diagnostic `code` is present but is NEVER a public contract (R17-6).
    posted.length = 0;
    const refuseCode = await runPackChildMain([input, outDir, 'pack.tar', limitsJson], channel);
    expect(refuseCode).not.toBe(0);
    const refusal = posted[0] as { ok?: unknown; code?: unknown; error?: unknown };
    expect(refusal.ok).toBe(false);
    expect(typeof refusal.code).toBe('string');
    expect(refusal.code as string).not.toBe('');
    expect(refusal.error as string).toBe('pack.tar: pack install accepts .zip archives only');

    // argv misuse: empty argv -> prefixed child failure, exit 1.
    posted.length = 0;
    const misuseCode = await runPackChildMain([], channel);
    expect(misuseCode).toBe(1);
    const misuse = posted[0] as { ok?: unknown; error?: unknown };
    expect(misuse.ok).toBe(false);
    expect(misuse.error as string).toMatch(new RegExp(`^${PACK_WORKER_ERROR_PREFIX}`));
    expect(PACK_WORKER_ERROR_PREFIX).toBe('pack worker: ');
  }, 120_000);
});

/** An SFX-prefixed valid pack (the parity suite's sfx-prefix-ok arm). */
function buildRawZipSfx(): Buffer {
  const prefix = Buffer.alloc(64).fill(1);
  const body = buildRawZip([
    { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
    { name: 'docs/a.txt', data: Buffer.from('x'), method: 8 },
  ]);
  return Buffer.concat([prefix, body]);
}

/** The c8 zip-comment accept control archive. */
function buildRawZipWithComment(): Buffer {
  const withComment = buildRawZip(
    [
      { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
      { name: 'docs/a.txt', data: Buffer.from('x'), method: 0 },
    ],
    {},
  );
  // Append a trailing EOCD comment by rewriting the comment-length field.
  const comment = Buffer.from('trailing archive comment that embeds no structures', 'utf8');
  const out = Buffer.concat([withComment, comment]);
  out.writeUInt16LE(comment.length, out.length - comment.length - 2);
  return out;
}

// ==================================================================== //
// P5 — real-child extraction equals the base-captured golden tree        //
// ==================================================================== //
describe('#320 AC3 P5: the committed fixture extracted by the real child is byte-identical to the base golden', () => {
  it('extracts parity-pack.zip to the golden file tree (relative paths + sha256)', { timeout: 180_000 }, async () => {
    // Provenance: the committed bytes ARE the captured bytes.
    const fixtureBytes = fs.readFileSync(PARITY_ZIP);
    expect(sha256(fixtureBytes)).toBe(FIXTURE_ZIP_SHA256);
    const goldenBytes = fs.readFileSync(PARITY_GOLDEN);
    expect(sha256(goldenBytes)).toBe(GOLDEN_SHA256);
    const golden = JSON.parse(goldenBytes.toString('utf8')) as {
      fixtureZipSha256: string;
      filename: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(golden.fixtureZipSha256).toBe(FIXTURE_ZIP_SHA256);
    expect(golden.files.length).toBeGreaterThanOrEqual(5);

    setPackWorkerForkFn(null);
    const outDir = await within(
      extractPackZipWithOptions(new Uint8Array(fixtureBytes), golden.filename, DEFAULT_LIMITS, { timeoutMs: 120_000 }),
      180_000,
    );
    try {
      expect(typeof outDir).toBe('string');
      expect(path.isAbsolute(outDir)).toBe(true);
      expect(treeManifest(outDir)).toEqual(golden.files);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 240_000);
});

// ==================================================================== //
// P5b — the REAL process boundary (R17-4): pid evidence + forced source  //
// ==================================================================== //
describe('#320 AC3 P5b: a successful extraction runs in a REAL child OS process (pid != parent), including the .ts source child', () => {
  it('compiled child: the launcher-reported pid differs from this process; the workspace is consumed by the move', { timeout: 180_000 }, async () => {
    setPackWorkerForkFn(null);
    const realFork = resolvePackWorkerForkFn(false);
    expect(typeof realFork).toBe('function');
    let observedPid: number | undefined;
    let observedArgs: string[] | undefined;
    setPackWorkerForkFn((modulePath: string, args: string[]) => {
      const child = realFork(modulePath, args);
      observedArgs = args;
      observedPid = child.pid;
      return child;
    });

    const outDir = await within(
      extractPackZipWithOptions(new Uint8Array(fs.readFileSync(PARITY_ZIP)), 'parity-pack.zip', DEFAULT_LIMITS, { timeoutMs: 120_000 }),
      180_000,
    );
    expect(fs.existsSync(path.join(outDir, 'pack.json'))).toBe(true);
    // THE process-boundary assertion: a semantically wrong in-process runner
    // cannot produce a different OS pid.
    expect(typeof observedPid).toBe('number');
    expect(observedPid).not.toBe(process.pid);
    // The workspace of THAT call is gone (success path cleanup).
    const work = trackWorkspace(observedArgs);
    expect(work).toBeDefined();
    expect(fs.existsSync(work as string)).toBe(false);
    fs.rmSync(outDir, { recursive: true, force: true });
  }, 240_000);

  it('FORCED SOURCE child (childPath = the .ts source): extracts the parity fixture to the golden through the .ts spawn fallback', { timeout: 180_000 }, async () => {
    // The round-15 critic proved a './x.js'-spelling source child FAILS to
    // load (TS-FALLBACK probe). The R17-4 shared-rules shape ('./pack-
    // archive-rules.ts' + allowImportingTsExtensions +
    // rewriteRelativeImportExtensions) was verified by the check author to
    // load under Node 24 type stripping AND to compile to './x.js' in dist.
    // This leg forces the SOURCE child through the REAL public entry so a
    // broken fallback cannot be masked by a stale compiled dist.
    expect(fs.existsSync(CHILD_SOURCE), 'the pack child source must exist').toBe(true);
    const fixtureBytes = fs.readFileSync(PARITY_ZIP);
    const golden = JSON.parse(fs.readFileSync(PARITY_GOLDEN, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    setPackWorkerForkFn(null);
    let observedPid: number | undefined;
    const realFork = resolvePackWorkerForkFn(false);
    setPackWorkerForkFn((modulePath: string, args: string[]) => {
      const child = realFork(modulePath, args);
      observedPid = child.pid;
      return child;
    });
    expect(packWorkerChildPath().toLowerCase().endsWith('.ts') || fs.existsSync(CHILD_SOURCE)).toBe(true);
    const outDir = await within(
      extractPackZipWithOptions(new Uint8Array(fixtureBytes), 'parity-pack.zip', DEFAULT_LIMITS, {
        timeoutMs: 120_000,
        childPath: CHILD_SOURCE,
      }),
      180_000,
    );
    try {
      expect(treeManifest(outDir)).toEqual(golden.files);
      expect(typeof observedPid).toBe('number');
      expect(observedPid).not.toBe(process.pid);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 240_000);

  it('the shared-rules import shape is pinned: the child imports the sibling with the explicit .ts extension, never .js', { timeout: 180_000 }, () => {
    const child = fs.readFileSync(CHILD_SOURCE, 'utf8');
    // The frozen shape (R17-4): ONE specifier spelling that loads in BOTH
    // the source tree (node .ts spawn fallback) and the compiled dist
    // (rewriteRelativeImportExtensions emits .js).
    expect(child).toContain("from './pack-archive-rules.ts'");
    expect(child).not.toContain("from './pack-archive-rules.js'");
    // The enabling compiler options are present in the desktop tsconfig.
    const tsconfig = JSON.parse(
      fs.readFileSync(path.resolve(THIS_DIR, '../../../desktop/tsconfig.json'), 'utf8').replace(/\/\/[^\n]*/g, '') //
        .replace(/\/\*[\s\S]*?\*\//g, '') as unknown as string,
    ) as { compilerOptions?: Record<string, unknown> };
    expect(tsconfig.compilerOptions?.['allowImportingTsExtensions']).toBe(true);
    expect(tsconfig.compilerOptions?.['rewriteRelativeImportExtensions']).toBe(true);
  });
});

// ==================================================================== //
// P6 — crash containment                                                //
// ==================================================================== //
describe('#320 AC3 P6: a crashed child is contained; the next extraction works', () => {
  it('exit 2 with no report rejects in isolation, and the parent serves the next extraction', async () => {
    const dir = makeTempDir();
    const crashChild = writeCrashChild(dir);

    let failure: unknown;
    try {
      await within(
        extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'crash.zip', undefined, { childPath: crashChild, timeoutMs: 15_000 }),
        20_000,
      );
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(WORKER_PREFIX);
    expect(message).toMatch(/exit/i);
    expect(message).toMatch(/\b2\b/);

    // The parent survived the child crash: the REAL child extracts the
    // committed fixture next, through the same seam.
    setPackWorkerForkFn(null);
    const outDir = await within(
      extractPackZipWithOptions(new Uint8Array(fs.readFileSync(PARITY_ZIP)), 'parity-pack.zip', DEFAULT_LIMITS, { timeoutMs: 120_000 }),
      180_000,
    );
    expect(fs.existsSync(path.join(outDir, 'pack.json'))).toBe(true);
    fs.rmSync(outDir, { recursive: true, force: true });
  }, 240_000);
});

// ==================================================================== //
// P7 — deadline + kill escalation                                       //
// ==================================================================== //
describe('#320 AC3 P7: a hung child is killed at the deadline, then escalated after the 2 s grace', () => {
  it('fake hung child: rejection names the timeout; kill #1 at the deadline, exactly one more after >= 1.9 s', { timeout: 180_000 }, async () => {
    const fakeChild = makeFakeChild(); // never reports, never exits, ignores kill
    const killTimes: number[] = [];
    const baseKill = fakeChild.kill.bind(fakeChild);
    fakeChild.kill = (): boolean => {
      killTimes.push(Date.now());
      return baseKill();
    };
    setPackWorkerForkFn(() => fakeChild);

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'hung.zip', undefined, { timeoutMs: 200 }), 10_000);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(WORKER_PREFIX);
    expect((failure as Error).message).toMatch(/timed out/i);
    expect(fakeChild.killCalls, 'exactly one kill at the deadline').toBe(1);
    expect((killTimes[0] ?? 0) - startedAt).toBeGreaterThanOrEqual(150);

    await waitFor(() => fakeChild.killCalls >= 2, 'the escalation kill after the grace', 5_000);
    expect((killTimes[1] ?? 0) - (killTimes[0] ?? 0), 'the second kill waits out the 2 s grace').toBeGreaterThanOrEqual(1_900);
    // ...and no third kill: the escalation is exactly two calls.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(fakeChild.killCalls).toBe(2);
  }, 20_000);

  it('REAL hung child: killed at the deadline, its OS process is gone, the next extraction works', { timeout: 180_000 }, async () => {
    const dir = makeTempDir();
    const hungChild = writeNeverExitingChild(dir);
    const recorded: Array<{ pid?: number; args?: string[] }> = [];
    const wrappingLauncher = (modulePath: string, args: string[]): PackWorkerChild => {
      const cp = fork(modulePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      recorded.push({ pid: cp.pid, args });
      const onAny = (event: string, cb: (value: unknown) => void): unknown => {
        (cp as unknown as { on(e: string, l: (...a: unknown[]) => void): unknown }).on(event, cb as never);
        return cp;
      };
      return {
        on: onAny as unknown as PackWorkerChild['on'],
        kill: (): unknown => cp.kill(),
        get pid(): number | undefined {
          return cp.pid;
        },
      };
    };
    setPackWorkerForkFn(wrappingLauncher);

    let failure: unknown;
    try {
      await within(
        extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'hung-real.zip', undefined, { childPath: hungChild, timeoutMs: 500 }),
        15_000,
      );
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/timed out/i);

    const pid = recorded[0]?.pid;
    expect(typeof pid).toBe('number');
    const gone = await waitFor(() => {
      try {
        process.kill(pid as number, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 'hung child OS process to disappear', 5_000);
    expect(gone).toBe(true);

    // The parent survived: the REAL child extracts the committed fixture next.
    setPackWorkerForkFn(null);
    const outDir = await within(
      extractPackZipWithOptions(new Uint8Array(fs.readFileSync(PARITY_ZIP)), 'parity-pack.zip', DEFAULT_LIMITS, { timeoutMs: 120_000 }),
      180_000,
    );
    expect(fs.existsSync(path.join(outDir, 'pack.json'))).toBe(true);
    fs.rmSync(outDir, { recursive: true, force: true });
  }, 240_000);
});

// ==================================================================== //
// P8 — malformed / oversize reports                                     //
// ==================================================================== //
describe('#320 AC3 P8: malformed reports are rejected with the `pack worker:` prefix', () => {
  const badReports: unknown[] = [
    { ok: true }, // no dir
    { ok: true, dir: '' }, // empty dir
    { ok: true, dir: 42 }, // non-string dir
    // R18-1: a success report naming a directory OTHER than the out dir the
    // parent passed (args[1]) is MALFORMED — a constant foreign path can
    // never equal the per-call workspace out dir. (P9's dedicated wrong-dir
    // leg additionally proves workspace cleanup + foreign-tree preservation.)
    { ok: true, dir: path.join(os.tmpdir(), 'p8-foreign-unrelated-dir') }, // wrong dir
    { ok: false }, // no code, no error
    { ok: false, code: 'entry-cap' }, // no error
    { ok: false, code: '', error: 'x.zip: archive declares 3 entries, over the 2 entry cap' }, // empty code
    'not-an-object',
  ];

  it.each(badReports.map((report) => [JSON.stringify(report), report] as const))('%s', async (_id, report) => {
    const fakeChild = makeFakeChild();
    setPackWorkerForkFn(() => fakeChild);
    const script = setInterval(() => {
      if ((fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(script);
      fakeChild.emit('message', report);
      fakeChild.emit('exit', 0);
    }, 10);
    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'malformed.zip', undefined, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(script);
    }
    expect(failure, `malformed report ${_id} must reject`).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(WORKER_PREFIX);
  });

  it('an oversize report (> 16 MiB serialized) rejects with the prefix and kills the child', async () => {
    const fakeChild = makeFakeChild();
    setPackWorkerForkFn(() => fakeChild);
    const big = setInterval(() => {
      if ((fakeChild.listeners.message ?? []).length === 0) return;
      clearInterval(big);
      fakeChild.emit('message', { ok: true, dir: `x`.repeat(17 * 1024 * 1024) });
    }, 10);
    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'oversize.zip', undefined, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(big);
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(WORKER_PREFIX);
    expect((failure as Error).message, 'oversize must be detected, not timed out').not.toMatch(/timed out/i);
    expect(fakeChild.killCalls, 'an oversize report kills the child').toBeGreaterThanOrEqual(1);
  });
});

// ==================================================================== //
// P9 — the parent-owned workspace lifecycle (R17-2: a matrix over EVERY  //
// non-success path + the success move)                                 //
// ==================================================================== //
describe('#320 AC3 P9: the parent-owned workspace is removed on success and on EVERY failure path', () => {
  /** Fake-seam scaffolding: run one extraction with a scripted fake child.
   * The script receives the child handle AND the launcher argv of ITS call
   * (args[1] is the parent-created out dir the fake child "extracts" into). */
  async function runWithFakeChild(
    script: (child: FakeChild, args: string[]) => void,
    filename = 'lifecycle.zip',
    timeoutMs = 5_000,
  ): Promise<{ outcome: 'fulfilled'; value: string } | { outcome: 'rejected'; reason: unknown; workspace?: string }> {
    const fakeChild = makeFakeChild();
    let workspace: string | undefined;
    let fired = false;
    setPackWorkerForkFn((_modulePath, args) => {
      workspace = trackWorkspace(args);
      lastArgs = args;
      return fakeChild;
    });
    const timer = setInterval(() => {
      if (!fired && workspace !== undefined && (fakeChild.listeners.message ?? []).length > 0 && (fakeChild.listeners.exit ?? []).length > 0) {
        fired = true;
        script(fakeChild, lastArgs as string[]);
      }
    }, 10);
    try {
      const value = await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), filename, undefined, { timeoutMs }), 10_000);
      return { outcome: 'fulfilled', value };
    } catch (reason) {
      return { outcome: 'rejected', reason, workspace };
    } finally {
      clearInterval(timer);
    }
  }

  it('SUCCESS: the extracted out dir is MOVED to a fresh returned dir; the workspace is removed', { timeout: 180_000 }, async () => {
    let movedFrom: string | undefined;
    const result = await runWithFakeChild((child, args) => {
      // The fake child writes the extracted tree into ITS out dir and reports.
      const outDir = args[1] as string;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'pack.json'), PACK_JSON_STUB);
      movedFrom = outDir;
      child.emit('message', { ok: true, dir: outDir });
      child.emit('exit', 0);
    });
    expect(result.outcome).toBe('fulfilled');
    const dir = (result as { outcome: 'fulfilled'; value: string }).value;
    expect(fs.existsSync(path.join(dir, 'pack.json'))).toBe(true);
    // The returned dir is a FRESH pack-install-* dir (not the workspace out
    // dir, not the workspace path) whose TREE came along byte-identical
    // (R18-1), and the workspace no longer exists.
    expect(movedFrom).toBeDefined();
    expect(dir).not.toBe(movedFrom);
    expect(dir).not.toBe(path.dirname(movedFrom as string));
    expect(path.basename(dir)).toMatch(/^pack-install-/);
    expect(Buffer.compare(fs.readFileSync(path.join(dir, 'pack.json')), PACK_JSON_STUB), 'the returned fresh dir holds the tree').toBe(0);
    expect(path.basename(path.dirname(movedFrom as string))).toMatch(/^pack-extract-/);
    expect(fs.existsSync(movedFrom as string)).toBe(false);
    expect(fs.existsSync(path.dirname(movedFrom as string)), 'the whole workspace is removed').toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The most recent launcher argv captured by runWithFakeChild / the matrix legs. */
  let lastArgs: string[] | undefined;

  it('matrix: every failure path removes the whole workspace', { timeout: 180_000 }, async () => {
    // The fake-seam legs share one argv capture point.
    const cases: Array<{ id: string; run: () => Promise<{ workspace?: string; rejected: boolean }> }> = [];
    const makeFakeLeg = (
      id: string,
      script: (child: FakeChild) => void,
    ): { id: string; run: () => Promise<{ workspace?: string; rejected: boolean }> } => ({
      id,
      run: async () => {
        const fakeChild = makeFakeChild();
        let workspace: string | undefined;
        setPackWorkerForkFn((_modulePath, args) => {
          lastArgs = args;
          workspace = trackWorkspace(args);
          return fakeChild;
        });
        const timer = setInterval(() => {
          if ((fakeChild.listeners.message ?? []).length > 0 && (fakeChild.listeners.exit ?? []).length > 0) {
            script(fakeChild);
          }
        }, 10);
        let rejected = false;
        try {
          const value = await within(
            extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), `${id}.zip`, undefined, { timeoutMs: id === 'deadline-fake' ? 250 : 5_000 }),
            10_000,
          );
          fs.rmSync(value, { recursive: true, force: true });
        } catch {
          rejected = true;
        } finally {
          clearInterval(timer);
        }
        return { workspace, rejected };
      },
    });

    cases.push(
      makeFakeLeg('report-failure', (child) => {
        child.emit('message', { ok: false, code: 'entry-cap', error: 'x.zip: archive declares 3 entries, over the 2 entry cap' });
        child.emit('exit', 1);
      }),
      makeFakeLeg('no-report-clean-exit', (child) => {
        child.emit('exit', 0);
      }),
      makeFakeLeg('crash-exit-3-no-report', (child) => {
        child.emit('exit', 3);
      }),
      makeFakeLeg('malformed-report', (child) => {
        child.emit('message', { ok: true });
        child.emit('exit', 0);
      }),
      makeFakeLeg('wrong-dir-report', (child) => {
        // R18-1: a success report naming anything OTHER than the passed out
        // dir (args[1]) is malformed — the dedicated wrong-dir leg below also
        // proves the foreign tree survives; this row pins the rejection +
        // workspace cleanup inside the matrix.
        child.emit('message', { ok: true, dir: path.join(os.tmpdir(), 'p9-foreign-dir-constant') });
        child.emit('exit', 0);
      }),
      makeFakeLeg('wrong-dir-lexical-alias-report', (child) => {
        // R20-2: a success report whose dir RESOLVES to args[1] but is NOT
        // the identical string (<work>/child-created/../out) is malformed —
        // EXACT STRING IDENTITY, no path.resolve equivalence. The dedicated
        // lexical-alias leg below also proves NOTHING is adopted; this row
        // pins the rejection + workspace cleanup inside the matrix.
        const aliased = lastArgs?.[1];
        child.emit('message', {
          ok: true,
          dir:
            typeof aliased === 'string'
              ? `${path.dirname(aliased)}${path.sep}child-created${path.sep}..${path.sep}${WORKSPACE_OUT_BASENAME}`
              : path.join(os.tmpdir(), 'p9-foreign-dir-constant'),
        });
        child.emit('exit', 0);
      }),
      makeFakeLeg('oversize-report', (child) => {
        // A serialized report over the 16 MiB cap (the P8 shape): reject +
        // kill, and the workspace is still owed to the parent cleanup.
        child.emit('message', { ok: true, dir: 'x'.repeat(17 * 1024 * 1024) });
      }),
      makeFakeLeg('deadline-fake', (_child) => {
        /* never reports, never exits: the deadline path */
      }),
    );
    // The launch-throw leg registers its own launcher: the launcher ITSELF
    // throws synchronously (a script-time throw would escape the interval
    // timer, not the launcher contract).
    cases.push({
      id: 'launch-throw-registered',
      run: async () => {
        let workspace: string | undefined;
        setPackWorkerForkFn((_modulePath, args) => {
          lastArgs = args;
          workspace = trackWorkspace(args);
          throw new Error('boom: launcher refused to start');
        });
        let rejected = false;
        try {
          await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'launch-throw.zip'), 5_000);
        } catch {
          rejected = true;
        }
        return { workspace, rejected };
      },
    });

    for (const leg of cases) {
      const result = await leg.run();
      expect(result.rejected, `${leg.id} must reject`).toBe(true);
      expect(result.workspace, `${leg.id}: the launcher ran, so a workspace existed`).toBeDefined();
      expect(
        fs.existsSync(result.workspace as string),
        `${leg.id}: the whole workspace must be removed afterwards`,
      ).toBe(false);
    }

    // ---- R18-2: LAUNCH REFUSAL (inside Electron with nothing registered)
    // must REMOVE the workspace, not merely reject — the round-16 critic
    // found the refusal exercised only for its error text. No launcher runs,
    // so the assertion is that NO new pack-extract-* workspace remains.
    {
      setPackWorkerForkFn(null);
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-extract-'));
      const versions = process.versions as { electron?: string };
      const hadElectron = Object.prototype.hasOwnProperty.call(versions, 'electron');
      const previousElectron = versions.electron;
      versions.electron = '31.0.0-spec';
      let refusal: unknown;
      try {
        await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'refusal-cleanup.zip'), 5_000);
      } catch (err) {
        refusal = err;
      } finally {
        if (hadElectron) versions.electron = previousElectron;
        else delete versions.electron;
      }
      expect(refusal, 'the no-launcher Electron refusal must reject').toBeInstanceOf(Error);
      expect((refusal as Error).message).not.toMatch(/spec guard/);
      expect((refusal as Error).message).toMatch(WORKER_PREFIX);
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-extract-'));
      expect(
        after.filter((n) => !before.includes(n)),
        'launch refusal must leave NO pack-extract-* workspace behind (R18-2)',
      ).toEqual([]);
    }

    // ---- REAL-child legs (crash, deadline, post-report hang) where the
    // workspace is captured from the launcher argv. R18-2: every real crash/
    // deadline child WRITES PARTIAL OUTPUT under the out dir (args[1]) before
    // dying or hanging; the deadline/report-hang legs WAIT until that partial
    // output demonstrably exists, then assert the parent removed ALL of it.
    const realLegs: Array<{ id: string; childPath?: string; filename?: string; timeoutMs: number; waitForPartial?: boolean }> = [
      // The crash child writes its partial tree then exits 2 synchronously —
      // the write is ordered before the exit inside the child, so the
      // workspace-gone assertion below covers the partial output.
      { id: 'crash-real', childPath: writeCrashChild(makeTempDir()), timeoutMs: 15_000 },
      { id: 'deadline-real', childPath: writeNeverExitingChild(makeTempDir()), timeoutMs: 400, waitForPartial: true },
      { id: 'report-then-hang-real', childPath: writeReportThenHangChild(makeTempDir()), timeoutMs: 700, waitForPartial: true },
    ];
    for (const leg of realLegs) {
      const realFork = resolvePackWorkerForkFn(false);
      expect(typeof realFork).toBe('function');
      let workspace: string | undefined;
      setPackWorkerForkFn((modulePath, args) => {
        lastArgs = args;
        workspace = trackWorkspace(args);
        return realFork(modulePath, args);
      });
      let rejected = false;
      const pending = extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), leg.filename ?? `${leg.id}.zip`, undefined, {
        timeoutMs: leg.timeoutMs,
        ...(leg.childPath === undefined ? {} : { childPath: leg.childPath }),
      });
      if (leg.waitForPartial === true) {
        // Anti-vacuity: the partial output REALLY existed under <work>/out
        // before the kill — the parent must still remove every byte of it.
        await waitFor(
          () =>
            (workspace !== undefined && fs.existsSync(path.join(workspace, WORKSPACE_OUT_BASENAME, 'partial.txt'))) ||
            false,
          `${leg.id}: the child's partial output under <work>/out`,
          5_000,
        );
      }
      try {
        const value = await within(pending, 20_000);
        fs.rmSync(value, { recursive: true, force: true });
      } catch {
        rejected = true;
      }
      expect(rejected, `${leg.id} must reject`).toBe(true);
      expect(workspace, `${leg.id}: the launcher ran`).toBeDefined();
      expect(fs.existsSync(workspace as string), `${leg.id}: the workspace must be removed`).toBe(false);
      // R18-2: the PARTIAL OUTPUT died with the workspace — the whole tree
      // under <work>, the partial file included, is gone. For the
      // report-then-hang leg this also re-proves a report ALONE never
      // settles the runner: the deadline owns the kill AND the cleanup even
      // though a (valid) report arrived first.
      expect(
        workspace !== undefined && fs.existsSync(path.join(workspace, WORKSPACE_OUT_BASENAME, 'partial.txt')),
        `${leg.id}: the partial output must be gone with the workspace`,
      ).toBe(false);
    }

    // ---- WRITE failure: the parent cannot write <work>/input.zip. Forced by
    // spying on fs.writeFileSync and throwing ENOSPC for exactly the input.zip
    // basename (a read-only os.tmpdir surrogate is unreliable on Windows and
    // would break mkdtemp itself, before any workspace exists). Best-effort
    // forcing: if the shipped runner writes input.zip through another API the
    // leg degrades to an ordinary rejection leg — it can never pass spuriously
    // (the workspace-gone assertion is checked either way), it only fails to
    // exercise the exact route.
    {
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-extract-'));
      const realWriteFileSync: typeof fs.writeFileSync = fs.writeFileSync;
      const spy = vi
        .spyOn(fs, 'writeFileSync')
        .mockImplementation((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
          if (typeof file === 'string' && path.basename(file) === WORKSPACE_INPUT_BASENAME) {
            throw Object.assign(new Error('ENOSPC: spec-forced input.zip write failure'), { code: 'ENOSPC' });
          }
          realWriteFileSync(file, data, options);
        });
      let rejected = false;
      try {
        await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'write-fail.zip'), 10_000);
      } catch {
        rejected = true;
      } finally {
        spy.mockRestore();
      }
      expect(rejected, 'a failed input.zip write must reject (never resolve, never hang)').toBe(true);
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-extract-'));
      expect(
        after.filter((n) => !before.includes(n)),
        'a failed write must not strand a workspace directory in tmp',
      ).toEqual([]);
    }
  }, 120_000);

  it('R18-1 dedicated wrong-dir leg: a success report naming a directory other than the passed out dir is malformed — prefix rejection, workspace removed, foreign tree preserved', { timeout: 180_000 }, async () => {
    const fakeChild = makeFakeChild();
    let workspace: string | undefined;
    setPackWorkerForkFn((_modulePath, args) => {
      workspace = trackWorkspace(args);
      return fakeChild;
    });
    // The foreign tree: a directory the child carved out on its own — exactly
    // the round-16 shape a lenient runner would adopt or delete.
    const foreign = makeTempDir();
    fs.mkdirSync(path.join(foreign, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'pack.json'), Buffer.from('{"id":"foreign"}'));
    fs.writeFileSync(path.join(foreign, 'docs', 'foreign.txt'), Buffer.from('foreign tree'));
    const timer = setInterval(() => {
      if ((fakeChild.listeners.message ?? []).length === 0 || (fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(timer);
      // The broken/malicious child "extracts" into its OWN dir and reports it.
      fakeChild.emit('message', { ok: true, dir: foreign });
      fakeChild.emit('exit', 0);
    }, 10);
    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'wrong-dir.zip', undefined, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(timer);
    }
    expect(failure, 'the wrong-dir success report must reject as a malformed report').toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(WORKER_PREFIX);
    expect(workspace, 'the launcher ran, so a workspace existed').toBeDefined();
    expect(fs.existsSync(workspace as string), 'the WHOLE workspace must be removed').toBe(false);
    // The foreign tree survives byte-for-byte — never adopted, never moved,
    // never cleaned. A STRICT implementation (reject dir !== args[1]) passes;
    // a lenient one (move whatever is reported) either returns a foreign path
    // (fails the rejection above) or deletes the tree (fails this).
    expect(fs.readFileSync(path.join(foreign, 'pack.json')).toString()).toBe('{"id":"foreign"}');
    expect(fs.readFileSync(path.join(foreign, 'docs', 'foreign.txt')).toString()).toBe('foreign tree');
    expect(fs.readdirSync(foreign).sort()).toEqual(['docs', 'pack.json']);
  });

  it('R19-2 same-basename foreign-out leg: a report dir equal to args[1] ONLY by basename (<fresh-root>/out vs <work>/out) is malformed — prefix rejection, workspace removed, foreign tree byte-preserved', { timeout: 180_000 }, async () => {
    const fakeChild = makeFakeChild();
    let outArg: string | undefined;
    setPackWorkerForkFn((_modulePath, args) => {
      outArg = args[1];
      trackWorkspace(args);
      return fakeChild;
    });
    // The foreign tree: a FRESH root whose child dir carries the SAME basename
    // `out` as the parent-passed out dir but a DIFFERENT parent — the exact
    // pair a basename-only parent conflates (every differently-named frozen
    // fixture above is rejected by BOTH implementations; only this leg
    // discriminates them).
    const foreignRoot = makeTempDir();
    const foreignOut = path.join(foreignRoot, WORKSPACE_OUT_BASENAME);
    fs.mkdirSync(path.join(foreignOut, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(foreignOut, 'pack.json'), Buffer.from('{"id":"foreign-same-basename"}'));
    fs.writeFileSync(path.join(foreignOut, 'docs', 'foreign.txt'), Buffer.from('foreign same-basename tree'));
    const foreignBefore = treeManifest(foreignOut);
    const timer = setInterval(() => {
      if ((fakeChild.listeners.message ?? []).length === 0 || (fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(timer);
      // The malicious child reports its OWN <fresh-root>/out: identical
      // basename, different root.
      fakeChild.emit('message', { ok: true, dir: foreignOut });
      fakeChild.emit('exit', 0);
    }, 10);
    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'same-basename-out.zip', undefined, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(timer);
    }
    expect(outArg, 'the launcher ran, so the parent had created its own out dir').toBeDefined();
    // Leg geometry: same basename, different whole path — the discriminator a
    // basename-only parent cannot make.
    expect(path.basename(foreignOut)).toBe(WORKSPACE_OUT_BASENAME);
    expect(path.basename(outArg as string)).toBe(WORKSPACE_OUT_BASENAME);
    expect(path.dirname(foreignOut)).not.toBe(path.dirname(outArg as string));
    expect(foreignOut).not.toBe(outArg);
    expect(failure, 'a report dir equal to args[1] only by BASENAME must reject as malformed (FULL-PATH identity, R19-2)').toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(WORKER_PREFIX);
    const workspace = path.dirname(path.resolve(outArg as string));
    expect(fs.existsSync(workspace), 'the WHOLE workspace must be removed').toBe(false);
    // The foreign tree survives byte-for-byte — never adopted (a basename-only
    // parent would have moved it into pack-install-* and deleted the
    // original), never touched.
    expect(fs.existsSync(foreignRoot), 'the foreign ROOT survives').toBe(true);
    expect(treeManifest(foreignOut), 'the foreign tree is byte-preserved').toEqual(foreignBefore);
    expect(fs.readFileSync(path.join(foreignOut, 'pack.json')).toString()).toBe('{"id":"foreign-same-basename"}');
    expect(fs.readFileSync(path.join(foreignOut, 'docs', 'foreign.txt')).toString()).toBe('foreign same-basename tree');
    expect(fs.readdirSync(foreignOut).sort()).toEqual(['docs', 'pack.json']);
  });

  it('R20-2 lexical-alias rejection leg: a report dir that RESOLVES to args[1] but is NOT the identical string (<work>/child-created/../out) is malformed — prefix rejection, workspace removed, NOTHING adopted', { timeout: 180_000 }, async () => {
    const fakeChild = makeFakeChild();
    let outArg: string | undefined;
    setPackWorkerForkFn((_modulePath, args) => {
      outArg = args[1];
      trackWorkspace(args);
      return fakeChild;
    });
    // The conformant-looking attack (the round-18 critic's executed probe,
    // VERBATIM in shape): the child writes the REAL tree into the parent's
    // out dir — so a resolved-path parent finds the tree and moves it — then
    // reports the out dir through a LEXICAL ALIAS, a different string that
    // path.resolve maps onto the same directory. EXACT STRING IDENTITY
    // rejects the report BEFORE any adoption; the resolved-path parent the
    // R19-2 demonstration shipped accepted and adopted exactly this shape.
    const installBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-install-'));
    const timer = setInterval(() => {
      if ((fakeChild.listeners.message ?? []).length === 0 || (fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(timer);
      const outDir = outArg as string;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'pack.json'), PACK_JSON_STUB);
      fakeChild.emit('message', {
        ok: true,
        dir: `${path.dirname(outDir)}${path.sep}child-created${path.sep}..${path.sep}${WORKSPACE_OUT_BASENAME}`,
      });
      fakeChild.emit('exit', 0);
    }, 10);
    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'lexical-alias-out.zip', undefined, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(timer);
    }
    const alias =
      outArg !== undefined
        ? `${path.dirname(outArg)}${path.sep}child-created${path.sep}..${path.sep}${WORKSPACE_OUT_BASENAME}`
        : undefined;
    // Leg geometry: a DIFFERENT string that path.resolve maps ONTO args[1] —
    // the exact pair a resolved-path (or realpath) parent conflates and the
    // exact-identity parent does not.
    expect(outArg, 'the launcher ran, so the parent had created its own out dir').toBeDefined();
    expect(alias).toBeDefined();
    expect(alias).not.toBe(outArg);
    expect(path.resolve(alias as string)).toBe(path.resolve(outArg as string));
    expect(
      failure,
      'a report dir that is not the IDENTICAL args[1] string must reject as malformed (EXACT STRING IDENTITY, R20-2)',
    ).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(WORKER_PREFIX);
    expect(message).not.toMatch(/timed out/i);
    const workspace = outArg !== undefined ? path.dirname(path.resolve(outArg)) : undefined;
    expect(workspace).toBeDefined();
    expect(fs.existsSync(workspace as string), 'the WHOLE workspace (the parent-created out dir included) must be removed').toBe(false);
    // NOTHING was adopted: no fresh pack-install-* dir appeared anywhere (a
    // resolved-path parent would have moved the tree into one — the executed
    // round-18 adoption), and the aliased spelling does not survive as a
    // directory either (it names the removed out dir through .. segments).
    const installAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pack-install-'));
    expect(
      installAfter.filter((n) => !installBefore.includes(n)),
      'the lexical-alias report must adopt NOTHING (no new pack-install-* dir)',
    ).toEqual([]);
  });

  it('R19-2/R20-2 demonstration: a BASENAME-ONLY parent (path.basename comparison) FAILS the same-basename leg and a RESOLVED-PATH parent (path.resolve equality) FAILS the lexical-alias leg; EXACT STRING IDENTITY passes both — the check\'s own classifier', { timeout: 180_000 }, () => {
    // The check's own classifier, made explicit: the three candidate
    // report-dir validators an implementer could ship. The two WRONG ones
    // normalize: basename-only conflates every same-basename directory (the
    // executed round-17 false-green), and resolved-path equality ADDITIONALLY
    // accepts lexical aliases (the executed round-18 false-green). The
    // contract validator (R20-2) is the literal string comparison
    // report.dir === args[1] with NO normalization of either side.
    const basenameOnlyParent = (reportDir: string, passedOutDir: string): boolean =>
      path.basename(reportDir) === path.basename(passedOutDir);
    const resolvedPathParent = (reportDir: string, passedOutDir: string): boolean =>
      path.resolve(reportDir) === path.resolve(passedOutDir);
    const exactIdentityParent = (reportDir: string, passedOutDir: string): boolean =>
      reportDir === passedOutDir;

    const work = makeTempDir();
    const passedOutDir = path.join(work, WORKSPACE_OUT_BASENAME); // the launcher's args[1]
    const conformant = passedOutDir;
    const differentlyNamedForeign = path.join(os.tmpdir(), 'p9-foreign-dir-constant'); // a frozen fixture shape
    const foreignRoot = makeTempDir();
    const sameBasenameForeign = path.join(foreignRoot, WORKSPACE_OUT_BASENAME);
    const lexicalAlias = `${work}${path.sep}child-created${path.sep}..${path.sep}${WORKSPACE_OUT_BASENAME}`;

    // Controls — all three parents agree on the conformant dir and on every
    // DIFFERENTLY-named frozen foreign dir: the pre-R19 frozen fixtures alone
    // could NOT discriminate the implementations (the round-17 false-green).
    expect(basenameOnlyParent(conformant, passedOutDir)).toBe(true);
    expect(resolvedPathParent(conformant, passedOutDir)).toBe(true);
    expect(exactIdentityParent(conformant, passedOutDir)).toBe(true);
    expect(basenameOnlyParent(differentlyNamedForeign, passedOutDir)).toBe(false);
    expect(resolvedPathParent(differentlyNamedForeign, passedOutDir)).toBe(false);
    expect(exactIdentityParent(differentlyNamedForeign, passedOutDir)).toBe(false);

    // Discriminator 1 (R19-2): the same-basename foreign dir. The
    // basename-only parent ACCEPTS it — adoption into pack-install-*,
    // workspace removal, foreign tree consumed — which the dedicated
    // same-basename leg above freezes as a REJECTION, so a basename-only
    // implementation FAILS this check. The resolved-path and exact-identity
    // parents both reject it, exactly as the frozen leg requires.
    expect(path.basename(sameBasenameForeign)).toBe(path.basename(passedOutDir));
    expect(sameBasenameForeign).not.toBe(passedOutDir);
    expect(
      basenameOnlyParent(sameBasenameForeign, passedOutDir),
      'a basename-only parent wrongly ACCEPTS the foreign out (it fails the frozen same-basename leg)',
    ).toBe(true);
    expect(
      resolvedPathParent(sameBasenameForeign, passedOutDir),
      'the resolved-path parent rejects the same-basename foreign out',
    ).toBe(false);
    expect(
      exactIdentityParent(sameBasenameForeign, passedOutDir),
      'the exact-identity parent rejects the same-basename foreign out (it passes the frozen same-basename leg)',
    ).toBe(false);

    // Discriminator 2 (R20-2): the LEXICAL ALIAS. The alias is a DIFFERENT
    // string that path.resolve maps ONTO the passed out dir, so the
    // resolved-path parent ACCEPTS it — adopting the tree through a report
    // that is not args[1] — which the dedicated lexical-alias leg above
    // freezes as a REJECTION: a resolved-path implementation FAILS this
    // check. EXACT STRING IDENTITY rejects it, exactly as the frozen leg
    // requires.
    expect(lexicalAlias).not.toBe(passedOutDir);
    expect(path.resolve(lexicalAlias)).toBe(path.resolve(passedOutDir));
    expect(
      resolvedPathParent(lexicalAlias, passedOutDir),
      'a resolved-path parent wrongly ACCEPTS the lexical alias (it fails the frozen lexical-alias leg)',
    ).toBe(true);
    expect(
      exactIdentityParent(lexicalAlias, passedOutDir),
      'the exact-identity parent rejects the lexical alias (it passes the frozen lexical-alias leg)',
    ).toBe(false);
  });

  it('temp naming: the workspace prefix is the frozen mkdtemp prefix, never pid/date composition', { timeout: 180_000 }, async () => {
    const fakeChild = makeFakeChild();
    const argsCapture: string[][] = [];
    setPackWorkerForkFn((_modulePath, args) => {
      argsCapture.push(args);
      trackWorkspace(args);
      return fakeChild;
    });
    const script = setInterval(() => {
      if ((fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(script);
      fakeChild.emit('message', { ok: false, code: 'x', error: 'x.zip: no pack.json manifest at the archive root' });
      fakeChild.emit('exit', 1);
    }, 10);
    await within(
      extractPackZip(new Uint8Array(smallPackZipBytes()), 'naming.zip').then(
        () => undefined,
        () => undefined,
      ),
      10_000,
    ).finally(() => clearInterval(script));
    expect(argsCapture).toHaveLength(1);
    const work = workspaceOfArgs(argsCapture[0]);
    expect(work).toBeDefined();
    // The frozen prefix (fs.mkdtempSync(path.join(os.tmpdir(), 'pack-extract-'))).
    expect(path.basename(work as string)).toMatch(/^pack-extract-/);
    // NOT a pid+Date.now composition (the round-15 collision probe).
    expect(path.basename(work as string)).not.toMatch(new RegExp(`${process.pid}`));
    // Two DIFFERENT calls get two DIFFERENT workspaces (unique by construction).
    const second = await (async () => {
      const fresh = makeFakeChild();
      let args2: string[] | undefined;
      setPackWorkerForkFn((_m, a) => {
        args2 = a;
        trackWorkspace(a);
        return fresh;
      });
      const timer = setInterval(() => {
        if ((fresh.listeners.exit ?? []).length === 0) return;
        clearInterval(timer);
        fresh.emit('message', { ok: false, code: 'x', error: 'y.zip: no pack.json manifest at the archive root' });
        fresh.emit('exit', 1);
      }, 10);
      await within(
        extractPackZip(new Uint8Array(smallPackZipBytes()), 'naming2.zip').then(
          () => undefined,
          () => undefined,
        ),
        10_000,
      ).finally(() => clearInterval(timer));
      return workspaceOfArgs(args2);
    })();
    expect(second).toBeDefined();
    expect(second).not.toBe(work);
  }, 30_000);
});

// ==================================================================== //
// P10 — bootstrap registration (source pin + electron stub legs)        //
// ==================================================================== //
describe('#320 AC3 P10: bootstrap registers the utilityProcess pack launcher', () => {
  const forkMock = utilityProcess.fork as unknown as ReturnType<typeof vi.fn>;
  const hermeticUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-utility-userdata-'));

  /**
   * A utility child shaped per call by `build(args)` (R18-1): the CONFORMANT
   * shape reports the out dir the PARENT passed (args[1]) and the fake child
   * writes the extracted tree into it before posting; a report naming any
   * OTHER dir is posted verbatim — the wrong-dir shape the runner must
   * reject.
   */
  function scriptedFork(build: (args: string[]) => { report?: Record<string, unknown>; code?: number }) {
    return (modulePath: string, args?: string[], options?: Record<string, unknown>) => {
      const child = new FakeUtilityProcess(modulePath, args ?? [], options);
      const { report, code = 0 } = build(args ?? []);
      setImmediate(() => {
        if (report !== undefined) {
          const dir = (report as { dir?: unknown }).dir;
          if (typeof dir === 'string' && args !== undefined && dir === args[1]) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'pack.json'), PACK_JSON_STUB);
          }
        }
        if (report !== undefined) child.emit('message', report);
        child.emit('exit', code);
      });
      return child;
    };
  }

  beforeEach(() => {
    __resetElectronStub();
    app.getPath.mockImplementation((name: string) => (name === 'userData' ? hermeticUserData : process.cwd()));
    __resetTransportSecurityForTests();
    setPackWorkerForkFn(null);
  });

  afterEach(async () => {
    app.emit('will-quit');
    await new Promise((resolve) => setTimeout(resolve, 50));
    setPackWorkerForkFn(null);
  });

  afterAll(() => {
    fs.rmSync(hermeticUserData, { recursive: true, force: true });
  });

  it('source pin: index.ts registers the pack launcher inside whenReady with the frozen serviceName; stop() wiring calls terminatePackWorkers', () => {
    const index = stripComments(fs.readFileSync(MAIN_INDEX_SOURCE, 'utf8'));
    expect(index).toContain('setPackWorkerForkFn(');
    expect(index).toContain(`'${SERVICE_NAME}'`);
    // The registration sits INSIDE the ready handler (after its opening).
    const readyAt = index.indexOf('app.whenReady().then');
    const registerAt = index.indexOf('setPackWorkerForkFn(');
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(registerAt).toBeGreaterThan(readyAt);

    const backendIndex = stripComments(fs.readFileSync(BACKEND_INDEX_SOURCE, 'utf8'));
    const stopAt = backendIndex.indexOf('async stop()');
    const terminateAt = backendIndex.indexOf('terminatePackWorkers()');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(terminateAt, 'NodeBackendHost.stop() must call terminatePackWorkers()').toBeGreaterThan(stopAt);
  });

  it('an extraction with NO explicit launcher forks the pack child through electron utilityProcess and adopts the CONFORMANT report into a fresh dir', async () => {
    expect(resolvePackWorkerForkFn(true), 'nothing registered before bootstrap').toBeNull();
    bootstrap();
    await waitFor(() => resolvePackWorkerForkFn(true) !== null, 'pack launcher registration');

    // R18-1: the stub child extracts into the PARENT-passed out dir (args[1])
    // and reports exactly that path — never a foreign dir.
    forkMock.mockImplementation(scriptedFork((args) => ({ report: { ok: true, dir: args[1] } })));
    forkMock.mockClear();

    const result = await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'reg.zip'), 10_000);
    expect(typeof result).toBe('string');

    expect(forkMock).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = forkMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(modulePath).toBe(packWorkerChildPath());
    expect(args).toHaveLength(4);
    expect(args[2]).toBe('reg.zip');
    expect(() => JSON.parse(args[3] as string)).not.toThrow();
    // The report rides the message channel: stdout discarded, stderr piped.
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(options.serviceName).toBe(SERVICE_NAME);
    // No environment override at all — in particular no ELECTRON_RUN_AS_NODE.
    expect(options).not.toHaveProperty('env');
    expect(JSON.stringify(options)).not.toContain('ELECTRON_RUN_AS_NODE');
    // R18-1 adoption: a FRESH pack-install-* dir carrying the tree; the
    // workspace (the parent of args[0]/args[1]) is gone.
    expect(result).not.toBe(args[1]);
    expect(path.basename(result)).toMatch(/^pack-install-/);
    expect(Buffer.compare(fs.readFileSync(path.join(result, 'pack.json')), PACK_JSON_STUB)).toBe(0);
    expect(fs.existsSync(path.dirname(path.resolve(args[0] as string))), 'the workspace is removed').toBe(false);
    fs.rmSync(result, { recursive: true, force: true });
  });

  it('R18-1 invalid-fixture leg: a utility child reporting a NON-workspace dir is malformed — prefix rejection, workspace removed, foreign tree preserved', async () => {
    bootstrap();
    await waitFor(() => resolvePackWorkerForkFn(true) !== null, 'pack launcher registration');

    const foreign = makeTempDir();
    fs.writeFileSync(path.join(foreign, 'foreign.txt'), Buffer.from('foreign tree'));
    forkMock.mockImplementation(scriptedFork(() => ({ report: { ok: true, dir: foreign } })));
    forkMock.mockClear();

    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'reg-wrong-dir.zip', undefined, { timeoutMs: 10_000 }), 15_000);
    } catch (err) {
      failure = err;
    }
    expect(forkMock, 'the registered utilityProcess launcher carried the call').toHaveBeenCalledTimes(1);
    expect(failure, 'a success report naming a NON-workspace dir must be rejected as malformed').toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(WORKER_PREFIX);
    expect(message).not.toMatch(/timed out/i);
    const call = forkMock.mock.calls[0] as [string, string[], Record<string, unknown>] | undefined;
    expect(call, 'the launcher ran').toBeDefined();
    const workspace = trackWorkspace(call?.[1]);
    expect(workspace, 'the workspace existed at launch').toBeDefined();
    expect(fs.existsSync(workspace as string), 'the workspace must be removed').toBe(false);
    // The foreign tree is PRESERVED untouched (never adopted, never cleaned).
    expect(fs.existsSync(path.join(foreign, 'foreign.txt')), 'the foreign tree must survive').toBe(true);
    expect(fs.readFileSync(path.join(foreign, 'foreign.txt')).toString()).toBe('foreign tree');
  });

  it('stub failure leg: a utility child that exits non-zero with NO report rejects naming the exit code', async () => {
    bootstrap();
    await waitFor(() => resolvePackWorkerForkFn(true) !== null, 'pack launcher registration');

    forkMock.mockImplementation(scriptedFork(() => ({ code: 3 })));
    forkMock.mockClear();

    let failure: unknown;
    try {
      await within(extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'reg-fail.zip', undefined, { timeoutMs: 10_000 }), 15_000);
    } catch (err) {
      failure = err;
    }
    expect(forkMock, 'the registered utilityProcess launcher carried the call').toHaveBeenCalledTimes(1);
    expect(failure, 'a non-zero exit without a report must reject').toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(WORKER_PREFIX);
    expect(message).not.toMatch(/timed out/i);
    expect(message).toMatch(/exit/i);
    expect(message).toMatch(/\b3\b/);
  });
});

// ==================================================================== //
// P11 — the REAL host stop() owns the pack children                     //
// ==================================================================== //
describe('#320 AC3 P11: NodeBackendHost.stop() kills a live pack child and rejects the pending extraction', () => {
  let host: NodeBackendHost | null = null;

  afterEach(async () => {
    // Belt and braces: never leak a fake in-flight extraction past the leg.
    terminatePackWorkers();
    if (host !== null) {
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it('stop() settles the in-flight extraction with a rejection, kills the child, and removes the workspace', { timeout: 180_000 }, async () => {
    // The i199/i230 host-lifecycle harness: a REAL NodeBackendHost on an
    // explicit StubEngine, started for real, then stopped through its own
    // stop() — never terminatePackWorkers() directly.
    host = new NodeBackendHost({
      token: 'i320-c3-pack-host-stop-token',
      engine: new StubEngine(),
    });
    await host.start();

    const fakeChild = makeFakeChild(); // never reports, never exits
    let launched = 0;
    let workspace: string | undefined;
    setPackWorkerForkFn((_modulePath, args) => {
      launched += 1;
      workspace = trackWorkspace(args);
      return fakeChild;
    });

    const pending = extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'host-stop.zip', undefined, { timeoutMs: 120_000 });
    // Observe settlement without an unhandled rejection window.
    let failure: unknown;
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        failure = err;
        settled = true;
      },
    );
    await waitFor(() => launched === 1, 'pack child launch');
    expect(fakeChild.killCalls, 'harness sanity: nothing killed the child before stop()').toBe(0);

    const stopping = host;
    host = null;
    await stopping.stop();

    await within(observed, 5_000).catch(() => {});
    expect(settled, 'host stop() must settle the in-flight extraction (stop() wiring)').toBe(true);
    expect(failure, 'the in-flight extraction must REJECT after host stop').toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(WORKER_PREFIX);
    expect(fakeChild.killCalls, 'host stop() must kill the live pack child').toBeGreaterThanOrEqual(1);
    // The terminate-on-stop path removes the workspace (R17-2).
    expect(workspace).toBeDefined();
    expect(fs.existsSync(workspace as string), 'terminate-on-stop must remove the workspace').toBe(false);
  }, 30_000);
});

// ==================================================================== //
// P12 — termination kills EVERY live child + REAL concurrency (R17-5)   //
// ==================================================================== //
describe('#320 AC3 P12: terminatePackWorkers kills every live child; two REAL extractions run concurrently', () => {
  it('two live children: both killed, both rejected with the terminate message; the seam still serves the next call', { timeout: 180_000 }, async () => {
    const children = [makeFakeChild(), makeFakeChild()];
    let launched = 0;
    setPackWorkerForkFn(() => {
      launched += 1;
      return children[launched - 1] as FakeChild;
    });

    const first = extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'first.zip', undefined, { timeoutMs: 120_000 });
    const second = extractPackZipWithOptions(new Uint8Array(smallPackZipBytes()), 'second.zip', undefined, { timeoutMs: 120_000 });
    await waitFor(() => launched === 2, 'both pack children launched');

    const observed = Promise.allSettled([first, second]);
    terminatePackWorkers();
    const results = await within(observed, 5_000);

    for (const result of results) {
      expect(result.status).toBe('rejected');
      const message = (result as PromiseRejectedResult).reason instanceof Error
        ? ((result as PromiseRejectedResult).reason as Error).message
        : String((result as PromiseRejectedResult).reason);
      expect(message).toMatch(WORKER_PREFIX);
      expect(message).toMatch(/terminat/i);
    }
    for (const child of children) {
      expect(child.killCalls).toBeGreaterThanOrEqual(1);
    }

    // The seam survives termination. R18-1: a success report naming an
    // UNRELATED directory is MALFORMED — rejected with the prefix, the
    // workspace removed, the foreign tree untouched (this replaces the
    // round-16 identity assertion `next === adopted`, which contradicted
    // P3/P9's move contract) — and a CONFORMANT report (dir === args[1], tree
    // written into it) adopts into a FRESH returned dir.
    const foreign = makeTempDir();
    fs.writeFileSync(path.join(foreign, 'foreign-pack.json'), PACK_JSON_STUB);
    const wrongDirChild = makeFakeChild();
    let wrongDirArgs: string[] | undefined;
    setPackWorkerForkFn((_modulePath, args) => {
      wrongDirArgs = args;
      trackWorkspace(args);
      return wrongDirChild;
    });
    const wrongDirTimer = setInterval(() => {
      if ((wrongDirChild.listeners.exit ?? []).length === 0) return;
      clearInterval(wrongDirTimer);
      wrongDirChild.emit('message', { ok: true, dir: foreign });
      wrongDirChild.emit('exit', 0);
    }, 10);
    let wrongDirFailure: unknown;
    try {
      await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'wrong-dir.zip'), 10_000);
    } catch (err) {
      wrongDirFailure = err;
    } finally {
      clearInterval(wrongDirTimer);
    }
    expect(wrongDirFailure, 'the unrelated-directory success report must be rejected as malformed').toBeInstanceOf(Error);
    expect((wrongDirFailure as Error).message).not.toMatch(/spec guard/);
    expect((wrongDirFailure as Error).message).toMatch(WORKER_PREFIX);
    expect(wrongDirArgs, 'the launcher ran').toBeDefined();
    const wrongDirWorkspace = wrongDirArgs !== undefined ? workspaceOfArgs(wrongDirArgs) : undefined;
    expect(wrongDirWorkspace).toBeDefined();
    expect(fs.existsSync(wrongDirWorkspace as string), 'the workspace must be removed after the wrong-dir rejection').toBe(false);
    expect(fs.existsSync(path.join(foreign, 'foreign-pack.json')), 'the unrelated directory must survive untouched').toBe(true);

    // Conformant recovery: the seam serves a full extraction end to end.
    const fresh = makeFakeChild();
    let freshArgs: string[] | undefined;
    setPackWorkerForkFn((_modulePath, args) => {
      freshArgs = args;
      trackWorkspace(args);
      return fresh;
    });
    const script = setInterval(() => {
      if ((fresh.listeners.exit ?? []).length === 0) return;
      clearInterval(script);
      const outDir = freshArgs?.[1] as string;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'pack.json'), PACK_JSON_STUB);
      fresh.emit('message', { ok: true, dir: outDir });
      fresh.emit('exit', 0);
    }, 10);
    const next = await within(extractPackZip(new Uint8Array(smallPackZipBytes()), 'after-terminate.zip'), 10_000).finally(
      () => clearInterval(script),
    );
    expect(next).not.toBe(freshArgs?.[1]);
    expect(path.basename(next)).toMatch(/^pack-install-/);
    expect(Buffer.compare(fs.readFileSync(path.join(next, 'pack.json')), PACK_JSON_STUB)).toBe(0);
    const freshWorkspace = freshArgs !== undefined ? workspaceOfArgs(freshArgs) : undefined;
    expect(freshWorkspace).toBeDefined();
    expect(fs.existsSync(freshWorkspace as string), 'the workspace is removed after the success move').toBe(false);
    fs.rmSync(next, { recursive: true, force: true });
  });

  it('REAL concurrency: two simultaneous REAL-child extractions of different payloads — distinct workspaces, correct trees, both cleaned', { timeout: 180_000 }, async () => {
    setPackWorkerForkFn(null);
    const realFork = resolvePackWorkerForkFn(false);
    expect(typeof realFork).toBe('function');
    const workspaces: Array<string | undefined> = [];
    setPackWorkerForkFn((modulePath: string, args: string[]) => {
      workspaces.push(trackWorkspace(args));
      return realFork(modulePath, args);
    });

    // Two DIFFERENT payloads: the committed parity fixture, and a synthetic
    // two-doc pack with unicode/space-carrying names in the tree.
    const fixtureBytes = fs.readFileSync(PARITY_ZIP);
    const golden = JSON.parse(fs.readFileSync(PARITY_GOLDEN, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const synthDoc = Buffer.from('concurrent second payload — ünïcode ✓', 'utf8');
    const synth = buildRawZip([
      { name: 'pack.json', data: PACK_JSON_STUB, method: 0 },
      { name: 'docs/only doc.txt', data: synthDoc, method: 8 },
      { name: 'assets/two words.bin', data: Buffer.from('second payload asset'), method: 0 },
    ]);

    const [a, b] = await within(
      Promise.all([
        extractPackZipWithOptions(new Uint8Array(fixtureBytes), 'parity-pack.zip', DEFAULT_LIMITS, { timeoutMs: 120_000 }),
        extractPackZipWithOptions(new Uint8Array(synth), 'concurrent second.zip', DEFAULT_LIMITS, { timeoutMs: 120_000 }),
      ]),
      240_000,
    );
    try {
      // Distinct returned dirs with the CORRECT trees (no cross-talk).
      expect(a).not.toBe(b);
      expect(treeManifest(a)).toEqual(golden.files);
      expect(treeManifest(b)).toEqual([
        { path: 'assets/two words.bin', sha256: sha256(Buffer.from('second payload asset')) },
        { path: 'docs/only doc.txt', sha256: sha256(synthDoc) },
        { path: 'pack.json', sha256: sha256(PACK_JSON_STUB) },
      ]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }

    // Both parent-owned workspaces are GONE after the two successes.
    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]).toBeDefined();
    expect(workspaces[1]).toBeDefined();
    expect(workspaces[0], 'concurrent calls must get DISTINCT workspaces').not.toBe(workspaces[1]);
    for (const work of workspaces) {
      expect(fs.existsSync(work as string), `the workspace ${work} must be cleaned`).toBe(false);
    }
  }, 300_000);
});
