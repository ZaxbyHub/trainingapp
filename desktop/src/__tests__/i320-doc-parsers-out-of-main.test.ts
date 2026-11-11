// i320-doc-parsers-out-of-main.test.ts — FROZEN ACCEPTANCE SPEC (issue #320
// AC1 / check C1, trace 320-269-parse-isolation-chat-integrity), authored by
// the issue-tracer ARM'S-LENGTH CHECK AUTHOR at base 5d1f7338, before any fix.
//
// It finishes the #319 defect class: every untrusted .docx / .pptx / .pdf
// parse AND the .docx/.pptx zip-bomb cap must leave the privileged Electron
// main process and run in a child OS process behind the registered launcher
// seam (the #289 GPU-probe / #319 workbook-parser pattern), so a poisoned or
// hanging document can crash or wedge only the child.
//
// RED AT BASE (5d1f7338): this file statically imports
// desktop/main/backend/ingest/doc-worker.js and doc-worker-child.js, which do
// not exist until the fix lands — the whole file fails to load with an
// import-resolution error, which IS the acceptance evidence for the missing
// isolation surface. The source-only legs (S1, S2, S8 source pin) also fail
// at base on their own content pins (extractors.ts still loads mammoth, jszip
// and pdfjs-dist and still defines the parent-side assertZipWithinCap).
//
// KNOWN CONFLICT (not this spec's to resolve): the frozen #319 spec
// i289-xlsx-parse-isolation.test.ts T10 asserts the PRE-#320 end state (a
// parent ZIP_EXTENSIONS set covering '.docx'/'.pptx' and an
// `assertZipWithinCap` mention in extractors.ts). S2 here pins the #320 end
// state (no parent-side zip cap for any format). The implementer owns that
// reconciliation; this file pins only the #320 end state.
//
// AMENDED 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Required Revisions 1 and 5; only this spec file
// changed, no production code). Amendments:
//   (a) Critic rev 5 — the S1 jszip guard is now GENUINELY directory-wide:
//       it scans ALL of desktop/main and asserts an EXACT set equality over
//       { backend/ingest/doc-worker-child.ts, backend/ingest/
//       xlsx-worker-child.ts, backend/packs/pack-extract.ts }, where
//       pack-extract.ts is an explicitly NAMED RESIDUAL for issue #320 AC3
//       (maintainer decision pending: pack zip extraction precedes Ed25519
//       verification and the signature gate is default-off). Any NEW jszip
//       site anywhere in desktop/main fails the leg. (SUPERSEDED on the
//       pack-extract.ts member by the AC_CHANGED_BY_USER amendment of
//       2026-11-09 below — the member is now the PLANNED
//       backend/packs/pack-extract-child.ts.)
//   (b) The load-form patterns (and their S1 self-test) now cover whitespace
//       variants (`import ( 'jszip' )`, `require ( "mammoth" )`,
//       `from"jszip"`), a dynamic import carrying a second argument
//       (`import('pdfjs-dist/legacy/build/pdf.mjs', { with: {...} })`), count
//       `export ... from` re-exports as loads, and do NOT count
//       `import type` / `export type` (type-only, elided at compile time).
//   (c) New computed-specifier leg: every dynamic `import(` / `require(` in
//       desktop/main must carry a WHOLE string-literal first argument except
//       a named allowlist (empty at base 5d1f7338 — see its comment), so a
//       computed load of a parser library cannot slip past the literal scan.
//   (d) Critic rev 1 — S4 report validation: a report whose `text` is not a
//       string, whose `pages` is not an array, or whose any `pages[i]` lacks
//       a numeric `pageNumber` / string `text` is REJECTED with the
//       `doc worker:` prefix (never adopted); a valid {ok:true,text,pages}
//       is adopted with pages intact.
//   (e) Critic rev 1 — S3 routing: the PUBLIC extractDocumentFromFile must
//       forward `timeoutMs` and `childPath` for .docx, .pptx AND .pdf, and
//       .pdf never receives a cap argument even when maxZipBytes is passed.
//
// AMENDED (round 2) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 2 Required Revision 3 — plan Revision 3 R5' and
// R1'; again ONLY this spec file changed, no production code). Amendments:
//   (f) R5' — escape-coded-specifier bypass CLOSED. The critic executed
//       `const z = require('\x6a\x73\x7a\x69\x70'); await z.loadAsync(bytes)`:
//       JavaScript cooks string escapes before module resolution, so that
//       require loads jszip, yet it passed amendment (c) as a "whole string
//       literal" while every literal-matching scan (load forms, the JSZip
//       call pattern) missed it. The computed-specifier leg now treats any
//       dynamic import(/require( whose string-literal argument CONTAINS A
//       BACKSLASH as COMPUTED (flagged unless allowlisted), and also flags a
//       static `import ... from '<spec>'` / `export ... from '<spec>'` whose
//       specifier is escape-bearing. The allowlist stays EXACTLY what the
//       base tree produces under the amended scan — still EMPTY
//       (re-verified against 5d1f7338 by repro/scan-selfcheck-v2.mjs).
//   (g) R1' — the S4 malformed-report matrix adds `pageNumber: NaN` and
//       `pageNumber: Infinity`. Both are valid structured-clone numeric
//       values, so a REAL report carries them across IPC intact (this
//       spec's fake seam emits report objects directly, which is faithful
//       for them); the runner must REJECT both with the `doc worker:`
//       prefix — finiteness is checked with Number.isFinite, never with
//       `typeof === 'number'`.
//
// AMENDED (round 3) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 3 Required Revision 2 — plan Revision 4 R5'';
// again ONLY this spec file changed, no production code). Amendment:
//   (h) R5'' — the S1 scan is now an AST INVENTORY, not regexes. The critic
//       executed four loads the regex machinery of (b)/(c)/(f) could not see
//       (repro/critic-round3-scan-probe.mjs): direct
//       `createRequire(import.meta.url)('jszip')` (it returned the exact
//       installed jszip module), an aliased createRequire call,
//       `module['require']('jszip')`, and an escape-coded side-effect
//       import. Every desktop/main source file (all SOURCE_EXTENSIONS, a
//       ScriptKind per extension) is parsed with the TypeScript compiler API
//       (`typescript`, a desktop devDependency) and EVERY runtime load site
//       is inventoried: import/export-from declarations (type-only excluded,
//       side-effect imports included), dynamic import(), `import x =
//       require()`, and calls of `require`, `module.require` / `.require` on
//       any receiver, `module['require']`, `module[key]`, a createRequire(...)
//       result called directly, and any same-file identifier bound to a
//       require function (createRequire result or require alias, closed
//       transitively; createRequire itself may arrive renamed). The
//       specifier is the AST's COOKED string value (hex/unicode escapes,
//       no-substitution templates and String.raw all resolved), so an
//       escape-coded literal is judged on the module it really loads; any
//       non-static specifier is COMPUTED. The S1 legs assert exact FILE sets
//       on the cooked specifiers (mammoth / pdfjs-dist / jszip, any subpath,
//       also via a node_modules path, case-insensitive) — the sanctioned sets
//       are UNCHANGED — and the computed leg asserts exact equality with an
//       allowlist RE-CAPTURED at base 5d1f7338 with the inventory: still [].
//       A secondary TEXTUAL guard on the parse entry points (`loadAsync(`,
//       `extractRawText(`, `getDocument(` — method name only, so aliased
//       handles match) backs the inventory up for handles that reach a file
//       without a load site. The self-tests run the inventory on every
//       critic counterexample (all probe rows verbatim) plus every round-1/2
//       row, each pinned to its exact {form, specifier|COMPUTED}. Amendments
//       (b), (c) and (f) are SUPERSEDED by (h); their sanctioned file sets
//       and the empty allowlist carry over.
//
// AMENDED (round 4) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 4 Critical finding "C1 still has reachable,
// undisclosed loader and parser-call bypasses" / Required Revision 1 — plan
// Revision 5 R5'''; again ONLY this spec file changed, no production code).
// The critic EXECUTED ordinary loader forms past the (h) load inventory
// (which only visits CallExpression load invocations): `new require('jszip')`,
// `require.call/apply/bind`, split-assignment aliases,
// `Module['createRequire'](...)`, `Module._load('jszip', ...)`, and require
// passed as a callback (`['jszip'].map(require)`) — each returning the
// CANONICAL installed jszip module — plus `z['loadAsync'](bytes)`,
// `z?.loadAsync?.(bytes)` and comment-separated calls past the round-3
// TEXTUAL call guard. Enumerating shapes cannot terminate, so amendment:
//   (i) R5''' — a FAIL-CLOSED LOADER-CAPABILITY REFERENCE WALK, layered on
//       top of the (h) load inventory (which is KEPT: it yields the literal
//       specifiers the allowed-file-set legs judge). For every desktop/main
//       source file the walk visits EVERY runtime (non-type-position)
//       reference to a loader CAPABILITY: the identifiers `require` and
//       `module` (lexical shadowing respected where cheap — a local parameter
//       named `module` is not the CJS module; an unresolvable reference is
//       FLAGGED, never excused); any binding imported from 'module' /
//       'node:module' (only a NAMED `createRequire` import — any rename — is
//       a recognised origin); any binding derived from a createRequire(...)
//       result through tracked aliases; and any property or element access
//       named `require`, `createRequire` or `_load` on ANY receiver
//       (`process.mainModule.require`, `globalThis['require']`, `Module._load`).
//       RECOGNISED uses, not flagged: a DIRECT call (dot, literal element,
//       optional, bare identifier or createRequire-result callee) whose first
//       argument is a STATIC string literal — the load inventory already
//       judged its COOKED specifier (a direct call with a computed/missing
//       argument is flagged here as well; the computed-specifier leg gates it
//       too); `require.resolve(...)` / `.resolve` on a require function; and
//       a declaration binding of a createRequire(...) result or a tracked
//       alias of one (the five base files' pattern — every later reference to
//       such a binding is policed by this same walk, so "only ever directly
//       called (or .resolve'd)" is enforced per reference). `typeof require` /
//       `typeof module` guards would be recognised ONLY if present at base —
//       the round-4 re-capture found NONE, so the form is flagged. Everything
//       else is an UNRECOGNISED LOADER USE: `new require(...)`,
//       `.call/.apply/.bind`, declaration/assignment aliases of an ambient
//       require, passing a loader (require or a createRequire result) as a
//       value or callback, member or computed-member createRequire,
//       `Module._load`, a destructure keyed `createRequire` (the recognised
//       origin is the NAMED IMPORT only), an import of the module package
//       other than named createRequire (default, namespace, other-named,
//       import-equals, re-export), and any non-shadowed value use of `module`.
//       New S1 leg: the set of unrecognised uses across desktop/main must
//       EXACTLY equal UNRECOGNISED_LOADER_USE_ALLOWLIST — captured at base
//       5d1f7338 by repro/scan-selfcheck-v2.mjs (spec-logic extraction +
//       independent mirror, lockstep-asserted). The base tree needs ZERO
//       allowlist entries: the only loader capabilities in desktop/main are
//       the five `import { createRequire } from 'node:module'` imports
//       (update-checker.ts, backend/store/{backup,recovery,sqlite-store,
//       pack-manager}.ts) whose results are bound once and only ever directly
//       called with literal specifiers. The walk is deliberately NOT widened
//       to make any future site disappear; a new unrecognised use must join
//       the allowlist with a file, a stable fragment and a one-line reason.
//   (j) R5''' — the round-3 secondary TEXTUAL call guard (amendment (h)'s
//       `/\bloadAsync\s*\(/`-style regexes) is REPLACED by AST recognition of
//       `.loadAsync(`, `.extractRawText(`, `getDocument(` in dot
//       (`z.loadAsync(...)`), literal element-access (`z['loadAsync'](...)`),
//       optional (`z?.loadAsync?.(...)`, `z?.['loadAsync']?.(...)`) and bare
//       (`loadAsync(...)`, which the old regex also caught) call forms; a
//       comment separating receiver and method (`z /* x */ .loadAsync(b)`)
//       is invisible to text but plain syntax to the AST. Cooked (escape-
//       decoded) element keys match. Same allowed FILE SETS as before.
//
// AMENDED (round 5) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 5 — two Critical findings and one Important
// finding, Required Revisions 1-3 — plan Revision 6 INV-1..INV-3; again ONLY
// this spec file changed, no production code). The critic EXECUTED three
// ordinary gaps past (h)/(i)/(j): a factory `function loader(){ return
// createRequire(import.meta.url); } loader()('jszip')` and a direct callback
// `['jszip'].map(createRequire(import.meta.url))` (the factory returned the
// canonical installed jszip); a new main module importing and calling the
// child's exported `runDocChildMain` (the child's dynamic parser imports then
// run IN THE CALLER'S PROCESS while every file-local set stays unchanged); and
// `const load = z.loadAsync; load(bytes)` / `z.loadAsync.call(z, bytes)` (zero
// parser-call sites). Each is closed by ONE class-level invariant, not by
// another enumerated shape:
//   (k) INV-1, PROCESS BOUNDARY. A parse-child module
//       (backend/ingest/doc-worker-child.ts, backend/ingest/
//       xlsx-worker-child.ts) is a process entry point, never a library. Every
//       runtime module edge in desktop/main — static import, re-export,
//       import-equals, and every call-form load the (h) inventory finds
//       (dynamic import(), require, require aliases, createRequire results,
//       member require) — is RESOLVED to a main-relative module (relative
//       specifiers against the importer; absolute paths and file: URLs; the
//       extension ignored, so the repo's `./x.js` -> `x.ts` ESM mapping,
//       `./x`, `./x.ts` all name one module; case-insensitive; COOKED
//       specifier). The ONLY permitted edge into a child is its own runner
//       named-importing exactly its own error-prefix constant
//       (backend/ingest/xlsx-worker.ts <- XLSX_WORKER_ERROR_PREFIX, existing
//       at base, xlsx-worker.ts:28; backend/ingest/doc-worker.ts <-
//       DOC_WORKER_ERROR_PREFIX, planned). Every other edge is a finding: any
//       other importer, another or an extra binding (runDocChildMain /
//       runXlsxChildMain), namespace / default / side-effect imports,
//       re-exports, dynamic import(), require (any form), import-equals.
//       Type-only imports / re-exports stay permitted (elided); forking the
//       child BY PATH is not a module edge. Any wrapper or re-export must
//       itself import the child, so local wrappers are closed structurally.
//       New S1 leg: the finding set over desktop/main is EMPTY (no
//       allowlist) and the base xlsx prefix edge is resolved and permitted
//       (anti-vacuity). A computed-specifier load cannot be resolved; it
//       stays gated by the computed-specifier leg (empty allowlist).
//   (l) INV-2, createRequire RESULT POSITIONS. Recognising a createRequire(...)
//       call now depends on where its RESULT goes. Recognised positions: (a)
//       immediately invoked (`createRequire(u)('lit')`; a computed argument is
//       still `require(computed)`) or `.resolve`d (dot or literal
//       `['resolve']`); (b) the initializer of an Identifier-named `const` in a
//       plain, non-exported, non-`declare` variable statement, every later
//       reference to which is policed by the (i) walk and must be such a
//       direct literal call, a `.resolve`, or a `const` alias whose own
//       references satisfy this same rule, TRANSITIVELY (plan Revision 6
//       addendum, INV-2 clarification: `const r2 = r1` stays recognised and
//       r2's uses are policed exactly like r1's — equivalent in safety to
//       forbidding the alias, since every use still ends in a direct literal
//       call or `.resolve`; a `let`/`var`/exported alias is an escape). Every
//       other position of the
//       call is an UNRECOGNISED `createRequire-escape`: returned (factory),
//       passed as an argument or callback, a default parameter, a property /
//       array element / class field, a let/var/exported binding, spread,
//       destructured, a ternary arm, a discarded comma operand (reassignment is
//       the existing `assign-alias`). `export { req }` of a local capability
//       is a new `export-capability` finding. The five base sites
//       (update-checker.ts, backend/store/{backup,recovery,sqlite-store,
//       pack-manager}.ts) are const-bound and directly called with literals, so
//       UNRECOGNISED_LOADER_USE_ALLOWLIST stays EMPTY.
//   (m) INV-3, PARSER-ENTRY REFERENCES. The S1 parser guard now counts every
//       RUNTIME REFERENCE to loadAsync, extractRawText, convertToHtml,
//       convertToMarkdown and getDocument — property access (incl. optional
//       chains), literal-key element access (cooked), destructuring keys,
//       import/export specifiers, object/class member keys and any identifier
//       with that name — not only calls. Aliases, `.call/.apply/.bind` and a
//       module that exports a parser handle therefore all carry a reference
//       and fall under the SAME exact allowed file sets (extractRawText /
//       getDocument: the doc child only; loadAsync: the doc child, the xlsx
//       child and the planned pack child packs/pack-extract-child.ts — the
//       pack-extract.ts residual member was REPLACED by the
//       AC_CHANGED_BY_USER amendment of 2026-11-09; convertToHtml /
//       convertToMarkdown: nowhere but the doc child). TYPE positions are
//       excluded (type literals and their method / property signatures,
//       interfaces, type aliases, type queries, indexed access types,
//       type-only imports, ambient `declare`): at base the only non-call
//       mentions are the type-position casts at extractors.ts:63 / :113, so
//       the base reference sets equal the base call sets (no over-flag). The
//       (j) call guard and its legs are KEPT beside the reference legs.
//   Evidence: repro/scan-selfcheck-v2.mjs extracts these functions and row
//   tables verbatim, runs them in lockstep with an independent mirror over
//   all of desktop/main at base, replays every round-5 probe (each caught),
//   proves the runtime-loading ones canonical in a throwaway step, and runs a
//   VIRTUAL HEAD TREE of the planned production shape (doc child with the
//   three dynamic imports and entry-point calls; doc-worker.ts importing
//   DOC_WORKER_ERROR_PREFIX from './doc-worker-child.js' and forking the
//   child by path; extractors.ts importing extractDocOutOfProcess from
//   './doc-worker.js'): every layer green, every allowlist still empty.
//
// AMENDED (round 5 addendum) 2026-11-08 (recorded CHECK_WRONG raised by the
// check author itself before plan-critic round 6 — plan "Revision 6 addendum",
// INV-2 clarification + INV-4; again ONLY this spec file changed, no
// production code). The check author found that INV-1 polices module IMPORTS
// only: another main module could run a parse child in-process via
// `new Worker(path.join(dir, 'doc-worker-child.js'))` (worker_threads share the
// main address space) without any module edge into the child. Amendments:
//   (l') INV-2 clarification — the (l) wording above now states the transitive
//       const-alias rule the walk already implemented (no behaviour change).
//   (n) INV-4, LAUNCH SURFACE. Every launch of a parse child, in-process or
//       out-of-process, has to NAME it through one of three capabilities, and
//       each is confined: (a) a runtime string literal, no-substitution
//       template or template-literal quasi whose COOKED text contains a
//       parse-child basename (`doc-worker-child`, `xlsx-worker-child`;
//       case-insensitive) only in that child's own runner
//       (backend/ingest/doc-worker.ts / xlsx-worker.ts) and the child file
//       itself; (b) runtime references (identifiers, dot / optional /
//       literal-key element access, destructuring keys, import bindings,
//       re-exports, member keys — the INV-3 reference walk, generalised) to
//       `docWorkerChildPath` / `xlsxWorkerChildPath` only in their own runner;
//       (c) runtime references to `setDocWorkerForkFn` / `setXlsxWorkerForkFn`
//       only in their own runner and desktop/main/index.ts (the bootstrap
//       registration). Comments (not syntax) and TYPE positions (incl.
//       string-literal types) do not count. SPECIFIER CHOICE: the module
//       specifier of a static import / export-from declaration and of an
//       import-equals `require('...')` is EXCLUDED from (a), because INV-1
//       already judges every such edge — the permitted runner-prefix import
//       (xlsx-worker.ts:28) is therefore never double-reported; call-form load
//       arguments (`import('./doc-worker-child.js')`, `require(...)`) stay in
//       (a), a deliberate fail-closed overlap with INV-1 that can only
//       double-report an already-forbidden edge. New S1 leg: the INV-4 finding
//       set over desktop/main is EMPTY (no allowlist); anti-vacuity: the base
//       xlsx runner's two `path.join(here, 'xlsx-worker-child.{js,ts}')`
//       literals (xlsx-worker.ts:117 / :119) and the index.ts
//       `setXlsxWorkerForkFn` registration are seen and PERMITTED. Base
//       evidence (repro/scan-selfcheck-v2.mjs, spec extraction + independent
//       mirror in lockstep): finding set EMPTY at 5d1f7338; `worker_threads`
//       in retrieval/reranker.ts (`new Worker(this.workerPath)` for
//       rerank-worker.ts) names no parse child and is untouched. Contract
//       consequence (already implied by the frozen contract below): only the
//       doc runner resolves the default child path — extractors.ts forwards
//       `childPath` and never calls docWorkerChildPath itself.
//
// AMENDED (round 6) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 6 — two Critical findings (INV-4 and INV-3 do
// not close cross-module capability aliases) and one Important finding
// (virtual-head satisfiability is not class closure), Required Revisions 1-2
// — plan Revision 7 INV-5a/5b/5c and the stopping principle; again ONLY this
// spec file changed, no production code). The critic EXECUTED owner-exported
// capability aliases past every earlier layer: with the xlsx runner adding
// `export const parserWorkerPath = xlsxWorkerChildPath`, another main module
// imported `parserWorkerPath` and ran `new Worker(parserWorkerPath(), { argv:
// [workbook], stdout: true })` — the REAL xlsx child then parsed the parity
// workbook IN THE LAUNCHING OS PROCESS (worker_threads shares the address
// space, and the child's own process-entry guard fired because
// process.argv[1] is the worker filename) while the consumer produced ZERO
// INV-1, INV-4, loader-walk and parser-reference findings. The setter
// analogue `export const registerParserLauncher = setDocWorkerForkFn` let a
// consumer install a launcher with every finding set empty, and the
// pack-extract.ts owner (jszip-sanctioned only BEFORE the
// AC_CHANGED_BY_USER 2026-11-09 amendment) exporting `openZip =
// JSZip.loadAsync.bind(JSZip)` handed a working renamed parser to an
// unsanctioned ingest module (the renamed function really parsed a zip).
// INV-3/INV-4 confine NAMES inside files, so a rename crosses the module
// boundary invisibly; a name rule cannot close renames. INV-5 closes the
// world around the capability OWNERS instead:
//   (o) INV-5a, FROZEN EXPORT SURFACES. The owner set is COMPUTED at every
//       run: the seed owners { backend/ingest/xlsx-worker.ts,
//       backend/ingest/xlsx-worker-child.ts, backend/packs/pack-extract.ts }
//       plus the transitive closure of modules that RE-EXPORT an owner
//       binding (a re-export declaration — `export { x } from`, `export *`,
//       `export * as ns` — resolving to a current owner and handing out one
//       of its runtime names; type-only re-exports are elided and do not
//       taint). The closure captured at base 5d1f7338 is EXACTLY
//       { xlsx-worker.ts, xlsx-worker-child.ts, pack-extract.ts,
//       packs/zip-install.ts } (zip-install.ts re-exports 16 runtime
//       pack-extract bindings; nothing re-exports a zip-install binding).
//       Two PLANNED owners join at fix time: backend/ingest/doc-worker.ts
//       (runtime exports frozen to the doc-mirror of the xlsx runner's base
//       surface: DEFAULT_DOC_TIMEOUT_MS, nodeForkDocWorker,
//       setDocWorkerForkFn, resolveDocWorkerForkFn, docWorkerChildPath,
//       terminateDocWorkers, extractDocOutOfProcess) and
//       backend/ingest/doc-worker-child.ts (DOC_WORKER_ERROR_PREFIX,
//       runDocChildMain — the exact union this spec itself imports from the
//       child). For each owner the set of RUNTIME exported names — value
//       exports (const/let/var/function/class/enum/namespace/import-equals
//       and destructured const bindings), `export { }` lists, re-export
//       lists (`export ... from`, `export *`, `export * as ns`) and
//       `export default`; type/interface/type-alias exports and `type`-
//       marked specifiers EXCLUDED — must EXACTLY equal its frozen list.
//       Any new export of any form — an alias, a wrapper, a re-export —
//       fails. A planned owner that does not exist yet passes VACUOUSLY;
//       once the file exists the exact list is enforced ("absent OR exact").
//   (p) INV-5b, FROZEN IMPORT EDGES. For each owner, the set of (importer
//       file, imported binding) edges within desktop/main — static
//       named/default/namespace imports, re-exports, dynamic import(),
//       require (every call-form load the (h) inventory recognises), and
//       import-equals; type-only edges excluded, specifiers resolved with
//       the INV-1 path resolution (extension-agnostic, case-insensitive) —
//       must EXACTLY equal a frozen list captured at base PLUS the planned
//       Revision 7 edges (extractors.ts -> extractDocOutOfProcess, index.ts
//       -> setDocWorkerForkFn, backend/index.ts -> terminateDocWorkers,
//       doc-worker.ts -> DOC_WORKER_ERROR_PREFIX). The base capture includes
//       extractors.ts's dynamic import of './xlsx-worker.js' (binding *). A
//       NEW consumer of an existing export fails; a frozen edge disappearing
//       fails once its owner exists (a planned edge is excused only while
//       the planned owner file is absent). INV-1 becomes the child-specific
//       special case of this leg.
//   (q) INV-5c, CONFINED IN-PROCESS EXECUTION. Every load of
//       'worker_threads' / 'node:worker_threads' — any form the load
//       inventory recognises, including require and dynamic import — and
//       every `new Worker(` construction (bare, dot or literal-element
//       callee named Worker) is confined to EXACTLY
//       { backend/retrieval/reranker.ts, backend/retrieval/rerank-worker.ts }
//       (reranker.ts: the Worker import and construction; rerank-worker.ts:
//       the worker side, parentPort/workerData only). At base those two
//       files are the only sites. Out-of-process launch (child_process
//       fork/spawn, utilityProcess.fork) runs in a separate OS process and
//       is untouched. This closes same-process launching of a parse child
//       whatever name the path arrives under.
//
// AMENDED (round 7) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 7 — two Critical findings (INV-5a/5b omit LOCAL
// RENAMED RE-EXPORTS by already-permitted owner consumers; INV-5c leaves
// Worker-capability exports from the allowed reranker pair unconfined) and
// one Important finding (the stopping principle overclaims its static
// boundary) — plan Revision 8 SRC-1/SRC-2 and the two-source argument; again
// ONLY this spec file changed, no production code). The critic EXECUTED both
// escapes (repro/critic-round7-probes.mjs + .out): `export { extractPackZip
// as openPack };` added to packs/surface.ts (an already-permitted zip-install
// consumer) and `export { setXlsxWorkerForkFn as registerWorkbookLauncher };`
// added to index.ts handed consumers the capability with EVERY finding set
// empty — a LOCAL export list of an imported binding is neither a new INV-5b
// edge nor an `export ... from` closure taint; and `export { Worker };` in
// retrieval/reranker.ts plus `import { Worker as ParserWorker }` let a
// consumer construct an in-process worker under a name INV-5c does not know
// (the combined setter+Worker route ran the REAL compiled xlsx child to
// exit 0 INSIDE the launching OS process — launcher and main PID both
// 61708). Revision 8 closes the SOURCES, not the paths: a new in-main parse
// needs exactly one of (a) a parser library loaded into main — already
// confined by the load inventory, the loader walk and INV-1..INV-3 to the
// parse children (the doc and xlsx children, plus the planned pack child
// once the AC_CHANGED_BY_USER 2026-11-09 amendment below replaced the
// former named-AC3-residual member pack-extract.ts) — or (b)
// in-process execution of code that parses. (b) is closed at every source:
//   (r) SRC-1, IN-PROCESS EXECUTION CAPABILITIES, confined to exact base
//       sets (base evidence by grep at 5d1f7338, re-captured by
//       repro/scan-selfcheck-v2.mjs):
//       - the reranker pair JOINS the INV-5 owner world: backend/retrieval/
//         reranker.ts and backend/retrieval/rerank-worker.ts become SEED
//         owners with frozen runtime export surfaces (reranker.ts: the
//         8-name base list; rerank-worker.ts: EMPTY) and frozen importer
//         edges (reranker.ts: exactly ONE importer — backend/index.ts:47-54,
//         taking ResumableReranker, WorkerEmbedder, WorkerReranker and
//         resolveRerankerModelDir; rerank-worker.ts: NONE — it is only ever
//         spawned by path). `export { Worker as ParserWorker }` is now an
//         INV-5a export-added and its consumer an INV-5b edge-added.
//       - runtime references to the `workerPath` option key (property key,
//         property access, literal element access, shorthand, destructuring)
//         are confined to reranker.ts, so no other module can point
//         WorkerReranker — or ResumableReranker, which forwards the same
//         options object — at another script. The check author INSPECTED
//         WorkerEmbedder (reranker.ts:413): it takes an already-constructed
//         worker OBJECT (`{ embed(texts) }`) plus a modelId, NOT a
//         caller-supplied script path — there is NO second script-path key
//         in that file to confine. At base the key appears only in
//         reranker.ts:30 (the type-position interface member), :143 (the
//         private field), :152 (read + default) and :163 (the Worker
//         construction); the SRC-1 finding set is EMPTY at base.
//       - EMPTY-ALLOWED-SET rules across ALL of desktop/main, each verified
//         empty at base: any load of 'vm' / 'node:vm' (every form the load
//         inventory recognises); every RUNTIME reference to `eval` /
//         `Function` (the identifier in any value position — subsuming
//         eval(...), new Function(...), Function(...), the globalThis /
//         global / window / self literal-key member forms AND aliases such
//         as `const e = eval`); any reference to `process.dlopen` (dot or
//         literal element, receiver chain rooted at `process`); and any
//         member access named `_compile`, `_load`, `wrap`,
//         `_resolveFilename`, `_extensions`, `_cache` or `prototype` on a
//         binding imported from 'module' / 'node:module' (named, default,
//         namespace or import-equals, incl. same-file const aliases) or on
//         the unshadowed identifier `module` (the round-4 walk already
//         polices non-shadowed `module` VALUE uses and `_load`; this rule
//         adds the remaining CJS internals). eval / new Function move OUT
//         of the disclosed-residual list and become closed rules.
//         `Reflect.apply(fn, ...)` with a parser or loader fn needs NO new
//         rule: the fn operand is itself a reference the existing layers
//         flag (a parser-entry name — INV-3's reference walk — or a loader
//         capability passed as a value — the round-4 walk's `value` form);
//         only the NON-LITERAL computed key (`globalThis[k](...)`,
//         `Reflect.apply(globalThis[k], ...)`) remains residual.
//   (s) SRC-2, NO LAUNDERING BY PERMITTED CONSUMERS. For every runtime
//       module edge (importer M, owner O, binding B) — the INV-5b world,
//       computed from the tree, frozen and planned alike — M may not
//       runtime-export B under ANY name: `export { B as x }`, `export { B }`,
//       `export const/let/var x = B` (a direct alias through `as` casts and
//       parens included), `export default B`, a destructured or member
//       binding of an owner namespace (`export const x = ns.cap`), and
//       `export *` / `export * as ns` / `export { ... } from` an owner.
//       export-from of an owner in a file that ALREADY holds the same
//       (file, binding) edge is deliberately flagged TOO: INV-5b is blind
//       there (extractors.ts's frozen dynamic-import '*' edge, surface.ts's
//       frozen extractPackZip edge), so only SRC-2 catches it. Owners are
//       exempt — their surfaces are INV-5a's frozen lists, so zip-install's
//       sanctioned pack-extract re-exports are NOT double-flagged — and
//       type-only exports are exempt (elided). A hand-written WRAPPER export
//       (a function — or object literal — that CALLS the capability) is
//       deliberately not flagged: it can only re-expose an out-of-process
//       runner (the parse stays in a child OS process), a pack-extract.ts
//       function (before the AC_CHANGED_BY_USER 2026-11-09 amendment this
//       was the already-disclosed AC3 residual bounded by it; after it
//       pack-extract.ts itself only bridges to the pack runner, so the
//       wrapper's parse also stays in a child OS process), or
//       launch control whose only in-process route runs through an
//       execution source. ROUND 8 showed that last leg was FALSE under
//       Revision 8 (a launch-control wrapper in index.ts installed a
//       process.getBuiltinModule Worker into the REAL runner with zero
//       findings); it holds again only because amendment (t) closes those
//       sources (SRC-3 / SRC-4 below), not by the three-way argument itself.
//       No base consumer re-exports an owner binding (backend/index.ts's
//       local `export { resolveBackendMode, resolveNodeEngine };` names
//       NON-owner bindings from types.js / llama-engine.js), so the SRC-2
//       finding set is EMPTY at base and at the planned head; both round-7
//       local-re-export probes fail on it, and the Worker probes fail on
//       the (r) owner addition.
//
// AMENDED (round 8) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 8 — two Critical findings (SRC-1 omits
// `process.getBuiltinModule`; inspector Runtime.evaluate is an independent
// unclosed evaluator) and one Important finding (the shared-state rationale
// overclaims the three-way bound), Required Revisions 1-3 — plan Revision 9
// SRC-3/SRC-4/SRC-5, the rationale correction and the Electron API review;
// again ONLY this spec file changed, no production code). The critic
// EXECUTED (repro/critic-round8-probes.mjs + .out): `process.getBuiltinModule(
// 'node:worker_threads').Worker` renamed `ParserThread` (zero findings in all
// 12 layers; installed by a hand-written wrapper in the permitted index.ts it
// ran the REAL compiled xlsx child to exit 0 in the launching PID 48268); an
// inspector `Session` issuing `Runtime.evaluate` (the parser load and entry
// call live in the expression STRING; canonical jszip parsed a real archive
// in the evaluating PID 6088); and getBuiltinModule('node:vm') (same real
// parse, PID 23544). Revision 9 stops discovering sources one at a time:
//   (t) SRC-3, COMPLETE BUILT-IN CLASSIFICATION. BUILTIN_MODULE_CLASSIFICATION
//       is keyed by EVERY entry of require('node:module').builtinModules of
//       the running Node — vitest 3.2.7 runs on Node v24.16.0: 72 entries;
//       Electron 45.2.1 (Node 24.22.1) lists 74, the extra `original-fs` /
//       `original-fs/promises` living in ELECTRON_ONLY_BUILTIN_CLASSIFICATION
//       (the plan said "72 entries on Node 24 / Electron 45": Electron has
//       74). A self-test asserts key-set EQUALITY at test time, so a new
//       built-in fails C1 until classified. Each entry is IN-PROCESS-EXEC
//       (runs JS / wasm / native code in THIS process from a string, file or
//       binary), OUT-OF-PROCESS or INERT, with a one-line reason researched
//       per entry on both runtimes. IN-PROCESS-EXEC = { inspector,
//       inspector/promises, module, node:sqlite, node:test, process, repl,
//       v8, vm, wasi, worker_threads }; OUT-OF-PROCESS = { child_process,
//       cluster } (+ Electron utilityProcess, not a built-in). DISAGREEMENTS
//       with the plan's expected list, by the check author's research:
//       `process` is ADDED (the node:process module IS the process object —
//       default === process — and its named exports carry dlopen /
//       getBuiltinModule / binding / _linkedBinding / execve, verified on both
//       runtimes); `node:test/reporters` is INERT, not IN-PROCESS-EXEC (its
//       dot/junit/spec/tap/lcov exports transform test-event streams and load
//       nothing). Researched and kept INERT: diagnostics_channel / async_hooks
//       / perf_hooks / domain (caller-supplied handlers only; module-load
//       tracing reports loads, a captured export is the disclosed shared-state
//       residual), readline (completers are caller functions), http/https/
//       http2 (custom agents are caller code), timers (Node rejects string
//       callbacks, verified), util (no evaluator member). crypto / tls (and
//       the _tls_* / https / http2 surfaces) stay INERT as MODULES, but their
//       member-level OpenSSL engine loads (crypto.setEngine, the
//       privateKeyEngine / clientCertEngine options — a dlopen under plain Node
//       24 / OpenSSL 3.5.6, verified; refused by Electron 45's BoringSSL) are
//       confined by SRC-5 below. Normalisation: a 'node:'-prefixed spelling of
//       an unprefixed key maps to it; the 'node:'-only built-ins (sea, sqlite,
//       test, test/reporters) match ONLY with the prefix (`require('sqlite')`
//       is a userland package — module.isBuiltin('sqlite') === false).
//       CONFINEMENT: every IN-PROCESS-EXEC built-in reached by ANY route the
//       load inventory recognises (import / export-from / import-equals /
//       import() / require and every alias or member form) or through
//       getBuiltinModule('<id>') on any receiver (the SRC-4 route; a COMPUTED
//       argument counts) is allowed ONLY in: worker_threads — the reranker
//       pair (INV-5c); module — a static named `import { createRequire }` of
//       the module package (INV-2's recognised origin; any other module-package
//       load is also a loader-walk finding); every other one — NOWHERE.
//       Check-author additions to the same SRC-3 finding set (each EMPTY at
//       base, recorded for the critic): a load whose COOKED specifier is a
//       `data:` URL (the ESM loader EVALUATES the URL's source text, invisible
//       to the outer AST — `import('data:text/javascript,...')` executed in the
//       importing PID on both runtimes); runtime references to the
//       `WebAssembly` global (compiles and runs wasm in this process without
//       any built-in load; wasi alone would be an inconsistent half-rule); and
//       a function's `constructor` member / reflective 'constructor' key
//       (`(() => {}).constructor` IS Function and
//       `Object.getPrototypeOf(async () => {}).constructor` is AsyncFunction —
//       both evaluate a string, verified — so without it SRC-1's "every
//       runtime reference to Function" would be reachable without the name;
//       `.constructor.name` reads and ===/!== comparisons are not flagged).
//       New S1 leg: the SRC-3 finding set over desktop/main is EMPTY;
//       anti-vacuity: the permitted set is exactly the reranker pair's two
//       worker_threads imports and the five base named createRequire imports.
//   (t') SRC-4, BUILT-IN ACCESS APIs ARE LOADER CAPABILITIES. Every runtime
//       reference to `getBuiltinModule`, `binding`, `_linkedBinding` or
//       `internalBinding` — NAME-BASED on every receiver (stronger than
//       receiver tracking: `process.x`, `globalThis.process.x`, any alias
//       `p.x`, literal-element and optional members, destructuring keys such
//       as `const { getBuiltinModule } = process`, the named import
//       `import { getBuiltinModule } from 'node:process'`, object keys and bare
//       identifiers) — is an UNRECOGNISED loader use (`builtin-access`) under
//       the EMPTY UNRECOGNISED_LOADER_USE_ALLOWLIST. Check-author additions,
//       EMPTY at base: `execve` (replaces the process image with an arbitrary
//       binary under the SAME PID — present on Node 24.16 and Electron
//       45.2.1), `_debugProcess` / `_debugEnd` (activate / end the V8
//       inspector in a target PID, the current one included, without loading
//       node:inspector — present on Electron's main-process `process`).
//       `process.mainModule` is NOT added: the desktop/main entry is ESM, where
//       it is undefined (verified), and the frozen round-4 walk row pins
//       `process.mainModule.require('<literal>')` as a recognised member load
//       judged by the load inventory. Only
//       a NON-LITERAL computed key (`process[k]`) evades it — the disclosed
//       computed-key residual.
//   (t'') SRC-5, NATIVE-EXTENSION LOADS. Runtime references to
//       `loadExtension` are confined to the EXACT base sites
//       (SRC5_ALLOWED_SITES, one site per entry):
//       backend/store/sqlite-store.ts:206 and backend/store/pack-manager.ts:1300,
//       both `db.loadExtension(unpackAsarPath(<sqlite-vec>.getLoadablePath()))`
//       (better-sqlite3; the `loadExtension(path: string): void` members at
//       sqlite-store.ts:77 / pack-manager.ts:70 are type positions). The name
//       also covers node:sqlite and Electron's session.loadExtension
//       (conservatively). Check-author additions, EMPTY at base: `setEngine`,
//       `privateKeyEngine`, `clientCertEngine` (OpenSSL engine loads, above).
//       `process.dlopen` stays an SRC-1 empty rule.
//   SHARED-STATE RATIONALE, CORRECTED (round-8 finding 3). The Revision 8
//   claim that shared-state transfer "can only move AC3-residual or
//   out-of-process capabilities" by the three-way argument is WITHDRAWN:
//   backend/retrieval/reranker.ts owns `Worker`, so shared mutable state
//   (assignment onto globalThis/global/process, mutation of a passed-in object,
//   callback registration) can move ANY capability — an in-process Worker
//   included — out of an owner. It stays a DISCLOSED DATA-FLOW RESIDUAL on the
//   honest ground that this static guard does no inter-procedural data-flow
//   analysis, and that careless code does not stash an execution capability on
//   a global or a passed-in object in order to launch a parser; the behavioural
//   legs and the real-Electron different-PID harness are what pin the runners'
//   actual process boundary.
//   ELECTRON MAIN-PROCESS API REVIEW (recorded so round 9 can challenge it;
//   enumerated by running a throwaway Electron 45.2.1 main script over the
//   `electron` module exports, the session / webContents / app prototypes and
//   the main-process `process`). `webContents.executeJavaScript` /
//   `executeJavaScriptInIsolatedWorld`, `webFrameMain.executeJavaScript`,
//   `webContents.debugger` (CDP Runtime.evaluate), `session.setPreloads` /
//   `registerPreloadScript` and a BrowserWindow with `nodeIntegration` all run
//   code in RENDERER processes (separate OS processes; this app's windows are
//   contextIsolation/sandbox on, nodeIntegration off — index.ts:154-157);
//   `session.loadExtension` loads a Chrome extension whose scripts run in
//   extension renderers (its name is SRC-5-confined anyway); `utilityProcess`
//   and `ServiceWorkerMain` are out-of-process. No `electron` export evaluates
//   code in the MAIN process. The main-process `process` additions that CAN
//   (`_linkedBinding`, `_debugProcess`, `_debugEnd`) are SRC-4 names.
//   (Observation, not a code-exec source: nativeImage decodes untrusted images
//   in main — a Class-A sweep item for the Phase 4.2 disposition.)
//
// AMENDED (round 8 addendum) 2026-11-08 (recorded CHECK_WRONG raised by the
// check author itself while implementing Revision 9 — the plan's "Revision 9
// update" adopts the author's corrections/additions (the 74-entry Electron
// built-in count, process as IN-PROCESS-EXEC, node:test/reporters as INERT,
// the data: URL / WebAssembly / function-constructor / execve / _debugProcess
// additions, all already implemented above) and adds SRC-6 for the gap the
// author reported: C1 polices the three libraries #320 NAMES (mammoth /
// jszip / pdfjs-dist, plus xlsx via #319), so a DIFFERENT third-party parser
// library loaded into main would pass every rule. Again ONLY this spec file
// changed, no production code. Amendment:
//   (u) SRC-6, FROZEN THIRD-PARTY PACKAGE INVENTORY. The set of third-party
//       package names loaded anywhere in desktop/main — every route the (h)
//       load inventory recognises (static import / export-from / side-effect
//       import, dynamic import(), require and its recognised alias / member /
//       createRequire forms, import-equals), specifiers COOKED, relative /
//       absolute / file: / data: / # specifiers and Node builtins excluded
//       (getBuiltinModule is builtins-only, already SRC-4-confined),
//       normalised to the package name — scope kept, subpath dropped,
//       node_modules paths unwrapped, case-folded (`pdfjs-dist/legacy/build/
//       pdf.mjs` -> pdfjs-dist, `ajv/dist/2020` -> ajv) — must EXACTLY equal
//       THIRD_PARTY_PACKAGE_CLASSIFICATION, captured at base 5d1f7338 (11
//       entries). A load of an unclassified package is an UNCLASSIFIED
//       finding — a new parser or any other package FAILS C1 until someone
//       classifies it, the same completeness mechanism SRC-3 applies to
//       builtins, applied to npm. A table entry nothing loads is a REMOVED
//       finding — it fails until the table is pruned, which is a deliberate
//       frozen-list edit recorded in the amendment log (base capture: nothing
//       to prune; the base set EQUALS the table keys). Each PARSER entry —
//       jszip, mammoth, pdfjs-dist, and xlsx, which IS loaded in desktop/main
//       (backend/ingest/xlsx-worker-child.ts, checked) — is allowed ONLY in
//       the exact file set the existing rules assign (the S1 legs above; xlsx
//       reuses the frozen #289 T1 assignment, cross-checked by the SRC-6
//       self-test, not a second source of truth); a load anywhere else is a
//       PARSER-OUTSIDE-ALLOWED finding, a deliberate fail-closed overlap with
//       the jszip / mammoth / pdfjs-dist legs. NON-PARSER entries carry a
//       one-line reason; the untrusted-binary decode surfaces the honest
//       reasons disclose (better-sqlite3's read-only PREBUILT PACK indexes —
//       the signed-AC3 surface, not #320 user documents; node-llama-cpp's
//       GGUF decode of app-downloaded models; @huggingface/transformers'
//       repo-staged tokenizer/ONNX artifacts; electron's nativeImage) are
//       recorded as Phase 4.2 Class-A sweep neighbours, NOT #320 document
//       parsers — no package beyond the plan's expected four is classified
//       PARSER. Anti-vacuity: the base set is non-empty and contains electron
//       and the native addons better-sqlite3 / sqlite-vec / node-llama-cpp.
//       `electron` is NON-PARSER with the header-note (t) main-process API
//       review as its reason. A COMPUTED load specifier names no package (the
//       computed-specifier leg, empty allowlist, already forces every load to
//       a static literal). A dependency already listed NON-PARSER that
//       secretly parses untrusted bytes is a classification error caught by
//       review — disclosed residual: "misclassified existing dependency".
//
// AMENDED (round 9) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 9 — two Critical module-RESOLUTION findings
// (every static layer consumes only the MAIN_DIR file list, so a main source
// can import a NEW local wrapper OUTSIDE that root which TypeScript compiles
// and Node/Electron executes in the main process; and packageNameOf silently
// discarded every '#' specifier, which Node package.json `imports` aliases
// can map to external parser packages) — Required Revisions 1-2 — plan
// Revision 10 SRC-7/SRC-8; again ONLY this spec file changed, no production
// code). The critic EXECUTED both routes (repro/critic-round9-probes.mjs +
// .out): a main module importing '../shared/workbook-parser.js' (an UNSCANNED
// wrapper outside desktop/main) had ZERO findings in every one of the 15
// layers while a real TypeScript program emitted both dist/main/probe.js and
// dist/shared/workbook-parser.js with zero diagnostics and the wrapper parsed
// the CANONICAL installed xlsx IN THE MAIN PID on Node 24.16,
// Electron-as-Node and a real Electron 45.2.1 main process; and with
// "imports": {"#workbook": "xlsx"} in desktop/package.json, ordinary
// `import * as XLSX from '#workbook'` (also the require and new-package
// forms) resolved to file:///E:/ZCode/trainingapp/desktop/node_modules/xlsx/
// xlsx.mjs and parsed a real workbook in-process with ZERO findings
// (nodejs.org/api/packages.html#imports: unlike `exports`, `imports` permits
// mapping to external packages). Amendments:
//   (v) SRC-7, PRIVILEGED-GRAPH BOUNDARY. Every module edge of a
//       desktop/main source file — a relative ('./x', '../x', '.', '..'),
//       absolute (POSIX '/' or drive 'E:/') or file: URL specifier, by EVERY
//       route the (h) load inventory recognises (static import /
//       export-from / side-effect import, dynamic import(), require and its
//       recognised alias / member / createRequire forms, import-equals) —
//       must resolve INSIDE desktop/main: path.resolve against the importing
//       file's directory (file: URLs via fileURLToPath), containment compared
//       case-insensitively (Windows). Only the DIRECTORY matters, so the
//       repo's `./x.js` -> `x.ts` extension mapping is irrelevant here; a
//       specifier resolving exactly to desktop/main's parent ('..' /
//       '../...' — and an absolute or file: URL outside the root) is
//       OUTSIDE. Any edge resolving outside desktop/main is a finding with
//       an EMPTY allowed set. The guard's scan domain then EQUALS the set of
//       local modules main can execute, so every other layer's file
//       enumeration is complete by construction. Bare specifiers stay
//       governed by SRC-6 (packages) and SRC-3 (builtins); '#' specifiers
//       are SRC-8's. Base 5d1f7338 and the planned head both have ZERO
//       escapes (re-captured by repro/scan-selfcheck-v2.mjs).
//   (w) SRC-8, PACKAGE-IMPORT ALIASES. Any COOKED load specifier beginning
//       '#' (a Node package.json `imports` alias, which can map to ANY
//       external package or local file) is a finding with an EMPTY allowed
//       set, on EVERY load route. packageNameOf no longer silently discards
//       '#': it returns the alias name ('#workbook' -> '#workbook',
//       subpath dropped), so a '#' load ALSO surfaces UNCLASSIFIED under
//       SRC-6 until someone classifies it — but classification can NEVER
//       excuse the load, because the SRC-8 finding is at the LoadSite level.
//       desktop/package.json must carry NO `imports` field at all (a direct
//       assertion in the SRC-8 leg). Base and planned head both have ZERO
//       '#' specifiers.
//   TSCONFIG PATHS (recorded so round 10 can challenge it): no desktop
//   tsconfig defines `paths` or `baseUrl` — desktop/tsconfig.json, and
//   tsconfig.test.json / tsconfig.preload.json / tsconfig.e2e.json, which all
//   extend it (checked at 5d1f7338) — and tsc does not rewrite path aliases at
//   emit, so a `paths`
//   alias could not resolve at runtime without a bundler or loader (none
//   configured for desktop/main). If a future change adds `paths`, the bare
//   alias would still surface as an UNCLASSIFIED package under SRC-6. The
//   disclosed-residual list below is UNCHANGED: both round-9 routes are
//   ordinary static module resolution, are CLOSED by (v)/(w), and are NOT
//   added to the residuals.
//
// AMENDED (round 10) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 10 — two Critical findings (SRC-7 checks only the
// LEXICAL specifier path, not the module file Node actually resolves after
// CommonJS LOAD_AS_DIRECTORY and filesystem-link traversal; native addon
// loading remains an open execution source — better-sqlite3's public
// `nativeBinding` option loads an arbitrary .node path and require loads a
// relative `.node` file directly, neither visible to SRC-5/SRC-6) and one
// Important finding (the residual list cannot absorb these ordinary
// documented runtime routes) — Required Revisions 1-3 — plan Revision 11
// SRC-7'/SRC-9; again ONLY this spec file changed, no production code). The
// critic EXECUTED all four routes (repro/critic-round10-probes.mjs + .out):
// `require('./container')` with `main/container/package.json` `main:
// '../../shared/workbook-parser.cjs'` resolved the wrapper OUTSIDE main and
// parsed canonical xlsx in the consumer PID on Node, Electron-as-Node and a
// real Electron 45.2.1 main process (PID 43748); a directory junction
// (`main/linked` -> external `shared`, imported as
// './linked/workbook-parser.cjs') did the same (real Electron main PID 57004)
// while the walk listed only probe.cjs — the junction is neither
// isDirectory() nor isFile() to the Dirent walk; `new Database(':memory:',
// { nativeBinding })` selected the canonical better-sqlite3 .node file and
// executed native SQL in the calling PID on both runtimes; a recognised
// createRequire result calling `require('./native-parser.node')` likewise
// executed native SQL with ZERO findings in all 17 layers. BASE FACTS at
// 5d1f7338 (re-verified for this amendment): no `.node` specifier in ANY
// desktop/main source, no `nativeBinding` reference, no directory import
// (no relative load edge resolves to a directory), and no symlink/junction
// anywhere under desktop/main — both closures therefore start from EMPTY
// sets. Amendments:
//   (x) SRC-7', ACTUAL RESOLUTION (upgrades SRC-7 from lexical containment
//       to what Node loads). For every LOCAL module edge (relative /
//       absolute POSIX-or-drive / file: URL, by every route the (h) load
//       inventory recognises) of a desktop/main source, the EXECUTABLE
//       target is resolved Node-style: (a) a specifier that resolves to a
//       DIRECTORY is resolved through that directory's own package.json —
//       its `main` (with LOAD_AS_INDEX fallback), or `exports` read
//       CONSERVATIVELY (every string target the exports object can produce
//       must resolve in-tree; subpath selection is not emulated) — or its
//       index.ts / index.js / index.mts / index.mjs / index.cts / index.cjs;
//       (b) .js / .mjs / .cjs specifiers map to their .ts / .mts / .cts twins
//       when the twin exists (the compiled layout: all 120 base local edges
//       are './x.js' -> x.ts twin resolutions — 149 relative specifier
//       occurrences across 120 inventoried local load sites, none lexical,
//       none a directory), with extensionless candidates
//       (./x -> x.ts, x.tsx, x.js, ...) tried next; (c) the final target is
//       realpathSync'ed (following symlinks AND junctions) and must stay
//       inside desktop/main, compared case-insensitively (Windows). A target
//       no filesystem observation can place (planned-but-absent files,
//       broken imports) falls back to LEXICAL containment — never a pass
//       invented for an observable escape. Findings, each with an EMPTY
//       allowed set: an edge whose final resolved target is OUTSIDE
//       desktop/main (including via package.json main, exports targets,
//       index resolution, twin mapping and realpath); a package.json inside
//       desktop/main whose `main`/`exports` string targets resolve outside
//       (this pins the container-probe shape — the nested manifest is a
//       finding source even before anyone imports the directory); an
//       UNRESOLVABLE directory edge (existing directory, no usable
//       main/exports/index — Node itself would fail; fail closed); and any
//       symlink/junction ENTRY encountered while enumerating desktop/main
//       (Dirent isSymbolicLink(); on Windows junctions report true —
//       verified — and neither isDirectory() nor isFile(), so the walk never
//       follows or scans them). Scanning or following links is NOT offered:
//       a link's target can change after review, so EVERY link is a finding,
//       even one pointing in-tree (pinned by a self-test row). The walk
//       domain now equals the local modules main can actually execute BY
//       CONSTRUCTION of the resolution, not of the lexical path.
//   (y) SRC-9, NATIVE CODE EXECUTION (fail closed, EMPTY allowed sets,
//       across ALL of desktop/main): (1) any RUNTIME reference to a
//       `nativeBinding` member (the INV-3 runtime-reference walk: property
//       access, literal element, destructuring key, option-key / shorthand
//       key in an object literal, import/export specifier, bare identifier —
//       a same-named local declaration counts too, deliberately
//       conservative; better-sqlite3's public path-to-require loader per the
//       critic's binding.js:9-15 evidence); (2) any load whose COOKED
//       specifier OR actual resolved target ends `.node` (case-insensitive),
//       on EVERY route the inventory recognises — relative, absolute, file:
//       URL, bare package subpath ('some-pkg/prebuilds/win-x64/addon.node'
//       — the extension rule is not relative-only) and directory-resolved
//       (a package.json main/exports/index target ending .node); the target
//       check uses SRC-7''s actual resolver, so a directory package routing
//       to a .node binary cannot smuggle it. better-sqlite3 loading its own
//       binding internally inside node_modules is not desktop/main source
//       and is out of scope — SRC-9 polices desktop/main source only;
//       native addons stay reachable through their SRC-6-classified package
//       entry, and loading a DIFFERENT addon's binary by path is exactly the
//       escape SRC-9 closes. COMPUTED specifiers name no extension (the
//       computed-specifier leg, empty allowlist, already forces literals).
//   Both round-10 probe sets become frozen self-test rows (the critic's
//   verbatim sources plus the package-subpath .node regression, an in-tree
//   main NEGATIVE, an in-tree .ts twin NEGATIVE, in-tree exports targets
//   NEGATIVE, an in-tree junction STILL-a-finding pin, and import-equals /
//   dynamic-import / createRequire / option-shape routes), with the runtime
//   evidence retained (real native SQL returning {answer:42}, same-PID
//   canonical xlsx parses — EVIDENCE CITATION CORRECTED (round 11, finding
//   5): re-running the critic's round-10 probe script is NOT native-closure
//   proof — that harness predates SRC-9, so its r11 re-run
//   (repro/critic-round10-probes-r11-rerun.out:5-6,29) still reports ZERO
//   findings for nativeBinding and the direct .node load; only its two
//   filesystem routes turn red. Native closure is proven by the 983-check
//   amended mirror repro/scan-selfcheck-v2.mjs and by the critic's round-11
//   harness repro/critic-round11-probes.mjs, which DO extract SRC-9 and show
//   both native probes RED).
//   The disclosed-residual list below is UNCHANGED: directory package.json
//   resolution, junction traversal, nativeBinding and direct `.node` loads
//   are ordinary documented runtime behaviour, are CLOSED by (x)/(y), and
//   are NOT added to the residuals.
//
// AMENDED (round 11) 2026-11-08 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 11 — four Critical findings (CommonJS resolves an
// extensionless specifier to X.node and a directory to index.node, so
// SRC7_EXTENSIONLESS / SRC7_INDEX_NAMES never surface the binary and an
// unresolved in-tree directory produced no finding; an exact extensionless
// or unknown-extension file is executable JavaScript that SOURCE_EXTENSIONS
// and the walk omit, so SRC-7' containment accepted an UNSCANNED wrapper
// that parsed canonical xlsx in the real Electron main PID; a nested
// desktop/main/package.json {name:'better-sqlite3', exports:{'./addon':
// './native-parser.node'}} let the bare allowed spelling
// 'better-sqlite3/addon' self-reference a LOCAL native addon that executed
// native SQL with zero findings — package SPELLING is not resolved package
// identity; and a literal dynamic import('./answer.wasm') executed an
// exported Wasm function ({answer:42}) in the calling PID on Node,
// Electron-as-Node and a real Electron main with no WebAssembly identifier
// anywhere — repro/critic-round11-probes.mjs + .out:11-58, FIVE zero-finding
// executed routes summarized at .out:60) and one Important evidence-citation
// finding (the round-10 probe-script re-run never extracted SRC-9 —
// correction applied to the round-10 note above) — Required Revisions 1-5 —
// plan Revision 12 SRC-10/SRC-10b/SRC-10c; again ONLY this spec file
// changed, no production code). BASE FACTS at 5d1f7338 (re-verified for this
// amendment): desktop/package.json has name trainingapp-desktop with NO
// exports and NO imports; NO load specifier equal to 'trainingapp-desktop'
// or beginning 'trainingapp-desktop/' anywhere in desktop/main (the name
// occurs only inside log strings); NO directory load (the round-11
// self-check via-profile is 100% compiled-layout twins, zero directory
// channels); NO package.json anywhere under desktop/main; and the only
// non-source file under desktop/main is the untracked graphify tool cache
// desktop/main/graphify-out/cache/stat-index.json — loaded by nothing, never
// enumerated by the walk (.json is not a SOURCE_EXTENSIONS member), NOT a
// load target, and therefore invisible to every rule below. All five routes
// place executable code OUTSIDE the enumerated source set, so they are
// closed by ONE positive gate on the actual target plus three empty-base
// bans, not by emulating more package resolution. Amendments:
//   (z) SRC-10, ALLOWED-TARGET GATE (the final classification layer, sitting
//       on top of SRC-7' actual resolution). For EVERY load site of a
//       desktop/main source the ACTUAL executable target must be
//       classifiable as exactly one of: (a) a file in the scanned source set
//       (a SOURCE_EXTENSIONS file the walk enumerates under desktop/main —
//       .ts/.mts/.cts at base; an in-memory planned file counts through its
//       tree key); (b) a third-party package in
//       THIRD_PARTY_PACKAGE_CLASSIFICATION (allowed only in that table's
//       assigned files — SRC-6 polices the assignment, SRC-10 the
//       classifiability); (c) a built-in in the SRC-3 tables; (d) a .json
//       data file named on the frozen SRC10_JSON_ALLOWLIST — EMPTY at base
//       (nothing in desktop/main loads JSON today; a new JSON load joins the
//       list with a reason or fails). EVERYTHING ELSE is a finding with an
//       EMPTY allowed set: an extensionless file, a file with an unknown
//       extension, a .node or .wasm binary, a load resolved through a
//       directory, a target outside desktop/main, an UNRESOLVABLE target (a
//       source-extension specifier whose file/twin is in neither the walk
//       nor the tree — a planned-but-absent file counts only when the
//       planned tree names it), an unparseable file: URL, a bare specifier
//       naming no classified package, and a non-local specifier that is
//       neither package nor built-in (a data: URL — SRC-3's data-url rule
//       already fails it closed; a deliberate fail-closed overlap). This one
//       gate catches all five round-11 routes: './workbook-parser' resolves
//       to an extensionless executable; './native-parser' resolves (in
//       Node) to native-parser.node, which the source-biased
//       SRC7_EXTENSIONLESS list cannot even see — the extensionless
//       specifier itself is unclassifiable; './container' with only
//       container/index.node is a directory load; './answer.wasm' is a
//       binary; and the nested-manifest self-reference is banned outright by
//       (z'). COMPUTED sites are the computed leg's own domain (empty
//       allowlist), not re-derived here.
//   (z') SRC-10b, EMPTY-BASE BANS (the critic's preferred smaller rules,
//       adopted over emulating more resolution): (i) ANY package.json file
//       anywhere under desktop/main is a finding (base: none — a nested
//       manifest can self-reference exports to a local binary BEFORE any
//       load exists, which is exactly the round-11 route); (ii) ANY load
//       whose SRC-7'-resolved target is a directory — unresolved directories
//       AND index/main/exports-resolved ones — is a finding (base: no
//       directory loads; banning the whole channel is smaller and safer than
//       emulating directory resolution); (iii) ANY load specifier equal to
//       'trainingapp-desktop' or beginning 'trainingapp-desktop/' (a package
//       SELF-REFERENCE, which needs only name+exports in
//       desktop/main/package.json to resolve anywhere) is a finding (base:
//       none).
//   (z'') SRC-10c: ANY load specifier OR SRC-7'-resolved target ending
//       '.wasm' (case-insensitive, on every route the inventory recognises)
//       is a finding (base: none). Node 24's module loader imports .wasm
//       directly with no WebAssembly identifier; SRC-3's global/WASI rules
//       stay for programmatic and URL instantiation.
//   The disclosed-residual list below is UNCHANGED: all five round-11 routes
//   are ordinary documented CommonJS/ESM/Node semantics, are CLOSED by
//   (z)/(z')/(z''), and are NOT added to the residuals.
//
// AMENDED (round 12) 2026-11-09 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 12 — two Critical findings (SRC-10's class (b)
// returned from the package SPELLING at src10ClassifySite before any
// actual-target resolution, so a nested node_modules shadow and a
// manifest-less index.node package directory under desktop/main executed
// canonical xlsx / native SQL in a REAL Electron 45.2.1 main process with
// ZERO findings in all 23 layers and all three walks) and two Important
// findings (the NODE_PATH allowed-package-subpath route; the plan/spec
// class-(a) wording mismatch) — Required Revisions 1-4 — plan Revision 13
// SRC-10'; again ONLY this spec file changed, no production code). The
// critic EXECUTED (repro/critic-round12-probes.mjs + .out): the escape —
// `main/node_modules/better-sqlite3` as an exact EXTENSIONLESS FILE loaded
// through the ordinary allowed spelling `require('better-sqlite3')`
// (LOAD_AS_FILE(DIR/X) runs before LOAD_AS_DIRECTORY and CommonJS parses the
// exact extensionless file as JavaScript; the source walk never scanned the
// wrapper; it loaded CANONICAL desktop/node_modules/xlsx/xlsx.js and parsed
// the workbook in the consumer/main PID on Node, Electron-as-Node and real
// Electron main — .out:13-21); the same early return hiding package-
// DIRECTORY resolution: a manifest-less `main/node_modules/better-sqlite3/`
// directory resolved index.node (LOAD_INDEX's third candidate needs no
// package.json) and executed native SQL ({answer:42}) in the calling PID on
// all three runtimes (.out:22-30); and `ajv-formats/addon` — an allowed
// package name with NO installed subpath — fell through every parent
// node_modules candidate to NODE_PATH and parsed canonical xlsx through an
// external extensionless wrapper on Node and Electron-as-Node (.out:31-36)
// while REAL Electron main REJECTED the specifier ("Cannot find module
// 'ajv-formats/addon'", .out:37) — recorded honestly: the NODE_PATH route is
// a Node-side hole, NOT a third real-Electron escape. Amendment:
//   (z3) SRC-10', RESOLVED PACKAGE TARGETS (upgrades class (b) from
//       name-based to resolved-target-based, the round-10 principle applied
//       to the package class). For every bare-package load site (a specifier
//       with a package name, subpath optional) C1 statically emulates Node
//       resolution FROM THE IMPORTING FILE: walk up parent directories
//       taking `<parent>/node_modules/<name>` as a candidate (each candidate
//       resolves INDEPENDENTLY — one that cannot resolve the specifier does
//       not stop the walk, exactly like LOAD_NODE_MODULES), read each
//       candidate root's package.json exports/main as needed for bare and
//       subpath loads (exports read with a require/import condition
//       preference; a subpath an exports map does not define fails the
//       candidate), and find the resolved FILE by LOAD_AS_FILE extension
//       probing (.js/.json/.node — the exact extensionless file included)
//       and index resolution. NODE_PATH is modelled as the FINAL candidate
//       set, exactly where Node consults it: a load only NODE_PATH supplies
//       is refused outright (its root can never be the canonical
//       desktop/node_modules installation). The police, each with an EMPTY
//       allowed set: (1) the resolved package root must realpathSync
//       (case-insensitive) to <desktop>/node_modules/<name> — nested
//       shadows, NODE_PATH targets and any out-of-tree root fail; (2) the
//       resolved FILE must be a .js/.mjs/.cjs/.json file
//       (SRC10_PACKAGE_FILE_EXTENSIONS) whose realpath stays INSIDE the
//       resolved root — extensionless resolved files, .node, .wasm, unknown
//       extensions, manifest-less package directories and index.node all
//       fail (a manifest-less directory that resolves an index is its own
//       finding kind; one that resolves nothing lets the walk continue, as
//       Node does); (3) the resolved root's directory name must equal the
//       SRC-6-classified name; (4) the xlsx dependency is
//       `file:../vendor/sheetjs/xlsx-0.20.3.tgz` — a TARBALL install, which
//       materialises as an ordinary directory under desktop/node_modules, so
//       its resolved root IS the canonical root and it passes rule (1) like
//       every canonical package (a future file:/link: dependency resolving
//       outside the tree fails). SRC-9's and SRC-10c's specifier channels
//       already fail .node/.wasm subpaths and rule (2) is the stricter
//       target gate for package loads; containment and the (EMPTY) JSON
//       allowlist apply to the resolved target exactly as to a relative
//       load. Classes (a)/(c)/(d) are UNCHANGED.
//       WORDING ALIGNED (round-12 finding 5): class (a) covers ALL SEVEN
//       SOURCE_EXTENSIONS (.ts, .tsx, .js, .mjs, .cjs, .mts, .cts) the walk
//       enumerates under desktop/main — the plan's ".ts/.mts/.cts" was
//       wrong; at base 5d1f7338 all 71 desktop/main files are .ts, and the
//       other six extensions stay SCANNED so a future .js/.cjs file under
//       main cannot hide from the walk.
//   Base facts (re-verified for this amendment): NO node_modules directory
//   anywhere under desktop/main (nothing inside the tree can shadow a
//   package name); NO NODE_PATH in repo config (neither package.json's
//   scripts nor any .npmrc names it); xlsx is the ONLY file: dependency and
//   it is a TARBALL; and all 27 base package load sites resolve via the
//   canonical desktop/node_modules roots (the resolution table is pinned by
//   the S1 SRC-10 gate leg). The disclosed-residual list below is UNCHANGED:
//   the two nested-shadow routes and the Node-side NODE_PATH route are
//   ordinary static module resolution, are CLOSED by (z3), and are NOT added
//   to the residuals.
//
// AMENDED (round 13) 2026-11-09 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 13 — three Critical resolver-fidelity findings
// (SRC-10' mis-cut a bare specifier's inner `node_modules` segment to a
// DIFFERENT package's identity; its conditional-exports emulation omitted
// the ACTIVE `node-addons` condition and traversed conditions in a
// hard-coded order instead of Node's manifest-order first-active-key rule;
// its exports-pattern comparator ignored the TRAILER, so an
// equal-fixed-prefix `./features/*.js` native pattern won at runtime) —
// Required Revisions 1-4 — plan Revision 14 SRC-10''; again ONLY this spec
// file changed, no production code). The critic EXECUTED all three plus
// the compound-specifier no-manifest route with ZERO findings in every
// layer and walk, native SQL / canonical-xlsx execution in the calling PID
// on Node, Electron-as-Node and a REAL Electron 45.2.1 main
// (repro/critic-round13-resolution.out:32-91,
// critic-round13-inner-node-modules.out:38-47; 27/27 base sites matched).
// An emulation will always lag the real algorithm, so amendment:
//   (z4) SRC-10'' — ASK NODE ITSELF. For every bare-package load site in
//       desktop/main the gate resolves the specifier with the runtime's
//       OWN resolver, in the MODE the site actually uses: require-mode
//       sites (`require()`, recognised require forms, `alias()`,
//       `createRequire()()`, `member.require()`, `member[require]()`,
//       `import=require`) with `createRequire(<importing
//       file>).resolve(<specifier>)`; import-mode sites (`import`,
//       `export-from`, `import()`) with `import.meta.resolve(<specifier>,
//       pathToFileURL(<importing file>).href)` executed in a SPAWNED
//       PLAIN-NODE ESM child (one batched call for all sites; a throwaway
//       .mjs under the system temp dir written at test time, source inline
//       in this spec — never a repo file), so vitest's module transform
//       cannot shim it; the leg independently verifies the child ran
//       OUT-OF-PROCESS with the import.meta.resolve PARENT argument really
//       honoured (--experimental-import-meta-resolve; without it Node
//       silently ignores the parent) and NODE_OPTIONS deleted. Node's own
//       active condition sets (require: require/node/node-addons/default;
//       import: import/node/node-addons/default), manifest key order, array
//       fallback, pattern-key ordering with trailers and subpath identity
//       are then faithful BY CONSTRUCTION. The existing gates judge NODE'S
//       ANSWER: the canonical root is derived from the RESOLVED PATH (the
//       ancestor node_modules + the name segment under it — never from the
//       specifier spelling), the landed file must exist and be an in-root
//       .js/.mjs/.cjs/.json (SRC-9 .node and SRC-10c .wasm re-applied to
//       Node's target; extensionless / unknown extensions fail); a
//       specifier Node cannot resolve, or resolves to a nonexistent file,
//       IS a finding (fail closed). Base fact driving the mode split:
//       sqlite-vec and @huggingface/transformers resolve to DIFFERENT
//       files per mode at base 5d1f7338 (index.cjs vs index.mjs;
//       transformers.node.cjs vs transformers.node.mjs), so judging every
//       site in one mode would police a file the site never loads.
//   (z5) INNER-node_modules BAN: any bare specifier containing a
//       `node_modules` path segment is a finding with an EMPTY allowed set
//       (verified none at base) — the round-13 finding-1 shape fails
//       closed BEFORE resolution (Node treats the inner segment as
//       ordinary subpath text of the FIRST package name; the emulator's
//       re-cut inspected a different package entirely).
//   (z6) DIFFERENTIAL (anti-vacuity, not a gate): the SRC-10' EMULATOR is
//       KEPT VERBATIM and every site's emulated target is compared with
//       Node's; a disagreement is REPORTED in the test output, and the
//       27/27 base agreement is ASSERTED (a base disagreement is surfaced,
//       never hidden) — the gates themselves judge only Node's answer.
//   (z7) CROSS-RUNTIME PARITY: every site is re-resolved under
//       ELECTRON-AS-NODE (ELECTRON_RUN_AS_NODE=1 over the electron
//       devDependency's dist/electron.exe, Node 24.22.1) and identical
//       results to vitest's Node are REQUIRED (the binary is present at
//       base; the leg skips ONLY with an explicit reason when absent). ONE
//       identity difference is EXPECTED and pinned, not hidden: under
//       ELECTRON_RUN_AS_NODE the specifier 'electron' resolves to the
//       runtime's OWN built-in ('electron:electron' — the module the
//       packaged main receives), while plain Node resolves the
//       devDependency wrapper node_modules/electron/index.js (which the
//       gates judge and pass); the leg asserts exactly the four base
//       'electron' import sites take that answer and every other site
//       resolves the IDENTICAL file on both runtimes.
//       Runtime condition injection into the PACKAGED main is closed by
//       RUNTIME EVIDENCE, reworded by amendment (z10) below: the
//       enableNodeOptionsEnvironmentVariable:false fuse disables
//       NODE_OPTIONS, and the round-14 packaged-mode negative control
//       (the exact production fuses applied to a copied real Electron
//       45.2.1 distribution) measured direct --conditions ALSO leaving
//       resolution on the safe target — while Electron documents
//       enableNodeCliInspectArguments as covering the --inspect /
//       --inspect-brk INSPECTION flags only, never arbitrary Node
//       options. Recorded here as the reason parity is asserted only
//       across the development runtimes.
//   The residual list below is UNCHANGED (none of the round-13 routes
//   joins it; each is closed by (z4)/(z5) and the round-12 gates).
//
// AMENDED (round 14) 2026-11-09 (recorded CHECK_WRONG: the plan critic's
// 06-critic-review.md Round 14 — one Critical source-mode escape (a `.cts`
// static import is syntactically `import` but TypeScript NodeNext EMITS it
// as `require()`, so resolving in import mode validated a file the emitted
// program never loads) plus one Critical frozen-head contradiction (three
// live S1 assertions pinned 27 package rows while the planned head has 26)
// and two wording corrections — Required Revisions 1-4 — plan Revision 15;
// again ONLY this spec file changed, no production code). The critic
// EXECUTED the `.cts` route with ZERO findings in every layer and both
// walks while the emitted require-mode program resolved an EXTENSIONLESS
// canonical-xlsx wrapper and parsed a workbook in the consumer/main PID on
// Node, Electron-as-Node and a REAL Electron 45.2.1 main
// (repro/critic-round14-probes.out:18-27; the divergence row at :19 shows
// the import-mode answer was the benign safe.mjs while the actual
// require-mode target classifies `extensionless`). Amendments:
//   (z8) EMITTED-FORMAT MODE (R15-1): src10SiteMode now derives a site's
//       resolution mode from the EMITTED module format of the IMPORTING
//       FILE, not from the load's syntax — `.cjs`/`.cts` files are
//       CommonJS (a static `import`/`export-from` there resolves with
//       createRequire: NodeNext compiles it to require()), `.mjs`/`.mts`
//       are ESM, `.ts`/`.tsx`/`.js` follow the nearest governing
//       package.json `type` (desktop/main has none of its own — SRC-10b
//       bans it — so the real tree is governed by desktop/package.json's
//       "module": ESM), a dynamic `import()` is ALWAYS ESM whatever the
//       file, and require-shaped forms are always CommonJS (a require call
//       resolves through the CommonJS loader by construction). Base fact
//       (re-verified): desktop/main is 71 `.ts` files and ZERO
//       `.cts`/`.mts`/`.cjs`/`.mjs`, so no base row's mode label changes
//       and the 27/27 base differential is untouched. The critic's
//       geometry is frozen as the round-14 self-test row below: the `.cts`
//       static import of '@huggingface/transformers' over conditional
//       exports {import:'./safe.mjs', require:'./evil'} turns the tree RED
//       through the `extensionless` finding on Node's require-mode answer,
//       the TypeScript NodeNext emit (`require("@huggingface/transformers")`)
//       is asserted directly, `.mts` static-import and `.cts`
//       dynamic-import controls pin that the fix does not overcorrect, and
//       the three-runtime execution evidence is cited from the probe
//       output (this spec cannot execute at base — its own imports fail).
//   (z9) HEAD-SHAPED PACKAGE COUNTS (R15-2): the three live S1
//       package-count assertions (the SRC-10' table leg, the SRC-10''
//       node-table leg and the round-12 self-test negative) required 27
//       rows — the BASE count — while the planned head resolves 26
//       (extractors.ts loses its four in-main parser loads, the doc child
//       adds three). They now follow the planned-head legs' absent-OR-
//       EXACT rule: 27 while doc-worker-child.ts is absent (the recorded
//       base table stays 27 and is asserted wherever the base table is
//       computed), EXACTLY 26 once it exists — recorded so the implementer
//       cannot silently reconcile the count at implementation time.
//   (z10) WORDING (R15-3): (a) direct-CLI condition injection into the
//       packaged main is closed by RUNTIME EVIDENCE (the round-14
//       packaged-mode negative control, repro/critic-round14-probes.out:
//       28-36: with the exact production fuses applied to a copied real
//       Electron 45.2.1 distribution, NODE_OPTIONS=--conditions was inert
//       and direct --conditions still resolved the safe target);
//       enableNodeOptionsEnvironmentVariable:false disables NODE_OPTIONS,
//       while Electron documents enableNodeCliInspectArguments as covering
//       the --inspect/--inspect-brk inspection flags ONLY — no claim that
//       it filters arbitrary Node options. (b) the package-name-mismatch
//       rule pins RESOLVED-PATH identity against the site's SPELLED
//       package name (the node_modules directory the target actually sits
//       in): it never reads the resolved manifest's `name`, so it verifies
//       the installation alias/path, NOT the underlying npm/publisher
//       identity — a legitimate npm alias (whose manifest name differs
//       from its directory alias) stays green (both round-14 alias
//       controls did), and the ALIASED package's contents are reviewed
//       during SRC-6 classification (the frozen table's judgment call),
//       not verified by this guard.
//   The residual list below is UNCHANGED — the `.cts` emitted-mode route
//   is NOT a residual (it is closed by (z8)); none of the round-14
//   findings joins it.
//
// AMENDED (AC_CHANGED_BY_USER) 2026-11-09 (the maintainer's ASK-1 decision,
// plan Revision 16 / ac3-decision-comment.md, verbatim "Migrate in this PR"):
// pack zip extraction migrates behind the launcher pattern IN THIS PR, AC3
// becomes executable with its own frozen check C3
// (desktop/src/__tests__/i320-pack-extract-out-of-main.test.ts), and
// backend/packs/pack-extract.ts is NO LONGER a named jszip residual. Again
// ONLY this spec file changed, no production code. Every layer that named
// the AC3 residual or jszip's allowed sites is re-frozen to the
// post-migration shape:
//   * S1 jszip leg + INV-3 loadAsync reference set: the allowed set is
//     EXACTLY the three parse children { backend/ingest/doc-worker-child.ts,
//     backend/ingest/xlsx-worker-child.ts, backend/packs/
//     pack-extract-child.ts } — pack-extract.ts REMOVED (absent-OR-exact for
//     the planned pack child, exactly like the planned doc owners, so the
//     spec loads and behaves correctly before the fix while staying RED at
//     base for BOTH defects: extractors.ts still loads jszip AND
//     pack-extract.ts still loads jszip — the AC3 defect C3/C1 must catch).
//   * INV-1 / INV-4: the pack pair joins the parse-child process boundary
//     and the launch surface (runner backend/packs/pack-worker.ts, child
//     backend/packs/pack-extract-child.ts, binding PACK_WORKER_ERROR_PREFIX;
//     basename 'pack-extract-child'; resolver packWorkerChildPath confined
//     to the pack runner; setter setPackWorkerForkFn confined to the pack
//     runner + desktop/main/index.ts registration).
//   * INV-5: pack-worker.ts and pack-extract-child.ts are PLANNED OWNERS
//     with frozen planned export lists (absent OR exact) and planned import
//     edges (pack-extract.ts -> extractPackZipOutOfProcess, index.ts ->
//     setPackWorkerForkFn, backend/index.ts -> terminatePackWorkers,
//     pack-worker.ts -> PACK_WORKER_ERROR_PREFIX). pack-extract.ts KEEPS its
//     base-frozen export surface and importer edges — the public
//     extractPackZip API is unchanged; only its jszip load leaves.
//   * SRC-6: jszip's allowedFiles become the three children (the table
//     stays tied to the legs' pinned sets by the existing cross-check).
//   * The named AC3 pack-extract residual is REMOVED from every residual
//     enumeration; the residual list below otherwise stands unchanged.
//   * The extract-then-verify ordering (extraction still precedes the
//     opt-in, default-off Ed25519 gate) is UNCHANGED and out of scope —
//     the migration moves PARSING out of the privileged process; no C1
//     layer speaks to signature timing.
//
// STOPPING PRINCIPLE (plan Revision 7, AMENDED by Revisions 8, 9, 10, 11,
// 12, 13, 14 and 15, and by the AC_CHANGED_BY_USER amendment of 2026-11-09;
// the residual boundary for the accepted threat model of careless
// or accidental reintroduction by repository contributors): the static guard
// closes every capability transfer that crosses a MODULE EDGE — exports,
// imports, re-exports and loads (INV-5a/5b/5c + SRC-1's owner world + SRC-2's
// local re-export ban) — and the in-process-execution SOURCES: SRC-1's empty
// vm/eval/Function/dlopen/Module-internal sets and the workerPath
// confinement, SRC-3's complete built-in classification (self-checked against
// builtinModules) with its data: URL / WebAssembly / function-constructor
// additions, SRC-4's built-in access APIs, SRC-5's native-extension loads,
// SRC-6's frozen third-party package inventory (self-checked against every
// package the load inventory sees, so a NEW parser library is UNCLASSIFIED
// until someone classifies it) and the RESOLUTION boundary — SRC-7' confines
// every local module edge inside desktop/main by ACTUAL resolution
// (directory package.json main/exports/index, the .js -> .ts compiled-layout
// twin mapping and a final realpath, so the scan domain equals the executable
// local graph, links included as their own fail-closed finding), SRC-8 bans
// every '#' package-import alias, SRC-9 bans every nativeBinding member
// reference and every `.node` load on any route (specifier or resolved
// target), and SRC-10 closes the gate itself: every load's actual target
// must be a scanned in-tree source, a classified package, a classified
// built-in or an allowlisted .json — where a classified PACKAGE (SRC-10',
// round 12) means the load RESOLVES to the canonical
// <desktop>/node_modules/<name> installation of its SRC-6 name and to an
// in-root .js/.mjs/.cjs/.json file, never merely that its spelling names a
// classified package — while SRC-10b bans every nested
// package.json, every directory load and every package self-reference, and
// SRC-10c bans every .wasm load (specifier or resolved target).
// It deliberately does NOT track capability transfer through AMBIENT or SHARED
// MUTABLE STATE: assignment onto globalThis/global/process, mutation of
// objects passed in as arguments, or callback registration that leaks a
// capability out of an owner — which CAN move any capability, the reranker's
// in-process Worker included (following it needs inter-procedural data-flow
// analysis, and careless code does not stash an execution capability that way
// to launch a parser). A SEMANTIC change of an existing frozen export — making
// extractDocOutOfProcess itself parse in-process, say — is likewise outside the
// static guard and is caught by the behavioural legs (S3-S10, the real-child
// and real-Electron PID checks of implementation obligation 4).
//
// THREAT MODEL (recorded so the residual is honest, per plan R5''', Revisions
// 6, 8 and 9): this guard stops accidental or careless reintroduction of
// parser loads into the privileged process by REPOSITORY CONTRIBUTORS. It is
// not a sandbox against a hostile committer. Disclosed residuals — SHRUNK by
// round 7 (SRC-1 closes eval / new Function / Function and the vm / dlopen /
// Module-internal sources; the named-fn Reflect.apply form is caught at its fn
// operand by INV-3 / the round-4 walk), SHRUNK again by the AC_CHANGED_BY_USER
// amendment of 2026-11-09 (the named AC3 pack-extract.ts jszip residual is
// REMOVED — the pack migration this spec now pins closes it; every parser
// load in main is confined to the three parse children) and NOT widened by
// round 8 (every
// round-8 route is CLOSED by SRC-3 / SRC-4, none is reclassified as residual)
// or by round 9 (both round-9 routes are CLOSED by SRC-7 / SRC-8; the list
// below is unchanged):
//   * computed member access with a NON-LITERAL key — `globalThis[k](...)`,
//     `Reflect.apply(globalThis[k], ...)`, `z[k](...)` on an
//     already-obtained library object, a computed KEY that names the loader
//     itself (`obj[k]` with `k === 'require'`, `process[k]` with
//     `k === 'getBuiltinModule'`), and an eval/Function capability reached
//     only through such a key;
//   * a parse-child basename BUILT by concatenation or other computation
//     (`'doc-worker-' + 'child'` — the same computed-construction class,
//     named in the plan's Revision 6 addendum for INV-4);
//   * vendored copies of a library outside node_modules;
//   * a MISCLASSIFIED EXISTING DEPENDENCY (plan Revision 9 update): a
//     THIRD_PARTY_PACKAGE_CLASSIFICATION entry listed NON-PARSER that
//     secretly parses untrusted bytes in main — SRC-6 freezes the inventory
//     and the classification, but the classification itself is a judgment
//     call; it is caught by review (the table's one-line reasons name the
//     decode surfaces honestly), not by this guard. An npm ALIAS
//     installation (manifest `name` differing from its directory alias —
//     green under the (z10)(b) resolved-path rule) is exactly this review
//     judgment: the ALIASED package's contents are classified during SRC-6
//     review; the mismatch rule verifies the installation path/alias only;
//   * capability transfer through AMBIENT or SHARED MUTABLE STATE
//     (assignment onto globalThis/global/process, mutation of a passed-in
//     object, callback registration leaking a capability out of an owner) — a
//     DATA-FLOW residual that can move ANY capability, the reranker's
//     in-process Worker included; disclosed because the static guard does no
//     inter-procedural data-flow analysis, not because the moved capability
//     is harmless;
//   * a SEMANTIC change of an existing frozen export (e.g. a frozen runner
//     entry taught to parse in-process), which the behavioural legs (S3-S10,
//     the real-Electron parent/child PID evidence) pin instead of the static
//     guard.
// Every round-4 through round-12 counterexample (including the addendum's
// in-process `new Worker(<child path>)` launch, the round-6 owner-exported
// aliases, the round-7 local re-exports / Worker exports, the round-8
// getBuiltinModule Worker / bootstrap wrapper / inspector Runtime.evaluate /
// getBuiltinModule vm routes, the round-9 external local wrapper and
// package-import '#' alias routes, the round-10 directory-package-main,
// junction-redirect, nativeBinding and direct-relative-`.node` routes, the
// round-11 extensionless-JavaScript, extensionless-X.node,
// index.node-directory, package-self-reference and direct-`.wasm` routes,
// and the round-12 nested-node_modules extensionless-package-file shadow,
// manifest-less index.node package directory and NODE_PATH allowed-subpath
// routes, and the round-13 inner-node_modules bare-subpath,
// node-addons-condition, condition-key-order and pattern-trailer routes,
// and the round-14 `.cts` static-import emitted-require-mode route) is
// ordinary syntax or filesystem state and IS caught; the
// runtime-loading ones carry canonical-resolution or same-PID proofs in
// repro/scan-selfcheck-v2.mjs (a throwaway step outside this spec, which
// cannot execute at base).
//
// FROZEN PRODUCTION CONTRACT
//
// Parent-side runner — desktop/main/backend/ingest/doc-worker.ts (mirrors
// xlsx-worker.ts with doc names):
//
//   export interface DocWorkerChild {            // same surface as XlsxWorkerChild
//     on(event: 'message', cb: (message: unknown) => void): unknown;
//     on(event: 'exit', cb: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
//     on(event: 'error', cb: (...args: unknown[]) => void): unknown;
//     kill(): unknown;
//   }
//   export type DocWorkerForkFn = (modulePath: string, args: string[]) => DocWorkerChild;
//   export function setDocWorkerForkFn(fn: DocWorkerForkFn | null): void;
//   export function terminateDocWorkers(): void;   // NodeBackendHost.stop() calls it
//   export function docWorkerChildPath(): string;   // compiled doc-worker-child.js, else the .ts sibling
//   export async function extractDocOutOfProcess(
//     filePath: string,
//     opts?: { maxZipBytes?: number; timeoutMs?: number; childPath?: string },
//   ): Promise<{ text: string; pages?: Array<{ pageNumber: number; text: string }> }>;
//
//   The launcher is resolved PER CALL: registered override -> node fork
//   outside Electron -> REFUSAL (reject with the `doc worker:` prefix, never an
//   in-process fallback) inside Electron with nothing registered. It is invoked
//   as launcher(childPath, [path.resolve(filePath), ...optionalCap]) with
//   String(maxZipBytes) appended when a cap is given; childPath defaults to
//   docWorkerChildPath(). Settles ON EXIT (a report alone never settles; a
//   report + exit 0 resolves); a non-zero exit with no report rejects naming
//   the exit code; a clean exit with no report rejects within the grace;
//   report-derived failures ({ok:false,error}) reject with the `doc worker:`
//   prefix; the deadline kills once, then once more after the 2 s grace.
//
//   PAGES (contract note recorded by the check author): the in-main .pdf and
//   .pptx extractors return per-page text (`pages`), which the ingest
//   pipeline feeds to the chunker for page attribution. The public
//   extractDocumentFromFile result must stay identical, so the child report
//   may carry `pages` beside `text` and the runner must surface it. S6 pins the
//   .pptx pages; i320-pdf-parity.test.ts pins the .pdf pages.
//
// Child entry — desktop/main/backend/ingest/doc-worker-child.ts:
//
//   export const DOC_WORKER_ERROR_PREFIX = 'doc worker: ';
//   export async function runDocChildMain(
//     argv: string[],
//     channel?: { postMessage(message: unknown): void },
//   ): Promise<number>;
//     // role-based argv (the #319 rule): the file path is the LAST element,
//     // or the SECOND-TO-LAST when the last element is a numeric zip cap;
//     // format by the path's extension: .docx -> mammoth.extractRawText,
//     // .pptx -> JSZip + slide <a:t> text in numeric slide order,
//     // .pdf -> pdfjs-dist legacy build; the zip-bomb cap is enforced HERE for
//     // .docx/.pptx when given; exactly one report
//     // {ok:true,text[,pages]} | {ok:false,error:'doc worker: ...'};
//     // returns 0 on success, non-zero on failure.
//
// Routing — desktop/main/backend/ingest/extractors.ts keeps the public
// extractDocumentFromFile(filePath, opts?) and sends .docx/.pptx/.pdf through
// extractDocOutOfProcess (maxZipBytes forwarded for .docx/.pptx only), with no
// mammoth / jszip / pdfjs-dist load form and no parent-side zip cap left.
// AMENDED (critic rev 1): the public route forwards `timeoutMs` and
// `childPath` to extractDocOutOfProcess for ALL THREE document formats
// (.docx/.pptx/.pdf — mirroring what the .xlsx route already does for the
// xlsx runner), supplying only defined values; .pdf still never receives a
// cap argument. The runner VALIDATES the report shape before adoption:
// {ok:true} needs a string `text` and, when `pages` is present, an ARRAY of
// {pageNumber: number, text: string} where pageNumber is FINITE
// (Number.isFinite — NaN/Infinity rejected; amendment (g)); anything else
// rejects with the `doc worker:` prefix and is NEVER adopted (a cast is not
// validation).
//
// Bootstrap — desktop/main/index.ts registers, inside app.whenReady (beside
// the xlsx registration):
//   setDocWorkerForkFn((modulePath, args) => utilityProcess.fork(modulePath, args,
//     { stdio: ['ignore', 'ignore', 'pipe'], serviceName: 'TrainingApp document parser' }))
//
// Pack migration names (AMENDED AC_CHANGED_BY_USER 2026-11-09; the FULL
// behavioural contract is the separate frozen C3 spec
// i320-pack-extract-out-of-main.test.ts — this block pins only the names C1's
// static layers freeze): runner desktop/main/backend/packs/pack-worker.ts
// mirrors the xlsx runner's surface with pack names (DEFAULT_PACK_TIMEOUT_MS,
// nodeForkPackWorker, setPackWorkerForkFn, resolvePackWorkerForkFn,
// packWorkerChildPath, terminatePackWorkers, extractPackZipOutOfProcess; the
// PackWorkerChild / PackWorkerForkFn types) and child
// desktop/main/backend/packs/pack-extract-child.ts exports
// PACK_WORKER_ERROR_PREFIX = 'pack worker: ' and runPackChildMain. index.ts
// registers the pack launcher (serviceName 'TrainingApp pack extractor')
// beside the xlsx/doc registrations; NodeBackendHost.stop() calls
// terminatePackWorkers(). pack-extract.ts keeps the PUBLIC extractPackZip
// API (surface.ts:26 unchanged) and its base-frozen export surface, loses
// every jszip load/call, and bridges through the pack runner; extraction
// still precedes the Ed25519 gate (out of scope, unchanged).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync, fork } from 'node:child_process';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import JSZip from 'jszip';
import { app, utilityProcess, FakeUtilityProcess, __resetElectronStub } from 'electron';
import { extractDocumentFromFile } from '../../main/backend/ingest/extractors.js';
import { NodeBackendHost } from '../../main/backend/index.js';
import { StubEngine } from '../../main/backend/engine.js';
import { bootstrap } from '../../main/index';
import { __resetTransportSecurityForTests } from '../../main/security/index';
import { resolveXlsxWorkerForkFn, setXlsxWorkerForkFn } from '../../main/backend/ingest/xlsx-worker.js';
import {
  docWorkerChildPath,
  extractDocOutOfProcess,
  setDocWorkerForkFn,
  terminateDocWorkers,
  type DocWorkerChild,
} from '../../main/backend/ingest/doc-worker.js';
import { DOC_WORKER_ERROR_PREFIX, runDocChildMain } from '../../main/backend/ingest/doc-worker-child.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = path.resolve(THIS_DIR, '../../main');
const INGEST_DIR = path.join(MAIN_DIR, 'backend', 'ingest');
const EXTRACTORS_SOURCE = path.join(INGEST_DIR, 'extractors.ts');
const CHILD_SOURCE = path.join(INGEST_DIR, 'doc-worker-child.ts');
const MAIN_INDEX_SOURCE = path.join(MAIN_DIR, 'index.ts');
const DOC_CHILD_RELATIVE = 'backend/ingest/doc-worker-child.ts';
const XLSX_CHILD_RELATIVE = 'backend/ingest/xlsx-worker-child.ts';
/** INV-5 owner paths (main-relative, forward slashes). */
const XLSX_RUNNER_RELATIVE = 'backend/ingest/xlsx-worker.ts';
const DOC_RUNNER_RELATIVE = 'backend/ingest/doc-worker.ts';
/**
 * The public pack bridge. A NAMED jszip RESIDUAL for #320 AC3 until the
 * AC_CHANGED_BY_USER amendment of 2026-11-09 ("Migrate in this PR"); from
 * that amendment on it must be jszip-FREE (see the S1 jszip leg and the
 * planned pack pair below — check C3 owns the behavioural contract).
 */
const PACK_EXTRACT_RELATIVE = 'backend/packs/pack-extract.ts';
/**
 * The planned pack pair (AC_CHANGED_BY_USER 2026-11-09): the pack runner and
 * pack parse child, planned owners under INV-5 (absent OR exact) and the
 * pack child a PARSE CHILD under INV-1/INV-4.
 */
const PACK_RUNNER_RELATIVE = 'backend/packs/pack-worker.ts';
const PACK_CHILD_RELATIVE = 'backend/packs/pack-extract-child.ts';
/**
 * Amendment (z9) (round 14, plan Revision 15 R15-2): the recorded BASE
 * package-load table of desktop/main is 27 rows at 5d1f7338; the PLANNED
 * HEAD resolves 26 (extractors.ts loses its four in-main parser loads —
 * pdfjs-dist, mammoth and jszip x2 — and the doc child adds three). This spec
 * cannot load at base (its own doc-worker imports fail), so every LIVE S1
 * package-count assertion follows the planned-head legs' absent-OR-exact
 * rule: 27 while doc-worker-child.ts is absent (the base table, asserted
 * wherever it is computed), EXACTLY 26 once it exists.
 */
const BASE_PACKAGE_ROWS = 27;
const HEAD_PACKAGE_ROWS = 26;
function expectedPackageRowCount(): number {
  return fs.existsSync(path.join(MAIN_DIR, ...DOC_CHILD_RELATIVE.split('/'))) ? HEAD_PACKAGE_ROWS : BASE_PACKAGE_ROWS;
}
const TEN_MB = 10 * 1024 * 1024;
const SERVICE_NAME = 'TrainingApp document parser';
/** The report-derived / child-reported rejection prefix. */
const WORKER_PREFIX = /^doc worker:/;

// Expected texts: captured from the PRE-MIGRATION in-main extractor at base
// 5d1f7338 over these exact generated files (repro/verify-office-expected.mjs
// in the trace dir builds byte-identical entry sets and prints these values).
const DOCX_TEXT = 'Hello from the docx child\n\nSecond paragraph & more\n\n';
const PPTX_TEXT = 'Slide one title\nFish & chips\n\nSecond slide\n\nTenth slide';
const PPTX_PAGES = [
  { pageNumber: 1, text: 'Slide one title\nFish & chips' },
  { pageNumber: 2, text: 'Second slide' },
  { pageNumber: 3, text: 'Tenth slide' },
];

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  terminateDocWorkers();
  setDocWorkerForkFn(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'doc-worker-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remove block comments and FULL-LINE // comments (never strips code). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every source extension the main-process tree can carry. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];

/** Every source file (SOURCE_EXTENSIONS) under a directory, recursively. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function relToMain(file: string): string {
  return path.relative(MAIN_DIR, file).split(path.sep).join('/');
}

// ---- AST load-site inventory (amendment (h), round 3 — plan R5'') ----------------
//
// SUPERSEDES the regex load-form patterns (amendment (b)) and the regex
// computed-specifier predicate (amendments (c), (f)). The plan critic
// EXECUTED direct and aliased `createRequire(...)('jszip')`,
// `module['require']('jszip')` and an escape-coded side-effect import past
// those regexes (repro/critic-round3-scan-probe.mjs). Every desktop/main
// source file is now PARSED with the TypeScript compiler API and every
// runtime module-load site is inventoried with the specifier module
// resolution actually sees (the AST's COOKED string value), so no spelling of
// the specifier (escapes, templates, String.raw) and no enumerated loader
// shape can hide a parser load from the S1 legs below.

/** Specifier sentinel for a load site whose module specifier is not a static string. */
const COMPUTED = '<COMPUTED>';

/** One runtime module-load site found by the AST inventory. */
interface LoadSite {
  /** File relative to desktop/main (or the in-memory probe name). */
  file: string;
  /**
   * The load form: `import` (incl. the side-effect `import 'm'`),
   * `export-from`, `import=require`, `import()`, `require()`, `alias()` (an
   * identifier bound IN THE SAME FILE to a require function — a
   * `createRequire(...)` result or an alias of require / module.require),
   * `member.require()` (`module.require`, or `.require` on any receiver),
   * `member[require]()` (`module['require']`), `module[computed]()`
   * (`module[key](...)` — may be require), and `createRequire()()` (a
   * `createRequire(...)` result called directly).
   */
  form: string;
  /** The COOKED module specifier (escapes decoded), or COMPUTED. */
  specifier: string;
  /** Whitespace-collapsed source text of the load node (at most 80 chars). */
  fragment: string;
}

/** ScriptKind by extension: TSX for .tsx, JS for .js/.mjs/.cjs, TS for .ts/.mts/.cts. */
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

/** Strip value-preserving wrappers: parens, `as`, `satisfies`, `!`, `<T>x`, and the comma idiom `(0, f)`. */
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

/**
 * The module specifier a load site's argument evaluates to, read from the
 * AST: a StringLiteral / NoSubstitutionTemplateLiteral yields its COOKED
 * `.text` (hex, unicode and every other escape already decoded — exactly the
 * string module resolution receives); `String.raw` over a substitution-free
 * template yields its RAW text (what String.raw returns). Anything else — an
 * identifier, a call, a concatenation, an interpolated template, a missing
 * argument — is COMPUTED.
 */
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

/**
 * Type-only imports are elided at compile time and load nothing:
 * `import type ...`, and an import with NO default binding whose named
 * bindings are ALL `type`-marked (`import { type A, type B } from 'm'`).
 * That second rule holds because desktop/tsconfig.json does NOT enable
 * verbatimModuleSyntax (pinned by the self-test). A side-effect `import 'm'`
 * and an empty `import {} from 'm'` COUNT (fail-closed).
 */
function importIsTypeOnly(decl: ts.ImportDeclaration): boolean {
  const clause = decl.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const named = clause.namedBindings;
  return named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
}

/** `export type { ... } from 'm'`, or a re-export whose names are ALL `type`-marked (elided likewise). */
function exportIsTypeOnly(decl: ts.ExportDeclaration): boolean {
  if (decl.isTypeOnly) return true;
  const clause = decl.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

/**
 * Inventory every runtime module-load site in one source text:
 *   (a) ImportDeclaration / ExportDeclaration with a module specifier
 *       (type-only excluded, side-effect imports included);
 *   (b) dynamic `import(...)`;
 *   (c) calls of: the identifier `require`; `module.require` (or `.require`
 *       on any receiver); `module['require']`; `module[key]` (computed — may
 *       be require); a `createRequire(...)` result called directly; and any
 *       identifier bound in the same file to a require function (a
 *       `createRequire(...)` / `X.createRequire(...)` result — including
 *       `const require = createRequire(import.meta.url)` — or an alias of
 *       require / module.require, closed transitively; createRequire itself
 *       may arrive renamed by import or destructure); plus
 *       `import x = require('m')` (ImportEqualsDeclaration).
 * Type-position `import('m')` (ImportTypeNode) is not a runtime load.
 */
function loadSitesInSource(source: string, fileName: string): LoadSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const sites: LoadSite[] = [];

  // Pass 1 — same-file bindings, closed to a fixpoint.
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

  // Pass 2 — the load sites.
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

/** The inventory of every file (paths relative to desktop/main). */
function loadSitesOf(files: string[]): LoadSite[] {
  return files.flatMap((file) => loadSitesInSource(fs.readFileSync(file, 'utf8'), relToMain(file)));
}

/**
 * A parser library by package name: the bare name or ANY subpath
 * (`pdfjs-dist/legacy/build/pdf.mjs`, `jszip/dist/jszip.min.js`), also when
 * reached through a node_modules path; case-insensitive (Windows resolves
 * 'JSZip' to the jszip package directory). Look-alikes ('jszipper',
 * 'mammoth-extra') do not match.
 */
function parserSpecifier(name: string): RegExp {
  const n = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?:^|[\\\\/]node_modules[\\\\/])${n}(?:$|[\\\\/])`, 'i');
}

const MAMMOTH_SPECIFIER = parserSpecifier('mammoth');
const PDFJS_SPECIFIER = parserSpecifier('pdfjs-dist');
const JSZIP_SPECIFIER = parserSpecifier('jszip');

/** Files holding at least one load site whose cooked specifier names the parser. */
function filesLoading(sites: LoadSite[], parser: RegExp): string[] {
  return [...new Set(sites.filter((s) => s.specifier !== COMPUTED && parser.test(s.specifier)).map((s) => s.file))].sort();
}

interface ComputedSpecifierSite {
  file: string;
  /** Stable code fragment identifying the site inside the file. */
  fragment: string;
}

/** Every load site whose specifier is COMPUTED, as {file, fragment}, sorted. */
function computedSpecifierSites(sites: LoadSite[]): ComputedSpecifierSite[] {
  return sites
    .filter((s) => s.specifier === COMPUTED)
    .map(({ file, fragment }) => ({ file, fragment }))
    .sort((a, b) => (a.file === b.file ? a.fragment.localeCompare(b.fragment) : a.file.localeCompare(b.file)));
}

// COMPUTED-SPECIFIER ALLOWLIST — RE-CAPTURED in round 3 by running the AST
// inventory over ALL of desktop/main at base 5d1f7338
// (repro/scan-selfcheck-v2.mjs runs this spec's own extracted inventory and
// an independent mirror of it). Every load site at base has a STATIC
// specifier, so the allowlist is EMPTY and the leg below asserts exact
// equality against []. Base inventory facts the re-capture established:
//   * dynamic import(): embedder.ts, extractors.ts (pdfjs-dist/legacy/...,
//     mammoth, jszip x2, ./xlsx-worker.js), gpu-probe-child.ts,
//     xlsx-worker-child.ts (jszip, xlsx), llama-engine.ts, rerank-worker.ts —
//     all string literals;
//   * createRequire-bound require functions: update-checker.ts
//     `require_ = createRequire(import.meta.url)` -> 'ajv/dist/2020',
//     'ajv-formats' (pinned below); backup.ts, recovery.ts, sqlite-store.ts,
//     pack-manager.ts bind the name `require` itself -> 'better-sqlite3',
//     'sqlite-vec', 'ajv/dist/2020', 'ajv-formats' — all literals;
//   * NO module.require / module['require'] / import-equals / String.raw /
//     template / escape-coded specifier exists anywhere in desktop/main;
//   * TYPE-POSITION import('...') (types.ts, index.ts, llama-engine.ts) are
//     ImportTypeNodes, not runtime loads, and are not inventoried.
// Any FUTURE computed specifier — including one the #320 fix introduces —
// must either become a static literal or be added HERE with the file, the
// inventory's code fragment, and a one-line reason.
const COMPUTED_SPECIFIER_ALLOWLIST: ComputedSpecifierSite[] = [];

// ---- AST parser-CALL guard (amendment (j) — supersedes the round-3 textual guard) ----
//
// The AST load inventory is PRIMARY for loads. This INDEPENDENT AST layer is
// defence in depth for what an inventory of LOAD sites cannot see: a parser
// handle that reaches a file WITHOUT a load site in it (passed in as a
// parameter, a vendored copy outside node_modules, an eval/Function/Reflect-
// built loader) still has to CALL the parse entry point. Round 4 showed the
// round-3 TEXTUAL guard (/\bloadAsync\s*\(/ style) misses bracket calls
// (`z['loadAsync'](bytes)`), optional chains (`z?.loadAsync?.(bytes)`) and
// comment-separated calls; comments are not syntax, so the AST sees through
// them. Element keys are matched on their COOKED text (escapes decoded).

/** The three parse entry-point method names, as reachable call forms. */
const PARSER_ENTRY_NAMES = ['loadAsync', 'extractRawText', 'getDocument'] as const;

interface ParserCallSite {
  file: string;
  /** The parse entry-point name being called. */
  name: string;
  /** `dot` (z.loadAsync), `element` (z['loadAsync']) or `bare` (loadAsync). */
  form: 'dot' | 'element' | 'bare';
  /** Whitespace-collapsed call text (at most 80 chars). */
  fragment: string;
}

/** Every parser-entry CALL site in one source (dot / element / optional / bare). */
function parserCallSitesInSource(source: string, fileName: string): ParserCallSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const sites: ParserCallSite[] = [];
  const add = (node: ts.CallExpression, name: string, form: ParserCallSite['form']): void => {
    sites.push({ file: fileName, name, form, fragment: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee)) {
        if ((PARSER_ENTRY_NAMES as readonly string[]).includes(callee.text)) add(node, callee.text, 'bare');
      } else if (ts.isPropertyAccessExpression(callee)) {
        if ((PARSER_ENTRY_NAMES as readonly string[]).includes(callee.name.text)) add(node, callee.name.text, 'dot');
      } else if (ts.isElementAccessExpression(callee)) {
        const key = staticSpecifier(callee.argumentExpression, sf);
        if ((PARSER_ENTRY_NAMES as readonly string[]).includes(key)) add(node, key, 'element');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** Files with at least one parser-entry call site of `name`, relative paths sorted. */
function filesCallingParserEntry(files: string[], name: string): string[] {
  return [
    ...new Set(
      files
        .flatMap((file) => parserCallSitesInSource(fs.readFileSync(file, 'utf8'), relToMain(file)))
        .filter((site) => site.name === name)
        .map((site) => site.file),
    ),
  ].sort();
}

// ---- AST parser-entry REFERENCE guard (amendment (m), round 5 — plan Revision 6 INV-3) ----
//
// The call guard above sees only CALLS whose callee is directly named after a
// parse entry point. Round 5 executed `const load = z.loadAsync; load(bytes)`
// and `z.loadAsync.call(z, bytes)` (zero call sites) and a cross-module parser
// handle. INV-3 counts every RUNTIME REFERENCE to an entry-point NAME instead:
// a property access (incl. optional chains), a literal-key element access, a
// destructuring key, an import/export specifier, an object/class member key
// (incl. a literal computed key) and any identifier with that name (value
// reference or declaration). Aliases, `.call/.apply/.bind` and a module that
// hands a parser handle to another module all involve such a reference, so
// they all fall under the SAME exact allowed file sets. TYPE positions are
// excluded — type literals / method and property signatures, interfaces, type
// aliases, type queries (`typeof z.loadAsync` in a type), indexed access
// types, ambient `declare` statements — because they emit no code. The base
// tree's only non-call mentions are exactly such type-position casts
// (extractors.ts:63 `getDocument(src: ...)`, :113 `extractRawText(input: ...)`).

/** Every parse entry-point NAME whose runtime references are confined (INV-3). */
const PARSER_ENTRY_REFERENCE_NAMES = ['loadAsync', 'extractRawText', 'convertToHtml', 'convertToMarkdown', 'getDocument'] as const;

interface ParserEntryReference {
  file: string;
  /** The entry-point name referenced (INV-4 reuses this shape for its own names). */
  name: string;
  /** `dot` (z.loadAsync, z?.loadAsync), `element` (z['loadAsync']), `binding` (const { loadAsync } = z), `specifier` (import/export names), `key` (object/class member names), `identifier` (any other identifier). */
  form: 'dot' | 'element' | 'binding' | 'specifier' | 'key' | 'identifier';
  /** Whitespace-collapsed text of the referencing node (at most 80 chars). */
  fragment: string;
}

/** Type positions emit no code: excluded from the INV-3 reference walk. A class `extends X` heritage expression is runtime and is NOT excluded. */
function isTypeOnlyPosition(node: ts.Node): boolean {
  if (ts.isExpressionWithTypeArguments(node)) {
    const clause = node.parent;
    return !(ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ExtendsKeyword && !ts.isInterfaceDeclaration(clause.parent));
  }
  if (ts.isTypeNode(node) || ts.isTypeElement(node)) return true;
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  // Type-only import/export forms are elided at compile time.
  if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly) return true;
  if ((ts.isImportClause(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && node.isTypeOnly) return true;
  if (ts.canHaveModifiers(node)) {
    return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
  }
  return false;
}

/** Every RUNTIME reference to a parse entry-point name in one source (INV-3). */
function parserEntryReferencesInSource(source: string, fileName: string): ParserEntryReference[] {
  return runtimeNameReferencesInSource(source, fileName, PARSER_ENTRY_REFERENCE_NAMES);
}

/**
 * The INV-3 runtime-reference walk over ANY name set (INV-3 uses the parse
 * entry points; INV-4, amendment (n), reuses it for the child-path resolvers
 * and launcher setters). Same forms, same type-position exclusion.
 */
function runtimeNameReferencesInSource(source: string, fileName: string, names: readonly string[]): ParserEntryReference[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const refs: ParserEntryReference[] = [];
  const add = (anchor: ts.Node, name: string, form: ParserEntryReference['form']): void => {
    refs.push({ file: fileName, name, form, fragment: anchor.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80) });
  };
  const isMemberNamePosition = (p: ts.Node, node: ts.Node): boolean =>
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)) &&
    p.name === node;
  const visit = (node: ts.Node): void => {
    if (isTypeOnlyPosition(node)) return;
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      const p = node.parent;
      if (ts.isPropertyAccessExpression(p) && p.name === node) add(p, node.text, 'dot');
      else if (ts.isBindingElement(p) && (p.propertyName === node || (p.propertyName === undefined && p.name === node))) {
        add(p, node.text, 'binding');
      } else if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) {
        // One reference per specifier, even when `loadAsync as loadAsync` names it twice.
        if ((p.propertyName ?? p.name) === node) add(p, node.text, 'specifier');
      } else if (isMemberNamePosition(p, node) || ts.isShorthandPropertyAssignment(p)) add(p, node.text, 'key');
      else add(p, node.text, 'identifier');
    } else if (ts.isElementAccessExpression(node)) {
      const key = staticSpecifier(node.argumentExpression, sf);
      if (names.includes(key)) add(node, key, 'element');
    } else if (ts.isComputedPropertyName(node)) {
      const key = staticSpecifier(node.expression, sf);
      if (names.includes(key)) add(node.parent, key, ts.isBindingElement(node.parent) ? 'binding' : 'key');
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && names.includes(node.text)) {
      const p = node.parent;
      if (ts.isBindingElement(p) && p.propertyName === node) add(p, node.text, 'binding');
      else if (isMemberNamePosition(p, node)) add(p, node.text, 'key');
      else if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && (p.propertyName ?? p.name) === node) {
        add(p, node.text, 'specifier');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/** Files with at least one RUNTIME reference to the entry-point `name` (INV-3), relative paths sorted. */
function filesReferencingParserEntry(files: string[], name: string): string[] {
  return [
    ...new Set(
      files
        .flatMap((file) => parserEntryReferencesInSource(fs.readFileSync(file, 'utf8'), relToMain(file)))
        .filter((ref) => ref.name === name)
        .map((ref) => ref.file),
    ),
  ].sort();
}

// ---- loader-capability REFERENCE walk (amendment (i), round 4 — plan R5''') -----------
//
// Fails closed on every runtime reference to a loader capability that is not
// a RECOGNISED form (see the header note (i) for the full taxonomy). The
// amendment-(h) load inventory ABOVE is kept unchanged and stays primary for
// literal specifiers; this walk exists because a capability can be reached,
// aliased, bound, constructed and invoked through shapes a load-site
// inventory never visits (`new require`, `.call/.apply/.bind`, assignment
// aliases, `Module._load`, member createRequire, callbacks).

/** One UNRECOGNISED loader-capability use found by the reference walk. */
interface LoaderUse {
  /** File relative to desktop/main (or the in-memory probe name). */
  file: string;
  /** How the capability is reached: `new-require`, `fn.call`, `fn.apply`, `fn.bind`, `alias-decl`, `assign-alias`, `value`, `member-createRequire`, `destructure-createRequire`, `non-module-createRequire-import`, `_load`, `module-value`, `module-import-default`, `module-import-namespace`, `module-import-other`, `module-import-equals`, `module-re-export`, `require(computed)`, `typeof-guard`, (INV-2, amendment (l)) `createRequire-escape` / `export-capability`, and (SRC-4, amendment (t)) `builtin-access`. */
  form: string;
  /** Whitespace-collapsed fragment of the classified node (at most 80 chars). */
  fragment: string;
}

/** Scope owners for the cheap `module` shadow resolution (a locally declared `module` is never the CJS module). */
function isScopeOwnerForModuleShadow(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isModuleDeclaration(node)
  );
}

/** Does this scope DIRECTLY declare the name `module` (params and declaration names, never descending into nested function scopes)? */
function scopeDeclaresModule(scope: ts.Node): boolean {
  let found = false;
  const nameDeclares = (name: ts.Node): void => {
    if (found || name === undefined) return;
    if (ts.isIdentifier(name)) {
      if (name.text === 'module') found = true;
      return;
    }
    if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) nameDeclares(element.name);
      }
    }
  };
  const isNestedScope = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node);
  const walk = (node: ts.Node, top: boolean): void => {
    if (found) return;
    if (!top && isNestedScope(node)) return;
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      nameDeclares(node.name);
    } else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      if (node.name !== undefined && node.name.text === 'module') found = true;
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.name !== undefined && node.name.text === 'module') found = true;
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name !== undefined && clause.name.text === 'module') found = true;
      const bindings = clause?.namedBindings;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings) && bindings.name.text === 'module') found = true;
        else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.name.text === 'module') found = true;
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (node.name.text === 'module') found = true;
    }
    ts.forEachChild(node, (child) => walk(child, false));
  };
  walk(scope, true);
  return found;
}

/** True when the identifier is a declaration name or a property/key name, not a value reference (shorthand `{ require }` IS a reference). */
function identifierIsDeclarationOrKeyName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isPropertyAssignment(p)) return p.name === id;
  if (ts.isShorthandPropertyAssignment(p)) return false;
  if (ts.isLabeledStatement(p)) return p.label === id;
  if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return p.name === id || p.propertyName === id;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isNamedTupleMember(p) ||
      ts.isJsxAttribute(p)) &&
    'name' in p
  ) {
    return (p as { name?: ts.Node }).name === id;
  }
  return false;
}

/**
 * INV-2 (amendment (l)): climb from an expression through the value-preserving
 * wrappers (parens, `as`, `satisfies`, `!`, `<T>x`, the RIGHT operand of a
 * comma) to the outermost node carrying the SAME value — that node's PARENT is
 * the value's position.
 */
function outermostValueWrapper(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node;
  for (;;) {
    const p = cur.parent;
    if (
      (ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isTypeAssertionExpression(p)) &&
      p.expression === cur
    ) {
      cur = p;
    } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken && p.right === cur) {
      cur = p;
    } else {
      return cur;
    }
  }
}

/**
 * INV-2 (amendment (l)), position (b): the ONLY declaration that may hold a
 * createRequire result (or a tracked alias of one) — an Identifier-named
 * `const` (not let/var/using) in a plain, NON-exported, non-`declare`
 * VariableStatement. Destructuring, `let`/`var`, `export const`, a for-loop
 * initializer, a class field or a parameter default are all other positions.
 */
function isRecognisedRequireBinding(decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return false;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement)) return false;
  return !(statement.modifiers ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DeclareKeyword,
  );
}

/**
 * SRC-4 (amendment (t), round 8 — plan Revision 9): the BUILT-IN ACCESS APIs
 * are loader capabilities. `process.getBuiltinModule` returns any built-in
 * (worker_threads' Worker, vm, inspector, module ...) WITHOUT require() or
 * import() — the round-8 critic executed it to run the REAL xlsx child inside
 * the launching OS process — and `process.binding` / `_linkedBinding` /
 * `internalBinding` reach Node's native bindings directly. Check-author
 * additions (recorded for the critic, each verified EMPTY at base 5d1f7338):
 * `execve` (replaces the process image with an arbitrary binary under the SAME
 * PID), `_debugProcess` / `_debugEnd` (activate / end the V8 inspector in a
 * target PID, including the current one, without loading node:inspector).
 * (`process.mainModule` is deliberately NOT added: the desktop/main entry is
 * ESM, where it is undefined — verified — and a frozen round-4 walk row pins
 * `process.mainModule.require('<literal>')` as a recognised member load whose
 * specifier the load inventory judges.)
 * The walk is NAME-BASED on EVERY receiver (fail closed, stronger than
 * receiver tracking): any runtime reference — dot / optional / literal-element
 * member on any receiver (`process.x`, `globalThis.process.x`, an alias
 * `p.x`), destructuring key (`const { getBuiltinModule } = process`), import /
 * export specifier (`import { getBuiltinModule } from 'node:process'` — the
 * node:process module's named exports carry these members, verified on Node
 * 24.16 and Electron 45.2.1), object key or bare identifier — is an
 * UNRECOGNISED loader use (`builtin-access`) gated by the EMPTY
 * UNRECOGNISED_LOADER_USE_ALLOWLIST. Type positions do not count. Only a
 * NON-LITERAL computed key (`process[k]`) evades it — the disclosed
 * computed-key residual.
 */
const SRC4_BUILTIN_ACCESS_NAMES = [
  'getBuiltinModule',
  'binding',
  '_linkedBinding',
  'internalBinding',
  'execve',
  '_debugProcess',
  '_debugEnd',
] as const;

/**
 * Every UNRECOGNISED loader-capability use in one source. Capabilities and
 * RECOGNISED forms are enumerated in the header note (i); anything else is
 * flagged here with a stable form name. Lexical shadowing of `module` is
 * resolved with a scope walk; a `require` shadowed by an untracked local is
 * still treated as the capability (fail closed — its direct calls are
 * inventoried by the load layer regardless). SRC-4 (amendment (t)) appends one
 * `builtin-access` use per runtime reference to SRC4_BUILTIN_ACCESS_NAMES.
 */
function loaderUsesInSource(source: string, fileName: string): LoaderUse[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const uses: LoaderUse[] = [];
  const handled = new Set<ts.Node>();
  const flag = (node: ts.Node, form: string): void => {
    uses.push({ file: fileName, form, fragment: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80) });
  };
  const markHandled = (expr: ts.Expression): void => {
    const e = unwrapExpression(expr);
    handled.add(e);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) markHandled(e.expression);
  };

  // Pass 1 — same-file bindings with ORIGINS (ambient require vs createRequire
  // results vs createRequire itself), closed to a fixpoint. NOTE: unlike the
  // load inventory, createRequireFns is NOT seeded with the bare name — the
  // recognised createRequire origin must be EARNED by a named module-package
  // import, so a homemade `createRequire` binding from anywhere else is never
  // recognised here (its loads are still fail-closed inventoried by the load
  // layer's own broader seed).
  const ambientRequireFns = new Set<string>(['require']);
  const createRequireFns = new Set<string>();
  const createRequireResultFns = new Set<string>();
  const isModulePackageSpecifier = (spec: string): boolean => spec === 'module' || spec === 'node:module';
  const isCreateRequireCallExpr = (e: ts.Expression): boolean => {
    if (!ts.isCallExpression(e)) return false;
    const callee = unwrapExpression(e.expression);
    return ts.isIdentifier(callee) && createRequireFns.has(callee.text);
  };
  const declBindings: Array<{ local: string; init: ts.Expression }> = [];
  const destructureBindings: Array<{ local: string; key: string }> = [];
  const importBindings: Array<{ local: string; key: string; fromModulePackage: boolean }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      declBindings.push({ local: node.name.text, init: node.initializer });
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) destructureBindings.push({ local: node.name.text, key: key.text });
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause !== undefined && !clause.isTypeOnly) {
        const spec = staticSpecifier(node.moduleSpecifier, sf);
        const fromModulePackage = spec !== COMPUTED && isModulePackageSpecifier(spec);
        if (clause.name !== undefined) importBindings.push({ local: clause.name.text, key: 'default', fromModulePackage });
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) importBindings.push({ local: bindings.name.text, key: '*', fromModulePackage });
          else {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) {
                importBindings.push({ local: element.name.text, key: (element.propertyName ?? element.name).text, fromModulePackage });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { local, key, fromModulePackage } of importBindings) {
      if (key === 'createRequire' && fromModulePackage && !createRequireFns.has(local)) {
        createRequireFns.add(local);
        grew = true;
      }
    }
    for (const { local, key } of destructureBindings) {
      if (key === 'require' && !ambientRequireFns.has(local)) {
        ambientRequireFns.add(local);
        grew = true;
      }
    }
    for (const { local, init } of declBindings) {
      const e = unwrapExpression(init);
      let target: Set<string> | null = null;
      if (isCreateRequireCallExpr(e)) target = createRequireResultFns;
      else if (ts.isIdentifier(e)) {
        if (createRequireResultFns.has(e.text)) target = createRequireResultFns;
        else if (ambientRequireFns.has(e.text)) target = ambientRequireFns;
        else if (createRequireFns.has(e.text)) target = createRequireFns;
      } else if (ts.isPropertyAccessExpression(e) && e.name.text === 'require') target = ambientRequireFns;
      else if (ts.isElementAccessExpression(e) && staticSpecifier(e.argumentExpression, sf) === 'require') {
        target = ambientRequireFns;
      } else if (ts.isPropertyAccessExpression(e) && e.name.text === 'createRequire') target = createRequireFns;
      if (target !== null && !target.has(local)) {
        target.add(local);
        grew = true;
      }
    }
  }

  // Pass 2 — classify every runtime reference.
  const moduleShadowedAt = (id: ts.Identifier): boolean => {
    for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
      if (isScopeOwnerForModuleShadow(scope) && scopeDeclaresModule(scope)) return true;
    }
    return false;
  };
  const capAccessName = (e: ts.Expression): 'require' | 'createRequire' | '_load' | null => {
    if (ts.isPropertyAccessExpression(e)) {
      const n = e.name.text;
      return n === 'require' || n === 'createRequire' || n === '_load' ? n : null;
    }
    if (ts.isElementAccessExpression(e)) {
      const k = staticSpecifier(e.argumentExpression, sf);
      return k === 'require' || k === 'createRequire' || k === '_load' ? k : null;
    }
    return null;
  };
  const capIdentifierKind = (id: ts.Identifier): 'requireFn' | 'createRequireFn' | 'module' | null => {
    const t = id.text;
    if (ambientRequireFns.has(t) || createRequireResultFns.has(t)) return 'requireFn';
    if (createRequireFns.has(t)) return 'createRequireFn';
    if (t === 'module' && !moduleShadowedAt(id)) return 'module';
    return null;
  };
  const isCapabilityExpr = (e: ts.Expression): boolean =>
    capAccessName(e) !== null || (ts.isIdentifier(e) && capIdentifierKind(e) !== null) || isCreateRequireCallExpr(e);
  // INV-2 (amendment (l)): a createRequire(...) RESULT is recognised ONLY in
  // these positions — (a) immediately invoked (`createRequire(u)('lit')`; a
  // computed argument is still flagged `require(computed)`) or `.resolve`d
  // (dot or literal-element `resolve`); (b) the initializer of a recognised
  // const binding (isRecognisedRequireBinding), whose every later reference is
  // policed by this same walk (a direct literal call, a `.resolve`, or a const
  // alias whose own references satisfy the same rule, transitively — the
  // Revision 6 addendum INV-2 clarification). Any other position — returned, an argument or
  // callback, a default parameter, a property / array element / class field,
  // a let/var/exported binding, spread, a discarded comma operand — is an
  // UNRECOGNISED `createRequire-escape`.
  const createRequireResultPositionRecognised = (call: ts.Expression): boolean => {
    const w = outermostValueWrapper(call);
    const p = w.parent;
    if (ts.isCallExpression(p) && p.expression === w) return true;
    if (ts.isPropertyAccessExpression(p) && p.expression === w && p.name.text === 'resolve') return true;
    if (ts.isElementAccessExpression(p) && p.expression === w && staticSpecifier(p.argumentExpression, sf) === 'resolve') {
      return true;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === w) return isRecognisedRequireBinding(p);
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;

    if (ts.isImportDeclaration(node)) {
      const spec = staticSpecifier(node.moduleSpecifier, sf);
      const mod = spec !== COMPUTED && isModulePackageSpecifier(spec);
      const clause = node.importClause;
      if (mod && clause !== undefined && !clause.isTypeOnly) {
        if (clause.name !== undefined) flag(node, 'module-import-default');
        else if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
          flag(node, 'module-import-namespace');
        } else if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
          const valueElements = clause.namedBindings.elements.filter((el) => !el.isTypeOnly);
          if (valueElements.some((el) => (el.propertyName ?? el.name).text !== 'createRequire')) {
            flag(node, 'module-import-other');
          }
        }
      }
      if (!mod && clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        if (clause.namedBindings.elements.some((el) => !el.isTypeOnly && (el.propertyName ?? el.name).text === 'createRequire')) {
          flag(node, 'non-module-createRequire-import');
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const exportSpec = node.moduleSpecifier === undefined ? COMPUTED : staticSpecifier(node.moduleSpecifier, sf);
      if (node.moduleSpecifier !== undefined && !node.isTypeOnly && exportSpec !== COMPUTED && isModulePackageSpecifier(exportSpec)) {
        flag(node, 'module-re-export');
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isModulePackageSpecifier(staticSpecifier(node.moduleReference.expression, sf))
      ) {
        flag(node, 'module-import-equals');
      }
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const access = capAccessName(callee);
      if (access === 'require') {
        // X.require('lit') / X['require']('lit') — a direct member load.
        if (staticSpecifier(node.arguments[0], sf) === COMPUTED) flag(node, 'require(computed)');
        markHandled(callee);
      } else if (access === 'createRequire') {
        // Member/computed createRequire is never a recognised origin.
        flag(callee, 'member-createRequire');
        markHandled(callee);
      } else if (access === '_load') {
        flag(callee, '_load');
        markHandled(callee);
      } else if (ts.isIdentifier(callee)) {
        const kind = capIdentifierKind(callee);
        if (kind === 'requireFn') {
          if (staticSpecifier(node.arguments[0], sf) === COMPUTED) flag(node, 'require(computed)');
          markHandled(callee);
        } else if (kind === 'createRequireFn') {
          // Invoking createRequire is recognised ONLY when its RESULT lands in a
          // recognised position (INV-2, amendment (l)). An enclosing form that
          // already classified this call (new / .call / assignment / tag /
          // direct invocation) has marked it handled — no double finding.
          markHandled(callee);
          if (!handled.has(node) && !createRequireResultPositionRecognised(node)) flag(node, 'createRequire-escape');
        }
      } else if (ts.isCallExpression(callee) && isCreateRequireCallExpr(callee)) {
        // createRequire(u)('lit') — the result is directly invoked here.
        if (staticSpecifier(node.arguments[0], sf) === COMPUTED) flag(node, 'require(computed)');
        markHandled(callee);
        markHandled(callee.expression);
      } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const m = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : staticSpecifier(callee.argumentExpression, sf);
        if (m === 'call' || m === 'apply' || m === 'bind') {
          const base = unwrapExpression(callee.expression);
          if (isCapabilityExpr(base)) {
            flag(node, `fn.${m}`);
            markHandled(base);
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const callee = node.expression === undefined ? undefined : unwrapExpression(node.expression);
      if (callee !== undefined && isCapabilityExpr(callee)) {
        flag(node, 'new-require');
        markHandled(callee);
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const e = unwrapExpression(node.initializer);
      if (ts.isIdentifier(e)) {
        if (createRequireResultFns.has(e.text)) {
          // A tracked alias of a createRequire result: recognised only in the
          // same const-binding position as the result itself (INV-2 (b)).
          if (!isRecognisedRequireBinding(node)) flag(node, 'createRequire-escape');
          markHandled(e);
        } else if (ambientRequireFns.has(e.text)) {
          flag(node, 'alias-decl'); // aliasing the AMBIENT require (the round-4 counterexample)
          markHandled(e);
        } else if (createRequireFns.has(e.text)) {
          flag(node, 'value'); // createRequire itself bound as a value
          markHandled(e);
        } else if (e.text === 'module' && !moduleShadowedAt(e)) {
          flag(node, 'value');
          markHandled(e);
        }
      } else {
        const access = capAccessName(e);
        if (access === 'require') {
          flag(node, 'alias-decl'); // const s = module.require / X['require']
          markHandled(e);
        }
        // member-createRequire / _load initialisers are flagged at the access
        // below; `const r = createRequire(u)` is the recognised pattern.
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ts.isIdentifier(node.name)) {
      const key = node.propertyName ?? node.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
      if (keyText === 'require') {
        flag(node, 'alias-decl'); // const { require: t } = <anything>
      } else if (keyText === 'createRequire') {
        flag(node, 'destructure-createRequire'); // the recognised origin is the NAMED IMPORT only
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const e = unwrapExpression(node.right);
      if (isCapabilityExpr(e)) {
        flag(node, 'assign-alias'); // r = require / obj.loader = require / any capability
        markHandled(e);
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      const tag = unwrapExpression(node.tag);
      if (isCapabilityExpr(tag)) {
        flag(node, 'value'); // require`...` invokes the capability with a strings array
        markHandled(tag);
      }
    } else if (
      ts.isExportSpecifier(node) &&
      !node.isTypeOnly &&
      ts.isNamedExports(node.parent) &&
      node.parent.parent.moduleSpecifier === undefined &&
      !node.parent.parent.isTypeOnly
    ) {
      // INV-2 (amendment (l)): `export { req }` hands the LOCAL capability to
      // other modules, where this walk can no longer police its uses.
      const local = node.propertyName ?? node.name;
      if (ts.isIdentifier(local) && capIdentifierKind(local) !== null) flag(node, 'export-capability');
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !handled.has(node)) {
      const access = capAccessName(node);
      if (access === 'createRequire') {
        flag(node, 'member-createRequire');
        markHandled(node);
      } else if (access === '_load') {
        flag(node, '_load');
        markHandled(node);
      } else if (access === 'require') {
        const p = node.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text === 'resolve') {
          markHandled(node); // <X>.require.resolve(...) — non-loading
        } else if (ts.isCallExpression(p) && p.expression === node) {
          markHandled(node); // already classified as the call callee above
        } else {
          flag(node, 'value'); // a .require access neither called nor .resolve'd
          markHandled(node);
        }
      }
    } else if (ts.isIdentifier(node) && !handled.has(node) && !identifierIsDeclarationOrKeyName(node)) {
      const kind = capIdentifierKind(node);
      if (kind !== null) {
        const p = node.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text === 'resolve') {
          // require.resolve / trackedFn.resolve — recognised non-loading use.
        } else if (p.kind === ts.SyntaxKind.TypeOfExpression) {
          flag(node, 'typeof-guard'); // no typeof guard exists at base — fail closed
        } else if (kind === 'module') {
          flag(node, 'module-value');
        } else {
          flag(node, 'value');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // SRC-4 (amendment (t)): every runtime reference to a built-in access API.
  for (const ref of runtimeNameReferencesInSource(source, fileName, SRC4_BUILTIN_ACCESS_NAMES)) {
    uses.push({ file: fileName, form: 'builtin-access', fragment: ref.fragment });
  }
  return uses;
}

/** The walk's findings over files, sorted (file, form, fragment) for exact-set legs. */
function sortedLoaderUses(files: string[]): LoaderUse[] {
  return files
    .flatMap((file) => loaderUsesInSource(fs.readFileSync(file, 'utf8'), relToMain(file)))
    .sort((a, b) => (a.file === b.file ? (a.form === b.form ? a.fragment.localeCompare(b.fragment) : a.form.localeCompare(b.form)) : a.file.localeCompare(b.file)));
}

// UNRECOGNISED LOADER USE ALLOWLIST — captured at base 5d1f7338 in round 4 by
// running the loader-capability reference walk over ALL of desktop/main
// (repro/scan-selfcheck-v2.mjs extracts THIS spec's walk, runs it, and
// cross-checks an independent mirror in lockstep). The base tree produces
// ZERO unrecognised uses, so the allowlist is EMPTY and no site had to be
// excused or any recognised form widened. Base facts the capture established:
//   * the ONLY loader capabilities in desktop/main are five named
//     `import { createRequire } from 'node:module'` imports — update-checker.ts
//     (binding `require_`) and backend/store/backup.ts, recovery.ts,
//     sqlite-store.ts, pack-manager.ts (each binding the name `require`);
//   * every binding is a createRequire(...) result used ONLY as a direct-call
//     callee with STATIC literal specifiers ('better-sqlite3', 'sqlite-vec',
//     'ajv/dist/2020', 'ajv-formats') — the recognised pattern, no flags;
//   * NO unshadowed `module` identifier, NO typeof require/module guard, NO
//     require.resolve, NO member/_load/computed access, NO alias/assignment/
//     new/call/apply/bind/callback use exists anywhere in desktop/main.
// Any FUTURE unrecognised use — including one the #320 fix introduces — must
// be added HERE with the file, the walk's stable form + fragment, and a
// one-line reason; the leg below asserts EXACT equality.
const UNRECOGNISED_LOADER_USE_ALLOWLIST: Array<LoaderUse & { reason: string }> = [];

// ---- PROCESS-BOUNDARY guard (amendment (k), round 5 — plan Revision 6 INV-1) ----------
//
// Round 5 executed the gap the file-local inventories cannot see: a new main
// module that imports the child's exported entry (`runDocChildMain`) and calls
// it runs the child's dynamic parser imports IN THE CALLER'S PROCESS, while the
// parser loads and calls stay textually inside the sanctioned child file. INV-1
// makes a parse-child module a PROCESS ENTRY POINT, never a library: every
// runtime module edge in desktop/main (static import, re-export, import-equals,
// and every call-form load the amendment-(h) inventory finds — dynamic
// import(), require, createRequire results, member require) is RESOLVED to a
// main-relative path (relative specifiers against the importing file; absolute
// paths and file: URLs; the extension is ignored, so './x.js' -> 'x.ts' — the
// repo's ESM `.js` -> `.ts` mapping — './x', './x.ts' and './x.mjs' all name the
// same module stem; case-insensitive, as Windows resolves it). An edge whose
// target is a parse child is a FINDING unless it is EXACTLY its own runner
// named-importing its own error-prefix constant (local alias allowed; type-only
// bindings ignored). Every wrapper or re-export must itself import the child,
// so this closes local wrappers structurally. Type-only imports/re-exports are
// permitted (elided). Forking the child by path is not a module edge. A load
// with a COMPUTED specifier cannot be resolved here; it is gated by the
// computed-specifier leg (empty allowlist).

/** The parse-child process entry points (main-relative) and each one's ONLY permitted importer + binding. */
const PARSE_CHILD_BOUNDARY: ReadonlyArray<{ child: string; runner: string; binding: string }> = [
  { child: 'backend/ingest/doc-worker-child.ts', runner: 'backend/ingest/doc-worker.ts', binding: 'DOC_WORKER_ERROR_PREFIX' },
  { child: 'backend/ingest/xlsx-worker-child.ts', runner: 'backend/ingest/xlsx-worker.ts', binding: 'XLSX_WORKER_ERROR_PREFIX' },
  // AC_CHANGED_BY_USER 2026-11-09: the pack child joins the boundary.
  { child: 'backend/packs/pack-extract-child.ts', runner: 'backend/packs/pack-worker.ts', binding: 'PACK_WORKER_ERROR_PREFIX' },
];

/** A forbidden module edge into a parse child. */
interface BoundaryFinding {
  file: string;
  /** The parse child the edge resolves to (main-relative). */
  target: string;
  /** `import-by-non-runner`, `import-side-effect`, `import-default`, `import-namespace`, `import-binding`, `re-export`, `import-equals`, or a call-form load (`import()`, `require()`, `alias()`, `member.require()`, ...). */
  form: string;
  fragment: string;
}

/** The one permitted edge shape: runner -> its child, binding = the prefix constant. */
interface PermittedBoundaryEdge {
  file: string;
  target: string;
  binding: string;
}

/** The module stem of a path: any JS/TS source or compiled extension stripped, lower-cased. */
function moduleStem(p: string): string {
  return p.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/i, '').toLowerCase();
}

/**
 * Resolve a COOKED specifier, seen from `fromRel` (main-relative, posix), to a
 * main-relative module stem; null for bare packages, `node:` builtins and
 * COMPUTED specifiers.
 */
function resolveMainSpecifier(fromRel: string, specifier: string): string | null {
  if (specifier === COMPUTED) return null;
  let s = specifier.replace(/\\/g, '/');
  if (/^file:/i.test(s)) {
    try {
      s = fileURLToPath(s).replace(/\\/g, '/');
    } catch {
      return null;
    }
  }
  if (s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../')) {
    return moduleStem(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), s)));
  }
  if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) return moduleStem(relToMain(s));
  return null;
}

/** INV-1 edges of one source: forbidden edges into a parse child, and the permitted runner-prefix edges. */
function processBoundaryEdgesInSource(
  source: string,
  fileRel: string,
): { findings: BoundaryFinding[]; permitted: PermittedBoundaryEdge[] } {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const findings: BoundaryFinding[] = [];
  const permitted: PermittedBoundaryEdge[] = [];
  const childOf = (specifier: string): (typeof PARSE_CHILD_BOUNDARY)[number] | null => {
    const stem = resolveMainSpecifier(fileRel, specifier);
    if (stem === null) return null;
    return PARSE_CHILD_BOUNDARY.find((b) => moduleStem(b.child) === stem) ?? null;
  };
  const add = (node: ts.Node, target: string, form: string): void => {
    findings.push({ file: fileRel, target, form, fragment: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80) });
  };
  const isRunner = (b: (typeof PARSE_CHILD_BOUNDARY)[number]): boolean => moduleStem(fileRel) === moduleStem(b.runner);
  // Every declaration form, wherever it sits (incl. namespace / ambient bodies).
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const b = childOf(staticSpecifier(node.moduleSpecifier, sf));
      if (b !== null && !importIsTypeOnly(node)) {
        const clause = node.importClause;
        if (!isRunner(b)) add(node, b.child, 'import-by-non-runner');
        else if (clause === undefined) add(node, b.child, 'import-side-effect');
        else if (clause.name !== undefined) add(node, b.child, 'import-default');
        else if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
          add(node, b.child, 'import-namespace');
        } else {
          const named = clause.namedBindings;
          const values =
            named !== undefined && ts.isNamedImports(named)
              ? named.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text)
              : [];
          if (values.length === 1 && values[0] === b.binding) permitted.push({ file: fileRel, target: b.child, binding: b.binding });
          else add(node, b.child, 'import-binding');
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && !exportIsTypeOnly(node)) {
        const b = childOf(staticSpecifier(node.moduleSpecifier, sf));
        if (b !== null) add(node, b.child, 're-export');
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const b = childOf(staticSpecifier(node.moduleReference.expression, sf));
      if (b !== null) add(node, b.child, 'import-equals');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Every CALL-form load the amendment-(h) inventory finds (dynamic import(),
  // require, require aliases, createRequire results, member require, ...).
  for (const site of loadSitesInSource(source, fileRel)) {
    if (site.form === 'import' || site.form === 'export-from' || site.form === 'import=require') continue;
    const b = childOf(site.specifier);
    if (b !== null) findings.push({ file: fileRel, target: b.child, form: site.form, fragment: site.fragment });
  }
  return { findings, permitted };
}

/** INV-1 over files: every forbidden edge and every permitted edge, sorted. */
function processBoundaryOf(files: string[]): { findings: BoundaryFinding[]; permitted: PermittedBoundaryEdge[] } {
  const per = files.map((file) => processBoundaryEdgesInSource(fs.readFileSync(file, 'utf8'), relToMain(file)));
  const key = (o: { file: string; target: string }, extra: string): string => `${o.file}\u0000${o.target}\u0000${extra}`;
  return {
    findings: per
      .flatMap((r) => r.findings)
      .sort((a, b) => key(a, `${a.form}\u0000${a.fragment}`).localeCompare(key(b, `${b.form}\u0000${b.fragment}`))),
    permitted: per.flatMap((r) => r.permitted).sort((a, b) => key(a, a.binding).localeCompare(key(b, b.binding))),
  };
}

// ---- LAUNCH-SURFACE guard (amendment (n), round 5 addendum — plan Revision 6 INV-4) ----
//
// INV-1 polices module EDGES only, so another main module could still run a
// parse child IN-PROCESS without importing it — `new Worker(path.join(dir,
// 'doc-worker-child.js'))` (worker_threads share the main address space) — or
// re-fork it through the runner's resolver, or swap the runner's launcher for
// an in-process one. Every launch of a parse child has to NAME it through one
// of three capabilities, and INV-4 confines each to its owner:
//   (a) a runtime string literal, no-substitution template or template-literal
//       quasi (head / middle / tail) whose COOKED text contains a parse-child
//       basename (`doc-worker-child`, `xlsx-worker-child`; case-insensitive
//       substring) — only in that child's own runner and the child file itself;
//   (b) a runtime reference to the child-path resolver (`docWorkerChildPath` /
//       `xlsxWorkerChildPath`) — only in its own runner;
//   (c) a runtime reference to the launcher setter (`setDocWorkerForkFn` /
//       `setXlsxWorkerForkFn`) — only in its own runner (the definition) and
//       desktop/main/index.ts (the bootstrap registration).
// (b)/(c) reuse the INV-3 runtime-reference walk (identifiers, dot / optional /
// literal-key element access, destructuring keys, import / export specifiers
// incl. re-exports, member keys). Comments are not syntax; TYPE positions
// (isTypeOnlyPosition, incl. string-literal types) emit no code and do not
// count. Files are compared by module stem (extension-agnostic,
// case-insensitive), exactly as INV-1 compares its runner.
// SPECIFIER POSITIONS (the choice recorded for the addendum): the module
// specifier of a static import / export-from declaration and the
// `require('...')` of an import-equals declaration are EXCLUDED from (a) —
// INV-1 already resolves and judges every such edge, so the permitted
// runner-prefix import (xlsx-worker.ts:28) is never double-reported and a
// forbidden one is reported once, by INV-1. CALL-form load arguments
// (`import('./doc-worker-child.js')`, `require(...)`) are NOT excluded: they
// are ordinary call arguments to (a), so in a non-runner such a load is red
// under BOTH INV-1 and INV-4 (deliberate fail-closed overlap; never a
// permitted edge, so nothing permitted is double-counted). A basename BUILT by
// concatenation or computation is the disclosed computed-construction residual.

/** One INV-4 launch-surface capability and the ONLY files allowed to name it. */
interface LaunchSurfaceRule {
  /** `child-basename` (a), `child-path-resolver` (b) or `launcher-setter` (c). */
  kind: 'child-basename' | 'child-path-resolver' | 'launcher-setter';
  /** The basename (lower-case substring) or the exact identifier name. */
  name: string;
  /** Main-relative files permitted to name it. */
  allowed: readonly string[];
}

const LAUNCH_SURFACE_RULES: readonly LaunchSurfaceRule[] = [
  { kind: 'child-basename', name: 'doc-worker-child', allowed: ['backend/ingest/doc-worker.ts', 'backend/ingest/doc-worker-child.ts'] },
  { kind: 'child-basename', name: 'xlsx-worker-child', allowed: ['backend/ingest/xlsx-worker.ts', 'backend/ingest/xlsx-worker-child.ts'] },
  // AC_CHANGED_BY_USER 2026-11-09: the pack pair's launch surface.
  { kind: 'child-basename', name: 'pack-extract-child', allowed: ['backend/packs/pack-worker.ts', 'backend/packs/pack-extract-child.ts'] },
  { kind: 'child-path-resolver', name: 'docWorkerChildPath', allowed: ['backend/ingest/doc-worker.ts'] },
  { kind: 'child-path-resolver', name: 'xlsxWorkerChildPath', allowed: ['backend/ingest/xlsx-worker.ts'] },
  { kind: 'child-path-resolver', name: 'packWorkerChildPath', allowed: ['backend/packs/pack-worker.ts'] },
  { kind: 'launcher-setter', name: 'setDocWorkerForkFn', allowed: ['backend/ingest/doc-worker.ts', 'index.ts'] },
  { kind: 'launcher-setter', name: 'setXlsxWorkerForkFn', allowed: ['backend/ingest/xlsx-worker.ts', 'index.ts'] },
  { kind: 'launcher-setter', name: 'setPackWorkerForkFn', allowed: ['backend/packs/pack-worker.ts', 'index.ts'] },
];

/** One INV-4 hit: a runtime naming of a launch-surface capability. */
interface LaunchSurfaceHit {
  file: string;
  /** The rule's name (basename or identifier). */
  name: string;
  /** (a): `string`, `template` (no-substitution), `template-part` (head/middle/tail quasi); (b)/(c): the INV-3 reference form. */
  form: string;
  /** Whitespace-collapsed text of the anchoring node (at most 80 chars). */
  fragment: string;
}

/** INV-4 over one source: hits outside their rule's allowed files (findings) and inside them (permitted). */
function launchSurfaceInSource(source: string, fileRel: string): { findings: LaunchSurfaceHit[]; permitted: LaunchSurfaceHit[] } {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const findings: LaunchSurfaceHit[] = [];
  const permitted: LaunchSurfaceHit[] = [];
  const record = (rule: LaunchSurfaceRule, form: string, fragment: string): void => {
    const hit: LaunchSurfaceHit = { file: fileRel, name: rule.name, form, fragment };
    (rule.allowed.some((a) => moduleStem(a) === moduleStem(fileRel)) ? permitted : findings).push(hit);
  };
  const text = (node: ts.Node): string => node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80);
  // (a) — cooked literal text, specifier positions of import/export/import-equals declarations excluded.
  const basenameRules = LAUNCH_SURFACE_RULES.filter((r) => r.kind === 'child-basename');
  const isDeclarationSpecifier = (node: ts.Node): boolean => {
    const p = node.parent;
    return ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) || ts.isExternalModuleReference(p);
  };
  const visit = (node: ts.Node): void => {
    if (isTypeOnlyPosition(node)) return;
    let form: string | null = null;
    let anchor: ts.Node = node.parent;
    if (ts.isStringLiteral(node)) form = 'string';
    else if (ts.isNoSubstitutionTemplateLiteral(node)) form = 'template';
    else if (ts.isTemplateHead(node)) {
      form = 'template-part';
      anchor = node.parent; // the TemplateExpression
    } else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      form = 'template-part';
      anchor = node.parent.parent; // TemplateSpan -> TemplateExpression
    }
    if (form !== null && !isDeclarationSpecifier(node)) {
      const cooked = (node as ts.LiteralLikeNode).text.toLowerCase();
      for (const rule of basenameRules) {
        if (cooked.includes(rule.name)) record(rule, form, text(anchor));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // (b) / (c) — the INV-3 runtime-reference walk over the resolver and setter names.
  const nameRules = LAUNCH_SURFACE_RULES.filter((r) => r.kind !== 'child-basename');
  for (const ref of runtimeNameReferencesInSource(source, fileRel, nameRules.map((r) => r.name))) {
    const rule = nameRules.find((r) => r.name === ref.name);
    if (rule !== undefined) record(rule, ref.form, ref.fragment);
  }
  return { findings, permitted };
}

/** INV-4 over files: every finding and every permitted hit, sorted (file, name, form, fragment). */
function launchSurfaceOf(files: string[]): { findings: LaunchSurfaceHit[]; permitted: LaunchSurfaceHit[] } {
  const per = files.map((file) => launchSurfaceInSource(fs.readFileSync(file, 'utf8'), relToMain(file)));
  const key = (h: LaunchSurfaceHit): string => `${h.file}\u0000${h.name}\u0000${h.form}\u0000${h.fragment}`;
  const order = (a: LaunchSurfaceHit, b: LaunchSurfaceHit): number => key(a).localeCompare(key(b));
  return {
    findings: per.flatMap((r) => r.findings).sort(order),
    permitted: per.flatMap((r) => r.permitted).sort(order),
  };
}

// ---- INV-5 frozen owner world (amendments (o)/(p)/(q), round 6 — plan Revision 7) -------
//
// Round 6 executed owner-exported capability aliases past INV-1..INV-4: an
// owner can hand its resolver, its launcher setter or a bound parser entry
// to another main module under a NEW name, and the consumer then contains
// none of the policed names. A name rule cannot close renames, so INV-5
// freezes the world AROUND the owners instead: their export surfaces (5a),
// every import edge into them (5b) and every in-process worker launch (5c).
// All three operate on a TREE (main-relative path -> source text), so the
// legs below scan the real desktop/main tree and the self-tests mutate it.

/**
 * The seed owners whose capability exports are frozen (INV-5a). Round 7
 * (SRC-1) adds the reranker pair: they own the ONLY in-process execution
 * capability in desktop/main (worker_threads + new Worker), so their export
 * surfaces and importer edges join the frozen world.
 */
const INV5_SEED_OWNERS = [
  'backend/ingest/xlsx-worker.ts',
  'backend/ingest/xlsx-worker-child.ts',
  'backend/packs/pack-extract.ts',
  'backend/retrieval/reranker.ts',
  'backend/retrieval/rerank-worker.ts',
];

/**
 * The planned owners: absent at base (vacuous), exact-frozen once they exist.
 * The pack pair joins by the AC_CHANGED_BY_USER amendment of 2026-11-09.
 */
const INV5_PLANNED_OWNERS = [
  'backend/ingest/doc-worker.ts',
  'backend/ingest/doc-worker-child.ts',
  'backend/packs/pack-worker.ts',
  'backend/packs/pack-extract-child.ts',
];

/**
 * The owner re-export closure captured at base 5d1f7338: the seeds (round 6:
 * the two xlsx modules + pack-extract.ts; round 7 / SRC-1: the reranker pair)
 * plus packs/zip-install.ts (16 runtime pack-extract bindings re-exported;
 * its 5 `type`-marked re-exports are elided and do not taint). Nothing
 * re-exports a zip-install, reranker or rerank-worker binding, so the closure
 * stops there. Any module JOINING (a new re-export of an owner binding) or
 * LEAVING is an INV-5a finding.
 */
const FROZEN_OWNER_CLOSURE = [
  'backend/ingest/xlsx-worker-child.ts',
  'backend/ingest/xlsx-worker.ts',
  'backend/packs/pack-extract.ts',
  'backend/packs/zip-install.ts',
  'backend/retrieval/rerank-worker.ts',
  'backend/retrieval/reranker.ts',
];

/**
 * INV-5a: each owner's RUNTIME exported names, captured at base for the four
 * existing owners and frozen from the plan for the two planned ones (the doc
 * runner mirrors the xlsx runner's base surface with doc names; the doc child
 * exports exactly the union this spec itself imports from it). Type /
 * interface / type-alias exports and `type`-marked specifiers are excluded
 * (elided at compile time).
 */
const FROZEN_RUNTIME_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  'backend/ingest/xlsx-worker.ts': [
    'DEFAULT_XLSX_TIMEOUT_MS',
    'extractXlsxOutOfProcess',
    'nodeForkXlsxWorker',
    'resolveXlsxWorkerForkFn',
    'setXlsxWorkerForkFn',
    'terminateXlsxWorkers',
    'xlsxWorkerChildPath',
  ],
  'backend/ingest/xlsx-worker-child.ts': [
    'XLSX_WORKER_ERROR_PREFIX',
    'assertZipWithinCapInChild',
    'parseWorkbookToCsv',
    'runXlsxChildMain',
  ],
  'backend/packs/pack-extract.ts': [
    'DEFAULT_PACKS_MAX_COMPRESSION_RATIO',
    'DEFAULT_PACKS_MAX_ENTRIES',
    'DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES',
    'DEFAULT_PACK_EMBEDDING_MODEL_ID',
    'PACKS_EMBEDDING_MODEL_ID_ENV',
    'PACKS_MAX_COMPRESSION_RATIO_ENV',
    'PACKS_MAX_ENTRIES_ENV',
    'PACKS_MAX_UNCOMPRESSED_BYTES_ENV',
    'PACKS_REQUIRE_SIGNATURE_ENV',
    'PACKS_TRUSTED_KEYS_ENV',
    'canonicalManifestBytes',
    'duplicateTrustedKeyId',
    'enforceDeclaredLimits',
    'ensureContained',
    'extractPackZip',
    'isSymlinkEntry',
    'isZipFilename',
    'modelIdMatches',
    'parseZip32CentralDirectory',
    'resolvePackLimits',
    'resolvePacksSecurity',
    'safeEntryName',
    'verifyPackSignature',
  ],
  'backend/packs/zip-install.ts': [
    'DEFAULT_PACKS_MAX_COMPRESSION_RATIO',
    'DEFAULT_PACKS_MAX_ENTRIES',
    'DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES',
    'DEFAULT_PACK_EMBEDDING_MODEL_ID',
    'canonicalManifestBytes',
    'enforceDeclaredLimits',
    'ensureContained',
    'extractPackZip',
    'isSymlinkEntry',
    'isZipFilename',
    'modelIdMatches',
    'parseZip32CentralDirectory',
    'resolvePackLimits',
    'resolvePacksSecurity',
    'safeEntryName',
    'verifyPackSignature',
  ],
  'backend/ingest/doc-worker.ts': [
    'DEFAULT_DOC_TIMEOUT_MS',
    'docWorkerChildPath',
    'extractDocOutOfProcess',
    'nodeForkDocWorker',
    'resolveDocWorkerForkFn',
    'setDocWorkerForkFn',
    'terminateDocWorkers',
  ],
  'backend/ingest/doc-worker-child.ts': ['DOC_WORKER_ERROR_PREFIX', 'runDocChildMain'],
  // AC_CHANGED_BY_USER 2026-11-09: the planned pack pair. The pack runner
  // mirrors the xlsx runner's 7-name base surface with pack names (the same
  // doc-mirror rule; the runtime extraction export extractPackZipOutOfProcess
  // is the bridge pack-extract.ts consumes — the separate frozen C3 spec
  // pins the behavioural contract); the pack child exports exactly the union
  // the C3 spec imports from it.
  'backend/packs/pack-worker.ts': [
    'DEFAULT_PACK_TIMEOUT_MS',
    'extractPackZipOutOfProcess',
    // Revision 23 (recorded CHECK_WRONG sync with C3): the test-control
    // options variant joined the runner's frozen surface as the 8th name.
    'extractPackZipWithOptions',
    'nodeForkPackWorker',
    'packWorkerChildPath',
    'resolvePackWorkerForkFn',
    'setPackWorkerForkFn',
    'terminatePackWorkers',
  ],
  'backend/packs/pack-extract-child.ts': ['PACK_WORKER_ERROR_PREFIX', 'runPackChildMain'],
  // Round 7 / SRC-1: the reranker pair joins the owner world. reranker.ts's
  // base surface is its 8 runtime exports (the `export type {
  // RerankerSurface }` re-export and the RerankerRunnerOptions /
  // WorkerMemoryReport / ResolveRerankerOptions interfaces are type-only and
  // excluded); rerank-worker.ts is a process entry point with NO runtime
  // exports. Frozen at base 5d1f7338 — `export { Worker }` is an export-added.
  'backend/retrieval/reranker.ts': [
    'DEFAULT_RERANKER_MODEL_SUBPATH',
    'RERANKER_MODEL_DIR_ENV',
    'RERANKER_WEIGHTS_MIN_BYTES',
    'ResumableReranker',
    'STAGED_RERANKER_WEIGHTS_MIN_BYTES',
    'WorkerEmbedder',
    'WorkerReranker',
    'resolveRerankerModelDir',
  ],
  'backend/retrieval/rerank-worker.ts': [],
};

/**
 * INV-5b: every (importer, binding) edge into an existing owner, captured at
 * base 5d1f7338. `*` is a namespace import or any call-form load (the whole
 * module namespace is handed out) — extractors.ts's dynamic
 * `import('./xlsx-worker.js')` at :176 is the base `*` edge. zip-install.ts's
 * 16 runtime re-exports are pack-extract's biggest consumer block.
 */
const FROZEN_IMPORT_EDGES: Readonly<Record<string, ReadonlyArray<{ file: string; binding: string }>>> = {
  'backend/ingest/xlsx-worker.ts': [
    { file: 'backend/index.ts', binding: 'terminateXlsxWorkers' },
    { file: 'backend/ingest/extractors.ts', binding: '*' },
    { file: 'index.ts', binding: 'setXlsxWorkerForkFn' },
  ],
  'backend/ingest/xlsx-worker-child.ts': [{ file: 'backend/ingest/xlsx-worker.ts', binding: 'XLSX_WORKER_ERROR_PREFIX' }],
  'backend/packs/pack-extract.ts': [
    { file: 'backend/dev-server.ts', binding: 'resolvePacksSecurity' },
    { file: 'backend/index.ts', binding: 'resolvePacksSecurity' },
    { file: 'backend/packs/zip-install.ts', binding: 'DEFAULT_PACK_EMBEDDING_MODEL_ID' },
    { file: 'backend/packs/zip-install.ts', binding: 'DEFAULT_PACKS_MAX_COMPRESSION_RATIO' },
    { file: 'backend/packs/zip-install.ts', binding: 'DEFAULT_PACKS_MAX_ENTRIES' },
    { file: 'backend/packs/zip-install.ts', binding: 'DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES' },
    { file: 'backend/packs/zip-install.ts', binding: 'canonicalManifestBytes' },
    { file: 'backend/packs/zip-install.ts', binding: 'enforceDeclaredLimits' },
    { file: 'backend/packs/zip-install.ts', binding: 'ensureContained' },
    { file: 'backend/packs/zip-install.ts', binding: 'extractPackZip' },
    { file: 'backend/packs/zip-install.ts', binding: 'isSymlinkEntry' },
    { file: 'backend/packs/zip-install.ts', binding: 'isZipFilename' },
    { file: 'backend/packs/zip-install.ts', binding: 'modelIdMatches' },
    { file: 'backend/packs/zip-install.ts', binding: 'parseZip32CentralDirectory' },
    { file: 'backend/packs/zip-install.ts', binding: 'resolvePackLimits' },
    { file: 'backend/packs/zip-install.ts', binding: 'resolvePacksSecurity' },
    { file: 'backend/packs/zip-install.ts', binding: 'safeEntryName' },
    { file: 'backend/packs/zip-install.ts', binding: 'verifyPackSignature' },
    { file: 'backend/store/pack-manager.ts', binding: 'modelIdMatches' },
    { file: 'backend/store/pack-manager.ts', binding: 'resolvePacksSecurity' },
    { file: 'backend/store/pack-manager.ts', binding: 'verifyPackSignature' },
  ],
  'backend/packs/zip-install.ts': [{ file: 'backend/packs/surface.ts', binding: 'extractPackZip' }],
  // Round 7 / SRC-1: reranker.ts has exactly ONE base importer —
  // backend/index.ts:47-54 (the four VALUE bindings below; its `type
  // RerankerSurface` / `type WorkerMemoryReport` elements are type-only and
  // excluded). rerank-worker.ts has NO importers (it is spawned by path from
  // reranker.ts's defaultWorkerPath, which is a string, not a module edge).
  'backend/retrieval/reranker.ts': [
    { file: 'backend/index.ts', binding: 'ResumableReranker' },
    { file: 'backend/index.ts', binding: 'WorkerEmbedder' },
    { file: 'backend/index.ts', binding: 'WorkerReranker' },
    { file: 'backend/index.ts', binding: 'resolveRerankerModelDir' },
  ],
  'backend/retrieval/rerank-worker.ts': [],
};

/**
 * INV-5b: the Revision 7 planned edges, required only once their owner file
 * exists (excused while the planned owner is absent — the "absent OR exact
 * list" rule). No existing owner gains a planned edge: the fix must not add
 * new consumers of the xlsx runner, the children or the packs owners.
 */
const PLANNED_IMPORT_EDGES: Readonly<Record<string, ReadonlyArray<{ file: string; binding: string }>>> = {
  'backend/ingest/doc-worker.ts': [
    { file: 'backend/index.ts', binding: 'terminateDocWorkers' },
    { file: 'backend/ingest/extractors.ts', binding: 'extractDocOutOfProcess' },
    { file: 'index.ts', binding: 'setDocWorkerForkFn' },
  ],
  'backend/ingest/doc-worker-child.ts': [{ file: 'backend/ingest/doc-worker.ts', binding: 'DOC_WORKER_ERROR_PREFIX' }],
  // AC_CHANGED_BY_USER 2026-11-09: the pack migration's planned edges. The
  // bridge (pack-extract.ts -> extractPackZipOutOfProcess) is the pack
  // analogue of extractors.ts -> extractDocOutOfProcess; pack-extract.ts is
  // itself an owner, and the edge is INTO the new planned owner pack-worker.ts,
  // so no EXISTING owner gains a planned consumer.
  'backend/packs/pack-worker.ts': [
    { file: 'backend/index.ts', binding: 'terminatePackWorkers' },
    { file: 'backend/packs/pack-extract.ts', binding: 'extractPackZipOutOfProcess' },
    { file: 'index.ts', binding: 'setPackWorkerForkFn' },
  ],
  'backend/packs/pack-extract-child.ts': [{ file: 'backend/packs/pack-worker.ts', binding: 'PACK_WORKER_ERROR_PREFIX' }],
};

/** INV-5c: the ONLY files allowed to load worker_threads or construct a Worker. */
const INV5C_ALLOWED = ['backend/retrieval/reranker.ts', 'backend/retrieval/rerank-worker.ts'];

/** Every RUNTIME exported name of one source (INV-5a), sorted (default code-unit order). */
function runtimeExportNamesInSource(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const names = new Set<string>();
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);
  const boundNames = (name: ts.Node): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) boundNames(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
      for (const declaration of node.declarationList.declarations) boundNames(declaration.name);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
      !hasModifier(node, ts.SyntaxKind.DeclareKeyword)
    ) {
      // `export default function f() {}` / `export default class C {}` export
      // the DEFAULT binding — the declaration's own name is NOT an export.
      if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (node.name !== undefined) {
        names.add(node.name.text);
        // A namespace's INNER exports are reachable only through the namespace
        // binding (ns.X), so they are not part of the module-level surface.
        if (ts.isModuleDeclaration(node)) return;
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.exportClause === undefined) names.add('*');
      else if (ts.isNamespaceExport(node.exportClause)) names.add(node.exportClause.name.text);
      else for (const element of node.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text);
    } else if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
      // `export default <expression>` (an `export =` assignment is not a default export).
      names.add('default');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...names].sort();
}

/**
 * One re-export declaration that hands owner bindings outward (INV-5a taint):
 * the resolved target module STEM (null for bare packages / builtins /
 * computed) and the SOURCE names it hands out ('*' for `export *` and
 * `export * as ns`). Type-only re-export declarations and `type`-marked
 * elements are elided and do not taint.
 */
function reExportTaintsInSource(source: string, fileRel: string): Array<{ target: string | null; names: string[] }> {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const taints: Array<{ target: string | null; names: string[] }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && !node.isTypeOnly) {
      const names: string[] = [];
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      } else {
        names.push('*');
      }
      taints.push({ target: resolveMainSpecifier(fileRel, staticSpecifier(node.moduleSpecifier, sf)), names });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return taints;
}

/** The desktop/main tree as a (main-relative path -> source) map. */
function treeOfFiles(files: string[]): Map<string, string> {
  return new Map(files.map((file) => [relToMain(file), fs.readFileSync(file, 'utf8')] as const));
}

/** The owner closure over a tree: seeds plus every module re-exporting an owner binding, sorted. */
function inv5ClosureOfTree(tree: ReadonlyMap<string, string>): string[] {
  const relOfStem = new Map<string, string>([...tree.keys()].map((rel) => [moduleStem(rel), rel] as const));
  const owners = new Set<string>(INV5_SEED_OWNERS.map(moduleStem));
  const taint = new Map<string, Set<string>>();
  for (const stem of owners) {
    const rel = relOfStem.get(stem);
    taint.set(stem, new Set(rel === undefined ? [] : runtimeExportNamesInSource(tree.get(rel) ?? '', rel)));
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [rel, source] of tree) {
      const stem = moduleStem(rel);
      if (owners.has(stem)) continue;
      for (const edge of reExportTaintsInSource(source, rel)) {
        if (edge.target === null || !taint.has(edge.target)) continue;
        const tainted = taint.get(edge.target);
        if (tainted === undefined) continue;
        const hits = edge.names.includes('*') ? [...tainted] : edge.names.filter((name) => tainted.has(name));
        if (hits.length > 0) {
          owners.add(stem);
          const mine = taint.get(stem) ?? new Set<string>();
          for (const hit of hits) mine.add(hit);
          taint.set(stem, mine);
          grew = true;
        }
      }
    }
  }
  return [...owners].map((stem) => relOfStem.get(stem) ?? stem).sort();
}

/** One INV-5a finding: the closure changed, or an owner's export surface drifted. */
interface Inv5aFinding {
  kind: 'closure-added' | 'closure-missing' | 'owner-missing' | 'export-added' | 'export-missing';
  /** The owner (main-relative). */
  owner: string;
  /** The export name, for export-added / export-missing. */
  name?: string;
}

/** INV-5a over a tree: every closure / export-surface difference from the frozen lists. */
function inv5aFindingsOfTree(tree: ReadonlyMap<string, string>): Inv5aFinding[] {
  const findings: Inv5aFinding[] = [];
  const relOfStem = new Map<string, string>([...tree.keys()].map((rel) => [moduleStem(rel), rel] as const));
  const closureStems = new Set(inv5ClosureOfTree(tree).map(moduleStem));
  const frozenStems = new Set(FROZEN_OWNER_CLOSURE.map(moduleStem));
  for (const stem of closureStems) {
    if (!frozenStems.has(stem)) findings.push({ kind: 'closure-added', owner: relOfStem.get(stem) ?? stem });
  }
  for (const owner of FROZEN_OWNER_CLOSURE) {
    if (!closureStems.has(moduleStem(owner))) findings.push({ kind: 'closure-missing', owner });
  }
  for (const owner of [...FROZEN_OWNER_CLOSURE, ...INV5_PLANNED_OWNERS]) {
    const rel = relOfStem.get(moduleStem(owner));
    if (rel === undefined) {
      // A planned owner may not exist yet (vacuous); a base owner must.
      if (!INV5_PLANNED_OWNERS.some((o) => moduleStem(o) === moduleStem(owner))) findings.push({ kind: 'owner-missing', owner });
      continue;
    }
    const names = runtimeExportNamesInSource(tree.get(rel) ?? '', rel);
    const frozen = FROZEN_RUNTIME_EXPORTS[owner] ?? [];
    for (const name of names) if (!frozen.includes(name)) findings.push({ kind: 'export-added', owner, name });
    for (const name of frozen) if (!names.includes(name)) findings.push({ kind: 'export-missing', owner, name });
  }
  return findings.sort((a, b) => `${a.owner}\u0000${a.kind}\u0000${a.name ?? ''}`.localeCompare(`${b.owner}\u0000${b.kind}\u0000${b.name ?? ''}`));
}

/** One runtime module edge out of a source (INV-5b), target = resolved module stem (null for bare/computed). */
interface ModuleImportEdge {
  target: string | null;
  /** The SOURCE binding taken from the target ('default', '*', a named binding, '<side-effect>', or an import-equals local). */
  binding: string;
  form: string;
  fragment: string;
}

/**
 * Every runtime import edge of one source: static named / default / namespace
 * imports, side-effect imports, re-export lists (`export { x } from`,
 * `export *`, `export * as ns` — by SOURCE name), import-equals, and every
 * call-form load the (h) inventory finds (binding '*'). Type-only edges are
 * excluded; specifiers resolve with the INV-1 path resolution.
 */
function moduleImportEdgesInSource(source: string, fileRel: string): ModuleImportEdge[] {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const edges: ModuleImportEdge[] = [];
  const add = (node: ts.Node, specifier: string, binding: string, form: string): void => {
    edges.push({
      target: resolveMainSpecifier(fileRel, specifier),
      binding,
      form,
      fragment: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !importIsTypeOnly(node)) {
      const specifier = staticSpecifier(node.moduleSpecifier, sf);
      const clause = node.importClause;
      if (clause === undefined) add(node, specifier, '<side-effect>', 'import');
      else {
        if (clause.name !== undefined) add(node, specifier, 'default', 'import');
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) add(node, specifier, '*', 'import');
          else {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) add(element, specifier, (element.propertyName ?? element.name).text, 'import');
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && !node.isTypeOnly) {
      const specifier = staticSpecifier(node.moduleSpecifier, sf);
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (!element.isTypeOnly) add(element, specifier, (element.propertyName ?? element.name).text, 'export-from');
        }
      } else {
        add(node, specifier, '*', 'export-from');
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, staticSpecifier(node.moduleReference.expression, sf), node.name.text, 'import=require');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const site of loadSitesInSource(source, fileRel)) {
    if (site.form === 'import' || site.form === 'export-from' || site.form === 'import=require') continue;
    edges.push({ target: resolveMainSpecifier(fileRel, site.specifier), binding: '*', form: site.form, fragment: site.fragment });
  }
  return edges;
}

/** One INV-5b finding: a NEW consumer/binding of an owner, or a frozen edge that vanished. */
interface Inv5bFinding {
  kind: 'edge-added' | 'edge-missing';
  owner: string;
  file: string;
  binding: string;
}

/** INV-5b over a tree: every import-edge difference from the frozen + planned lists. */
function inv5bFindingsOfTree(tree: ReadonlyMap<string, string>): Inv5bFinding[] {
  const findings: Inv5bFinding[] = [];
  const relOfStem = new Map<string, string>([...tree.keys()].map((rel) => [moduleStem(rel), rel] as const));
  const ownerStems = new Set([...inv5ClosureOfTree(tree), ...INV5_PLANNED_OWNERS].map(moduleStem));
  const computed = new Map<string, Set<string>>();
  for (const [rel, source] of tree) {
    for (const edge of moduleImportEdgesInSource(source, rel)) {
      if (edge.target === null || !ownerStems.has(edge.target)) continue;
      const ownerRel = relOfStem.get(edge.target) ?? edge.target;
      const key = `${rel}\u0000${edge.binding}`;
      (computed.get(ownerRel) ?? computed.set(ownerRel, new Set<string>()).get(ownerRel)!).add(key);
    }
  }
  for (const owner of [...FROZEN_OWNER_CLOSURE, ...INV5_PLANNED_OWNERS]) {
    const ownerExists = relOfStem.has(moduleStem(owner));
    const allowed = new Map<string, 'frozen' | 'planned'>();
    for (const edge of FROZEN_IMPORT_EDGES[owner] ?? []) allowed.set(`${edge.file}\u0000${edge.binding}`, 'frozen');
    for (const edge of PLANNED_IMPORT_EDGES[owner] ?? []) allowed.set(`${edge.file}\u0000${edge.binding}`, 'planned');
    const seen = computed.get(owner) ?? new Set<string>();
    for (const key of seen) {
      if (!allowed.has(key)) {
        const [file, binding] = key.split('\u0000');
        findings.push({ kind: 'edge-added', owner, file, binding });
      }
    }
    for (const [key, origin] of allowed) {
      if (seen.has(key)) continue;
      if (!ownerExists && origin === 'planned') continue; // planned edge excused while the owner is absent
      const [file, binding] = key.split('\u0000');
      findings.push({ kind: 'edge-missing', owner, file, binding });
    }
  }
  return findings.sort((a, b) =>
    `${a.owner}\u0000${a.kind}\u0000${a.file}\u0000${a.binding}`.localeCompare(`${b.owner}\u0000${b.kind}\u0000${b.file}\u0000${b.binding}`),
  );
}

/** One INV-5c site: a worker_threads load or a `new Worker(` construction. */
interface Inv5cSite {
  file: string;
  kind: 'worker-threads-load' | 'worker-construction';
  /** The load form ('import', 'import()', 'require()', ...) or the construction form ('identifier', 'dot', 'element'). */
  form: string;
  fragment: string;
}

/**
 * Every worker_threads load (any form the load inventory recognises — static
 * import, export-from, import-equals, dynamic import(), require and every
 * alias/member form) and every `new Worker(` construction (bare identifier,
 * dot or literal-element callee) in one source.
 */
function inv5cSitesInSource(source: string, fileRel: string): Inv5cSite[] {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const sites: Inv5cSite[] = [];
  for (const site of loadSitesInSource(source, fileRel)) {
    if (site.specifier === 'worker_threads' || site.specifier === 'node:worker_threads') {
      sites.push({ file: fileRel, kind: 'worker-threads-load', form: site.form, fragment: site.fragment });
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression === undefined ? null : unwrapExpression(node.expression);
      let form: string | null = null;
      if (callee !== null) {
        if (ts.isIdentifier(callee) && callee.text === 'Worker') form = 'identifier';
        else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Worker') form = 'dot';
        else if (ts.isElementAccessExpression(callee) && staticSpecifier(callee.argumentExpression, sf) === 'Worker') form = 'element';
      }
      if (form !== null) {
        sites.push({ file: fileRel, kind: 'worker-construction', form, fragment: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** INV-5c over a tree: every site OUTSIDE the allowed reranker pair (no allowlist). */
function inv5cFindingsOfTree(tree: ReadonlyMap<string, string>): Inv5cSite[] {
  const out: Inv5cSite[] = [];
  for (const [rel, source] of tree) {
    if (INV5C_ALLOWED.some((a) => moduleStem(a) === moduleStem(rel))) continue;
    out.push(...inv5cSitesInSource(source, rel));
  }
  return out.sort((a, b) => `${a.file}\u0000${a.kind}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.kind}\u0000${b.form}\u0000${b.fragment}`));
}

/** INV-5c anti-vacuity: the sites INSIDE the allowed pair (the base pair is non-empty). */
function inv5cPermittedOfTree(tree: ReadonlyMap<string, string>): Inv5cSite[] {
  const out: Inv5cSite[] = [];
  for (const [rel, source] of tree) {
    if (!INV5C_ALLOWED.some((a) => moduleStem(a) === moduleStem(rel))) continue;
    out.push(...inv5cSitesInSource(source, rel));
  }
  return out.sort((a, b) => `${a.file}\u0000${a.kind}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.kind}\u0000${b.form}\u0000${b.fragment}`));
}

// ---- SRC-1 in-process execution sources + SRC-2 no-laundering (amendments ---
// (r)/(s), round 7 — plan Revision 8) ------------------------------------------
//
// Round 7 executed two escapes past INV-5: a LOCAL renamed re-export of an
// imported owner binding (surface.ts / index.ts) and a Worker-capability
// export from the INV-5c-allowed reranker pair. Revision 8 closes the
// sources instead of the paths (the two-source argument, header note above):
// SRC-1 confines every in-process-execution capability (the reranker pair
// joins the INV-5 owner world; the workerPath option key is confined to
// reranker.ts; vm loads, eval/Function runtime references, process.dlopen
// references and CJS-internal accesses on module-package bindings are
// allowed NOWHERE), and SRC-2 bans re-exporting an owner binding from a
// permitted consumer under ANY name.

/** SRC-1: the construction-capability names whose RUNTIME references are allowed nowhere. */
const SRC1_EVAL_CONSTRUCTION_NAMES = ['eval', 'Function'] as const;

/** SRC-1: member names on module-package bindings / the `module` identifier that reach CJS internals. */
const SRC1_MODULE_INTERNAL_NAMES = ['_compile', '_load', 'wrap', '_resolveFilename', '_extensions', '_cache', 'prototype'] as const;

/** SRC-1: the ONLY file allowed a runtime reference to the `workerPath` script-path option key. */
const SRC1_WORKERPATH_ALLOWED = ['backend/retrieval/reranker.ts'];

/** One SRC-1 site: a vm load, an eval/Function runtime reference, a process.dlopen reference, a CJS-internal access, or a workerPath reference. */
interface Src1Site {
  file: string;
  kind: 'vm-load' | 'eval-construction' | 'dlopen' | 'module-internal' | 'worker-path';
  /** The load form ('import', 'import()', 'require()', ...), the reference form ('dot', 'element', 'key', 'binding', 'identifier'), `${dot|element} ${name}` for module-internal, or the reference form for worker-path. */
  form: string;
  fragment: string;
}

/**
 * Every SRC-1 site in one source. vm loads reuse the amendment-(h) load
 * inventory (every recognised form); eval / Function / workerPath reuse the
 * INV-3 runtime-reference walk (so calls, global-object literal-key members,
 * aliases, keys and destructuring all count, and TYPE positions do not);
 * process.dlopen is a dot / literal-element access whose receiver chain is
 * rooted at `process`; CJS internals are dot / literal-element accesses
 * named in SRC1_MODULE_INTERNAL_NAMES on a binding imported from
 * 'module' / 'node:module' (named / default / namespace / import-equals,
 * plus same-file const aliases) or on the unshadowed identifier `module`
 * (the loader walk's cheap scope-shadow rule).
 */
function inProcessExecSitesInSource(source: string, fileRel: string): Src1Site[] {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const sites: Src1Site[] = [];
  const text = (node: ts.Node): string => node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80);
  for (const site of loadSitesInSource(source, fileRel)) {
    if (site.specifier === 'vm' || site.specifier === 'node:vm') {
      sites.push({ file: fileRel, kind: 'vm-load', form: site.form, fragment: site.fragment });
    }
  }
  for (const ref of runtimeNameReferencesInSource(source, fileRel, SRC1_EVAL_CONSTRUCTION_NAMES)) {
    sites.push({ file: fileRel, kind: 'eval-construction', form: ref.form, fragment: ref.fragment });
  }
  // module-package bindings (every import shape + same-file const aliases).
  const moduleBindings = new Set<string>();
  const isModulePackageSpecifier = (spec: string): boolean => spec === 'module' || spec === 'node:module';
  const aliasInits: Array<{ local: string; init: ts.Expression }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = staticSpecifier(node.moduleSpecifier, sf);
      const clause = node.importClause;
      if (spec !== COMPUTED && isModulePackageSpecifier(spec) && clause !== undefined && !clause.isTypeOnly) {
        if (clause.name !== undefined) moduleBindings.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) moduleBindings.add(bindings.name.text);
          else for (const element of bindings.elements) if (!element.isTypeOnly) moduleBindings.add(element.name.text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = staticSpecifier(node.moduleReference.expression, sf);
      if (spec !== COMPUTED && isModulePackageSpecifier(spec)) moduleBindings.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      aliasInits.push({ local: node.name.text, init: node.initializer });
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { local, init } of aliasInits) {
      const e = unwrapExpression(init);
      if (ts.isIdentifier(e) && moduleBindings.has(e.text) && !moduleBindings.has(local)) {
        moduleBindings.add(local);
        grew = true;
      }
    }
  }
  const moduleShadowedAt = (id: ts.Identifier): boolean => {
    for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
      if (isScopeOwnerForModuleShadow(scope) && scopeDeclaresModule(scope)) return true;
    }
    return false;
  };
  const receiverBase = (e: ts.Expression): string | null => {
    const u = unwrapExpression(e);
    if (ts.isIdentifier(u)) return u.text;
    if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) return receiverBase(u.expression);
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (isTypeOnlyPosition(node)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticSpecifier(node.argumentExpression, sf);
      const receiver = unwrapExpression(node.expression);
      const accessForm = ts.isPropertyAccessExpression(node) ? 'dot' : 'element';
      if (name === 'dlopen' && receiverBase(receiver) === 'process') {
        sites.push({ file: fileRel, kind: 'dlopen', form: accessForm, fragment: text(node) });
      }
      if ((SRC1_MODULE_INTERNAL_NAMES as readonly string[]).includes(name)) {
        const onModuleBinding = ts.isIdentifier(receiver) && moduleBindings.has(receiver.text);
        const onModuleIdentifier = ts.isIdentifier(receiver) && receiver.text === 'module' && !moduleShadowedAt(receiver);
        if (onModuleBinding || onModuleIdentifier) {
          sites.push({ file: fileRel, kind: 'module-internal', form: `${accessForm} ${name}`, fragment: text(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const ref of runtimeNameReferencesInSource(source, fileRel, ['workerPath'])) {
    sites.push({ file: fileRel, kind: 'worker-path', form: ref.form, fragment: ref.fragment });
  }
  return sites;
}

/** SRC-1 over a tree: every site OUTSIDE its allowed set (vm / eval / Function / dlopen / Module internals: allowed NOWHERE; workerPath: only reranker.ts). */
function src1FindingsOfTree(tree: ReadonlyMap<string, string>): Src1Site[] {
  const out: Src1Site[] = [];
  for (const [rel, source] of tree) {
    const workerPathAllowed = SRC1_WORKERPATH_ALLOWED.some((a) => moduleStem(a) === moduleStem(rel));
    for (const site of inProcessExecSitesInSource(source, rel)) {
      if (site.kind === 'worker-path' && workerPathAllowed) continue;
      out.push(site);
    }
  }
  return out.sort((a, b) => `${a.file}\u0000${a.kind}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.kind}\u0000${b.form}\u0000${b.fragment}`));
}

/** SRC-1 anti-vacuity: the workerPath references INSIDE reranker.ts (the base file uses the key). */
function src1PermittedOfTree(tree: ReadonlyMap<string, string>): Src1Site[] {
  const out: Src1Site[] = [];
  for (const [rel, source] of tree) {
    if (!SRC1_WORKERPATH_ALLOWED.some((a) => moduleStem(a) === moduleStem(rel))) continue;
    for (const site of inProcessExecSitesInSource(source, rel)) {
      if (site.kind === 'worker-path') out.push(site);
    }
  }
  return out.sort((a, b) => `${a.file}\u0000${a.kind}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.kind}\u0000${b.form}\u0000${b.fragment}`));
}

/** One SRC-2 finding: a non-owner module runtime-exports an owner binding under any name. */
interface Src2Finding {
  /** `re-export-alias` (an export list entry, an exported alias initializer, or an export-from name), `re-export-default`, `re-export-namespace` (`export *` / `export * as ns` of an owner). */
  kind: 're-export-alias' | 're-export-default' | 're-export-namespace';
  /** The laundering module (main-relative; NEVER an owner file — owner surfaces are INV-5a's). */
  file: string;
  /** The owner whose binding is handed out (main-relative). */
  owner: string;
  /** The PUBLIC export name the capability is given ('default' for a default export, '*' for a bare `export *`). */
  name: string;
  fragment: string;
}

/**
 * SRC-2 over a tree (amendment (s), round 7 — plan Revision 8): for every
 * runtime module edge (importer M, owner O, binding B) — the INV-5b world,
 * computed from the tree, frozen and planned edges alike — M may not
 * runtime-export B under ANY name. Local export lists (`export { B as x }`),
 * exported alias initializers (`export const x = B`, through `as` casts and
 * parens), `export default B`, members of an owner namespace
 * (`export default ns.cap`), destructured load results and every export-from
 * of an owner (`export { ... } from`, `export *`, `export * as ns`) are
 * findings. OWNER files are exempt (INV-5a freezes their surfaces —
 * zip-install.ts's sanctioned re-exports are not re-flagged); type-only
 * exports are exempt (elided); hand-written wrappers are deliberately not
 * flagged (header note (s), as AMENDED in round 8: a launch-control wrapper
 * is harmless only because SRC-1/SRC-3/SRC-4 close the in-process sources).
 */
function src2FindingsOfTree(tree: ReadonlyMap<string, string>): Src2Finding[] {
  const findings: Src2Finding[] = [];
  const relOfStem = new Map<string, string>([...tree.keys()].map((rel) => [moduleStem(rel), rel] as const));
  const ownerStems = new Set([...inv5ClosureOfTree(tree), ...INV5_PLANNED_OWNERS].map(moduleStem));
  const ownerOfSpecifier = (fileRel: string, sf: ts.SourceFile, specifierNode: ts.Expression | undefined): string | null => {
    const spec = staticSpecifier(specifierNode, sf);
    if (spec === COMPUTED) return null;
    const stem = resolveMainSpecifier(fileRel, spec);
    return stem !== null && ownerStems.has(stem) ? relOfStem.get(stem) ?? stem : null;
  };
  for (const [rel, source] of tree) {
    if (ownerStems.has(moduleStem(rel))) continue; // owners: INV-5a's frozen surfaces
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
    const text = (node: ts.Node): string => node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80);
    const ownerLocals = new Map<string, string>();
    // The load-call classifier needs the amendment-(h) inventory's require /
    // createRequire alias fixpoint (its pass 1), so a namespace obtained via
    // `require('./owner.js')` / `r('./owner.js')` / `await import(...)` and
    // then exported is caught too.
    const requireFns = new Set<string>(['require']);
    const createRequireFns = new Set<string>(['createRequire']);
    const isCreateRequireCallExpr = (e: ts.Expression): boolean => {
      if (!ts.isCallExpression(e)) return false;
      const callee = unwrapExpression(e.expression);
      return ts.isIdentifier(callee) && createRequireFns.has(callee.text);
    };
    const aliasBindings: Array<{ local: string; key?: string; init?: ts.Expression }> = [];
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        aliasBindings.push({ local: node.name.text, init: node.initializer });
      } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) aliasBindings.push({ local: node.name.text, key: key.text });
      } else if (ts.isImportSpecifier(node)) {
        aliasBindings.push({ local: node.name.text, key: (node.propertyName ?? node.name).text });
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sf);
    for (let grew = true; grew; ) {
      grew = false;
      for (const { local, key, init } of aliasBindings) {
        let target: Set<string> | null = null;
        if (key === 'require') target = requireFns;
        else if (key === 'createRequire') target = createRequireFns;
        else if (init !== undefined) {
          const e = unwrapExpression(init);
          if (isCreateRequireCallExpr(e)) target = requireFns;
          else if (ts.isIdentifier(e)) {
            if (requireFns.has(e.text)) target = requireFns;
            else if (createRequireFns.has(e.text)) target = createRequireFns;
          } else if (ts.isPropertyAccessExpression(e) && e.name.text === 'require') target = requireFns;
          else if (ts.isPropertyAccessExpression(e) && e.name.text === 'createRequire') target = createRequireFns;
        }
        if (target !== null && !target.has(local)) {
          target.add(local);
          grew = true;
        }
      }
    }
    const loadCallOwner = (call: ts.CallExpression): string | null => {
      const calleeNode = call.expression;
      if (calleeNode.kind === ts.SyntaxKind.ImportKeyword) return ownerOfSpecifier(rel, sf, call.arguments[0]);
      const callee = unwrapExpression(calleeNode);
      if (ts.isIdentifier(callee)) return requireFns.has(callee.text) ? ownerOfSpecifier(rel, sf, call.arguments[0]) : null;
      if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'require' ? ownerOfSpecifier(rel, sf, call.arguments[0]) : null;
      if (ts.isElementAccessExpression(callee)) {
        return staticSpecifier(callee.argumentExpression, sf) === 'require' ? ownerOfSpecifier(rel, sf, call.arguments[0]) : null;
      }
      if (ts.isCallExpression(callee) && isCreateRequireCallExpr(callee)) return ownerOfSpecifier(rel, sf, call.arguments[0]);
      return null;
    };
    // Pass A — owner locals: static imports, import-equals, and load-call results (whole namespaces and destructured members).
    const collectOwnerLocals = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && !importIsTypeOnly(node)) {
        const owner = ownerOfSpecifier(rel, sf, node.moduleSpecifier);
        if (owner !== null) {
          const clause = node.importClause;
          if (clause?.name !== undefined) ownerLocals.set(clause.name.text, owner);
          const bindings = clause?.namedBindings;
          if (bindings !== undefined) {
            if (ts.isNamespaceImport(bindings)) ownerLocals.set(bindings.name.text, owner);
            else for (const element of bindings.elements) if (!element.isTypeOnly) ownerLocals.set(element.name.text, owner);
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const owner = ownerOfSpecifier(rel, sf, node.moduleReference.expression);
        if (owner !== null) ownerLocals.set(node.name.text, owner);
      } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        let e = unwrapExpression(node.initializer);
        if (ts.isAwaitExpression(e)) e = unwrapExpression(e.expression);
        if (ts.isCallExpression(e)) {
          const owner = loadCallOwner(e);
          if (owner !== null) {
            if (ts.isIdentifier(node.name)) ownerLocals.set(node.name.text, owner);
            else if (ts.isObjectBindingPattern(node.name)) {
              for (const element of node.name.elements) {
                if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) ownerLocals.set(element.name.text, owner);
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectOwnerLocals);
    };
    collectOwnerLocals(sf);
    // Pass B — exports.
    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
      (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);
    const flag = (kind: Src2Finding['kind'], node: ts.Node, owner: string, name: string): void => {
      findings.push({ kind, file: rel, owner, name, fragment: text(node) });
    };
    const checkExportedExpression = (kind: Src2Finding['kind'], node: ts.Node, raw: ts.Expression, name: string): void => {
      let e = unwrapExpression(raw);
      if (ts.isAwaitExpression(e)) e = unwrapExpression(e.expression);
      if (ts.isIdentifier(e) && ownerLocals.has(e.text)) {
        flag(kind, node, ownerLocals.get(e.text) as string, name);
        return;
      }
      // a member of a namespace holder: export const x = ns.cap / export default ns.cap
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
        const base = unwrapExpression(e.expression);
        if (ts.isIdentifier(base) && ownerLocals.has(base.text)) {
          flag(kind, node, ownerLocals.get(base.text) as string, name);
          return;
        }
      }
      if (ts.isCallExpression(e)) {
        const owner = loadCallOwner(e);
        if (owner !== null) flag(kind, node, owner, name);
      }
    };
    const visitExports = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        if (node.moduleSpecifier !== undefined) {
          const owner = ownerOfSpecifier(rel, sf, node.moduleSpecifier);
          if (owner !== null) {
            if (node.exportClause === undefined) flag('re-export-namespace', node, owner, '*');
            else if (ts.isNamespaceExport(node.exportClause)) flag('re-export-namespace', node, owner, node.exportClause.name.text);
            else for (const element of node.exportClause.elements) if (!element.isTypeOnly) flag('re-export-alias', element, owner, element.name.text);
          }
        } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            if (element.isTypeOnly) continue;
            const local = element.propertyName ?? element.name;
            if (ts.isIdentifier(local) && ownerLocals.has(local.text)) {
              flag('re-export-alias', element, ownerLocals.get(local.text) as string, element.name.text);
            }
          }
        }
      } else if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          if (declaration.initializer === undefined) continue;
          if (ts.isIdentifier(declaration.name)) {
            checkExportedExpression('re-export-alias', declaration, declaration.initializer, declaration.name.text);
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            let e = unwrapExpression(declaration.initializer);
            if (ts.isAwaitExpression(e)) e = unwrapExpression(e.expression);
            if (ts.isCallExpression(e)) {
              const owner = loadCallOwner(e);
              if (owner !== null) {
                for (const element of declaration.name.elements) {
                  if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) flag('re-export-alias', element, owner, element.name.text);
                }
              }
            }
          }
        }
      } else if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
        checkExportedExpression('re-export-default', node, node.expression, 'default');
      }
      ts.forEachChild(node, visitExports);
    };
    visitExports(sf);
  }
  return findings.sort((a, b) =>
    `${a.file}\u0000${a.kind}\u0000${a.owner}\u0000${a.name}\u0000${a.fragment}`.localeCompare(
      `${b.file}\u0000${b.kind}\u0000${b.owner}\u0000${b.name}\u0000${b.fragment}`,
    ),
  );
}

// ---- SRC-3 complete built-in classification + SRC-5 native-extension loads ------
// (amendment (t), round 8 — plan Revision 9) ------------------------------------
//
// Rounds 4-8 found in-process execution routes in the Node/Electron API surface
// one at a time. That surface is FINITE, so it is classified ONCE, completely,
// against the runtime's own list: BUILTIN_MODULE_CLASSIFICATION is keyed by
// EVERY entry of require('node:module').builtinModules in the Node that runs
// this spec (vitest 3.2.7 on Node v24.16.0: 72 entries — the 'node:'-only
// built-ins sea / sqlite / test / test/reporters appear WITH the prefix), and a
// self-test asserts key-set EQUALITY at test time, so a Node upgrade that adds
// a built-in fails C1 until someone classifies it. Electron 45.2.1 (Node
// 24.22.1, the runtime of desktop/main) lists 74: the same 72 plus the two
// ELECTRON_ONLY entries below (asserted when the spec runs under Electron, and
// by repro/scan-selfcheck-v2.mjs running Electron as Node).
//
// Classes: IN-PROCESS-EXEC — can run JavaScript, WebAssembly or native code
// inside the CURRENT process from a string, file or binary; OUT-OF-PROCESS —
// runs code only in a separate OS process (#320's own property); INERT —
// neither. Each entry carries the check author's one-line reason (researched
// per entry on Node 24.16 and Electron 45.2.1 — see the header note (t) for
// the disagreements with the plan's expected list). Member-level native loads
// inside otherwise INERT modules (crypto.setEngine, the TLS engine options)
// are confined by SRC-5 rather than by banning the module.

type BuiltinClass = 'IN-PROCESS-EXEC' | 'OUT-OF-PROCESS' | 'INERT';

interface BuiltinClassification {
  cls: BuiltinClass;
  reason: string;
}

/** SRC-3: EVERY Node built-in (key set === builtinModules of the running Node, asserted). */
const BUILTIN_MODULE_CLASSIFICATION: Readonly<Record<string, BuiltinClassification>> = {
  _http_agent: { cls: 'INERT', reason: 'legacy alias of the http Agent: connection pooling, no evaluation' },
  _http_client: { cls: 'INERT', reason: 'legacy alias of http.ClientRequest: network I/O only' },
  _http_common: { cls: 'INERT', reason: 'legacy http internals (method/header tables, the llhttp HTTP-framing parser): no code evaluation' },
  _http_incoming: { cls: 'INERT', reason: 'legacy alias of http.IncomingMessage: a readable stream' },
  _http_outgoing: { cls: 'INERT', reason: 'legacy alias of http.OutgoingMessage: a writable stream' },
  _http_server: { cls: 'INERT', reason: 'legacy alias of the http Server internals: network I/O only' },
  _stream_duplex: { cls: 'INERT', reason: 'legacy alias of stream.Duplex' },
  _stream_passthrough: { cls: 'INERT', reason: 'legacy alias of stream.PassThrough' },
  _stream_readable: { cls: 'INERT', reason: 'legacy alias of stream.Readable' },
  _stream_transform: { cls: 'INERT', reason: 'legacy alias of stream.Transform' },
  _stream_wrap: { cls: 'INERT', reason: 'legacy JSStreamSocket wrapper: adapts a stream to a socket handle' },
  _stream_writable: { cls: 'INERT', reason: 'legacy alias of stream.Writable' },
  _tls_common: { cls: 'INERT', reason: 'legacy SecureContext helpers; its OpenSSL-engine options are member-confined by SRC-5' },
  _tls_wrap: { cls: 'INERT', reason: 'legacy TLSSocket/Server; its OpenSSL-engine options are member-confined by SRC-5' },
  assert: { cls: 'INERT', reason: 'assertions only' },
  'assert/strict': { cls: 'INERT', reason: 'strict-mode assertions only' },
  async_hooks: { cls: 'INERT', reason: 'hooks / AsyncLocalStorage call caller-supplied functions; no source or binary evaluation' },
  buffer: { cls: 'INERT', reason: 'byte buffers' },
  child_process: { cls: 'OUT-OF-PROCESS', reason: 'spawn/fork/exec run code in a separate OS process (#320 property)' },
  cluster: { cls: 'OUT-OF-PROCESS', reason: 'forks worker OS processes through child_process' },
  console: { cls: 'INERT', reason: 'logging' },
  constants: { cls: 'INERT', reason: 'deprecated constant tables' },
  crypto: { cls: 'INERT', reason: 'hashes/ciphers/KDFs/random; the native-load member setEngine is confined by SRC-5 (plain Node 24 OpenSSL 3.5.6 dlopens engines; Electron 45 refuses ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED)' },
  dgram: { cls: 'INERT', reason: 'UDP sockets' },
  diagnostics_channel: { cls: 'INERT', reason: 'publish/subscribe with caller-supplied handlers; module-load tracing channels report loads, they evaluate nothing (a captured export is the disclosed shared-state residual)' },
  dns: { cls: 'INERT', reason: 'name resolution' },
  'dns/promises': { cls: 'INERT', reason: 'name resolution (promises)' },
  domain: { cls: 'INERT', reason: 'deprecated error routing for caller code' },
  events: { cls: 'INERT', reason: 'EventEmitter' },
  fs: { cls: 'INERT', reason: 'file I/O; writing a file executes nothing (running it needs a recognised load route)' },
  'fs/promises': { cls: 'INERT', reason: 'file I/O (promises)' },
  http: { cls: 'INERT', reason: 'HTTP client/server; a custom Agent is caller code, not evaluation' },
  http2: { cls: 'INERT', reason: 'HTTP/2 client/server; TLS engine options member-confined by SRC-5' },
  https: { cls: 'INERT', reason: 'HTTPS client/server; TLS engine options member-confined by SRC-5' },
  inspector: { cls: 'IN-PROCESS-EXEC', reason: 'Session.post("Runtime.evaluate") evaluates JavaScript in THIS process; inspector.open() exposes the same to any local debugger client' },
  'inspector/promises': { cls: 'IN-PROCESS-EXEC', reason: 'the promise Session API: Runtime.evaluate in THIS process (the round-8 critic probe parsed a real archive in the evaluating PID)' },
  module: { cls: 'IN-PROCESS-EXEC', reason: 'createRequire/require load and run modules; register()/registerHooks() install loader hooks; Module._compile/_load; confined to recognised named-createRequire imports (INV-2)' },
  net: { cls: 'INERT', reason: 'TCP/IPC sockets' },
  os: { cls: 'INERT', reason: 'host information' },
  path: { cls: 'INERT', reason: 'path string manipulation' },
  'path/posix': { cls: 'INERT', reason: 'path string manipulation (posix)' },
  'path/win32': { cls: 'INERT', reason: 'path string manipulation (win32)' },
  perf_hooks: { cls: 'INERT', reason: 'timing/histograms; observers are caller-supplied functions' },
  process: { cls: 'IN-PROCESS-EXEC', reason: 'the module IS the global process object (default === process) carrying dlopen/getBuiltinModule/binding/_linkedBinding/execve; loading it is confined EMPTY and those members are confined by name (SRC-1 dlopen, SRC-4) on every receiver' },
  punycode: { cls: 'INERT', reason: 'deprecated IDN string encoding' },
  querystring: { cls: 'INERT', reason: 'query-string encoding' },
  readline: { cls: 'INERT', reason: 'line editing over streams; completers are caller functions; no evaluation' },
  'readline/promises': { cls: 'INERT', reason: 'line editing over streams (promises)' },
  repl: { cls: 'IN-PROCESS-EXEC', reason: 'REPLServer evaluates input source in the current context (vm-backed eval)' },
  stream: { cls: 'INERT', reason: 'stream classes' },
  'stream/consumers': { cls: 'INERT', reason: 'stream-to-value helpers' },
  'stream/promises': { cls: 'INERT', reason: 'pipeline/finished (promises)' },
  'stream/web': { cls: 'INERT', reason: 'WHATWG streams' },
  string_decoder: { cls: 'INERT', reason: 'byte-to-string decoding' },
  sys: { cls: 'INERT', reason: 'deprecated alias of util' },
  timers: { cls: 'INERT', reason: 'timers; Node REJECTS a string callback (ERR_INVALID_ARG_TYPE, verified), unlike browsers' },
  'timers/promises': { cls: 'INERT', reason: 'timers (promises); no string callbacks' },
  tls: { cls: 'INERT', reason: 'TLS sockets; privateKeyEngine/clientCertEngine (an OpenSSL engine dlopen under plain Node, verified) member-confined by SRC-5' },
  trace_events: { cls: 'INERT', reason: 'enables V8/Node trace categories; evaluates nothing' },
  tty: { cls: 'INERT', reason: 'terminal streams' },
  url: { cls: 'INERT', reason: 'URL parsing/formatting' },
  util: { cls: 'INERT', reason: 'inspect/promisify/format/types; no evaluator member (verified on both runtimes)' },
  'util/types': { cls: 'INERT', reason: 'type predicates' },
  v8: { cls: 'IN-PROCESS-EXEC', reason: 'conservative: setFlagsFromString mutates the running engine process-wide (e.g. --allow-natives-syntax for later-compiled code) and startupSnapshot hooks deserialisation; desktop/main never needs it' },
  vm: { cls: 'IN-PROCESS-EXEC', reason: 'runInThisContext/Script/compileFunction/SourceTextModule evaluate source in THIS process' },
  wasi: { cls: 'IN-PROCESS-EXEC', reason: 'WASI.start/initialize run a WebAssembly instance in THIS process' },
  worker_threads: { cls: 'IN-PROCESS-EXEC', reason: 'Worker runs a file or eval:true source on a thread of THIS OS process (same PID); confined to the reranker pair (INV-5c)' },
  zlib: { cls: 'INERT', reason: 'compression codecs: a decompressor, not a code evaluator (untrusted-input decompression is a Class-A sweep item, not a C1 source)' },
  'node:sea': { cls: 'INERT', reason: 'reads assets embedded in a single-executable app; executes nothing' },
  'node:sqlite': { cls: 'IN-PROCESS-EXEC', reason: 'DatabaseSync({ allowExtension: true }).loadExtension loads a native SQLite extension into THIS process (LoadLibrary attempted, verified)' },
  'node:test': { cls: 'IN-PROCESS-EXEC', reason: 'run({ files, isolation: "none" }) imports test files into THIS process; mock.module() substitutes module bodies' },
  'node:test/reporters': { cls: 'INERT', reason: 'dot/junit/spec/tap/lcov transforms over test events; they load and run nothing (the plan expected IN-PROCESS-EXEC; disagreement recorded in header note (t))' },
};

/** SRC-3: the built-ins Electron's Node adds (Electron 45.2.1 builtinModules = Node's 72 + these 2). */
const ELECTRON_ONLY_BUILTIN_CLASSIFICATION: Readonly<Record<string, BuiltinClassification>> = {
  'original-fs': { cls: 'INERT', reason: 'Electron: the asar-unaware fs; file I/O only' },
  'original-fs/promises': { cls: 'INERT', reason: 'Electron: the asar-unaware fs (promises); file I/O only' },
};

/**
 * The classification key a module specifier loads, or null when it is not a
 * built-in. Exact keys first; a 'node:'-prefixed spelling of an UNPREFIXED key
 * normalises to it ('node:vm' -> 'vm', 'node:fs/promises' -> 'fs/promises').
 * The reverse is NOT applied: the 'node:'-only built-ins load only with the
 * prefix — `require('sqlite')` / `require('test')` name userland packages
 * (module.isBuiltin('sqlite') === false, verified). Case-sensitive, like Node.
 */
function canonicalBuiltinId(specifier: string): string | null {
  const known = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(BUILTIN_MODULE_CLASSIFICATION, id) ||
    Object.prototype.hasOwnProperty.call(ELECTRON_ONLY_BUILTIN_CLASSIFICATION, id);
  if (known(specifier)) return specifier;
  if (specifier.startsWith('node:') && known(specifier.slice('node:'.length))) return specifier.slice('node:'.length);
  return null;
}

/** The SRC-3 class of a canonical built-in id. */
function builtinClassOf(id: string): BuiltinClass {
  return ((BUILTIN_MODULE_CLASSIFICATION[id] ?? ELECTRON_ONLY_BUILTIN_CLASSIFICATION[id]) as BuiltinClassification).cls;
}

/**
 * One SRC-3 site. `builtin-load`: an IN-PROCESS-EXEC built-in loaded through
 * any route the amendment-(h) inventory recognises; `builtin-get`: an
 * IN-PROCESS-EXEC (or COMPUTED) built-in obtained through getBuiltinModule (the
 * SRC-4 route, any receiver); `data-url-load`: a load whose COOKED specifier is
 * a `data:` URL (the module loader EVALUATES the URL's source text — the outer
 * AST cannot see it; verified in-process on both runtimes); `global-evaluator`:
 * a runtime reference to the `WebAssembly` global (compiles and runs wasm in
 * this process) or to a function's `constructor` (`(() => {}).constructor` IS
 * Function; `Object.getPrototypeOf(async () => {}).constructor` is
 * AsyncFunction — both evaluate a string; verified).
 */
interface Src3Site {
  file: string;
  kind: 'builtin-load' | 'builtin-get' | 'data-url-load' | 'global-evaluator';
  /** The canonical built-in id, COMPUTED, 'data:', 'WebAssembly' or 'constructor'. */
  source: string;
  /** The load form, the getBuiltinModule callee form, or the reference form. */
  form: string;
  fragment: string;
  /** True only for a static `import { createRequire } from 'node:module'` declaration (the INV-2 recognised origin). */
  namedCreateRequireImport: boolean;
}

/** Every SRC-3 site in one source (permission is decided per tree). */
function src3SitesInSource(source: string, fileRel: string): Src3Site[] {
  const sf = ts.createSourceFile(fileRel, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileRel));
  const sites: Src3Site[] = [];
  const text = (node: ts.Node): string => node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80);
  // The recognised createRequire origin: a static, non-type-only import of the
  // module package with NO default / namespace binding whose every value
  // binding is named createRequire (any local rename) — the loader walk's
  // no-flag condition. Matched to its load site by fragment (a multiset).
  const recognisedFragments: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = staticSpecifier(statement.moduleSpecifier, sf);
    const clause = statement.importClause;
    if ((spec !== 'module' && spec !== 'node:module') || clause === undefined || clause.isTypeOnly || clause.name !== undefined) continue;
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    const values = named.elements.filter((el) => !el.isTypeOnly);
    if (values.length > 0 && values.every((el) => (el.propertyName ?? el.name).text === 'createRequire')) {
      recognisedFragments.push(text(statement));
    }
  }
  for (const site of loadSitesInSource(source, fileRel)) {
    if (site.specifier === COMPUTED) continue; // the computed-specifier leg gates these
    if (/^data:/i.test(site.specifier)) {
      sites.push({ file: fileRel, kind: 'data-url-load', source: 'data:', form: site.form, fragment: site.fragment, namedCreateRequireImport: false });
      continue;
    }
    const id = canonicalBuiltinId(site.specifier);
    if (id === null || builtinClassOf(id) !== 'IN-PROCESS-EXEC') continue;
    let recognised = false;
    if (id === 'module' && site.form === 'import') {
      const i = recognisedFragments.indexOf(site.fragment);
      if (i >= 0) {
        recognisedFragments.splice(i, 1);
        recognised = true;
      }
    }
    sites.push({ file: fileRel, kind: 'builtin-load', source: id, form: site.form, fragment: site.fragment, namedCreateRequireImport: recognised });
  }
  const visit = (node: ts.Node): void => {
    if (isTypeOnlyPosition(node)) return;
    if (ts.isCallExpression(node)) {
      // getBuiltinModule('<id>') on any receiver (dot / optional / literal element) or bare.
      const callee = unwrapExpression(node.expression);
      let form: string | null = null;
      if (ts.isIdentifier(callee) && callee.text === 'getBuiltinModule') form = 'identifier';
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule') form = 'dot';
      else if (ts.isElementAccessExpression(callee) && staticSpecifier(callee.argumentExpression, sf) === 'getBuiltinModule') form = 'element';
      if (form !== null) {
        const spec = staticSpecifier(node.arguments[0], sf);
        const id = spec === COMPUTED ? COMPUTED : canonicalBuiltinId(spec);
        if (id === COMPUTED || (id !== null && builtinClassOf(id) === 'IN-PROCESS-EXEC')) {
          sites.push({ file: fileRel, kind: 'builtin-get', source: id, form, fragment: text(node), namedCreateRequireImport: false });
        }
      }
    }
    // A function's `constructor` (Function / AsyncFunction / GeneratorFunction).
    // Reading `.constructor.name` and an equality comparison are NOT evaluation.
    const isConstructorMember =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
      (ts.isElementAccessExpression(node) && staticSpecifier(node.argumentExpression, sf) === 'constructor');
    if (isConstructorMember) {
      const w = outermostValueWrapper(node as ts.Expression);
      const p = w.parent;
      const readsName = ts.isPropertyAccessExpression(p) && p.expression === w && p.name.text === 'name';
      const compared =
        ts.isBinaryExpression(p) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind);
      if (!readsName && !compared) {
        sites.push({ file: fileRel, kind: 'global-evaluator', source: 'constructor', form: ts.isPropertyAccessExpression(node) ? 'dot' : 'element', fragment: text(node), namedCreateRequireImport: false });
      }
    } else if (ts.isBindingElement(node) && node.propertyName !== undefined) {
      const key = node.propertyName;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : ts.isComputedPropertyName(key) ? staticSpecifier(key.expression, sf) : null;
      if (keyText === 'constructor') {
        sites.push({ file: fileRel, kind: 'global-evaluator', source: 'constructor', form: 'binding', fragment: text(node), namedCreateRequireImport: false });
      }
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'constructor') {
      // A reflective key: Reflect.get(fn, 'constructor'), getOwnPropertyDescriptor(p, 'constructor').
      const p = node.parent;
      const alreadyCounted =
        (ts.isElementAccessExpression(p) && p.argumentExpression === node) ||
        (ts.isBindingElement(p) && p.propertyName === node) ||
        ts.isComputedPropertyName(p) ||
        ts.isLiteralTypeNode(p);
      if (!alreadyCounted) {
        sites.push({ file: fileRel, kind: 'global-evaluator', source: 'constructor', form: 'string', fragment: text(p), namedCreateRequireImport: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const ref of runtimeNameReferencesInSource(source, fileRel, ['WebAssembly'])) {
    sites.push({ file: fileRel, kind: 'global-evaluator', source: 'WebAssembly', form: ref.form, fragment: ref.fragment, namedCreateRequireImport: false });
  }
  return sites;
}

/** SRC-3 permission: worker_threads loads inside the reranker pair (INV-5c) and the recognised named-createRequire imports of the module package (INV-2). Everything else is allowed NOWHERE. */
function src3SiteIsPermitted(site: Src3Site): boolean {
  if (site.kind !== 'builtin-load') return false;
  if (site.source === 'worker_threads') return INV5C_ALLOWED.some((a) => moduleStem(a) === moduleStem(site.file));
  if (site.source === 'module') return site.namedCreateRequireImport;
  return false;
}

/** SRC-3 site order: (file, kind, source, form, fragment). */
function src3Order(a: Src3Site, b: Src3Site): number {
  return `${a.file}\u0000${a.kind}\u0000${a.source}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.kind}\u0000${b.source}\u0000${b.form}\u0000${b.fragment}`);
}

/** SRC-3 over a tree: every IN-PROCESS-EXEC site OUTSIDE its allowed set (no allowlist). */
function src3FindingsOfTree(tree: ReadonlyMap<string, string>): Src3Site[] {
  return [...tree].flatMap(([rel, source]) => src3SitesInSource(source, rel)).filter((s) => !src3SiteIsPermitted(s)).sort(src3Order);
}

/** SRC-3 anti-vacuity: the permitted sites (base: the five createRequire imports + the reranker pair's two worker_threads loads). */
function src3PermittedOfTree(tree: ReadonlyMap<string, string>): Src3Site[] {
  return [...tree].flatMap(([rel, source]) => src3SitesInSource(source, rel)).filter(src3SiteIsPermitted).sort(src3Order);
}

/**
 * SRC-5: runtime references to a NATIVE-EXTENSION load member, confined to the
 * EXACT base sites. `loadExtension` (better-sqlite3 / node:sqlite DatabaseSync
 * — a native SQLite extension loaded into this process; the name also covers
 * Electron's session.loadExtension, conservatively). Check-author additions,
 * EMPTY at base: `setEngine` (crypto — an OpenSSL dynamic engine dlopen under
 * plain Node 24) and the TLS option keys `privateKeyEngine` /
 * `clientCertEngine` (the same engine load; Node 24.16 reported "DSO support
 * routines::could not load the shared library" for a missing id, i.e. it
 * attempted the load; Electron 45 refuses every custom engine).
 * `process.dlopen` stays an SRC-1 empty rule.
 */
const SRC5_NATIVE_LOAD_NAMES = ['loadExtension', 'setEngine', 'privateKeyEngine', 'clientCertEngine'] as const;

/**
 * SRC-5 base capture (5d1f7338): the ONLY two runtime native-extension loads in
 * desktop/main — each the sqlite-vec vec0 extension, loaded through
 * unpackAsarPath (#133). The `loadExtension(path: string): void` members at
 * sqlite-store.ts:77 and pack-manager.ts:70 are TYPE positions and do not count.
 * Each entry admits exactly ONE site (a second same-fragment site fails).
 */
const SRC5_ALLOWED_SITES: ReadonlyArray<{ file: string; name: string; form: string; fragment: string; reason: string }> = [
  {
    file: 'backend/store/pack-manager.ts',
    name: 'loadExtension',
    form: 'dot',
    fragment: 'db.loadExtension',
    reason: 'pack-manager.ts:1300 — sqlite-vec vec0 for the read-only prebuilt pack index (#73 C6), asar-redirected (#133)',
  },
  {
    file: 'backend/store/sqlite-store.ts',
    name: 'loadExtension',
    form: 'dot',
    fragment: 'db.loadExtension',
    reason: 'sqlite-store.ts:206 — sqlite-vec vec0 for the live store, before any vec0 DDL/DML, asar-redirected (#133)',
  },
];

interface Src5Site {
  file: string;
  name: string;
  form: string;
  fragment: string;
}

/** Every SRC-5 native-load member reference in one source (the INV-3 runtime-reference walk). */
function src5SitesInSource(source: string, fileRel: string): Src5Site[] {
  return runtimeNameReferencesInSource(source, fileRel, SRC5_NATIVE_LOAD_NAMES).map((r) => ({ file: fileRel, name: r.name, form: r.form, fragment: r.fragment }));
}

/** SRC-5 over a tree: each allowlist entry consumes at most ONE matching site; every other site is a finding. */
function src5OfTree(tree: ReadonlyMap<string, string>): { findings: Src5Site[]; permitted: Src5Site[] } {
  const remaining = SRC5_ALLOWED_SITES.map((a) => ({ ...a }));
  const findings: Src5Site[] = [];
  const permitted: Src5Site[] = [];
  const order = (a: Src5Site, b: Src5Site): number => `${a.file}\u0000${a.name}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.name}\u0000${b.form}\u0000${b.fragment}`);
  const sites = [...tree].flatMap(([rel, source]) => src5SitesInSource(source, rel)).sort(order);
  for (const site of sites) {
    const i = remaining.findIndex((a) => moduleStem(a.file) === moduleStem(site.file) && a.name === site.name && a.form === site.form && a.fragment === site.fragment);
    if (i >= 0) {
      remaining.splice(i, 1);
      permitted.push(site);
    } else {
      findings.push(site);
    }
  }
  return { findings, permitted };
}

// ---- amendment (u) / SRC-6 (round 8 addendum): frozen third-party package inventory ----

/** SRC-6 package class. */
type ThirdPartyClass = 'PARSER' | 'NON-PARSER';

interface ThirdPartyClassification {
  cls: ThirdPartyClass;
  reason: string;
  /** PARSER entries only: the EXACT allowed file set the existing rules assign (main-relative). */
  allowedFiles?: readonly string[];
}

/**
 * The package name a third-party module specifier names, or null when it is
 * not a third-party package: relative ('./x', '../x'), absolute ('/x',
 * 'E:/x'), file:/data: specifiers, the COMPUTED sentinel, node_modules
 * path prefixes (unwrapped: 'x/node_modules/@scope/pkg/sub' ->
 * '@scope/pkg'), Node builtins (both spellings, via canonicalBuiltinId —
 * getBuiltinModule never reaches here, it is builtins-only and SRC-4-named)
 * and every 'node:'-prefixed spelling (never resolves to a package).
 * Normalisation: backslashes folded, case-folded (Windows resolves 'JSZip'
 * to the jszip directory — the same case-insensitivity parserSpecifier
 * applies), subpaths dropped ('pdfjs-dist/legacy/build/pdf.mjs' ->
 * 'pdfjs-dist', 'ajv/dist/2020' -> 'ajv'), scopes kept ('@scope/name').
 * AMENDED (round 9, SRC-8): a '#' package-import alias is NO LONGER
 * discarded — it returns the alias name the same way ('#workbook' ->
 * '#workbook', '#workbook/sub' -> '#workbook', '#@scope/pkg/x' ->
 * '#@scope/pkg'), so SRC-6 reports it UNCLASSIFIED until classified; the
 * SRC-8 leg bans every '#' load site outright, so classification can never
 * excuse it.
 */
function packageNameOf(specifier: string): string | null {
  if (specifier === COMPUTED) return null;
  const s = specifier.replace(/\\/g, '/').toLowerCase();
  // Unwrap a node_modules path prefix FIRST (parserSpecifier semantics: the
  // legs count '../node_modules/jszip' and 'x/node_modules/@scope/pkg' as
  // package loads), then judge the remainder.
  const nm = /(?:^|\/)node_modules\//.exec(s);
  const cut = nm !== null && nm.index !== undefined ? s.slice(nm.index + nm[0].length) : s;
  if (cut === '' || cut.startsWith('.') || cut.startsWith('/')) return null;
  if (/^[a-z]:/.test(cut) || cut.startsWith('file:') || cut.startsWith('data:')) return null;
  if (cut.startsWith('node:') || canonicalBuiltinId(cut) !== null) return null;
  const parts = cut.split('/');
  const head = parts[0] ?? '';
  const name = cut.startsWith('@') || cut.startsWith('#@') ? `${head}/${parts[1] ?? ''}` : head;
  if (!/^(@[^/]+\/[^/]+|#@[^/]+\/[^/]+|#[^/@][^/]*|[^/@#][^/]*)$/.test(name)) return null;
  return name;
}

/**
 * SRC-6 base capture (5d1f7338): the sorted set of third-party package names
 * the load inventory finds across ALL of desktop/main must EXACTLY equal
 * these keys (the S1 SRC-6 leg asserts it; a new package is UNCLASSIFIED, a
 * vanished one REMOVED). The frozen classification:
 *   PARSER (4) — exactly the plan's expected set, each allowed ONLY in the
 *     file set the existing rules assign (the S1 legs above; xlsx reuses the
 *     frozen #289 T1 assignment — the SRC-6 self-test cross-checks every
 *     allowedFiles against those legs' pinned sets, so this table cannot
 *     drift into a second source of truth).
 *   NON-PARSER (7) — one-line reasons that DISCLOSE the untrusted-binary
 *     decode surfaces honestly (pack indexes / GGUF / ONNX / nativeImage) as
 *     Phase 4.2 Class-A sweep neighbours; no package beyond the expected four
 *     is classified PARSER (reported to the plan critic: NONE unexpected).
 */
const THIRD_PARTY_PACKAGE_CLASSIFICATION: Readonly<Record<string, ThirdPartyClassification>> = {
  '@huggingface/transformers': {
    cls: 'NON-PARSER',
    reason: 'inference runtime over REPO-STAGED tokenizer/ONNX model artifacts (embedder.ts, rerank-worker.ts), not user documents; its ONNX-protobuf / tokenizer-JSON decode of maintainer-staged files is a Phase 4.2 Class-A sweep neighbour',
  },
  ajv: {
    cls: 'NON-PARSER',
    reason: 'JSON-Schema VALIDATOR over values already parsed by the builtin JSON.parse (pack manifest / update-feed schemas); it reads no document bytes',
  },
  'ajv-formats': {
    cls: 'NON-PARSER',
    reason: 'string-format predicates (an ajv plugin) for the same validators; reads no document bytes',
  },
  'better-sqlite3': {
    cls: 'NON-PARSER',
    reason: 'the storage engine: the app\'s own store plus read-only PREBUILT PACK indexes (signed-AC3 pack bytes, not #320 user documents); NATIVE ADDON; its sqlite-vec loadExtension is SRC-5-confined',
  },
  electron: {
    cls: 'NON-PARSER',
    reason: 'the framework itself; the header-note (t) review found no electron export that evaluates code in the MAIN process; nativeImage decodes untrusted images in main — a Class-A sweep item, not code execution',
  },
  jszip: {
    cls: 'PARSER',
    reason: 'zip archive reader/writer over untrusted bytes (the #320/#319 document containers and #320 AC3 pack uploads) — after the AC_CHANGED_BY_USER 2026-11-09 amendment, parsed ONLY in the three parse children; pack-extract.ts is no longer an allowed site',
    allowedFiles: ['backend/ingest/doc-worker-child.ts', 'backend/ingest/xlsx-worker-child.ts', 'backend/packs/pack-extract-child.ts'],
  },
  mammoth: {
    cls: 'PARSER',
    reason: '.docx (Office Open XML) text extractor over untrusted documents',
    allowedFiles: ['backend/ingest/doc-worker-child.ts'],
  },
  'node-llama-cpp': {
    cls: 'NON-PARSER',
    reason: 'llama.cpp inference over the app\'s own DOWNLOADED GGUF models (ADR-0002 profiles); readGgufFileInfo / weight loading decode maintainer-pipeline binaries, not user documents — a Class-A sweep neighbour; NATIVE ADDON',
  },
  'pdfjs-dist': {
    cls: 'PARSER',
    reason: 'PDF document parser over untrusted .pdf bytes',
    allowedFiles: ['backend/ingest/doc-worker-child.ts'],
  },
  'sqlite-vec': {
    cls: 'NON-PARSER',
    reason: 'ships the vec0 SQLite extension; in main it only resolves getLoadablePath() — the loadExtension sites are SRC-5-confined; NATIVE ADDON; reads no document bytes',
  },
  xlsx: {
    cls: 'PARSER',
    reason: 'SheetJS .xlsx workbook parser over untrusted spreadsheets (the #319 child; file:../vendor/sheetjs dependency)',
    allowedFiles: ['backend/ingest/xlsx-worker-child.ts'],
  },
};

/** The sorted set of third-party package names a load-site inventory sees (COMPUTED sites name no package). */
function thirdPartyPackagesOf(sites: LoadSite[]): string[] {
  const names = new Set<string>();
  for (const site of sites) {
    const name = packageNameOf(site.specifier);
    if (name !== null) names.add(name);
  }
  return [...names].sort();
}

/** One SRC-6 finding. */
interface Src6Finding {
  kind: 'UNCLASSIFIED' | 'REMOVED' | 'PARSER-OUTSIDE-ALLOWED';
  name: string;
  /** PARSER-OUTSIDE-ALLOWED only: the offending main-relative file. */
  file?: string;
}

/**
 * SRC-6 findings over a load-site inventory: every loaded package missing
 * from the table (UNCLASSIFIED — a new parser library or any new dependency),
 * every table entry nothing loads (REMOVED — fails until the table is pruned),
 * and every PARSER package loaded outside its assigned file set
 * (PARSER-OUTSIDE-ALLOWED — a fail-closed overlap with the per-library legs,
 * which judge specifier sets; this leg judges package NAMES).
 */
function src6FindingsOfSites(sites: LoadSite[]): Src6Finding[] {
  const findings: Src6Finding[] = [];
  const loaded = thirdPartyPackagesOf(sites);
  for (const name of loaded) {
    if (!Object.prototype.hasOwnProperty.call(THIRD_PARTY_PACKAGE_CLASSIFICATION, name)) findings.push({ kind: 'UNCLASSIFIED', name });
  }
  for (const name of Object.keys(THIRD_PARTY_PACKAGE_CLASSIFICATION)) {
    if (!loaded.includes(name)) findings.push({ kind: 'REMOVED', name });
  }
  for (const [name, entry] of Object.entries(THIRD_PARTY_PACKAGE_CLASSIFICATION)) {
    if (entry.cls !== 'PARSER') continue;
    const allowed = [...(entry.allowedFiles ?? [])].sort();
    for (const file of filesLoading(sites, parserSpecifier(name))) {
      if (!allowed.includes(file)) findings.push({ kind: 'PARSER-OUTSIDE-ALLOWED', name, file });
    }
  }
  return findings.sort((a, b) => `${a.kind}\u0000${a.name}\u0000${a.file ?? ''}`.localeCompare(`${b.kind}\u0000${b.name}\u0000${b.file ?? ''}`));
}

/** SRC-6 findings over a whole tree (the same inventory, file by file). */
function src6FindingsOfTree(tree: ReadonlyMap<string, string>): Src6Finding[] {
  return src6FindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)));
}

// ---- RESOLUTION BOUNDARY (amendments (v)/(w), round 9 — plan Revision 10
// SRC-7/SRC-8; AMENDED round 10 — plan Revision 11 SRC-7'/SRC-9) ----
//
// Every layer above consumes the desktop/main FILE LIST and the load
// specifiers as written. Round 9 showed resolution can take a load to code
// that list never contains: a relative / absolute / file: URL edge to a local
// module OUTSIDE desktop/main (TypeScript compiles it into the main program;
// Node and Electron run it in the main PID), and a '#' package-import alias
// that Node resolves through package.json `imports` to ANY package. Both are
// closed at the boundary with EMPTY allowed sets: SRC-8 rejects every '#'
// specifier (banned, not resolved), and SRC-7 confined every local edge
// inside desktop/main. Round 10 then EXECUTED two resolution-reality escapes
// past that lexical confinement: CommonJS LOAD_AS_DIRECTORY reads a nested
// package.json `main` ('./container' -> container/package.json main
// '../../shared/workbook-parser.cjs' -> an UNSCANNED wrapper outside main,
// parsed canonical xlsx in the real Electron main PID), and the filesystem
// follows a directory junction after the lexical check ('./linked/
// workbook-parser.cjs' through main/linked -> external shared, same real
// Electron main PID). SRC-7' (amendment (x)) now resolves the ACTUAL
// executable target Node loads — directory package.json main/exports/index,
// the .js -> .ts compiled-layout twin mapping, and a final realpath — and
// boundary-checks THAT; a nested package.json under desktop/main and every
// symlink/junction entry encountered while enumerating the tree are their
// own EMPTY-allowed-set findings. Both rules consume the (h) load inventory,
// so EVERY recognised load route is covered by construction.

/** One SRC-7 finding: a local module edge whose resolved target lies OUTSIDE desktop/main. */
interface Src7Finding {
  /** The importing file, main-relative. */
  file: string;
  /** The load form (the inventory's form string). */
  form: string;
  /** The COOKED specifier as the load site carries it. */
  specifier: string;
  /** The raw lexical path, relative to desktop/main with forward slashes ('..' escapes the root). */
  resolved: string;
  /** How the executable target was placed: directory-main / directory-index / directory-exports / unresolved-directory / file / twin / extensionless / realpath / lexical / unparseable. */
  via: string;
  /** The final observed executable target (post directory-resolution, twin mapping AND realpath), relative to desktop/main; equals `resolved` when nothing was observed. */
  actual: string;
  fragment: string;
}

/**
 * True when a COOKED specifier is a LOCAL module edge SRC-7 must resolve:
 * relative ('', '.', '..', './x', '../x'), absolute (POSIX '/x' — on
 * Windows a drive-rooted path — or drive 'E:/x', backslashes folded) or a
 * file: URL. Bare packages, 'node:' / builtins, data: URLs, '#' aliases
 * (SRC-8's) and COMPUTED are not local edges.
 */
function isLocalLoadSpecifier(specifier: string): boolean {
  if (specifier === COMPUTED) return false;
  const s = specifier.replace(/\\/g, '/');
  if (s === '' || s === '.' || s === '..') return true;
  if (/^file:/i.test(s)) return true;
  return s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || /^[A-Za-z]:\//.test(s);
}

/**
 * How an SRC-7' resolution placed the executable target of a local edge:
 * 'file' (the raw path exists as a file), 'twin' (only the .ts/.mts/.cts
 * twin exists — the compiled layout), 'extensionless' (an appended source
 * extension exists), 'directory-main' / 'directory-exports' /
 * 'directory-index' (a directory resolved through its package.json or index
 * files), 'unresolved-directory' (an existing directory Node itself could
 * not resolve — fail closed), 'lexical' (nothing observable exists at the
 * path: containment falls back to the raw lexical path, never a pass
 * invented for an observable escape), 'unparseable' (a file: URL
 * fileURLToPath rejects — fail closed).
 */
type Src7Via =
  | 'file'
  | 'twin'
  | 'extensionless'
  | 'directory-main'
  | 'directory-exports'
  | 'directory-index'
  | 'unresolved-directory'
  | 'lexical'
  | 'unparseable';

/** One SRC-7' resolution: what a local edge's executable target actually is. */
interface Src7Resolution {
  /** The raw lexical absolute path the specifier names (null only for an unparseable file: URL). */
  raw: string | null;
  /** The executable target after directory resolution and twin mapping (null for unresolved directories / unparseable URLs). */
  target: string | null;
  /** realpathSync of the target when it exists (follows symlinks AND junctions), else null. */
  realpath: string | null;
  via: Src7Via;
}

/** The compiled-layout twin of a specifier: .js/.mjs/.cjs map to .ts/.mts/.cts sources (plan Revision 11 SRC-7' (b)). */
function src7TwinSource(p: string): string {
  if (/\.cjs$/i.test(p)) return `${p.slice(0, -4)}.cts`;
  if (/\.mjs$/i.test(p)) return `${p.slice(0, -4)}.mts`;
  if (/\.js$/i.test(p)) return `${p.slice(0, -3)}.ts`;
  return p;
}

/** Extensions tried for an extensionless relative specifier ('./x' -> x.ts, ...), in try order. */
const SRC7_EXTENSIONLESS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];

/** index candidates of LOAD_AS_INDEX, in try order (.ts first: the source layout). */
const SRC7_INDEX_NAMES = ['index.ts', 'index.js', 'index.mts', 'index.mjs', 'index.cts', 'index.cjs'];

/** 'file' | 'dir' | null — statSync FOLLOWS links/junctions, exactly like Node's resolution. */
function src7StatKind(p: string): 'file' | 'dir' | null {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
  } catch {
    /* absent */
  }
  return null;
}

/**
 * The existing FILE a path names: the exact path, else its compiled-layout
 * twin (SRC-7' (b)), else — for an extensionless path — an appended source
 * extension. null when no file is observable.
 */
function src7ExistingFile(p: string): string | null {
  if (src7StatKind(p) === 'file') return p;
  const twin = src7TwinSource(p);
  if (twin !== p && src7StatKind(twin) === 'file') return twin;
  if (path.extname(p) === '') {
    for (const ext of SRC7_EXTENSIONLESS) {
      if (src7StatKind(p + ext) === 'file') return p + ext;
    }
  }
  return null;
}

/** The first existing index file of a directory (LOAD_AS_INDEX), or null. */
function src7IndexFileOf(dir: string): string | null {
  for (const name of SRC7_INDEX_NAMES) {
    const p = path.join(dir, name);
    if (src7StatKind(p) === 'file') return p;
  }
  return null;
}

/** Every STRING target leaf of an `exports` value (objects, conditions, arrays), in declaration order. */
function src7ExportsStringTargets(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) src7ExportsStringTargets(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) src7ExportsStringTargets(v, out);
  return out;
}

/** The fixed part of an exports target pattern (everything before the first '*'). */
function src7ExportsFixedPart(target: string): string {
  const star = target.indexOf('*');
  return star === -1 ? target : target.slice(0, star);
}

/**
 * Resolve an EXISTING directory Node-style (SRC-7' (a)): its package.json
 * `main` (an existing file, else LOAD_AS_INDEX inside a main that is itself a
 * directory, else the package's own index, else unresolved — fail closed),
 * then a conservative `exports` pass (the '.' subpath target if present, else
 * the first string target — the ALL-targets containment rule is
 * src7PackageJsonFindingsOf's, so no routing emulation can pass an outside
 * candidate), then the index files. A package.json that fails to parse is no
 * usable manifest (index / unresolved).
 */
function src7ResolveDirectory(dir: string): Src7Resolution {
  const finish = (target: string, via: Src7Via): Src7Resolution => ({
    raw: dir,
    target,
    realpath: src7StatKind(target) !== null ? fs.realpathSync(target) : null,
    via,
  });
  let pkg: Record<string, unknown> | null = null;
  const pkgPath = path.join(dir, 'package.json');
  if (src7StatKind(pkgPath) === 'file') {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    } catch {
      pkg = null;
    }
  }
  if (pkg !== null && typeof pkg.main === 'string') {
    const mainAbs = path.resolve(dir, pkg.main.replace(/\\/g, '/'));
    // exact file, compiled-layout twin or extensionless candidate — all name
    // the executable target (SRC-7' (a)+(b)).
    const asFile = src7ExistingFile(mainAbs);
    if (asFile !== null) return finish(asFile, 'directory-main');
    if (src7StatKind(mainAbs) === 'dir') {
      const inner = src7IndexFileOf(mainAbs);
      if (inner !== null) return finish(inner, 'directory-main');
    }
    const idx = src7IndexFileOf(dir);
    if (idx !== null) return finish(idx, 'directory-main');
    return { raw: dir, target: null, realpath: null, via: 'unresolved-directory' };
  }
  if (pkg !== null && (typeof pkg.exports === 'string' || (pkg.exports !== null && typeof pkg.exports === 'object'))) {
    const targets = src7ExportsStringTargets(pkg.exports, []);
    const dot = pkg.exports as Record<string, unknown>;
    const preferred = typeof dot === 'object' && dot !== null && Object.prototype.hasOwnProperty.call(dot, '.')
      ? src7ExportsStringTargets(dot['.'], [])
      : targets;
    for (const target of preferred.length > 0 ? preferred : targets) {
      const candidate = src7ExistingFile(path.resolve(dir, src7ExportsFixedPart(target).replace(/\\/g, '/')));
      if (candidate !== null) return finish(candidate, 'directory-exports');
    }
    const idx = src7IndexFileOf(dir);
    if (idx !== null) return finish(idx, 'directory-exports');
    return { raw: dir, target: null, realpath: null, via: 'unresolved-directory' };
  }
  const idx = src7IndexFileOf(dir);
  if (idx !== null) return finish(idx, 'directory-index');
  return { raw: dir, target: null, realpath: null, via: 'unresolved-directory' };
}

/**
 * SRC-7' (amendments (v)/(x)): the ACTUAL executable target of one local
 * module edge — relative / absolute / file: URL, resolved against
 * `mainDir` (a parameter so the extracted self-check can supply a probe
 * root): directories through their own package.json / index files, files by
 * exact path or compiled-layout twin, the final target realpath'ed. Nothing
 * observable at the path yields via 'lexical' with the raw path as target
 * (containment still judged — the round-9 external-wrapper rows pass through
 * here). COMPUTED is not a local edge (isLocalLoadSpecifier rejects it).
 */
function resolveActualMainTarget(fromRel: string, specifier: string, mainDir: string): Src7Resolution {
  if (specifier === COMPUTED) return { raw: null, target: null, realpath: null, via: 'lexical' };
  let s = specifier.replace(/\\/g, '/');
  if (/^file:/i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      return { raw: null, target: null, realpath: null, via: 'unparseable' };
    }
  }
  const importer = path.resolve(mainDir, fromRel);
  // An absolute specifier (drive, POSIX '/x' — drive-rooted on Windows — or a
  // decoded file: URL) wins over the importer directory in path.resolve.
  const raw = path.resolve(path.dirname(importer), s);
  const kind = src7StatKind(raw);
  if (kind === 'dir') return src7ResolveDirectory(raw);
  const asFile = src7ExistingFile(raw);
  if (asFile !== null) {
    const via: Src7Via = path.resolve(asFile) === path.resolve(raw) ? 'file' : src7TwinSource(raw) === asFile ? 'twin' : 'extensionless';
    return { raw, target: asFile, realpath: fs.realpathSync(asFile), via };
  }
  return { raw, target: raw, realpath: null, via: 'lexical' };
}

/** True when an absolute path equals mainDir or lies beneath it (case-insensitive, separators folded — Windows). */
function src7Contains(abs: string | null, mainDir: string): boolean {
  if (abs === null) return false;
  const fold = (p: string): string => p.split(path.sep).join('/').replace(/\/+$/, '').toLowerCase();
  const target = fold(abs);
  const root = fold(path.resolve(mainDir));
  return target === root || target.startsWith(`${root}/`);
}

/**
 * SRC-7' over a load-site inventory: every LOCAL edge's ACTUAL executable
 * target (directory package.json main/exports/index, twin mapping, realpath)
 * must stay inside `mainDir`. A finding records the raw lexical resolution
 * (`resolved`), the resolution channel (`via`) and the final observed target
 * (`actual`) — the round-10 directory probe escapes via 'directory-main' and
 * the junction probe via 'realpath' (raw inside, realpath outside), while the
 * round-9 wrapper rows keep their 'lexical' escapes. Unparseable file: URLs
 * and unresolvable existing directories are findings (fail closed). EMPTY
 * allowed set. Sorted.
 */
function src7EscapesOfSites(sites: LoadSite[], mainDir: string): Src7Finding[] {
  const relOf = (abs: string): string => path.relative(mainDir, abs).split(path.sep).join('/');
  const findings: Src7Finding[] = [];
  for (const site of sites) {
    if (!isLocalLoadSpecifier(site.specifier)) continue;
    const res = resolveActualMainTarget(site.file, site.specifier, mainDir);
    if (res.via === 'unparseable' || res.raw === null) {
      findings.push({
        file: site.file,
        form: site.form,
        specifier: site.specifier,
        resolved: '<unparseable file: URL>',
        via: 'unparseable',
        actual: '<unparseable file: URL>',
        fragment: site.fragment,
      });
      continue;
    }
    const containmentPath = res.realpath ?? res.target ?? res.raw;
    if (src7Contains(containmentPath, mainDir)) continue;
    // Only the realpath left the root (the pre-realpath target was inside):
    // a symlink/junction moved it — report the channel as 'realpath'.
    const via = res.realpath !== null && res.target !== null && src7Contains(res.target, mainDir) ? 'realpath' : res.via;
    findings.push({
      file: site.file,
      form: site.form,
      specifier: site.specifier,
      resolved: relOf(res.raw),
      via,
      actual: relOf(containmentPath),
      fragment: site.fragment,
    });
  }
  const key = (f: Src7Finding): string => [f.file, f.form, f.specifier, f.resolved, f.via, f.actual, f.fragment].join('\u0000');
  return findings.sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-7 findings over a whole tree (the same inventory, file by file). */
function src7FindingsOfTree(tree: ReadonlyMap<string, string>, mainDir: string): Src7Finding[] {
  return src7EscapesOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)), mainDir);
}

/** One SRC-7' walk finding: a symlink/junction ENTRY under the enumerated root. */
interface Src7LinkFinding {
  /** The link entry's path, relative to the root, forward slashes. */
  link: string;
}

/**
 * SRC-7' walk rule (amendment (x)): every symlink/junction ENTRY encountered
 * while enumerating the tree is a finding with an EMPTY allowed set — on
 * Windows a junction reports Dirent.isSymbolicLink() === true (verified;
 * round 10's junction probe) while being neither isDirectory() nor isFile(),
 * so listTsFiles neither follows nor scans it. Links are neither followed nor
 * scanned: a link's target can change after review, so EVERY link fails,
 * even one pointing in-tree (pinned by a self-test row).
 */
function src7LinkFindingsOf(dir: string): Src7LinkFinding[] {
  const out: Src7LinkFinding[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        out.push({ link: path.relative(dir, full).split(path.sep).join('/') });
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort((a, b) => a.link.localeCompare(b.link));
}

/** One SRC-7' nested-manifest finding: a package.json under the root whose main/exports targets leave it. */
interface Src7PackageJsonFinding {
  /** The package.json path, relative to the root, forward slashes. */
  file: string;
  /** 'main' or 'exports' (an unparseable package.json fails closed under 'main' with target ''). */
  field: 'main' | 'exports';
  /** The offending target string as written. */
  target: string;
  /** The target's resolved location, relative to the root ('..' escapes). */
  resolved: string;
}

/**
 * SRC-7' nested-manifest rule (amendment (x)): a package.json inside the
 * enumerated root is itself a finding source — its `main` target and EVERY
 * string target its `exports` can produce (fixed part before '*', resolved
 * against the manifest's directory, containment after realpath when the
 * target exists, lexical otherwise) must resolve INSIDE the root. This pins
 * the round-10 container-probe shape: the nested manifest routing loads
 * outside main is a finding even before anyone imports the directory. EMPTY
 * allowed set. Sorted.
 */
function src7PackageJsonFindingsOf(dir: string): Src7PackageJsonFinding[] {
  const findings: Src7PackageJsonFinding[] = [];
  const relOf = (abs: string): string => path.relative(dir, abs).split(path.sep).join('/');
  const checkTarget = (pkgDir: string, rel: string, field: 'main' | 'exports', target: string): void => {
    const resolved = path.resolve(pkgDir, src7ExportsFixedPart(target.replace(/\\/g, '/')));
    const candidate = src7ExistingFile(resolved) ?? resolved;
    const containmentPath = src7StatKind(candidate) !== null ? fs.realpathSync(candidate) : candidate;
    if (!src7Contains(containmentPath, dir)) findings.push({ file: rel, field, target, resolved: relOf(containmentPath) });
  };
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(d, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, childRel);
      else if (entry.isFile() && entry.name.toLowerCase() === 'package.json') {
        let pkg: Record<string, unknown> | null = null;
        try {
          pkg = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
        } catch {
          pkg = null;
        }
        if (pkg === null) {
          findings.push({ file: childRel, field: 'main', target: '', resolved: '<unparseable package.json>' });
          continue;
        }
        if (typeof pkg.main === 'string') checkTarget(d, childRel, 'main', pkg.main);
        if (pkg.exports !== null && (typeof pkg.exports === 'string' || typeof pkg.exports === 'object')) {
          for (const target of src7ExportsStringTargets(pkg.exports, [])) checkTarget(d, childRel, 'exports', target);
        }
      }
    }
  };
  walk(dir, '');
  return findings.sort((a, b) => [a.file, a.field, a.target, a.resolved].join('\u0000').localeCompare([b.file, b.field, b.target, b.resolved].join('\u0000')));
}

/** One SRC-8 finding: a load site whose COOKED specifier begins '#'. */
interface Src8Finding {
  file: string;
  form: string;
  specifier: string;
  fragment: string;
}

/**
 * SRC-8 over a load-site inventory: every load site, on ANY route, whose
 * COOKED specifier begins '#' — a Node package.json `imports` alias, which
 * can map to any external package or local file. EMPTY allowed set: the
 * alias is BANNED, never resolved. Sorted.
 */
function src8FindingsOfSites(sites: LoadSite[]): Src8Finding[] {
  const key = (f: Src8Finding): string => [f.file, f.form, f.specifier, f.fragment].join('\u0000');
  return sites
    .filter((s) => s.specifier !== COMPUTED && s.specifier.startsWith('#'))
    .map(({ file, form, specifier, fragment }) => ({ file, form, specifier, fragment }))
    .sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-8 findings over a whole tree (the same inventory, file by file). */
function src8FindingsOfTree(tree: ReadonlyMap<string, string>): Src8Finding[] {
  return src8FindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)));
}

// ---- NATIVE CODE EXECUTION (amendment (y), round 10 — plan Revision 11 SRC-9) ----
//
// Round 10 EXECUTED native code in the main PID with ZERO findings in all 17
// layers: better-sqlite3's PUBLIC `nativeBinding` option (a path its
// lib/binding.js:9-15 path.resolve + require loads — desktop/node_modules is
// not desktop/main source, so the package's own internal loading is OUT OF
// SCOPE; the rule polices desktop/main SOURCE) selected the canonical .node
// addon and ran native SQL; a recognised createRequire result calling
// require('./native-parser.node') did the same. SRC-5's member list has no
// nativeBinding and SRC-6 sees no package for a relative .node path. SRC-9
// fails closed with EMPTY allowed sets on BOTH shapes; native addons stay
// reachable through their SRC-6-classified package entry — loading a
// DIFFERENT addon's binary by path is exactly the escape SRC-9 closes.

/**
 * SRC-9 (1): the nativeBinding member — better-sqlite3's public
 * path-to-require option (the critic's binding.js evidence). ANY runtime
 * reference in desktop/main is a finding; a same-named local declaration
 * counts too (deliberately conservative — the walk reuses the INV-3
 * runtime-reference forms: property access, literal element, destructuring,
 * option-key/shorthand, import/export specifier, bare identifier).
 */
const SRC9_NATIVE_BINDING_NAMES = ['nativeBinding'] as const;

/** Every SRC-9 nativeBinding runtime reference in one source (the INV-3 walk). */
function src9NativeBindingSitesInSource(source: string, fileRel: string): Src5Site[] {
  return runtimeNameReferencesInSource(source, fileRel, SRC9_NATIVE_BINDING_NAMES).map((r) => ({ file: fileRel, name: r.name, form: r.form, fragment: r.fragment }));
}

/** SRC-9 (1) over a tree: EVERY nativeBinding reference is a finding (EMPTY allowed set). */
function src9NativeBindingFindingsOfTree(tree: ReadonlyMap<string, string>): Src5Site[] {
  return [...tree]
    .flatMap(([rel, source]) => src9NativeBindingSitesInSource(source, rel))
    .sort((a, b) => `${a.file}\u0000${a.name}\u0000${a.form}\u0000${a.fragment}`.localeCompare(`${b.file}\u0000${b.name}\u0000${b.form}\u0000${b.fragment}`));
}

/** One SRC-9 (2) finding: a load whose specifier or actual resolved target is a `.node` binary. */
interface Src9NodeFinding {
  file: string;
  form: string;
  /** The COOKED specifier as the load site carries it. */
  specifier: string;
  /** 'specifier' (the cooked text ends .node) or 'target' (the SRC-7'-resolved executable target ends .node — directory-resolved loads included). */
  via: 'specifier' | 'target';
  /** The .node path that fired (the specifier text, or the resolved target relative to mainDir). */
  node: string;
  fragment: string;
}

/**
 * SRC-9 (2) over a load-site inventory: every load, on EVERY route the
 * inventory recognises, whose COOKED specifier ends `.node`
 * (case-insensitive — relative, absolute, file: URL and bare package
 * subpaths like 'some-pkg/prebuilds/win-x64/addon.node', so the extension
 * rule is not relative-only) OR whose SRC-7'-RESOLVED executable target
 * ends `.node` (a directory package.json main/exports/index routing to a
 * .node binary cannot smuggle it). COMPUTED specifiers name no extension
 * (the computed-specifier leg, empty allowlist, already forces literals).
 * EMPTY allowed set. Sorted.
 */
function src9NodeLoadFindingsOfSites(sites: LoadSite[], mainDir: string): Src9NodeFinding[] {
  const isNode = (p: string): boolean => p.replace(/\\/g, '/').toLowerCase().endsWith('.node');
  const findings: Src9NodeFinding[] = [];
  for (const site of sites) {
    if (site.specifier === COMPUTED) continue;
    if (isNode(site.specifier)) {
      findings.push({ file: site.file, form: site.form, specifier: site.specifier, via: 'specifier', node: site.specifier, fragment: site.fragment });
      continue;
    }
    if (!isLocalLoadSpecifier(site.specifier)) continue;
    const res = resolveActualMainTarget(site.file, site.specifier, mainDir);
    if (res.target !== null && isNode(res.target)) {
      findings.push({
        file: site.file,
        form: site.form,
        specifier: site.specifier,
        via: 'target',
        node: path.relative(mainDir, res.target).split(path.sep).join('/'),
        fragment: site.fragment,
      });
    }
  }
  const key = (f: Src9NodeFinding): string => [f.file, f.form, f.specifier, f.via, f.node, f.fragment].join('\u0000');
  return findings.sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-9 (2) findings over a whole tree (the same inventory, file by file). */
function src9NodeLoadFindingsOfTree(tree: ReadonlyMap<string, string>, mainDir: string): Src9NodeFinding[] {
  return src9NodeLoadFindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)), mainDir);
}

// ---- ALLOWED-TARGET GATE (amendments (z)/(z')/(z''), round 11 — plan
// Revision 12 SRC-10/SRC-10b/SRC-10c; AMENDED round 12 — plan Revision 13
// SRC-10' resolved package targets) ----
//
// Round 12 EXECUTED three more zero-finding routes (the critic's
// repro/critic-round12-probes.mjs + .out:13-37): SRC-10's class (b) returned
// from the package NAME before any actual-target resolution, so
// `require('better-sqlite3')` with `main/node_modules/better-sqlite3` an
// exact EXTENSIONLESS wrapper FILE parsed CANONICAL xlsx in the consumer PID
// on Node, Electron-as-Node and a REAL Electron 45.2.1 main process; a
// manifest-less `main/node_modules/better-sqlite3/` directory resolved
// index.node (LOAD_INDEX needs no package.json) and executed native SQL in
// the calling PID on all three runtimes; and `require('ajv-formats/addon')`
// — an allowed name with no installed subpath — fell through to NODE_PATH
// and parsed canonical xlsx on Node and Electron-as-Node (real Electron main
// REJECTS that specifier; recorded honestly). SRC-10' (amendment (z3))
// resolves every bare-package load the way Node would from the importing
// file and polices the RESOLVED root, identity and file — see the SRC-10'
// block below. Round 11's routes and gates are unchanged.
//
// Round 11 EXECUTED five zero-finding routes past every layer above
// (repro/critic-round11-probes.out:11-58, summarized at :60): CommonJS
// resolved an extensionless './native-parser' to native-parser.node and a
// directory './container' to container/index.node (both executed native SQL
// in the calling PID — SRC7_EXTENSIONLESS / SRC7_INDEX_NAMES omit .node, and
// the unresolved in-tree directory was no finding); an exact EXTENSIONLESS
// file main/workbook-parser — executable JavaScript that SOURCE_EXTENSIONS
// and the walk omit — parsed canonical xlsx in the consumer PID on Node,
// Electron-as-Node and a REAL Electron 45.2.1 main process while SRC-7'
// accepted its in-tree target; a nested main/package.json
// {name:'better-sqlite3', exports:{'./addon':'./native-parser.node'}} let the
// bare ALLOWED spelling 'better-sqlite3/addon' self-reference a LOCAL native
// addon (native SQL; the manifest walk policed only the exports target's
// containment, which the in-tree .node passed); and a literal dynamic
// import('./answer.wasm') executed an exported Wasm function ({answer:42}) on
// all three runtimes with no WebAssembly identifier anywhere. All five place
// executable code OUTSIDE the enumerated source set, so the closure is ONE
// positive gate on the actual target (SRC-10) plus three empty-base bans
// (SRC-10b) and a .wasm ban (SRC-10c) — not more resolver emulation. Each
// consumes the (h) load inventory and SRC-7''s actual resolver, so EVERY
// recognised load route is covered by construction.

/** One SRC-10 (d) allowlist entry: an exact (file, specifier) .json data load, with its reason. */
interface Src10JsonAllowlistEntry {
  /** The importing file, main-relative. */
  file: string;
  /** The exact COOKED specifier. */
  specifier: string;
  reason: string;
}

/**
 * SRC-10 (d): the frozen .json data-load allowlist — EMPTY at base 5d1f7338
 * (nothing under desktop/main loads JSON; the unloaded graphify cache
 * graphify-out/cache/stat-index.json is not a load target). A new JSON load
 * joins this list with a reason — a deliberate frozen-list edit — or fails.
 */
const SRC10_JSON_ALLOWLIST: Src10JsonAllowlistEntry[] = [];

/**
 * SRC-10b (iii): the desktop package's own name (base fact: desktop/package.json
 * `name`, with NO exports and NO imports — pinned by the S1 leg). A
 * self-reference specifier needs only name + exports in a package.json at or
 * above the importer to resolve ANYWHERE, before SRC-6 / SRC-9 see a target.
 */
const SRC10_SELF_REFERENCE_PACKAGE = 'trainingapp-desktop';

/** The SRC-10 pass classes ((a) source, (b) package, (c) builtin, (d) json) plus 'computed' — the computed-specifier leg's own empty-allowlist domain, not re-derived here. */
type Src10Class = 'source' | 'package' | 'builtin' | 'json' | 'computed';

/** Every SRC-10 outcome: a pass class, or one of the gate's fail-closed finding kinds (the package-* kinds are SRC-10', round 12). */
type Src10Outcome =
  | Src10Class
  | 'outside-root'
  | 'extensionless'
  | 'unknown-extension'
  | 'native-binary'
  | 'wasm-binary'
  | 'directory-load'
  | 'json-outside-allowlist'
  | 'unclassified-package'
  | 'unclassified-specifier'
  | 'unresolvable'
  | 'unparseable'
  | 'package-unresolved'
  | 'package-root-node-path'
  | 'package-root-outside-tree'
  | 'package-name-mismatch'
  | 'package-manifest-less'
  | 'package-target-outside-root'
  // SRC-10'' (amendment (z4), round 13 — plan Revision 14):
  | 'package-inner-node-modules'
  | 'package-target-missing'
  | 'package-target-outside-node-modules';

/** One SRC-10 classification: the outcome plus the loaded/offending target (main-relative where placeable), package name or specifier. */
interface Src10Classification {
  cls: Src10Outcome;
  detail: string;
}

/**
 * SRC-10's scanned source set (class (a)): every SOURCE_EXTENSIONS file the
 * walk enumerates under `mainDir`, UNION the in-memory tree keys resolved
 * against mainDir (the planned head's not-yet-emitted files and a probe
 * overlay count through their tree keys). Folded absolute paths (forward
 * slashes, lower case — Windows). This IS every other layer's enumeration,
 * so a file the walk cannot see — behind a link, outside the root, of an
 * extension the walk skips — is never class (a).
 */
function src10ScanSetOf(tree: ReadonlyMap<string, string>, mainDir: string): Set<string> {
  const fold = (p: string): string => path.resolve(p).split(path.sep).join('/').toLowerCase();
  const out = new Set<string>();
  for (const file of listTsFiles(mainDir)) out.add(fold(file));
  for (const rel of tree.keys()) out.add(fold(path.resolve(mainDir, rel)));
  return out;
}

/**
 * SRC-10 (amendment (z), AMENDED round 12 by SRC-10' / (z3)): classify ONE
 * load site. Specifier-level classes first — a built-in (SRC-3's tables,
 * class (c)); a third-party package (SRC-6's table by package name — an
 * unclassified name stays SRC-6's 'unclassified-package', a CLASSIFIED name
 * is now handed to src10ClassifyPackageSite, which judges the load's
 * RESOLVED root, identity and file: class (b) is resolved-target-based, not
 * name-based; the FILE assignment stays SRC-6's PARSER-OUTSIDE-ALLOWED
 * rule). A non-local specifier that is neither (a data: URL) is
 * unclassifiable. A LOCAL edge is resolved by SRC-7''s actual resolver: a
 * resolution that entered a directory (any channel, unresolved included) is
 * a 'directory-load'; otherwise the observed target (or, when nothing is
 * observable, the raw lexical path) is judged by containment, then
 * extension: .node / .wasm binaries, .json against SRC10_JSON_ALLOWLIST, a
 * SOURCE_EXTENSIONS file only when the scanned set contains it (or its
 * compiled-layout twin — an absent planned file counts through its tree key;
 * a broken import is 'unresolvable'), and any other file — no extension or
 * an unknown one — is unclassifiable (CommonJS would run it as JavaScript).
 */
function src10ClassifySite(site: LoadSite, scanSet: Set<string>, mainDir: string, nodeResolutions?: ReadonlyMap<string, Src10NodeResolution>): Src10Classification {
  const rel = (p: string): string => path.relative(mainDir, p).split(path.sep).join('/');
  const fold = (p: string): string => path.resolve(p).split(path.sep).join('/').toLowerCase();
  if (site.specifier === COMPUTED) return { cls: 'computed', detail: COMPUTED };
  if (canonicalBuiltinId(site.specifier) !== null) return { cls: 'builtin', detail: site.specifier };
  const pkg = packageNameOf(site.specifier);
  if (pkg !== null) {
    // SRC-10'' (amendment (z4), round 13 — plan Revision 14): with a
    // resolved batch, class (b) is judged on NODE'S OWN ANSWER (the
    // src10NodeClassifySite gates); without one (the pure-static rows that
    // must not spawn a child) the SRC-10' EMULATOR below decides — the
    // same emulator the differential leg then cross-checks.
    if (nodeResolutions !== undefined) {
      const node = nodeResolutions.get(`${src10SiteMode(site.form, site.file, mainDir)}\u0000${site.file}\u0000${site.specifier}`);
      if (node !== undefined) return src10NodeClassifySite(site, node, mainDir);
    }
    return Object.prototype.hasOwnProperty.call(THIRD_PARTY_PACKAGE_CLASSIFICATION, pkg)
      ? src10ClassifyPackageSite(site, pkg, mainDir)
      : { cls: 'unclassified-package', detail: pkg };
  }
  if (!isLocalLoadSpecifier(site.specifier)) return { cls: 'unclassified-specifier', detail: site.specifier };
  const res = resolveActualMainTarget(site.file, site.specifier, mainDir);
  if (res.via === 'unparseable' || res.raw === null) return { cls: 'unparseable', detail: site.specifier };
  if (res.via === 'directory-main' || res.via === 'directory-index' || res.via === 'directory-exports' || res.via === 'unresolved-directory') {
    return { cls: 'directory-load', detail: rel(res.raw) };
  }
  const target = res.target ?? res.raw;
  if (!src7Contains(res.realpath ?? target, mainDir)) return { cls: 'outside-root', detail: rel(res.realpath ?? target) };
  const ext = path.extname(target).toLowerCase();
  if (ext === '.node') return { cls: 'native-binary', detail: rel(target) };
  if (ext === '.wasm') return { cls: 'wasm-binary', detail: rel(target) };
  if (ext === '.json') {
    const allowed = SRC10_JSON_ALLOWLIST.some((e) => e.file === site.file && e.specifier === site.specifier);
    return { cls: allowed ? 'json' : 'json-outside-allowlist', detail: rel(target) };
  }
  if (SOURCE_EXTENSIONS.includes(ext)) {
    const member = scanSet.has(fold(target)) || scanSet.has(fold(src7TwinSource(target)));
    return { cls: member ? 'source' : 'unresolvable', detail: rel(target) };
  }
  return { cls: ext === '' ? 'extensionless' : 'unknown-extension', detail: rel(target) };
}

/** One SRC-10 finding: a load site whose actual target is in NONE of the four classes (EMPTY allowed set, every kind). */
interface Src10Finding {
  file: string;
  form: string;
  /** The COOKED specifier as the load site carries it. */
  specifier: string;
  kind: Exclude<Src10Outcome, Src10Class>;
  /** The offending target (main-relative where placeable), package name or specifier. */
  detail: string;
  fragment: string;
}

/** SRC-10 over a load-site inventory: every site whose classification is not a pass class. EMPTY allowed set. Sorted. */
function src10FindingsOfSites(sites: LoadSite[], scanSet: Set<string>, mainDir: string, nodeResolutions?: ReadonlyMap<string, Src10NodeResolution>): Src10Finding[] {
  const findings: Src10Finding[] = [];
  for (const site of sites) {
    const c = src10ClassifySite(site, scanSet, mainDir, nodeResolutions);
    if (c.cls === 'source' || c.cls === 'package' || c.cls === 'builtin' || c.cls === 'json' || c.cls === 'computed') continue;
    findings.push({ file: site.file, form: site.form, specifier: site.specifier, kind: c.cls, detail: c.detail, fragment: site.fragment });
  }
  const key = (f: Src10Finding): string => [f.file, f.form, f.specifier, f.kind, f.detail, f.fragment].join('\u0000');
  return findings.sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-10 findings over a whole tree (the same inventory, file by file; scanned set = the walk of mainDir UNION the tree keys). */
function src10FindingsOfTree(tree: ReadonlyMap<string, string>, mainDir: string, nodeResolutions?: ReadonlyMap<string, Src10NodeResolution>): Src10Finding[] {
  return src10FindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)), src10ScanSetOf(tree, mainDir), mainDir, nodeResolutions);
}

/** SRC-10 anti-vacuity: how many load sites each outcome took (pass classes AND any finding kinds), keyed by outcome. */
function src10ClassCountsOfSites(sites: LoadSite[], scanSet: Set<string>, mainDir: string, nodeResolutions?: ReadonlyMap<string, Src10NodeResolution>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) {
    const cls = src10ClassifySite(site, scanSet, mainDir, nodeResolutions).cls;
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  return counts;
}

/** One SRC-10b (ii) finding: a load whose SRC-7'-resolved target is a directory. */
interface Src10bDirectoryFinding {
  file: string;
  form: string;
  specifier: string;
  /** The directory channel SRC-7' resolved through. */
  via: 'directory-main' | 'directory-index' | 'directory-exports' | 'unresolved-directory';
  /** The directory, main-relative. */
  resolved: string;
  fragment: string;
}

/**
 * SRC-10b (ii) over a load-site inventory: EVERY local load whose SRC-7'
 * resolution entered a directory — unresolved directories (index.node,
 * empty, manifest-less) AND main/exports/index-resolved ones — is a finding.
 * EMPTY allowed set: base 5d1f7338 has no directory load, so banning the
 * whole channel is smaller and safer than emulating LOAD_AS_DIRECTORY.
 * Sorted.
 */
function src10bDirectoryLoadFindingsOfSites(sites: LoadSite[], mainDir: string): Src10bDirectoryFinding[] {
  const findings: Src10bDirectoryFinding[] = [];
  for (const site of sites) {
    if (!isLocalLoadSpecifier(site.specifier)) continue;
    const res = resolveActualMainTarget(site.file, site.specifier, mainDir);
    if (res.raw === null) continue;
    if (res.via === 'directory-main' || res.via === 'directory-index' || res.via === 'directory-exports' || res.via === 'unresolved-directory') {
      findings.push({
        file: site.file,
        form: site.form,
        specifier: site.specifier,
        via: res.via,
        resolved: path.relative(mainDir, res.raw).split(path.sep).join('/'),
        fragment: site.fragment,
      });
    }
  }
  const key = (f: Src10bDirectoryFinding): string => [f.file, f.form, f.specifier, f.via, f.resolved, f.fragment].join('\u0000');
  return findings.sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-10b (ii) findings over a whole tree (the same inventory, file by file). */
function src10bDirectoryLoadFindingsOfTree(tree: ReadonlyMap<string, string>, mainDir: string): Src10bDirectoryFinding[] {
  return src10bDirectoryLoadFindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)), mainDir);
}

/** One SRC-10b (i) finding: a package.json file under the enumerated root. */
interface Src10bPackageJsonFinding {
  /** The package.json path, relative to the root, forward slashes. */
  file: string;
}

/**
 * SRC-10b (i) walk rule: EVERY package.json anywhere under the root is a
 * finding, whatever its content — desktop/main/package.json itself included
 * (round 11: a nested manifest with name + exports lets a bare, allowed
 * package spelling self-reference a LOCAL binary before any rule sees a
 * target). Links are not followed (the SRC-7' link rule owns them). EMPTY
 * allowed set; base has NO package.json under desktop/main. Sorted.
 */
function src10bPackageJsonFindingsOf(dir: string): Src10bPackageJsonFinding[] {
  const out: Src10bPackageJsonFinding[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === 'package.json') out.push({ file: path.relative(dir, full).split(path.sep).join('/') });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** One SRC-10b (iii) finding: a package self-reference load specifier. */
interface Src10bSelfReferenceFinding {
  file: string;
  form: string;
  specifier: string;
  fragment: string;
}

/**
 * SRC-10b (iii) over a load-site inventory: every COOKED specifier equal to
 * SRC10_SELF_REFERENCE_PACKAGE or beginning '<name>/' — a package
 * SELF-REFERENCE, on any route. EMPTY allowed set; base has none (the name
 * occurs in desktop/main only inside log strings). Sorted.
 */
function src10bSelfReferenceFindingsOfSites(sites: LoadSite[]): Src10bSelfReferenceFinding[] {
  const key = (f: Src10bSelfReferenceFinding): string => [f.file, f.form, f.specifier, f.fragment].join('\u0000');
  return sites
    .filter((s) => s.specifier !== COMPUTED && (s.specifier === SRC10_SELF_REFERENCE_PACKAGE || s.specifier.startsWith(`${SRC10_SELF_REFERENCE_PACKAGE}/`)))
    .map(({ file, form, specifier, fragment }) => ({ file, form, specifier, fragment }))
    .sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-10b (iii) findings over a whole tree (the same inventory, file by file). */
function src10bSelfReferenceFindingsOfTree(tree: ReadonlyMap<string, string>): Src10bSelfReferenceFinding[] {
  return src10bSelfReferenceFindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)));
}

/** One SRC-10c finding: a load whose specifier or actual resolved target is a `.wasm` binary. */
interface Src10cWasmFinding {
  file: string;
  form: string;
  /** The COOKED specifier as the load site carries it. */
  specifier: string;
  /** 'specifier' (the cooked text ends .wasm) or 'target' (the SRC-7'-resolved executable target ends .wasm — directory-resolved loads included). */
  via: 'specifier' | 'target';
  /** The .wasm path that fired (the specifier text, or the resolved target relative to mainDir). */
  wasm: string;
  fragment: string;
}

/**
 * SRC-10c over a load-site inventory: every load, on EVERY route the
 * inventory recognises, whose COOKED specifier ends `.wasm`
 * (case-insensitive — relative, absolute, file: URL and bare package
 * subpaths) OR whose SRC-7'-RESOLVED executable target ends `.wasm`. Node
 * 24's module loader imports a .wasm module directly with no WebAssembly
 * identifier (round 11 executed import('./answer.wasm') -> run() === 42 in
 * the real Electron main PID); SRC-3's WebAssembly-global / WASI rules stay
 * for programmatic and URL instantiation. EMPTY allowed set. Sorted.
 */
function src10cWasmLoadFindingsOfSites(sites: LoadSite[], mainDir: string): Src10cWasmFinding[] {
  const isWasm = (p: string): boolean => p.replace(/\\/g, '/').toLowerCase().endsWith('.wasm');
  const findings: Src10cWasmFinding[] = [];
  for (const site of sites) {
    if (site.specifier === COMPUTED) continue;
    if (isWasm(site.specifier)) {
      findings.push({ file: site.file, form: site.form, specifier: site.specifier, via: 'specifier', wasm: site.specifier, fragment: site.fragment });
      continue;
    }
    if (!isLocalLoadSpecifier(site.specifier)) continue;
    const res = resolveActualMainTarget(site.file, site.specifier, mainDir);
    if (res.target !== null && isWasm(res.target)) {
      findings.push({
        file: site.file,
        form: site.form,
        specifier: site.specifier,
        via: 'target',
        wasm: path.relative(mainDir, res.target).split(path.sep).join('/'),
        fragment: site.fragment,
      });
    }
  }
  const key = (f: Src10cWasmFinding): string => [f.file, f.form, f.specifier, f.via, f.wasm, f.fragment].join('\u0000');
  return findings.sort((a, b) => key(a).localeCompare(key(b)));
}

/** SRC-10c findings over a whole tree (the same inventory, file by file). */
function src10cWasmLoadFindingsOfTree(tree: ReadonlyMap<string, string>, mainDir: string): Src10cWasmFinding[] {
  return src10cWasmLoadFindingsOfSites([...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel)), mainDir);
}

// ---- RESOLVED PACKAGE TARGETS (amendment (z3), round 12 — plan Revision 13
// SRC-10'; the class-(b) upgrade the round-12 critic required) ----
//
// src10ClassifySite used to award class (b) from the package NAME alone, so
// a bare allowed spelling whose ACTUAL target was a nested
// desktop/main/node_modules shadow file or a manifest-less index.node
// directory passed every layer while executing canonical xlsx / native SQL
// in the real Electron main PID. The resolver below emulates Node's
// LOAD_NODE_MODULES from the importing FILE (walk-up node_modules
// candidates, each resolved independently; the package manifest's
// exports — read with a require/import condition preference — or main;
// LOAD_AS_FILE extension probing including the exact extensionless file;
// LOAD_INDEX), models NODE_PATH as the FINAL candidate set exactly where
// Node consults it (and refuses it), and the police checks the RESOLVED
// root identity, name and target file.

/** SRC-10' rule (2): the only file extensions a resolved package target may carry. */
const SRC10_PACKAGE_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];

/** Node's LOAD_AS_FILE extension probing at a package boundary: the exact path, then .js / .json / .node (never source twins — package files are not scanned sources). */
const SRC10_PACKAGE_FILE_PROBES = ['', '.js', '.json', '.node'];

/** Node's LOAD_INDEX candidates at a package boundary (index.node included so the manifest-less index.node geometry RESOLVES and then fails the police, instead of hiding). */
const SRC10_PACKAGE_INDEX_NAMES = ['index.js', 'index.json', 'index.node'];

/** exports condition preference for require-shaped load forms (createRequire / require aliases). */
const SRC10_EXPORTS_CONDITIONS_REQUIRE = ['node', 'require', 'default', 'import'];

/** exports condition preference for import-shaped load forms (static import / export-from / dynamic import()). */
const SRC10_EXPORTS_CONDITIONS_IMPORT = ['node', 'import', 'default', 'require'];

/** How SRC-10' placed a bare-package load. */
type Src10PackageVia =
  /** A walk-up (or, refused below, NODE_PATH) candidate resolved the specifier to a target file. */
  | 'resolved'
  /** Only a NODE_PATH entry supplied the package — refused outright (round-12 escape 3). */
  | 'node-path'
  /** No candidate anywhere on the walk-up resolved the specifier (at runtime Node would reach NODE_PATH or throw). */
  | 'not-found'
  /** The winning candidate is a package directory with NO parseable package.json that resolved an index file (the round-12 index.node escape). */
  | 'manifest-less';

/** One SRC-10' resolution: what a bare-package load actually resolved to. */
interface Src10PackageResolution {
  via: Src10PackageVia;
  /** The winning candidate root (`<parent>/node_modules/<name>`, a NODE_PATH entry path, or null when nothing supplied the name). */
  root: string | null;
  /** realpathSync of the root when it exists on disk, else null. */
  rootReal: string | null;
  /** The resolved FILE (absolute), or null. */
  target: string | null;
  /** realpathSync of the target when it exists, else null. */
  targetReal: string | null;
  /** How the target was placed: exact-file (the extensionless package file), extension, exports, main, main-index, index, subpath-file. */
  targetVia: string | null;
}

/** Folded absolute path key: forward slashes, lower case (Windows). */
function src10FoldPath(p: string): string {
  return path.resolve(p).split(path.sep).join('/').toLowerCase();
}

/**
 * SRC-10' rule (1) anchor: the package-installation root ABOVE the scanned
 * tree — the NEAREST STRICT ANCESTOR of mainDir that carries a node_modules
 * directory. For the real desktop/main that ancestor IS <desktop>, so the
 * rule reads "the resolved root must realpath to <desktop>/node_modules/
 * <name>"; probe trees nested under the real desktop keep the real anchor,
 * and because the search begins ABOVE mainDir it can never be satisfied by a
 * shadow planted INSIDE the scanned tree (a main/node_modules shadow changes
 * no ancestor). Null when no ancestor carries node_modules (fail closed).
 */
function src10CanonicalPackageRootAnchor(mainDir: string): string | null {
  let dir = path.dirname(path.resolve(mainDir));
  for (;;) {
    if (src7StatKind(path.join(dir, 'node_modules')) === 'dir') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The subpath a package specifier carries after its package name ('' for a bare load, '/x' kept as written). */
function src10SubpathOf(specifier: string): string {
  const s = specifier.replace(/\\/g, '/');
  const marker = 'node_modules/';
  const cutAt = s.toLowerCase().indexOf(marker);
  const cut = cutAt !== -1 ? s.slice(cutAt + marker.length) : s;
  const head = cut.startsWith('@') || cut.startsWith('#@') ? 2 : 1;
  return cut.split('/').slice(head).join('/');
}

/** Every NODE_PATH entry (the FINAL candidate set Node consults; empty when unset). */
function src10NodePathDirs(): string[] {
  return (process.env.NODE_PATH ?? '').split(path.delimiter).filter((p) => p.trim() !== '');
}

/** LOAD_AS_FILE at a package boundary: the exact path, then .js / .json / .node. */
function src10PackageFileAt(p: string): { file: string; via: 'exact-file' | 'extension' } | null {
  for (const ext of SRC10_PACKAGE_FILE_PROBES) {
    if (src7StatKind(p + ext) === 'file') return { file: p + ext, via: ext === '' ? 'exact-file' : 'extension' };
  }
  return null;
}

/** LOAD_AS_INDEX at a package boundary (index.js / index.json / index.node). */
function src10PackageIndexAt(dir: string): string | null {
  for (const name of SRC10_PACKAGE_INDEX_NAMES) {
    const p = path.join(dir, name);
    if (src7StatKind(p) === 'file') return p;
  }
  return null;
}

/** A package.json read at a package boundary (null when absent or unparseable). */
function src10PackageManifestOf(dir: string): Record<string, unknown> | null {
  const pkgPath = path.join(dir, 'package.json');
  if (src7StatKind(pkgPath) !== 'file') return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The runtime target strings an `exports` value yields under one condition
 * preference (SRC-10' reads exports conservatively but NOT blind: only the
 * require/import condition chain Node would actually select is followed —
 * 'types'-only leaves yield no runtime file and are not followed; an
 * unrecognised condition such as 'browser' is not followed either, and a
 * value no known condition reaches resolves NOTHING, failing the candidate).
 */
function src10ExportsRuntimeTargets(value: unknown, conditions: string[], out: string[]): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) src10ExportsRuntimeTargets(v, conditions, out);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  const map = value as Record<string, unknown>;
  for (const cond of conditions) {
    if (Object.prototype.hasOwnProperty.call(map, cond)) src10ExportsRuntimeTargets(map[cond], conditions, out);
  }
  return out;
}

/**
 * The candidate RELATIVE targets an `exports` map yields for one subpath
 * ('' or './x'): the exact key's runtime targets first, else the
 * longest-fixed-part pattern key that matches (composited with the
 * subpath's variable part); null when the map does not define the subpath
 * (Node: ERR_PACKAGE_PATH_NOT_EXPORTED — the candidate fails and the walk
 * continues).
 */
function src10ExportsCandidatesFor(exportsValue: unknown, sub: string, conditions: string[]): string[] | null {
  const key = sub === '' ? '.' : `./${sub.replace(/^\//, '')}`;
  if (typeof exportsValue === 'string') return key === '.' ? [exportsValue] : null;
  if (exportsValue === null || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return null;
  const map = exportsValue as Record<string, unknown>;
  // The condition SHORTHAND: an exports object with NO '.'-prefixed key IS
  // the '.' entry's condition object (@huggingface/transformers at base).
  const hasSubpathKeys = Object.keys(map).some((k) => k.startsWith('.'));
  if (!hasSubpathKeys) {
    if (sub !== '') return null;
    const shorthand = src10ExportsRuntimeTargets(map, conditions, []);
    return shorthand.length > 0 ? shorthand : null;
  }
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    const targets = src10ExportsRuntimeTargets(map[key], conditions, []);
    return targets.length > 0 ? targets : null;
  }
  let best: { fixed: string; suffix: string; target: string } | null = null;
  for (const [k, value] of Object.entries(map)) {
    const star = k.indexOf('*');
    if (star === -1) continue;
    const fixed = k.slice(0, star);
    const suffix = k.slice(star + 1);
    if (!key.startsWith(fixed) || !key.endsWith(suffix) || key.length < fixed.length + suffix.length) continue;
    if (best !== null && fixed.length <= best.fixed.length) continue;
    const targets = src10ExportsRuntimeTargets(value, conditions, []);
    const first = targets[0];
    if (first !== undefined) best = { fixed, suffix, target: first };
  }
  if (best === null) return null;
  const variable = key.slice(best.fixed.length, key.length - best.suffix.length);
  return [best.target.replace(/\*/g, variable)];
}

/**
 * Resolve ONE candidate root the way Node's LOAD_PACKAGE_EXPORTS /
 * LOAD_AS_FILE / LOAD_AS_DIRECTORY would for a bare or subpath package load:
 * an exports map gates first (a subpath it does not define FAILS the
 * candidate — the walk continues); then LOAD_AS_FILE of the candidate path
 * (the exact path — the bare-load extensionless package FILE, the round-12
 * shadow — then .js/.json/.node); then LOAD_AS_DIRECTORY (its package.json
 * `main`, a main that is itself a directory through its index, else the
 * directory's own index files, index.node included). A package directory
 * with NO parseable manifest that resolves an index is reported
 * manifest-less (the police fails the whole shape); one that resolves
 * NOTHING returns 'failed' so the walk-up CONTINUES exactly like
 * LOAD_NODE_MODULES (a nested shadow that itself cannot resolve the
 * specifier does not stop Node from reaching desktop/node_modules).
 */
function src10TryPackageCandidate(
  nameRoot: string,
  sub: string,
  conditions: string[],
): { status: 'resolved' | 'manifest-less' | 'failed'; target: string | null; targetVia: string | null } {
  const manifest = src7StatKind(nameRoot) === 'dir' ? src10PackageManifestOf(nameRoot) : null;
  if (manifest !== null && (typeof manifest.exports === 'string' || (manifest.exports !== null && typeof manifest.exports === 'object'))) {
    const candidates = src10ExportsCandidatesFor(manifest.exports, sub, conditions);
    if (candidates === null) return { status: 'failed', target: null, targetVia: null };
    for (const c of candidates) {
      const file = src10PackageFileAt(path.resolve(nameRoot, src7ExportsFixedPart(c).replace(/\\/g, '/')));
      if (file !== null) return { status: 'resolved', target: file.file, targetVia: 'exports' };
    }
    return { status: 'failed', target: null, targetVia: null };
  }
  const candPath = sub === '' ? nameRoot : path.join(nameRoot, sub);
  const asFile = src10PackageFileAt(candPath);
  if (asFile !== null) {
    return { status: 'resolved', target: asFile.file, targetVia: sub === '' ? asFile.via : 'subpath-file' };
  }
  if (src7StatKind(candPath) === 'dir') {
    const dirManifest = sub === '' ? manifest : src10PackageManifestOf(candPath);
    if (dirManifest !== null && typeof dirManifest.main === 'string') {
      const mainAbs = path.resolve(candPath, dirManifest.main.replace(/\\/g, '/'));
      const mainFile = src10PackageFileAt(mainAbs);
      if (mainFile !== null) return { status: 'resolved', target: mainFile.file, targetVia: 'main' };
      if (src7StatKind(mainAbs) === 'dir') {
        const inner = src10PackageIndexAt(mainAbs);
        if (inner !== null) return { status: 'resolved', target: inner, targetVia: 'main-index' };
      }
    }
    const idx = src10PackageIndexAt(candPath);
    if (idx !== null) {
      // A manifest-less package directory resolving an index (index.node
      // included) is its own finding shape — Node would LOAD it; the police
      // refuses the whole candidate.
      const bareManifestLess = sub === '' && manifest === null;
      return { status: bareManifestLess ? 'manifest-less' : 'resolved', target: idx, targetVia: 'index' };
    }
  }
  return { status: 'failed', target: null, targetVia: null };
}

/**
 * SRC-10' (plan Revision 13): statically resolve a bare-package load the
 * way Node's LOAD_NODE_MODULES would FROM THE IMPORTING FILE — walk up
 * parent directories taking `<parent>/node_modules/<name>` as a candidate
 * (each resolved independently; a failing candidate does not stop the
 * walk), then — modelled as the last candidate set, exactly as Node
 * consults it — every NODE_PATH entry (`<entry>/<name>`). `mainDir`
 * parameterises the root for probe trees; the canonical root of a
 * classified package is <src10CanonicalPackageRootAnchor(mainDir)>/
 * node_modules/<name>.
 */
function resolveBarePackageTarget(fromRel: string, specifier: string, mainDir: string, form: string): Src10PackageResolution {
  const name = packageNameOf(specifier);
  if (name === null) return { via: 'not-found', root: null, rootReal: null, target: null, targetReal: null, targetVia: null };
  const sub = src10SubpathOf(specifier);
  const conditions = form === 'import' || form === 'export-from' || form === 'import()' ? SRC10_EXPORTS_CONDITIONS_IMPORT : SRC10_EXPORTS_CONDITIONS_REQUIRE;
  const finish = (via: Src10PackageVia, root: string, target: string | null, targetVia: string | null): Src10PackageResolution => ({
    via,
    root,
    rootReal: src7StatKind(root) !== null ? fs.realpathSync(root) : null,
    target,
    targetReal: target !== null && src7StatKind(target) !== null ? fs.realpathSync(target) : null,
    targetVia,
  });
  let dir = path.dirname(path.resolve(mainDir, fromRel));
  for (;;) {
    const cand = path.join(dir, 'node_modules', ...name.split('/'));
    const r = src10TryPackageCandidate(cand, sub, conditions);
    if (r.status !== 'failed') return finish(r.status === 'manifest-less' ? 'manifest-less' : 'resolved', cand, r.target, r.targetVia);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const entry of src10NodePathDirs()) {
    const cand = path.join(entry, ...name.split('/'));
    const r = src10TryPackageCandidate(cand, sub, conditions);
    if (r.status !== 'failed') return finish('node-path', cand, r.target, r.targetVia);
  }
  return { via: 'not-found', root: null, rootReal: null, target: null, targetReal: null, targetVia: null };
}

/**
 * SRC-10' class (b) (amendment (z3)): classify a load of a CLASSIFIED
 * package by its RESOLVED target, never by its spelling. Police, each with
 * an EMPTY allowed set: (1) the resolved root — walk-up node_modules first,
 * NODE_PATH modelled as the final candidate set and REFUSED — must
 * realpathSync (case-insensitive) to the node_modules of
 * src10CanonicalPackageRootAnchor(mainDir) (<desktop>/node_modules/<name>
 * for the real tree; nested
 * shadows, NODE_PATH targets, out-of-tree roots fail); (2) the
 * resolved FILE must be a .js/.mjs/.cjs/.json file whose realpath stays
 * INSIDE the resolved root (extensionless files, .node, .wasm, unknown
 * extensions, manifest-less directories and index.node fail; a package
 * .json subpath needs the — EMPTY — SRC-10 (d) allowlist exactly like a
 * local .json load); (3) the resolved root's directory name must equal the
 * SRC-6-classified name (near-vacuous on Windows' case-insensitive volume,
 * where the candidate is built FROM the name; kept for the scoped-name
 * normalisation and any case-sensitive volume); (4) the xlsx dependency is
 * `file:../vendor/sheetjs/xlsx-0.20.3.tgz` — a TARBALL install, which
 * materialises as an ordinary directory under desktop/node_modules, so its
 * resolved root IS the canonical root and it passes like every canonical
 * package (a future file:/link: dependency resolving outside the tree fails
 * rule (1)). A load no candidate can resolve is 'package-unresolved'. The
 * details are relative to the DESKTOP directory (mainDir's parent).
 */
function src10ClassifyPackageSite(site: LoadSite, pkg: string, mainDir: string): Src10Classification {
  const relToDesktopDir = (p: string | null): string => (p === null ? '' : path.relative(path.resolve(mainDir, '..'), p).split(path.sep).join('/'));
  const res = resolveBarePackageTarget(site.file, site.specifier, mainDir, site.form);
  if (res.via === 'not-found') return { cls: 'package-unresolved', detail: pkg };
  if (res.via === 'node-path') return { cls: 'package-root-node-path', detail: relToDesktopDir(res.rootReal ?? res.root) };
  if (res.via === 'manifest-less') return { cls: 'package-manifest-less', detail: relToDesktopDir(res.root) };
  const rootName = path.basename(res.root ?? '');
  if (rootName.toLowerCase() !== (pkg.split('/').pop() ?? '')) {
    return { cls: 'package-name-mismatch', detail: relToDesktopDir(res.rootReal ?? res.root) };
  }
  const anchor = src10CanonicalPackageRootAnchor(mainDir);
  if (anchor === null || res.rootReal === null || src10FoldPath(res.rootReal) !== src10FoldPath(path.join(anchor, 'node_modules', ...pkg.split('/')))) {
    return { cls: 'package-root-outside-tree', detail: relToDesktopDir(res.rootReal ?? res.root) };
  }
  if (res.target === null) return { cls: 'package-target-outside-root', detail: relToDesktopDir(res.root) };
  const targetReal = res.targetReal ?? res.target;
  if (!src7Contains(targetReal, res.rootReal)) return { cls: 'package-target-outside-root', detail: relToDesktopDir(targetReal) };
  const ext = path.extname(res.target).toLowerCase();
  if (ext === '.node') return { cls: 'native-binary', detail: relToDesktopDir(res.target) };
  if (ext === '.wasm') return { cls: 'wasm-binary', detail: relToDesktopDir(res.target) };
  if (!SRC10_PACKAGE_FILE_EXTENSIONS.includes(ext)) {
    return { cls: ext === '' ? 'extensionless' : 'unknown-extension', detail: relToDesktopDir(res.target) };
  }
  if (ext === '.json') {
    const allowed = SRC10_JSON_ALLOWLIST.some((e) => e.file === site.file && e.specifier === site.specifier);
    return { cls: allowed ? 'json' : 'json-outside-allowlist', detail: relToDesktopDir(res.target) };
  }
  return { cls: 'package', detail: pkg };
}

/** One SRC-10' resolution row: how a package-named load site actually resolved (paths relative to the desktop directory — mainDir's parent). */
interface Src10PackageResolutionRow {
  file: string;
  form: string;
  specifier: string;
  /** The package NAME (SRC-6 normalisation; classified or not). */
  name: string;
  via: Src10PackageVia;
  /** The resolved root, relative to the desktop directory ('' when not found). */
  root: string;
  /** The resolved target file, relative to the desktop directory ('' when none). */
  target: string;
  /** How the target was placed (exact-file / extension / exports / main / main-index / index / subpath-file; '' when none). */
  targetVia: string;
}

/** SRC-10' anti-vacuity: the resolved-package table over a load-site inventory (every package-named site, sorted). */
function src10PackageResolutionsOfSites(sites: LoadSite[], mainDir: string): Src10PackageResolutionRow[] {
  const relToDesktopDir = (p: string | null): string => (p === null ? '' : path.relative(path.resolve(mainDir, '..'), p).split(path.sep).join('/'));
  const out: Src10PackageResolutionRow[] = [];
  for (const site of sites) {
    if (site.specifier === COMPUTED) continue;
    const name = packageNameOf(site.specifier);
    if (name === null) continue;
    const res = resolveBarePackageTarget(site.file, site.specifier, mainDir, site.form);
    out.push({
      file: site.file,
      form: site.form,
      specifier: site.specifier,
      name,
      via: res.via,
      root: relToDesktopDir(res.root),
      target: relToDesktopDir(res.target),
      targetVia: res.targetVia ?? '',
    });
  }
  const key = (r: Src10PackageResolutionRow): string => [r.file, r.form, r.specifier].join('\u0000');
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

// ---- NODE-RESOLVED PACKAGE TARGETS (amendment (z4), round 13 — plan
// Revision 14 SRC-10''; AMENDED under the recorded CHECK_WRONG of the
// round-13 review — the emulator alone is never the source of truth) ----
//
// The round-13 critic EXECUTED three divergences between SRC-10's
// EMULATION of the package resolver and Node itself
// (repro/critic-round13-resolution.out:32-62, the no-manifest compound-
// specifier route at repro/critic-round13-inner-node-modules.out:38-47):
// (1) a bare specifier with an inner `node_modules` segment —
// `require('ajv-formats/node_modules/ajv')` — was re-cut to canonical
// `ajv` while Node resolves package `ajv-formats` subpath
// `node_modules/ajv` and executed a contributor wrapper; (2) the emulator
// omitted the ACTIVE `node-addons` condition and traversed conditions in a
// hard-coded order while Node picks the FIRST matching key of the ACTIVE
// set in manifest order; (3) the pattern comparator ignored the TRAILER,
// so an equal-fixed-prefix `./features/*.js` native pattern won at runtime.
// Each route had ZERO findings in every layer and walk, and Node,
// Electron-as-Node and a REAL Electron 45.2.1 main all loaded the native /
// wrapper target. An emulation will always lag the real algorithm, so
// SRC-10'' (amendment (z4)) stops emulating as the source of truth: class
// (b) is judged on the answer NODE ITSELF gives, in the mode the load site
// actually uses.

/** SRC-10'' (amendment (z4)): a specifier containing any `node_modules` path segment is refused BEFORE resolution (EMPTY allowed set; base: none). */
function src10SpecifierHasInnerNodeModules(specifier: string): boolean {
  return /(?:^|[/\\])node_modules(?:$|[/\\])/i.test(specifier);
}

/**
 * Amendment (z8) (round 14, plan Revision 15 R15-1): the EMITTED module
 * format of a source file — the loader the COMPILED program runs it under
 * (desktop/tsconfig.json is module/moduleResolution NodeNext, so TypeScript
 * emits exactly this format). `.cjs`/`.cts` are CommonJS and `.mjs`/`.mts`
 * are ESM regardless of any manifest; `.ts`/`.tsx`/`.js` follow the NEAREST
 * package.json walking up from the file — `"type": "module"` is ESM,
 * anything else (no `type`, another value, an unreadable manifest, or no
 * manifest at all) is CommonJS, Node's own default. desktop/main carries no
 * package.json (SRC-10b bans one), so the real tree is governed by
 * desktop/package.json's "module".
 */
function src10SourceFormatOf(file: string, mainDir: string = MAIN_DIR): 'commonjs' | 'module' {
  const abs = path.isAbsolute(file) ? file : path.resolve(mainDir, file);
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.cjs' || ext === '.cts') return 'commonjs';
  if (ext === '.mjs' || ext === '.mts') return 'module';
  let dir = path.dirname(abs);
  for (let hop = 0; hop < 64; hop += 1) {
    if (src7StatKind(path.join(dir, 'package.json')) === 'file') {
      const manifest = src10PackageManifestOf(dir);
      return manifest !== null && manifest.type === 'module' ? 'module' : 'commonjs';
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'commonjs';
}

/**
 * The load MODE of a site — AMENDED (z8): derived from the EMITTED format of
 * the IMPORTING FILE, not from the load's syntax (round 14: a `.cts` static
 * import is syntactically `import` but NodeNext emits `require()`, so the
 * import-mode answer validated a file the program never loads —
 * repro/critic-round14-probes.out:18-27). The mode table:
 *   dynamic `import()`                       -> import  (ESM always, any file)
 *   static `import` / `export-from` in
 *     .cjs / .cts                             -> require (emitted as require())
 *     .mjs / .mts                             -> import
 *     .ts / .tsx / .js                        -> the governing package.json
 *                                                `type`: 'module' -> import,
 *                                                otherwise require
 *   require-shaped forms (`require()`, `alias()`, `createRequire()()`,
 *     `member.require()`, `member[require]()`, `import=require`, ...)
 *                                             -> require
 * Base 5d1f7338: all 71 desktop/main files are .ts under desktop/package.json
 * "type": "module", so every base row keeps its pre-(z8) label.
 */
function src10SiteMode(form: string, file: string, mainDir: string = MAIN_DIR): 'require' | 'import' {
  if (form === 'import()') return 'import';
  if (form === 'import' || form === 'export-from') return src10SourceFormatOf(file, mainDir) === 'module' ? 'import' : 'require';
  return 'require';
}

/**
 * The inline ESM child source SRC-10'' runs in a PLAIN `node` process (a
 * THROWAWAY .mjs file under the system temp dir, written at test time —
 * never a file of this repo). The child receives one JSON array on stdin —
 * [{mode:'require'|'import', importer:<absolute path>, specifier:<string>},
 * ...] — and answers one JSON object on stdout:
 * {pid, node, electron, execArgv, nodeOptions, importMetaResolveArity,
 *  rows:[{resolved:<absolute path or URL string>|null,
 *         error:<string>|null}]}.
 * require-mode rows use createRequire(<importing file>).resolve(<spec>) —
 * the exact function Node's CommonJS loader uses. import-mode rows use
 * import.meta.resolve(<spec>, pathToFileURL(<importing file>).href) — the
 * two-argument form, so resolution starts FROM THE IMPORTING FILE, not
 * from the child's own module; a file: URL answer becomes a path again
 * with fileURLToPath. NODE_OPTIONS is deleted from the child environment
 * so no ambient condition injection perturbs the baseline. The child runs
 * OUTSIDE vitest's module transform (plain node -e semantics over a real
 * file), so import.meta.resolve cannot be shimmed; the flag
 * --experimental-import-meta-resolve is passed so the two-argument form is
 * active on every supported line (Node 24.16 and Electron's 24.22.1 both
 * carry it) — the SPEC independently verifies the parent argument was
 * honoured (see src10AssertNodeChildFaithful) instead of trusting the flag.
 */
const SRC10_NODE_RESOLVER_SOURCE = [
  "import { createRequire } from 'node:module';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  "let raw = '';",
  "for await (const chunk of process.stdin) raw += chunk;",
  'const requests = JSON.parse(raw);',
  'const rows = requests.map((r) => {',
  '  try {',
  '    if (r.mode === "require") {',
  '      return { resolved: createRequire(r.importer).resolve(r.specifier), error: null };',
  '    }',
  '    const url = import.meta.resolve(r.specifier, pathToFileURL(r.importer).href);',
  '    return { resolved: url.startsWith("file:") ? fileURLToPath(url) : url, error: null };',
  '  } catch (error) {',
  '    return { resolved: null, error: String((error && error.code) || error) };',
  '  }',
  '});',
  'process.stdout.write(JSON.stringify({',
  '  pid: process.pid, node: process.versions.node, electron: process.versions.electron ?? null,',
  '  execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null,',
  '  importMetaResolveArity: import.meta.resolve.length,',
  '  rows,',
  '}));',
].join('\n');

/** The electron devDependency's ELECTRON_RUN_AS_NODE executable (null when absent — the parity legs skip with an explicit reason only then). */
function src10ElectronAsNodeExecutable(): string | null {
  const p = path.resolve(MAIN_DIR, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(p) ? p : null;
}

/** Run the SRC-10'' child over an explicit request list (one batched child call). */
function src10RunResolverRequests(executable: string | null, requests: Array<{ mode: 'require' | 'import'; importer: string; specifier: string }>, extraEnv: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i320-src10n-'));
  const file = path.join(dir, 'node-resolver.mjs');
  fs.writeFileSync(file, SRC10_NODE_RESOLVER_SOURCE);
  try {
    const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: executable === null ? undefined : '1', ...extraEnv };
    delete env.NODE_OPTIONS;
    const stdout = execFileSync(executable ?? process.execPath, ['--experimental-import-meta-resolve', file], {
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
      input: JSON.stringify(requests),
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as {
      pid: number;
      node: string;
      electron: string | null;
      execArgv: string[];
      nodeOptions: string | null;
      importMetaResolveArity: number;
      rows: Array<{ resolved: string | null; error: string | null }>;
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * SRC-10'' child-faithfulness anti-vacuity: Node 24.16 silently ignores
 * the import.meta.resolve PARENT argument unless
 * --experimental-import-meta-resolve is active — an ignored parent would
 * resolve every import-mode site from the CHILD'S own temp module, giving
 * plausible-looking yet wrong rows. The probe resolves a marker specifier
 * from a THROWAWAY parent that exists ONLY in a throwaway directory: under
 * real two-argument semantics the answer is that directory; under
 * parent-ignoring semantics Node resolves from the child's own location
 * and errors (the marker is nowhere near it), failing the assertion. Also
 * pins the provenance facts the parity table relies on: the child really
 * ran OUTSIDE this process (a different pid), with NODE_OPTIONS deleted
 * and --experimental-import-meta-resolve in execArgv.
 */
function src10AssertNodeChildFaithful(executable: string | null, label: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i320-src10f-'));
  try {
    const parent = path.join(dir, 'parent.mjs');
    const marker = path.join(dir, 'r14-resolve-parent-marker.mjs');
    fs.writeFileSync(marker, 'export default 1;\n');
    const answer = src10RunResolverRequests(executable, [{ mode: 'import', importer: parent, specifier: './r14-resolve-parent-marker.mjs' }]);
    const row = answer.rows[0];
    if (row === undefined || row.error !== null || row.resolved === null) {
      throw new Error(`SRC-10'' child (${label}) could not resolve the marker: ${JSON.stringify(answer)}`);
    }
    if (src10FoldPath(row.resolved) !== src10FoldPath(marker)) {
      throw new Error(
        `SRC-10'' child (${label}) import.meta.resolve ignored the PARENT argument (got ${row.resolved}, want ${marker}); ` +
          `execArgv=${JSON.stringify(answer.execArgv)} arity=${answer.importMetaResolveArity}`,
      );
    }
    if (answer.pid === process.pid) throw new Error(`SRC-10'' child (${label}) ran IN-PROCESS (pid ${answer.pid}) — the resolver must be a spawned plain node`);
    if (answer.nodeOptions !== null) throw new Error(`SRC-10'' child (${label}) saw NODE_OPTIONS=${answer.nodeOptions}`);
    if (!answer.execArgv.includes('--experimental-import-meta-resolve')) {
      throw new Error(`SRC-10'' child (${label}) execArgv missing the flag: ${JSON.stringify(answer.execArgv)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A memoised batch: sites of ONE tree resolved by NODE (one child call per runtime, reused across legs). */
interface Src10NodeResolution {
  /** Absolute Node targets ('' when Node errored or answered a non-file URL). */
  target: string;
  /** Node's error string ('' when it resolved). */
  error: string;
  /** The EMULATOR's (SRC-10') target, absolute ('' when none). */
  emulated: string;
  /** src10FoldPath(Node target) === src10FoldPath(emulator target). */
  agrees: boolean;
  /** Electron-as-Node's absolute target, or its raw non-file URL ('' when absent or errored). */
  electronTarget: string;
  /**
   * True when Electron-as-Node answered a NON-FILE URL for the `electron`
   * package — under ELECTRON_RUN_AS_NODE the specifier 'electron' resolves
   * to the RUNTIME'S OWN BUILT-IN module (electron:electron), not the
   * devDependency wrapper plain Node resolves; recorded in the table, and
   * the parity leg treats it as the EXPECTED answer for that one package.
   */
  electronViaBuiltin: boolean;
  /** Electron-as-Node agreed with Node (true when the binary was absent — the leg skips with an explicit reason). */
  electronAgrees: boolean;
  /** True when the Electron binary was present and the parity row really ran. */
  electronRan: boolean;
}

/**
 * Batch-resolve every bare-package load site of a tree with NODE ITSELF in
 * each site's own mode — AMENDED (z8): the mode of the importing file's
 * EMITTED format (src10SiteMode: require-mode -> createRequire(importer)
 * .resolve; import-mode -> import.meta.resolve in the spawned ESM child; a
 * `.cts` static import is require-mode), plus the
 * SAME batch under ELECTRON-AS-NODE (ELECTRON_RUN_AS_NODE=1 over the
 * electron devDependency's binary) and the SRC-10' emulator, for the
 * differential. NODE_PATH is INHERITED by the child legs (Node's own
 * CommonJS resolver consults it last; ESM ignores it) — a NODE_PATH-supplied
 * target carries no canonical node_modules root and the gates refuse it,
 * and the base fact pins that no repo config sets one. Keys use the site's file
 * AS THE CALLER WROTE IT (relative for tree legs, absolute for the base
 * walk); `mainDir` resolves RELATIVE site files to the importer the child
 * resolves from (absolute site files pass through unchanged).
 */
function src10NodeResolutionsOfSites(sites: LoadSite[], mainDir: string = MAIN_DIR): Map<string, Src10NodeResolution> {
  const importerOf = (file: string): string => (path.isAbsolute(file) ? file : path.resolve(mainDir, file));
  const packageSites = sites.filter((s) => s.specifier !== COMPUTED && packageNameOf(s.specifier) !== null);
  const requests = packageSites.map((s) => ({ mode: src10SiteMode(s.form, s.file, mainDir), importer: importerOf(s.file), specifier: s.specifier }));
  const cache = new Map<string, Src10NodeResolution>();
  if (requests.length === 0) return cache;
  const keyParts = (mode: string, file: string, specifier: string): string => `${mode}\u0000${file}\u0000${specifier}`;
  const keyOf = (r: { mode: string; importer: string; specifier: string }): string => keyParts(r.mode, r.importer, r.specifier);
  const unique = new Map<string, { mode: 'require' | 'import'; importer: string; specifier: string }>();
  for (const r of requests) unique.set(keyOf(r), r);
  const list = [...unique.values()];
  const nodeRun = src10RunResolverRequests(null, list);
  const electronExe = src10ElectronAsNodeExecutable();
  const electronRun = electronExe === null ? null : src10RunResolverRequests(electronExe, list, { ELECTRON_RUN_AS_NODE: '1' });
  const emulated = new Map<string, Src10PackageResolution>();
  const rowIndex = new Map<string, number>();
  list.forEach((r, i) => rowIndex.set(keyOf(r), i));
  for (const r of list) {
    const site = packageSites.find((s) => s.specifier === r.specifier && src10SiteMode(s.form, s.file, mainDir) === r.mode && importerOf(s.file) === r.importer);
    if (site !== undefined) emulated.set(keyOf(r), resolveBarePackageTarget(site.file, site.specifier, mainDir, site.form));
  }
  for (const site of packageSites) {
    const r = { mode: src10SiteMode(site.form, site.file, mainDir), importer: importerOf(site.file), specifier: site.specifier };
    const i = rowIndex.get(keyOf(r));
    if (i === undefined) continue;
    const nodeRow = nodeRun.rows[i] ?? { resolved: null, error: 'missing-row' };
    const eleRow = electronRun === null ? null : (electronRun.rows[i] ?? { resolved: null, error: 'missing-row' });
    const emu = emulated.get(keyOf(r));
    const nodeTarget = nodeRow.resolved !== null && nodeRow.error === null ? nodeRow.resolved : '';
    const emuTarget = emu !== undefined && emu.target !== null ? emu.target : '';
    const electronAnswer = eleRow !== null && eleRow.resolved !== null && eleRow.error === null ? eleRow.resolved : '';
    // The one EXPECTED cross-runtime identity difference: under
    // ELECTRON_RUN_AS_NODE the specifier 'electron' resolves to the
    // runtime's OWN built-in (a non-file URL such as 'electron:electron'),
    // not the devDependency wrapper plain Node resolves. Recorded in the
    // table; only that package's rows accept the builtin answer.
    const electronViaBuiltin = electronAnswer !== '' && !/^[a-z]:/i.test(electronAnswer) && electronAnswer.includes(':') && packageNameOf(site.specifier) === 'electron';
    cache.set(keyParts(r.mode, site.file, site.specifier), {
      target: nodeTarget,
      error: nodeRow.error ?? '',
      emulated: emuTarget,
      agrees: nodeTarget !== '' && emuTarget !== '' && src10FoldPath(nodeTarget) === src10FoldPath(emuTarget),
      electronTarget: electronAnswer,
      electronViaBuiltin,
      electronAgrees:
        electronRun === null
          ? true
          : electronViaBuiltin || (electronAnswer !== '' && src10FoldPath(electronAnswer) === src10FoldPath(nodeTarget)),
      electronRan: electronRun !== null,
    });
  }
  return cache;
}

/** One row of the SRC-10'' per-site table: site, mode, Node's target, the emulator's target, Electron-as-Node's target (paths relative to the desktop directory). */
interface Src10NodeResolutionRow {
  file: string;
  form: string;
  mode: 'require' | 'import';
  specifier: string;
  node: string;
  emulator: string;
  electron: string;
  electronRan: boolean;
  agrees: boolean;
  electronAgrees: boolean;
}

/** The per-site resolution table (the round-14 evidence the S1 legs print and pin). */
function src10NodeResolutionRowsOfSites(sites: LoadSite[]): Src10NodeResolutionRow[] {
  const desktop = path.resolve(MAIN_DIR, '..');
  const rel = (p: string): string => (p === '' ? '' : path.relative(desktop, p).split(path.sep).join('/'));
  const cache = src10NodeResolutionsOfSites(sites);
  const out: Src10NodeResolutionRow[] = [];
  for (const site of sites) {
    if (site.specifier === COMPUTED || packageNameOf(site.specifier) === null) continue;
    const mode = src10SiteMode(site.form, site.file);
    const r = cache.get(`${mode}\u0000${site.file}\u0000${site.specifier}`);
    if (r === undefined) continue;
    out.push({ file: site.file, form: site.form, mode, specifier: site.specifier, node: rel(r.target), emulator: rel(r.emulated), electron: r.electronViaBuiltin ? r.electronTarget : rel(r.electronTarget), electronRan: r.electronRan, agrees: r.agrees, electronAgrees: r.electronAgrees });
  }
  return out.sort((a, b) => [a.file, a.form, a.specifier].join('\u0000').localeCompare([b.file, b.form, b.specifier].join('\u0000')));
}

/**
 * The memoised SRC-10'' batch over the REAL base tree's load sites (importers
 * absolute) — ONE Node child call and ONE Electron-as-Node child call shared
 * by every S1 leg of the run (the batch helper itself spawns per invocation;
 * the legs below run many).
 */
let src10BaseNodeBatch: ReadonlyMap<string, Src10NodeResolution> | null = null;
function src10BaseNodeResolutions(): ReadonlyMap<string, Src10NodeResolution> {
  if (src10BaseNodeBatch === null) {
    src10BaseNodeBatch = src10NodeResolutionsOfSites(loadSitesOf(listTsFiles(MAIN_DIR)), MAIN_DIR);
  }
  return src10BaseNodeBatch;
}

/** SRC-10 findings over a tree with class (b) judged on NODE'S OWN ANSWER (one batched child call per runtime). */
function src10NodeFindingsOfTree(tree: ReadonlyMap<string, string>, mainDir: string): Src10Finding[] {
  const sites = [...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel));
  return src10FindingsOfSites(sites, src10ScanSetOf(tree, mainDir), mainDir, src10NodeResolutionsOfSites(sites, mainDir));
}

/**
 * SRC-10'' (amendment (z4)) — judge a bare-package load site on NODE'S OWN
 * ANSWER, in the site's mode. Order:
 *  (0) the inner-node_modules BAN: a bare specifier containing any
 *      `node_modules` path segment is `package-inner-node-modules` — an
 *      EMPTY allowed set, checked BEFORE any resolution (round-13 finding
 *      1; Node treats the inner segment as ordinary subpath text and the
 *      emulator re-cut it to a different package's identity);
 *  (1) `package-unresolved` when the batch recorded no row for the site, or
 *      Node THREW for it (unresolvable = fail closed), or Node answered a
 *      non-file URL (a package can never be a built-in: builtins were
 *      class (c) before this branch);
 *  (2) derive the ROOT from NODE'S RESOLVED PATH — the ancestor `node_modules`
 *      directory chain of the target — and the NAME as the path segment
 *      under it (`<node_modules>/@scope/name/...`); never from the
 *      specifier spelling;
 *  (3) `unclassified-package` when that derived name is not in the SRC-6
 *      table, `package-name-mismatch` when the RESOLVED PATH's directory
 *      identity is not the package the site SPELLS (a legacy main can land
 *      a spelling in ANOTHER canonical root; resolved-PATH/alias identity,
 *      never manifest/publisher identity — (z10)(b)), and
 *      `package-root-outside-tree` when the root does not sit under the
 *      canonical `<desktop>/node_modules` (NODE_PATH targets, shadows,
 *      out-of-tree roots: Node found them, the police refuse them);
 *  (4) `package-target-missing` when Node's target does not exist on disk
 *      (fail closed), `native-binary` for .node (SRC-9's channel,
 *      re-applied to Node's answer), `wasm-binary` for .wasm (SRC-10c),
 *      `extensionless` / `unknown-extension` outside
 *      SRC10_PACKAGE_FILE_EXTENSIONS, `package-target-outside-root` when
 *      realpathSync leaves the derived root, and the (EMPTY) JSON
 *      allowlist for .json exactly as a local .json load;
 *  (5) `package` — the pass class — only after every gate above.
 * The EMULATOR (SRC-10', kept verbatim above) is a DIFFERENTIAL
 * CROSS-CHECK only: a disagreement is reported by the S1 leg (and asserted
 * empty at base as anti-vacuity) but never gates a load — round-13's
 * finding-2/3 layouts are exactly emulator-green, Node-red.
 */
function src10NodeClassifySite(site: LoadSite, node: Src10NodeResolution, mainDir: string = MAIN_DIR): Src10Classification {
  const relToDesktopDir = (p: string): string => path.relative(path.resolve(mainDir, '..'), p).split(path.sep).join('/');
  if (!isLocalLoadSpecifier(site.specifier) && src10SpecifierHasInnerNodeModules(site.specifier)) {
    return { cls: 'package-inner-node-modules', detail: site.specifier };
  }
  if (node.target === '') return { cls: 'package-unresolved', detail: node.error === '' ? site.specifier : `${site.specifier} (${node.error})` };
  const segments = node.target.replace(/\\/g, '/').split('/');
  const nmIndex = segments.lastIndexOf('node_modules');
  if (nmIndex === -1 || nmIndex + 1 >= segments.length) return { cls: 'package-root-outside-tree', detail: relToDesktopDir(node.target) };
  const rest = segments.slice(nmIndex + 1);
  const derivedName = ((rest[0] ?? '').startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : (rest[0] ?? '')).toLowerCase();
  const root = segments.slice(0, nmIndex + 1 + (derivedName.includes('/') ? 2 : 1)).join('/');
  if (!Object.prototype.hasOwnProperty.call(THIRD_PARTY_PACKAGE_CLASSIFICATION, derivedName)) {
    return { cls: 'unclassified-package', detail: derivedName };
  }
  // The package Node LANDED in must be the package the site SPELLS (SRC-6's
  // PARSER file assignment keys on the spelling): a legacy main such as
  // '../xlsx/xlsx.js' would otherwise let a NON-PARSER spelling land in a
  // canonical PARSER root. AMENDED (z10)(b): this pins RESOLVED-PATH
  // identity (the node_modules directory the target sits in) against the
  // spelled name — it never reads the resolved manifest's `name`, so a
  // legitimate npm alias stays green and the aliased package's CONTENTS are
  // reviewed during SRC-6 classification; no npm/publisher identity claim.
  if (derivedName !== packageNameOf(site.specifier)) return { cls: 'package-name-mismatch', detail: relToDesktopDir(root) };
  const anchor = src10CanonicalPackageRootAnchor(mainDir);
  if (anchor === null || src10FoldPath(root) !== src10FoldPath(path.join(anchor, 'node_modules', ...derivedName.split('/')))) {
    return { cls: 'package-root-outside-tree', detail: relToDesktopDir(root) };
  }
  if (src7StatKind(node.target) !== 'file') return { cls: 'package-target-missing', detail: relToDesktopDir(node.target) };
  const targetReal = fs.realpathSync(node.target);
  const rootReal = fs.realpathSync(root);
  if (!src7Contains(targetReal, rootReal)) return { cls: 'package-target-outside-root', detail: relToDesktopDir(targetReal) };
  const ext = path.extname(node.target).toLowerCase();
  if (ext === '.node') return { cls: 'native-binary', detail: relToDesktopDir(node.target) };
  if (ext === '.wasm') return { cls: 'wasm-binary', detail: relToDesktopDir(node.target) };
  if (!SRC10_PACKAGE_FILE_EXTENSIONS.includes(ext)) {
    return { cls: ext === '' ? 'extensionless' : 'unknown-extension', detail: relToDesktopDir(node.target) };
  }
  if (ext === '.json') {
    const allowed = SRC10_JSON_ALLOWLIST.some((e) => e.file === site.file && e.specifier === site.specifier);
    return { cls: allowed ? 'json' : 'json-outside-allowlist', detail: relToDesktopDir(node.target) };
  }
  return { cls: 'package', detail: derivedName };
}

// ---- real document builders (jszip in the TEST process only) -------------------

const DOCX_ENTRIES: Record<string, string> = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>',
  'word/document.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Hello from the docx child</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:t>paragraph &amp; more</w:t></w:r></w:p>' +
    '</w:body></w:document>',
};

function slideXml(runs: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    runs.map((r) => `<p:sp><p:txBody><a:p><a:r><a:t>${r}</a:t></a:r></a:p></p:txBody></p:sp>`).join('') +
    '</p:spTree></p:cSld></p:sld>'
  );
}

// slide10 is written FIRST and slide2 after slide1: the child must order
// slides numerically (1, 2, 10), not by zip order or lexically.
const PPTX_ENTRIES: Record<string, string> = {
  'ppt/slides/slide10.xml': slideXml(['Tenth slide']),
  'ppt/slides/slide1.xml': slideXml(['Slide one title', 'Fish &amp; chips', ' ']),
  'ppt/slides/slide2.xml': slideXml(['Second slide']),
};

async function writeZip(file: string, entries: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

async function writeRealDocx(dir: string, name = 'real.docx'): Promise<string> {
  return writeZip(path.join(dir, name), DOCX_ENTRIES);
}

async function writeRealPptx(dir: string, name = 'real.pptx'): Promise<string> {
  return writeZip(path.join(dir, name), PPTX_ENTRIES);
}

/** A placeholder .pdf: fake-launcher legs never parse it. */
function writePlaceholderPdf(dir: string, name = 'placeholder.pdf'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '%PDF-1.4\n% placeholder, never parsed by a fake child\n', 'latin1');
  return file;
}

// ---- fake / fixture children ------------------------------------------------------

interface FakeChild {
  listeners: Record<string, Array<(value: unknown) => void>>;
  delivered: unknown[];
  killCalls: number;
  on(event: string, cb: (value: unknown) => void): FakeChild;
  kill(): boolean;
  emit(event: string, value: unknown): void;
}

function makeFakeChild(): FakeChild {
  const child: FakeChild = {
    listeners: {},
    delivered: [],
    killCalls: 0,
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

/**
 * Once the runner has subscribed (exit listener present), deliver `report`
 * (when given) and then `exit` (when non-null) — asynchronously, as real IPC
 * would. Returns a canceller.
 */
function scriptChild(child: FakeChild, report: unknown, exitCode: number | null): () => void {
  const timer = setInterval(() => {
    if ((child.listeners.exit ?? []).length === 0) return;
    clearInterval(timer);
    if (report !== undefined) child.emit('message', report);
    if (exitCode !== null) child.emit('exit', exitCode);
  }, 10);
  return () => clearInterval(timer);
}

interface LaunchCall {
  modulePath: string;
  args: string[];
}

/** Register a fake launcher that hands out `children` in order, recording calls. */
function registerFakeLauncher(children: FakeChild[]): LaunchCall[] {
  const calls: LaunchCall[] = [];
  setDocWorkerForkFn((modulePath: string, args: string[]) => {
    calls.push({ modulePath, args: [...args] });
    const next = children[calls.length - 1];
    if (next === undefined) throw new Error(`spec: unexpected launch #${calls.length}`);
    return next as unknown as DocWorkerChild;
  });
  return calls;
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

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/spec guard/);
    return err as Error;
  }
  throw new Error('spec: expected a rejection, got a resolution');
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

/**
 * Run `fn` as if inside Electron (process.versions.electron present), so the
 * runner's node-fork default is unavailable and only a REGISTERED launcher —
 * or the refusal — can serve the call. Restored in finally.
 */
async function asElectron<T>(fn: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.versions, 'electron');
  if (!had) {
    Object.defineProperty(process.versions, 'electron', {
      value: '0.0.0-i320-spec',
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }
  try {
    return await fn();
  } finally {
    if (!had) delete (process.versions as Record<string, unknown>).electron;
  }
}

/**
 * Spec-owned CommonJS fixture child for the REAL fork containment leg (S4):
 * bytes starting with the zip magic PK\x03\x04 crash it with exit 2 and NO
 * report; anything else is reported back verbatim as utf8 text over node IPC.
 */
function writeCrashingFixtureChild(dir: string): string {
  const source = [
    "'use strict';",
    "const fs = require('node:fs');",
    'const file = process.argv[process.argv.length - 1];',
    'const buf = fs.readFileSync(file);',
    'if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {',
    '  process.exit(2);',
    '}',
    "process.send({ ok: true, text: buf.toString('utf8') }, () => process.exit(0));",
    '',
  ].join('\n');
  const file = path.join(dir, 'fixture-doc-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/** Spec-owned CommonJS child that NEVER exits and NEVER reports. */
function writeNeverExitingChild(dir: string): string {
  const file = path.join(dir, 'fixture-hung-doc-child.cjs');
  fs.writeFileSync(file, ["'use strict';", 'setInterval(() => {}, 1000);', ''].join('\n'), 'utf8');
  return file;
}

// =====================================================================================

describe('#320 AC1 S1/S2: no docx/pptx/pdf parser and no zip cap remain in the main process', () => {
  it('S1 self-test (amendment h): the AST inventory resolves every load form to its COOKED specifier or COMPUTED', () => {
    // Each row: the inventory of an in-memory source, as `${form} ${specifier}`
    // per load site in source order.
    const inv = (code: string): string[] =>
      loadSitesInSource(code, 'selfcheck-probe.ts').map((s) => `${s.form} ${s.specifier}`);
    const rows: Array<[string, string, string[]]> = [
      // Round 1: the original load shapes.
      ['static default import', "import mammoth from 'mammoth';", ['import mammoth']],
      ['dynamic import', 'const m = await import("mammoth");', ['import() mammoth']],
      ['plain require', "const m = require('mammoth');", ['require() mammoth']],
      ['side-effect import', "import 'mammoth';", ['import mammoth']],
      ['a plain re-export IS a load', "export { default } from 'mammoth';", ['export-from mammoth']],
      ['pdfjs subpath dynamic import', "await import('pdfjs-dist/legacy/build/pdf.mjs')", ['import() pdfjs-dist/legacy/build/pdf.mjs']],
      ['namespace import', "import * as pdfjs from 'pdfjs-dist';", ['import pdfjs-dist']],
      ['dynamic import .default', "(await import('jszip')).default", ['import() jszip']],
      // Round 2 (amendment b): whitespace, import attributes, type-only, look-alikes.
      ['whitespace: import ( ... )', "import ( 'jszip' );", ['import() jszip']],
      ['whitespace: require ( ... )', 'require ( "mammoth" );', ['require() mammoth']],
      ['no space after from', 'import JSZip from"jszip";', ['import jszip']],
      [
        'dynamic import with import attributes',
        "import('pdfjs-dist/legacy/build/pdf.mjs', { with: { type: 'json' } });",
        ['import() pdfjs-dist/legacy/build/pdf.mjs'],
      ],
      ['import type is NOT a load', "import type { Result } from 'mammoth';", []],
      ['export type is NOT a load', "export type { Zip } from 'jszip';", []],
      ['every named binding type-only is NOT a load', "import { type A, type B } from 'jszip';", []],
      ['every re-exported name type-only is NOT a load', "export { type A } from 'jszip';", []],
      ['a default VALUE binding beside a type binding IS a load', "import JSZip, { type A } from 'jszip';", ['import jszip']],
      ['one value binding among type bindings IS a load', "import { type A, loadAsync } from 'jszip';", ['import jszip']],
      ['a value re-export IS a load', "export { extractRawText } from 'mammoth';", ['export-from mammoth']],
      ['Array.from(...) is NOT a load', "const y = Array.from('jszip');", []],
      ['require.resolve is NOT a load', "const p = require.resolve('jszip');", []],
      ['a longer identifier is not import/require', 'const z = myimport(x); const w = myrequire(y);', []],
      [
        'look-alike names are inventoried verbatim (the parser matcher rejects them)',
        "import x from 'jszipper'; import y from 'mammoth-extra';",
        ['import jszipper', 'import mammoth-extra'],
      ],
      // Round 2 (amendment c): computed specifiers.
      ['interpolated template', 'const z = await import(`x${y}`);', ['import() <COMPUTED>']],
      ['identifier specifier', 'const z = await import(mod);', ['import() <COMPUTED>']],
      ['concatenation starting from a literal', "const z = require('a' + b);", ['require() <COMPUTED>']],
      ['whitespace before an identifier', 'const z = require ( x );', ['require() <COMPUTED>']],
      ['optional-call require', 'const z = require?.(dyn);', ['require() <COMPUTED>']],
      ['missing argument', 'const z = require();', ['require() <COMPUTED>']],
      // Round 2 (amendment f) + round 3: the critic's EXECUTED counterexamples,
      // verbatim from repro/critic-round3-scan-probe.mjs. The specifier is
      // COOKED, so every escape spelling resolves to jszip.
      [
        'probe: round-2 hex escape + alias',
        String.raw`const z = require('\x6a\x73\x7a\x69\x70'); await z.loadAsync(bytes)`,
        ['require() jszip'],
      ],
      [
        'probe: unicode escapes + alias',
        String.raw`const z = require('\u006a\u0073\u007a\u0069\u0070'); await z.loadAsync(bytes)`,
        ['require() jszip'],
      ],
      ['probe: String.raw specifier', 'const z = require(String.raw`jszip`); await z.loadAsync(bytes)', ['require() jszip']],
      ['probe: template literal, no substitutions', 'const z = require(`jszip`); await z.loadAsync(bytes)', ['require() jszip']],
      ['probe: module.require plain literal', "const z = module.require('jszip'); await z.loadAsync(bytes)", ['member.require() jszip']],
      [
        'probe: module.require escaped literal',
        String.raw`const z = module.require('\x6a\x73\x7a\x69\x70'); await z.loadAsync(bytes)`,
        ['member.require() jszip'],
      ],
      [
        'probe: direct createRequire call',
        "import { createRequire } from 'node:module'; const z = createRequire(import.meta.url)('jszip'); await z.loadAsync(bytes)",
        ['import node:module', 'createRequire()() jszip'],
      ],
      [
        'probe: aliased createRequire call',
        "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); const z = req('jszip'); await z.loadAsync(bytes)",
        ['import node:module', 'alias() jszip'],
      ],
      ['probe: computed module member', "const z = module['require']('jszip'); await z.loadAsync(bytes)", ['member[require]() jszip']],
      // The probe's side-effect row, VERBATIM, lacks the leading backslash of
      // `\x6a`, so it really names the module 'x6aszip' (the inventory sees
      // and decodes it — it is no longer invisible). The intended jszip form
      // is the next row.
      ['probe: escaped static side-effect import (verbatim)', String.raw`import 'x6a\x73\x7a\x69\x70';`, ['import x6aszip']],
      ['escaped static side-effect import', String.raw`import '\x6a\x73\x7a\x69\x70';`, ['import jszip']],
      ['escaped static import', String.raw`import z from '\x6a\x73\x7a\x69\x70';`, ['import jszip']],
      ['escaped static re-export', String.raw`export { default } from '\x6a\x73\x7a\x69\x70';`, ['export-from jszip']],
      ['escaped dynamic import', String.raw`const z = await import('\x6a\x73\x7a\x69\x70');`, ['import() jszip']],
      ['String.raw yields the RAW text (not cooked)', 'const z = require(String.raw`j\\x73zip`);', ['require() j\\x73zip']],
      // Round 3 (plan R5''): every require-function shape.
      ['import-equals require', "import z = require('jszip');", ['import=require jszip']],
      [
        'module[key] may be require',
        "const a = module[key]('jszip'); const b = module[key](x);",
        ['module[computed]() jszip', 'module[computed]() <COMPUTED>'],
      ],
      ['other members of module are NOT loads', "module.exports.f('jszip'); module['exports'].g('jszip');", []],
      [
        '.require on any receiver',
        "process.mainModule.require('jszip'); import.meta.require('jszip');",
        ['member.require() jszip', 'member.require() jszip'],
      ],
      [
        'destructured createRequire, then an alias',
        "const { createRequire } = await import('node:module'); const req = createRequire(import.meta.url); req('jszip');",
        ['import() node:module', 'alias() jszip'],
      ],
      [
        'renamed createRequire import, then an alias',
        "import { createRequire as mk } from 'node:module'; const r = mk(import.meta.url); r('jszip');",
        ['import node:module', 'alias() jszip'],
      ],
      ['renamed createRequire destructure, called directly', "const { createRequire: mk } = m; mk(u)('jszip');", ['createRequire()() jszip']],
      [
        'var / let / const aliases, transitively, through a cast',
        "var r1 = createRequire(u); let r2 = r1; const r3 = (r2 as NodeRequire); r3('jszip');",
        ['alias() jszip'],
      ],
      [
        'X.createRequire member form',
        "Module.createRequire(u)('jszip'); const q = Module.createRequire(u); q('mammoth');",
        ['createRequire()() jszip', 'alias() mammoth'],
      ],
      [
        'the base store-module shape: `require` itself bound to createRequire',
        "const require = createRequire(import.meta.url); const D = require('better-sqlite3');",
        ['require() better-sqlite3'],
      ],
      [
        'plain aliases of require / module.require',
        "const r = require; const s = module.require; const { require: t } = module; r('jszip'); s('jszip'); t('jszip');",
        ['alias() jszip', 'alias() jszip', 'alias() jszip'],
      ],
      [
        'casts and the comma idiom unwrap',
        "(0, require)('jszip' as string); (require as NodeRequire)!(('jszip'));",
        ['require() jszip', 'require() jszip'],
      ],
      ['creating a require is not itself a load', 'const r = createRequire(import.meta.url);', []],
      ['type-position import() is NOT a load', "type T = typeof import('jszip'); let v: import('mammoth').Result;", []],
    ];
    for (const [label, code, expected] of rows) {
      expect(inv(code), label).toEqual(expected);
    }
  });

  it('S1 self-test (amendment h): parser matching, computed-site shape, script kinds, the type-only premise, the call guard', () => {
    // Parser-library matching on the cooked specifier.
    for (const s of ['jszip', 'jszip/dist/jszip.min.js', 'JSZip', '../../node_modules/jszip/dist/jszip.js', 'C:\\app\\node_modules\\jszip']) {
      expect(JSZIP_SPECIFIER.test(s), s).toBe(true);
    }
    for (const s of ['jszipper', 'jszip-utils', 'my-jszip', 'x6aszip', COMPUTED]) {
      expect(JSZIP_SPECIFIER.test(s), s).toBe(false);
    }
    expect(PDFJS_SPECIFIER.test('pdfjs-dist')).toBe(true);
    expect(PDFJS_SPECIFIER.test('pdfjs-dist/legacy/build/pdf.mjs')).toBe(true);
    expect(PDFJS_SPECIFIER.test('pdfjs-dist-extra')).toBe(false);
    expect(MAMMOTH_SPECIFIER.test('mammoth')).toBe(true);
    expect(MAMMOTH_SPECIFIER.test('mammoth-extra')).toBe(false);

    // A computed site is reported as {file, fragment}; static sites are not.
    expect(
      computedSpecifierSites(loadSitesInSource("const z = await import(mod); const y = require('jszip');", 'p.ts')),
    ).toEqual([{ file: 'p.ts', fragment: 'import(mod)' }]);

    // ScriptKind by extension: every SOURCE_EXTENSIONS member parses.
    for (const ext of SOURCE_EXTENSIONS) {
      const code = ext === '.tsx' ? "const e = <div />; require('jszip');" : "require('jszip');";
      expect(
        loadSitesInSource(code, `probe${ext}`).map((s) => s.specifier),
        `${ext} parses with its own ScriptKind`,
      ).toEqual(['jszip']);
    }

    // The all-type-only named-import exclusion is sound only while main
    // compiles WITHOUT verbatimModuleSyntax (which would keep `import {}`).
    const tsconfig = fs.readFileSync(path.resolve(THIS_DIR, '../../tsconfig.json'), 'utf8');
    expect(tsconfig, 'type-only exclusion premise').not.toMatch(/"verbatimModuleSyntax"\s*:\s*true/);
  });

  it('S1 self-test (amendment j): the AST parser-call guard sees dot, element, optional and comment-separated forms', async () => {
    // Each row: the parser-call sites of an in-memory source, as `${form} ${name}`
    // in source order. Round 4 executed `z['loadAsync'](bytes)`,
    // `z?.loadAsync?.(bytes)` and comment-separated calls past the round-3
    // TEXTUAL guard; all three are plain syntax to this AST walk.
    const calls = (code: string): string[] =>
      parserCallSitesInSource(code, 'selfcheck-probe.ts').map((site) => `${site.form} ${site.name}`);
    const callRows: Array<[string, string, string[]]> = [
      ['dot call (the round-3 shape)', 'await z.loadAsync(bytes);', ['dot loadAsync']],
      ['whitespace inside a dot call', 'JSZip.loadAsync (bytes);', ['dot loadAsync']],
      ['literal element call (round 4)', "const z = require('jszip'); await z['loadAsync'](bytes);", ['element loadAsync']],
      ['optional chain call (round 4)', 'await z?.loadAsync?.(bytes);', ['dot loadAsync']],
      ['optional literal element call', "await z?.['loadAsync']?.(bytes);", ['element loadAsync']],
      ['comment between receiver and method (round 4)', 'await z /* sep */ .loadAsync(bytes);', ['dot loadAsync']],
      ['comment inside the argument list', 'await z.loadAsync(/* bytes */ bytes);', ['dot loadAsync']],
      ['bare identifier call (the old regex also caught this)', 'loadAsync(bytes);', ['bare loadAsync']],
      ['dot extractRawText', 'await m.extractRawText({ buffer });', ['dot extractRawText']],
      ['dot getDocument', 'pdfjs.getDocument({ data });', ['dot getDocument']],
      ['element getDocument with an escape-coded key (COOKED match)', String.raw`pdfjs['get\u0044ocument']({ data });`, ['element getDocument']],
      ['a property read without a call is not a call site', 'const f = z.loadAsync;', []],
      ['a longer method name is not the entry point', 'zip.loadAsyncLater(x);', []],
      ['a longer identifier is not the entry point', 'xloadAsync(y);', []],
      ['a computed element key is the disclosed residual', 'z[k](bytes);', []],
    ];
    for (const [label, code, expected] of callRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(calls(code), label).toEqual(expected);
    }
  });

  it('S1 self-test (amendment i): the loader-capability walk fails closed on every round-4 counterexample', async () => {
    // Each row: the walk's findings for an in-memory source, as `form` values
    // in walk order. Every row the plan critic EXECUTED in round 4 (plus the
    // negative shapes) is pinned to its exact finding set. Canonical-resolution
    // proofs for the runtime-loading rows live in repro/scan-selfcheck-v2.mjs
    // (this spec cannot execute them at base).
    const walk = (code: string): string[] => loaderUsesInSource(code, 'selfcheck-probe.ts').map((use) => use.form);
    const walkRows: Array<[string, string, string[]]> = [
      // ---- round-4 counterexamples (all EXECUTED by the critic) ----
      ['probe: new require', "const z = new require('jszip'); await z.loadAsync(bytes);", ['new-require']],
      ['probe: require.call', "const z = require.call(null, 'jszip'); await z.loadAsync(bytes);", ['fn.call']],
      ['probe: require.apply', "const z = require.apply(null, ['jszip']); await z.loadAsync(bytes);", ['fn.apply']],
      ['probe: require.bind', "const r = require.bind(null); const z = r('jszip'); await z.loadAsync(bytes);", ['fn.bind']],
      ['probe: assignment alias', "let r; r = require; const z = r('jszip'); await z.loadAsync(bytes);", ['assign-alias']],
      ['probe: declaration alias of require', "const r = require; const z = r('jszip'); await z.loadAsync(bytes);", ['alias-decl']],
      [
        'probe: namespace module import + computed-member createRequire',
        "import * as Module from 'module'; const z = Module['createRequire'](u)('jszip'); await z.loadAsync(bytes);",
        ['module-import-namespace', 'member-createRequire'],
      ],
      ['probe: computed-member createRequire without an import', "const z = Module['createRequire'](u)('jszip'); await z.loadAsync(bytes);", ['member-createRequire']],
      [
        'probe: dot-member createRequire',
        "const z = Module.createRequire(u)('jszip'); await z.loadAsync(bytes);",
        ['member-createRequire'],
      ],
      [
        'probe: Module._load',
        "import * as Module from 'module'; const z = Module._load('jszip', null); await z.loadAsync(bytes);",
        ['module-import-namespace', '_load'],
      ],
      ['probe: loader passed as a callback', "const z = ['jszip'].map(require)[0]; await z.loadAsync(bytes);", ['value']],
      ['probe: loader passed in an object literal', "const api = { load: require }; const z = api.load('jszip'); await z.loadAsync(bytes);", ['value']],
      ['probe: shorthand { require } passes the capability', 'function t(o: { require?: unknown }) {} t({ require });', ['value']],
      ['probe: require passed as a tagged template tag', 'const z = require`jszip`;', ['value']],
      [
        'probe: createRequire result passed as a callback',
        "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); const z = ['jszip'].map(req)[0]; await z.loadAsync(bytes);",
        ['value'],
      ],
      [
        'probe: new on a createRequire result',
        "import { createRequire } from 'node:module'; const req = createRequire(u); const z = new req('jszip'); await z.loadAsync(bytes);",
        ['new-require'],
      ],
      [
        'probe: assignment alias of a createRequire result',
        "import { createRequire } from 'node:module'; const req = createRequire(u); let r2; r2 = req; r2('jszip');",
        ['assign-alias'],
      ],
      [
        'probe: renamed createRequire bound as a value',
        "import { createRequire as mk } from 'node:module'; const mk2 = mk; mk2(u)('jszip');",
        ['value'],
      ],
      // ---- the module package: only named createRequire is a recognised origin ----
      ['default import of module', "import M from 'module';", ['module-import-default']],
      ['namespace import of module', "import * as M from 'module';", ['module-import-namespace']],
      ['other-named import of module', "import { builtinModules } from 'node:module';", ['module-import-other']],
      ['import-equals of module', "import M = require('module');", ['module-import-equals']],
      ['re-export from module', "export { createRequire } from 'module';", ['module-re-export']],
      ['createRequire imported from a non-module package', "import { createRequire } from './homemade.js';", ['non-module-createRequire-import']],
      [
        'destructured createRequire (never a recognised origin)',
        "const { createRequire } = await import('node:module'); const req = createRequire(u); req('jszip');",
        ['destructure-createRequire'],
      ],
      ['renamed createRequire destructure from an unknown receiver', "const { createRequire: mk } = m; mk(u)('jszip');", ['destructure-createRequire']],
      // ---- module identifier and computed shapes ----
      ['unshadowed module.exports', 'module.exports = {};', ['module-value']],
      ['module as a value', 'const m = module;', ['value']],
      [
        'module[computed] keeps the capability flagged',
        "const a = module[key]('jszip'); const b = module[key](x);",
        ['module-value', 'module-value'],
      ],
      [
        'the plain-aliases source of the amendment-(h) load row',
        "const r = require; const s = module.require; const { require: t } = module; r('jszip'); s('jszip'); t('jszip');",
        ['alias-decl', 'alias-decl', 'alias-decl', 'module-value'],
      ],
      ['typeof require guard (none exists at base — flagged)', "if (typeof require === 'function') { require('jszip'); }", ['typeof-guard']],
      ['typeof module guard (none exists at base — flagged)', 'if (typeof module === "object") { module.require("jszip"); }', ['typeof-guard']],
      ['direct require with a computed specifier stays fail-closed', "const name = 'jszip'; const z = require(name);", ['require(computed)']],
      ['direct member require with a computed specifier', "const z = globalThis['require'](name);", ['require(computed)']],
      ['a computed element KEY naming the loader is the disclosed residual', 'const z = globalThis[reqName]();', []],
      // ---- recognised / negative shapes ----
      ['type-position typeof import is NOT a runtime reference', "type T = typeof import('x'); let v: import('mammoth').Result;", []],
      ['a local parameter named module is not the CJS module', 'function wrap(module: { id: string }) { return module.id; }', []],
      ['a local variable named module is not the CJS module', 'let module = { id: 1 }; module.id = 2;', []],
      ['require.resolve is a non-loading use', "const p = require.resolve('jszip');", []],
      [
        'an object key named require in a plain object literal, never called',
        "const cfg = { require: 'optional-dep-name' };",
        [],
      ],
      [
        'the base update-checker pattern: named createRequire import, result only directly called and .resolve\u2019d',
        "import { createRequire } from 'node:module'; const require_ = createRequire(import.meta.url); const A = require_('ajv/dist/2020'); const p = require_.resolve('ajv-formats');",
        [],
      ],
      [
        'the base store pattern: `require` itself bound to a createRequire result',
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const D = require('better-sqlite3');",
        [],
      ],
      [
        'tracked aliases of a createRequire result stay recognised while only called',
        "import { createRequire as mk } from 'node:module'; const r1 = mk(u); const r2 = r1; const A = r2('ajv'); r2.resolve('ajv-formats');",
        [],
      ],
      ['a direct createRequire result invocation with a literal', "import { createRequire } from 'node:module'; const z = createRequire(import.meta.url)('ajv-formats');", []],
      ['module.require with a literal is a recognised member load', "const fs = module.require('fs');", []],
      ['.require on any receiver with a literal is a recognised member load', "const z = process.mainModule.require('jszip'); import.meta.require('jszip');", []],
      ['module.require.resolve is a non-loading use', "const p = module.require.resolve('fs');", []],
      ['optional-call require with a literal', "const z = require?.('jszip');", []],
      ['casts and the comma idiom unwrap to the direct call', "(0, require)('jszip' as string); (require as NodeRequire)!(('jszip'));", []],
      ['an escaped literal is a DIRECT call judged by the load layer, not the walk', String.raw`const z = require('\x6a\x73\x7a\x69\x70'); await z.loadAsync(bytes);`, []],
      [
        'the fix shape: dynamic imports are not loader-capability references',
        "const mammoth = await import('mammoth'); const JSZip = (await import('jszip')).default; const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');",
        [],
      ],
    ];
    for (const [label, code, expected] of walkRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(walk(code), label).toEqual(expected);
    }

    // Anti-vacuity: the walk really fires on a MUTATED base pattern — taking
    // update-checker.ts's recognised shape and passing its require function as
    // a callback must produce exactly one finding.
    const mutated = fs.readFileSync(path.resolve(THIS_DIR, '../../main/update-checker.ts'), 'utf8') + "\nconst probeCb = ['x'].map(require_);\n";
    expect(loaderUsesInSource(mutated, 'mutated-update-checker.ts').map((use) => use.form)).toEqual(['value']);
  });

  it('S1 self-test (amendment l / INV-2): a createRequire RESULT is recognised only in its two safe positions', async () => {
    // Each row: the walk's findings as `form` values. Round 5 EXECUTED the
    // factory row (it returned the canonical installed jszip module) and the
    // direct-callback row; neither produced any finding before INV-2.
    const walk = (code: string): string[] => loaderUsesInSource(code, 'selfcheck-probe.ts').map((use) => use.form);
    const CR = "import { createRequire } from 'node:module'; ";
    const inv2Rows: Array<[string, string, string[]]> = [
      // ---- round-5 counterexamples (EXECUTED by the critic) ----
      ['probe: factory returning the result', `${CR}function loader(){ return createRequire(import.meta.url); } const z = loader()('jszip');`, ['createRequire-escape']],
      ['probe: result passed directly as a callback', `${CR}const z = ['jszip'].map(createRequire(import.meta.url))[0];`, ['createRequire-escape']],
      // ---- every other position of a createRequire(...) call ----
      ['arrow factory', `${CR}const mk = () => createRequire(import.meta.url); mk()('jszip');`, ['createRequire-escape']],
      ['default parameter value', `${CR}function f(r = createRequire(import.meta.url)) { return r('jszip'); }`, ['createRequire-escape']],
      ['argument to another call', `${CR}keep(createRequire(import.meta.url));`, ['createRequire-escape']],
      ['object property value', `${CR}const o = { r: createRequire(import.meta.url) }; o.r('jszip');`, ['createRequire-escape']],
      ['array element', `${CR}const a = [createRequire(import.meta.url)]; a[0]('jszip');`, ['createRequire-escape']],
      ['class field', `${CR}class L { r = createRequire(import.meta.url); }`, ['createRequire-escape']],
      ['let binding', `${CR}let r = createRequire(import.meta.url); r('jszip');`, ['createRequire-escape']],
      ['var binding', `${CR}var r = createRequire(import.meta.url); r('jszip');`, ['createRequire-escape']],
      ['reassignment', `${CR}let r; r = createRequire(import.meta.url); r('jszip');`, ['assign-alias']],
      ['spread', `${CR}const o = { ...createRequire(import.meta.url) };`, ['createRequire-escape']],
      ['destructured result', `${CR}const { resolve } = createRequire(import.meta.url);`, ['createRequire-escape']],
      ['exported const binding', `${CR}export const req = createRequire(import.meta.url); req('ajv');`, ['createRequire-escape']],
      ['default export of the result', `${CR}export default createRequire(import.meta.url);`, ['createRequire-escape']],
      ['a const binding later exported by name', `${CR}const req = createRequire(import.meta.url); export { req };`, ['export-capability']],
      ['a let alias of a recognised const result', `${CR}const r1 = createRequire(import.meta.url); let r2 = r1; r2('jszip');`, ['createRequire-escape']],
      // ---- the Revision 6 addendum INV-2 clarification: const aliases, transitively ----
      ['a const alias chain whose last link is only called / .resolved', `${CR}const r1 = createRequire(import.meta.url); const r2 = r1; const r3 = r2; r3('ajv'); r3.resolve('ajv-formats');`, []],
      ['a const alias chain whose last link escapes as a callback', `${CR}const r1 = createRequire(import.meta.url); const r2 = r1; const r3 = r2; ['jszip'].map(r3);`, ['value']],
      ['a const alias chain whose middle link is exported', `${CR}const r1 = createRequire(import.meta.url); export const r2 = r1; const r3 = r2; r3('ajv');`, ['createRequire-escape']],
      ['a discarded comma operand', `${CR}const z = (createRequire(import.meta.url), 0);`, ['createRequire-escape']],
      ['ternary arm', `${CR}const r = flag ? createRequire(import.meta.url) : null;`, ['createRequire-escape']],
      // ---- recognised positions (negatives) ----
      ['immediate literal call', `${CR}const A = createRequire(import.meta.url)('ajv/dist/2020');`, []],
      ['immediate .resolve', `${CR}const p = createRequire(import.meta.url).resolve('ajv-formats');`, []],
      ["immediate ['resolve']", `${CR}const p = createRequire(import.meta.url)['resolve']('ajv-formats');`, []],
      ['const binding through a cast', `${CR}const r = (createRequire(import.meta.url) as NodeRequire); r('ajv');`, []],
      ['the base update-checker shape', `${CR}const require_ = createRequire(import.meta.url); const A = require_('ajv/dist/2020'); const B = require_('ajv-formats');`, []],
      ['the base store shape', `${CR}const require = createRequire(import.meta.url); function open() { return require('better-sqlite3'); }`, []],
    ];
    for (const [label, code, expected] of inv2Rows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(walk(code), label).toEqual(expected);
    }

    // The five REAL base createRequire files stay fully recognised (they exist
    // at base and after the fix, untouched by it).
    for (const rel of ['update-checker.ts', 'backend/store/backup.ts', 'backend/store/recovery.ts', 'backend/store/sqlite-store.ts', 'backend/store/pack-manager.ts']) {
      const text = fs.readFileSync(path.join(MAIN_DIR, ...rel.split('/')), 'utf8');
      expect(text, `${rel} carries the const-bound createRequire shape`).toMatch(/^const \w+ = createRequire\(import\.meta\.url\);$/m);
      expect(loaderUsesInSource(text, rel), `${rel} yields zero unrecognised uses`).toEqual([]);
    }
    // Anti-vacuity: the SAME real file mutated into a let binding / an exported
    // binding produces exactly one escape finding.
    const updateChecker = fs.readFileSync(path.join(MAIN_DIR, 'update-checker.ts'), 'utf8');
    for (const [label, mutation] of [
      ['let', 'let require_ = createRequire(import.meta.url);'],
      ['export const', 'export const require_ = createRequire(import.meta.url);'],
    ] as const) {
      const mutated = updateChecker.replace('const require_ = createRequire(import.meta.url);', mutation);
      expect(mutated, `${label} mutation applied`).not.toBe(updateChecker);
      expect(loaderUsesInSource(mutated, 'mutated-update-checker.ts').map((use) => use.form), label).toEqual(['createRequire-escape']);
    }
  });

  it('S1 self-test (amendment k / INV-1): the process boundary resolves every edge into a parse child', async () => {
    // Each row: [label, importing file (main-relative), source, findings as
    // `form` values, permitted edges as `target <- binding`]. Round 5 EXECUTED
    // the child-entry reuse row: before INV-1 it produced only a relative import.
    const DOC = 'backend/ingest/doc-worker.ts';
    const XLSX = 'backend/ingest/xlsx-worker.ts';
    const edges = (rel: string, code: string): [string[], string[]] => {
      const r = processBoundaryEdgesInSource(code, rel);
      return [r.findings.map((f) => f.form), r.permitted.map((p) => `${p.target} <- ${p.binding}`)];
    };
    const boundaryRows: Array<[string, string, string, string[], string[]]> = [
      // ---- the permitted edges ----
      ['the base xlsx edge (xlsx-worker.ts:28)', XLSX, "import { XLSX_WORKER_ERROR_PREFIX } from './xlsx-worker-child.js';", [], [`${XLSX_CHILD_RELATIVE} <- XLSX_WORKER_ERROR_PREFIX`]],
      ['the PLANNED doc edge', DOC, "import { DOC_WORKER_ERROR_PREFIX } from './doc-worker-child.js';", [], [`${DOC_CHILD_RELATIVE} <- DOC_WORKER_ERROR_PREFIX`]],
      ['the permitted edge with a local alias and a type binding', DOC, "import { DOC_WORKER_ERROR_PREFIX as P, type X } from './doc-worker-child.js';", [], [`${DOC_CHILD_RELATIVE} <- DOC_WORKER_ERROR_PREFIX`]],
      ['the permitted edge through a normalised path', DOC, "import { DOC_WORKER_ERROR_PREFIX } from '../ingest/./doc-worker-child.js';", [], [`${DOC_CHILD_RELATIVE} <- DOC_WORKER_ERROR_PREFIX`]],
      // ---- round-5 counterexample + wrappers ----
      ['probe: child-entry reuse from a new main module', 'backend/ingest/reuse.ts', "import { runDocChildMain } from './doc-worker-child.js'; await runDocChildMain(['/x.docx']);", ['import-by-non-runner'], []],
      ['xlsx child-entry reuse through a local wrapper', 'backend/other/wrap.ts', "import { runXlsxChildMain } from '../ingest/xlsx-worker-child.js'; export const go = runXlsxChildMain;", ['import-by-non-runner'], []],
      ['even the prefix, imported by a non-runner', 'backend/x.ts', "import { DOC_WORKER_ERROR_PREFIX } from './ingest/doc-worker-child.js';", ['import-by-non-runner'], []],
      ["a runner importing the OTHER child's prefix", DOC, "import { XLSX_WORKER_ERROR_PREFIX } from './xlsx-worker-child.js';", ['import-by-non-runner'], []],
      ['re-export of the entry', 'backend/ingest/wrap.ts', "export { runDocChildMain } from './doc-worker-child.js';", ['re-export'], []],
      ['star re-export', 'backend/ingest/wrap.ts', "export * from './xlsx-worker-child.js';", ['re-export'], []],
      ['even the runner re-exporting the prefix', DOC, "export { DOC_WORKER_ERROR_PREFIX } from './doc-worker-child.js';", ['re-export'], []],
      // ---- the runner with any other binding shape ----
      ['runner: an extra binding', DOC, "import { DOC_WORKER_ERROR_PREFIX, runDocChildMain } from './doc-worker-child.js';", ['import-binding'], []],
      ['runner: the entry only', DOC, "import { runDocChildMain } from './doc-worker-child.js';", ['import-binding'], []],
      ['xlsx runner: the entry', XLSX, "import { runXlsxChildMain } from './xlsx-worker-child.js';", ['import-binding'], []],
      ['runner: namespace import', DOC, "import * as child from './doc-worker-child.js';", ['import-namespace'], []],
      ['runner: default import', DOC, "import child from './doc-worker-child.js';", ['import-default'], []],
      ['runner: default beside the prefix', DOC, "import child, { DOC_WORKER_ERROR_PREFIX } from './doc-worker-child.js';", ['import-default'], []],
      ['runner: side-effect import', DOC, "import './doc-worker-child.js';", ['import-side-effect'], []],
      ['runner: empty named import', DOC, "import {} from './doc-worker-child.js';", ['import-binding'], []],
      ['runner: a value binding among type bindings', DOC, "import { type X, runDocChildMain } from './doc-worker-child.js';", ['import-binding'], []],
      // ---- call-form loads and import-equals (forbidden even for the runner) ----
      ['dynamic import', DOC, "const c = await import('./doc-worker-child.js'); await c.runDocChildMain([p]);", ['import()'], []],
      ['require', 'backend/ingest/x.ts', "const c = require('./doc-worker-child.js');", ['require()'], []],
      ['createRequire alias', 'backend/ingest/x.ts', "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('./xlsx-worker-child.js');", ['alias()'], []],
      ['import-equals', DOC, "import c = require('./doc-worker-child.js');", ['import-equals'], []],
      // ---- specifier spellings ----
      ['extensionless specifier', 'backend/ingest/x.ts', "import { runDocChildMain } from './doc-worker-child';", ['import-by-non-runner'], []],
      ['.ts extension specifier', 'backend/ingest/x.ts', "import { runDocChildMain } from './doc-worker-child.ts';", ['import-by-non-runner'], []],
      ['case-variant specifier (Windows resolves it)', 'backend/ingest/x.ts', "import { runDocChildMain } from './Doc-Worker-Child.js';", ['import-by-non-runner'], []],
      ['escape-coded specifier (COOKED)', 'backend/ingest/x.ts', String.raw`import { runDocChildMain } from './doc-worker-\x63hild.js';`, ['import-by-non-runner'], []],
      // ---- not edges into a child (negatives) ----
      ['type-only import', 'backend/ingest/x.ts', "import type { DocWorkerChild } from './doc-worker-child.js';", [], []],
      ['all-type named import', 'backend/ingest/x.ts', "import { type A, type B } from './doc-worker-child.js';", [], []],
      ['type-only re-export', 'backend/ingest/x.ts', "export type { A } from './xlsx-worker-child.js';", [], []],
      ['forking the child BY PATH is not a module edge', DOC, "const childPath = path.join(here, 'doc-worker-child.js'); fork(childPath, args);", [], []],
      ['the planned extractors.ts route imports the RUNNER', 'backend/ingest/extractors.ts', "import { extractDocOutOfProcess } from './doc-worker.js';", [], []],
      ['a look-alike module name', 'backend/ingest/x.ts', "import { a } from './doc-worker-child-utils.js';", [], []],
      ['a same-named module in another directory', 'backend/packs/x.ts', "import { a } from './doc-worker-child.js';", [], []],
      ['a package specifier', 'backend/ingest/x.ts', "import { a } from 'doc-worker-child';", [], []],
    ];
    for (const [label, rel, code, findings, permitted] of boundaryRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(edges(rel, code), label).toEqual([findings, permitted]);
    }
    // Absolute-path and file: URL specifiers resolve against desktop/main too.
    const abs = path.join(INGEST_DIR, 'doc-worker-child.js');
    expect(edges('backend/x.ts', `const c = await import(${JSON.stringify(abs)});`)[0], 'absolute path').toEqual(['import()']);
    expect(
      edges('backend/x.ts', `const c = await import(${JSON.stringify(pathToFileURL(abs).href)});`)[0],
      'file: URL',
    ).toEqual(['import()']);
  });

  it('S1 self-test (amendment m / INV-3): every RUNTIME reference to a parse entry point counts, type positions do not', async () => {
    // Each row: the references as `${form} ${name}` in source order. Round 5
    // EXECUTED the alias and Function.prototype.call rows: both produced zero
    // parser-CALL sites (the amendment-(j) layer only sees named callees).
    const refs = (code: string): string[] =>
      parserEntryReferencesInSource(code, 'selfcheck-probe.ts').map((ref) => `${ref.form} ${ref.name}`);
    const refRows: Array<[string, string, string[]]> = [
      // ---- round-5 counterexamples (EXECUTED by the critic) ----
      ['probe: method alias', 'const load = z.loadAsync; await load(bytes);', ['dot loadAsync']],
      ['probe: Function.prototype.call', 'await z.loadAsync.call(z, bytes);', ['dot loadAsync']],
      ['.apply', 'await z.loadAsync.apply(z, [bytes]);', ['dot loadAsync']],
      ['.bind', 'const load = z.loadAsync.bind(z); await load(bytes);', ['dot loadAsync']],
      ['destructuring', 'const { loadAsync } = z; await loadAsync(bytes);', ['binding loadAsync', 'identifier loadAsync']],
      ['renamed destructuring', 'const { loadAsync: l } = z; await l(bytes);', ['binding loadAsync']],
      ['literal-key destructuring', "const { 'loadAsync': l } = z;", ['binding loadAsync']],
      [
        'probe: cross-module handle — the EXPORTING module carries the reference',
        'export function handle(z: Zip) { return z.loadAsync; }',
        ['dot loadAsync'],
      ],
      ['cross-module handle — the importing module has none (its exporter is in desktop/main)', "import { handle } from './h.js'; await handle(z)(bytes);", []],
      ['a re-exported entry name', "export { extractRawText } from 'mammoth';", ['specifier extractRawText']],
      ['an imported entry name', "import { extractRawText as x } from 'mammoth';", ['specifier extractRawText']],
      ['optional chain read', 'const f = z?.loadAsync;', ['dot loadAsync']],
      ['literal element read', "const f = z['getDocument'];", ['element getDocument']],
      ['escape-coded element key (COOKED)', String.raw`const f = pdfjs['get\u0044ocument'];`, ['element getDocument']],
      ['typeof in an EXPRESSION is runtime', "if (typeof m.convertToHtml === 'function') {}", ['dot convertToHtml']],
      ['object member key', 'const api = { convertToMarkdown: f, getDocument() {} };', ['key convertToMarkdown', 'key getDocument']],
      ['computed literal member key', "const api = { ['loadAsync']: f };", ['key loadAsync']],
      ['shorthand property', 'const api = { extractRawText };', ['key extractRawText']],
      ['call forms still count (dot / element / optional)', "z.loadAsync(b); z['extractRawText'](b); z?.getDocument?.(b);", ['dot loadAsync', 'element extractRawText', 'dot getDocument']],
      // ---- TYPE positions (negatives) ----
      [
        'the base pdfjs type-position cast (extractors.ts:61-77 shape) — only the CALL counts',
        "const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {\n    getDocument(src: {\n      data: Uint8Array;\n      useSystemFonts: boolean;\n    }): {\n      promise: Promise<unknown>;\n    };\n  };\n  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;",
        ['dot getDocument'],
      ],
      [
        'the base mammoth type-position cast (extractors.ts:112-115 shape) — only the CALL counts',
        "const mammoth = (await import('mammoth')) as unknown as {\n    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;\n  };\n  const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });",
        ['dot extractRawText'],
      ],
      ['interface members', 'interface Z { loadAsync(b: Uint8Array): Promise<unknown>; getDocument: (s: unknown) => unknown; }', []],
      ['type alias of a type literal', 'type M = { extractRawText(i: unknown): unknown; convertToHtml: unknown };', []],
      ['type query and indexed access type', "let f: typeof z.loadAsync; let g: Z['loadAsync'];", []],
      ['type-only import of an entry name', "import type { loadAsync } from './t.js'; import { type getDocument } from './t.js';", []],
      ['ambient declare', 'declare const loadAsync: (b: Uint8Array) => Promise<unknown>;', []],
      ['a longer name is not the entry point', 'zip.loadAsyncLater(x); const xloadAsync = 1;', []],
      ['a computed element key is the disclosed residual', 'const f = z[k];', []],
    ];
    for (const [label, code, expected] of refRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(refs(code), label).toEqual(expected);
    }
    // The reference layer is a SUPERSET of the call layer on every call row.
    for (const code of ["z.loadAsync(b); z['extractRawText'](b); z?.getDocument?.(b);", 'loadAsync(bytes);']) {
      const callNames = parserCallSitesInSource(code, 'p.ts').map((site) => site.name);
      const refNames = parserEntryReferencesInSource(code, 'p.ts').map((ref) => ref.name);
      for (const name of callNames) expect(refNames, code).toContain(name);
    }
  });

  it('S1 self-test (amendment n / INV-4): every runtime naming of a parse child launch surface is confined to its owner', async () => {
    // Each row: [label, file (main-relative), source, findings as `${form}
    // ${name}`, permitted as `${form} ${name}`], in walk order ((a) literals
    // first, then the (b)/(c) references). The check author found the first
    // row's gap: INV-1 sees no module edge in it, yet worker_threads would run
    // the child's parser imports in the MAIN address space.
    const DOC = 'backend/ingest/doc-worker.ts';
    const XLSX = 'backend/ingest/xlsx-worker.ts';
    const surface = (rel: string, code: string): [string[], string[]] => {
      const r = launchSurfaceInSource(code, rel);
      return [r.findings.map((h) => `${h.form} ${h.name}`), r.permitted.map((h) => `${h.form} ${h.name}`)];
    };
    const launchRows: Array<[string, string, string, string[], string[]]> = [
      // ---- positives: an in-process or re-routed launch from another module ----
      ['new Worker over a path.join literal in another module', 'backend/retrieval/x.ts', "import { Worker } from 'node:worker_threads'; new Worker(path.join(dir, 'doc-worker-child.js'));", ['string doc-worker-child'], []],
      ['a template quasi naming the xlsx child', 'backend/x.ts', 'new Worker(`${dir}/xlsx-worker-child.js`);', ['template-part xlsx-worker-child'], []],
      ['a template HEAD quasi', 'backend/x.ts', 'const p = `doc-worker-child.${ext}`;', ['template-part doc-worker-child'], []],
      ['a no-substitution template', 'backend/x.ts', 'const p = `./xlsx-worker-child.ts`;', ['template xlsx-worker-child'], []],
      ['new URL(...) for a worker', 'backend/x.ts', "new Worker(new URL('./doc-worker-child.js', import.meta.url));", ['string doc-worker-child'], []],
      ['case-variant basename (case-insensitive)', 'backend/x.ts', "fork(path.join(here, 'Doc-Worker-Child.js'));", ['string doc-worker-child'], []],
      ['escape-coded basename (COOKED)', 'backend/x.ts', String.raw`fork(path.join(here, 'doc-worker-\x63hild.js'));`, ['string doc-worker-child'], []],
      ["the doc RUNNER naming the xlsx child", DOC, "fork(path.join(here, 'xlsx-worker-child.js'));", ['string xlsx-worker-child'], []],
      ['fork(docWorkerChildPath()) from another module', 'backend/x.ts', "import { docWorkerChildPath } from './ingest/doc-worker.js'; fork(docWorkerChildPath());", ['specifier docWorkerChildPath', 'identifier docWorkerChildPath'], []],
      ['the resolver via a namespace member', 'backend/x.ts', "fork(ingest.xlsxWorkerChildPath()); fork(ingest['docWorkerChildPath']());", ['dot xlsxWorkerChildPath', 'element docWorkerChildPath'], []],
      ['the resolver destructured from a dynamic import', 'backend/x.ts', "const { docWorkerChildPath: p } = await import('./ingest/doc-worker.js');", ['binding docWorkerChildPath'], []],
      ['a re-export of xlsxWorkerChildPath from a non-runner', 'backend/ingest/wrap.ts', "export { xlsxWorkerChildPath } from './xlsx-worker.js';", ['specifier xlsxWorkerChildPath'], []],
      ['the OTHER runner using the xlsx resolver', DOC, 'fork(xlsxWorkerChildPath());', ['identifier xlsxWorkerChildPath'], []],
      ['setDocWorkerForkFn(inProcessFn) from a non-bootstrap module', 'backend/x.ts', 'setDocWorkerForkFn(inProcessFn);', ['identifier setDocWorkerForkFn'], []],
      ['the xlsx setter imported by a non-bootstrap module', 'backend/index.ts', "import { setXlsxWorkerForkFn } from './ingest/xlsx-worker.js'; setXlsxWorkerForkFn(null);", ['specifier setXlsxWorkerForkFn', 'identifier setXlsxWorkerForkFn'], []],
      ['the setter passed as a value', 'backend/x.ts', 'const reg = ingest.setDocWorkerForkFn; reg(fn);', ['dot setDocWorkerForkFn'], []],
      ['call-form load argument: the deliberate INV-1/INV-4 overlap', 'backend/x.ts', "const c = await import('./ingest/doc-worker-child.js');", ['string doc-worker-child'], []],
      // ---- permitted (negatives: no finding) ----
      ["the runner's own path.join resolution (xlsx-worker.ts:117/119 shape)", XLSX, "const compiled = path.join(here, 'xlsx-worker-child.js'); return path.join(here, 'xlsx-worker-child.ts');", [], ['string xlsx-worker-child', 'string xlsx-worker-child']],
      ['the PLANNED doc runner: path.join + exported resolver + setter definition', DOC, "export function docWorkerChildPath(): string { return path.join(here, 'doc-worker-child.js'); } export function setDocWorkerForkFn(fn: unknown): void {} const childPath = opts.childPath ?? docWorkerChildPath();", [], ['string doc-worker-child', 'identifier docWorkerChildPath', 'identifier setDocWorkerForkFn', 'identifier docWorkerChildPath']],
      ['index.ts bootstrap registration of both setters', 'index.ts', "import { setDocWorkerForkFn } from './backend/ingest/doc-worker.js'; import { setXlsxWorkerForkFn } from './backend/ingest/xlsx-worker.js'; setDocWorkerForkFn((m, a) => utilityProcess.fork(m, a)); setXlsxWorkerForkFn((m, a) => utilityProcess.fork(m, a));", [], ['specifier setDocWorkerForkFn', 'specifier setXlsxWorkerForkFn', 'identifier setDocWorkerForkFn', 'identifier setXlsxWorkerForkFn']],
      ['a literal inside the child file itself', 'backend/ingest/doc-worker-child.ts', "const self = 'doc-worker-child';", [], ['string doc-worker-child']],
      // ---- not a launch surface at all (negatives) ----
      ['a comment mentioning the child', 'backend/x.ts', "// forks doc-worker-child.js via docWorkerChildPath() and setDocWorkerForkFn\n/* xlsx-worker-child.ts */ const a = 1;", [], []],
      ["reranker.ts's new Worker(this.workerPath)", 'backend/retrieval/reranker.ts', "import { Worker } from 'node:worker_threads'; const worker = new Worker(this.workerPath, { workerData: {} });", [], []],
      ['INV-1-governed declaration specifiers are excluded (no double report)', 'backend/x.ts', "import { runDocChildMain } from './ingest/doc-worker-child.js'; export * from './ingest/xlsx-worker-child.js'; import c = require('./ingest/doc-worker-child.js');", [], []],
      ["the runner's permitted prefix import is not an INV-4 hit", XLSX, "import { XLSX_WORKER_ERROR_PREFIX } from './xlsx-worker-child.js';", [], []],
      ['type positions do not count', 'backend/x.ts', "type P = 'doc-worker-child.js'; let f: typeof docWorkerChildPath; interface I { setDocWorkerForkFn(f: unknown): void; }", [], []],
      ['a longer identifier is not the resolver', 'backend/x.ts', 'const docWorkerChildPathCache = 1; mySetDocWorkerForkFn();', [], []],
    ];
    for (const [label, rel, code, findings, permitted] of launchRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(surface(rel, code), label).toEqual([findings, permitted]);
    }
    // The REAL base files: the xlsx runner and index.ts are permitted-only,
    // reranker.ts names nothing.
    for (const rel of ['backend/ingest/xlsx-worker.ts', 'index.ts', 'backend/retrieval/reranker.ts']) {
      const real = launchSurfaceInSource(fs.readFileSync(path.join(MAIN_DIR, ...rel.split('/')), 'utf8'), rel);
      expect(real.findings, `${rel} has no INV-4 finding`).toEqual([]);
      if (rel === 'backend/retrieval/reranker.ts') expect(real.permitted, 'reranker.ts names no parse child').toEqual([]);
      else expect(real.permitted.length, `${rel} carries permitted launch-surface hits`).toBeGreaterThan(0);
    }
    // Anti-vacuity: the SAME xlsx runner text moved to another module turns its
    // path.join literals and resolver references into findings.
    const moved = launchSurfaceInSource(fs.readFileSync(path.join(INGEST_DIR, 'xlsx-worker.ts'), 'utf8'), 'backend/ingest/copy-of-xlsx-worker.ts');
    expect(moved.permitted, 'nothing is permitted outside the owners').toEqual([]);
    expect(moved.findings.filter((h) => h.name === 'xlsx-worker-child').map((h) => h.fragment)).toEqual([
      "path.join(here, 'xlsx-worker-child.js')",
      "path.join(here, 'xlsx-worker-child.ts')",
    ]);
  });

  it('S1 self-test (amendment o / INV-5a): the runtime export-name walk and the frozen surfaces', async () => {
    // Each row: the runtime export names of an in-memory source, sorted.
    const names = (code: string): string[] => runtimeExportNamesInSource(code, 'selfcheck-probe.ts');
    const inv5ExportRows: Array<[string, string, string[]]> = [
      ['value exports of every declaration kind', 'export const A = 1; export let B = 2; export var C = 3; export function D() {} export async function E() {} export class F {} export enum G { H } export namespace I { export const J = 1; }', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I']],
      ['a destructured export const', 'export const { a, b: c } = obj;', ['a', 'c']],
      ['an export list, renames included (the PUBLIC name)', 'const x = 1; const y = 2; export { x, y as z };', ['x', 'z']],
      ['a re-export list hands out the PUBLIC names', "export { extractPackZip, isZipFilename as isZip } from './pack-extract.js';", ['extractPackZip', 'isZip']],
      ['export * from', "export * from './pack-extract.js';", ['*']],
      ['export * as ns from', "export * as packs from './pack-extract.js';", ['packs']],
      ['export default function', 'export default function run() {}', ['default']],
      ['export default class', 'export default class Runner {}', ['default']],
      ['export default expression', 'export default 42;', ['default']],
      ['export = (CJS) is not export default', 'export = {};', []],
      ['an exported import-equals', "export import child = require('./child.js');", ['child']],
      [
        'TYPE positions are excluded (interface / type alias / type re-exports / declare)',
        "export interface I { m(): void; } export type T = 1; export type { X } from './x.js'; export { type Y } from './y.js'; export declare const D: number;",
        [],
      ],
      [
        'the PLANNED doc runner surface (frozen: the xlsx mirror with doc names)',
        [
          'export const DEFAULT_DOC_TIMEOUT_MS = 120_000;',
          'export const nodeForkDocWorker: DocWorkerForkFn = (m, a) => fork(m, a);',
          'export function setDocWorkerForkFn(fn: DocWorkerForkFn | null): void {}',
          'export function resolveDocWorkerForkFn(): DocWorkerForkFn | null { return null; }',
          'export function docWorkerChildPath(): string { return ""; }',
          'export function terminateDocWorkers(): void {}',
          'export async function extractDocOutOfProcess(filePath: string): Promise<{ text: string }> { return { text: "" }; }',
        ].join('\n'),
        ['DEFAULT_DOC_TIMEOUT_MS', 'docWorkerChildPath', 'extractDocOutOfProcess', 'nodeForkDocWorker', 'resolveDocWorkerForkFn', 'setDocWorkerForkFn', 'terminateDocWorkers'],
      ],
      [
        'the PLANNED doc child surface (frozen: exactly what this spec imports from it)',
        [
          "export const DOC_WORKER_ERROR_PREFIX = 'doc worker: ';",
          'export async function runDocChildMain(argv: string[], channel?: { postMessage(m: unknown): void }): Promise<number> { return 0; }',
        ].join('\n'),
        ['DOC_WORKER_ERROR_PREFIX', 'runDocChildMain'],
      ],
    ];
    for (const [label, code, expected] of inv5ExportRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(names(code), label).toEqual(expected);
    }
    // The REAL base owners' computed surfaces equal their frozen lists (these
    // four files exist at base and are untouched by the fix).
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    for (const owner of FROZEN_OWNER_CLOSURE) {
      expect(runtimeExportNamesInSource(tree.get(owner) ?? '', owner), `${owner} runtime export surface`).toEqual([
        ...FROZEN_RUNTIME_EXPORTS[owner] ?? [],
      ].sort());
    }
  });

  it('S1 self-test (amendment p / INV-5b): import-edge extraction, the base capture and the planned edges', async () => {
    // Each row: the runtime import edges of an in-memory source as
    // `${resolved target stem} ! ${binding}` in source order (null targets —
    // bare packages / builtins — are printed as `null`).
    const edges = (rel: string, code: string): string[] =>
      moduleImportEdgesInSource(code, rel).map((e) => `${e.target} ! ${e.binding}`);
    const inv5EdgeRows: Array<[string, string, string, string[]]> = [
      ['a named import', 'backend/ingest/x.ts', "import { extractDocOutOfProcess } from './doc-worker.js';", ['backend/ingest/doc-worker ! extractDocOutOfProcess']],
      ['a renamed named import takes the SOURCE binding', 'backend/ingest/x.ts', "import { extractDocOutOfProcess as parse } from './doc-worker.js';", ['backend/ingest/doc-worker ! extractDocOutOfProcess']],
      ['a default import', 'backend/x.ts', "import runner from './ingest/doc-worker.js';", ['backend/ingest/doc-worker ! default']],
      ['a namespace import', 'backend/x.ts', "import * as runner from './ingest/doc-worker.js';", ['backend/ingest/doc-worker ! *']],
      ['a side-effect import', 'backend/x.ts', "import './ingest/doc-worker.js';", ['backend/ingest/doc-worker ! <side-effect>']],
      [
        'type-only imports are NOT edges',
        'backend/x.ts',
        "import type { DocWorkerChild } from './ingest/doc-worker.js';\nimport { type DocWorkerForkFn } from './ingest/doc-worker.js';",
        [],
      ],
      ['a re-export list takes SOURCE names', 'backend/ingest/wrap.ts', "export { extractXlsxOutOfProcess as parseXlsx } from './xlsx-worker.js';", ['backend/ingest/xlsx-worker ! extractXlsxOutOfProcess']],
      ['export * from an owner', 'backend/ingest/wrap.ts', "export * from './xlsx-worker.js';", ['backend/ingest/xlsx-worker ! *']],
      ['export * as ns from an owner (the whole namespace)', 'backend/ingest/wrap.ts', "export * as runner from './xlsx-worker.js';", ['backend/ingest/xlsx-worker ! *']],
      ['a type-only re-export is NOT an edge', 'backend/ingest/wrap.ts', "export type { XlsxWorkerForkFn } from './xlsx-worker.js';", []],
      ['dynamic import() hands out the namespace (*)', 'backend/ingest/extractors.ts', "const { extractDocOutOfProcess } = await import('./doc-worker.js');", ['backend/ingest/doc-worker ! *']],
      ['require (and every call form) hands out the namespace (*)', 'backend/x.ts', "const runner = require('./ingest/doc-worker.js');", ['backend/ingest/doc-worker ! *']],
      ['import-equals names its local binding', 'backend/x.ts', "import child = require('./ingest/doc-worker.js');", ['backend/ingest/doc-worker ! child']],
      ['bare packages and builtins resolve to null (not owner edges)', 'backend/x.ts', "import fs from 'node:fs'; import JSZip from 'jszip';", ['null ! default', 'null ! default']],
      ['the BASE extractors.ts dynamic xlsx edge', 'backend/ingest/extractors.ts', "const { extractXlsxOutOfProcess } = await import('./xlsx-worker.js');", ['backend/ingest/xlsx-worker ! *']],
      ['the PLANNED extractors.ts route edge', 'backend/ingest/extractors.ts', "import { extractDocOutOfProcess } from './doc-worker.js';", ['backend/ingest/doc-worker ! extractDocOutOfProcess']],
      ['the PLANNED index.ts registration edge', 'index.ts', "import { setDocWorkerForkFn, type DocWorkerChild } from './backend/ingest/doc-worker.js';", ['backend/ingest/doc-worker ! setDocWorkerForkFn']],
      ['the PLANNED backend host stop edge', 'backend/index.ts', "import { terminateDocWorkers } from './ingest/doc-worker.js';", ['backend/ingest/doc-worker ! terminateDocWorkers']],
      ['the PLANNED runner -> child prefix edge', 'backend/ingest/doc-worker.ts', "import { DOC_WORKER_ERROR_PREFIX } from './doc-worker-child.js';", ['backend/ingest/doc-worker-child ! DOC_WORKER_ERROR_PREFIX']],
    ];
    for (const [label, rel, code, expected] of inv5EdgeRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(edges(rel, code), label).toEqual(expected);
    }
  });

  it('S1 self-test (amendment q / INV-5c): every worker_threads load and new Worker( form is seen', async () => {
    // Each row: the INV-5c sites of an in-memory source as `${kind} ${form}`.
    const sites = (rel: string, code: string): string[] => inv5cSitesInSource(code, rel).map((s) => `${s.kind} ${s.form}`);
    const inv5cRows: Array<[string, string, string, string[]]> = [
      ['the base reranker shape (Worker import + construction)', 'backend/retrieval/reranker.ts', "import { Worker } from 'node:worker_threads';\nconst worker = new Worker(this.workerPath, { workerData: {} });", ['worker-threads-load import', 'worker-construction identifier']],
      ['the base rerank-worker shape (parentPort/workerData)', 'backend/retrieval/rerank-worker.ts', "import { parentPort, workerData } from 'node:worker_threads';", ['worker-threads-load import']],
      ['the bare specifier loads too', 'backend/x.ts', "import { Worker } from 'worker_threads';", ['worker-threads-load import']],
      ['dynamic import() of worker_threads', 'backend/x.ts', "const wt = await import('node:worker_threads');", ['worker-threads-load import()']],
      ['require of worker_threads', 'backend/x.ts', "const wt = require('node:worker_threads');", ['worker-threads-load require()']],
      ['a createRequire-alias load of worker_threads', 'backend/x.ts', "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); const wt = r('node:worker_threads');", ['worker-threads-load alias()']],
      ['a member require load', 'backend/x.ts', "const wt = module.require('node:worker_threads');", ['worker-threads-load member.require()']],
      ['a dot-callee new wt.Worker(', 'backend/x.ts', 'const w = new wt.Worker(file);', ['worker-construction dot']],
      ['an element-callee new wt["Worker"](', 'backend/x.ts', 'const w = new wt["Worker"](file);', ['worker-construction element']],
      ['a type-only import does not load', 'backend/x.ts', "import type { Worker } from 'node:worker_threads';", []],
      ['a case-variant specifier does not match (builtin specifiers are case-sensitive)', 'backend/x.ts', "import { Worker } from 'Node:Worker_Threads';", []],
      ['a look-alike module does not match', 'backend/x.ts', "import { Worker } from 'worker-threads-mock';", []],
      ['a longer name is not Worker', 'backend/x.ts', 'const w = new MyWorker(file); const pool = new WorkerPool(file);', []],
      ['comments do not count', 'backend/x.ts', '// new Worker(x) after require("node:worker_threads")\nconst a = 1;', []],
    ];
    for (const [label, rel, code, expected] of inv5cRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(sites(rel, code), label).toEqual(expected);
    }
  });

  it('S1 self-test (round-6 probes / INV-5): every cross-module capability alias turns the tree red', { timeout: 300_000 }, () => {
    // The plan critic's round-6 probes, VERBATIM in their capability shape: an
    // owner exports its capability under a NEW name and a consumer module uses
    // it. Before INV-5 every finding set was EMPTY for the consumer; each
    // probe is now caught by INV-5a (the owner's frozen surface gained a
    // name) and/or INV-5b (a NEW import edge into the owner) and INV-5c (the
    // in-process Worker launch).
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const withFiles = (entries: Array<[string, string]>): Map<string, string> => {
      const tree = new Map(baseTree);
      for (const [rel, text] of entries) tree.set(rel, text);
      return tree;
    };
    const xlsxRunnerText = fs.readFileSync(path.join(INGEST_DIR, 'xlsx-worker.ts'), 'utf8');
    const packExtractText = fs.readFileSync(path.join(MAIN_DIR, 'backend', 'packs', 'pack-extract.ts'), 'utf8');

    // Probe 1 — the resolver alias: `export const parserWorkerPath =
    // xlsxWorkerChildPath` in the runner; another module launches the REAL
    // child in-process through it.
    const RESOLVER_CONSUMER = [
      "import { Worker } from 'node:worker_threads';",
      "import { parserWorkerPath } from './xlsx-worker.js';",
      'export function launchWorkbook(workbook: string): unknown {',
      '  return new Worker(parserWorkerPath(), { argv: [workbook], stdout: true });',
      '}',
    ].join('\n');
    const tree1 = withFiles([
      ['backend/ingest/xlsx-worker.ts', `${xlsxRunnerText}\nexport const parserWorkerPath = xlsxWorkerChildPath;\n`],
      ['backend/ingest/parser-launcher.ts', RESOLVER_CONSUMER],
    ]);
    expect(inv5aFindingsOfTree(tree1), 'probe: resolver alias -> INV-5a export-added').toEqual([
      { kind: 'export-added', owner: XLSX_RUNNER_RELATIVE, name: 'parserWorkerPath' },
    ]);
    expect(inv5bFindingsOfTree(tree1), 'probe: resolver alias -> INV-5b edge-added').toEqual([
      { kind: 'edge-added', owner: XLSX_RUNNER_RELATIVE, file: 'backend/ingest/parser-launcher.ts', binding: 'parserWorkerPath' },
    ]);
    expect(inv5cFindingsOfTree(tree1).map((s) => `${s.kind} ${s.file}`), 'probe: resolver alias -> INV-5c in-process launch').toEqual([
      'worker-construction backend/ingest/parser-launcher.ts',
      'worker-threads-load backend/ingest/parser-launcher.ts',
    ]);
    expect(launchSurfaceInSource(RESOLVER_CONSUMER, 'backend/ingest/parser-launcher.ts').findings, 'the round-6 gap, pinned: INV-4 sees NOTHING in the consumer').toEqual([]);

    // Probe 2 — the setter alias: `export const registerParserLauncher =
    // setDocWorkerForkFn`; a consumer installs a launcher with it.
    const docRunnerText = fs.readFileSync(path.join(INGEST_DIR, 'doc-worker.ts'), 'utf8');
    const SETTER_CONSUMER = [
      "import { registerParserLauncher } from './doc-worker.js';",
      'export function installParserLauncher(): void { registerParserLauncher(launchInProcess); }',
    ].join('\n');
    const tree2 = withFiles([
      ['backend/ingest/doc-worker.ts', `${docRunnerText}\nexport const registerParserLauncher = setDocWorkerForkFn;\n`],
      ['backend/ingest/register-launcher.ts', SETTER_CONSUMER],
    ]);
    expect(inv5aFindingsOfTree(tree2), 'probe: setter alias -> INV-5a export-added').toEqual([
      { kind: 'export-added', owner: DOC_RUNNER_RELATIVE, name: 'registerParserLauncher' },
    ]);
    expect(inv5bFindingsOfTree(tree2), 'probe: setter alias -> INV-5b edge-added').toEqual([
      { kind: 'edge-added', owner: DOC_RUNNER_RELATIVE, file: 'backend/ingest/register-launcher.ts', binding: 'registerParserLauncher' },
    ]);

    // Probe 3 — the owner parser handle: `export const openZip =
    // JSZip.loadAsync.bind(JSZip)` added to pack-extract.ts (the owner was
    // jszip-sanctioned only BEFORE the AC_CHANGED_BY_USER 2026-11-09
    // amendment — the probe stays: an owner handing out a parser entry is an
    // INV-5a export-added whatever the sanctioned sets say); an ingest
    // consumer calls openZip(bytes). INV-3 cannot see the consumer (pinned
    // below).
    const OPENZIP_CONSUMER = [
      "import { openZip } from '../packs/pack-extract.js';",
      'export async function readZipText(bytes: Uint8Array): Promise<unknown> { return openZip(bytes); }',
    ].join('\n');
    const tree3 = withFiles([
      [PACK_EXTRACT_RELATIVE, `${packExtractText}\nexport const openZip = JSZip.loadAsync.bind(JSZip);\n`],
      ['backend/ingest/zip-via-owner.ts', OPENZIP_CONSUMER],
    ]);
    expect(inv5aFindingsOfTree(tree3), 'probe: openZip alias -> INV-5a export-added').toEqual([
      { kind: 'export-added', owner: PACK_EXTRACT_RELATIVE, name: 'openZip' },
    ]);
    expect(inv5bFindingsOfTree(tree3), 'probe: openZip alias -> INV-5b edge-added').toEqual([
      { kind: 'edge-added', owner: PACK_EXTRACT_RELATIVE, file: 'backend/ingest/zip-via-owner.ts', binding: 'openZip' },
    ]);
    expect(parserEntryReferencesInSource(OPENZIP_CONSUMER, 'backend/ingest/zip-via-owner.ts'), 'the round-6 gap, pinned: INV-3 sees NO parser-entry reference in the consumer').toEqual([]);

    // Probe 4 — the exported wrapper: the owner exports a NEW function that
    // internally performs the parse; the consumer names only the wrapper.
    const WRAPPER_CONSUMER = [
      "import { unzipEntry } from '../packs/pack-extract.js';",
      'export async function readEntry(bytes: Uint8Array): Promise<unknown> { return unzipEntry(bytes); }',
    ].join('\n');
    const tree4 = withFiles([
      [PACK_EXTRACT_RELATIVE, `${packExtractText}\nexport async function unzipEntry(data: Uint8Array): Promise<unknown> { return JSZip.loadAsync(data); }\n`],
      ['backend/ingest/unzip-via-owner.ts', WRAPPER_CONSUMER],
    ]);
    expect(inv5aFindingsOfTree(tree4), 'probe: exported wrapper -> INV-5a export-added').toEqual([
      { kind: 'export-added', owner: PACK_EXTRACT_RELATIVE, name: 'unzipEntry' },
    ]);
    expect(inv5bFindingsOfTree(tree4), 'probe: exported wrapper -> INV-5b edge-added').toEqual([
      { kind: 'edge-added', owner: PACK_EXTRACT_RELATIVE, file: 'backend/ingest/unzip-via-owner.ts', binding: 'unzipEntry' },
    ]);
  });

  it('S1 self-test (amendment r / SRC-1): vm loads, eval/Function references, dlopen, CJS internals and workerPath are all seen', async () => {
    // Each row: the SRC-1 sites of an in-memory source as `${kind} ${form}`
    // (sorted by the walk's own order). These are the SOURCES Revision 8
    // closes; every one was EMPTY at base 5d1f7338.
    const sites = (code: string): string[] => inProcessExecSitesInSource(code, 'selfcheck-probe.ts').map((s) => `${s.kind} ${s.form}`);
    const src1Rows: Array<[string, string, string[]]> = [
      ['a vm static import + runInThisContext', "import vm from 'node:vm';\nexport const run = (src: string): unknown => vm.runInThisContext(src);", ['vm-load import']],
      ['vm via dynamic import', "const vm = await import('vm');", ['vm-load import()']],
      ['vm via require', "const vm = require('node:vm');", ['vm-load require()']],
      ['a bare eval call', 'export const run = (src: string): unknown => eval(src);', ['eval-construction identifier']],
      ['globalThis.eval', 'export const run = (src: string): unknown => globalThis.eval(src);', ['eval-construction dot']],
      ["globalThis['eval']", "export const run = (src: string): unknown => globalThis['eval'](src);", ['eval-construction element']],
      ['new Function', 'export const run = (src: string): unknown => new Function(src)();', ['eval-construction identifier']],
      ['a bare Function call', 'export const run = (src: string): unknown => Function(`return ${src}`)();', ['eval-construction identifier']],
      ["window['Function']", "export const run = (src: string): unknown => (window as unknown as { Function(s: string): unknown })['Function'](src);", ['eval-construction element']],
      ['an eval ALIAS is still a runtime reference', 'const e = eval;\nexport const run = (src: string): unknown => e(src);', ['eval-construction identifier']],
      ['process.dlopen (dot)', 'export const load = (m: unknown, p: string): void => { process.dlopen(m as never, p); };', ['dlopen dot']],
      ["process['dlopen'] (element)", "export const load = (m: unknown, p: string): void => { process['dlopen'](m as never, p); };", ['dlopen element']],
      ['dlopen on a NON-process receiver is not the binding', 'const obj = { dlopen(): void { /* local */ } };\nexport const load = (): void => { obj.dlopen(); };', []],
      ['Module._load via a module-package default import', "import Module from 'node:module';\nexport const z = (spec: string): unknown => Module._load(spec, null);", ['module-internal dot _load']],
      ['a const alias of a module-package binding', "import * as M from 'node:module';\nconst M2 = M;\nexport const z = (spec: string): unknown => (M2 as unknown as { _resolveFilename(s: string): string })._resolveFilename(spec);", ['module-internal dot _resolveFilename']],
      ["Module.prototype and module['_extensions']", "import Module from 'node:module';\nexport const p = (Module as unknown as { prototype: object }).prototype;\nexport const e = (module as unknown as Record<string, object>)['_extensions'];", ['module-internal dot prototype', 'module-internal element _extensions']],
      ['wrap on the ambient module identifier', "export const w = (s: string): string => (module as unknown as { wrap(s: string): string }).wrap(s);", ['module-internal dot wrap']],
      ['a SHADOWED local module is not the CJS module', 'export const z = (module: { _load(s: string): void }): void => { module._load("x"); };', []],
      ['a CJS-internal name on an unrelated receiver is not a Module access', 'const local = { wrap(s: string): string { return s; } };\nexport const w = (s: string): string => local.wrap(s);', []],
      ['workerPath as an object key (the WorkerReranker option)', 'export const make = (childPath: string): { workerPath: string } => ({ workerPath: childPath });', ['worker-path key']],
      ['workerPath destructuring / element access / shorthand', "const opts: Record<string, string> = {};\nconst { workerPath } = opts;\nconst p2 = opts['workerPath'];\nexport const o = { workerPath };", ['worker-path binding', 'worker-path element', 'worker-path key']],
      ['workerPath in a TYPE position does not count', 'export interface Opts { workerPath?: string; }', []],
      ['the string "eval" is not a reference', "export const s = 'eval';", []],
      ['Function in a TYPE position does not count', 'export const f = (cb: (x: number) => number): number => cb(1);', []],
    ];
    for (const [label, code, expected] of src1Rows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(sites(code), label).toEqual(expected);
    }
  });

  it('S1 self-test (round-7 probes / SRC-1 + SRC-2 + the reranker owner addition): every local re-export and Worker-capability export turns the tree red', { timeout: 300_000 }, () => {
    // The plan critic's round-7 probes, VERBATIM in their capability shape,
    // plus the SRC-1 probes Revision 8 adds. Before the round-7 amendment
    // every finding set below was EMPTY for the first four probes (the
    // critic's repro/critic-round7-probes.out lines 1-4); each is now caught
    // by SRC-2 (local re-exports by permitted consumers), by the SRC-1 owner
    // addition (Worker exports from the reranker pair: INV-5a/5b) or by the
    // SRC-1 workerPath confinement.
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const withFiles = (entries: Array<[string, string]>): Map<string, string> => {
      const tree = new Map(baseTree);
      for (const [rel, text] of entries) tree.set(rel, text);
      return tree;
    };
    const surfaceText = fs.readFileSync(path.join(MAIN_DIR, 'backend', 'packs', 'surface.ts'), 'utf8');
    const indexText = fs.readFileSync(MAIN_INDEX_SOURCE, 'utf8');
    const rerankerText = fs.readFileSync(path.join(MAIN_DIR, 'backend', 'retrieval', 'reranker.ts'), 'utf8');
    const backendIndexText = fs.readFileSync(path.join(MAIN_DIR, 'backend', 'index.ts'), 'utf8');

    // Probe 1 — the critic's local renamed parser re-export through an
    // existing permitted importer: surface.ts re-exports the zip-install
    // binding it already holds; a consumer imports the renamed alias.
    const SURFACE_ALIAS = `${surfaceText}\nexport { extractPackZip as openPack };\n`;
    const PACK_CONSUMER = "import { openPack } from '../packs/surface.js';\nexport async function readPack(bytes: Uint8Array, filename: string): Promise<unknown> { return openPack(bytes, filename); }";
    const tree1 = withFiles([
      ['backend/packs/surface.ts', SURFACE_ALIAS],
      ['backend/ingest/open-pack-via-surface.ts', PACK_CONSUMER],
    ]);
    expect(src2FindingsOfTree(tree1), 'probe: surface.ts local renamed parser re-export -> SRC-2 re-export-alias').toEqual([
      { kind: 're-export-alias', file: 'backend/packs/surface.ts', owner: 'backend/packs/zip-install.ts', name: 'openPack', fragment: 'extractPackZip as openPack' },
    ]);
    expect(inv5aFindingsOfTree(tree1), 'the round-7 gap, pinned: INV-5a sees NOTHING (surface.ts is not an owner)').toEqual([]);
    expect(inv5bFindingsOfTree(tree1), 'the round-7 gap, pinned: INV-5b sees NO new owner edge (the zip-install edge is unchanged)').toEqual([]);
    expect(parserEntryReferencesInSource(PACK_CONSUMER, 'backend/ingest/open-pack-via-surface.ts'), 'the round-7 gap, pinned: the consumer names NO parser entry').toEqual([]);

    // Probe 2 — the critic's local renamed setter re-export through the
    // permitted bootstrap: index.ts re-exports the xlsx setter it imports.
    const INDEX_ALIAS = `${indexText}\nexport { setXlsxWorkerForkFn as registerWorkbookLauncher };\n`;
    const SETTER_CONSUMER = "import { registerWorkbookLauncher } from '../../index.js';\nexport function install(launch: unknown): void { registerWorkbookLauncher(launch as never); }";
    const tree2 = withFiles([
      ['index.ts', INDEX_ALIAS],
      ['backend/ingest/register-via-index.ts', SETTER_CONSUMER],
    ]);
    expect(src2FindingsOfTree(tree2), 'probe: index.ts local renamed setter re-export -> SRC-2 re-export-alias').toEqual([
      { kind: 're-export-alias', file: 'index.ts', owner: XLSX_RUNNER_RELATIVE, name: 'registerWorkbookLauncher', fragment: 'setXlsxWorkerForkFn as registerWorkbookLauncher' },
    ]);
    expect(inv5aFindingsOfTree(tree2), 'the round-7 gap, pinned: INV-5a sees NOTHING (index.ts is not an owner)').toEqual([]);
    expect(inv5bFindingsOfTree(tree2), 'the round-7 gap, pinned: INV-5b sees NO new owner edge (the index.ts setter edge is unchanged)').toEqual([]);

    // Probe 3 — the critic's renamed Worker constructor exported by an
    // INV-5c-allowed file: reranker.ts exports Worker; a consumer constructs
    // it under the new name. The SRC-1 owner addition catches it: INV-5a
    // (reranker's surface is frozen) + INV-5b (a NEW consumer edge).
    const RERANKER_ALIAS = `${rerankerText}\nexport { Worker };\n`;
    const WORKER_CONSUMER = "import { Worker as ParserWorker } from '../retrieval/reranker.js';\nexport function launch(modulePath: string, args: string[]): unknown { return new ParserWorker(modulePath, { argv: args, stdout: true }); }";
    const tree3 = withFiles([
      ['backend/retrieval/reranker.ts', RERANKER_ALIAS],
      ['backend/ingest/worker-via-reranker.ts', WORKER_CONSUMER],
    ]);
    expect(inv5aFindingsOfTree(tree3), 'probe: Worker export from the reranker -> INV-5a export-added (SRC-1 owner addition)').toEqual([
      { kind: 'export-added', owner: 'backend/retrieval/reranker.ts', name: 'Worker' },
    ]);
    expect(inv5bFindingsOfTree(tree3), 'probe: the renamed-Worker consumer -> INV-5b edge-added').toEqual([
      { kind: 'edge-added', owner: 'backend/retrieval/reranker.ts', file: 'backend/ingest/worker-via-reranker.ts', binding: 'Worker' },
    ]);
    expect(inv5cFindingsOfTree(tree3), 'the round-7 gap, pinned: INV-5c itself still does not know the name ParserWorker (the owner addition is what closes it)').toEqual([]);

    // Probe 4 — the critic's combined renamed-setter + renamed-Worker route:
    // the composition that launched the REAL xlsx child in-process. Both
    // halves are caught: SRC-2 for the setter, INV-5a/5b for the Worker.
    const ADAPTER_CONSUMER = [
      "import { registerWorkbookLauncher } from '../../index.js';",
      "import { Worker as ParserWorker } from '../retrieval/reranker.js';",
      'export function installParserLauncher(): void {',
      '  registerWorkbookLauncher((modulePath: string, args: string[]) => {',
      '    const worker = new ParserWorker(modulePath, { argv: args, stdout: true });',
      '    return {',
      '      pid: process.pid,',
      '      stderr: null,',
      '      on(event: any, cb: any) { worker.on(event, cb); },',
      '      kill() { void worker.terminate(); },',
      '    };',
      '  });',
      '}',
    ].join('\n');
    const tree4 = withFiles([
      ['index.ts', INDEX_ALIAS],
      ['backend/retrieval/reranker.ts', RERANKER_ALIAS],
      ['backend/ingest/install-in-main.ts', ADAPTER_CONSUMER],
    ]);
    expect(src2FindingsOfTree(tree4), 'probe: combined route -> SRC-2 catches the setter half').toEqual([
      { kind: 're-export-alias', file: 'index.ts', owner: XLSX_RUNNER_RELATIVE, name: 'registerWorkbookLauncher', fragment: 'setXlsxWorkerForkFn as registerWorkbookLauncher' },
    ]);
    expect(inv5aFindingsOfTree(tree4), 'probe: combined route -> INV-5a catches the Worker half').toEqual([
      { kind: 'export-added', owner: 'backend/retrieval/reranker.ts', name: 'Worker' },
    ]);
    expect(inv5bFindingsOfTree(tree4), 'probe: combined route -> INV-5b catches the Worker consumer').toEqual([
      { kind: 'edge-added', owner: 'backend/retrieval/reranker.ts', file: 'backend/ingest/install-in-main.ts', binding: 'Worker' },
    ]);

    // Probe 5 — a WorkerReranker pointed at ANOTHER script from a module
    // that is NOT reranker.ts: only the workerPath key reference confines it.
    // (Inside backend/index.ts — an already-frozen reranker consumer — so the
    // demonstration is not confounded by the INV-5b new-edge flag.)
    const tree5 = withFiles([
      ['backend/index.ts', `${backendIndexText}\nexport function pointRerankerAt(childPath: string): WorkerReranker { return new WorkerReranker({ workerPath: childPath }); }\n`],
    ]);
    expect(src1FindingsOfTree(tree5).map((s) => `${s.kind} ${s.form}`), 'probe: new WorkerReranker({ workerPath }) from another module -> SRC-1 worker-path confinement').toEqual(['worker-path key']);
    expect(inv5bFindingsOfTree(tree5), 'the frozen consumer set is unchanged (no new edge — only SRC-1 speaks)').toEqual([]);

    // Probe 6 — the same construction in a BRAND-NEW module (the critic's
    // threat shape): SRC-1 flags the key AND INV-5b the new consumer edge.
    const POINT_CONSUMER = "import { WorkerReranker } from '../retrieval/reranker.js';\nexport function make(childPath: string): WorkerReranker { return new WorkerReranker({ workerPath: childPath }); }";
    const tree6 = withFiles([['backend/ingest/point-reranker.ts', POINT_CONSUMER]]);
    expect(src1FindingsOfTree(tree6).map((s) => `${s.kind} ${s.form}`), 'probe: the new-module workerPath consumer is SRC-1 red').toEqual(['worker-path key']);
    expect(inv5bFindingsOfTree(tree6), 'probe: the new-module workerPath consumer is also an INV-5b new edge (fail-closed overlap)').toEqual([
      { kind: 'edge-added', owner: 'backend/retrieval/reranker.ts', file: 'backend/ingest/point-reranker.ts', binding: 'WorkerReranker' },
    ]);
  });

  it('S1 self-test (amendment t / SRC-3): the built-in classification covers EXACTLY the running builtinModules, once each', async () => {
    // The termination mechanism of Revision 9: completeness is enforced
    // against the runtime's OWN list, not by review discovery. Under vitest
    // (Node) the Node table must equal builtinModules; under Electron the Node
    // table plus the Electron-only table must.
    const nodeKeys = Object.keys(BUILTIN_MODULE_CLASSIFICATION);
    const electronKeys = Object.keys(ELECTRON_ONLY_BUILTIN_CLASSIFICATION);
    const underElectron = typeof process.versions.electron === 'string';
    const expectedKeys = underElectron ? [...nodeKeys, ...electronKeys] : nodeKeys;
    expect([...expectedKeys].sort(), 'classification keys === builtinModules (a new built-in must be classified)').toEqual([...builtinModules].sort());
    expect(new Set([...nodeKeys, ...electronKeys]).size, 'no key is classified twice').toBe(nodeKeys.length + electronKeys.length);
    for (const [id, entry] of [...Object.entries(BUILTIN_MODULE_CLASSIFICATION), ...Object.entries(ELECTRON_ONLY_BUILTIN_CLASSIFICATION)]) {
      expect(['IN-PROCESS-EXEC', 'OUT-OF-PROCESS', 'INERT'], `${id} class`).toContain(entry.cls);
      expect(entry.reason, `${id} carries a one-line reason`).toMatch(/^\S[^\n]*$/);
    }
    // The frozen classification outcome (any re-classification is a deliberate frozen-list edit).
    const byClass = (cls: BuiltinClass): string[] =>
      Object.entries({ ...BUILTIN_MODULE_CLASSIFICATION, ...ELECTRON_ONLY_BUILTIN_CLASSIFICATION })
        .filter(([, e]) => e.cls === cls)
        .map(([id]) => id)
        .sort();
    expect(byClass('IN-PROCESS-EXEC')).toEqual(
      ['inspector', 'inspector/promises', 'module', 'node:sqlite', 'node:test', 'process', 'repl', 'v8', 'vm', 'wasi', 'worker_threads'].sort(),
    );
    expect(byClass('OUT-OF-PROCESS')).toEqual(['child_process', 'cluster']);
    // Specifier normalisation: 'node:'-prefixed and unprefixed forms; the
    // 'node:'-only built-ins never match their unprefixed userland namesakes.
    const builtinRows: Array<[string, string | null]> = [
      ['vm', 'vm'],
      ['node:vm', 'vm'],
      ['fs/promises', 'fs/promises'],
      ['node:fs/promises', 'fs/promises'],
      ['node:inspector/promises', 'inspector/promises'],
      ['node:sqlite', 'node:sqlite'],
      ['sqlite', null],
      ['node:test', 'node:test'],
      ['test', null],
      ['node:test/reporters', 'node:test/reporters'],
      ['node:sea', 'node:sea'],
      ['process', 'process'],
      ['node:process', 'process'],
      ['original-fs', 'original-fs'],
      ['Node:VM', null],
      ['VM', null],
      ['vm2', null],
      ['jszip', null],
      ['node:node:vm', null],
    ];
    for (const [specifier, expected] of builtinRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(canonicalBuiltinId(specifier), `canonicalBuiltinId(${JSON.stringify(specifier)})`).toBe(expected);
    }
  });

  it('S1 self-test (amendment t / SRC-3): every IN-PROCESS-EXEC built-in route, data: URL load and global evaluator is seen; inert built-ins are not', async () => {
    // Each row: the SRC-3 sites of an in-memory source as `${kind} ${source} ${form}`.
    // The first four rows are the plan critic's round-8 probes VERBATIM
    // (repro/critic-round8-probes.mjs) — each had ZERO findings in every layer.
    const sites = (code: string): string[] => src3SitesInSource(code, 'selfcheck-probe.ts').map((s) => `${s.kind} ${s.source} ${s.form}`);
    const src3Rows: Array<[string, string, string[]]> = [
      ['round-8 probe (verbatim): Worker obtained through process.getBuiltinModule and renamed', "const ParserThread = process.getBuiltinModule('node:worker_threads').Worker;\nexport function launch(modulePath: string, args: string[]) {\n  return new ParserThread(modulePath, { argv: args, stdout: true });\n}", ['builtin-get worker_threads dot']],
      ['round-8 probe (verbatim): process.getBuiltinModule vm', "const vm = process.getBuiltinModule('node:vm');\nexport function evaluateInMain(expression: string): unknown {\n  return vm.runInThisContext(expression);\n}", ['builtin-get vm dot']],
      ['round-8 probe (verbatim): inspector Session Runtime.evaluate', "import { Session } from 'node:inspector/promises';\nexport async function evaluateInMain(expression: string): Promise<unknown> {\n  const session = new Session();\n  session.connect();\n  try {\n    return await session.post('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });\n  } finally {\n    session.disconnect();\n  }\n}", ['builtin-load inspector/promises import']],
      ['round-8 probe (verbatim): the permitted-bootstrap wrapper body', "setXlsxWorkerForkFn((modulePath: string, args: string[]) => {\n  const ParserThread = process.getBuiltinModule('node:worker_threads').Worker;\n  const worker = new ParserThread(modulePath, { argv: args, stdout: true });\n  return { pid: process.pid, stderr: null, on(event: any, cb: any) { worker.on(event, cb); }, kill() { void worker.terminate(); } };\n});", ['builtin-get worker_threads dot']],
      ['dynamic import of node:inspector', "const { Session } = await import('node:inspector');", ['builtin-load inspector import()']],
      ['require of repl', "const repl = require('repl');", ['builtin-load repl require()']],
      ['static import of wasi', "import { WASI } from 'node:wasi';", ['builtin-load wasi import']],
      ["new (await import('node:test')).run in-process isolation", "export const go = async (files: string[]): Promise<unknown> => new (await import('node:test')).run({ files, isolation: 'none' });", ['builtin-load node:test import()']],
      ['node:sqlite DatabaseSync (its loadExtension is SRC-5 too)', "import { DatabaseSync } from 'node:sqlite';\nconst db = new DatabaseSync(':memory:', { allowExtension: true });\ndb.loadExtension(extPath);", ['builtin-load node:sqlite import']],
      ['v8 flag mutation (conservative)', "import v8 from 'node:v8';\nv8.setFlagsFromString('--allow-natives-syntax');", ['builtin-load v8 import']],
      ['the node:process module (the process object)', "import process from 'node:process';", ['builtin-load process import']],
      ['a named node:process getBuiltinModule import + bare call', "import { getBuiltinModule } from 'node:process';\nexport const vm = getBuiltinModule('vm');", ['builtin-load process import', 'builtin-get vm identifier']],
      ['a named createRequire import is SEEN (permission is decided per tree)', "import { createRequire } from 'node:module';", ['builtin-load module import']],
      ['a default module-package import', "import Module from 'node:module';", ['builtin-load module import']],
      ['require of module', "const m = require('module');", ['builtin-load module require()']],
      ['the bare worker_threads specifier', "import { Worker } from 'worker_threads';", ['builtin-load worker_threads import']],
      ['a COMPUTED getBuiltinModule argument (fail closed)', 'const m = process.getBuiltinModule(name);', ['builtin-get <COMPUTED> dot']],
      ['a data: URL dynamic import evaluates its source', "export const one = await import('data:text/javascript,export default process.pid');", ['data-url-load data: import()']],
      ['a data: URL static import, scheme case-insensitive', "import 'DATA:text/javascript,globalThis.x = 1';", ['data-url-load data: import']],
      ['the WebAssembly global', 'export const run = async (bytes: Uint8Array): Promise<unknown> => WebAssembly.instantiate(bytes);', ['global-evaluator WebAssembly identifier']],
      ['globalThis.WebAssembly', 'export const W = globalThis.WebAssembly;', ['global-evaluator WebAssembly dot']],
      ['a function constructor IS Function', "const F = (() => {}).constructor;\nexport const run = (src: string): unknown => F(src)();", ['global-evaluator constructor dot']],
      ['the AsyncFunction constructor', "const AF = Object.getPrototypeOf(async () => {}).constructor;\nexport const run = (src: string): unknown => new AF(src)();", ['global-evaluator constructor dot']],
      ["a literal-element ['constructor']", "export const F = (() => {})['constructor'];", ['global-evaluator constructor element']],
      ['a destructured constructor key', 'const { constructor: F } = () => {};', ['global-evaluator constructor binding']],
      ["a reflective 'constructor' key", "export const F = Reflect.get(() => {}, 'constructor');", ['global-evaluator constructor string']],
      ['NEGATIVE: unprefixed sqlite is a userland package', "import sqlite from 'sqlite';", []],
      ['NEGATIVE: unprefixed test is a userland package', "import test from 'test';", []],
      ['NEGATIVE: ordinary inert built-ins (fs, path, crypto, zlib)', "import fs from 'node:fs';\nimport path from 'node:path';\nimport crypto from 'node:crypto';\nimport { createHash } from 'crypto';\nconst z = require('node:zlib');", []],
      ['NEGATIVE: out-of-process built-ins', "import { fork } from 'node:child_process';\nimport cluster from 'cluster';", []],
      ['NEGATIVE: node:test/reporters is inert', "import { spec as specReporter } from 'node:test/reporters';", []],
      ['NEGATIVE: getBuiltinModule of an inert built-in (SRC-4 still flags the access)', "const fs = process.getBuiltinModule('fs');", []],
      ['NEGATIVE: WebAssembly in a TYPE position', 'export function f(m: WebAssembly.Module): void { void m; }', []],
      ['NEGATIVE: reading constructor.name', 'export const n = (e: Error): string => e.constructor.name;', []],
      ['NEGATIVE: comparing constructors', 'export const same = (a: object, b: object): boolean => a.constructor === b.constructor;', []],
      ['NEGATIVE: a class constructor declaration', 'export class A { constructor(readonly x: number) {} }', []],
      ['NEGATIVE: comments do not count', "// process.getBuiltinModule('vm') import('node:inspector') WebAssembly .constructor\nconst a = 1;", []],
    ];
    for (const [label, code, expected] of src3Rows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(sites(code), label).toEqual(expected);
    }
    // Permission is per tree: worker_threads only in the reranker pair, the
    // module package only through the recognised named createRequire import.
    const permissionOf = (rel: string, code: string): boolean[] => src3SitesInSource(code, rel).map(src3SiteIsPermitted);
    const src3PermissionRows: Array<[string, string, string, boolean[]]> = [
      ['worker_threads inside reranker.ts', 'backend/retrieval/reranker.ts', "import { Worker } from 'node:worker_threads';", [true]],
      ['worker_threads inside rerank-worker.ts', 'backend/retrieval/rerank-worker.ts', "import { parentPort } from 'node:worker_threads';", [true]],
      ['worker_threads anywhere else', 'backend/ingest/x.ts', "import { Worker } from 'node:worker_threads';", [false]],
      ['getBuiltinModule worker_threads even inside reranker.ts', 'backend/retrieval/reranker.ts', "const W = process.getBuiltinModule('node:worker_threads').Worker;", [false]],
      ['a named createRequire import', 'backend/x.ts', "import { createRequire } from 'node:module';", [true]],
      ['a RENAMED named createRequire import', 'backend/x.ts', "import { createRequire as cr } from 'node:module';", [true]],
      ['createRequire plus another named binding', 'backend/x.ts', "import { createRequire, Module } from 'node:module';", [false]],
      ['a default module import', 'backend/x.ts', "import Module from 'module';", [false]],
      ['a namespace module import', 'backend/x.ts', "import * as M from 'node:module';", [false]],
      ['require of module', 'backend/x.ts', "const M = require('node:module');", [false]],
      ['every other IN-PROCESS-EXEC built-in, anywhere', 'backend/retrieval/reranker.ts', "import vm from 'node:vm';", [false]],
    ];
    for (const [label, rel, code, expected] of src3PermissionRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(permissionOf(rel, code), label).toEqual(expected);
    }
  });

  it('S1 self-test (amendment t / SRC-4): every built-in access API reference is an unrecognised loader use', async () => {
    const forms = (code: string): string[] => loaderUsesInSource(code, 'selfcheck-probe.ts').map((u) => u.form);
    const src4Rows: Array<[string, string, string[]]> = [
      ['process.getBuiltinModule direct', "process.getBuiltinModule('node:worker_threads');", ['builtin-access']],
      ['an alias: const gbm = process.getBuiltinModule', 'const gbm = process.getBuiltinModule;', ['builtin-access']],
      ['destructured from process', 'const { getBuiltinModule } = process;', ['builtin-access']],
      ['through globalThis.process', "globalThis.process.getBuiltinModule('vm');", ['builtin-access']],
      ['a literal-element member', "process['getBuiltinModule']('vm');", ['builtin-access']],
      ['an optional call', "process?.getBuiltinModule?.('vm');", ['builtin-access']],
      ['a named import from node:process', "import { getBuiltinModule } from 'node:process';", ['builtin-access']],
      ["process.binding('fs')", "process.binding('fs');", ['builtin-access']],
      ['process._linkedBinding', "process._linkedBinding('electron_common_v8_util');", ['builtin-access']],
      ['a bare internalBinding', "internalBinding('fs');", ['builtin-access']],
      ['process.execve (same-PID image replacement)', "process.execve('/bin/sh', ['sh']);", ['builtin-access']],
      ['process._debugProcess (inspector activation)', 'process._debugProcess(process.pid);', ['builtin-access']],
      ['process._debugEnd', 'process._debugEnd();', ['builtin-access']],
      ['NEGATIVE: ordinary process members', 'const a = process.pid + process.platform + String(process.env.X);', []],
      ['NEGATIVE: the name inside a string', "console.log('getBuiltinModule is not used');", []],
      ['NEGATIVE: a TYPE position', 'type G = typeof process.getBuiltinModule;', []],
    ];
    for (const [label, code, expected] of src4Rows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(forms(code), label).toEqual(expected);
    }
  });

  it('S1 self-test (amendment t / SRC-5): native-extension load members are seen in every runtime form', async () => {
    const sites = (code: string): string[] => src5SitesInSource(code, 'selfcheck-probe.ts').map((s) => `${s.form} ${s.name}`);
    const src5Rows: Array<[string, string, string[]]> = [
      ['better-sqlite3 / node:sqlite db.loadExtension', 'db.loadExtension(p);', ['dot loadExtension']],
      ['Electron session.loadExtension (conservative)', 'session.defaultSession.loadExtension(dir);', ['dot loadExtension']],
      ['crypto.setEngine', "crypto.setEngine('/x/engine.so');", ['dot setEngine']],
      ['the TLS privateKeyEngine option', "tls.createSecureContext({ privateKeyEngine: 'e', privateKeyIdentifier: 'k' });", ['key privateKeyEngine']],
      ['the TLS clientCertEngine option', "https.request({ clientCertEngine: 'e' });", ['key clientCertEngine']],
      ['a destructured loadExtension', 'const { loadExtension } = db;', ['binding loadExtension']],
      ['NEGATIVE: an interface method signature (the base type positions)', 'interface D { loadExtension(path: string): void; }', []],
      ['NEGATIVE: a type-literal member', 'type D = { loadExtension(path: string): void };', []],
      ['NEGATIVE: the name inside a string', "console.log('loadExtension');", []],
    ];
    for (const [label, code, expected] of src5Rows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(sites(code), label).toEqual(expected);
    }
  });

  it('S1 self-test (amendment u / SRC-6): package normalisation, the frozen table shape, and every new-package route', async () => {
    // Normalisation rows: the specifier spellings the load inventory can
    // produce (cooked literals, subpaths, scopes, node_modules paths, drives).
    const src6NormRows: Array<[string, string | null]> = [
      ['jszip', 'jszip'],
      ['jszip/', 'jszip'],
      ['JSZip', 'jszip'],
      ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist'],
      ['ajv/dist/2020', 'ajv'],
      ['@huggingface/transformers', '@huggingface/transformers'],
      ['@HuggingFace/Transformers/base.js', '@huggingface/transformers'],
      ['@scope/pkg/sub/deep.js', '@scope/pkg'],
      ['node_modules/jszip', 'jszip'],
      ['../node_modules/jszip/lib/index.js', 'jszip'],
      ['..\\node_modules\\@scope\\pkg\\sub', '@scope/pkg'],
      ['./x', null],
      ['../x', null],
      ['/abs/x', null],
      ['E:/abs/x', null],
      ['E:\\abs\\x', null],
      ['file:///C:/x', null],
      ['data:text/javascript,x', null],
      // AMENDED (round 9, SRC-8): '#' aliases are no longer discarded — they
      // surface by alias name (and the SRC-8 leg bans every such load site).
      ['#internal', '#internal'],
      ['#workbook', '#workbook'],
      ['#Workbook/sub/deep.js', '#workbook'],
      ['#new-parser', '#new-parser'],
      ['#@scope/pkg/sub', '#@scope/pkg'],
      ['#', null],
      ['node:fs', null],
      ['fs', null],
      ['node:vm', null],
      ['assert/strict', null],
      ['node:not-a-real-builtin', null],
      ['@scope', null],
      ['', null],
      [COMPUTED, null],
    ];
    for (const [specifier, expected] of src6NormRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(packageNameOf(specifier), `packageNameOf(${JSON.stringify(specifier)})`).toBe(expected);
    }
    // Table shape: the PARSER set is exactly the plan's four, and each entry's
    // allowedFiles EQUALS the set the existing legs assign (no second source
    // of truth; xlsx reuses the frozen #289 T1 assignment).
    const table = THIRD_PARTY_PACKAGE_CLASSIFICATION;
    const allowedOf = (n: string): readonly string[] => table[n]?.allowedFiles ?? [];
    expect(
      Object.entries(table).filter(([, e]) => e.cls === 'PARSER').map(([n]) => n).sort(),
      'PARSER === the plan-expected four (any other PARSER classification is reported to the plan critic)',
    ).toEqual(['jszip', 'mammoth', 'pdfjs-dist', 'xlsx']);
    expect([...allowedOf('jszip')].sort(), 'jszip allowed set === the S1 jszip leg sanctioned set (the three parse children — AC_CHANGED_BY_USER 2026-11-09)').toEqual(
      [DOC_CHILD_RELATIVE, XLSX_CHILD_RELATIVE, PACK_CHILD_RELATIVE].sort(),
    );
    expect([...allowedOf('mammoth')], 'mammoth allowed set === the S1 mammoth leg set').toEqual([DOC_CHILD_RELATIVE]);
    expect([...allowedOf('pdfjs-dist')], 'pdfjs-dist allowed set === the S1 pdfjs-dist leg set').toEqual([DOC_CHILD_RELATIVE]);
    expect([...allowedOf('xlsx')], 'xlsx allowed set === the #289 T1 assignment (the xlsx child only)').toEqual([XLSX_CHILD_RELATIVE]);
    for (const [name, entry] of Object.entries(table)) {
      expect(entry.reason, `${name} carries a one-line reason`).toMatch(/^\S[^\n]*$/);
      if (entry.cls === 'NON-PARSER') expect(entry.allowedFiles, `${name} is NON-PARSER and carries no allowed set`).toBeUndefined();
    }
    // Tree probes: every new-package load form turns the tree red; classified
    // NON-PARSER loads in new files do not. (Findings are compared as the ADDS
    // over the unmodified tree, so the rows hold at base AND at the fixed
    // tree: at base the tree itself carries the FOUR PARSER-OUTSIDE-ALLOWED
    // findings the fixes remove — the three extractors.ts parser loads and,
    // since the AC_CHANGED_BY_USER 2026-11-09 amendment, the pack-extract.ts
    // jszip load the pack migration removes.)
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const baseFindingKeys = new Set(src6FindingsOfTree(baseTree).map((f) => `${f.kind}\u0000${f.name}\u0000${f.file ?? ''}`));
    const addedFindings = (code: string): Src6Finding[] =>
      src6FindingsOfTree(new Map(baseTree).set('backend/ingest/src6-probe.ts', code)).filter(
        (f) => !baseFindingKeys.has(`${f.kind}\u0000${f.name}\u0000${f.file ?? ''}`),
      );
    const src6ProbeRows: Array<[string, string, Src6Finding[]]> = [
      ['a new parser package, static import', "import AdmZip from 'adm-zip';\nexport const open = (p: string): unknown => AdmZip(p);", [{ kind: 'UNCLASSIFIED', name: 'adm-zip' }]],
      ['a new parser package, require', "const yauzl = require('yauzl');\nexport const entries = yauzl;", [{ kind: 'UNCLASSIFIED', name: 'yauzl' }]],
      ['a new parser package, dynamic import', "export const unzip = async (): Promise<unknown> => import('unzipper');", [{ kind: 'UNCLASSIFIED', name: 'unzipper' }]],
      ['a new SCOPED parser package', "import { parseDoc } from '@acme/doc-parser';\nexport const p = parseDoc;", [{ kind: 'UNCLASSIFIED', name: '@acme/doc-parser' }]],
      [
        'a subpath of a PARSER in a NEW file (classified, but not allowed there)',
        "import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';\nexport const d = getDocument;",
        [{ kind: 'PARSER-OUTSIDE-ALLOWED', name: 'pdfjs-dist', file: 'backend/ingest/src6-probe.ts' }],
      ],
      ['NEGATIVE: a classified NON-PARSER import in a new file is ALLOWED', "import Ajv2020 from 'ajv/dist/2020';\nexport const Ajv = Ajv2020;", []],
      ['NEGATIVE: a NON-PARSER subpath normalises to the classified name', "import { env } from '@huggingface/transformers/base.js';\nvoid env;", []],
      ['NEGATIVE: builtin and node:-prefixed loads add no package', "import fs from 'node:fs';\nimport { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);\nexport const x = r('node:path');", []],
    ];
    for (const [label, code, expected] of src6ProbeRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      expect(addedFindings(code), label).toEqual(expected);
    }
    // The REMOVED direction: a tree loading NONE of the table's packages
    // fails with one REMOVED finding per entry — the table is pruned
    // deliberately, never silently.
    const loneTree = new Map([['backend/ingest/lone.ts', "import path from 'node:path';\nexport const p = path;"]]);
    expect(src6FindingsOfTree(loneTree).map((f) => `${f.kind} ${f.name}`), 'anti-vacuity: the table is non-empty and every entry is load-checked').toEqual(
      Object.keys(THIRD_PARTY_PACKAGE_CLASSIFICATION)
        .sort()
        .map((name) => `REMOVED ${name}`),
    );
  });

  it('S1 self-test (round-8 probes / SRC-3 + SRC-4): the getBuiltinModule and inspector routes turn the tree red', { timeout: 300_000 }, async () => {
    // The plan critic's round-8 probes VERBATIM (repro/critic-round8-probes.mjs
    // ownProbe rows): before amendment (t) every finding set was EMPTY
    // (critic-round8-probes.out lines 6-9). Each now trips SRC-3 and, where it
    // names getBuiltinModule, SRC-4 (loader walk `builtin-access`).
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const withFiles = (entries: Array<[string, string]>): Map<string, string> => {
      const tree = new Map(baseTree);
      for (const [rel, text] of entries) tree.set(rel, text);
      return tree;
    };
    const walkOf = (tree: ReadonlyMap<string, string>): string[] =>
      [...tree].flatMap(([rel, source]) => loaderUsesInSource(source, rel)).map((u) => `${u.file} ${u.form} ${u.fragment}`);
    const src3Of = (tree: ReadonlyMap<string, string>): string[] => src3FindingsOfTree(tree).map((s) => `${s.file} ${s.kind} ${s.source}`);
    const indexText = fs.readFileSync(MAIN_INDEX_SOURCE, 'utf8');

    // Probe 1 — Worker obtained through process.getBuiltinModule and renamed.
    const BUILTIN_WORKER = [
      "const ParserThread = process.getBuiltinModule('node:worker_threads').Worker;",
      'export function launch(modulePath: string, args: string[]) {',
      '  return new ParserThread(modulePath, { argv: args, stdout: true });',
      '}',
    ].join('\n');
    const tree1 = withFiles([['backend/ingest/builtin-worker.ts', BUILTIN_WORKER]]);
    expect(walkOf(tree1), 'probe 1 -> SRC-4 builtin-access').toEqual(['backend/ingest/builtin-worker.ts builtin-access process.getBuiltinModule']);
    expect(src3Of(tree1), 'probe 1 -> SRC-3 builtin-get worker_threads').toEqual(['backend/ingest/builtin-worker.ts builtin-get worker_threads']);
    expect(inv5cFindingsOfTree(tree1), 'the round-8 gap, pinned: INV-5c sees neither the load nor the renamed constructor').toEqual([]);
    expect(src1FindingsOfTree(tree1), 'the round-8 gap, pinned: SRC-1 sees nothing').toEqual([]);

    await new Promise<void>((resolve) => setImmediate(resolve)); // CHECK_WRONG(rpc-yield): flush the vitest worker RPC between sections
    // Probe 2 — the permitted bootstrap (index.ts) installs that Worker as the
    // REAL runner's launcher: no new owner edge, no re-export.
    const BUILTIN_WRAPPER = `${indexText}\n${[
      'export function installBuiltinInMainParserLauncher(): void {',
      '  setXlsxWorkerForkFn((modulePath: string, args: string[]) => {',
      "    const ParserThread = process.getBuiltinModule('node:worker_threads').Worker;",
      '    const worker = new ParserThread(modulePath, { argv: args, stdout: true });',
      '    return {',
      '      pid: process.pid,',
      '      stderr: null,',
      '      on(event: any, cb: any) { worker.on(event, cb); },',
      '      kill() { void worker.terminate(); },',
      '    };',
      '  });',
      '}',
    ].join('\n')}\n`;
    const tree2 = withFiles([['index.ts', BUILTIN_WRAPPER]]);
    expect(walkOf(tree2), 'probe 2 -> SRC-4 builtin-access in index.ts').toEqual(['index.ts builtin-access process.getBuiltinModule']);
    expect(src3Of(tree2), 'probe 2 -> SRC-3 builtin-get worker_threads in index.ts').toEqual(['index.ts builtin-get worker_threads']);
    expect(inv5bFindingsOfTree(tree2), 'the round-8 gap, pinned: no new owner edge').toEqual([]);
    expect(src2FindingsOfTree(tree2), 'the round-8 gap, pinned: no re-export').toEqual([]);

    await new Promise<void>((resolve) => setImmediate(resolve)); // CHECK_WRONG(rpc-yield): flush the vitest worker RPC between sections
    // Probe 3 — inspector Runtime.evaluate hides the parser load and entry
    // reference inside an expression STRING; the source is the inspector load.
    const INSPECTOR_EVAL = [
      "import { Session } from 'node:inspector/promises';",
      'export async function evaluateInMain(expression: string): Promise<unknown> {',
      '  const session = new Session();',
      '  session.connect();',
      '  try {',
      "    return await session.post('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });",
      '  } finally {',
      '    session.disconnect();',
      '  }',
      '}',
      'export const parseExpression = "process.getBuiltinModule(\'module\').createRequire(\'E:/ZCode/trainingapp/desktop/package.json\')(\'jszip\').loadAsync(new Uint8Array(0))";',
    ].join('\n');
    const tree3 = withFiles([['backend/ingest/inspector-eval.ts', INSPECTOR_EVAL]]);
    expect(src3Of(tree3), 'probe 3 -> SRC-3 builtin-load inspector/promises').toEqual(['backend/ingest/inspector-eval.ts builtin-load inspector/promises']);
    expect(walkOf(tree3), 'the round-8 gap, pinned: the evaluated expression is a string — the loader walk sees nothing').toEqual([]);
    expect(parserEntryReferencesInSource(INSPECTOR_EVAL, 'backend/ingest/inspector-eval.ts'), 'the round-8 gap, pinned: INV-3 sees nothing').toEqual([]);

    await new Promise<void>((resolve) => setImmediate(resolve)); // CHECK_WRONG(rpc-yield): flush the vitest worker RPC between sections
    // Probe 4 — vm obtained through process.getBuiltinModule.
    const BUILTIN_VM = [
      "const vm = process.getBuiltinModule('node:vm');",
      'export function evaluateInMain(expression: string): unknown {',
      '  return vm.runInThisContext(expression);',
      '}',
      'export const parseExpression = "process.getBuiltinModule(\'module\').createRequire(\'E:/ZCode/trainingapp/desktop/package.json\')(\'jszip\').loadAsync(new Uint8Array(0))";',
    ].join('\n');
    const tree4 = withFiles([['backend/ingest/builtin-vm.ts', BUILTIN_VM]]);
    expect(walkOf(tree4), 'probe 4 -> SRC-4 builtin-access').toEqual(['backend/ingest/builtin-vm.ts builtin-access process.getBuiltinModule']);
    expect(src3Of(tree4), 'probe 4 -> SRC-3 builtin-get vm').toEqual(['backend/ingest/builtin-vm.ts builtin-get vm']);
    expect(src1FindingsOfTree(tree4), 'the round-8 gap, pinned: SRC-1 sees no vm LOAD').toEqual([]);

    // Further aliases and sources, each in a new module: every one turns the
    // tree red in SRC-3, SRC-4 or SRC-5.
    await new Promise<void>((resolve) => setImmediate(resolve)); // CHECK_WRONG(rpc-yield): flush the vitest worker RPC between sections
    const extraRows: Array<[string, string, { walk: number; src3: number; src5: number }]> = [
      ['const gbm = process.getBuiltinModule', "const gbm = process.getBuiltinModule;\nexport const vm = gbm('vm');", { walk: 1, src3: 0, src5: 0 }],
      ['const { getBuiltinModule } = process', "const { getBuiltinModule } = process;\nexport const vm = getBuiltinModule('node:vm');", { walk: 2, src3: 1, src5: 0 }],
      ['globalThis.process.getBuiltinModule', "export const W = globalThis.process.getBuiltinModule('worker_threads').Worker;", { walk: 1, src3: 1, src5: 0 }],
      ["process.binding('fs')", "export const fsb = process.binding('fs');", { walk: 1, src3: 0, src5: 0 }],
      ["import('node:inspector')", "export const insp = await import('node:inspector');", { walk: 0, src3: 1, src5: 0 }],
      ["require('repl')", "const repl = require('repl');\nexport const r = repl.start();", { walk: 0, src3: 1, src5: 0 }],
      ['import wasi', "import { WASI } from 'node:wasi';\nexport const w = new WASI({ version: 'preview1' });", { walk: 0, src3: 1, src5: 0 }],
      ["new (await import('node:test')).run", "export const go = async (files: string[]): Promise<unknown> => new (await import('node:test')).run({ files, isolation: 'none' });", { walk: 0, src3: 1, src5: 0 }],
      ['node:sqlite loadExtension', "import { DatabaseSync } from 'node:sqlite';\nexport const load = (p: string): void => { new DatabaseSync(':memory:', { allowExtension: true }).loadExtension(p); };", { walk: 0, src3: 1, src5: 1 }],
    ];
    for (const [label, code, want] of extraRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      const tree = withFiles([['backend/ingest/r8-extra.ts', code]]);
      const got = { walk: walkOf(tree).length, src3: src3FindingsOfTree(tree).length, src5: src5OfTree(tree).findings.length };
      expect(got, label).toEqual(want);
    }
    // NEGATIVE: ordinary inert built-ins in a new module change nothing.
    const inertTree = withFiles([['backend/ingest/r8-inert.ts', "import fs from 'node:fs';\nimport path from 'node:path';\nimport { createHash } from 'node:crypto';\nexport const h = (p: string): string => createHash('sha256').update(fs.readFileSync(path.resolve(p))).digest('hex');"]]);
    expect({ walk: walkOf(inertTree), src3: src3FindingsOfTree(inertTree), src5: src5OfTree(inertTree).findings }, 'inert built-ins are not sources').toEqual({ walk: [], src3: [], src5: [] });
  });

  it('S1 self-test (round-9 probes / SRC-7 + SRC-8): the external-wrapper and #alias routes turn the tree red', { timeout: 300_000 }, async () => {
    // The plan critic's round-9 probes VERBATIM
    // (repro/critic-round9-probes.mjs ownProbe rows; before amendments (v)/(w)
    // every one of the 15 layers was EMPTY — critic-round9-probes.out lines
    // 12-15). The external-wrapper probes (a main module importing a local
    // module OUTSIDE desktop/main — TypeScript compiles it into the main
    // program, and the critic's wrapper parsed the CANONICAL installed xlsx
    // IN THE MAIN PID on Node, Electron-as-Node and a real Electron 45.2.1
    // main process) now trip SRC-7 in relative, absolute and file: URL form;
    // every '#alias' load route (a package.json `imports` alias the critic
    // resolved to the canonical installed xlsx, parsing a real workbook
    // in-process) now trips SRC-8 and, via the packageNameOf fix, also
    // surfaces UNCLASSIFIED under SRC-6.
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const withFiles = (entries: Array<[string, string]>): Map<string, string> => {
      const tree = new Map(baseTree);
      for (const [rel, text] of entries) tree.set(rel, text);
      return tree;
    };
    const src7Of = (tree: ReadonlyMap<string, string>): string[] => src7FindingsOfTree(tree, MAIN_DIR).map((f) => `${f.file} ${f.form} ${f.resolved}`);
    const src8Of = (tree: ReadonlyMap<string, string>): string[] => src8FindingsOfTree(tree).map((f) => `${f.file} ${f.form} ${f.specifier}`);

    // Probe 1 — "main imports an UNSCANNED local wrapper outside desktop/main"
    // (the critic's exact consumer, relative form).
    const EXTERNAL_WRAPPER_CONSUMER = [
      "import { parseWorkbook } from '../shared/workbook-parser.js';",
      'export function parse(filePath: string): unknown {',
      '  return parseWorkbook(filePath);',
      '}',
    ].join('\n');
    const tree1 = withFiles([['external-wrapper.ts', EXTERNAL_WRAPPER_CONSUMER]]);
    expect(src7Of(tree1), 'probe 1 -> SRC-7 local escape (relative form)').toEqual([
      'external-wrapper.ts import ../shared/workbook-parser.js',
    ]);
    expect(src8Of(tree1), 'probe 1 has no # specifier').toEqual([]);
    expect(
      src6FindingsOfTree(tree1).filter((f) => f.kind === 'UNCLASSIFIED'),
      'the round-9 gap, pinned: SRC-6 sees no package (the specifier is local)',
    ).toEqual([]);

    // Probes 1b/1c — the same external wrapper by ABSOLUTE (drive) and file:
    // URL specifiers (round-9 Required Revision 1's remaining forms).
    const wrapperAbs = path.resolve(MAIN_DIR, '..', 'shared', 'workbook-parser.js').split(path.sep).join('/');
    const wrapperUrl = pathToFileURL(wrapperAbs).href;
    for (const [label, specifier] of [
      ['absolute (drive) form', wrapperAbs],
      ['file: URL form', wrapperUrl],
    ] as const) {
      const tree = withFiles([
        [
          'external-wrapper.ts',
          `import { parseWorkbook } from ${JSON.stringify(specifier)};\nexport function parse(filePath: string): unknown {\n  return parseWorkbook(filePath);\n}`,
        ],
      ]);
      expect(src7Of(tree), `external wrapper, ${label} -> SRC-7 local escape`).toEqual([
        'external-wrapper.ts import ../shared/workbook-parser.js',
      ]);
    }

    // Probe 2 — `import * as XLSX from '#workbook'` (the critic's static form).
    const PACKAGE_ALIAS_IMPORT = [
      "import * as XLSX from '#workbook';",
      'export function parseWorkbook(bytes: Uint8Array): unknown {',
      "  return XLSX.read(bytes, { type: 'buffer' });",
      '}',
    ].join('\n');
    const tree2 = withFiles([['backend/ingest/package-import-alias.ts', PACKAGE_ALIAS_IMPORT]]);
    expect(src8Of(tree2), 'probe 2 -> SRC-8 #alias (static import)').toEqual([
      'backend/ingest/package-import-alias.ts import #workbook',
    ]);
    expect(src7Of(tree2), 'a # specifier is not a local edge SRC-7 resolves').toEqual([]);
    expect(
      src6FindingsOfTree(tree2).filter((f) => f.kind === 'UNCLASSIFIED'),
      'packageNameOf surfaces the alias to SRC-6 as UNCLASSIFIED',
    ).toEqual([{ kind: 'UNCLASSIFIED', name: '#workbook' }]);

    // Probe 3 — `require('#workbook')` (the critic used a .cts file).
    const PACKAGE_ALIAS_REQUIRE = [
      "const XLSX = require('#workbook');",
      'export function parseWorkbook(bytes: Uint8Array): unknown {',
      "  return XLSX.read(bytes, { type: 'buffer' });",
      '}',
    ].join('\n');
    const tree3 = withFiles([['backend/ingest/package-require-alias.cts', PACKAGE_ALIAS_REQUIRE]]);
    expect(src8Of(tree3), 'probe 3 -> SRC-8 #alias (require)').toEqual([
      'backend/ingest/package-require-alias.cts require() #workbook',
    ]);

    // Probe 4 — `await import('#workbook')` (dynamic form).
    const PACKAGE_ALIAS_DYNAMIC = [
      'export async function parseWorkbook(bytes: Uint8Array): Promise<unknown> {',
      "  const XLSX = await import('#workbook');",
      "  return XLSX.read(bytes, { type: 'buffer' });",
      '}',
    ].join('\n');
    const tree4 = withFiles([['backend/ingest/package-dynamic-alias.ts', PACKAGE_ALIAS_DYNAMIC]]);
    expect(src8Of(tree4), 'probe 4 -> SRC-8 #alias (dynamic import)').toEqual([
      'backend/ingest/package-dynamic-alias.ts import() #workbook',
    ]);

    // Probe 5 — a createRequire alias loading '#workbook'.
    const PACKAGE_ALIAS_CREATEREQUIRE = [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const XLSX = require('#workbook');",
      'export function parseWorkbook(bytes: Uint8Array): unknown {',
      "  return XLSX.read(bytes, { type: 'buffer' });",
      '}',
    ].join('\n');
    const tree5 = withFiles([['backend/ingest/package-require-alias-via-createrequire.ts', PACKAGE_ALIAS_CREATEREQUIRE]]);
    expect(src8Of(tree5), 'probe 5 -> SRC-8 #alias (createRequire result)').toEqual([
      'backend/ingest/package-require-alias-via-createrequire.ts require() #workbook',
    ]);

    // Probe 6 — import-equals `import XLSX = require('#workbook')`.
    const PACKAGE_ALIAS_IMPORT_EQUALS = [
      "import XLSX = require('#workbook');",
      'export function parseWorkbook(bytes: Uint8Array): unknown {',
      "  return XLSX.read(bytes, { type: 'buffer' });",
      '}',
    ].join('\n');
    const tree6 = withFiles([['backend/ingest/package-import-equals-alias.ts', PACKAGE_ALIAS_IMPORT_EQUALS]]);
    expect(src8Of(tree6), 'probe 6 -> SRC-8 #alias (import-equals)').toEqual([
      'backend/ingest/package-import-equals-alias.ts import=require #workbook',
    ]);

    // Probe 7 — the new-package-alias variant ('#new-parser').
    const NEW_PARSER_ALIAS = "import { parse } from '#new-parser';\nexport const parseDocument = (bytes: Uint8Array): unknown => parse(bytes);";
    const tree7 = withFiles([['backend/ingest/package-new-parser-alias.ts', NEW_PARSER_ALIAS]]);
    expect(src8Of(tree7), 'probe 7 -> SRC-8 #alias to a brand-new parser package').toEqual([
      'backend/ingest/package-new-parser-alias.ts import #new-parser',
    ]);
    expect(
      src6FindingsOfTree(tree7).filter((f) => f.kind === 'UNCLASSIFIED'),
      'the new-parser alias also surfaces UNCLASSIFIED',
    ).toEqual([{ kind: 'UNCLASSIFIED', name: '#new-parser' }]);

    // Every other recognised load ROUTE, for both rules (round-9 Required
    // Revisions 1-2: relative / absolute / file: URL escapes by every route;
    // static import, require, dynamic import, export-from, createRequire and
    // escaped-'#' rows). Rows: [label, main-relative file, source, rule,
    // expected `file form resolved|specifier` lines].
    const src78RouteRows: Array<[string, string, string, string, string[]]> = [
      ['SRC-7 via dynamic import()', 'backend/ingest/dyn-wrapper.ts', "export const load = async (): Promise<unknown> => import('../../../shared/workbook-parser.js');", 'SRC-7', ['backend/ingest/dyn-wrapper.ts import() ../shared/workbook-parser.js']],
      ['SRC-7 via require', 'backend/ingest/req-wrapper.cts', "const w = require('../../../shared/workbook-parser.js');\nexport const parse = w.parseWorkbook;", 'SRC-7', ['backend/ingest/req-wrapper.cts require() ../shared/workbook-parser.js']],
      ['SRC-7 via a createRequire result', 'backend/ingest/cr-wrapper.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const w = require('../../../shared/workbook-parser.js');", 'SRC-7', ['backend/ingest/cr-wrapper.ts require() ../shared/workbook-parser.js']],
      ['SRC-7 via import-equals', 'backend/ingest/ie-wrapper.ts', "import w = require('../../../shared/workbook-parser.js');\nexport const parse = w.parseWorkbook;", 'SRC-7', ['backend/ingest/ie-wrapper.ts import=require ../shared/workbook-parser.js']],
      ['SRC-7 via export-from', 'backend/ingest/reexport-wrapper.ts', "export { parseWorkbook } from '../../../shared/workbook-parser.js';", 'SRC-7', ['backend/ingest/reexport-wrapper.ts export-from ../shared/workbook-parser.js']],
      ['SRC-7 via side-effect import', 'backend/ingest/side-effect-wrapper.ts', "import '../../../shared/workbook-parser.js';", 'SRC-7', ['backend/ingest/side-effect-wrapper.ts import ../shared/workbook-parser.js']],
      ['SRC-7 via an escape-coded relative specifier', 'backend/ingest/escaped-wrapper.ts', "import '../../../shared/\\x77orkbook-parser.js';", 'SRC-7', ['backend/ingest/escaped-wrapper.ts import ../shared/workbook-parser.js']],
      ["SRC-7: an edge resolving EXACTLY to desktop/main's parent", 'parent-edge.ts', "import x from '..';\nexport const y = x;", 'SRC-7', ['parent-edge.ts import ..']],
      ['SRC-7: a deeper escape into the repository root', 'backend/ingest/repo-root-wrapper.ts', "import { x } from '../../../../web_ui/src/x.js';\nexport const y = x;", 'SRC-7', ['backend/ingest/repo-root-wrapper.ts import ../../web_ui/src/x.js']],
      ['SRC-8 via export-from', 'backend/ingest/package-reexport-alias.ts', "export { read } from '#workbook';", 'SRC-8', ['backend/ingest/package-reexport-alias.ts export-from #workbook']],
      ['SRC-8 via side-effect import', 'backend/ingest/package-side-effect-alias.ts', "import '#workbook';", 'SRC-8', ['backend/ingest/package-side-effect-alias.ts import #workbook']],
      ['SRC-8 escape-coded (cooks to #workbook)', 'backend/ingest/package-escaped-alias.ts', "import * as XLSX from '\\x23workbook';\nexport const r = XLSX;", 'SRC-8', ['backend/ingest/package-escaped-alias.ts import #workbook']],
      ['SRC-8 a #subpath alias', 'backend/ingest/package-subpath-alias.ts', "import { read } from '#parsers/xlsx';\nexport const r = read;", 'SRC-8', ['backend/ingest/package-subpath-alias.ts import #parsers/xlsx']],
      ['NEGATIVE: an in-tree relative climb that stays inside', 'backend/ingest/climb-inside.ts', "import { x } from '../../update-checker.js';\nexport const y = x;", 'SRC-7', []],
      ['NEGATIVE: a bare package is not a local edge (SRC-6 owns it)', 'backend/ingest/bare.ts', "import Ajv2020 from 'ajv/dist/2020';\nexport const A = Ajv2020;", 'SRC-7', []],
    ];
    for (const [label, rel, code, rule, want] of src78RouteRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      const tree = withFiles([[rel, code]]);
      expect(rule === 'SRC-7' ? src7Of(tree) : src8Of(tree), label).toEqual(want);
    }
    // Computed-negative rows (absolute / file: URL / case-variant paths INSIDE
    // desktop/main are not escapes; computed at run time because they embed
    // this checkout's absolute paths).
    const extractorsAbs = path.join(MAIN_DIR, 'backend', 'ingest', 'extractors.js').split(path.sep).join('/');
    for (const [label, specifier] of [
      ['absolute path INSIDE desktop/main', extractorsAbs],
      ['file: URL INSIDE desktop/main', pathToFileURL(extractorsAbs).href],
      ['case-variant absolute path INSIDE desktop/main (Windows)', extractorsAbs.toUpperCase()],
    ] as const) {
      const tree = withFiles([
        ['backend/ingest/inside-absolute.ts', `import { extractDocumentFromFile } from ${JSON.stringify(specifier)};\nexport const p = extractDocumentFromFile;`],
      ]);
      expect(src7Of(tree), `NEGATIVE: an ${label} is not an escape`).toEqual([]);
    }

    // NEGATIVES: ordinary in-tree relative imports, the base tree, and the
    // simulated post-fix tree (the virtual head shape: the planned doc child,
    // doc runner, extractors route, index registration and backend stop
    // wiring) all stay green — the fix shape introduces no SRC-7 / SRC-8
    // finding.
    const ordinary = withFiles([
      [
        'backend/ingest/ordinary-relative.ts',
        "import { extractDocumentFromFile } from './extractors.js';\nimport { extractPackZip } from '../packs/surface.js';\nexport const parse = extractDocumentFromFile;\nexport const unzip = extractPackZip;",
      ],
    ]);
    expect(src7Of(ordinary), 'NEGATIVE: ordinary in-tree relative imports stay inside').toEqual([]);
    expect(src8Of(ordinary), 'NEGATIVE: no # specifier').toEqual([]);
    expect(src7Of(baseTree), 'NEGATIVE: the base tree has zero local escapes').toEqual([]);
    expect(src8Of(baseTree), 'NEGATIVE: the base tree has zero # specifiers').toEqual([]);
    const plannedDocChild = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "export const DOC_WORKER_ERROR_PREFIX = 'doc worker: ';",
      'async function extractPdf(filePath: string) {',
      "  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as { getDocument(src: { data: Uint8Array }): { promise: Promise<{ numPages: number }> } };",
      '  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(filePath)) }).promise;',
      '  return { text: String(doc.numPages) };',
      '}',
      'async function extractDocx(filePath: string) {',
      '  const mammoth = (await import(\'mammoth\')) as unknown as { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> };',
      '  const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });',
      '  return { text: value };',
      '}',
      'async function extractPptx(filePath: string) {',
      "  const JSZip = (await import('jszip')).default;",
      '  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));',
      '  return { text: Object.keys(zip.files).join() };',
      '}',
      'export async function runDocChildMain(argv: string[], channel?: { postMessage(m: unknown): void }): Promise<number> {',
      '  const filePath = argv[argv.length - 1] as string;',
      '  const ext = path.extname(filePath).toLowerCase();',
      "  const r = ext === '.pdf' ? await extractPdf(filePath) : ext === '.docx' ? await extractDocx(filePath) : await extractPptx(filePath);",
      '  channel?.postMessage({ ok: true, ...r });',
      '  return 0;',
      '}',
    ].join('\n');
    const plannedDocRunner = (baseTree.get(XLSX_RUNNER_RELATIVE) ?? '')
      .replaceAll('xlsx-worker-child', 'doc-worker-child')
      .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'DOC_WORKER_ERROR_PREFIX')
      .replaceAll('xlsxWorkerChildPath', 'docWorkerChildPath')
      .replaceAll('setXlsxWorkerForkFn', 'setDocWorkerForkFn')
      .replaceAll('XlsxWorker', 'DocWorker')
      .replaceAll('DEFAULT_XLSX_TIMEOUT_MS', 'DEFAULT_DOC_TIMEOUT_MS')
      .replaceAll('extractXlsxOutOfProcess', 'extractDocOutOfProcess');
    const plannedExtractors = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { extractDocOutOfProcess } from './doc-worker.js';",
      'export async function extractDocumentFromFile(filePath: string, opts: { maxZipBytes?: number; timeoutMs?: number; childPath?: string } = {}) {',
      '  const ext = path.extname(filePath).toLowerCase();',
      "  if (ext === '.docx' || ext === '.pptx') return extractDocOutOfProcess(filePath, { maxZipBytes: opts.maxZipBytes, timeoutMs: opts.timeoutMs, childPath: opts.childPath });",
      "  if (ext === '.pdf') return extractDocOutOfProcess(filePath, { timeoutMs: opts.timeoutMs, childPath: opts.childPath });",
      "  if (ext === '.xlsx') { const { extractXlsxOutOfProcess } = await import('./xlsx-worker.js'); return { text: await extractXlsxOutOfProcess(filePath, opts) }; }",
      "  return { text: fs.readFileSync(filePath, 'utf8') };",
      '}',
    ].join('\n');
    const plannedIndex = (baseTree.get('index.ts') ?? '')
      .replace(/import \{\r?\n  setXlsxWorkerForkFn,/, "import {\n  setDocWorkerForkFn,\n  type DocWorkerChild,\n} from './backend/ingest/doc-worker.js';\nimport {\n  setXlsxWorkerForkFn,")
      .replace('    setXlsxWorkerForkFn((modulePath, args) =>', [
        '    setDocWorkerForkFn((modulePath, args) =>',
        '      utilityProcess.fork(modulePath, args, {',
        "        stdio: ['ignore', 'ignore', 'pipe'],",
        "        serviceName: 'TrainingApp document parser',",
        '      }) as unknown as DocWorkerChild,',
        '    );',
        '    setXlsxWorkerForkFn((modulePath, args) =>',
      ].join('\n'));
    const plannedBackendIndex = (baseTree.get('backend/index.ts') ?? '')
      .replace("import { terminateXlsxWorkers } from './ingest/xlsx-worker.js';", "import { terminateDocWorkers } from './ingest/doc-worker.js';\nimport { terminateXlsxWorkers } from './ingest/xlsx-worker.js';")
      .replace('    terminateXlsxWorkers();', '    terminateDocWorkers();\n    terminateXlsxWorkers();');
    const headTree = new Map(baseTree);
    headTree.set(DOC_CHILD_RELATIVE, plannedDocChild);
    headTree.set(DOC_RUNNER_RELATIVE, plannedDocRunner);
    headTree.set('backend/ingest/extractors.ts', plannedExtractors);
    headTree.set('index.ts', plannedIndex);
    headTree.set('backend/index.ts', plannedBackendIndex);
    expect(src7Of(headTree), 'NEGATIVE: the simulated post-fix tree has zero local escapes').toEqual([]);
    expect(src8Of(headTree), 'NEGATIVE: the simulated post-fix tree has zero # specifiers').toEqual([]);
    // Anti-vacuity: the simulated head really carries the planned in-main
    // relative edges (runner -> child, extractors -> runner).
    expect(
      loadSitesInSource(headTree.get(DOC_RUNNER_RELATIVE) ?? '', DOC_RUNNER_RELATIVE).some(
        (s) => s.specifier === './doc-worker-child.js',
      ),
      'the simulated head really has the runner -> child relative edge',
    ).toBe(true);
    expect(
      loadSitesInSource(plannedExtractors, 'backend/ingest/extractors.ts').some((s) => s.specifier === './doc-worker.js'),
      'the simulated head really has the extractors -> runner relative edge',
    ).toBe(true);
  });

  it('S1 self-test (round-10 probes / SRC-7\' + SRC-9): the directory-package, junction, nativeBinding and .node routes turn the tree red', { timeout: 300_000 }, async () => {
    // The plan critic's round-10 probes (repro/critic-round10-probes.mjs —
    // before amendments (x)/(y) every one of the 17 layers was EMPTY;
    // critic-round10-probes.out lines 5-34): a directory edge resolved
    // through a nested package.json `main` pointing OUTSIDE main executed
    // canonical xlsx in the consumer PID on Node, Electron-as-Node and a
    // REAL Electron 45.2.1 main process (PID 43748); a directory junction
    // imported as './linked/workbook-parser.cjs' did the same (real Electron
    // main PID 57004) while the walk listed only probe.cjs — the junction is
    // neither isDirectory() nor isFile(); better-sqlite3's `nativeBinding`
    // option loaded the canonical .node addon and executed native SQL
    // ({answer:42}) in the calling PID on both runtimes; a recognised
    // createRequire result loading './native-parser.node' did the same. Each
    // route is now pinned, plus the regressions the plan adds: a bare
    // package-subpath .node load, in-tree main/exports/twin/symlink
    // NEGATIVES, and the import-equals / dynamic-import / createRequire /
    // option-shape routes.
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const withFiles = (entries: Array<[string, string]>): Map<string, string> => {
      const tree = new Map(baseTree);
      for (const [rel, text] of entries) tree.set(rel, text);
      return tree;
    };
    const src7Of = (tree: ReadonlyMap<string, string>, mainDir = MAIN_DIR): string[] =>
      src7FindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.resolved} ${f.via} ${f.actual}`);
    const src9Node = (tree: ReadonlyMap<string, string>, mainDir = MAIN_DIR): string[] =>
      src9NodeLoadFindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.via} ${f.node}`);
    const src9Binding = (tree: ReadonlyMap<string, string>): string[] =>
      src9NativeBindingFindingsOfTree(tree).map((s) => `${s.file} ${s.form} ${s.name}`);

    // --- In-memory probe rows: the native routes (the critic's sources
    // --- VERBATIM) plus every other load route and option shape. (The
    // --- sources are inlined so the extraction mirror can replay the table
    // --- verbatim; the two verbatim consts below are reused by the gap pin.)
    const NATIVE_BINDING_PROBE = [
      "import Database from 'better-sqlite3';",
      'export function executeThroughNativeAddon(nativeBinding: string): unknown {',
      "  const db = new Database(':memory:', { nativeBinding });",
      "  const row = db.prepare('select 42 as answer').get();",
      '  db.close();',
      '  return row;',
      '}',
    ].join('\n');
    const DIRECT_NATIVE_PROBE = [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const native = require('./native-parser.node');",
      'export function parseDocument(bytes: Uint8Array): unknown {',
      '  return native.parseDocument(bytes);',
      '}',
    ].join('\n');
    // Rows: [label, main-relative file, source, rule, expected lines].
    const src79ProbeRows: Array<[string, string, string, string, string[]]> = [
      ['round-10 probe (verbatim): better-sqlite3 nativeBinding loads an arbitrary native addon path', 'backend/ingest/native-binding.ts', "import Database from 'better-sqlite3';\nexport function executeThroughNativeAddon(nativeBinding: string): unknown {\n  const db = new Database(':memory:', { nativeBinding });\n  const row = db.prepare('select 42 as answer').get();\n  db.close();\n  return row;\n}", 'SRC-9-binding', [
        'backend/ingest/native-binding.ts identifier nativeBinding',
        'backend/ingest/native-binding.ts key nativeBinding',
      ]],
      ['round-10 probe (verbatim): direct relative .node load (createRequire result)', 'backend/ingest/native-parser.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst native = require('./native-parser.node');\nexport function parseDocument(bytes: Uint8Array): unknown {\n  return native.parseDocument(bytes);\n}", 'SRC-9-node', ['backend/ingest/native-parser.ts require() specifier ./native-parser.node']],
      ['package-subpath .node (the extension rule is not relative-only)', 'backend/ingest/pkg-subpath-native.ts', "import native from 'some-pkg/prebuilds/win-x64/addon.node';\nexport const parse = (b: Uint8Array): unknown => native.parse(b);", 'SRC-9-node', ['backend/ingest/pkg-subpath-native.ts import specifier some-pkg/prebuilds/win-x64/addon.node']],
      ['.node via dynamic import()', 'backend/ingest/dyn-native.ts', "export const load = async (): Promise<unknown> => import('./native-parser.node');", 'SRC-9-node', ['backend/ingest/dyn-native.ts import() specifier ./native-parser.node']],
      ['.node via import-equals', 'backend/ingest/ie-native.ts', "import native = require('./native-parser.node');\nexport const parse = native.parseDocument;", 'SRC-9-node', ['backend/ingest/ie-native.ts import=require specifier ./native-parser.node']],
      ['.node via a file: URL', 'backend/ingest/url-native.ts', "export const load = (): unknown => require('file:///E:/ZCode/trainingapp/desktop/main/backend/ingest/native-parser.node');", 'SRC-9-node', ['backend/ingest/url-native.ts require() specifier file:///E:/ZCode/trainingapp/desktop/main/backend/ingest/native-parser.node']],
      ['.node via member require', 'backend/ingest/member-native.cts', "const native = module.require('./native-parser.node');\nexport const parse = native.parseDocument;", 'SRC-9-node', ['backend/ingest/member-native.cts member.require() specifier ./native-parser.node']],
      ['.node by a case-variant extension (Windows)', 'backend/ingest/case-native.ts', "import native from './native-parser.NODE';\nexport const parse = native.parseDocument;", 'SRC-9-node', ['backend/ingest/case-native.ts import specifier ./native-parser.NODE']],
      ['nativeBinding as a property access', 'backend/ingest/binding-access.ts', "import Database from 'better-sqlite3';\nexport const open = (opts: { nativeBinding?: string }): unknown => new Database(':memory:', { nativeBinding: opts.nativeBinding });", 'SRC-9-binding', ['backend/ingest/binding-access.ts dot nativeBinding', 'backend/ingest/binding-access.ts key nativeBinding']],
      ['nativeBinding as a literal element (and a computed literal key)', 'backend/ingest/binding-element.ts', "import Database from 'better-sqlite3';\nexport const open = (opts: Record<string, string>): unknown => new Database(':memory:', { ['nativeBinding']: opts['nativeBinding'] });", 'SRC-9-binding', ['backend/ingest/binding-element.ts element nativeBinding', 'backend/ingest/binding-element.ts key nativeBinding']],
      ['nativeBinding destructured', 'backend/ingest/binding-destructure.ts', "import Database from 'better-sqlite3';\nexport const open = (opts: { nativeBinding?: string }): unknown => {\n  const { nativeBinding } = opts;\n  return new Database(':memory:', { nativeBinding });\n};", 'SRC-9-binding', ['backend/ingest/binding-destructure.ts binding nativeBinding', 'backend/ingest/binding-destructure.ts key nativeBinding']],
      ['NEGATIVE: nativeBinding only in a TYPE position', 'backend/ingest/binding-type.ts', 'export interface NativeOpts { nativeBinding?: string }', 'SRC-9-binding', []],
      ['NEGATIVE: better-sqlite3 without the nativeBinding option', 'backend/ingest/plain-sqlite.ts', "import Database from 'better-sqlite3';\nexport const open = (): unknown => new Database(':memory:');", 'SRC-9-binding', []],
      ['NEGATIVE: an ordinary .ts import (a source, not a binary)', 'backend/ingest/plain-source.ts', "import { x } from './plain-sibling.js';\nexport const y = x;", 'SRC-9-node', []],
      ['NEGATIVE: a bare package load never names .node', 'backend/ingest/plain-package.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const db = require('better-sqlite3');", 'SRC-9-node', []],
    ];
    for (const [label, rel, code, rule, want] of src79ProbeRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      const tree = withFiles([[rel, code]]);
      const got = rule === 'SRC-9-binding' ? src9Binding(tree) : rule === 'SRC-9-node' ? src9Node(tree) : src7Of(tree);
      expect(got, label).toEqual(want);
    }
    // The two verbatim native probes are invisible to every PRE-round-10
    // layer (the critic's zero-finding evidence, pinned): the load inventory
    // sees only a bare package / a relative string, so no parser-load,
    // computed, loader-walk or SRC-1..SRC-8 finding fires on them.
    for (const [rel, code] of [
      ['backend/ingest/native-binding.ts', NATIVE_BINDING_PROBE],
      ['backend/ingest/native-parser.ts', DIRECT_NATIVE_PROBE],
    ] as const) {
      const tree = withFiles([[rel, code]]);
      expect(src7Of(tree), `round-10 gap pinned (${rel}): SRC-7 sees no escape (the specifiers are not local edges out of main)`).toEqual([]);
      expect(src8FindingsOfTree(tree), `round-10 gap pinned (${rel}): SRC-8 sees no # specifier`).toEqual([]);
    }

    // --- Filesystem-geometry probe rows: real directories, nested
    // --- package.json manifests and a junction, under throwaway roots.
    const probeRoot = makeTempDir('doc-worker-src7-');
    /** Build a throwaway `main` root with the given extra entries and walk it. */
    // AMENDED (round 13): keys relative to the PROBE main (treeOfFiles keys relative to MAIN_DIR, which made every probe key '../...' — a latent defect these never-at-base rows could not reveal).
    const walkProbeMain = (mainDir: string): Map<string, string> =>
      new Map(listTsFiles(mainDir).map((file) => [path.relative(mainDir, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const));
    const writeIf = (p: string, text: string): void => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };

    // Probe 1 (the critic's VERBATIM geometry): require('./container') with
    // container/package.json main '../../shared/workbook-parser.cjs' — the
    // lexical specifier is INSIDE main; the ACTUAL target is outside.
    const dirMain = path.join(probeRoot, 'directory-main', 'main');
    writeIf(path.join(dirMain, 'probe.cjs'), "const wrapper = require('./container');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
    writeIf(path.join(dirMain, 'container', 'package.json'), JSON.stringify({ main: '../../shared/workbook-parser.cjs' }));
    writeIf(path.join(dirMain, '..', 'shared', 'workbook-parser.cjs'), "const XLSX = require('xlsx');\nexports.resolvedXlsx = require.resolve('xlsx');\nexports.parseWorkbook = (p) => XLSX.read(require('fs').readFileSync(p), { type: 'buffer' });\n");
    const dirTree = walkProbeMain(dirMain);
    expect([...dirTree.keys()], 'the walk lists only the probe file (the container holds a manifest, not sources)').toEqual(['probe.cjs']);
    expect(src7Of(dirTree, dirMain), 'round-10 probe 1 -> SRC-7\' directory-main escape (the executed wrapper is OUTSIDE main)').toEqual([
      `probe.cjs require() container directory-main ${'../shared/workbook-parser.cjs'}`,
    ]);
    expect(src7PackageJsonFindingsOf(dirMain), 'the nested package.json is itself a finding (its main resolves outside)').toEqual([
      { file: 'container/package.json', field: 'main', target: '../../shared/workbook-parser.cjs', resolved: '../shared/workbook-parser.cjs' },
    ]);
    expect(src7LinkFindingsOf(dirMain), 'no links in the directory probe').toEqual([]);

    // Probe 2 (the critic's VERBATIM geometry): a directory junction — the
    // specifier is lexically inside, the FILESYSTEM follows the link.
    const jnRoot = path.join(probeRoot, 'junction');
    const jnMain = path.join(jnRoot, 'main');
    writeIf(path.join(jnMain, 'probe.cjs'), "const wrapper = require('./linked/workbook-parser.cjs');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
    writeIf(path.join(jnRoot, 'shared', 'workbook-parser.cjs'), "const XLSX = require('xlsx');\nexports.resolvedXlsx = require.resolve('xlsx');\nexports.parseWorkbook = (p) => XLSX.read(require('fs').readFileSync(p), { type: 'buffer' });\n");
    fs.symlinkSync(path.join(jnRoot, 'shared'), path.join(jnMain, 'linked'), 'junction');
    const jnTree = walkProbeMain(jnMain);
    expect([...jnTree.keys()], 'the walk lists only the probe file — the junction is neither isDirectory() nor isFile()').toEqual(['probe.cjs']);
    expect(src7Of(jnTree, jnMain), 'round-10 probe 2 -> SRC-7\' realpath escape (the junction moves the target outside main)').toEqual([
      `probe.cjs require() linked/workbook-parser.cjs realpath ${'../shared/workbook-parser.cjs'}`,
    ]);
    expect(src7LinkFindingsOf(jnMain), 'the junction ENTRY is a link finding (fail-closed; never followed or scanned)').toEqual([{ link: 'linked' }]);
    expect(src7PackageJsonFindingsOf(jnMain), 'no package.json under the junction probe main').toEqual([]);

    // NEGATIVE: a nested package.json whose main stays IN-TREE.
    const okMain = path.join(probeRoot, 'in-tree-main', 'main');
    writeIf(path.join(okMain, 'probe.cjs'), "const inner = require('./container');\nmodule.exports = { v: inner };\n");
    writeIf(path.join(okMain, 'container', 'package.json'), JSON.stringify({ main: './inner.cjs' }));
    writeIf(path.join(okMain, 'container', 'inner.cjs'), 'module.exports = 42;\n');
    const okTree = walkProbeMain(okMain);
    expect(src7Of(okTree, okMain), 'NEGATIVE: a directory edge whose package.json main stays in-tree is not an escape').toEqual([]);
    expect(src7PackageJsonFindingsOf(okMain), 'NEGATIVE: the in-tree main produces no nested-manifest finding').toEqual([]);
    expect(src7LinkFindingsOf(okMain), 'NEGATIVE: no links').toEqual([]);

    // NEGATIVE: a nested package.json whose exports string targets stay IN-TREE.
    const exMain = path.join(probeRoot, 'in-tree-exports', 'main');
    writeIf(path.join(exMain, 'probe.cjs'), "const inner = require('./container');\nmodule.exports = { v: inner };\n");
    writeIf(path.join(exMain, 'container', 'package.json'), JSON.stringify({ exports: { '.': './inner.mjs', './x': './x.mjs' } }));
    writeIf(path.join(exMain, 'container', 'inner.mjs'), 'export const v = 1;\n');
    writeIf(path.join(exMain, 'container', 'x.mjs'), 'export const x = 2;\n');
    const exTree = walkProbeMain(exMain);
    expect(src7Of(exTree, exMain), 'NEGATIVE: a directory edge resolved through in-tree exports targets is not an escape').toEqual([]);
    expect(src7PackageJsonFindingsOf(exMain), 'NEGATIVE: in-tree exports targets produce no nested-manifest finding').toEqual([]);

    // NEGATIVE: the compiled-layout .ts twin mapping (an in-tree './x.js'
    // edge whose target is the x.ts source).
    const twinMain = path.join(probeRoot, 'twin-main', 'main');
    writeIf(path.join(twinMain, 'probe.ts'), "import { helper } from './helper.js';\nexport const v = helper;\n");
    writeIf(path.join(twinMain, 'helper.ts'), 'export const helper = 1;\n');
    const twinTree = walkProbeMain(twinMain);
    expect(src7Of(twinTree, twinMain), 'NEGATIVE: an in-tree .js specifier maps to its .ts twin (no escape, no unresolvable-directory)').toEqual([]);

    // PIN: a link INSIDE the tree pointing IN-TREE is STILL a finding
    // (fail-closed — a link's target can change after review). On Windows an
    // unprivileged reparse point is a junction (verified: Dirent
    // isSymbolicLink() === true for junctions; the same walk rule covers
    // privileged file symlinks).
    const linkMain = path.join(probeRoot, 'in-tree-link', 'main');
    writeIf(path.join(linkMain, 'probe.cjs'), "const helper = require('./linked-helper/helper.cjs');\nmodule.exports = { v: helper };\n");
    writeIf(path.join(linkMain, 'real-helper', 'helper.cjs'), 'module.exports = 42;\n');
    fs.symlinkSync(path.join(linkMain, 'real-helper'), path.join(linkMain, 'linked-helper'), 'junction');
    const linkTree = walkProbeMain(linkMain);
    expect(src7LinkFindingsOf(linkMain), 'an IN-TREE junction is STILL a link finding (fail-closed pin)').toEqual([{ link: 'linked-helper' }]);
    expect(
      src7Of(linkTree, linkMain),
      'the in-tree junction does NOT produce an escape (realpath stays inside) — the LINK rule is what fires, not containment',
    ).toEqual([]);

    // A directory-resolved .node target (SRC-9 via 'target'): the container
    // manifest routes the edge to a native binary.
    const nodeMain = path.join(probeRoot, 'directory-node', 'main');
    writeIf(path.join(nodeMain, 'probe.cjs'), "const native = require('./container');\nmodule.exports = { parse: native.parseDocument };\n");
    writeIf(path.join(nodeMain, 'container', 'package.json'), JSON.stringify({ main: './addon.node' }));
    writeIf(path.join(nodeMain, 'container', 'addon.node'), '<binary>');
    const nodeTree = walkProbeMain(nodeMain);
    expect(src9Node(nodeTree, nodeMain), 'a directory-resolved .node target is an SRC-9 finding (via target)').toEqual([
      'probe.cjs require() target container/addon.node',
    ]);

    // NEGATIVES over the base and simulated post-fix trees: both stay green
    // under the AMENDED rules (the fix shape adds no directory package, no
    // link and no nested manifest; its planned files are lexically in-tree).
    expect(src7Of(baseTree), 'NEGATIVE: the base tree has zero actual-resolution escapes').toEqual([]);
    const headTree = new Map(baseTree);
    headTree.set(DOC_CHILD_RELATIVE, (baseTree.get(XLSX_CHILD_RELATIVE) ?? '')
      .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'DOC_WORKER_ERROR_PREFIX')
      .replaceAll('runXlsxChildMain', 'runDocChildMain'));
    headTree.set('backend/ingest/plain-head.ts', "import { x } from './plain-head-sibling.js';\nexport const y = x;");
    expect(src7Of(headTree), 'NEGATIVE: an in-memory planned file with an in-tree edge stays green (lexical fallback for not-yet-emitted files)').toEqual([]);
    expect(src9Node(headTree), 'NEGATIVE: the head shape adds no .node load').toEqual([]);
    expect(src9Binding(headTree), 'NEGATIVE: the head shape adds no nativeBinding reference').toEqual([]);
  });

  it('S1 self-test (round-11 probes / SRC-10 + SRC-10b + SRC-10c): the extensionless, index.node, self-reference and .wasm routes turn the tree red', { timeout: 300_000 }, async () => {
    // The plan critic's round-11 probes (repro/critic-round11-probes.mjs —
    // before amendments (z)/(z')/(z'') every one of the 19 layers plus both
    // walks was EMPTY; critic-round11-probes.out lines 11-58, five executed
    // routes summarized at :60): an extensionless require('./native-parser')
    // resolved native-parser.node and executed native SQL in the calling PID
    // (Node, Electron-as-Node AND a real Electron 45.2.1 main process); a
    // directory require('./container') with only container/index.node did
    // the same; a nested main/package.json
    // {name:'better-sqlite3',exports:{'./addon':'./native-parser.node'}}
    // let the bare ALLOWED spelling 'better-sqlite3/addon' execute a LOCAL
    // native addon; an exact extensionless main/workbook-parser file parsed
    // the CANONICAL installed xlsx in the consumer PID on all three
    // runtimes; and a literal dynamic import('./answer.wasm') executed an
    // exported Wasm function ({answer:42}) on all three runtimes. Each route
    // is now pinned under the rule that catches it, plus the plan's
    // regressions (unknown-extension file, static .wasm import, the exact
    // self-reference spelling/subpath) and the empty-base NEGATIVES.
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const withFiles = (entries: Array<[string, string]>): Map<string, string> => {
      const tree = new Map(baseTree);
      for (const [rel, text] of entries) tree.set(rel, text);
      return tree;
    };
    const fmt10 = (tree: ReadonlyMap<string, string>, mainDir = MAIN_DIR): string[] =>
      src10FindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`);
    const fmt10bDir = (tree: ReadonlyMap<string, string>, mainDir = MAIN_DIR): string[] =>
      src10bDirectoryLoadFindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.via} ${f.resolved}`);
    const fmt10bSelf = (tree: ReadonlyMap<string, string>): string[] =>
      src10bSelfReferenceFindingsOfTree(tree).map((f) => `${f.file} ${f.form} ${f.specifier}`);
    const fmt10c = (tree: ReadonlyMap<string, string>, mainDir = MAIN_DIR): string[] =>
      src10cWasmLoadFindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.via} ${f.wasm}`);

    // --- In-memory probe rows (specifier-level rules: the target's
    // --- extension is on the specifier, so no filesystem is needed).
    // Rows: [label, main-relative file, source, rule, expected lines].
    const src10ProbeRows: Array<[string, string, string, string, string[]]> = [
      ['round-11 probe: X.node via an extensionless lookup (specifier names no extension; nothing observable)', 'backend/ingest/ext-node.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const native = require('./native-parser');", 'SRC-10', ['backend/ingest/ext-node.ts require() extensionless backend/ingest/native-parser']],
      ['round-11 gap pinned: SRC-9 sees NO .node on that extensionless specifier (the source-biased candidate lists omit .node)', 'backend/ingest/ext-node.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const native = require('./native-parser');", 'SRC-9-node', []],
      ['round-11 probe: direct .wasm via dynamic import()', 'backend/ingest/dyn-wasm.ts', "export const load = async (): Promise<unknown> => import('./answer.wasm');", 'SRC-10c', ['backend/ingest/dyn-wasm.ts import() specifier ./answer.wasm']],
      ['round-11 probe: direct .wasm via STATIC import (the required static regression)', 'backend/ingest/static-wasm.ts', "import run from './answer.wasm';\nexport const answer = (): number => run();", 'SRC-10c', ['backend/ingest/static-wasm.ts import specifier ./answer.wasm']],
      ['.wasm by a bare package subpath (the extension rule is not relative-only)', 'backend/ingest/pkg-wasm.ts', "import run from 'some-pkg/answer.wasm';\nexport const answer = (): number => run();", 'SRC-10c', ['backend/ingest/pkg-wasm.ts import specifier some-pkg/answer.wasm']],
      ['.wasm is in NO SRC-10 class either (fail-closed overlap with SRC-10c)', 'backend/ingest/dyn-wasm.ts', "export const load = async (): Promise<unknown> => import('./answer.wasm');", 'SRC-10', ['backend/ingest/dyn-wasm.ts import() wasm-binary backend/ingest/answer.wasm']],
      ['SRC-10b (iii): the package self-reference spelling EXACTLY', 'backend/ingest/self-ref.ts', "export { parse } from 'trainingapp-desktop';", 'SRC-10b-self', ['backend/ingest/self-ref.ts export-from trainingapp-desktop']],
      ['SRC-10b (iii): a self-reference subpath', 'backend/ingest/self-ref-sub.ts', "import { parse } from 'trainingapp-desktop/lib/parser';\nexport const p = parse;", 'SRC-10b-self', ['backend/ingest/self-ref-sub.ts import trainingapp-desktop/lib/parser']],
      ['NEGATIVE: an ordinary in-tree .ts import (a walked compiled-layout twin) is class (a)', 'backend/ingest/plain-src.ts', "import { x } from '../../update-checker.js';\nexport const y = x;", 'SRC-10', []],
      ['NEGATIVE: a classified NON-PARSER package in any file is class (b)', 'backend/ingest/plain-ajv.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const ajv = require('ajv/dist/2020');", 'SRC-10', []],
      ['NEGATIVE: the classified native addon entry (better-sqlite3 itself) is class (b)', 'backend/ingest/plain-sqlite10.ts', "import Database from 'better-sqlite3';\nexport const open = (): unknown => new Database(':memory:');", 'SRC-10', []],
      ['NEGATIVE: a built-in load is class (c)', 'backend/ingest/plain-fs.ts', "import fs from 'node:fs';\nexport const read = (): string => fs.readFileSync('x', 'utf8');", 'SRC-10', []],
      // SRC-10' rows (amendment (z3), round 12): class (b) is judged on the
      // RESOLVED root + target. The NEGATIVES resolve against the REAL
      // desktop/node_modules (these rows run at MAIN_DIR).
      ["SRC-10' NEGATIVE: a bare classified PARSER package resolves normally (jszip's extensionless main './lib/index' probes to lib/index.js)", 'backend/ingest/pkg-jszip.ts', "import { JSZip } from 'jszip';\nexport const z = JSZip;", 'SRC-10', []],
      ["SRC-10' NEGATIVE: a classified subpath load resolves normally (pdfjs-dist/legacy/build/pdf.mjs is an exact installed file)", 'backend/ingest/pkg-pdfjs.ts', "export const load = async (): Promise<unknown> => import('pdfjs-dist/legacy/build/pdf.mjs');", 'SRC-10', []],
      ["SRC-10' NEGATIVE: the file: TARBALL xlsx dependency materialises under desktop/node_modules and passes the canonical-root rule like every classified package", 'backend/ingest/pkg-xlsx.ts', "import * as XLSX from 'xlsx';\nexport const v = XLSX;", 'SRC-10', []],
      ["SRC-10' NEGATIVE: ajv/dist/2020 resolves to a .js FILE today (pinned: no exports map, the exact dist/2020.js subpath file)", 'backend/ingest/pkg-ajv2020.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const ajv = require('ajv/dist/2020');", 'SRC-10', []],
      ["SRC-10' NEGATIVE: the import-equals route resolves the same package (class (b), form import=require)", 'backend/ingest/pkg-import-equals.ts', "import jszip = require('jszip');\nexport const z = jszip;", 'SRC-10', []],
      ["SRC-10' NEGATIVE: the classified electron main entry resolves normally (no exports, main index.js)", 'backend/ingest/pkg-electron.ts', "import { app } from 'electron';\nexport const a = app;", 'SRC-10', []],
      ["SRC-10': a package .json subpath is class (d) gated — the allowlist is EMPTY, so better-sqlite3/package.json (an installed exports subpath) is a finding until allowlisted with a reason", 'backend/ingest/pkg-json.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const pkg = require('better-sqlite3/package.json');", 'SRC-10', ['backend/ingest/pkg-json.ts require() json-outside-allowlist node_modules/better-sqlite3/package.json']],
      ["SRC-10': a subpath of an allowed package that the canonical installation does not supply does not resolve — desktop/node_modules/ajv-formats has no 'addon', so the walk-up fails everywhere (at runtime Node would fall through to NODE_PATH, which the emulator refuses; the critic's round-12 escape 3)", 'backend/ingest/pkg-addon.ts', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const addon = require('ajv-formats/addon');", 'SRC-10', ['backend/ingest/pkg-addon.ts require() package-unresolved ajv-formats']],
    ];
    for (const [label, rel, code, rule, want] of src10ProbeRows) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // rpc-yield
      const tree = withFiles([[rel, code]]);
      const got =
        rule === 'SRC-10' ? fmt10(tree)
          : rule === 'SRC-10b-self' ? fmt10bSelf(tree)
            : rule === 'SRC-10c' ? fmt10c(tree)
              : src9NodeLoadFindingsOfTree(tree, MAIN_DIR).map((f) => `${f.file} ${f.form} ${f.via} ${f.node}`);
      expect(got, label).toEqual(want);
    }
    // The plain-src NEGATIVE needs its twin present in the tree (an in-memory
    // planned sibling, like the head's not-yet-emitted files).
    {
      const tree = withFiles([
        ['backend/ingest/plain-src.ts', "import { x } from './plain-sibling.js';\nexport const y = x;"],
        ['backend/ingest/plain-sibling.ts', 'export const x = 1;\n'],
      ]);
      expect(fmt10(tree), 'NEGATIVE: the twin-named in-tree import resolves to class (a) through its tree key').toEqual([]);
    }

    // --- Filesystem-geometry rows: the critic's VERBATIM geometries on a
    // --- throwaway root (the target files must be observable on disk).
    const probeRoot = makeTempDir('doc-worker-src10-');
    // AMENDED (round 13): keys relative to the PROBE main (treeOfFiles keys relative to MAIN_DIR, which made every probe key '../...' — a latent defect these never-at-base rows could not reveal).
    const walkProbeMain = (mainDir: string): Map<string, string> =>
      new Map(listTsFiles(mainDir).map((file) => [path.relative(mainDir, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const));
    const writeIf = (p: string, text: string): void => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    const nativeAddon = path.resolve(MAIN_DIR, '..', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
    const nativeBytes = fs.existsSync(nativeAddon) ? fs.readFileSync(nativeAddon) : Buffer.from('<native-binary>');

    // Probe 1 (the critic's VERBATIM geometry): require('./workbook-parser')
    // where main/workbook-parser is an EXACT extensionless file — CommonJS
    // parses it as JavaScript; SOURCE_EXTENSIONS and the walk omit it.
    const extJsMain = path.join(probeRoot, 'extensionless-js', 'main');
    writeIf(path.join(extJsMain, 'probe.cjs'), "const wrapper = require('./workbook-parser');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
    writeIf(path.join(extJsMain, 'workbook-parser'), [
      "const fs = require('fs');",
      "const XLSX = require('xlsx');",
      "exports.resolvedXlsx = require.resolve('xlsx');",
      'exports.parseWorkbook = function parseWorkbook(filePath) {',
      "  const book = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });",
      '  const sheet = book.Sheets[book.SheetNames[0]];',
      '  return { pid: process.pid, cell: sheet.A1.v };',
      '};',
    ].join('\n'));
    const extJsTree = walkProbeMain(extJsMain);
    expect([...extJsTree.keys()], 'the walk lists only the probe file (the extensionless wrapper carries no source extension)').toEqual(['probe.cjs']);
    expect(fmt10(extJsTree, extJsMain), 'round-11 probe 1 -> SRC-10 extensionless (the executable target is in NO class)').toEqual([
      'probe.cjs require() extensionless workbook-parser',
    ]);
    expect(src7FindingsOfTree(extJsTree, extJsMain), 'round-11 gap pinned: SRC-7\' sees NO escape (the extensionless target is in-tree)').toEqual([]);
    expect(src9NodeLoadFindingsOfTree(extJsTree, extJsMain), 'round-11 gap pinned: SRC-9 sees no .node').toEqual([]);

    // Probe 2 (the plan's regression): the same wrapper behind an UNKNOWN
    // extension ('.foo') — CommonJS parses an exact file of any extension as
    // JavaScript; the walk omits it equally.
    const unkMain = path.join(probeRoot, 'unknown-extension', 'main');
    writeIf(path.join(unkMain, 'probe.cjs'), "const wrapper = require('./workbook-parser.foo');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
    writeIf(path.join(unkMain, 'workbook-parser.foo'), "const XLSX = require('xlsx');\nexports.parseWorkbook = () => null;\n");
    const unkTree = walkProbeMain(unkMain);
    expect(fmt10(unkTree, unkMain), 'round-11 regression -> SRC-10 unknown-extension (no-extension and unknown-extension are the same CommonJS rule)').toEqual([
      'probe.cjs require() unknown-extension workbook-parser.foo',
    ]);

    // Probe 3 (the critic's VERBATIM geometry): require('./native-parser')
    // where only native-parser.node exists — Node's LOAD_AS_FILE tries
    // X.node, so the specifier EXECUTES a native binary the source-biased
    // resolver cannot even observe.
    const extNodeMain = path.join(probeRoot, 'extensionless-node', 'main');
    writeIf(path.join(extNodeMain, 'probe.cjs'), "const native = require('./native-parser');\nmodule.exports = { parse: native.parseDocument };\n");
    fs.writeFileSync(path.join(extNodeMain, 'native-parser.node'), nativeBytes);
    const extNodeTree = walkProbeMain(extNodeMain);
    expect(fmt10(extNodeTree, extNodeMain), 'round-11 probe 3 -> SRC-10 extensionless (the .node binary is invisible to SRC7_EXTENSIONLESS; the specifier itself is unclassifiable)').toEqual([
      'probe.cjs require() extensionless native-parser',
    ]);
    expect(src9NodeLoadFindingsOfTree(extNodeTree, extNodeMain), 'round-11 gap pinned: SRC-9 sees NO .node (the candidate lists omit .node — the exact critic evidence)').toEqual([]);
    expect(src7FindingsOfTree(extNodeTree, extNodeMain), 'round-11 gap pinned: SRC-7\' sees no escape (in-tree)').toEqual([]);

    // Probe 4 (the critic's VERBATIM geometry): require('./container') with
    // only container/index.node — LOAD_AS_INDEX includes index.node.
    const indexNodeMain = path.join(probeRoot, 'index-node', 'main');
    writeIf(path.join(indexNodeMain, 'probe.cjs'), "const native = require('./container');\nmodule.exports = { parse: native.parseDocument };\n");
    fs.mkdirSync(path.join(indexNodeMain, 'container'), { recursive: true });
    fs.writeFileSync(path.join(indexNodeMain, 'container', 'index.node'), nativeBytes);
    const indexNodeTree = walkProbeMain(indexNodeMain);
    expect(fmt10bDir(indexNodeTree, indexNodeMain), 'round-11 probe 4 -> SRC-10b (ii) unresolved-directory (index.node is not an index SRC-7\' knows)').toEqual([
      'probe.cjs require() unresolved-directory container',
    ]);
    expect(fmt10(indexNodeTree, indexNodeMain), 'round-11 probe 4 -> SRC-10 directory-load too (the gate fails the whole channel)').toEqual([
      'probe.cjs require() directory-load container',
    ]);
    expect(src9NodeLoadFindingsOfTree(indexNodeTree, indexNodeMain), 'round-11 gap pinned: SRC-9 sees NO .node (index.node never becomes a target)').toEqual([]);

    // Probe 5 (the critic's VERBATIM geometry): the nested package.json
    // self-reference — main/package.json names better-sqlite3 and exports
    // './addon' to a LOCAL .node; the bare, ALLOWED spelling
    // 'better-sqlite3/addon' then executes the local addon.
    const selfMain = path.join(probeRoot, 'self-reference', 'main');
    writeIf(path.join(selfMain, 'probe.cjs'), "const native = require('better-sqlite3/addon');\nmodule.exports = { parse: native.parseDocument };\n");
    writeIf(path.join(selfMain, 'package.json'), JSON.stringify({ name: 'better-sqlite3', private: true, type: 'commonjs', exports: { './addon': './native-parser.node' } }));
    fs.writeFileSync(path.join(selfMain, 'native-parser.node'), nativeBytes);
    const selfTree = walkProbeMain(selfMain);
    expect(src10bPackageJsonFindingsOf(selfMain), 'round-11 probe 5 -> SRC-10b (i): ANY package.json under desktop/main is a finding, before any load exists').toEqual([
      { file: 'package.json' },
    ]);
    expect(
      fmt10(selfTree, selfMain),
      "round-11 route now ALSO caught by SRC-10' (round 12): 'better-sqlite3/addon' resolves NOWHERE on the walk-up (no node_modules root supplies the subpath), so the allowed spelling is package-unresolved — round 11 pinned this row as the gap (SRC-10 passed the bare spelling as class (b)); SRC-10b (i) still catches the nested manifest independently",
    ).toEqual(['probe.cjs require() package-unresolved better-sqlite3']);
    expect(
      src10NodeFindingsOfTree(selfTree, selfMain).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`),
      "round-11 route under SRC-10'' (round 13): NODE ITSELF self-resolves 'better-sqlite3/addon' through the nested manifest to the LOCAL main/native-parser.node — a target under NO node_modules root, so the derived-root gate refuses it (still red, now on Node's own answer)",
    ).toEqual(['probe.cjs require() package-root-outside-tree main/native-parser.node']);
    expect(src6FindingsOfTree(selfTree).filter((f) => f.kind === 'UNCLASSIFIED' || f.kind === 'PARSER-OUTSIDE-ALLOWED'), 'round-11 gap pinned: SRC-6 accepts the better-sqlite3 spelling entirely (no UNCLASSIFIED, no out-of-allowed-site row)').toEqual([]);
    expect(src7PackageJsonFindingsOf(selfMain), 'round-11 gap pinned: the OLD nested-manifest rule passes (the exports target stays IN-TREE — containment, not execution type)').toEqual([]);
    expect(src9NodeLoadFindingsOfTree(selfTree, selfMain), 'round-11 gap pinned: SRC-9 never resolves the bare specifier').toEqual([]);

    // Probe 6: a directory package.json whose main routes to a .wasm binary
    // (the SRC-10c 'target' channel, beside the specifier channel).
    const dirWasmMain = path.join(probeRoot, 'directory-wasm', 'main');
    writeIf(path.join(dirWasmMain, 'probe.cjs'), "const run = require('./container');\nmodule.exports = { answer: () => run() };\n");
    writeIf(path.join(dirWasmMain, 'container', 'package.json'), JSON.stringify({ main: './answer.wasm' }));
    fs.writeFileSync(path.join(dirWasmMain, 'container', 'answer.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const dirWasmTree = walkProbeMain(dirWasmMain);
    expect(fmt10c(dirWasmTree, dirWasmMain), 'a directory-resolved .wasm target is an SRC-10c finding (via target)').toEqual([
      'probe.cjs require() target container/answer.wasm',
    ]);
    expect(src10bPackageJsonFindingsOf(dirWasmMain), 'the routing manifest is an SRC-10b (i) finding too').toEqual([
      { file: 'container/package.json' },
    ]);

    // NEGATIVE: a .json data file that NOTHING loads (the graphify-cache
    // shape): the walk never enumerates it, no load site names it, SRC-10b
    // (i) looks only for package.json — no finding of any kind.
    const idleJsonMain = path.join(probeRoot, 'idle-json', 'main');
    writeIf(path.join(idleJsonMain, 'probe.ts'), "export const v = 1;\n");
    writeIf(path.join(idleJsonMain, 'graphify-out', 'cache', 'stat-index.json'), JSON.stringify({ a: 1 }));
    const idleJsonTree = walkProbeMain(idleJsonMain);
    expect([...idleJsonTree.keys()], 'the unloaded .json cache is NOT enumerated (no source extension)').toEqual(['probe.ts']);
    expect(fmt10(idleJsonTree, idleJsonMain), 'NEGATIVE: an unloaded .json tool cache is never a load target and produces NO finding').toEqual([]);
    expect(src10bPackageJsonFindingsOf(idleJsonMain), 'NEGATIVE: the .json cache is not a package.json').toEqual([]);

    // NEGATIVES: the base tree and a simulated post-fix tree (planned files
    // with resolvable twin edges, both on disk and in-tree-only) stay green.
    expect(fmt10(baseTree), 'NEGATIVE: the base tree classifies every load (source/package/builtin; allowlists empty)').toEqual([]);
    expect(fmt10bDir(baseTree), 'NEGATIVE: the base tree has no directory load').toEqual([]);
    expect(fmt10bSelf(baseTree), 'NEGATIVE: the base tree has no self-reference specifier').toEqual([]);
    expect(fmt10c(baseTree), 'NEGATIVE: the base tree has no .wasm load').toEqual([]);
    const headTree = new Map(baseTree);
    headTree.set(DOC_CHILD_RELATIVE, (baseTree.get(XLSX_CHILD_RELATIVE) ?? '')
      .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'DOC_WORKER_ERROR_PREFIX')
      .replaceAll('runXlsxChildMain', 'runDocChildMain'));
    headTree.set('backend/ingest/plain-head.ts', "import { x } from './plain-head-sibling.js';\nexport const y = x;");
    headTree.set('backend/ingest/plain-head-sibling.ts', 'export const x = 1;\n');
    expect(fmt10(headTree), 'NEGATIVE: the simulated post-fix tree classifies every load (the not-yet-emitted twins count through their tree keys)').toEqual([]);
    expect(fmt10bDir(headTree), 'NEGATIVE: the head shape adds no directory load').toEqual([]);
    expect(fmt10bSelf(headTree), 'NEGATIVE: the head shape adds no self-reference').toEqual([]);
    expect(fmt10c(headTree), 'NEGATIVE: the head shape adds no .wasm load').toEqual([]);
  });

  it("S1 self-test (round-12 probes / SRC-10'): the nested node_modules shadow, the manifest-less index.node package and the NODE_PATH subpath turn the tree red", { timeout: 300_000 }, () => {
    // The plan critic's round-12 probes (repro/critic-round12-probes.mjs —
    // before amendment (z3) every one of the 23 layers plus the three walks
    // was EMPTY on these geometries; critic-round12-probes.out lines 13-37):
    // `require('better-sqlite3')` with main/node_modules/better-sqlite3 an
    // exact EXTENSIONLESS wrapper FILE parsed CANONICAL
    // desktop/node_modules/xlsx/xlsx.js in the consumer/main PID on Node,
    // Electron-as-Node and a REAL Electron 45.2.1 main process (LOAD_AS_FILE
    // runs before LOAD_AS_DIRECTORY); a manifest-less
    // main/node_modules/better-sqlite3/ directory with only index.node
    // executed native SQL ({answer:42}) in the calling PID on all three
    // runtimes (LOAD_INDEX needs no package.json); and
    // `require('ajv-formats/addon')` — an allowed name with no installed
    // subpath — fell through every parent node_modules candidate to
    // NODE_PATH and parsed canonical xlsx on Node and Electron-as-Node while
    // real Electron main REJECTED the specifier (recorded honestly: a
    // Node-side hole, not a third real-Electron escape). The probe roots sit
    // UNDER DESKTOP (a throwaway dot-directory) so the walk-up really
    // traverses desktop/node_modules — the runtime legs of the critic's
    // proof ran on exactly that geometry.
    const fmt10 = (tree: ReadonlyMap<string, string>, mainDir: string): string[] =>
      src10FindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`);
    const probeRoot = fs.mkdtempSync(path.join(path.resolve(MAIN_DIR, '..'), '.i320-src10p-'));
    tempDirs.push(probeRoot);
    // AMENDED (round 13): keys relative to the PROBE main (treeOfFiles keys relative to MAIN_DIR, which made every probe key '../...' — a latent defect these never-at-base rows could not reveal).
    const walkProbeMain = (mainDir: string): Map<string, string> =>
      new Map(listTsFiles(mainDir).map((file) => [path.relative(mainDir, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const));
    const writeIf = (p: string, text: string): void => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    const nativeAddon = path.resolve(MAIN_DIR, '..', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
    const nativeBytes = fs.existsSync(nativeAddon) ? fs.readFileSync(nativeAddon) : Buffer.from('<native-binary>');
    /** The critic's extensionless canonical-xlsx wrapper, VERBATIM (parserWrapper of repro/critic-round12-probes.mjs). */
    const parserWrapper = () => [
      "const fs = require('fs');",
      "const XLSX = require('xlsx');",
      "exports.resolvedXlsx = require.resolve('xlsx');",
      'exports.parseWorkbook = function parseWorkbook(filePath) {',
      "  const book = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });",
      '  const sheet = book.Sheets[book.SheetNames[0]];',
      '  return { pid: process.pid, cell: sheet.A1.v };',
      '};',
    ].join('\n');
    /** The classifier outcome of one specifier in a probe main (pinned exactly). */
    const classifyIn = (tree: ReadonlyMap<string, string>, mainDir: string, specifier: string): Src10Classification => {
      const sites = [...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel));
      const site = sites.find((s) => s.specifier === specifier);
      if (site === undefined) throw new Error(`probe load inventory missed ${specifier}`);
      return src10ClassifySite(site, src10ScanSetOf(tree, mainDir), mainDir);
    };
    /** Round-12 gap pin: on these package geometries EVERY rule that existed before SRC-10' stays green (the critic's zero-finding result), so only the resolved-package branch fires. */
    const preRound13RulesEmpty = (tree: ReadonlyMap<string, string>, mainDir: string): void => {
      expect(src10FindingsOfTree(tree, mainDir).every((f) => f.kind.startsWith('package-') || f.kind === 'json-outside-allowlist'), 'gap pin: every SRC-10 finding is an SRC-10\' package kind (no local-target kind fires)').toBe(true);
      expect(src10bDirectoryLoadFindingsOfTree(tree, mainDir), 'gap pin: SRC-10b (ii) sees no LOCAL directory load (the specifier is a bare package name)').toEqual([]);
      expect(src10bSelfReferenceFindingsOfTree(tree), 'gap pin: SRC-10b (iii) sees no self-reference').toEqual([]);
      expect(src10cWasmLoadFindingsOfTree(tree, mainDir), 'gap pin: SRC-10c sees no .wasm').toEqual([]);
      expect(src9NodeLoadFindingsOfTree(tree, mainDir), 'gap pin: SRC-9 never resolves a bare package specifier (index.node stays invisible to it)').toEqual([]);
      expect(src7FindingsOfTree(tree, mainDir), 'gap pin: SRC-7\' sees no local edge escape').toEqual([]);
      expect(src7LinkFindingsOf(mainDir), 'gap pin: no links').toEqual([]);
      expect(src7PackageJsonFindingsOf(mainDir), 'gap pin: no nested-manifest target leaves the probe root').toEqual([]);
    };

    // NEW 1 (the critic's VERBATIM geometry): main/node_modules/better-sqlite3
    // is an exact EXTENSIONLESS FILE — LOAD_AS_FILE(DIR/X) selects it and
    // CommonJS runs it as JavaScript while the walk never scans it.
    const shadowMain = path.join(probeRoot, 'shadow-root', 'main');
    writeIf(path.join(shadowMain, 'probe.cjs'), "const wrapper = require('better-sqlite3');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
    const shadowTarget = path.join(shadowMain, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(path.dirname(shadowTarget), { recursive: true });
    fs.writeFileSync(shadowTarget, parserWrapper());
    const shadowTree = walkProbeMain(shadowMain);
    expect([...shadowTree.keys()], 'the walk lists only the probe file (the extensionless package shadow carries no source extension)').toEqual(['probe.cjs']);
    expect(fmt10(shadowTree, shadowMain), "round-12 escape 1 -> SRC-10' package-root-outside-tree (the resolved root is the nested shadow FILE, not desktop/node_modules/better-sqlite3)").toEqual([
      'probe.cjs require() package-root-outside-tree main/node_modules/better-sqlite3',
    ]);
    expect(classifyIn(shadowTree, shadowMain, 'better-sqlite3'), 'the classifier refuses the allowed spelling whose resolved root is the nested shadow').toEqual({ cls: 'package-root-outside-tree', detail: 'main/node_modules/better-sqlite3' });
    preRound13RulesEmpty(shadowTree, shadowMain);
    expect(src10NodeFindingsOfTree(shadowTree, shadowMain).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`), "round-12 escape 1 under SRC-10'' (round 13): NODE ITSELF resolves the nested shadow FILE; its derived root is not canonical — still red on Node's own answer").toEqual([
      'probe.cjs require() package-root-outside-tree main/node_modules/better-sqlite3',
    ]);
    expect(src10bPackageJsonFindingsOf(shadowMain), 'gap pin: SRC-10b (i) sees no package.json (the shadow needs no manifest)').toEqual([]);
    expect(
      src6FindingsOfTree(shadowTree).filter((f) => f.kind === 'UNCLASSIFIED' || f.kind === 'PARSER-OUTSIDE-ALLOWED'),
      'gap pin: SRC-6 accepts the better-sqlite3 spelling entirely (name classification is not target classification)',
    ).toEqual([]);

    // NEW 2 (the critic's VERBATIM geometry): a manifest-less
    // main/node_modules/better-sqlite3/ directory whose only file is
    // index.node — LOAD_AS_DIRECTORY falls through to LOAD_INDEX, whose
    // third candidate is index.node.
    const folderMain = path.join(probeRoot, 'index-node-root', 'main');
    writeIf(path.join(folderMain, 'probe.cjs'), "const native = require('better-sqlite3');\nmodule.exports = { parse: native.parseDocument };\n");
    fs.mkdirSync(path.join(folderMain, 'node_modules', 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(folderMain, 'node_modules', 'better-sqlite3', 'index.node'), nativeBytes);
    const folderTree = walkProbeMain(folderMain);
    expect(fmt10(folderTree, folderMain), "round-12 escape 2 -> SRC-10' package-manifest-less (a package directory with NO manifest resolving index.node — Node would load the native addon)").toEqual([
      'probe.cjs require() package-manifest-less main/node_modules/better-sqlite3',
    ]);
    expect(classifyIn(folderTree, folderMain, 'better-sqlite3'), 'the classifier refuses the manifest-less package directory').toEqual({ cls: 'package-manifest-less', detail: 'main/node_modules/better-sqlite3' });
    preRound13RulesEmpty(folderTree, folderMain);
    expect(src10NodeFindingsOfTree(folderTree, folderMain).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`), "round-12 escape 2 under SRC-10'' (round 13): NODE ITSELF lands on main/node_modules/better-sqlite3/index.node; the derived root is not canonical — still red on Node's own answer").toEqual([
      'probe.cjs require() package-root-outside-tree main/node_modules/better-sqlite3',
    ]);
    expect(src10bPackageJsonFindingsOf(folderMain), 'gap pin: SRC-10b (i) sees no package.json (the route needs no manifest — exactly the critic\'s point)').toEqual([]);

    // NEW 3 (the critic's VERBATIM geometry): 'ajv-formats/addon' — an
    // allowed package name with NO installed subpath. desktop/node_modules/
    // ajv-formats has no exports map and no 'addon' file, so the walk-up
    // fails everywhere; with NODE_PATH set, the emulator's FINAL candidate
    // set supplies it from OUTSIDE desktop/node_modules and is refused
    // (without NODE_PATH the load is simply package-unresolved). Real
    // Electron main rejects this route's specifier — recorded honestly.
    const nodePathMain = path.join(probeRoot, 'node-path-root', 'main');
    writeIf(path.join(nodePathMain, 'probe.cjs'), "const wrapper = require('ajv-formats/addon');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
    const nodePathDir = path.join(probeRoot, 'global-node-path');
    const nodePathTarget = path.join(nodePathDir, 'ajv-formats', 'addon');
    fs.mkdirSync(path.dirname(nodePathTarget), { recursive: true });
    fs.writeFileSync(nodePathTarget, parserWrapper());
    const nodePathTree = walkProbeMain(nodePathMain);
    const previousNodePath = process.env.NODE_PATH;
    try {
      delete process.env.NODE_PATH;
      expect(fmt10(nodePathTree, nodePathMain), "round-12 escape 3 (NODE_PATH unset) -> SRC-10' package-unresolved: no walk-up candidate supplies the subpath (at runtime Node falls through to NODE_PATH, which no in-tree root can police)").toEqual([
        'probe.cjs require() package-unresolved ajv-formats',
      ]);
      expect(classifyIn(nodePathTree, nodePathMain, 'ajv-formats/addon')).toEqual({ cls: 'package-unresolved', detail: 'ajv-formats' });
      expect(src10NodeFindingsOfTree(nodePathTree, nodePathMain).map((f) => `${f.file} ${f.form} ${f.kind}`), "round-12 escape 3 (NODE_PATH unset) under SRC-10'' (round 13): NODE ITSELF cannot resolve 'ajv-formats/addon' — unresolvable is a finding (fail closed)").toEqual([
        'probe.cjs require() package-unresolved',
      ]);
      process.env.NODE_PATH = nodePathDir;
      expect(fmt10(nodePathTree, nodePathMain), 'round-12 escape 3 (NODE_PATH set) -> SRC-10\' package-root-node-path: the emulator models NODE_PATH as the final candidate set and REFUSES it (outside desktop/node_modules)').toEqual([
        'probe.cjs require() package-root-node-path ../global-node-path/ajv-formats',
      ]);
      expect(classifyIn(nodePathTree, nodePathMain, 'ajv-formats/addon')).toEqual({ cls: 'package-root-node-path', detail: '../global-node-path/ajv-formats' });
      expect(src10NodeFindingsOfTree(nodePathTree, nodePathMain).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`), "round-12 escape 3 (NODE_PATH set) under SRC-10'' (round 13): the child INHERITS NODE_PATH, so NODE ITSELF resolves the external wrapper — a target under NO node_modules root, refused by the derived-root gate").toEqual([
        'probe.cjs require() package-root-outside-tree ../global-node-path/ajv-formats/addon',
      ]);
      preRound13RulesEmpty(nodePathTree, nodePathMain);
      expect(src10bPackageJsonFindingsOf(nodePathMain), 'gap pin: no package.json under the probe main').toEqual([]);
    } finally {
      if (previousNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = previousNodePath;
    }

    // NEGATIVES over the base and simulated post-fix trees under SRC-10':
    // every base/head package load resolves to its canonical root and an
    // in-root .js/.mjs/.cjs/.json file, so both trees stay green.
    const baseTree = treeOfFiles(listTsFiles(MAIN_DIR));
    const basePackageRows = src10PackageResolutionsOfSites(loadSitesOf(listTsFiles(MAIN_DIR)), MAIN_DIR);
    expect(basePackageRows.length, 'amendment (z9): the tree really resolves a non-trivial package set (27 load sites at base 5d1f7338; 26 on the planned head — extractors loses its 4 in-main parser loads, the doc child adds 3; absent-OR-exact like every planned-head leg)').toBe(expectedPackageRowCount());
    expect(basePackageRows.every((r) => r.via === 'resolved'), 'NEGATIVE: every base package load resolves (no NODE_PATH candidate, nothing unresolved)').toBe(true);
    expect(new Set(basePackageRows.map((r) => r.root)), 'NEGATIVE: every base package load resolves to its CANONICAL desktop/node_modules root (the eleven classified packages)').toEqual(
      new Set(Object.keys(THIRD_PARTY_PACKAGE_CLASSIFICATION).map((name) => `node_modules/${name}`)),
    );
    expect(basePackageRows.filter((r) => r.name === 'xlsx').every((r) => r.root === 'node_modules/xlsx'), 'NEGATIVE: the file: TARBALL xlsx resolves to the canonical directory (a tarball install materialises under desktop/node_modules)').toBe(true);
    expect(fmt10(baseTree, MAIN_DIR), "NEGATIVE: the base tree stays green under SRC-10'").toEqual([]);
    const headTree = new Map(baseTree);
    headTree.set(DOC_CHILD_RELATIVE, (baseTree.get(XLSX_CHILD_RELATIVE) ?? '')
      .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'DOC_WORKER_ERROR_PREFIX')
      .replaceAll('runXlsxChildMain', 'runDocChildMain'));
    expect(fmt10(headTree, MAIN_DIR), "NEGATIVE: the simulated post-fix tree stays green under SRC-10' (the children load their classified parsers from the canonical roots)").toEqual([]);
    expect(
      src10FindingsOfTree(shadowTree, shadowMain).length > 0 && src10FindingsOfTree(folderTree, folderMain).length > 0,
      'anti-vacuity: the two real-Electron escape geometries really turn the tree red',
    ).toBe(true);
  });

  it("S1 self-test (round-13 probes / SRC-10''): the inner node_modules subpath, node-addons condition, condition key order and pattern trailer routes turn the tree red — each shown as an emulator-vs-Node disagreement", { timeout: 300_000 }, () => {
    // The plan critic's round-13 probes (repro/critic-round13-probes.mjs,
    // critic-round13-resolution.mjs — before amendment (z4) every one of
    // the 23 layers plus the three walks was EMPTY on these geometries;
    // critic-round13-resolution.out:32-62 and
    // critic-round13-inner-node-modules.out:38-47):
    //   (1) `require('ajv-formats/node_modules/ajv')` — Node treats
    //       ajv-formats as the package and node_modules/ajv as its SUBPATH;
    //       an exact extensionless wrapper at
    //       main/node_modules/ajv-formats/node_modules/ajv loaded CANONICAL
    //       xlsx in the consumer/main PID on Node, Electron-as-Node and a
    //       REAL Electron 45.2.1 main while SRC-10' re-cut the specifier to
    //       canonical ajv and awarded class (b);
    //   (2) canonical-root better-sqlite3 exports
    //       {'.':{'node-addons':'./evil.node',node:'./safe.cjs'}} — Node's
    //       ACTIVE node-addons condition selects evil.node (native SQL
    //       {answer:42} in the calling PID on all three runtimes) while the
    //       emulator's condition table omitted node-addons and approved
    //       safe.cjs;
    //   (3) {'.':{require:'./evil.node',node:'./safe.cjs'}} — Node picks the
    //       FIRST matching key of the ACTIVE set in MANIFEST order (require
    //       before node) and loads the native addon; the emulator's fixed
    //       node-first preference approved safe.cjs;
    //   (4) equal-fixed-prefix patterns './features/*' -> ./safe/*.cjs and
    //       './features/*.js' -> ./evil/*.node — Node's pattern comparator
    //       considers the TRAILER and selects evil/foo.node for
    //       better-sqlite3/features/foo.js; the emulator compared only
    //       fixed-prefix length and kept the first .cjs pattern.
    // Every row is now caught because NODE ITSELF resolves to the .node /
    // wrapper target (or the inner-node_modules ban fires first), and each
    // row prints the emulator-vs-Node DISAGREEMENT that made the
    // pre-amendment gate green.
    //
    // SRC-10'' runs against REAL node_modules trees: the four adversarial
    // rows build THROWAWAY probe trees under a temp root (dot-directory
    // under the system temp dir, with a node_modules seeded from the
    // installed packages each row needs), so Node really resolves the
    // adversarial layout the critic built; the negatives re-resolve the
    // REAL base and simulated post-fix trees.
    const fmt10n = (tree: ReadonlyMap<string, string>, mainDir: string): string[] =>
      src10NodeFindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`);
    const classifyIn = (tree: ReadonlyMap<string, string>, mainDir: string, specifier: string): Src10Classification => {
      const sites = [...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel));
      const site = sites.find((s) => s.specifier === specifier);
      if (site === undefined) throw new Error(`probe load inventory missed ${specifier}`);
      const batch = src10NodeResolutionsOfSites(sites, mainDir);
      return src10ClassifySite(site, src10ScanSetOf(tree, mainDir), mainDir, batch);
    };
    /** The emulator-vs-Node disagreement row for one probe site (the pre-amendment green the critic exploited). */
    const disagreementOf = (tree: ReadonlyMap<string, string>, mainDir: string, specifier: string): { emulated: string; node: string; agrees: boolean } => {
      const sites = [...tree].flatMap(([rel, source]) => loadSitesInSource(source, rel));
      const site = sites.find((s) => s.specifier === specifier);
      if (site === undefined) throw new Error(`probe load inventory missed ${specifier}`);
      const batch = src10NodeResolutionsOfSites(sites, mainDir);
      const node = batch.get(`${src10SiteMode(site.form, site.file, mainDir)}\u0000${site.file}\u0000${site.specifier}`);
      if (node === undefined) throw new Error(`SRC-10'' batch missed ${specifier}`);
      const emu = resolveBarePackageTarget(site.file, site.specifier, mainDir, site.form);
      return {
        emulated: emu.target === null ? '<unresolved>' : emu.target,
        node: node.target === '' ? `<node-error: ${node.error}>` : node.target,
        agrees: node.agrees,
      };
    };

    // --- The four critic round-13 probes on throwaway trees ---
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i320-src10r13-'));
    tempDirs.push(probeRoot);
    /** A tree whose KEYS are relative to the PROBE main (not MAIN_DIR). */
    const probeTreeOf = (mainDir: string): Map<string, string> =>
      new Map(listTsFiles(mainDir).map((file) => [path.relative(mainDir, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const));
    const writeIf = (p: string, text: string): void => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    const canonicalNative = path.resolve(MAIN_DIR, '..', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
    const nativeBytes = fs.existsSync(canonicalNative) ? fs.readFileSync(canonicalNative) : Buffer.from('<native-binary>');
    /** Seed a probe node_modules with a real manifest at <root>/node_modules/<name>. */
    const seedManifest = (root: string, name: string, manifest: Record<string, unknown>): string => {
      const pkgDir = path.join(root, 'node_modules', ...name.split('/'));
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, ...manifest }));
      return pkgDir;
    };
    /** The critic's extensionless canonical-xlsx wrapper (repro/critic-round13-resolution.mjs parserWrapper). */
    const parserWrapper = () => [
      "const fs = require('fs');",
      `const XLSX = require(${JSON.stringify(path.resolve(MAIN_DIR, '..', 'node_modules', 'xlsx'))});`,
      `exports.resolvedXlsx = require.resolve(${JSON.stringify(path.resolve(MAIN_DIR, '..', 'node_modules', 'xlsx'))});`,
      'exports.parseWorkbook = function parseWorkbook(filePath) {',
      "  const book = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });",
      '  const sheet = book.Sheets[book.SheetNames[0]];',
      '  return { pid: process.pid, cell: sheet.A1.v };',
      '};',
    ].join('\n');

    // PROBE 1 — inner node_modules subpath escape (the no-manifest route,
    // critic-round13-resolution.mjs 'inner-node-modules-specifier'): the
    // inner-node_modules ban (z5) fires BEFORE resolution, and Node itself
    // resolves the specifier to the nested wrapper (shown in the row).
    // The probe seeds CANONICAL ajv beside ajv-formats exactly as the
    // critic did, so the emulator's mis-cut lands on the benign canonical
    // dist/ajv.js while Node loads the nested wrapper.
    {
      const root = path.join(probeRoot, 'inner-node-modules', 'desktop');
      const mainDir = path.join(root, 'main');
      writeIf(path.join(root, 'package.json'), JSON.stringify({ name: 'r13-inner-node-modules', private: true, type: 'commonjs' }));
      const ajvFormats = seedManifest(root, 'ajv-formats', { main: 'dist/index.js' });
      writeIf(path.join(ajvFormats, 'dist', 'index.js'), 'module.exports = {};\n');
      const canonicalAjv = seedManifest(root, 'ajv', { main: 'dist/ajv.js' });
      writeIf(path.join(canonicalAjv, 'dist', 'ajv.js'), 'module.exports = { benign: true };\n');
      const nested = path.join(ajvFormats, 'node_modules', 'ajv');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'ajv', main: 'index.js' }));
      fs.writeFileSync(path.join(nested, 'index.js'), parserWrapper());
      writeIf(path.join(mainDir, 'probe.cjs'), "const wrapper = require('ajv-formats/node_modules/ajv');\nmodule.exports = { parse: wrapper.parseWorkbook };\n");
      const tree = probeTreeOf(mainDir);
      expect(src10FindingsOfTree(tree, mainDir), "round-13 route 1 gap pinned: the pre-round-14 EMULATOR gate (no Node batch) is EMPTY on this geometry — the critic's zero-finding result").toEqual([]);
      expect(fmt10n(tree, mainDir), "round-13 route 1 -> SRC-10'' package-inner-node-modules: the ban fires before any resolution (Node would treat node_modules/ajv as a SUBPATH of ajv-formats and load the nested wrapper; the emulator re-cut it to canonical ajv)").toEqual([
        'probe.cjs require() package-inner-node-modules ajv-formats/node_modules/ajv',
      ]);
      expect(classifyIn(tree, mainDir, 'ajv-formats/node_modules/ajv'), 'the classifier refuses the inner-node_modules specifier outright').toEqual({ cls: 'package-inner-node-modules', detail: 'ajv-formats/node_modules/ajv' });
      const d = disagreementOf(tree, mainDir, 'ajv-formats/node_modules/ajv');
      console.log('R14-PROBE inner-node_modules-subpath disagreement', JSON.stringify(d));
      expect(d.agrees, 'anti-vacuity: the EMULATOR and NODE really disagree on this specifier (the emulator resolved canonical ajv; Node resolves the nested wrapper) — the disagreement that kept every pre-round-14 layer green').toBe(false);
      expect(d.node.replace(/\\/g, '/').endsWith('node_modules/ajv-formats/node_modules/ajv/index.js'), 'Node resolves the NESTED wrapper (package ajv-formats, subpath node_modules/ajv)').toBe(true);
      expect(d.emulated.replace(/\\/g, '/').endsWith('node_modules/ajv/dist/ajv.js'), 'the emulator re-cut the specifier to CANONICAL ajv').toBe(true);
    }

    // PROBE 2 — the node-addons condition (critic-round13-resolution.mjs
    // 'node-addons-condition'): Node's ACTIVE condition selects evil.node;
    // the emulator's table omitted node-addons and approved safe.cjs.
    {
      const root = path.join(probeRoot, 'node-addons-condition', 'desktop');
      const mainDir = path.join(root, 'main');
      writeIf(path.join(root, 'package.json'), JSON.stringify({ name: 'r13-node-addons', private: true, type: 'commonjs' }));
      const pkgDir = seedManifest(root, 'better-sqlite3', { exports: { '.': { 'node-addons': './evil.node', node: './safe.cjs' } } });
      writeIf(path.join(pkgDir, 'safe.cjs'), 'module.exports = { benign: true };\n');
      fs.writeFileSync(path.join(pkgDir, 'evil.node'), nativeBytes);
      writeIf(path.join(mainDir, 'probe.cjs'), "const native = require('better-sqlite3');\nmodule.exports = { parse: native.parseDocument };\n");
      const tree = probeTreeOf(mainDir);
      expect(src10FindingsOfTree(tree, mainDir), "round-13 route 2 gap pinned: the pre-round-14 EMULATOR gate (no Node batch) is EMPTY on this geometry — the critic's zero-finding result").toEqual([]);
      expect(fmt10n(tree, mainDir), "round-13 route 2 -> SRC-10'' native-binary: NODE ITSELF resolves the ACTIVE node-addons condition's evil.node (the emulator approved safe.cjs)").toEqual([
        'probe.cjs require() native-binary node_modules/better-sqlite3/evil.node',
      ]);
      expect(classifyIn(tree, mainDir, 'better-sqlite3'), 'the classifier re-applies the .node gate to NODE\'S target').toEqual({ cls: 'native-binary', detail: 'node_modules/better-sqlite3/evil.node' });
      const d = disagreementOf(tree, mainDir, 'better-sqlite3');
      console.log('R14-PROBE node-addons-condition disagreement', JSON.stringify(d));
      expect(d.agrees, 'anti-vacuity: emulator (safe.cjs) vs Node (evil.node) disagree').toBe(false);
      expect(path.basename(d.node), "Node's target is the native addon").toBe('evil.node');
      expect(path.basename(d.emulated), "the emulator's target is the benign fallback").toBe('safe.cjs');
    }

    // PROBE 3 — condition manifest-order (critic-round13-resolution.mjs
    // 'condition-key-order'): require before node in MANIFEST order wins.
    {
      const root = path.join(probeRoot, 'condition-key-order', 'desktop');
      const mainDir = path.join(root, 'main');
      writeIf(path.join(root, 'package.json'), JSON.stringify({ name: 'r13-key-order', private: true, type: 'commonjs' }));
      const pkgDir = seedManifest(root, 'better-sqlite3', { exports: { '.': { require: './evil.node', node: './safe.cjs' } } });
      writeIf(path.join(pkgDir, 'safe.cjs'), 'module.exports = { benign: true };\n');
      fs.writeFileSync(path.join(pkgDir, 'evil.node'), nativeBytes);
      writeIf(path.join(mainDir, 'probe.cjs'), "const native = require('better-sqlite3');\nmodule.exports = { parse: native.parseDocument };\n");
      const tree = probeTreeOf(mainDir);
      expect(src10FindingsOfTree(tree, mainDir), "round-13 route 3 gap pinned: the pre-round-14 EMULATOR gate (no Node batch) is EMPTY on this geometry — the critic's zero-finding result").toEqual([]);
      expect(fmt10n(tree, mainDir), "round-13 route 3 -> SRC-10'' native-binary: NODE'S manifest-order selection loads evil.node (require precedes node; the emulator's fixed node-first preference approved safe.cjs)").toEqual([
        'probe.cjs require() native-binary node_modules/better-sqlite3/evil.node',
      ]);
      const d = disagreementOf(tree, mainDir, 'better-sqlite3');
      console.log('R14-PROBE condition-key-order disagreement', JSON.stringify(d));
      expect(d.agrees, 'anti-vacuity: emulator (safe.cjs) vs Node (evil.node) disagree').toBe(false);
      expect(path.basename(d.node)).toBe('evil.node');
      expect(path.basename(d.emulated)).toBe('safe.cjs');
    }

    // PROBE 4 — pattern-trailer precedence (critic-round13-resolution.mjs
    // 'pattern-trailer-order'): the trailer-specific .node pattern wins.
    {
      const root = path.join(probeRoot, 'pattern-trailer-order', 'desktop');
      const mainDir = path.join(root, 'main');
      writeIf(path.join(root, 'package.json'), JSON.stringify({ name: 'r13-pattern-trailer', private: true, type: 'commonjs' }));
      const pkgDir = seedManifest(root, 'better-sqlite3', {
        exports: { '.': './base.cjs', './features/*': './safe/*.cjs', './features/*.js': './evil/*.node' },
      });
      writeIf(path.join(pkgDir, 'base.cjs'), 'module.exports = { benign: true };\n');
      writeIf(path.join(pkgDir, 'safe', 'foo.js.cjs'), 'module.exports = { benign: true };\n');
      writeIf(path.join(pkgDir, 'evil', 'foo.node'), nativeBytes);
      writeIf(path.join(mainDir, 'probe.cjs'), "const native = require('better-sqlite3/features/foo.js');\nmodule.exports = { parse: native.parseDocument };\n");
      const tree = probeTreeOf(mainDir);
      expect(src10FindingsOfTree(tree, mainDir), "round-13 route 4 gap pinned: the pre-round-14 EMULATOR gate (no Node batch) is EMPTY on this geometry — the critic's zero-finding result").toEqual([]);
      expect(fmt10n(tree, mainDir), "round-13 route 4 -> SRC-10'' native-binary: NODE'S trailer-aware pattern comparator selects evil/foo.node (the emulator kept the first .cjs pattern)").toEqual([
        'probe.cjs require() native-binary node_modules/better-sqlite3/evil/foo.node',
      ]);
      const d = disagreementOf(tree, mainDir, 'better-sqlite3/features/foo.js');
      console.log('R14-PROBE pattern-trailer-order disagreement', JSON.stringify(d));
      expect(d.agrees, 'anti-vacuity: emulator (safe/foo.js.cjs) vs Node (evil/foo.node) disagree').toBe(false);
      expect(d.node.replace(/\\/g, '/').endsWith('evil/foo.node')).toBe(true);
      expect(d.emulated.replace(/\\/g, '/').endsWith('safe/foo.js.cjs')).toBe(true);
    }

    // --- NEGATIVES: the base tree and the simulated post-fix tree stay
    // --- green under SRC-10'' (Node resolves every site; the emulator
    // --- agrees 27/27; Electron-as-Node agrees; the findings are empty).
    {
      const files = listTsFiles(MAIN_DIR);
      const sites = loadSitesOf(files);
      const batch = src10NodeResolutionsOfSites(sites, MAIN_DIR);
      const counts = src10ClassCountsOfSites(sites, src10ScanSetOf(treeOfFiles(files), MAIN_DIR), MAIN_DIR, batch);
      expect(Object.keys(counts).sort(), "NEGATIVE: the base tree takes ONLY pass classes under SRC-10'' (source/package/builtin)").toEqual(['builtin', 'package', 'source']);
      expect(src10FindingsOfSites(sites, src10ScanSetOf(treeOfFiles(files), MAIN_DIR), MAIN_DIR, batch), "NEGATIVE: the base tree stays green under SRC-10''").toEqual([]);
      const headTree = new Map(treeOfFiles(files));
      headTree.set(DOC_CHILD_RELATIVE, (headTree.get(XLSX_CHILD_RELATIVE) ?? '')
        .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'DOC_WORKER_ERROR_PREFIX')
        .replaceAll('runXlsxChildMain', 'runDocChildMain'));
      const headSites = [...headTree].flatMap(([rel, source]) => loadSitesInSource(source, rel));
      expect(src10FindingsOfSites(headSites, src10ScanSetOf(headTree, MAIN_DIR), MAIN_DIR, src10NodeResolutionsOfSites(headSites, MAIN_DIR)), "NEGATIVE: the simulated post-fix tree stays green under SRC-10''").toEqual([]);
    }
  });

  it("S1 self-test (round-14 probe / SRC-10'' amendment z8): a .cts static import is resolved in its EMITTED require mode, so the conditional-exports require target is judged and fails; .mts static and .cts dynamic imports stay ESM", { timeout: 300_000 }, () => {
    // The plan critic's round-14 probe (repro/critic-round14-probes.mjs,
    // workbench 'cts-static-import-mode'; repro/critic-round14-probes.out:
    // 18-27): an ordinary `.cts` main source statically imports
    // '@huggingface/transformers' whose canonical-root manifest carries
    // conditional exports {import: './safe.mjs', require: './evil'} — a
    // benign ES module for the import condition and an EXTENSIONLESS
    // wrapper that loads CANONICAL xlsx for the require condition. Before
    // amendment (z8) src10SiteMode judged the site by its SYNTAX (`import`
    // -> import mode), so NODE ITSELF answered safe.mjs, the gate awarded
    // class (b), and every extracted layer and both walks were EMPTY
    // (:18-19); but TypeScript NodeNext EMITS a `.cts` static import as
    // require(), so the compiled program selected the require condition,
    // loaded the extensionless wrapper and parsed a real workbook in the
    // consumer/main PID on Node, Electron-as-Node and a REAL Electron 45.2.1
    // main (:20-27 — the execution evidence; this spec cannot execute at
    // base). The probe is a DISPOSABLE package layout proving mode
    // fidelity, not a claim that the installed dependency is hostile.
    // Under (z8) the site is asked in the EMITTED mode (require), Node
    // answers the wrapper, and the existing `extensionless` gate turns the
    // tree RED. The `.mts` static import and the `.cts` dynamic import()
    // are ESM-mode controls over the SAME layout (both must stay green on
    // safe.mjs), so the fix does not overcorrect.
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i320-src10r14-'));
    tempDirs.push(probeRoot);
    const writeIf = (p: string, text: string): void => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    /** A tree whose KEYS are relative to the PROBE main (not MAIN_DIR). */
    const probeTreeOf = (mainDir: string): Map<string, string> =>
      new Map(listTsFiles(mainDir).map((file) => [path.relative(mainDir, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const));
    const fmt10n = (tree: ReadonlyMap<string, string>, mainDir: string): string[] =>
      src10NodeFindingsOfTree(tree, mainDir).map((f) => `${f.file} ${f.form} ${f.kind} ${f.detail}`);
    const fold = (p: string): string => src10FoldPath(p);
    const canonicalXlsx = path.resolve(MAIN_DIR, '..', 'node_modules', 'xlsx');
    /** The critic's extensionless canonical-xlsx wrapper (critic-round14-probes.mjs parserWrapper). */
    const parserWrapper = (): string => [
      "const fs = require('fs');",
      `const XLSX = require(${JSON.stringify(canonicalXlsx)});`,
      `exports.resolvedXlsx = require.resolve(${JSON.stringify(canonicalXlsx)});`,
      'exports.parseWorkbook = function parseWorkbook(filePath) {',
      "  const book = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });",
      '  const sheet = book.Sheets[book.SheetNames[0]];',
      '  return { pid: process.pid, cell: sheet.A1.v };',
      '};',
    ].join('\n');
    /** The critic's VERBATIM .cts consumer (critic-round14-probes.mjs ctsConsumer). */
    const ctsConsumer = [
      "import electron from 'electron';",
      "import wrapper from '@huggingface/transformers';",
      'const api = electron as any;',
      'const parser = wrapper as any;',
      "const resolved = require.resolve('@huggingface/transformers');",
      'function execute(): void {',
      '  const value = parser.parseWorkbook(process.env.CRITIC_R14_WORKBOOK);',
      '  const result = { mainPid: process.pid, resolved, resolvedXlsx: parser.resolvedXlsx, value };',
      "  process.stdout.write('R14-CTS ' + JSON.stringify(result) + String.fromCharCode(10), () => {",
      '    if (api.app) api.app.exit(0);',
      '  });',
      '}',
      'if (api.app) {',
      "  api.app.commandLine.appendSwitch('disable-gpu');",
      '  api.app.whenReady().then(execute).catch((error: unknown) => { console.error(error); api.app.exit(1); });',
      '} else {',
      '  execute();',
      '}',
    ].join('\n');
    /**
     * The critic's workbench layout: a probe desktop whose package.json is
     * type:commonjs (as the critic's was), a stub `electron` package (the
     * consumer's other static import), and canonical-root
     * @huggingface/transformers with the conditional exports above.
     */
    const workbench = (label: string): { desktop: string; main: string; safe: string; evil: string } => {
      const desktop = path.join(probeRoot, label, 'desktop');
      const main = path.join(desktop, 'main');
      fs.mkdirSync(main, { recursive: true });
      writeIf(path.join(desktop, 'package.json'), JSON.stringify({ name: `r14-${label}`, private: true, type: 'commonjs', main: 'main/probe.cjs' }));
      writeIf(path.join(desktop, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron', main: 'index.js' }));
      writeIf(path.join(desktop, 'node_modules', 'electron', 'index.js'), 'module.exports = {};\n');
      const root = path.join(desktop, 'node_modules', '@huggingface', 'transformers');
      writeIf(path.join(root, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', type: 'commonjs', exports: { '.': { import: './safe.mjs', require: './evil' } } }));
      const safe = path.join(root, 'safe.mjs');
      const evil = path.join(root, 'evil');
      writeIf(safe, 'export default { benign: true };\n');
      writeIf(evil, parserWrapper());
      return { desktop, main, safe, evil };
    };
    const emit = (fileName: string, source: string): string =>
      ts.transpileModule(source, {
        fileName,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, esModuleInterop: true },
      }).outputText;

    // --- MODE TABLE unit pins (amendment z8) ---
    const ctsMode = workbench('mode-table');
    for (const [form, file, want] of [
      ['import', 'probe.cts', 'require'],
      ['export-from', 'probe.cts', 'require'],
      ['import', 'probe.cjs', 'require'],
      ['import()', 'probe.cts', 'import'],
      ['import()', 'probe.cjs', 'import'],
      ['import', 'probe.mts', 'import'],
      ['export-from', 'probe.mjs', 'import'],
      ['import', 'probe.ts', 'require'],
      ['require()', 'probe.mts', 'require'],
      ['import=require', 'probe.ts', 'require'],
    ] as const) {
      expect(src10SiteMode(form, file, ctsMode.main), `mode table (probe desktop type:commonjs): ${form} in ${file} -> ${want}`).toBe(want);
    }
    expect(src10SiteMode('import', 'backend/ingest/extractors.ts'), "mode table (real tree): a .ts static import under desktop/package.json type:module -> import").toBe('import');
    expect(src10SiteMode('export-from', 'backend/packs/zip-install.ts'), 'mode table (real tree): a .ts export-from -> import').toBe('import');
    expect(src10SiteMode('import()', 'backend/ingest/doc-worker-child.ts'), 'mode table (real tree): dynamic import() -> import').toBe('import');
    expect(src10SiteMode('require()', 'backend/store/sqlite-store.ts'), 'mode table (real tree): require() -> require').toBe('require');

    // --- PROBE 1: the critic's .cts static import (RED under z8) ---
    {
      const wb = workbench('cts-static-import-mode');
      writeIf(path.join(wb.main, 'probe.cts'), ctsConsumer);
      const tree = probeTreeOf(wb.main);
      expect([...tree.keys()], 'the walk enumerates the .cts probe (SOURCE_EXTENSIONS carries .cts)').toEqual(['probe.cts']);
      const emitted = emit(path.join(wb.main, 'probe.cts'), ctsConsumer);
      expect(emitted.includes('require("@huggingface/transformers")'), 'TypeScript NodeNext EMITS the .cts static import as require() — the mode the program actually loads in').toBe(true);
      expect(/\bimport\s+\w+\s+from\s+['"]@huggingface\/transformers['"]/.test(emitted), 'the emitted .cts program carries no static import of the package').toBe(false);
      const sites = loadSitesInSource(ctsConsumer, 'probe.cts');
      const site = sites.find((s) => s.specifier === '@huggingface/transformers');
      if (site === undefined) throw new Error('probe load inventory missed @huggingface/transformers');
      expect(site.form, 'the inventory sees the SYNTACTIC form `import`').toBe('import');
      expect(src10SiteMode(site.form, site.file, wb.main), "(z8): the site's mode is the EMITTED require mode, not the syntactic import mode").toBe('require');
      const batch = src10NodeResolutionsOfSites(sites, wb.main);
      const node = batch.get(`require\u0000probe.cts\u0000@huggingface/transformers`);
      if (node === undefined) throw new Error("SRC-10'' batch missed the require-mode row");
      expect(fold(node.target), 'NODE ITSELF, asked in require mode, lands on the EXTENSIONLESS wrapper').toBe(fold(wb.evil));
      expect(src10NodeClassifySite(site, node, wb.main), "the gate judges Node's require-mode answer: extensionless (CommonJS would run it as JavaScript)").toEqual({
        cls: 'extensionless',
        detail: 'node_modules/@huggingface/transformers/evil',
      });
      expect(fmt10n(tree, wb.main), "round-14 probe -> RED under SRC-10'' (z8): exactly the require-mode extensionless finding; the consumer's other static import (electron) stays class (b)").toEqual([
        'probe.cts import extensionless node_modules/@huggingface/transformers/evil',
      ]);
      // The pre-(z8) blind spot, recorded rather than hidden: asked in the
      // SYNTACTIC import mode, Node answers the benign safe.mjs and the same
      // gate awards class (b) — the critic's zero-finding result (:19).
      const importAnswer = src10RunResolverRequests(null, [{ mode: 'import', importer: path.join(wb.main, 'probe.cts'), specifier: '@huggingface/transformers' }]).rows[0];
      expect(importAnswer?.error ?? null, 'the import-mode question resolves').toBeNull();
      expect(fold(importAnswer?.resolved ?? ''), 'gap pinned: the SYNTACTIC import-mode answer is the benign safe.mjs (critic-round14-probes.out:19 scannerTarget)').toBe(fold(wb.safe));
      expect(
        src10NodeClassifySite(site, { ...node, target: importAnswer?.resolved ?? '', error: '' }, wb.main),
        'gap pinned: judged on the import-mode answer the site is class (b) — the pre-(z8) green',
      ).toEqual({ cls: 'package', detail: '@huggingface/transformers' });
      expect(src10FindingsOfTree(tree, wb.main), "gap pinned: the SRC-10' EMULATOR (no Node batch) resolves by syntax and stays EMPTY — the defect was the MODE, not the package algorithm").toEqual([]);
      expect(src10bPackageJsonFindingsOf(wb.main), 'no package.json under the probe main (the route needs none)').toEqual([]);
    }

    // --- CONTROL 2: .mts static import (ESM; stays green on safe.mjs) ---
    {
      const wb = workbench('mts-static-import-mode');
      const source = "import wrapper from '@huggingface/transformers';\nexport const value = wrapper;\n";
      writeIf(path.join(wb.main, 'probe.mts'), source);
      const tree = probeTreeOf(wb.main);
      const emitted = emit(path.join(wb.main, 'probe.mts'), source);
      expect(/import\s+wrapper\s+from\s+['"]@huggingface\/transformers['"]/.test(emitted) && !emitted.includes('require('), 'TypeScript NodeNext keeps the .mts static import as an ESM import').toBe(true);
      const sites = loadSitesInSource(source, 'probe.mts');
      const site = sites[0];
      if (site === undefined) throw new Error('probe load inventory missed the .mts import');
      expect(src10SiteMode(site.form, site.file, wb.main), '.mts static import -> import mode (even under a type:commonjs desktop manifest)').toBe('import');
      const node = src10NodeResolutionsOfSites(sites, wb.main).get(`import\u0000probe.mts\u0000@huggingface/transformers`);
      if (node === undefined) throw new Error("SRC-10'' batch missed the .mts import-mode row");
      expect(fold(node.target), 'NODE ITSELF, asked in import mode, lands on safe.mjs').toBe(fold(wb.safe));
      expect(fmt10n(tree, wb.main), 'CONTROL: the .mts static import stays GREEN (no overcorrection)').toEqual([]);
    }

    // --- CONTROL 3: .cts dynamic import() (ESM always; stays green) ---
    {
      const wb = workbench('cts-dynamic-import-mode');
      const source = "export async function load(): Promise<unknown> {\n  return (await import('@huggingface/transformers')).default;\n}\n";
      writeIf(path.join(wb.main, 'probe.cts'), source);
      const tree = probeTreeOf(wb.main);
      const emitted = emit(path.join(wb.main, 'probe.cts'), source);
      expect(emitted.includes("import('@huggingface/transformers')") && !emitted.includes('require("@huggingface/transformers")'), 'TypeScript NodeNext keeps a .cts dynamic import() as import() (never require())').toBe(true);
      const sites = loadSitesInSource(source, 'probe.cts');
      const site = sites[0];
      if (site === undefined) throw new Error('probe load inventory missed the .cts dynamic import');
      expect(site.form, 'the inventory sees the dynamic form').toBe('import()');
      expect(src10SiteMode(site.form, site.file, wb.main), '.cts dynamic import() -> import mode').toBe('import');
      const node = src10NodeResolutionsOfSites(sites, wb.main).get(`import\u0000probe.cts\u0000@huggingface/transformers`);
      if (node === undefined) throw new Error("SRC-10'' batch missed the .cts dynamic import-mode row");
      expect(fold(node.target), 'NODE ITSELF, asked in import mode, lands on safe.mjs').toBe(fold(wb.safe));
      expect(fmt10n(tree, wb.main), 'CONTROL: the .cts dynamic import stays GREEN (dynamic import() is ESM in any file)').toEqual([]);
    }

    // --- NEGATIVES: the real base / simulated post-fix trees under (z8) ---
    {
      const files = listTsFiles(MAIN_DIR);
      expect([...new Set(files.map((f) => path.extname(f).toLowerCase()))], 'base fact: desktop/main source files are all .ts (no .cts/.mts/.cjs/.mjs), so (z8) changes no base mode label').toEqual(['.ts']);
      const desktopManifest = JSON.parse(fs.readFileSync(path.resolve(MAIN_DIR, '..', 'package.json'), 'utf8')) as { type?: unknown };
      expect(desktopManifest.type, 'the governing manifest for desktop/main .ts files is desktop/package.json "type": "module"').toBe('module');
      expect(src10SourceFormatOf(path.join(MAIN_DIR, 'index.ts')), 'the real main tree emits ESM').toBe('module');
      const sites = loadSitesOf(files);
      const rows = src10NodeResolutionRowsOfSites(sites);
      const syntactic = (form: string): 'require' | 'import' => (form === 'import' || form === 'export-from' || form === 'import()' ? 'import' : 'require');
      expect(rows.filter((r) => r.mode !== syntactic(r.form)), 'NEGATIVE: no package row of the real tree changes mode under (z8) (every .ts file is ESM-emitted)').toEqual([]);
      expect(rows.length, 'amendment (z9): the real tree still resolves its package rows (27 at base; 26 on the planned head)').toBe(expectedPackageRowCount());
      const batch = src10NodeResolutionsOfSites(sites, MAIN_DIR);
      expect(src10FindingsOfSites(sites, src10ScanSetOf(treeOfFiles(files), MAIN_DIR), MAIN_DIR, batch), "NEGATIVE: the real tree stays green under SRC-10'' with (z8) modes").toEqual([]);
      const headTree = new Map(treeOfFiles(files));
      headTree.set(DOC_CHILD_RELATIVE, (headTree.get(XLSX_CHILD_RELATIVE) ?? '')
        .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'DOC_WORKER_ERROR_PREFIX')
        .replaceAll('runXlsxChildMain', 'runDocChildMain'));
      // AC_CHANGED_BY_USER 2026-11-09: the simulated post-fix tree also
      // carries the planned PACK pair and a jszip-free pack-extract (each
      // transform is a no-op once the real files exist). The pack runner
      // mirrors the xlsx runner with pack names; the pack child takes the
      // same identifier rename the doc child takes above; pack-extract.ts
      // swaps its jszip import for the planned runner edge.
      headTree.set(PACK_RUNNER_RELATIVE, (headTree.get(XLSX_RUNNER_RELATIVE) ?? '')
        .replaceAll('xlsx-worker-child', 'pack-extract-child')
        .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'PACK_WORKER_ERROR_PREFIX')
        .replaceAll('xlsxWorkerChildPath', 'packWorkerChildPath')
        .replaceAll('setXlsxWorkerForkFn', 'setPackWorkerForkFn')
        .replaceAll('XlsxWorker', 'PackWorker')
        .replaceAll('DEFAULT_XLSX_TIMEOUT_MS', 'DEFAULT_PACK_TIMEOUT_MS')
        .replaceAll('extractXlsxOutOfProcess', 'extractPackZipOutOfProcess'));
      headTree.set(PACK_CHILD_RELATIVE, (headTree.get(XLSX_CHILD_RELATIVE) ?? '')
        .replaceAll('XLSX_WORKER_ERROR_PREFIX', 'PACK_WORKER_ERROR_PREFIX')
        .replaceAll('runXlsxChildMain', 'runPackChildMain'));
      const plannedPackExtract = (headTree.get(PACK_EXTRACT_RELATIVE) ?? '')
        .replace(/import JSZip from 'jszip';\r?\n/, "import { extractPackZipOutOfProcess } from './pack-worker.js';\n");
      expect(plannedPackExtract, 'the simulated pack-extract carries no jszip import (AC_CHANGED_BY_USER; a no-op swap once the real bridge exists)').not.toContain("import JSZip from 'jszip'");
      headTree.set(PACK_EXTRACT_RELATIVE, plannedPackExtract);
      const headSites = [...headTree].flatMap(([rel, source]) => loadSitesInSource(source, rel));
      expect(src10FindingsOfSites(headSites, src10ScanSetOf(headTree, MAIN_DIR), MAIN_DIR, src10NodeResolutionsOfSites(headSites, MAIN_DIR)), "NEGATIVE: the simulated post-fix tree stays green under SRC-10'' with (z8) modes").toEqual([]);
    }
  });

  it('S1: mammoth and pdfjs-dist are loaded and called ONLY by the doc child across ALL of desktop/main', () => {
    const files = listTsFiles(MAIN_DIR);
    // Anti-vacuity: the scan really covered the main-process tree.
    expect(files.length).toBeGreaterThan(40);
    const relatives = files.map(relToMain);
    expect(relatives).toContain('backend/ingest/extractors.ts');
    expect(relatives).toContain(DOC_CHILD_RELATIVE);

    const sites = loadSitesOf(files);
    expect(filesLoading(sites, MAMMOTH_SPECIFIER), 'only the doc child may load mammoth (AST inventory)').toEqual([
      DOC_CHILD_RELATIVE,
    ]);
    expect(filesLoading(sites, PDFJS_SPECIFIER), 'only the doc child may load pdfjs-dist (AST inventory)').toEqual([
      DOC_CHILD_RELATIVE,
    ]);
    // Secondary AST parser-CALL guard (amendment (j) — dot / element /
    // optional / bare forms; see the parser-CALL guard comment).
    expect(filesCallingParserEntry(files, 'extractRawText'), 'only the doc child may call extractRawText(').toEqual([
      DOC_CHILD_RELATIVE,
    ]);
    expect(filesCallingParserEntry(files, 'getDocument'), 'only the doc child may call getDocument(').toEqual([
      DOC_CHILD_RELATIVE,
    ]);
    // INV-3 (amendment (m)): every RUNTIME reference — aliases, .call/.apply/
    // .bind, destructuring, handles handed across modules — not only calls.
    expect(filesReferencingParserEntry(files, 'extractRawText'), 'only the doc child may reference extractRawText').toEqual([
      DOC_CHILD_RELATIVE,
    ]);
    expect(filesReferencingParserEntry(files, 'getDocument'), 'only the doc child may reference getDocument').toEqual([
      DOC_CHILD_RELATIVE,
    ]);
    // The other mammoth entry points: allowed in the doc child only (the
    // planned child uses extractRawText alone, so these sets may be empty).
    for (const name of ['convertToHtml', 'convertToMarkdown']) {
      expect(
        filesReferencingParserEntry(files, name).filter((file) => file !== DOC_CHILD_RELATIVE),
        `only the doc child may reference ${name}`,
      ).toEqual([]);
    }
  });

  it('S1: jszip is loaded and called ONLY by the exact sanctioned set across ALL of desktop/main (critic rev 5)', () => {
    // AMENDED (critic revision 5): the jszip guard is GENUINELY
    // directory-wide — it scans ALL of desktop/main, not just
    // backend/ingest. AMENDED again (AC_CHANGED_BY_USER, 2026-11-09): the
    // maintainer decided "Migrate in this PR", so the allowed set is EXACTLY
    // the THREE parse children:
    //
    //   backend/packs/pack-extract-child.ts — the PLANNED pack child of the
    //     AC3 migration (frozen check C3 owns its behavioural contract). It
    //     is a planned owner handled absent-OR-exact, exactly like the
    //     planned doc pair: while it is absent this leg is RED, and once it
    //     exists the exact set is enforced. backend/packs/pack-extract.ts —
    //     the former NAMED RESIDUAL for issue #320 AC3 (pack zip extraction
    //     ran in the main process BEFORE the opt-in, default-off Ed25519
    //     gate) — is NO LONGER ALLOWED: the bridge keeps the public
    //     extractPackZip API but must not load jszip at all. The
    //     extract-then-verify ordering itself is unchanged and out of scope.
    //
    // EXACT-SET EQUALITY: any NEW jszip load site (any form the AST
    // inventory resolves — amendment (h)), loadAsync( call, or runtime
    // loadAsync REFERENCE (amendment (m) / INV-3) anywhere under desktop/main
    // fails this leg. At base 5d1f7338 this leg is RED for BOTH defects:
    // extractors.ts still loads jszip and doc-worker-child.ts does not exist,
    // AND pack-extract.ts still loads jszip while pack-extract-child.ts does
    // not exist — the AC3 defect C3/C1 must catch.
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    const sanctioned = [DOC_CHILD_RELATIVE, XLSX_CHILD_RELATIVE, PACK_CHILD_RELATIVE].sort();
    expect(
      filesLoading(loadSitesOf(files), JSZIP_SPECIFIER),
      'only the doc child, the xlsx child and the pack child may load jszip (AST inventory; AC_CHANGED_BY_USER 2026-11-09)',
    ).toEqual(sanctioned);
    expect(filesCallingParserEntry(files, 'loadAsync'), 'only the same sanctioned set may call loadAsync(').toEqual(
      sanctioned,
    );
    // INV-3 (amendment (m)): every RUNTIME reference to loadAsync, not only calls.
    expect(filesReferencingParserEntry(files, 'loadAsync'), 'only the same sanctioned set may reference loadAsync').toEqual(
      sanctioned,
    );
  });

  it('S1 (amendment k / INV-1): no desktop/main module imports a parse child except its runner taking the error prefix', () => {
    // A parse child is a PROCESS ENTRY POINT: importing its entry (or any other
    // binding, a namespace, a default, a re-export, a dynamic import / require /
    // import-equals of its path) would run the child's parser imports in the
    // CALLER'S (main) process. The finding set must be EMPTY — no allowlist.
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    const { findings, permitted } = processBoundaryOf(files);
    expect(findings, 'forbidden module edges into a parse child (wrappers, re-exports, entry reuse, loads)').toEqual([]);
    // Anti-vacuity: the guard really resolves this tree's relative edges — the
    // base xlsx runner's prefix import (xlsx-worker.ts:28) is SEEN and permitted.
    expect(permitted, 'the base xlsx runner -> child prefix edge is resolved').toContainEqual({
      file: 'backend/ingest/xlsx-worker.ts',
      target: XLSX_CHILD_RELATIVE,
      binding: 'XLSX_WORKER_ERROR_PREFIX',
    });
    // Every permitted edge is one of the two declared runner -> child shapes.
    for (const edge of permitted) {
      expect(
        PARSE_CHILD_BOUNDARY.some((b) => b.runner === edge.file && b.child === edge.target && b.binding === edge.binding),
        `${edge.file} -> ${edge.target}`,
      ).toBe(true);
    }
  });

  it('S1 (amendment n / INV-4): no desktop/main module names a parse child launch surface outside its owner', () => {
    // INV-1 sees module edges only; a main module could still launch a parse
    // child IN-PROCESS (`new Worker(<child path>)`), re-fork it via the runner's
    // resolver, or swap the runner's launcher. Every such launch names the child
    // through a basename literal, a child-path resolver or a launcher setter,
    // and each is confined to its owner (header note (n)). The finding set must
    // be EMPTY — no allowlist.
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    const { findings, permitted } = launchSurfaceOf(files);
    expect(findings, 'parse-child basenames / resolvers / launcher setters named outside their owner').toEqual([]);
    // Anti-vacuity: the guard really sees this tree's launch surface — the base
    // xlsx runner's path.join resolution literals (xlsx-worker.ts:117 / :119)
    // and the index.ts setter registration are SEEN and permitted.
    expect(
      permitted.filter((h) => h.file === 'backend/ingest/xlsx-worker.ts' && h.name === 'xlsx-worker-child').map((h) => h.fragment),
      'the xlsx runner resolves its child by path.join literals',
    ).toEqual(expect.arrayContaining(["path.join(here, 'xlsx-worker-child.js')", "path.join(here, 'xlsx-worker-child.ts')"]));
    expect(permitted, 'index.ts registers the xlsx launcher').toContainEqual(
      expect.objectContaining({ file: 'index.ts', name: 'setXlsxWorkerForkFn', form: 'identifier' }),
    );
    // Every permitted hit sits in one of its rule's allowed files.
    for (const hit of permitted) {
      const rule = LAUNCH_SURFACE_RULES.find((r) => r.name === hit.name);
      expect(rule?.allowed.some((a) => moduleStem(a) === moduleStem(hit.file)), `${hit.file}: ${hit.name}`).toBe(true);
    }
  });

  it('S1 (amendment o / INV-5a): the owner closure and every owner export surface equal the frozen lists', () => {
    // Round 6 closed the cross-module capability alias class by freezing the
    // world around the capability owners: the seed runners/children/pack core
    // plus the transitive re-export closure (zip-install.ts at base), plus
    // the two planned doc owners. Each owner's RUNTIME export names must
    // EXACTLY equal its frozen list — a new export of ANY form (an alias, a
    // wrapper, a re-export) fails; a planned owner that does not exist yet
    // passes vacuously but is exact-frozen the moment it appears.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    expect(inv5ClosureOfTree(tree), 'the computed owner closure equals the base-captured closure').toEqual(FROZEN_OWNER_CLOSURE);
    expect(inv5aFindingsOfTree(tree), 'no owner export surface may drift from its frozen list').toEqual([]);
    // Anti-vacuity: the frozen lists really describe these files — each base
    // owner's computed surface equals its capture (and the xlsx runner's is
    // the 7-name surface the doc runner mirrors).
    for (const owner of FROZEN_OWNER_CLOSURE) {
      expect(runtimeExportNamesInSource(tree.get(owner) ?? '', owner), `${owner} runtime export surface`).toEqual(
        [...(FROZEN_RUNTIME_EXPORTS[owner] ?? [])].sort(),
      );
    }
    expect(FROZEN_RUNTIME_EXPORTS[XLSX_RUNNER_RELATIVE]).toEqual([
      'DEFAULT_XLSX_TIMEOUT_MS',
      'extractXlsxOutOfProcess',
      'nodeForkXlsxWorker',
      'resolveXlsxWorkerForkFn',
      'setXlsxWorkerForkFn',
      'terminateXlsxWorkers',
      'xlsxWorkerChildPath',
    ]);
    // AC_CHANGED_BY_USER 2026-11-09: the planned pack runner mirrors that
    // surface with pack names, and the pack child exports exactly the
    // C3 spec's import union (absent OR exact, like the doc pair).
    // Revision 23 (CHECK_WRONG sync): extractPackZipWithOptions joined as
    // the 8th name — this assertion literal now matches FROZEN_RUNTIME_EXPORTS
    // above (the earlier 7-name literal was the round-23-impl self-inconsistency).
    expect(FROZEN_RUNTIME_EXPORTS[PACK_RUNNER_RELATIVE]).toEqual([
      'DEFAULT_PACK_TIMEOUT_MS',
      'extractPackZipOutOfProcess',
      'extractPackZipWithOptions',
      'nodeForkPackWorker',
      'packWorkerChildPath',
      'resolvePackWorkerForkFn',
      'setPackWorkerForkFn',
      'terminatePackWorkers',
    ]);
    expect(FROZEN_RUNTIME_EXPORTS[PACK_CHILD_RELATIVE]).toEqual(['PACK_WORKER_ERROR_PREFIX', 'runPackChildMain']);
  });

  it('S1 (amendment p / INV-5b): every import edge into an owner equals the frozen base + planned lists', () => {
    // INV-5b freezes the CONSUMER side: for every owner, the (importer,
    // binding) edges within desktop/main must exactly equal the base-captured
    // list plus the Revision 7 planned edges (excused only while the planned
    // owner file is absent). A NEW consumer of an existing export — the
    // round-6 alias consumer — fails; a frozen edge disappearing fails.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    expect(inv5bFindingsOfTree(tree), 'no owner may gain or lose an import edge').toEqual([]);
    // Anti-vacuity: the capture really describes this tree — the base dynamic
    // xlsx edge from extractors.ts and the zip-install consumer edge from
    // surface.ts are SEEN by the edge walk at their frozen bindings.
    const extractorsEdges = moduleImportEdgesInSource(tree.get('backend/ingest/extractors.ts') ?? '', 'backend/ingest/extractors.ts');
    expect(
      extractorsEdges.some((e) => e.target === moduleStem(XLSX_RUNNER_RELATIVE) && e.binding === '*'),
      "the base extractors.ts dynamic './xlsx-worker.js' edge is still seen as a * edge",
    ).toBe(true);
    const surfaceEdges = moduleImportEdgesInSource(tree.get('backend/packs/surface.ts') ?? '', 'backend/packs/surface.ts');
    expect(
      surfaceEdges.some((e) => e.target === moduleStem('backend/packs/zip-install.ts') && e.binding === 'extractPackZip'),
      'the surface.ts -> zip-install.ts extractPackZip edge is seen',
    ).toBe(true);
  });

  it('S1 (amendment q / INV-5c): worker_threads loads and new Worker( are confined to the reranker pair', () => {
    // Whatever name a parse-child path arrives under, RUNNING it in-process
    // needs worker_threads: every load of the module (any form the inventory
    // recognises) and every `new Worker(` construction is confined to EXACTLY
    // the reranker pair. The finding set is EMPTY — no allowlist.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    expect(inv5cFindingsOfTree(tree), 'worker_threads loads / Worker constructions outside the reranker pair').toEqual([]);
    // Anti-vacuity: the guard really sees the base pair — the reranker's
    // Worker import AND construction, and the worker side's parentPort /
    // workerData import.
    const permitted = inv5cPermittedOfTree(tree);
    expect(permitted.filter((s) => s.file === 'backend/retrieval/reranker.ts').map((s) => s.kind).sort()).toEqual([
      'worker-construction',
      'worker-threads-load',
    ]);
    expect(permitted.filter((s) => s.file === 'backend/retrieval/rerank-worker.ts').map((s) => s.kind)).toEqual(['worker-threads-load']);
    expect(inv5cSitesInSource(fs.readFileSync(path.join(MAIN_DIR, 'backend', 'inference', 'gpu-probe.ts'), 'utf8'), 'backend/inference/gpu-probe.ts'), 'gpu-probe.ts only MENTIONS worker_threads in comments').toEqual([]);
  });

  it('S1 (amendment r / SRC-1): vm / eval / Function / process.dlopen / CJS internals appear NOWHERE; workerPath only in reranker.ts', () => {
    // Revision 8 SRC-1: the in-process-execution SOURCES. The allowed sets
    // are EMPTY for vm loads, eval/Function runtime references, process.dlopen
    // and CJS-internal accesses on module-package bindings (each verified
    // empty at base 5d1f7338 — see the header note (r)); the `workerPath`
    // script-path key is confined to backend/retrieval/reranker.ts, so no
    // other module can point WorkerReranker / ResumableReranker at another
    // script. No allowlist: any new site fails.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    expect(
      src1FindingsOfTree(tree),
      'in-process execution sources (vm loads, eval/Function references, process.dlopen, Module internals, workerPath outside reranker.ts)',
    ).toEqual([]);
    // Anti-vacuity: the workerPath confinement really sees the base
    // reranker's own uses of the key — the private field (a member key) and
    // the three dot accesses (this.workerPath x2, options.workerPath).
    const permitted = src1PermittedOfTree(tree);
    expect(permitted.map((s) => s.form).sort(), 'the base reranker.ts workerPath references (1 key + 3 dots)').toEqual(['dot', 'dot', 'dot', 'key']);
    expect([...new Set(permitted.map((s) => s.file))]).toEqual(['backend/retrieval/reranker.ts']);
  });

  it('S1 (amendment s / SRC-2): no module runtime-exports an owner binding under any name', () => {
    // Revision 8 SRC-2: a module holding an owner capability through a
    // permitted INV-5b edge may not hand it onward — no local export-list
    // rename, no exported alias, no default export, no namespace re-export.
    // Owners are INV-5a's (zip-install.ts's sanctioned re-exports are not
    // re-flagged); wrappers are not flagged (header note (s), amended in round
    // 8: they rely on the SRC-1/SRC-3/SRC-4 source closure). No base
    // consumer re-exports an owner binding, so the set is EMPTY; the round-7
    // probe above proves the alias mutation of surface.ts / index.ts turns it
    // red.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    expect(src2FindingsOfTree(tree), 'permitted consumers may not re-export an owner binding (aliases, defaults, namespaces)').toEqual([]);
  });

  it('S1 (amendment t / SRC-3): IN-PROCESS-EXEC built-ins, data: URL loads and global evaluators appear only in their allowed sets', () => {
    // Revision 9 SRC-3: every IN-PROCESS-EXEC built-in (the frozen complete
    // classification) is confined by EVERY route the load inventory, the
    // loader walk and SRC-4 recognise — worker_threads to the reranker pair
    // (INV-5c), the module package to the recognised named createRequire
    // import (INV-2), every other one NOWHERE — plus the data: URL and global
    // evaluator sources. No allowlist: the finding set is EMPTY.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    expect(src3FindingsOfTree(tree), 'in-process execution built-ins / data: URL loads / WebAssembly / function-constructor references').toEqual([]);
    // Anti-vacuity: the permitted sites are exactly the reranker pair's two
    // worker_threads loads and the five base named createRequire imports.
    expect(
      src3PermittedOfTree(tree).map((s) => `${s.file} ${s.source} ${s.form}`),
      'the permitted IN-PROCESS-EXEC loads (worker_threads in the pair; named createRequire imports)',
    ).toEqual([
      'backend/retrieval/rerank-worker.ts worker_threads import',
      'backend/retrieval/reranker.ts worker_threads import',
      'backend/store/backup.ts module import',
      'backend/store/pack-manager.ts module import',
      'backend/store/recovery.ts module import',
      'backend/store/sqlite-store.ts module import',
      'update-checker.ts module import',
    ]);
  });

  it('S1 (amendment t / SRC-4): no desktop/main module references a built-in access API (getBuiltinModule / binding / ...)', () => {
    // Revision 9 SRC-4: the built-in access APIs are UNRECOGNISED loader uses
    // with an EMPTY allowlist. The amendment-(i) allowlist leg already enforces
    // this; the dedicated projection keeps the SRC-4 claim independently visible.
    const uses = sortedLoaderUses(listTsFiles(MAIN_DIR)).filter((u) => u.form === 'builtin-access');
    expect(uses, `runtime references to ${SRC4_BUILTIN_ACCESS_NAMES.join(' / ')}`).toEqual([]);
  });

  it('S1 (amendment t / SRC-5): native-extension loads appear ONLY at the two base sqlite-vec sites', () => {
    // Revision 9 SRC-5: runtime references to loadExtension (and the
    // check-author's setEngine / privateKeyEngine / clientCertEngine additions)
    // are confined to SRC5_ALLOWED_SITES exactly — one site per entry.
    const tree = treeOfFiles(listTsFiles(MAIN_DIR));
    const { findings, permitted } = src5OfTree(tree);
    expect(findings, 'native-extension load references outside the two base sites').toEqual([]);
    expect(permitted, 'anti-vacuity: both base sqlite-vec loads are seen, once each').toEqual(
      SRC5_ALLOWED_SITES.map(({ file, name, form, fragment }) => ({ file, name, form, fragment })),
    );
    for (const entry of SRC5_ALLOWED_SITES) {
      expect(entry.reason, `${entry.file} carries a one-line reason`).toMatch(/^\S[^\n]*$/);
    }
  });

  it('S1 (amendment u / SRC-6): the third-party packages loaded in desktop/main equal the frozen classification EXACTLY', () => {
    // Revision 9 update SRC-6: C1 policed only the three libraries #320 NAMES
    // (plus xlsx via #319), so a DIFFERENT third-party parser library loaded
    // into main passed every rule. The set of third-party package names loaded
    // anywhere in desktop/main — every route the load inventory recognises,
    // normalised to the package name (scope kept, subpath dropped) — must
    // EXACTLY equal THIRD_PARTY_PACKAGE_CLASSIFICATION, captured at base
    // 5d1f7338. A NEW package is UNCLASSIFIED until someone classifies it; a
    // VANISHED package is REMOVED until the table is pruned (a deliberate
    // frozen-list edit). PARSER entries are additionally confined to the file
    // sets the existing legs assign (fail-closed overlap with them). At base
    // the SET is already equal (extractors.ts loads the same three parser
    // packages the planned doc child will), so this leg's set assertion is
    // green at base on its own content while the findings assertion is RED —
    // extractors.ts is not in any PARSER allowed set, and since the
    // AC_CHANGED_BY_USER 2026-11-09 amendment pack-extract.ts is not in
    // jszip's allowed set either (the AC3 defect surfacing here too) —
    // consistent with this file's red-at-base import-resolution failure.
    const files = listTsFiles(MAIN_DIR);
    const sites = loadSitesOf(files);
    const packages = thirdPartyPackagesOf(sites);
    expect(packages.length, 'anti-vacuity: the inventory is non-empty').toBeGreaterThan(0);
    expect(packages, 'anti-vacuity: electron is loaded in main').toContain('electron');
    expect(packages, 'anti-vacuity: the native addon better-sqlite3 is loaded in main').toContain('better-sqlite3');
    expect(
      packages,
      'the loaded set must equal the frozen table (a NEW package is UNCLASSIFIED until classified; a vanished package is REMOVED until the table is pruned)',
    ).toEqual(Object.keys(THIRD_PARTY_PACKAGE_CLASSIFICATION).sort());
    expect(src6FindingsOfSites(sites), 'SRC-6 findings over desktop/main (UNCLASSIFIED / REMOVED / PARSER-OUTSIDE-ALLOWED)').toEqual([]);
  });

  it('S1 (amendments v+x / SRC-7\'): every local module edge of a desktop/main file resolves INSIDE desktop/main by ACTUAL resolution; no links, no nested manifests', () => {
    // Round 9 finding 1 (plan Revision 10 SRC-7): every layer enumerated only
    // the files physically beneath desktop/main, so a main module importing a
    // NEW local wrapper OUTSIDE that root (the critic's
    // '../shared/workbook-parser.js' — TypeScript compiles it into the main
    // program and it parsed canonical xlsx in the MAIN PID on Node,
    // Electron-as-Node and a real Electron main process) ran unscanned code
    // with ZERO findings. Round 10 finding 1 (plan Revision 11 SRC-7'):
    // LEXICAL containment is not resolution — a directory edge reads a
    // nested package.json `main` (the critic's './container' probe resolved
    // an external wrapper and parsed canonical xlsx in the REAL Electron
    // main PID) and the filesystem follows a junction after the lexical
    // check ('./linked/workbook-parser.cjs', real Electron main PID again)
    // while the walk never even lists the link. Every LOCAL edge — relative,
    // absolute (POSIX or drive) or file: URL, by every route the load
    // inventory recognises — must now resolve (directory package.json
    // main/exports/index, .js -> .ts twin mapping, final realpath) INSIDE
    // desktop/main; every symlink/junction ENTRY and every nested
    // package.json whose main/exports targets leave the root are findings.
    // ALL EMPTY allowed sets.
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    const sites = loadSitesOf(files);
    // Anti-vacuity: the edge enumeration really sees this tree's in-main
    // RELATIVE edges (149 specifier occurrences at base 5d1f7338; the
    // inventory's local set they feed is 120), every one of which must
    // resolve inside. Kept from round 9 and EXTENDED (plan Revision 11): the
    // ACTUAL-resolution pass really observes an executable target for every
    // local edge — every base local edge is a './x.js' -> x.ts TWIN mapping
    // (the compiled layout), none falls back to lexical containment.
    const relativeEdges = sites.filter((s) => isLocalLoadSpecifier(s.specifier) && /^\.{1,2}(?:\/|$)/.test(s.specifier.replace(/\\/g, '/')));
    expect(relativeEdges.length, 'the edge enumeration saw a non-trivial number of relative edges').toBeGreaterThan(100);
    const resolutions = sites.filter((s) => isLocalLoadSpecifier(s.specifier)).map((s) => resolveActualMainTarget(s.file, s.specifier, MAIN_DIR));
    expect(
      resolutions.filter((r) => r.via === 'file' || r.via === 'twin' || r.via === 'extensionless' || r.via === 'directory-main' || r.via === 'directory-index' || r.via === 'directory-exports').length,
      'the ACTUAL resolver observed a real executable target for the local edges (base: every edge is a compiled-layout twin)',
    ).toBeGreaterThan(100);
    expect(
      resolutions.filter((r) => r.via === 'twin').length,
      'the .js -> .ts twin mapping really fires (the compiled layout)',
    ).toBeGreaterThan(100);
    expect(resolutions.filter((r) => r.via === 'lexical').length, 'no base edge needs the lexical fallback').toBe(0);
    expect(src7EscapesOfSites(sites, MAIN_DIR), 'local module edges whose ACTUAL target resolves OUTSIDE desktop/main (EMPTY allowed set)').toEqual([]);
    // Walk-level rules (amendment (x)): no symlink/junction entry anywhere
    // under desktop/main, and no nested package.json routing loads outside.
    expect(src7LinkFindingsOf(MAIN_DIR), 'symlink/junction entries under desktop/main (EMPTY allowed set; links are never followed or scanned)').toEqual([]);
    expect(src7PackageJsonFindingsOf(MAIN_DIR), 'package.json files under desktop/main whose main/exports resolve outside (EMPTY allowed set)').toEqual([]);
    // Honesty pin for the walk rules: they really see links and nested
    // manifests when one exists (self-test rows below exercise them on temp
    // trees); at base desktop/main contains NO package.json at all.
    expect(files.every((f) => path.basename(f).toLowerCase() !== 'package.json'), 'anti-vacuity context: desktop/main carries no package.json at base').toBe(true);
  });

  it('S1 (amendment y / SRC-9): no nativeBinding reference and no .node load exists anywhere in desktop/main', () => {
    // Round 10 finding 2 (plan Revision 11 SRC-9): the ALLOWED better-sqlite3
    // package itself exposes `nativeBinding` — a public path its
    // lib/binding.js:9-15 path.resolve + require loads — and require loads a
    // relative '.node' file directly; the critic's probes executed native SQL
    // ({answer:42}) in the calling PID on Node and Electron-as-Node with ZERO
    // findings in all 17 layers. Both shapes now fail closed with EMPTY
    // allowed sets: every RUNTIME reference to the nativeBinding member, and
    // every load whose cooked specifier OR SRC-7'-resolved target ends .node
    // (relative, absolute, file:, package subpath, directory-resolved). Base
    // 5d1f7338 has NONE of either (recorded base fact).
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    const tree = treeOfFiles(files);
    expect(src9NativeBindingFindingsOfTree(tree), 'runtime references to the nativeBinding member (EMPTY allowed set)').toEqual([]);
    expect(src9NodeLoadFindingsOfTree(tree, MAIN_DIR), 'loads whose specifier or resolved target ends .node (EMPTY allowed set)').toEqual([]);
    // Anti-vacuity: the .node rule really sees this tree's load sites — the
    // inventory it consumes is the same non-empty one the SRC-7' leg pinned
    // (> 100 local edges), and the rule fires on the self-test probe rows
    // below (relative, subpath, file:, import-equals, dynamic, createRequire
    // and directory-resolved .node shapes).
    expect(loadSitesOf(files).length, 'the load inventory consumed by SRC-9 is non-empty').toBeGreaterThan(100);
  });

  it("S1 (amendments z4/z6/z7 / SRC-10''): NODE ITSELF resolves every bare-package site in the site's own mode; the emulator agrees (differential, 27/27 at base) and Electron-as-Node agrees (cross-runtime parity)", () => {
    // Round 13 (plan Revision 14 SRC-10'', amendments (z4)/(z6)/(z7)): the
    // class-(b) gate asks NODE ITSELF where each bare-package load lands —
    // createRequire(<importing file>).resolve for require-mode sites,
    // import.meta.resolve(<spec>, <importing file URL>) executed in a
    // SPAWNED plain-node ESM child for import-mode sites (one batched call;
    // the child's source is inline in this spec, written to a throwaway
    // temp .mjs at run time) — because the SRC-10' EMULATION diverged from
    // Node on inner-node_modules specifiers, active conditions
    // (node-addons), manifest key order and pattern trailers, and each
    // divergence was an EXECUTED zero-finding escape on Node,
    // Electron-as-Node and a real Electron 45.2.1 main
    // (repro/critic-round13-resolution.out:32-91). This leg proves the
    // child really is out-of-process and parent-honouring, prints the
    // per-site table (mode / Node / emulator / Electron-as-Node), asserts
    // the 27/27 base differential agreement (anti-vacuity: a base
    // disagreement is REPORTED here, never hidden) and the Electron-as-Node
    // parity (identical answers on the runtime desktop/main actually uses).
    const files = listTsFiles(MAIN_DIR);
    const sites = loadSitesOf(files);
    // (z4) Child faithfulness: the resolver ran OUT of this process, with
    // NODE_OPTIONS deleted, --experimental-import-meta-resolve active, and
    // the import.meta.resolve PARENT argument really honoured (the marker
    // exists only in a throwaway directory; parent-ignoring semantics
    // cannot produce it). Verified for BOTH runtimes.
    src10AssertNodeChildFaithful(null, 'node');
    const electronExe = src10ElectronAsNodeExecutable();
    if (electronExe === null) {
      console.log('S1 SRC-10\'\' parity leg SKIP: the electron devDependency binary (node_modules/electron/dist/electron.exe) is ABSENT on this machine');
    } else {
      src10AssertNodeChildFaithful(electronExe, 'electron-as-node');
    }
    // The per-site table: mode, Node's target, the emulator's target,
    // Electron-as-Node's target (paths relative to desktop).
    const rows = src10NodeResolutionRowsOfSites(sites);
    expect(rows.length, "SRC-10'' anti-vacuity: the tree resolves its package load sites with NODE ITSELF (27 at base 5d1f7338; 26 on the planned head — amendment (z9) absent-OR-exact)").toBe(expectedPackageRowCount());
    for (const r of rows) {
      console.log(`SRC10-NODE-TABLE ${r.file} ${r.form} mode=${r.mode} ${r.specifier} node=${r.node} emulator=${r.emulator} electron=${r.electron}${r.electronRan ? '' : '(absent)'} agrees=${r.agrees} electronAgrees=${r.electronAgrees}`);
    }
    // (z6) DIFFERENTIAL: the SRC-10' emulator agrees with Node on every
    // base site (the round-13 critic's 27/27 match, kept as anti-vacuity —
    // a base disagreement would be REPORTED by this very assertion, not
    // hidden; the round-13 probe rows above are the deliberate
    // disagreements on ADVERSARIAL layouts).
    const disagreements = rows.filter((r) => !r.agrees);
    expect(disagreements, "SRC-10' emulator vs NODE: every BASE site agrees (27/27; any disagreement is surfaced here, never hidden)").toEqual([]);
    // (z7) CROSS-RUNTIME PARITY: every site re-resolves IDENTICALLY under
    // ELECTRON-AS-NODE (Node 24.22.1 in the electron 45.2.1 binary,
    // ELECTRON_RUN_AS_NODE=1) — the runtime desktop/main actually ships in.
    // CHECK_WRONG(CI round 1, 2026-11-11): the hard 'leg, not a skip' assertion
    // baked in an environment assumption the Electron-shell acceptance lane
    // does not satisfy — its runner installs the devDependency WITHOUT the
    // electron dist binary (the row scan above already records
    // electron=(absent) and prints the explicit SKIP reason there). Where the
    // binary exists (dev machines; lanes that download it) the parity leg
    // runs in full — that is where the r14 evidence was captured. Where it is
    // absent the leg now SKIPS by the same explicit reason instead of failing
    // an environment probe; the Node + emulator differential legs above are
    // unconditional and already proved green on the same run.
    const electronDisagreements = rows.filter((r) => !r.electronAgrees);
    expect(electronDisagreements, 'Electron-as-Node parity: every site resolves to the SAME file as vitest\'s Node (cross-runtime divergence is a finding)').toEqual([]);
    // The ONE expected identity difference, pinned rather than hidden: under
    // ELECTRON_RUN_AS_NODE the four `import ... from 'electron'` sites
    // resolve to the runtime's OWN built-in module ('electron:electron' —
    // the same module the packaged main receives), while plain Node resolves
    // the devDependency wrapper node_modules/electron/index.js (which the
    // gate judges and passes). No other package may differ across runtimes.
    const builtinRows = rows.filter((r) => r.electron !== '' && r.electron.includes(':') && !/^[a-z]:/i.test(r.electron));
    expect(new Set(builtinRows.map((r) => r.specifier)), "only the 'electron' package resolves to a runtime built-in under Electron-as-Node").toEqual(new Set(['electron']));
    expect(builtinRows.map((r) => r.file).sort(), "the four base 'electron' import sites (index.ts, logging.ts, protocol.ts, security/config.ts)").toEqual(['index.ts', 'logging.ts', 'protocol.ts', 'security/config.ts']);
    expect(new Set(builtinRows.map((r) => r.electron)), "Electron-as-Node's answer for 'electron' is its built-in URL").toEqual(new Set(['electron:electron']));
    expect(rows.filter((r) => !builtinRows.includes(r)).every((r) => r.electron === r.node), 'every OTHER site: Electron-as-Node resolves the IDENTICAL file').toBe(true);
    // The mode split is real: both modes appear in the base tree, and the
    // two dual-entry packages land on DIFFERENT files per mode (the base
    // fact that makes judging every site in one mode wrong). The base sites
    // exercise ONE mode each (sqlite-vec is require-loaded,
    // @huggingface/transformers import-loaded), so the fact is probed
    // directly: both modes from the same real main importer
    // (backend/ingest/extractors.ts, the critic's round-13 parent), on both
    // runtimes.
    const modes = new Set(rows.map((r) => r.mode));
    expect(modes, 'both load modes occur in the base tree').toEqual(new Set(['require', 'import']));
    const parent = path.join(MAIN_DIR, 'backend', 'ingest', 'extractors.ts');
    const modeProbe: Array<{ mode: 'require' | 'import'; importer: string; specifier: string }> = [];
    for (const name of ['sqlite-vec', '@huggingface/transformers']) {
      modeProbe.push({ mode: 'require', importer: parent, specifier: name }, { mode: 'import', importer: parent, specifier: name });
    }
    const desktopRel = (p: string | null): string => (p === null ? '' : path.relative(path.resolve(MAIN_DIR, '..'), p).split(path.sep).join('/'));
    const nodeModes = src10RunResolverRequests(null, modeProbe).rows.map((r) => desktopRel(r.resolved));
    const electronModes = electronExe === null ? nodeModes : src10RunResolverRequests(electronExe, modeProbe).rows.map((r) => desktopRel(r.resolved));
    console.log(`SRC10-MODE-SPLIT ${JSON.stringify(modeProbe.map((p, i) => `${p.specifier} ${p.mode} -> node=${nodeModes[i]} electron=${electronModes[i]}`))}`);
    expect(nodeModes, 'base fact: sqlite-vec and @huggingface/transformers resolve to DIFFERENT files per mode (require -> .cjs, import -> .mjs)').toEqual([
      'node_modules/sqlite-vec/index.cjs',
      'node_modules/sqlite-vec/index.mjs',
      'node_modules/@huggingface/transformers/dist/transformers.node.cjs',
      'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
    ]);
    expect(electronModes, 'the per-mode split is identical under Electron-as-Node').toEqual(nodeModes);
  });

  it("S1 (amendments z/z'/z'' + z3 / SRC-10 + SRC-10' + SRC-10b + SRC-10c): every load target is a scanned source, a RESOLVED canonical package, a classified built-in or an allowlisted JSON; no package.json, directory load, self-reference or .wasm anywhere", () => {
    // Round 11 (plan Revision 12): five ordinary routes executed code in the
    // calling PID with ZERO findings in all 19 layers plus both walks —
    // an extensionless X.node lookup, a directory index.node, a nested
    // package.json self-reference to a local .node, an exact extensionless
    // JavaScript wrapper parsing canonical xlsx in a REAL Electron main, and
    // a direct import('./answer.wasm'). Every one placed executable code
    // OUTSIDE the enumerated source set. SRC-10 now classifies the ACTUAL
    // target of EVERY load site (SRC-7' actual resolution underneath) as (a)
    // a walked in-tree source, (b) a THIRD_PARTY_PACKAGE_CLASSIFICATION
    // package, (c) an SRC-3 built-in or (d) a SRC10_JSON_ALLOWLIST .json
    // (EMPTY at base); everything else fails with an EMPTY allowed set.
    // SRC-10b bans every package.json under desktop/main, every directory
    // load and every 'trainingapp-desktop' self-reference; SRC-10c bans
    // every .wasm load. All are EMPTY at base 5d1f7338 (recorded base
    // facts, re-verified below).
    // Round 12 (plan Revision 13 SRC-10'): class (b) is now RESOLVED-target
    // based — the walk-up emulation below pins how each base package load
    // actually resolves (root identity + target file), and the two nested
    // node_modules shadows plus the NODE_PATH subpath route of
    // repro/critic-round12-probes.out are self-test rows above.
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    const tree = treeOfFiles(files);
    const sites = loadSitesOf(files);
    const scanSet = src10ScanSetOf(tree, MAIN_DIR);
    expect(scanSet.size, 'the scanned source set is exactly the walked files').toBe(files.length);
    // Anti-vacuity: the gate really CLASSIFIED this tree's loads. Base
    // 5d1f7338 counts per class (repro/scan-selfcheck-v2.mjs section 4m
    // prints the same numbers): source 120 (every local edge is a walked
    // compiled-layout twin), package 27 (the eleven classified packages
    // across their load sites), builtin 108, json 0 (the allowlist is
    // EMPTY), computed 0 (that allowlist is EMPTY too) — and NO finding
    // kind.
    const counts = src10ClassCountsOfSites(sites, scanSet, MAIN_DIR, src10BaseNodeResolutions());
    expect(counts.source ?? 0, 'class (a): local edges resolved to walked in-tree sources').toBeGreaterThan(100);
    expect(counts.package ?? 0, 'class (b): loads resolving to classified, canonically-rooted third-party packages').toBeGreaterThan(20);
    expect(counts.builtin ?? 0, 'class (c): loads of classified built-ins').toBeGreaterThan(50);
    expect(counts.json ?? 0, 'class (d): allowlisted .json loads (EMPTY allowlist at base)').toBe(0);
    expect(counts.computed ?? 0, 'computed sites (the computed leg, EMPTY allowlist at base)').toBe(0);
    expect(
      Object.keys(counts).sort(),
      'the base tree takes ONLY pass classes (no finding kind appears in the classification profile)',
    ).toEqual(['builtin', 'package', 'source']);
    // SRC-10' base-resolution table (round 12): how each of the 27 package
    // load sites of desktop/main actually resolves. Every row resolves via
    // the WALK-UP to the CANONICAL desktop/node_modules/<name> root (11
    // distinct roots — the classified packages) and to an in-root
    // .js/.mjs/.cjs/.json file: jszip's extensionless main './lib/index'
    // probes to lib/index.js; xlsx (the file: TARBALL) resolves
    // desktop/node_modules/xlsx itself; pdfjs-dist's subpath hits the exact
    // legacy/build/pdf.mjs file; ajv/dist/2020 hits dist/2020.js; the
    // exports-bearing packages (better-sqlite3, sqlite-vec, node-llama-cpp,
    // @huggingface/transformers, xlsx) resolve through their exports maps.
    // No row reaches NODE_PATH or stays unresolved.
    const packageRows = src10PackageResolutionsOfSites(sites, MAIN_DIR);
    expect(packageRows.length, "SRC-10' anti-vacuity: the tree resolves its package load sites (27 at base 5d1f7338; 26 on the planned head — amendment (z9) absent-OR-exact)").toBe(expectedPackageRowCount());
    expect(new Set(packageRows.map((r) => r.via)), "every base package load resolves via the walk-up (no NODE_PATH candidate, nothing unresolved)").toEqual(new Set(['resolved']));
    expect(new Set(packageRows.map((r) => r.root)), 'every base package load resolves to its CANONICAL desktop/node_modules root (the eleven classified packages)').toEqual(
      new Set(Object.keys(THIRD_PARTY_PACKAGE_CLASSIFICATION).map((name) => `node_modules/${name}`)),
    );
    expect(packageRows.filter((r) => r.name === 'xlsx').every((r) => r.root === 'node_modules/xlsx'), 'the file: TARBALL xlsx resolves to the canonical directory (a tarball install materialises under desktop/node_modules)').toBe(true);
    expect(packageRows.every((r) => SRC10_PACKAGE_FILE_EXTENSIONS.includes(path.extname(r.target).toLowerCase())), 'every resolved package target is a .js/.mjs/.cjs/.json file').toBe(true);
    expect([...new Set(packageRows.filter((r) => r.specifier === 'ajv/dist/2020').map((r) => r.target))], "pinned: ajv/dist/2020 resolves to dist/2020.js today (no exports map; the exact subpath file; both load sites)").toEqual(['node_modules/ajv/dist/2020.js']);
    // Round-12 base facts: no node_modules under desktop/main (nothing
    // inside the tree can shadow a package name from the walk-up), and no
    // NODE_PATH in repo config (neither package.json nor any .npmrc).
    expect(fs.existsSync(path.join(MAIN_DIR, 'node_modules')), 'base fact: NO node_modules directory under desktop/main').toBe(false);
    const repoRoot = path.resolve(MAIN_DIR, '..', '..');
    const manifests = [path.resolve(MAIN_DIR, '..', 'package.json'), path.join(repoRoot, 'package.json')].filter((p) => fs.existsSync(p));
    expect(manifests.length, 'anti-vacuity: the desktop manifest exists').toBeGreaterThan(0);
    for (const manifestPath of manifests) {
      expect(fs.readFileSync(manifestPath, 'utf8').includes('NODE_PATH'), `base fact: no NODE_PATH in ${path.relative(repoRoot, manifestPath).split(path.sep).join('/')}`).toBe(false);
    }
    for (const npmrcPath of [path.join(repoRoot, '.npmrc'), path.resolve(MAIN_DIR, '..', '.npmrc')]) {
      if (fs.existsSync(npmrcPath)) {
        expect(fs.readFileSync(npmrcPath, 'utf8').includes('NODE_PATH'), 'base fact: no NODE_PATH in .npmrc').toBe(false);
      }
    }
    expect(src10FindingsOfSites(sites, scanSet, MAIN_DIR, src10BaseNodeResolutions()), "SRC-10 gate (SRC-10'/SRC-10'' included): loads whose actual target — NODE'S OWN ANSWER for bare packages — is in none of the four classes (EMPTY allowed set)").toEqual([]);
    // SRC-10'' (z5) base fact: NO bare specifier anywhere in desktop/main
    // carries a `node_modules` path segment (the ban's allowed set is EMPTY).
    expect(
      sites.filter((s) => s.specifier !== COMPUTED && !isLocalLoadSpecifier(s.specifier) && src10SpecifierHasInnerNodeModules(s.specifier)),
      "SRC-10'' (z5): bare specifiers with an inner node_modules segment (EMPTY allowed set; none at base)",
    ).toEqual([]);
    expect(src10bDirectoryLoadFindingsOfSites(sites, MAIN_DIR), 'SRC-10b (ii): loads resolved through a directory, unresolved or index-resolved (EMPTY allowed set)').toEqual([]);
    expect(src10bSelfReferenceFindingsOfSites(sites), "SRC-10b (iii): 'trainingapp-desktop' self-reference specifiers (EMPTY allowed set)").toEqual([]);
    expect(src10cWasmLoadFindingsOfSites(sites, MAIN_DIR), 'SRC-10c: loads whose specifier or resolved target ends .wasm (EMPTY allowed set)').toEqual([]);
    expect(src10bPackageJsonFindingsOf(MAIN_DIR), 'SRC-10b (i): package.json files ANYWHERE under desktop/main (EMPTY allowed set)').toEqual([]);
    // Base-fact pins: the self-reference constant names the real desktop
    // package, which carries NO exports (so a self-reference cannot resolve
    // at base) and NO imports (SRC-8's pin, repeated for the route).
    const desktopPackage = JSON.parse(fs.readFileSync(path.resolve(MAIN_DIR, '..', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(desktopPackage.name, 'SRC10_SELF_REFERENCE_PACKAGE names the real desktop package').toBe(SRC10_SELF_REFERENCE_PACKAGE);
    expect(Object.keys(desktopPackage), 'desktop/package.json defines no exports field').not.toContain('exports');
    // The graphify tool cache (desktop/main/graphify-out/cache/stat-index.json,
    // untracked output) is loaded by NOTHING: no load site names it, the
    // scanned source set never contains a .json file (the walk is
    // SOURCE_EXTENSIONS-only) and SRC-10b (i) looks only for package.json —
    // so it appears in NO finding above. Pinned explicitly.
    expect(sites.filter((s) => s.specifier.toLowerCase().includes('stat-index')), 'the graphify cache is never a load target').toEqual([]);
    expect([...scanSet].filter((p) => p.endsWith('.json')), 'no .json file is in the scanned source set').toEqual([]);
  });

  it('S1 (amendment w / SRC-8): no load specifier begins # and desktop/package.json defines no imports field', () => {
    // Round 9 finding 2 (plan Revision 10 SRC-8): a Node package.json
    // `imports` alias can map '#workbook' to an external package — the
    // critic's alias resolved the CANONICAL installed xlsx and parsed a real
    // workbook in-process on Node, Electron-as-Node and a real Electron main
    // process — while packageNameOf silently discarded every '#' specifier.
    // Every cooked '#' load specifier on ANY route is now a finding (EMPTY
    // allowed set); packageNameOf surfaces '#' names to SRC-6 too (pinned by
    // the SRC-6 self-test normalisation rows).
    const files = listTsFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(40); // anti-vacuity, same tree as above
    expect(src8FindingsOfSites(loadSitesOf(files)), "load specifiers beginning '#' (package.json imports aliases; EMPTY allowed set)").toEqual([]);
    // The alias map itself must not exist: desktop/package.json has NO
    // `imports` field (direct assertion).
    const desktopPackage = JSON.parse(fs.readFileSync(path.resolve(MAIN_DIR, '..', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(desktopPackage.name, 'anti-vacuity: this is the desktop package manifest').toBeTypeOf('string');
    expect(Object.keys(desktopPackage), 'desktop/package.json must not define an imports field').not.toContain('imports');
  });

  it('S1 (computed-specifier residual): every load site in desktop/main has a STATIC cooked specifier except the named allowlist', () => {
    // Amendment (h): a load site whose specifier the AST cannot resolve to a
    // static string (an identifier, a call, a concatenation, an interpolated
    // template, `module[key]`) could name a parser library invisibly, so it
    // fails this leg unless it is on COMPUTED_SPECIFIER_ALLOWLIST (empty at
    // base — the comment above it records the round-3 re-capture). An
    // escape-coded LITERAL is not computed any more: it is decoded and
    // judged by the load legs above on its real specifier.
    const files = listTsFiles(MAIN_DIR);
    const sites = loadSitesOf(files);
    // Anti-vacuity (plan R5''): the inventory really resolves this tree's
    // createRequire aliases — update-checker.ts binds
    // `require_ = createRequire(import.meta.url)` and loads two NON-parser
    // modules through it.
    expect(
      sites.filter((s) => s.file === 'update-checker.ts' && s.form === 'alias()').map((s) => s.specifier),
      'update-checker.ts createRequire alias sites are inventoried with their cooked specifiers',
    ).toEqual(['ajv/dist/2020', 'ajv-formats']);
    expect(
      computedSpecifierSites(sites),
      'computed load specifiers must become static literals or be named on the allowlist with a reason',
    ).toEqual(COMPUTED_SPECIFIER_ALLOWLIST);
  });

  it('S1 (amendment i): UNRECOGNISED loader-capability uses across desktop/main equal the base-captured allowlist EXACTLY', () => {
    // Plan R5''' (round 4): the load inventory only visits CallExpression load
    // invocations, so `new require`, `.call/.apply/.bind`, assignment aliases,
    // `Module['createRequire']`, `Module._load` and require-as-a-callback
    // executed past it — every one returning the canonical jszip module. The
    // reference walk fails closed instead: every runtime reference to a loader
    // capability must be a RECOGNISED form (see header note (i)), and the set
    // of unrecognised uses must EXACTLY equal the allowlist captured at base
    // 5d1f7338 (repro/scan-selfcheck-v2.mjs extracts this spec's walk and
    // cross-checks an independent mirror in lockstep). The base tree needed
    // ZERO entries — its only loader capabilities are the five named
    // `createRequire` imports of 'node:module' whose results are only ever
    // directly called with literal specifiers — so this leg is GREEN at base
    // on its own content and turns RED on any new unrecognised use, including
    // one the fix itself introduces. Allowlist entries need a reason; the
    // projection compared below is exact (file, form, fragment).
    const files = listTsFiles(MAIN_DIR);
    const uses = sortedLoaderUses(files);
    expect(
      uses,
      'unrecognised loader-capability uses must be RECOGNISED forms or join the allowlist with a reason',
    ).toEqual(UNRECOGNISED_LOADER_USE_ALLOWLIST.map(({ file, form, fragment }) => ({ file, form, fragment })));
    // Honesty pin: every allowlist entry carries a non-empty reason.
    for (const entry of UNRECOGNISED_LOADER_USE_ALLOWLIST) {
      expect(entry.reason, `allowlist entry ${entry.file} must carry a one-line reason`).toMatch(/\S/);
    }
  });

  it('S1 anti-vacuity: the parsers moved into the doc child (they did not vanish) and the routes survive', () => {
    expect(fs.existsSync(CHILD_SOURCE), 'desktop/main/backend/ingest/doc-worker-child.ts must exist').toBe(true);
    const childText = fs.readFileSync(CHILD_SOURCE, 'utf8');
    const childSites = loadSitesInSource(childText, DOC_CHILD_RELATIVE);
    expect(filesLoading(childSites, MAMMOTH_SPECIFIER), 'the doc child loads mammoth').toEqual([DOC_CHILD_RELATIVE]);
    expect(filesLoading(childSites, JSZIP_SPECIFIER), 'the doc child loads jszip').toEqual([DOC_CHILD_RELATIVE]);
    expect(filesLoading(childSites, PDFJS_SPECIFIER), 'the doc child loads pdfjs-dist').toEqual([DOC_CHILD_RELATIVE]);
    const childCalls = parserCallSitesInSource(childText, DOC_CHILD_RELATIVE);
    expect(childCalls.map((site) => site.name).includes('extractRawText'), 'the doc child calls extractRawText').toBe(true);
    expect(childCalls.map((site) => site.name).includes('loadAsync'), 'the doc child calls loadAsync').toBe(true);
    expect(childCalls.map((site) => site.name).includes('getDocument'), 'the doc child calls getDocument').toBe(true);

    const extractors = stripComments(fs.readFileSync(EXTRACTORS_SOURCE, 'utf8'));
    expect(extractors).toMatch(/export\s+async\s+function\s+extractDocumentFromFile\b/);
    expect(extractors).toContain("'.docx'");
    expect(extractors).toContain("'.pptx'");
    expect(extractors).toContain("'.pdf'");
    expect(extractors, 'extractors.ts delegates the document formats to the runner').toContain('extractDocOutOfProcess');
  });

  it('S2: extractors.ts runs NO parent-side zip cap for any format (the cap moved into the child)', () => {
    const extractors = stripComments(fs.readFileSync(EXTRACTORS_SOURCE, 'utf8'));
    expect(extractors, 'no JSZip in the parent').not.toMatch(/JSZip|jszip/);
    expect(extractors, 'no central-directory read in the parent').not.toContain('loadAsync');
    expect(extractors, 'no declared-size summing in the parent').not.toContain('uncompressedSize');
    expect(extractors, 'no parent-side assertZipWithinCap definition').not.toMatch(
      /function\s+assertZipWithinCap\b|\bassertZipWithinCap\s*[:=]/,
    );
  });
});

describe('#320 AC1 S3: the public entry launches the doc child through the registered seam', () => {
  it('S3: .docx/.pptx launch the child with [absPath, cap]; .pdf with [absPath] only; the child text is adopted', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const pptx = await writeRealPptx(dir);
    const pdf = writePlaceholderPdf(dir);
    const children = [makeFakeChild(), makeFakeChild(), makeFakeChild(), makeFakeChild()];
    const calls = registerFakeLauncher(children);
    const cancels = [
      scriptChild(children[0] as FakeChild, { ok: true, text: 'DOCX-FROM-CHILD' }, 0),
      scriptChild(children[1] as FakeChild, { ok: true, text: 'PPTX-FROM-CHILD' }, 0),
      scriptChild(children[2] as FakeChild, { ok: true, text: 'PDF-FROM-CHILD' }, 0),
      scriptChild(children[3] as FakeChild, { ok: true, text: 'DOCX-NO-CAP' }, 0),
    ];
    try {
      const d = await within(extractDocumentFromFile(docx, { maxZipBytes: TEN_MB }), 5_000);
      const p = await within(extractDocumentFromFile(pptx, { maxZipBytes: TEN_MB }), 5_000);
      const f = await within(extractDocumentFromFile(pdf, { maxZipBytes: TEN_MB }), 5_000);
      const n = await within(extractDocumentFromFile(docx), 5_000);
      expect(d.text).toBe('DOCX-FROM-CHILD');
      expect(p.text).toBe('PPTX-FROM-CHILD');
      expect(f.text).toBe('PDF-FROM-CHILD');
      expect(n.text).toBe('DOCX-NO-CAP');
    } finally {
      for (const cancel of cancels) cancel();
    }

    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.modulePath).toBe(docWorkerChildPath());
    expect(calls[0]?.args).toEqual([path.resolve(docx), String(TEN_MB)]);
    expect(calls[1]?.args).toEqual([path.resolve(pptx), String(TEN_MB)]);
    // .pdf is not a zip container: no cap rides to the child.
    expect(calls[2]?.args).toEqual([path.resolve(pdf)]);
    expect(calls[3]?.args).toEqual([path.resolve(docx)]);
    // Exactly one report per child was delivered and consumed.
    for (const child of children) {
      expect(child.listeners.message).toHaveLength(1);
      expect(child.delivered).toHaveLength(1);
    }
  });

  it('S3: the parent never applies the cap itself — a real docx above the cap and a non-zip pptx both reach the child', async () => {
    // At base the parent-side assertZipWithinCap rejects the first (declares
    // ~1 KB > 100 B) and JSZip throws on the second, before any child exists.
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const notAZip = path.join(dir, 'not-a-zip.pptx');
    fs.writeFileSync(notAZip, 'these bytes are not a zip archive', 'utf8');
    const children = [makeFakeChild(), makeFakeChild()];
    const calls = registerFakeLauncher(children);
    const cancels = [
      scriptChild(children[0] as FakeChild, { ok: true, text: 'ADOPTED-DOCX' }, 0),
      scriptChild(children[1] as FakeChild, { ok: true, text: 'ADOPTED-PPTX' }, 0),
    ];
    try {
      const d = await within(extractDocumentFromFile(docx, { maxZipBytes: 100 }), 5_000);
      const p = await within(extractDocumentFromFile(notAZip, { maxZipBytes: 100 }), 5_000);
      expect(d.text).toBe('ADOPTED-DOCX');
      expect(p.text).toBe('ADOPTED-PPTX');
    } finally {
      for (const cancel of cancels) cancel();
    }
    expect(calls.map((c) => c.args)).toEqual([
      [path.resolve(docx), '100'],
      [path.resolve(notAZip), '100'],
    ]);
  });

  it('S3: plain-text formats stay in-process (no child launched for .md/.txt)', async () => {
    const dir = makeTempDir();
    const md = path.join(dir, 'note.md');
    fs.writeFileSync(md, '# heading\nbody\n', 'utf8');
    const calls = registerFakeLauncher([]);
    const result = await within(extractDocumentFromFile(md), 5_000);
    expect(result.text).toBe('# heading\nbody\n');
    expect(calls).toHaveLength(0);
  });

  it('S3 (amendment e): the PUBLIC route forwards timeoutMs for .docx/.pptx/.pdf — a silent child is reaped at the CALLER deadline', async () => {
    // Critic rev 1: the public extractDocumentFromFile must forward timeoutMs
    // for EVERY document format, not just .xlsx. A silent child plus a short
    // caller deadline proves the forwarding: if the route swallowed
    // timeoutMs, the runner's (much longer) default deadline would hold and
    // the spec guard would trip instead of the runner.
    const dir = makeTempDir();
    const files = [await writeRealDocx(dir), await writeRealPptx(dir), writePlaceholderPdf(dir)];
    const children = files.map(() => makeFakeChild()); // silent: never report, never exit
    registerFakeLauncher(children);
    for (const [i, file] of files.entries()) {
      const startedAt = Date.now();
      const failure = await failureOf(within(extractDocumentFromFile(file, { timeoutMs: 200 }), 10_000));
      expect(failure.message, `${path.extname(file)}: timeoutMs must ride the public route to the runner`).toMatch(
        /timeout|timed out|deadline/i,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(children[i]?.killCalls, `${path.extname(file)}: the silent child must be killed at the caller deadline`).toBeGreaterThanOrEqual(1);
    }
  }, 45_000);

  it('S3 (amendment e): the PUBLIC route forwards childPath for .docx/.pptx/.pdf — the CALLER-SUPPLIED fixture child parses all three', async () => {
    // Critic rev 1: childPath must forward through the public route for
    // every document format. The crashing fixture reports any NON-zip file's
    // bytes verbatim, so plain-text .docx/.pptx/.pdf bodies coming back as
    // text prove each route forked the CALLER'S child (the default doc child
    // would instead parse — or reject — them as real formats).
    setDocWorkerForkFn(null); // outside Electron: the node fork default carries childPath
    const dir = makeTempDir();
    const childPath = writeCrashingFixtureChild(dir);
    const files = ['route.docx', 'route.pptx', 'route.pdf'].map((name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `body of ${name}`, 'utf8');
      return file;
    });
    for (const file of files) {
      const result = await within(extractDocumentFromFile(file, { childPath, timeoutMs: 15_000 }), 20_000);
      expect(result.text, `${path.extname(file)}: childPath must ride the public route`).toBe(`body of ${path.basename(file)}`);
    }
  }, 90_000);

  it('S3 (amendment e): .pdf NEVER receives a cap argument — even with maxZipBytes, timeoutMs and childPath all passed', async () => {
    const dir = makeTempDir();
    const pdf = writePlaceholderPdf(dir);
    const customChild = path.join(dir, 'custom-doc-child.cjs');
    fs.writeFileSync(customChild, '// routing probe only; the fake launcher never runs it\n', 'utf8');
    const children = [makeFakeChild()];
    const calls = registerFakeLauncher(children);
    const cancel = scriptChild(children[0] as FakeChild, { ok: true, text: 'PDF-NO-CAP' }, 0);
    try {
      const result = await within(
        extractDocumentFromFile(pdf, { maxZipBytes: TEN_MB, timeoutMs: 5_000, childPath: customChild }),
        10_000,
      );
      expect(result.text).toBe('PDF-NO-CAP');
    } finally {
      cancel();
    }
    expect(calls[0]?.modulePath, 'the caller-supplied childPath must reach the launcher for .pdf too').toBe(customChild);
    expect(calls[0]?.args, '.pdf is not a zip container: no cap rides to the child, ever').toEqual([path.resolve(pdf)]);
  }, 20_000);

  it('S3: inside Electron with NO registered launcher the runner REFUSES — no in-process fallback for any doc format', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const pptx = await writeRealPptx(dir);
    const pdf = writePlaceholderPdf(dir);
    setDocWorkerForkFn(null);
    await asElectron(async () => {
      const direct = await failureOf(within(extractDocOutOfProcess(docx), 5_000));
      expect(direct.message).toMatch(WORKER_PREFIX);
      expect(direct.message).toMatch(/refus/i);
      for (const file of [docx, pptx, pdf]) {
        const viaPublic = await failureOf(within(extractDocumentFromFile(file, { maxZipBytes: TEN_MB }), 5_000));
        expect(viaPublic.message, `${path.extname(file)} must refuse, not parse in-process`).toMatch(WORKER_PREFIX);
      }
    });
  });
});

describe('#320 AC1 S4: a poisoned / crashing child is contained', () => {
  it('S4 (fake seam): a child that exits non-zero with NO report rejects naming the exit code; the next extraction works', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const children = [makeFakeChild(), makeFakeChild()];
    registerFakeLauncher(children);
    const cancelCrash = scriptChild(children[0] as FakeChild, undefined, 3);
    const failure = await failureOf(within(extractDocumentFromFile(docx), 5_000)).finally(cancelCrash);
    expect(failure.message).not.toMatch(/timed out/i);
    expect(failure.message).toMatch(/exit/i);
    expect(failure.message).toMatch(/\b3\b/);

    const cancelOk = scriptChild(children[1] as FakeChild, { ok: true, text: 'healthy after crash' }, 0);
    try {
      const next = await within(extractDocumentFromFile(docx), 5_000);
      expect(next.text).toBe('healthy after crash');
    } finally {
      cancelOk();
    }
  });

  it('S4 (fake seam): a report-derived failure carries the `doc worker:` prefix and the child reason', async () => {
    const dir = makeTempDir();
    const pptx = await writeRealPptx(dir);
    const children = [makeFakeChild()];
    registerFakeLauncher(children);
    const cancel = scriptChild(children[0] as FakeChild, { ok: false, error: 'parser blew up (spec)' }, 1);
    const failure = await failureOf(within(extractDocumentFromFile(pptx), 5_000)).finally(cancel);
    expect(failure.message).toMatch(WORKER_PREFIX);
    expect(failure.message).toContain('parser blew up (spec)');
  });

  it('S4 (fake seam): a malformed report ({ok:true} without text) rejects; a throwing launcher rejects with its error', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const children = [makeFakeChild()];
    registerFakeLauncher(children);
    const cancel = scriptChild(children[0] as FakeChild, { ok: true }, 0);
    await failureOf(within(extractDocOutOfProcess(docx, { timeoutMs: 5_000 }), 10_000)).finally(cancel);

    setDocWorkerForkFn(() => {
      throw new Error('doc worker failed to launch (spec)');
    });
    const launch = await failureOf(within(extractDocOutOfProcess(docx), 5_000));
    expect(launch.message).toMatch(/failed to launch \(spec\)/);
  });

  it('S4 (amendment d): report VALIDATION — malformed text/pages reject with the `doc worker:` prefix and are never adopted', async () => {
    // Critic rev 1: the runner must VALIDATE {text, pages?} reports rather
    // than cast them. Every malformed shape below is delivered as a
    // {ok:true} report followed by a clean exit 0; the runner must still
    // REJECT it with the `doc worker:` prefix — never adopt it.
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const malformed: Array<{ label: string; report: unknown }> = [
      { label: 'text is a number', report: { ok: true, text: 123 } },
      { label: 'text is null', report: { ok: true, text: null } },
      { label: 'pages is a string', report: { ok: true, text: 't', pages: '1,2' } },
      { label: 'pages is an object', report: { ok: true, text: 't', pages: { 1: 'x' } } },
      { label: 'page entry lacks pageNumber', report: { ok: true, text: 't', pages: [{ text: 'no number' }] } },
      { label: 'pageNumber is a string', report: { ok: true, text: 't', pages: [{ pageNumber: '2', text: 'x' }] } },
      { label: 'page entry lacks text', report: { ok: true, text: 't', pages: [{ pageNumber: 3 }] } },
      { label: 'page text is a number', report: { ok: true, text: 't', pages: [{ pageNumber: 4, text: 56 }] } },
      {
        label: 'one malformed page among valid ones',
        report: { ok: true, text: 't', pages: [{ pageNumber: 1, text: 'ok' }, { pageNumber: [], text: 'x' }] },
      },
      // Amendment (g) / R1': typeof NaN and typeof Infinity are 'number', so
      // a `typeof` check would adopt these; finiteness (Number.isFinite) must
      // reject them. Both survive structured clone, so a real child report
      // carries them across IPC unchanged; the fake seam emits the objects
      // directly, which is faithful for these values.
      { label: 'pageNumber is NaN', report: { ok: true, text: 't', pages: [{ pageNumber: Number.NaN, text: 'x' }] } },
      {
        label: 'pageNumber is Infinity',
        report: { ok: true, text: 't', pages: [{ pageNumber: Number.POSITIVE_INFINITY, text: 'x' }] },
      },
    ];
    for (const { label, report } of malformed) {
      const children = [makeFakeChild()];
      registerFakeLauncher(children);
      const cancel = scriptChild(children[0] as FakeChild, report, 0);
      const failure = await failureOf(within(extractDocOutOfProcess(docx, { timeoutMs: 5_000 }), 10_000)).finally(cancel);
      expect(failure.message, `${label}: a malformed report must be REJECTED, never adopted`).toMatch(WORKER_PREFIX);
      expect(children[0]?.delivered, `${label}: the malformed report really reached the runner`).toHaveLength(1);
    }
  }, 60_000);

  it('S4 (amendment d): a VALID {ok:true,text,pages} report is adopted with pages intact', async () => {
    const dir = makeTempDir();
    const pptx = await writeRealPptx(dir);
    const pages = [
      { pageNumber: 1, text: 'first page & more' },
      { pageNumber: 2, text: 'second page' },
    ];
    const children = [makeFakeChild()];
    registerFakeLauncher(children);
    const cancel = scriptChild(children[0] as FakeChild, { ok: true, text: 'PAGES-INTACT', pages }, 0);
    try {
      const result = await within(extractDocumentFromFile(pptx, { maxZipBytes: TEN_MB }), 5_000);
      expect(result.text).toBe('PAGES-INTACT');
      expect(result.pages, 'validation must not strip or mangle valid pages').toEqual(pages);
    } finally {
      cancel();
    }
  });

  it('S4 (real node fork): a crashing fixture child rejects in isolation and the parent serves the next file', async () => {
    const dir = makeTempDir();
    const childPath = writeCrashingFixtureChild(dir);
    const poisoned = path.join(dir, 'poisoned.docx');
    fs.writeFileSync(poisoned, Buffer.from('PK\x03\x04 garbage not a zip', 'latin1'));
    const healthy = path.join(dir, 'healthy.docx');
    fs.writeFileSync(healthy, 'plain healthy text', 'utf8');
    setDocWorkerForkFn(null); // outside Electron: the node fork default

    const failure = await failureOf(within(extractDocOutOfProcess(poisoned, { childPath, timeoutMs: 15_000 }), 20_000));
    expect(failure.message).toMatch(/exit/i);
    expect(failure.message).toContain('2');

    const next = await within(extractDocOutOfProcess(healthy, { childPath, timeoutMs: 15_000 }), 20_000);
    expect(next.text).toBe('plain healthy text');
  }, 60_000);
});

describe('#320 AC1 S5: a hung child is killed at the deadline (settle-on-exit lifecycle)', () => {
  it('S5: a silent fake child is killed at the deadline and the extraction rejects quickly', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const children = [makeFakeChild()]; // never reports, never exits
    registerFakeLauncher(children);
    const startedAt = Date.now();
    const failure = await failureOf(within(extractDocOutOfProcess(docx, { timeoutMs: 200 }), 10_000));
    expect(failure.message).toMatch(/timeout|timed out|deadline/i);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(children[0]?.killCalls).toBeGreaterThanOrEqual(1);
  });

  it('S5: a report that never exits does NOT settle — the deadline reaps the child', async () => {
    const dir = makeTempDir();
    const pdf = writePlaceholderPdf(dir);
    const children = [makeFakeChild()];
    registerFakeLauncher(children);
    const cancel = scriptChild(children[0] as FakeChild, { ok: true, text: 'never settled' }, null);
    const failure = await failureOf(within(extractDocOutOfProcess(pdf, { timeoutMs: 300 }), 10_000)).finally(cancel);
    expect(failure.message).toMatch(/timeout|timed out|deadline/i);
    expect(children[0]?.killCalls, 'a reported-but-unexited child must be reaped').toBeGreaterThanOrEqual(1);
  });

  it('S5: a report followed by exit 0 resolves (settle on exit); exit 0 with NO report rejects within 2 s', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const children = [makeFakeChild(), makeFakeChild()];
    registerFakeLauncher(children);
    const cancelOk = scriptChild(children[0] as FakeChild, { ok: true, text: 'settled on exit' }, 0);
    try {
      const result = await within(extractDocOutOfProcess(docx, { timeoutMs: 5_000 }), 10_000);
      expect(result.text).toBe('settled on exit');
    } finally {
      cancelOk();
    }

    const cancelSilent = scriptChild(children[1] as FakeChild, undefined, 0);
    const startedAt = Date.now();
    await failureOf(within(extractDocOutOfProcess(docx, { timeoutMs: 30_000 }), 10_000)).finally(cancelSilent);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(2_000);
  });

  it('S5 escalation: at the deadline the runner calls kill() once, then exactly once more after the 2 s grace', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const killTimes: number[] = [];
    const fakeChild = makeFakeChild(); // never reports, never exits, ignores kill
    const baseKill = fakeChild.kill.bind(fakeChild);
    fakeChild.kill = (): boolean => {
      killTimes.push(Date.now());
      return baseKill();
    };
    registerFakeLauncher([fakeChild]);

    const startedAt = Date.now();
    const failure = await failureOf(within(extractDocOutOfProcess(docx, { timeoutMs: 200 }), 10_000));
    expect(failure.message).toMatch(/timed out/i);
    expect(fakeChild.killCalls, 'exactly one kill at the deadline').toBe(1);
    expect((killTimes[0] ?? 0) - startedAt).toBeGreaterThanOrEqual(150);

    await waitFor(() => fakeChild.killCalls >= 2, 'the escalation kill after the grace', 5_000);
    expect((killTimes[1] ?? 0) - (killTimes[0] ?? 0), 'the second kill waits out the 2 s grace').toBeGreaterThanOrEqual(1_900);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(fakeChild.killCalls, 'exactly two kills in total').toBe(2);
  }, 20_000);

  it('S5 (real OS process): a REAL hung child is killed at the deadline and its process is gone', async () => {
    const dir = makeTempDir();
    const hungFixture = writeNeverExitingChild(dir);
    const input = path.join(dir, 'never parsed.pdf');
    fs.writeFileSync(input, '%PDF-1.4\n', 'latin1');
    const recorded: Array<{ pid?: number }> = [];
    setDocWorkerForkFn((modulePath: string, args: string[]): DocWorkerChild => {
      const cp = fork(modulePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      recorded.push(cp);
      const onAny = (event: string, cb: (value: unknown) => void): unknown => {
        (cp as unknown as { on(e: string, l: (...a: unknown[]) => void): unknown }).on(event, cb as never);
        return cp;
      };
      return {
        on: onAny as unknown as DocWorkerChild['on'],
        kill: (): unknown => cp.kill(),
      } as DocWorkerChild;
    });

    const failure = await failureOf(within(extractDocOutOfProcess(input, { childPath: hungFixture, timeoutMs: 500 }), 15_000));
    expect(failure.message).toMatch(/timeout|timed out|deadline/i);
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
  }, 30_000);
});

describe('#320 AC1 S6/S7: the REAL production child parses real documents; the cap is enforced in the child', () => {
  it('S6: node fork + default childPath parse a real .docx and a real .pptx (path with a space) to the pre-migration text', async () => {
    setDocWorkerForkFn(null); // outside Electron: the node fork default
    const dir = makeTempDir('doc parity ');
    const docx = await writeRealDocx(dir, 'real copy.docx');
    const pptx = await writeRealPptx(dir, 'real copy.pptx');

    const directDocx = await within(extractDocOutOfProcess(docx, { timeoutMs: 60_000 }), 90_000);
    expect(directDocx.text).toBe(DOCX_TEXT);
    const directPptx = await within(extractDocOutOfProcess(pptx, { timeoutMs: 60_000 }), 90_000);
    expect(directPptx.text).toBe(PPTX_TEXT);

    const publicDocx = await within(extractDocumentFromFile(docx, { maxZipBytes: TEN_MB }), 90_000);
    expect(publicDocx.text).toBe(DOCX_TEXT);
    const publicPptx = await within(extractDocumentFromFile(pptx, { maxZipBytes: TEN_MB }), 90_000);
    expect(publicPptx.text).toBe(PPTX_TEXT);
    // Per-slide pages feed the chunker's page attribution: they survive the move.
    expect(publicPptx.pages).toEqual(PPTX_PAGES);
  }, 120_000);

  it('S7: runDocChildMain parses a docx/pptx and enforces the cap ITSELF, reporting `doc worker:` (role-based argv)', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const pptx = await writeRealPptx(dir);
    expect(DOC_WORKER_ERROR_PREFIX).toBe('doc worker: ');

    const run = async (argv: string[]): Promise<{ code: number; report: Record<string, unknown> }> => {
      const posted: unknown[] = [];
      const channel = { postMessage: (message: unknown): void => void posted.push(message) };
      const code = await runDocChildMain(argv, channel);
      expect(posted, `exactly one report for ${JSON.stringify(argv.slice(2))}`).toHaveLength(1);
      return { code, report: posted[0] as Record<string, unknown> };
    };

    const okDocx = await run(['node', 'doc-worker-child', docx]);
    expect(okDocx.code).toBe(0);
    expect(okDocx.report.ok).toBe(true);
    expect(okDocx.report.text).toBe(DOCX_TEXT);

    const okCapped = await run(['node', 'doc-worker-child', pptx, String(TEN_MB)]);
    expect(okCapped.code).toBe(0);
    expect(okCapped.report.ok).toBe(true);
    expect(okCapped.report.text).toBe(PPTX_TEXT);

    for (const file of [docx, pptx]) {
      const capped = await run(['node', 'doc-worker-child', file, '100']);
      expect(capped.code).not.toBe(0);
      expect(capped.report.ok).toBe(false);
      expect(typeof capped.report.error).toBe('string');
      expect(capped.report.error as string).toMatch(WORKER_PREFIX);
      expect(capped.report.error as string).toMatch(/cap/i);
    }

    // An unsupported extension is refused by the child, never guessed.
    const txt = path.join(dir, 'plain.txt');
    fs.writeFileSync(txt, 'not a document format', 'utf8');
    const unsupported = await run(['node', 'doc-worker-child', txt]);
    expect(unsupported.code).not.toBe(0);
    expect(unsupported.report.ok).toBe(false);
    expect(unsupported.report.error as string).toMatch(WORKER_PREFIX);
  }, 60_000);

  it('S7: end to end through the real child, a cap below the document size rejects with the CHILD-reported prefix', async () => {
    setDocWorkerForkFn(null);
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const failure = await failureOf(within(extractDocumentFromFile(docx, { maxZipBytes: 100 }), 90_000));
    expect(failure.message).toMatch(/cap/i);
    expect(failure.message, 'the cap rejection must come from the child report').toMatch(WORKER_PREFIX);
  }, 120_000);
});

describe('#320 AC1 S8: bootstrap registers the utilityProcess launcher for the doc worker', () => {
  const forkMock = utilityProcess.fork as unknown as ReturnType<typeof vi.fn>;
  const hermeticUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-utility-userdata-'));

  /** A utility child that posts `report` (when given) then exits `code`. */
  function scriptedFork(report: Record<string, unknown> | undefined, code = 0) {
    return (modulePath: string, args?: string[], options?: Record<string, unknown>) => {
      const child = new FakeUtilityProcess(modulePath, args ?? [], options);
      setImmediate(() => {
        if (report !== undefined) child.emit('message', report);
        child.emit('exit', code);
      });
      return child;
    };
  }

  /** bootstrap() and wait until the whenReady block has registered the parse launchers. */
  async function bootstrapAndWait(): Promise<void> {
    bootstrap();
    // The xlsx registration sits in the same whenReady block the doc
    // registration must join; once it is visible the block has run.
    await waitFor(() => resolveXlsxWorkerForkFn(true) !== null, 'parse-launcher registration');
  }

  beforeEach(() => {
    __resetElectronStub();
    app.getPath.mockImplementation((name: string) => (name === 'userData' ? hermeticUserData : process.cwd()));
    __resetTransportSecurityForTests();
    setDocWorkerForkFn(null);
    setXlsxWorkerForkFn(null);
  });

  afterEach(async () => {
    app.emit('will-quit');
    await new Promise((resolve) => setTimeout(resolve, 50));
    setDocWorkerForkFn(null);
    setXlsxWorkerForkFn(null);
  });

  afterAll(() => {
    fs.rmSync(hermeticUserData, { recursive: true, force: true });
  });

  it('S8 source pin: desktop/main/index.ts registers setDocWorkerForkFn with utilityProcess.fork inside app.whenReady', () => {
    const source = stripComments(fs.readFileSync(MAIN_INDEX_SOURCE, 'utf8'));
    const whenReadyAt = source.indexOf('app.whenReady()');
    const registerAt = source.indexOf('setDocWorkerForkFn(');
    expect(whenReadyAt).toBeGreaterThanOrEqual(0);
    expect(registerAt, 'index.ts must call setDocWorkerForkFn(').toBeGreaterThan(whenReadyAt);
    const registration = source.slice(registerAt, registerAt + 600);
    expect(registration).toMatch(/utilityProcess\.fork\(/);
    expect(registration).toMatch(new RegExp(`['"\`]${SERVICE_NAME}['"\`]`));
    expect(registration).toMatch(/stdio:\s*\[\s*['"]ignore['"]\s*,\s*['"]ignore['"]\s*,\s*['"]pipe['"]\s*\]/);
  });

  it('S8: a .docx extraction with NO explicit launcher forks the doc child through electron utilityProcess and adopts its report', async () => {
    await bootstrapAndWait();
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    forkMock.mockImplementation(scriptedFork({ ok: true, text: 'X' }));
    forkMock.mockClear();

    // As if inside Electron: an unregistered doc launcher would REFUSE here,
    // so only the bootstrap registration can carry this call.
    const result = await asElectron(() => within(extractDocumentFromFile(docx), 10_000));
    expect(result.text).toBe('X');

    expect(forkMock).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = forkMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(modulePath).toBe(docWorkerChildPath());
    expect(args[0]).toBe(path.resolve(docx));
    expect(options.serviceName).toBe(SERVICE_NAME);
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(options).not.toHaveProperty('env');
    expect(JSON.stringify(options)).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('S8 failure (stub contract): a utilityProcess doc child that exits non-zero with NO report rejects naming the exit code', async () => {
    await bootstrapAndWait();
    const dir = makeTempDir();
    const pdf = writePlaceholderPdf(dir);
    forkMock.mockImplementation(scriptedFork(undefined, 3));
    forkMock.mockClear();

    const failure = await asElectron(() => failureOf(within(extractDocOutOfProcess(pdf, { timeoutMs: 10_000 }), 15_000)));
    expect(forkMock, 'the registered utilityProcess launcher carried the call').toHaveBeenCalledTimes(1);
    expect(failure.message).not.toMatch(/timed out/i);
    expect(failure.message).toMatch(/exit/i);
    expect(failure.message).toMatch(/\b3\b/);
  });

  it('S8 failure (stub contract): a silent utilityProcess doc child hits the deadline and is killed', async () => {
    await bootstrapAndWait();
    const dir = makeTempDir();
    const pptx = await writeRealPptx(dir);
    const children: FakeUtilityProcess[] = [];
    forkMock.mockImplementation((modulePath: string, args?: string[], options?: Record<string, unknown>) => {
      const child = new FakeUtilityProcess(modulePath, args ?? [], options);
      children.push(child);
      return child;
    });
    forkMock.mockClear();

    const startedAt = Date.now();
    const failure = await asElectron(() => failureOf(within(extractDocOutOfProcess(pptx, { timeoutMs: 300 }), 10_000)));
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(failure.message).toMatch(/timeout|timed out|deadline/i);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(children).toHaveLength(1);
    expect(children[0]?.kill, 'the silent utilityProcess child must be killed').toHaveBeenCalled();
  });
});

describe('#320 AC1 S9/S10: host stop() and terminateDocWorkers own every live doc child', () => {
  let host: NodeBackendHost | null = null;

  afterEach(async () => {
    terminateDocWorkers();
    if (host !== null) {
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it('S9: NodeBackendHost.stop() kills the live doc child and rejects the pending extraction', async () => {
    host = new NodeBackendHost({
      token: 'i320-doc-host-stop-token',
      engine: new StubEngine(),
    });
    await host.start();

    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const fakeChild = makeFakeChild(); // never reports, never exits
    const calls = registerFakeLauncher([fakeChild]);

    const pending = extractDocumentFromFile(docx);
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
    await waitFor(() => calls.length === 1, 'doc child launch');
    expect(fakeChild.killCalls, 'harness sanity: nothing killed the child before stop()').toBe(0);

    const stopping = host;
    host = null;
    await stopping.stop();

    await within(observed, 5_000).catch(() => {});
    expect(settled, 'host stop() must settle the in-flight extraction (stop() wiring)').toBe(true);
    expect(failure, 'the in-flight extraction must REJECT after host stop').toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect(fakeChild.killCalls, 'host stop() must kill the live doc child').toBeGreaterThanOrEqual(1);
  });

  it('S10: terminateDocWorkers kills EVERY live doc child and rejects every in-flight extraction; the seam keeps working', async () => {
    const dir = makeTempDir();
    const docx = await writeRealDocx(dir);
    const pdf = writePlaceholderPdf(dir);
    const pptx = await writeRealPptx(dir);
    const children = [makeFakeChild(), makeFakeChild(), makeFakeChild(), makeFakeChild()];
    const calls = registerFakeLauncher(children);

    const outcomes: Array<{ settled: boolean; failure?: unknown }> = [];
    const observe = (p: Promise<unknown>): Promise<void> => {
      const slot: { settled: boolean; failure?: unknown } = { settled: false };
      outcomes.push(slot);
      return p.then(
        () => {
          slot.settled = true;
        },
        (err: unknown) => {
          slot.failure = err;
          slot.settled = true;
        },
      );
    };
    const all = Promise.all([
      observe(extractDocumentFromFile(docx)),
      observe(extractDocumentFromFile(pdf)),
      observe(extractDocumentFromFile(pptx)),
    ]);
    await waitFor(() => calls.length === 3, 'three doc children launched');
    terminateDocWorkers();
    await within(all, 5_000).catch(() => {});

    for (const [i, outcome] of outcomes.entries()) {
      expect(outcome.settled, `extraction #${i} must settle after terminateDocWorkers()`).toBe(true);
      expect(outcome.failure, `extraction #${i} must reject after terminateDocWorkers()`).toBeInstanceOf(Error);
      expect(children[i]?.killCalls, `child #${i} must be killed`).toBeGreaterThanOrEqual(1);
    }

    // The runner survives the mass termination: the next extraction works.
    const cancel = scriptChild(children[3] as FakeChild, { ok: true, text: 'after terminate' }, 0);
    try {
      const next = await within(extractDocumentFromFile(docx), 5_000);
      expect(next.text).toBe('after terminate');
    } finally {
      cancel();
    }
  });
});
