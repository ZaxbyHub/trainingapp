// audit-outbox-production.test.ts — frozen check C4 (the desktop half of #373:
// production audit wiring), rev 19 (plan Part 4 v26).
//
// What this file proves, EXECUTABLY, against the REAL production modules: the
// engineOverrides and startup compositions of desktop/main/backend-config.ts (the
// custody sink and the pack sink, the live getStore resolver), the startup-built
// pack sink aligned on ONE database (registry + envelope on one fresh connection,
// the real rebindStore swap path, an in-tx rollback witness), the sink factories
// resolver validation, the gen_high high-water legs (restore max-merge incl. the
// REVERSED orderings; journal-only / backup / crash restores), concurrent atomic
// binds with stale-generation refusal, beginRequest swap & concurrency, and the
// journal fallback (#373 AC1 — R6-4, R7-5, R8-6, R9-3, R9-6, R10-1, R10-3,
// R11-1, R11-2, R11-6, R12-3, R12-6, R13-2, R13-4, R14-3).
//
// Every production module the legs drive is NEW-SURFACE: absent at base, so each
// leg is RED there for the right reason — its first module-absence assertion — and
// the source-level pin (the last test) is RED at its module-bound import assertion
// (the pre-fix index.ts holds ZERO buildProductionStartup references; the finder
// also fails closed on wrong-module and unresolved-module shapes) until Phase 4
// lands the code.
//
// Harness contract (declared for the implementer — plan Part 4 v12 items
// 1-5; where the plan names only semantics, THIS spec binds the names):
//   1. desktop/main/backend-config.ts exports buildProductionEngineOverrides(
//      opts): PURE — the index.ts:399-424 shape { userDataPath,
//      gpuVerdictDir?, models?, externalProvider: { secretStore, airgap,
//      auditSink } }, every input passing through Object.is-identical.
//   2. desktop/main/backend/audit-outbox.ts exports createProductionAuditSink(
//      getStore, notify) and bindOutboxBinding(store, prefix, sender?) (the
//      companion item-5 contract: sender-set semantics + the INDEPENDENT
//      gen_high high-water; the binding carrier row is the table
//      audit_outbox_binding = { prefix, generation, senders }), and
//      createProductionCustodySink(getStore, notify?) → { beginRequest():
//      { capture, flush, discard } } — the R9-3 REQUEST-SCOPED batch view.
//      BOTH factories validate `typeof getStore === 'function'` and THROW
//      on null, undefined, or any non-callable value (R11-2, leg 25). The
//      bridge-call gates readOutboxPending(store, generation, sender) and
//      ackOutboxEvent(store, generation, sender, eventId) validate generation
//      matches the CURRENT binding AND sender ∈ set (the composition file's
//      declared names); a stale-lower generation is REJECTED, error naming it.
//   3. Journal + clear API (leg 15): captureClear(store) — one BEGIN
//      IMMEDIATE: clear_gen + 1, clear_seq = next_seq - 1, pending delete;
//      writeAuditJournalFallback(store, journalPath, envelope) — tmp+rename
//      MERGE of a fallback entry { envelope, gen } (gen = the CURRENT
//      clear_gen at call time) into a journal file that also carries the
//      SOURCE store's high-waters — seq_high AND gen_high (rev 7, R12-6:
//      the plan Part 4 v13 item 2 journal schema = pending +
//      watermark(clear_seq/clear_at/clear_gen) + binding + seq_high +
//      gen_high, so a restore can max-merge the generation high-water);
//      consumeAuditJournal(store, journalPath) —
//      install max-based watermarks (gen_high max-merges like clear_gen),
//      seed next_seq = max(next_seq, journal.seq_high, COALESCE(max(seq),0)+1),
//      DISCARD fallback entries with entry.gen < current clear_gen, insert
//      survivors with FRESH allocations above the seeded floor.
//   4. Custody reset coverage: one envelope per reset key whose path changed
//      custody state; non-custody keys emit nothing.
//   5. (rev 6, R11-2) desktop/main/backend-config.ts ALSO exports
//      buildProductionStartup(opts) → { engineOverrides, hostConfig } — the
//      COMPLETE startup composition extracted from index.ts:398-477, built
//      TOGETHER. opts = the injectable Electron/host/store dependencies:
//      { userDataPath, storePath, externalAirgap, models?, secretStore,
//      token, tokenHeaderName, allowedOrigins?, packsRoot, storeBackupsDir?,
//      onIngestProgress?, onMemoryEvent?, onStoreCorruption?, onGiveUp? } —
//      NO resolver argument and NO sink argument exists. engineOverrides is
//      the buildProductionEngineOverrides product with
//      externalProvider.auditSink = the REAL createProductionCustodySink
//      product; hostConfig is the buildProductionBackendHostConfig field
//      set (the createBackendHost config MINUS the engine — the caller
//      resolves the engine between the halves, index.ts:424) with auditSink
//      = the REAL createProductionAuditSink product. BOTH sinks share ONE
//      internal getStore resolver that closes over the STORE MODULE's
//      current-store state: desktop/main/backend/store/sqlite-store.ts
//      maintains a module-level current handle — every openStore return
//      registers the opened handle as current (a later open supersedes; the
//      Clear Cache reopen path) and the module exports
//      getCurrentStoreHandle() for wiring proof. The pack half is DURABLY
//      behavioral (rev 7, R12-3): a REAL pack commit through a host built
//      from hostConfig lands exactly one pack_install/pack_remove envelope
//      in the CURRENT store's audit_outbox (fresh-connection read) and
//      follows the store swap — a no-op `{ emit() {} }` sink, or a manually
//      constructed/injected sink, does not satisfy the executable pack leg.
//      (rev 9, R14-3) the pack half is also ALIGNED: every pack leg's
//      manager and sink share ONE database handle — the install commits on
//      the host's OWN store (both the packs-registry mutation and its
//      envelope asserted together on ONE fresh connection), and a store
//      swap rebinds the manager through the REAL rebindStore call the
//      host's setStore callback performs (backend/index.ts:1151-1158)
//      before the next commit; cross-database durable rows (a registry
//      commit on the manager's store with the envelope read from another)
//      are NOT evidence, and an in-tx envelope-append failure (the
//      BEFORE-INSERT RAISE(ABORT) trigger) rolls the registry mutation back
//      WITH the envelope (plan Part 4 v15 item 4).
//   6. (rev 6, R11-6) the binding-generation high-water lives in its OWN
//      dedicated durable row — a row of the seq_meta table (key TEXT
//      PRIMARY KEY, value INTEGER — the plan Part 4 v12 item 1 `next_seq`
//      home) keyed `gen_high` — NEVER inside the removable
//      audit_outbox_binding row; every bind/rebind/invalidate reads and
//      increments it inside the SAME single BEGIN IMMEDIATE that writes the
//      binding. (rev 7, R12-6) gen_high additionally MAX-MERGES across
//      restore: consumeAuditJournal installs max(store, journal) and a
//      backup-restore reopen preserves the counter — a fresh bind after
//      binding-row removal allocates strictly above the merged MAX (plan
//      Part 4 v13 item 5); dropping/zeroing it on any restore path fails
//      the rev-7 restore legs. (rev 8, R13-4) the max-merge is EXACT and
//      order-INDEPENDENT: every ordering — journal-largest AND the REVERSED
//      active=12 > journal=9 / backup=11 > journal=9 legs — asserts the
//      post-consume carrier EQUALS the exact MAX BEFORE binding-row removal,
//      then a fresh bind strictly above it; an implementation that
//      overwrites with the journal's value (destination.gen_high =
//      journal.gen_high) or resets to zero fails the REVERSED legs (plan
//      Part 4 v14 item 5).
//   7. (rev 19 — plan Part 4 v26 item 4) THE EXACTLY-ONCE CLAIM, scoped to what a
//      check can verify exactly. Two source-level assertions, in the last test of
//      this file: (a) index.ts statically imports buildProductionStartup from the
//      EXACT module desktop/main/backend-config.ts (module-bound existence — R13-2;
//      wrong-module and unresolved-module shapes FAIL CLOSED); (b) SOURCE CENSUS —
//      the name buildProductionStartup occurs as a USAGE (an identifier outside
//      import/export binding positions, or a whole string literal equal to the name)
//      EXACTLY ONCE across every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs file of the
//      repository outside node_modules, .git, .agents, dist, out, build, coverage,
//      __tests__, tests, test, and e2e — the defining module excluded — and that
//      one usage is a DIRECT CALL in index.ts. The pin is SYNTACTIC: a call under
//      `if (false)` still passes it. What is observed executably is the EFFECT of
//      the call: the custody-routes spec BOOTSTRAP leg runs the REAL index.ts
//      bootstrap with backend-config.ts unmocked, and the host config handed to
//      createBackendHost must carry an audit sink (emit view) — the observable the
//      startup composition exists to provide; under this plan wiring a removed or
//      dead call leaves index.ts without it and fails that assertion.
//      NOT CLAIMED, by design: (i) an invocation synthesized at RUNTIME by dynamic
//      code evaluation or by a separately loaded module instance; (ii) a usage
//      spelled under ANOTHER NAME — an aliased import of the target, or an alias
//      export of the defining module called elsewhere: the census is a census of
//      the literal spelling and does not resolve aliases. No acceptance criterion
//      of #372 or #373 requires either, so neither is a check concern — the
//      implementation diff is reviewed in Phase 4.5/4.6. The rev 16-17 counting
//      spy and the rev 17 mechanism gate are RETIRED WITH their machinery (06
//      Rounds 12-22: every "no invocation by any mechanism" claim was one more
//      executed shape away from false).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LlamaEngine, resolveNodeEngine } from '../../main/backend/inference/llama-engine.js';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';
// Construction capture for the rev-6 startup leg (the composition file's
// wave-4 pattern): a faithful subclass around the REAL PackManager export
// (identical behavior elsewhere; while armed it records the options
// production passed to the constructor — and, rev 7, the CONSTRUCTED
// INSTANCE, so the R12-3 pack leg can drive a REAL install/remove through
// the manager the HOST built with the startup's own sink).
const pmCapture = vi.hoisted(() => ({ armed: false, options: [] as unknown[], instances: [] as unknown[] }));
vi.mock('../../main/backend/store/pack-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/store/pack-manager.js')>();
  const RealPackManager = actual.PackManager;
  return { ...actual, PackManager: class extends RealPackManager {
    constructor(opts: ConstructorParameters<typeof RealPackManager>[0]) {
      if (pmCapture.armed) pmCapture.options.push(opts);
      super(opts);
      if (pmCapture.armed) pmCapture.instances.push(this); // after super(): `this` is legal here
    }
  } };
});

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('repo root not found (marker contracts/api.openapi.yaml)');
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url))); const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const itReal = nativeDepsIt('audit-outbox-production'); const TOKEN = 'audit-outbox-production-token';
const tempDirs: string[] = []; const openStores: Array<{ close(): void }> = []; const openServers: http.Server[] = []; const startedHosts: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (startedHosts.length > 0) await startedHosts.pop()!.stop().catch(() => undefined);
  for (const s of openServers.splice(0)) try { s.close(); } catch { /* closed */ }
  for (const s of openStores.splice(0)) try { s.close(); } catch { /* closed */ }
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir;
}

/** The declared delivery-seam payload (frozen C4's harness contract). */
interface DesktopAuditEnvelope { eventId: string; event: 'pack_install' | 'pack_remove' | 'settings_change'; subject: string; occurredAt: number }
/** Declared NEW-SURFACE contract of desktop/main/backend-config.ts (item 1): PURE. */
interface EngineOverrides { userDataPath: string; gpuVerdictDir?: string; models?: { quality?: string; fast?: string }; externalProvider: { secretStore: unknown; airgap: boolean; auditSink: unknown } }
interface EngineOverridesModule { buildProductionEngineOverrides(opts: EngineOverrides): EngineOverrides }
/** The buildProductionStartup host-config half (rev-6 header item 5): the createBackendHost field set MINUS the engine (the caller resolves the engine between the halves, index.ts:424). */
interface ProductionHostConfig { auditSink: unknown; [field: string]: unknown }
/** Declared NEW-SURFACE contract of desktop/main/backend-config.ts (rev-6 header item 5): the COMPLETE startup composition, built together. */
interface StartupCompositionModule { buildProductionStartup(opts: Record<string, unknown>): { engineOverrides: EngineOverrides; hostConfig: ProductionHostConfig } }
/** The R9-3 request-scoped batch view (header item 2). */
interface CustodyBatch { capture(envelope: DesktopAuditEnvelope): void; flush(): void | Promise<void>; discard(): void }
/** One row of the real audit_outbox table (plan Part 4 item 1 columns). */
interface OutboxRow { event_id: string; seq: number; event: string; subject: string; occurred_at: number }

/** Declared NEW-SURFACE contract of desktop/main/backend/audit-outbox.ts (items 2-3). */
interface ProductionOutboxModule {
  createProductionAuditSink(getStore: () => { db: unknown } | null, notify: (payload: { generation: number; pendingCount: number }) => void): { emit(envelope: DesktopAuditEnvelope): void };
  bindOutboxBinding(store: { db: unknown }, prefix: string, sender?: number): Promise<{ prefix: string; generation: number }>;
  /** Custody factory: beginRequest() returns a PER-INVOCATION batch view over a LIVE getStore() resolver; null/undefined resolver THROWS (leg 17). */
  createProductionCustodySink(getStore: () => { db: unknown } | null, notify?: (payload: { generation: number; pendingCount: number }) => void): { beginRequest(): CustodyBatch };
  /** Bridge-call gates: generation matches the CURRENT binding AND sender ∈ set; a stale-lower generation is REJECTED (leg 18b). */
  readOutboxPending(store: { db: unknown }, generation: number, sender: number): Promise<OutboxRow[]>;
  ackOutboxEvent(store: { db: unknown }, generation: number, sender: number, eventId: string): Promise<boolean>;
  /** One BEGIN IMMEDIATE clear — clear_gen + 1, clear_seq = next_seq - 1, pending delete. */
  captureClear(store: { db: unknown }): Promise<void>;
  /** tmp+rename MERGE of a fallback entry { envelope, gen } (gen = the CURRENT clear_gen at call time). */
  writeAuditJournalFallback(store: { db: unknown }, journalPath: string, envelope: DesktopAuditEnvelope): Promise<void>;
  /** Install max-based watermarks, seed next_seq, gate fallback entries by generation, insert survivors. */
  consumeAuditJournal(store: { db: unknown }, journalPath: string): Promise<void>;
}

const requireNative = createRequire(import.meta.url);

/** Read audit_outbox on a BRAND-NEW SEPARATE connection (WAL: only COMMITTED rows visible); star=true reads one FULL row (SELECT * — no projection hiding a missing column). */
function readOutboxOnFreshConnection(dbPath: string, star = false): { rows: OutboxRow[]; keys: string[]; error: string | null } {
  try {
    const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { all(): unknown[]; get(): unknown }; close(): void };
    const conn = new Database(dbPath);
    try {
      if (!star) return { rows: conn.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox').all() as OutboxRow[], keys: [], error: null };
      const row = conn.prepare('SELECT * FROM audit_outbox LIMIT 1').get() as Record<string, unknown> | undefined;
      return { rows: [], keys: row ? Object.keys(row) : [], error: null };
    } finally { conn.close(); }
  } catch (err) {
    return { rows: [], keys: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** R10-1 leg 18: simulate the plan's EMPTY-SET invalidation end-state — the binding carrier row `audit_outbox_binding` is REMOVED outright (05 :68). */
function removeBindingCarrierRows(dbPath: string): void {
  const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { run(): unknown }; close(): void };
  const conn = new Database(dbPath);
  try { conn.prepare('DELETE FROM audit_outbox_binding').run(); } finally { conn.close(); }
}

/** R11-6 leg 27: direct read of the declared INDEPENDENT gen_high carrier — the seq_meta row keyed `gen_high` (rev-6 header item 6) — on a BRAND-NEW connection. */
function readGenHigh(dbPath: string): { value: number | null; error: string | null } {
  try {
    const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { get(): unknown }; close(): void };
    const conn = new Database(dbPath);
    try {
      const row = conn.prepare("SELECT value FROM seq_meta WHERE key = 'gen_high'").get() as { value: unknown } | undefined;
      return { value: row !== undefined && typeof row.value === 'number' ? row.value : null, error: null };
    } finally { conn.close(); }
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** R14-3 ALIGNED pack evidence (rev 9; plan Part 4 v15 item 4): BOTH the audit_outbox envelopes AND the packs-REGISTRY rows read on ONE fresh connection of ONE database file — the arrangement that makes "registry mutation + envelope commit together" assertable at all (the rev-8 cross-database arrangement read them from different databases). */
function readPackEvidenceOnFreshConnection(dbPath: string): { envelopes: OutboxRow[]; registryRows: Array<{ id: string; version: string }>; error: string | null } {
  try {
    const Database = requireNative('better-sqlite3') as new (p: string) => { prepare(sql: string): { all(): unknown[] }; close(): void };
    const conn = new Database(dbPath);
    try {
      const envelopes = conn.prepare('SELECT event_id, seq, event, subject, occurred_at FROM audit_outbox').all() as OutboxRow[];
      const registryRows = conn.prepare('SELECT id, version FROM packs').all() as Array<{ id: string; version: string }>;
      return { envelopes, registryRows, error: null };
    } finally { conn.close(); }
  } catch (err) {
    return { envelopes: [], registryRows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** R14-3 rollback witness (rev 9; plan Part 4 v15 item 4): a BEFORE-INSERT trigger on the ALIGNED store's audit_outbox that RAISE(ABORT)s — a deterministic IN-TX failure of the envelope append while every other statement of the same transaction (the pack registry writes) succeeds, so the surrounding ROLLBACK is what can still save them together. */
function setOutboxInsertProbe(dbPath: string, armed: boolean): void {
  const Database = requireNative('better-sqlite3') as new (p: string) => { exec(sql: string): void; close(): void };
  const conn = new Database(dbPath);
  try {
    conn.exec(armed
      ? "CREATE TRIGGER IF NOT EXISTS audit_outbox_probe_abort BEFORE INSERT ON audit_outbox BEGIN SELECT RAISE(ABORT, 'emit probe (rollback witness)'); END"
      : 'DROP TRIGGER IF EXISTS audit_outbox_probe_abort');
  } finally { conn.close(); }
}

// ---- REV 19 SOURCE-LEVEL PIN (plan Part 4 v26): two static claims, and only
// these — (1) the module-bound import finder (R13-2 — the binding module
// specifier must RESOLVE to the exact expected file; name-only matching is
// forbidden); (2) the SOURCE CENSUS — the target name is USED exactly once in
// the repository production source, as a direct call in index.ts. The pin is
// syntactic; what the composition legs here prove is the builder behavior when
// THIS file calls it; the EFFECT of the index.ts call is observed by the
// custody-routes spec BOOTSTRAP leg (its startup-sink assertion). The rev 7-15
// static supplement machinery,
// the rev 16-17 counting spy, and the rev 17 mechanism gate are RETIRED WITH
// their machinery (plan Part 4 v26; 06 Rounds 12-22).
/** The checker program over the REAL index.ts (options: noLib/skipLibCheck/noEmit — diagnostics are NEVER read; only symbol resolution matters). Only symbol resolution matters to the module-bound import finder; local imports resolve with the desktop's own nodenext mapping, and unresolved external modules are irrelevant to it. */
function buildIndexProgram(indexPath: string): ts.Program {
  return ts.createProgram([indexPath], {
    noEmit: true, noLib: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
  });
}

/** R13-2 MODULE-BOUND resolution (rev 8; plan Part 4 v14 item 4): the canonical absolute path a RELATIVE module specifier (imported by `fromFile`) resolves to under the program's NodeNext mapping (`./x.js` → `x.ts` beside it, directory-index forms included), or null when it resolves to no existing file. Non-relative specifiers cannot resolve to the in-repo expected module under this program's options — null (fail closed). */
function resolveSpecifierPath(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const stem = specifier.replace(/\.(js|mjs|cjs)$/i, '');
  const candidates = [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${stem}/index.ts`, `${stem}/index.js`, stem];
  for (const candidate of candidates) {
    const abs = path.resolve(path.dirname(fromFile), candidate);
    try {
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return abs;
    } catch { /* unreadable — treat as unresolvable */ }
  }
  return null;
}

/** The MODULE-BOUND import symbol for `name` (rev 8, R13-2 — the name-only findImportedSymbol is DELETED): the checker symbol of the NamedImports binding, ONLY when the ImportDeclaration's module specifier RESOLVES to `expectedFile` (canonical path compare). A same-named binding from ANY other module returns undefined (wrong-module FAIL) and a binding whose expected module cannot be resolved returns undefined (fail-closed: name-only matching is forbidden, 06 :1136-1142). */
function findModuleBoundImportedSymbol(sf: ts.SourceFile, checker: ts.TypeChecker, name: string, expectedFile: string): ts.Symbol | undefined {
  let bound: ts.Symbol | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause === undefined || st.importClause.namedBindings === undefined || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    for (const el of st.importClause.namedBindings.elements) {
      if (el.name.text !== name) continue;
      if (!ts.isStringLiteral(st.moduleSpecifier)) return undefined; // a non-literal specifier cannot be bound to the exact expected module
      const resolved = resolveSpecifierPath(sf.fileName, st.moduleSpecifier.text);
      if (resolved === null || path.resolve(resolved) !== path.resolve(expectedFile)) return undefined; // wrong module, or the expected module cannot be resolved — both FAIL CLOSED
      bound = checker.getSymbolAtLocation(el.name) ?? checker.getSymbolAtLocation(el) ?? bound;
    }
  }
  return bound;
}

/** REV 19 SOURCE CENSUS (plan Part 4 v26): every USAGE of `name` in the repository production source text — an identifier whose text equals `name` that is NOT in an import/export binding position, or a string literal equal to `name`. Scanned: every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs file under the repository root, skipping node_modules, .git, .agents, dist, out, build, coverage, __tests__, tests, test, and e2e, and skipping the defining module (its declaration and its export). A name assembled at runtime is not source text and is outside the census by definition — the pin states the scope of the exactly-once claim. The census is a census of the LITERAL SPELLING: a usage under another name (an aliased import of the target, or an alias export of the defining module called elsewhere) is outside it, as is a name assembled at runtime. The EFFECT of the index.ts call is observed by the custody-routes spec BOOTSTRAP leg (its startup-sink assertion) — never by this function. */
function collectNameUsages(name: string, definingFile: string): Array<{ file: string; isDirectCall: boolean }> {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', 'dist', 'out', 'build', 'coverage', '__tests__', 'tests', 'test', 'e2e']);
  const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const usages: Array<{ file: string; isDirectCall: boolean }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
      if (!SOURCE_EXT.test(entry.name) || path.resolve(full) === path.resolve(definingFile)) continue;
      const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const isIdentifier = ts.isIdentifier(node) && node.text === name;
        const isLiteral = (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === name;
        if (isIdentifier || isLiteral) {
          const p = node.parent;
          const bindingPosition = isIdentifier && p !== undefined && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p));
          if (!bindingPosition) usages.push({ file: full, isDirectCall: p !== undefined && ts.isCallExpression(p) && p.expression === node });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(REPO_ROOT);
  return usages;
}

/** A real SQLite workspace store opened the way the pack lifecycle does. */
async function openWorkspaceStore(prefix: string): Promise<{ root: string; dbPath: string; store: { db: unknown; close(): void } }> {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const root = makeTempDir(prefix); const dbPath = path.join(root, 'store.db');
  const store = storeMod.openStore({ dbPath, dims: 8 });
  openStores.push(store); return { root, dbPath, store };
}

/** Copy a fixture pack, retargeting its embedding block to the test HashEmbedder (c7's rewrite). */
function stageFixture(root: string, name: string): string {
  const dest = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  const manifestPath = path.join(dest, 'pack.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.embedding = { model_id: 'hash-test', dims: 8, normalize: false };
  for (const entry of manifest.docs as Array<{ path: string; sha256: string }>) entry.sha256 = createHash('sha256').update(fs.readFileSync(path.join(dest, entry.path))).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return dest;
}


/** The REAL node-mode server over the REAL engine — /settings only. */
async function startSettingsServer(engine: unknown, persistExternal: () => void): Promise<{ port: number }> {
  const serverMod = await import('../../main/backend/server.js');
  const guardMod = await import('../../main/security/loopback-guard.js');
  const server = serverMod.createBackendServer({ guard: guardMod.createLoopbackGuard({ token: TOKEN }), tokenHeaderName: 'X-Desktop-Token', engine: engine as never, persistExternal });
  const port = await serverMod.listenOnRandomPort(server);
  openServers.push(server); return { port };
}

async function putSettings(port: number, patch: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings`, { method: 'PUT', headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(patch) });
}

/** In-memory SecretStore double (the wave-5 makeFakeSecretStore shape). */
function makeFakeSecretStore() {
  const map = new Map<string, string>();
  const deleteHistory: string[] = [];
  return { map, deleteHistory, persistent: true, get: (name: string) => map.get(name) ?? null, set: (name: string, value: string) => { map.set(name, value); }, delete: (name: string) => { deleteHistory.push(name); map.delete(name); } };
}
describe('audit-outbox-production (rev 19 — plan Part 4 v26): EXECUTABLE buildProductionStartup composition (PRIMARY — custody AND pack sinks) + ALIGNED pack durability on ONE database (registry mutation + envelope on ONE fresh connection, real rebindStore swap path, in-tx rollback witness) / engineOverrides custody composition + live getStore resolver / callable-resolver validation / gen_high high-water (rev-6 `second` fix) + restore max-merge + REVERSED gen_high orderings + concurrent atomic binds + stale-generation refusal / beginRequest swap & concurrency / journal fallback (#373 AC1 — R6-4, R7-5, R8-6, R9-3, R9-6, R10-1, R10-3, R11-1, R11-2, R11-6, R12-3, R12-6, R13-2, R13-4, R14-3)', () => {

  itReal('engineOverrides production composition: buildProductionEngineOverrides (backend-config.ts, extracted from index.ts:399-424) builds the real externalProvider options around the REAL custody-sink factory product (createProductionCustodySink, audit-outbox.ts — R7-5); the REAL LlamaEngine FROM THE BUILT OVERRIDES writes DURABLE save/clear/reset rows through THAT sink into a REAL store audit_outbox (Object.is) — each outer call is ONE beginRequest() batch (R9-3) (audit-outbox-production)', async () => {
    const configMod = (await import('../../main/backend-config.js').catch(() => null)) as unknown as EngineOverridesModule | null;
    expect(configMod, 'the production engine-override builder desktop/main/backend-config.ts must exist (plan Part 4 item 4, R6-4; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist — the REAL custody-sink factory this composition drives lives there (plan Part 4 v11 item 4; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof outboxMod!.createProductionCustodySink, 'the custody-sink factory export has the name this spec DECLARES (header item 2): createProductionCustodySink').toBe('function');
    const workspace = await openWorkspaceStore('audit-production-custody-');
    const custodySink = outboxMod!.createProductionCustodySink(() => workspace.store);
    const secretStore = makeFakeSecretStore();
    const root = makeTempDir('audit-production-engine-'); const storePath = path.join(root, 'profiles', 'test', 'store.sqlite');
    const built = configMod!.buildProductionEngineOverrides({
      userDataPath: root, gpuVerdictDir: path.dirname(storePath), models: { quality: 'quality-model-dir' },
      externalProvider: { secretStore, airgap: true, auditSink: custodySink },
    });
    expect(built.userDataPath, 'userDataPath survives the extraction (index.ts:408)').toBe(root);
    expect(built.gpuVerdictDir, 'gpuVerdictDir is path.dirname(storePath) (index.ts:409)').toBe(path.dirname(storePath));
    expect(built.models, 'the optional models override round-trips (index.ts:418-422)').toEqual({ quality: 'quality-model-dir' });
    expect(built.externalProvider.secretStore, 'the injected SecretStore instance threads Object.is-identical (index.ts:411-414)').toBe(secretStore);
    expect(built.externalProvider.airgap, 'the manifest airgap flag round-trips (index.ts:398, :415)').toBe(true);
    expect(built.externalProvider.auditSink, 'the built overrides carry the FACTORY custody sink Object.is-identical — the plan-declared ADDITION to the index.ts:399-424 field set').toBe(custodySink);
    const engine = new LlamaEngine(built as never);
    const srv = await startSettingsServer(engine, () => {});
    expect((await putSettings(srv.port, { 'external.apiKey': 'sk-production-probe' })).status, 'the real custody SAVE committed ok').toBe(200);
    expect([...secretStore.map.values()], 'the save really persisted the key through the BUILT-OVERRIDE SecretStore').toContain('sk-production-probe');
    const afterSave = readOutboxOnFreshConnection(workspace.dbPath);
    expect(afterSave.error, "the real store's audit_outbox reads cleanly on a fresh connection").toBeNull();
    const saveRows = afterSave.rows.filter((r) => r.event === 'settings_change');
    expect(saveRows.length, 'SAVE (one beginRequest batch) flushed EXACTLY ONE DURABLE settings_change row (capture alone never delivers; R7-5: durable rows, not recorder evidence)').toBe(1);
    expect(typeof saveRows[0]!.event_id === 'string' && saveRows[0]!.event_id.length > 0 && Number.isInteger(saveRows[0]!.seq) && saveRows[0]!.seq >= 1, 'the durable save row carries a present eventId and an ALLOCATED seq from the shared counter (plan Part 4 item 1: custody entries allocate from the SAME counter)').toBe(true);
    expect(saveRows[0]!.subject, 'the save envelope names the custody key').toContain('external.apiKey');
    const shape = readOutboxOnFreshConnection(workspace.dbPath, true);
    expect(shape.error, 'the full-row shape read (SELECT *) succeeds on a fresh connection').toBeNull();
    expect(['event_id', 'seq', 'event', 'subject', 'occurred_at'].filter((c) => !shape.keys.includes(c)), 'the durable row carries the plan Part 4 item 1 column form — clear generations are stamped ONLY on journal fallback entries (item 3)').toEqual([]);
    const exactKeys = ['event', 'event_id', 'occurred_at', 'seq', 'subject']; const sortedKeys = [...shape.keys].sort();
    expect(sortedKeys, `EXACT sorted ordinary-row key set (R8-6): must equal EXACTLY the five item-1 columns — extra: [${sortedKeys.filter((k) => !exactKeys.includes(k)).join(', ') || 'none'}]; missing: [${exactKeys.filter((k) => !sortedKeys.includes(k)).join(', ') || 'none'}]`).toEqual(exactKeys);
    const deletesAfterSave = secretStore.deleteHistory.length;
    expect((await putSettings(srv.port, { 'external.apiKey': '' })).status, 'the real custody CLEAR committed ok').toBe(200);
    expect(secretStore.deleteHistory.length, 'the clear drove real SecretStore DELETEs (clearKey, not a hand-rolled clear)').toBeGreaterThan(deletesAfterSave);
    const clearRows = readOutboxOnFreshConnection(workspace.dbPath).rows.filter((r) => r.event === 'settings_change');
    expect(clearRows.length, 'save + clear = one DURABLE row per committed custody change (the clear request\'s own batch flushed EXACTLY ONE more)').toBe(2);
    expect(clearRows[1]!.subject, 'the clear envelope names the custody key').toContain('external.apiKey');
    expect(clearRows[1]!.seq > clearRows[0]!.seq, 'the clear row allocated a LATER seq — the one shared counter strictly increases').toBe(true);
    expect((await putSettings(srv.port, { 'external.apiKey': 'sk-reset-probe' })).status, 'the arrange re-save committed ok').toBe(200);
    expect(readOutboxOnFreshConnection(workspace.dbPath).rows.filter((r) => r.event === 'settings_change').length, 'the arrange re-save flushed exactly one more DURABLE row (three custody changes so far)').toBe(3);
    expect((await putSettings(srv.port, { reset: ['external.apiKey', 'external.enabled'] })).status, 'the real reset route committed ok (reset stands alone — server.ts:956-975)').toBe(200);
    const resetRows = readOutboxOnFreshConnection(workspace.dbPath).rows.filter((r) => r.event === 'settings_change');
    expect(resetRows.length, 'the reset flushed EXACTLY ONE more DURABLE row — per-key reset coverage: only the custody-managed external.apiKey emits; external.enabled emits nothing').toBe(4);
    expect(resetRows[3]!.subject, 'the reset envelope names the reset custody key').toContain('external.apiKey');
    expect(resetRows[3]!.seq > resetRows[2]!.seq, 'the reset row allocated a LATER seq').toBe(true);
    expect(resetRows.length, 'nothing but the four custody rows ever hit the real outbox — a discarded capture leaves fewer, a double emit more').toBe(4);
    expect(new Set(resetRows.map((r) => r.event_id)).size, 'no two durable rows share an eventId across save/clear/re-save/reset').toBe(resetRows.length);
    expect(built.externalProvider.auditSink, 'the sink that wrote the durable rows IS the auditSink from the built overrides (Object.is — R6-4/R7-5)').toBe(custodySink);
  });

  itReal('live getStore resolver: the production pack sink resolves the CURRENT store at emit time — the first commit lands in store A; after the resolver swaps to store B (setStore after Clear Cache) the next commit lands in B, NOT A (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 item 4, R6-4; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const workspaceA = await openWorkspaceStore('audit-production-store-a-');
    const workspaceB = await openWorkspaceStore('audit-production-store-b-');
    await outboxMod!.bindOutboxBinding(workspaceA.store, 'audit-resolver-prefix'); await outboxMod!.bindOutboxBinding(workspaceB.store, 'audit-resolver-prefix');
    let current: { db: unknown } = workspaceA.store;
    const sink = outboxMod!.createProductionAuditSink(() => current, () => {});
    const managerMod = await import('../../main/backend/store/pack-manager.js'); const embedderMod = await import('../../main/backend/ingest/embedder.js');
    const managerA = new managerMod.PackManager({
      store: workspaceA.store, embedder: new embedderMod.HashEmbedder({ dims: 8 }), packsRoot: path.join(workspaceA.root, 'packs'),
      repoRoot: REPO_ROOT, packsSecurity: { embeddingModelId: 'hash-test' }, auditSink: sink,
    });
    await managerA.install(stageFixture(workspaceA.root, 'bundled-min'));
    current = workspaceB.store;
    const managerB = new managerMod.PackManager({
      store: workspaceB.store, embedder: new embedderMod.HashEmbedder({ dims: 8 }), packsRoot: path.join(workspaceB.root, 'packs'),
      repoRoot: REPO_ROOT, packsSecurity: { embeddingModelId: 'hash-test' }, auditSink: sink,
    });
    await managerB.install(stageFixture(workspaceB.root, 'versioned-a-1.0.0'));
    const readA = readOutboxOnFreshConnection(workspaceA.dbPath);
    const readB = readOutboxOnFreshConnection(workspaceB.dbPath);
    expect(readA.error, "store A's audit_outbox reads cleanly").toBeNull();
    expect(readB.error, "store B's audit_outbox reads cleanly").toBeNull();
    expect(readA.rows.filter((r) => String(r.subject).includes('bundled-min')).length, 'the FIRST emit (resolver → A) landed in store A').toBe(1);
    expect(readA.rows.filter((r) => String(r.subject).includes('versioned-a')).length, 'the SECOND emit NEVER landed in store A (the resolver was swapped)').toBe(0);
    expect(readB.rows.filter((r) => String(r.subject).includes('versioned-a')).length, 'the SECOND emit (resolver → B) landed in store B — the CURRENT store at emit time').toBe(1);
    expect(readB.rows.filter((r) => String(r.subject).includes('bundled-min')).length, 'store B never saw the first emit').toBe(0);
  });

  itReal('startup composition, EXECUTABLE PRIMARY (R11-2): buildProductionStartup (backend-config.ts, rev-6 header item 5) builds engineOverrides + hostConfig TOGETHER with BOTH real sinks INSIDE (no resolver or sink argument exists to fake); the leg drives the REAL chain index.ts ships — resolveNodeEngine(env, engineOverrides) → a real PUT save through THAT engine lands its durable row in the CURRENT store (Object.is end-to-end: the leg wires NO sink, only the startup\'s internally-built custody sink can write it); opening a SECOND store routes the next save to the NEW store, not the old one (the internal resolver is LIVE — the Clear Cache reopen shape); and { ...hostConfig, engine } through the REAL createBackendHost constructs a PackManager carrying hostConfig.auditSink (Object.is) (audit-outbox-production)', async () => {
    const configMod = (await import('../../main/backend-config.js').catch(() => null)) as unknown as StartupCompositionModule | null;
    expect(configMod, 'the production startup composition desktop/main/backend-config.ts must exist (plan Part 4 v12 item 4; rev-6 header item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof configMod!.buildProductionStartup, 'the startup composition export has the name this spec DECLARES (rev-6 header item 5): buildProductionStartup').toBe('function');
    const secretStore = makeFakeSecretStore();
    const root = makeTempDir('audit-startup-composition-'); const storePath = path.join(root, 'profiles', 'test', 'store.sqlite');
    const startup = configMod!.buildProductionStartup({
      userDataPath: root, storePath, externalAirgap: true,
      secretStore, token: TOKEN, tokenHeaderName: 'X-Desktop-Token',
      packsRoot: path.join(root, 'packs'), storeBackupsDir: path.join(root, 'backups'),
    });
    expect(startup.engineOverrides.userDataPath, 'the startup engineOverrides half keeps the index.ts:408 userDataPath').toBe(root);
    expect(startup.engineOverrides.gpuVerdictDir, 'the startup engineOverrides half keeps the index.ts:409 gpuVerdictDir (dirname of the store path)').toBe(path.dirname(storePath));
    expect(startup.engineOverrides.externalProvider.secretStore, 'the injected SecretStore threads into the engineOverrides half Object.is-identical (index.ts:411-414)').toBe(secretStore);
    expect(startup.engineOverrides.externalProvider.airgap, 'the externalAirgap input round-trips into the engineOverrides half (index.ts:398,:415)').toBe(true);
    expect(typeof (startup.engineOverrides.externalProvider.auditSink as { beginRequest?: unknown } | null)?.beginRequest, 'engineOverrides.externalProvider.auditSink is the INTERNALLY-BUILT custody sink (beginRequest batch view) — the leg passed NO sink anywhere, so the builder closed over its own factory product (R11-2: index passes no resolver argument at all)').toBe('function');
    expect(typeof (startup.hostConfig.auditSink as { emit?: unknown } | null)?.emit, 'hostConfig.auditSink is the INTERNALLY-BUILT pack sink (emit view) — the second real sink of the same composition').toBe('function');
    // The REAL chain, exactly as index.ts:424 ships it: the engine resolved
    // FROM THE BUILT OVERRIDES. The durable row this engine writes can only
    // come from the startup's internally-built custody sink — the Object.is
    // end-to-end proof (R11-2 PRIMARY; in-memory recorders count for nothing).
    const engine = resolveNodeEngine({}, startup.engineOverrides as never);
    const wsA = await openWorkspaceStore('audit-startup-store-a-'); // registers the CURRENT store (rev-6 header item 5 seam)
    const srv = await startSettingsServer(engine, () => {});
    expect((await putSettings(srv.port, { 'external.apiKey': 'sk-startup-a' })).status, 'the real custody SAVE through the startup-composed engine committed ok').toBe(200);
    expect([...secretStore.map.values()], 'the save really persisted through the STARTUP-BUILT SecretStore').toContain('sk-startup-a');
    const readA1 = readOutboxOnFreshConnection(wsA.dbPath);
    expect(readA1.error, "store A's audit_outbox reads cleanly on a fresh connection").toBeNull();
    expect(readA1.rows.filter((r) => r.event === 'settings_change').length, 'the save landed EXACTLY ONE durable settings_change row in the CURRENT store — Object.is end-to-end through engineOverrides into resolveNodeEngine: the leg wired NO sink, so only the startup\'s internally-built custody sink can have written it (R11-2 EXECUTABLE PRIMARY; plan Part 4 v12 item 4)').toBe(1);
    // The internal resolver is LIVE: opening a second store supersedes the
    // current-store state (the Clear Cache reopen shape) and the NEXT commit
    // follows it — the resolver is read at flush time, never captured.
    const wsB = await openWorkspaceStore('audit-startup-store-b-');
    expect((await putSettings(srv.port, { 'external.apiKey': 'sk-startup-b' })).status, 'the second real save after the store swap committed ok').toBe(200);
    const readA2 = readOutboxOnFreshConnection(wsA.dbPath); const readB = readOutboxOnFreshConnection(wsB.dbPath);
    expect(readB.error, "store B's audit_outbox reads cleanly").toBeNull();
    expect(readB.rows.filter((r) => r.event === 'settings_change').length, 'after the swap the NEXT save landed in the NEW current store — the startup\'s INTERNAL resolver followed the store-module current-store state').toBe(1);
    expect(readA2.rows.filter((r) => r.event === 'settings_change').length, 'store A kept EXACTLY its own row — the second save never landed in the OLD store').toBe(1);
    // The hostConfig half: the caller adds the engine between the halves
    // (index.ts:424-433 shape) and the REAL createBackendHost threads
    // hostConfig.auditSink into the PackManager it constructs (wiring-leg
    // pattern). The stub engine + test env keep host.start() minimal.
    const engineMod = await import('../../main/backend/engine.js');
    const hostMod = await import('../../main/backend/index.js');
    const stubEngine = new engineMod.StubEngine();
    const host = hostMod.createBackendHost({ ...startup.hostConfig, engine: stubEngine, env: { TRAININGAPP_DESKTOP_ENGINE: 'stub', TRAININGAPP_DESKTOP_EMBEDDER: 'hash' }, storeEmbeddingDims: 8 } as never);
    startedHosts.push(host as { stop(): Promise<void> });
    pmCapture.options.length = 0; pmCapture.armed = true;
    try { await (host as { start(): Promise<unknown> }).start(); } finally { pmCapture.armed = false; }
    expect(pmCapture.options.length, 'the production start() path constructed a PackManager from the BUILT host config (not a harness crash)').toBeGreaterThan(0);
    const captured = pmCapture.options[0] as { auditSink?: unknown } | undefined;
    expect(captured!.auditSink, 'createBackendHost → PackManager construction: the captured auditSink IS hostConfig.auditSink (Object.is) — the pack-sink half of the startup composition (R11-2; plan Part 4 v12 item 4)').toBe(startup.hostConfig.auditSink);
  });

  itReal('startup-built PACK sink, EXECUTABLE + ALIGNED ON ONE DATABASE (R12-3 + R14-3 — 06 :1071-1077: the pack half could be `{ emit() {} }` and still reach PackManager Object.is-identity; and 06 :1201-1207: the rev-8 leg kept the manager on the store host.start() opened while reading the expected envelope from separately-opened workspaces A/B — an independent CROSS-DATABASE append that cannot prove same-transaction atomicity): a REAL pack install through the PackManager the HOST built from buildProductionStartup\'s hostConfig commits on the HOST\'S OWN store, and ONE fresh connection of THAT ONE database shows BOTH the packs-REGISTRY row AND the pack_install envelope TOGETHER; the store swap then drives the REAL host swap/rebind path AS the host\'s setStore callback performs it (backend/index.ts:1151-1158 — openStore registers the module-current handle the sink resolves AND the leg calls the CAPTURED manager\'s REAL rebindStore with the SAME handle; never a bare workspace open) before a REAL install + REAL remove on B whose ONE fresh connection shows registry row + pack_remove envelope together; a BEFORE-INSERT RAISE(ABORT) trigger on the aligned store\'s audit_outbox (a deterministic IN-TX envelope-append failure) makes the install REJECT with NO registry row AND NO envelope — they commit or roll back TOGETHER — never a manually constructed or injected sink (audit-outbox-production)', async () => {
    const configMod = (await import('../../main/backend-config.js').catch(() => null)) as unknown as StartupCompositionModule | null;
    expect(configMod, 'the production startup composition desktop/main/backend-config.ts must exist (plan Part 4 v15 item 4; rev-6 header item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(typeof configMod!.buildProductionStartup, 'the startup composition export has the name this spec DECLARES (rev-6 header item 5): buildProductionStartup').toBe('function');
    const secretStore = makeFakeSecretStore();
    const root = makeTempDir('audit-startup-pack-'); const storePath = path.join(root, 'profiles', 'test', 'store.sqlite');
    const startup = configMod!.buildProductionStartup({
      userDataPath: root, storePath, externalAirgap: true,
      secretStore, token: TOKEN, tokenHeaderName: 'X-Desktop-Token',
      packsRoot: path.join(root, 'packs'), storeBackupsDir: path.join(root, 'backups'),
    });
    // Build the host from the startup's hostConfig half (index.ts:424-433
    // shape) and start it: host.start() opens the host's OWN store at
    // storePath (backend/index.ts:1043-1046), which registers as the store
    // module's current handle — THE ALIGNED ARRANGEMENT (R14-3): the
    // host-built manager holds THAT store (constructed with this.store at
    // backend/index.ts:1203-1208) and the startup-built sink resolves the
    // SAME handle at emit time. NO separate workspace open happens before
    // the install commit — the rev-8 shape (manager left on the host store
    // while the sink resolved a later-opened workspace) was a cross-database
    // append and is NOT evidence. The env carries the packs embedding-model
    // pin so the host-built manager accepts the hash-test fixture.
    const engineMod = await import('../../main/backend/engine.js');
    const hostMod = await import('../../main/backend/index.js');
    const stubEngine = new engineMod.StubEngine();
    const host = hostMod.createBackendHost({ ...startup.hostConfig, engine: stubEngine, env: { TRAININGAPP_DESKTOP_ENGINE: 'stub', TRAININGAPP_DESKTOP_EMBEDDER: 'hash', TRAININGAPP_PACKS_EMBEDDING_MODEL_ID: 'hash-test' }, storeEmbeddingDims: 8 } as never);
    startedHosts.push(host as { stop(): Promise<void> });
    pmCapture.options.length = 0; pmCapture.instances.length = 0; pmCapture.armed = true;
    try { await (host as { start(): Promise<unknown> }).start(); } finally { pmCapture.armed = false; }
    expect(pmCapture.instances.length, 'the production start() path constructed a PackManager from the BUILT host config (the pack leg drives THAT manager — the exact manager the startup-built host wired)').toBeGreaterThan(0);
    const manager = pmCapture.instances[0] as unknown as { install(packPath: string): Promise<unknown>; remove(packId: string, version?: string): Promise<unknown>; rebindStore(handle: unknown): void };
    const capturedOpts = pmCapture.options[0] as { auditSink?: unknown } | undefined;
    expect(capturedOpts!.auditSink, 'the host-built PackManager carries the STARTUP-BUILT pack sink Object.is-identical — the leg constructed NO sink and injected NOTHING, so only buildProductionStartup\'s internally-built sink can be here (R12-3: manually constructed or injected sink evidence does NOT count for the shipped startup sink; plan Part 4 v15 item 4)').toBe(startup.hostConfig.auditSink);
    // PHASE 1 — the ALIGNED install: registry mutation AND envelope on ONE
    // fresh connection of the HOST'S OWN store.
    const staging = makeTempDir('audit-startup-pack-stage-');
    await manager.install(stageFixture(staging, 'bundled-min'));
    const phaseOne = readPackEvidenceOnFreshConnection(storePath);
    expect(phaseOne.error, "the host's own store reads cleanly on a fresh connection after the real install (envelopes AND registry rows)").toBeNull();
    expect(phaseOne.envelopes.filter((r) => r.event === 'pack_install' && String(r.subject).includes('bundled-min')).length, 'PHASE 1 (aligned install): a REAL pack install through the HOST-BUILT manager landed EXACTLY ONE durable pack_install envelope — the startup-built pack sink is DURABLY behavioral, not a `{ emit() {} }` no-op (a no-op sink leaves ZERO durable rows and fails this assertion; R12-3; plan Part 4 v15 item 4)').toBe(1);
    expect(phaseOne.registryRows.filter((r) => r.id === 'bundled-min').length, 'PHASE 1 (aligned install): the packs-REGISTRY mutation for the SAME commit is visible on the SAME ONE fresh connection — manager and sink shared the host\'s OWN store handle, so registry row and envelope are in ONE database (R14-3: the rev-8 arrangement read the envelope from a workspace the manager never wrote and rewarded a cross-database append — that arrangement FAILS this assertion by construction, envelope=0 here; plan Part 4 v15 item 4)').toBe(1);
    // PHASE 2 — the REAL store-swap/rebind path, simulated EXACTLY as the
    // host's own setStore callback performs it (backend/index.ts:1151-1158:
    // `this.store = handle; this.packManager?.rebindStore(handle)`): the
    // openStore call registers workspace B as the module-current handle the
    // startup sink resolves, and the leg calls the CAPTURED manager's REAL
    // rebindStore with the SAME handle — the real rebind API, never a bare
    // workspace open that would leave the manager on the host store.
    const wsB = await openWorkspaceStore('audit-startup-pack-b-');
    manager.rebindStore(wsB.store);
    await manager.install(stageFixture(staging, 'versioned-a-1.0.0'));
    const phaseTwoB = readPackEvidenceOnFreshConnection(wsB.dbPath);
    expect(phaseTwoB.error, "workspace B's audit_outbox AND registry read cleanly on one fresh connection after the swapped install").toBeNull();
    expect(phaseTwoB.envelopes.filter((r) => r.event === 'pack_install' && String(r.subject).includes('versioned-a')).length, 'PHASE 2 (swapped install): the REAL install through the REBOUND manager landed EXACTLY ONE pack_install envelope on B — the sink\'s internal resolver followed the current-store swap (R12-3; plan Part 4 v15 item 4)').toBe(1);
    expect(phaseTwoB.registryRows.filter((r) => r.id === 'versioned-a').length, 'PHASE 2 (swapped install): B\'s registry row for the SAME commit is on the SAME ONE fresh connection — the rebind put the manager\'s transaction and the sink\'s emit on ONE database handle (R14-3; plan Part 4 v15 item 4)').toBe(1);
    const phaseTwoHost = readPackEvidenceOnFreshConnection(storePath);
    expect(phaseTwoHost.registryRows.filter((r) => r.id === 'versioned-a').length, 'PHASE 2: the HOST store\'s registry NEVER saw the swapped install — the manager really followed the rebind (a manager still on the host store would write the registry row HERE and fail the B-connection assertion above; R14-3; plan Part 4 v15 item 4)').toBe(0);
    expect(phaseTwoHost.envelopes.filter((r) => r.event === 'pack_install').length, 'PHASE 2: the HOST store gained NO second envelope — the sink really followed the current-store swap (cross-database durable rows are EXCLUDED as evidence; R14-3; plan Part 4 v15 item 4)').toBe(1);
    // PHASE 2b — the REAL remove through the SAME rebound manager: the
    // registry mutation (row GONE) and the pack_remove envelope, together
    // on B's ONE fresh connection.
    await manager.remove('versioned-a');
    const phaseTwoAfterRemove = readPackEvidenceOnFreshConnection(wsB.dbPath);
    expect(phaseTwoAfterRemove.error, "workspace B reads cleanly on one fresh connection after the real remove").toBeNull();
    expect(phaseTwoAfterRemove.registryRows.filter((r) => r.id === 'versioned-a').length, 'PHASE 2b (remove): the registry row is GONE on the SAME ONE fresh connection that carries the envelope — the remove\'s registry mutation committed on B (R14-3; plan Part 4 v15 item 4)').toBe(0);
    expect(phaseTwoAfterRemove.envelopes.filter((r) => r.event === 'pack_remove' && String(r.subject).includes('versioned-a')).length, 'PHASE 2b (remove): the REAL pack remove committed EXACTLY ONE durable pack_remove envelope on B\'s connection — registry mutation and envelope from ONE commit on ONE database (R12-3 + R14-3; plan Part 4 v15 item 4)').toBe(1);
    // PHASE 3 — the failure/rollback witness (the commit-then-throw fixture
    // class from the producer/composition specs, executable here as a
    // deterministic IN-TX envelope-append failure): a BEFORE-INSERT
    // RAISE(ABORT) trigger on B's audit_outbox makes ONLY the envelope
    // append of the install transaction throw. The install REJECTS, and ONE
    // fresh connection of B shows NO registry row AND NO envelope — the
    // registry mutation and the envelope ROLL BACK TOGETHER (an
    // implementation that appends the envelope OUTSIDE the pack transaction
    // leaves the registry row COMMITTED and fails the no-registry
    // assertion; one that swallows the emit failure and commits likewise).
    setOutboxInsertProbe(wsB.dbPath, true);
    let installThrew = false;
    try { await manager.install(stageFixture(staging, 'bundled-min')); } catch { installThrew = true; }
    setOutboxInsertProbe(wsB.dbPath, false);
    expect(installThrew, 'PHASE 3 (rollback witness): the sabotaged envelope append made the install REJECT — the in-tx emit failure surfaced to the caller (plan Part 4 v15 item 4)').toBe(true);
    const phaseThree = readPackEvidenceOnFreshConnection(wsB.dbPath);
    expect(phaseThree.error, 'workspace B reads cleanly after the rollback witness').toBeNull();
    expect(phaseThree.registryRows.filter((r) => r.id === 'bundled-min').length, 'PHASE 3 (rollback witness): the registry mutation ROLLED BACK WITH the failed envelope append — NO bundled-min row on B (an out-of-tx emit leaves this row COMMITTED and FAILS here; the registry mutation and the envelope commit or roll back TOGETHER; R14-3; plan Part 4 v15 item 4)').toBe(0);
    expect(phaseThree.envelopes.filter((r) => r.event === 'pack_install' && String(r.subject).includes('bundled-min')).length, 'PHASE 3 (rollback witness): the envelope is ABSENT too — the failed append left nothing durable on the aligned store (R14-3; plan Part 4 v15 item 4)').toBe(0);
    // PHASE 3b — control: with the trigger dropped, the SAME manager, the
    // SAME store, and the SAME fixture install cleanly — the witness sabotaged
    // exactly the envelope append, never the store.
    await manager.install(stageFixture(staging, 'bundled-min'));
    const phaseThreeControl = readPackEvidenceOnFreshConnection(wsB.dbPath);
    expect(phaseThreeControl.registryRows.filter((r) => r.id === 'bundled-min').length, 'PHASE 3b (control): after the trigger is dropped the install commits its registry row on B — the store was never wedged, the witness fired exactly at the envelope append (plan Part 4 v15 item 4)').toBe(1);
    expect(phaseThreeControl.envelopes.filter((r) => r.event === 'pack_install' && String(r.subject).includes('bundled-min')).length, 'PHASE 3b (control): the control install landed EXACTLY ONE pack_install envelope on B — aligned behavior restored (plan Part 4 v15 item 4)').toBe(1);
  });

  it('source-level pin: MODULE-BOUND import existence + SOURCE CENSUS (rev 19, plan Part 4 v26). (a) the REAL desktop/main/index.ts statically imports buildProductionStartup from the EXACT expected module desktop/main/backend-config.ts — the ImportDeclaration binding\'s module specifier must RESOLVE to that exact file (a same-named import from ./wrong.js FAILS; a deleted/unresolvable backend-config.ts FAILS CLOSED — name-only matching is forbidden, R13-2). (b) SOURCE CENSUS — the name buildProductionStartup occurs as a USAGE (an identifier outside import/export binding positions, or a whole string literal equal to the name) EXACTLY ONCE across every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs source file of the repository outside node_modules, .git, .agents, dist, out, build, coverage, __tests__, tests, test, and e2e — the defining module excluded — and that ONE usage is a DIRECT CALL in index.ts. SCOPE OF THE EXACTLY-ONCE CLAIM: this is a claim about the SHIPPED SOURCE TEXT. The pin is SYNTACTIC (a call under if (false) still passes it); the EFFECT of the call is observed executably by the custody-routes spec BOOTSTRAP leg (the REAL index.ts bootstrap runs with backend-config.ts unmocked, and the host config handed to createBackendHost must carry an audit sink). NOT CLAIMED, by design: an invocation synthesized at RUNTIME by dynamic code evaluation or by a separately loaded module instance, AND a usage spelled under ANOTHER NAME (an aliased import of the target, or an alias export of the defining module called elsewhere — the census is a census of the literal spelling) — no acceptance criterion of #372 or #373 requires it, so it is not a check concern (the implementation diff is reviewed in Phase 4.5/4.6) (audit-outbox-production)', () => {
    const indexPath = path.join(REPO_ROOT, 'desktop', 'main', 'index.ts');
    expect(fs.existsSync(indexPath), 'the real desktop/main/index.ts source must exist for the source-level pin to check (plan Part 4 v26)').toBe(true);
    const program = buildIndexProgram(indexPath);
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(indexPath);
    expect(sf, 'the checker program must include the real desktop/main/index.ts source file').toBeDefined();
    const expectedModule = path.join(REPO_ROOT, 'desktop', 'main', 'backend-config.ts');
    const targetSymbol = findModuleBoundImportedSymbol(sf!, checker, 'buildProductionStartup', expectedModule);
    expect(targetSymbol, 'index.ts must IMPORT buildProductionStartup MODULE-BOUND — the binding\'s module specifier must RESOLVE to the exact expected file desktop/main/backend-config.ts (the pre-fix file holds ZERO buildProductionStartup references: RED at base; a same-named import from ./wrong.js FAILS here (wrong-module mutant); a deleted/unresolvable backend-config.ts FAILS CLOSED here (unresolved-module mutant) — name-only matching is forbidden; R13-2, plan Part 4 v26)').toBeDefined();
    // (b) SOURCE CENSUS (plan Part 4 v26): exactly one USAGE in the production source text, a direct call in index.ts.
    const describeUsage = (u: { file: string; isDirectCall: boolean }): string => `${path.relative(REPO_ROOT, u.file).split(path.sep).join('/')} ${u.isDirectCall ? '(direct call)' : '(NOT a direct call)'}`;
    const usages = collectNameUsages('buildProductionStartup', expectedModule);
    expect(usages.length, `the name buildProductionStartup is USED exactly ONCE across the repository production source text — SOURCE CENSUS (plan Part 4 v26); got ${String(usages.length)}${usages.length === 0 ? '' : `: ${usages.map(describeUsage).join(', ')}`}`).toBe(1);
    expect(path.resolve(usages[0]!.file), 'the ONE usage of buildProductionStartup sits in desktop/main/index.ts').toBe(path.resolve(indexPath));
    expect(usages[0]!.isDirectCall, 'the ONE usage of buildProductionStartup is a DIRECT CALL — the callee of a call expression').toBe(true);
  }, 60000);

  it('callable-resolver validation, the R11-2 EXECUTABLE half (supersedes the R10-3 null-resolver leg): BOTH production sink factories validate `typeof getStore === \'function\'` — null, undefined, AND a non-callable object each THROW, asserted as FOUR INDEPENDENT expects (never one short-circuiting expression — 06 :994: the rev-5 pack assertion combined null+undefined and proved neither independently) (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v12 item 4; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    expect(() => outboxMod!.createProductionCustodySink(null as never), 'createProductionCustodySink(null) THROWS — independently proven (the null-resolver mutant removes the check and fails this assertion alone)').toThrow();
    expect(() => outboxMod!.createProductionCustodySink(undefined as never), 'createProductionCustodySink(undefined) THROWS — the SECOND independent null/undefined case (never short-circuited behind the null case; R11-2, plan Part 4 v12 item 4)').toThrow();
    expect(() => outboxMod!.createProductionAuditSink(null as never, () => {}), 'createProductionAuditSink(null, notify) THROWS — the pack factory validates its resolver the same way, independently proven').toThrow();
    expect(() => outboxMod!.createProductionAuditSink(undefined as never, () => {}), 'createProductionAuditSink(undefined, notify) THROWS — the FOURTH independent case').toThrow();
    expect(() => outboxMod!.createProductionCustodySink({} as never), 'createProductionCustodySink(a non-callable OBJECT) THROWS — the validation is `typeof getStore === \'function\'`, not merely non-null: a bare store object (the rev-5 direct-store bypass shape createProductionCustodySink(getStore()) shipped a store where a resolver belonged) must not pass (R11-2)').toThrow();
    expect(() => outboxMod!.createProductionAuditSink({} as never, () => {}), 'createProductionAuditSink(a non-callable OBJECT, notify) THROWS likewise — callable dataflow to the actual current-store read is required at BOTH factories').toThrow();
  });

  itReal('gen_high binding-generation high-water (R10-1): after empty-set invalidation REMOVES the audit_outbox_binding carrier row, a NEW subscription receives a generation STRICTLY ABOVE every prior one (from the independent persisted gen_high, never a reset counter) — and the high-water survives a close/reopen (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-gen-high-');
    const first = await outboxMod!.bindOutboxBinding(ws.store, 'gen-high-a', 11);
    expect(first.generation, 'the first bind allocates a positive generation').toBeGreaterThan(0);
    const second = await outboxMod!.bindOutboxBinding(ws.store, 'gen-high-b', 12);
    expect(second.generation, 'a different-prefix rebind allocates a NEW generation above the first (gen = ++gen_high) — the FIRST retained comparison (R11-1: the awaited second bind is bound to `const second` BEFORE the deletion leg; the rev-5 leg referenced an undeclared `second`, TS2304 x2, and could never execute past this point)').toBeGreaterThan(first.generation);
    // THE R10-1 COUNTEREXAMPLE SEAM: empty-set invalidation removes the only
    // named binding carrier outright (05 :68) — a counter that lived only
    // inside that row is GONE; only an independent gen_high allocates above.
    removeBindingCarrierRows(ws.dbPath);
    const fresh = await outboxMod!.bindOutboxBinding(ws.store, 'gen-high-fresh', 13);
    expect(fresh.generation, `after binding-row removal the fresh subscribe receives a generation STRICTLY ABOVE every prior one (${String(fresh.generation)} > ${String(second.generation)}) — from the INDEPENDENT persisted gen_high high-water, never a reset/reused counter (a reset counter would return 1; R10-1: a lower reused generation could neither adopt a higher source_gen nor out-compete a later stale compensation) — the SECOND retained comparison (R11-1, plan Part 4 v12 item 5)`).toBeGreaterThan(second.generation);
    const reopened = (await import('../../main/backend/store/sqlite-store.js')).openStore({ dbPath: ws.dbPath, dims: 8 });
    openStores.push(reopened);
    expect((await outboxMod!.bindOutboxBinding(reopened, 'gen-high-reopened', 14)).generation, 'a bind on a REOPENED store still allocates strictly above the pre-reopen high-water (gen_high survives every open)').toBeGreaterThan(fresh.generation);
  });

  itReal('stale-lower-generation compensation refused (R10-1): after invalidation the fresh binding holds a HIGHER generation; its redelivery/ack of the new row SUCCEEDS, and the stale LOWER generation\'s pending/ack against that acked row is REFUSED — no resurrection, no double-delete (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-gen-stale-');
    const stale = await outboxMod!.bindOutboxBinding(ws.store, 'gen-stale-a', 21);
    const sink = outboxMod!.createProductionCustodySink(() => ws.store);
    const seedBatch = sink.beginRequest();
    seedBatch.capture({ eventId: 'gen-stale-seed', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await seedBatch.flush();
    expect((await outboxMod!.readOutboxPending(ws.store, stale.generation, 21)).map((r) => r.event_id), 'before invalidation the stale generation\'s pending gate sees the durable row (arrange — the gate worked at that generation)').toContain('gen-stale-seed');
    removeBindingCarrierRows(ws.dbPath);
    const fresh = await outboxMod!.bindOutboxBinding(ws.store, 'gen-stale-b', 22);
    expect(fresh.generation, 'the fresh binding generation is HIGHER than the stale one (R10-1 gen_high — the premise the adoption/compensation proof needs)').toBeGreaterThan(stale.generation);
    const batch = sink.beginRequest();
    batch.capture({ eventId: 'gen-stale-new', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await batch.flush();
    expect((await outboxMod!.readOutboxPending(ws.store, fresh.generation, 22)).map((r) => r.event_id), 'the fresh HIGHER generation\'s redelivery sees the new durable row').toContain('gen-stale-new');
    await expect(outboxMod!.ackOutboxEvent(ws.store, fresh.generation, 22, 'gen-stale-new'), 'the higher generation\'s ACK of its row succeeds (resolves true — the row is acked)').resolves.toBe(true);
    await expect(outboxMod!.ackOutboxEvent(ws.store, stale.generation, 21, 'gen-stale-new'), 'the stale LOWER generation\'s compensating ACK of the higher generation\'s acked row is REFUSED with an error naming the generation (R10-1: compensation cannot delete or resurrect an acked row from below)').rejects.toThrow(/generation|stale|sender/i);
    await expect(outboxMod!.readOutboxPending(ws.store, stale.generation, 21), 'the stale LOWER generation\'s pending gate is REFUSED likewise — it can neither observe nor consume under the newer binding').rejects.toThrow(/generation|stale|sender/i);
    const finalRead = readOutboxOnFreshConnection(ws.dbPath);
    expect(finalRead.rows.filter((r) => r.event_id === 'gen-stale-new').length, 'the acked row STAYS acked (deleted) — the stale compensation neither resurrected nor double-deleted it').toBe(0);
  });

  itReal('concurrent-bind atomicity + separate gen_high carrier (R11-6): a VOLLEY of simultaneous different-prefix binds allocates pairwise DISTINCT generations all strictly above the prior high-water (one BEGIN IMMEDIATE read-increment-write per operation — no reuse, no collision); a simultaneous SAME-PREFIX pair resolves ONE shared generation (sender append, never a re-allocation); and the high-water lives in its OWN dedicated row — the seq_meta row keyed gen_high — which the blanket audit_outbox_binding DELETE does not disturb (direct read survives; the next bind allocates strictly above the survivor) (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v12 item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-concurrent-bind-');
    const pre = await outboxMod!.bindOutboxBinding(ws.store, 'gen-conc-pre', 31);
    expect(pre.generation, 'the arrange bind allocates a positive generation').toBeGreaterThan(0);
    // Different-prefix volley: four SIMULTANEOUS binds (Promise.all).
    const volley = await Promise.all(['gen-conc-a', 'gen-conc-b', 'gen-conc-c', 'gen-conc-d'].map((p, i) => outboxMod!.bindOutboxBinding(ws.store, p, 40 + i)));
    expect(new Set(volley.map((v) => v.generation)).size, 'every SIMULTANEOUS different-prefix bind allocated a DISTINCT generation — no reuse/collision (generation read-increment + binding write are ONE BEGIN IMMEDIATE per operation; a racy read-then-write could hand two binds the same number; plan Part 4 v12 item 5, R11-6)').toBe(4);
    for (const v of volley) {
      expect(v.generation, `every concurrent allocation sits STRICTLY ABOVE the pre-existing high-water ${String(pre.generation)} (gen = ++gen_high — never at or below it)`).toBeGreaterThan(pre.generation);
    }
    // Same-prefix pair: TWO simultaneous binds on ONE prefix.
    const [sameOne, sameTwo] = await Promise.all([outboxMod!.bindOutboxBinding(ws.store, 'gen-conc-same', 51), outboxMod!.bindOutboxBinding(ws.store, 'gen-conc-same', 52)]);
    expect(sameOne.generation, 'two SIMULTANEOUS same-prefix binds resolve ONE SHARED generation — the second is a sender APPEND inside the same single BEGIN IMMEDIATE, never a fresh allocation or a torn binding (plan Part 4 v12 item 5: same prefix → same generation, sender appended)').toBe(sameTwo.generation);
    const highWater = Math.max(pre.generation, ...volley.map((v) => v.generation), sameOne.generation);
    // The SEPARATE carrier: seq_meta.gen_high is its own dedicated row.
    const beforeDelete = readGenHigh(ws.dbPath);
    expect(beforeDelete.error, "the declared gen_high carrier (the seq_meta row keyed 'gen_high', rev-6 header item 6) reads on a fresh connection").toBeNull();
    expect(beforeDelete.value, `the carrier holds the allocation high-water (>= the highest allocated ${String(highWater)}; R11-6)`).toBeGreaterThanOrEqual(highWater);
    removeBindingCarrierRows(ws.dbPath);
    const afterDelete = readGenHigh(ws.dbPath);
    expect(afterDelete.error, 'the gen_high carrier still reads after the blanket audit_outbox_binding delete (fresh connection)').toBeNull();
    expect(afterDelete.value, 'the gen_high carrier SURVIVES empty-set invalidation\'s row removal UNCHANGED — it is its OWN dedicated row, never a column of the removable binding row (06 :1022-1028 named this the premise the whole adoption/compensation proof stands on; R11-6, plan Part 4 v12 item 5)').toBe(beforeDelete.value);
    const post = await outboxMod!.bindOutboxBinding(ws.store, 'gen-conc-post', 61);
    expect(post.generation, 'a bind AFTER the blanket delete allocates STRICTLY ABOVE the surviving high-water — the counter never reset with the binding rows').toBeGreaterThan(afterDelete.value!);
  });

  itReal('custody store-swap via beginRequest() batches (R8-6 + R9-3): each batch resolves the CURRENT store from the sink\'s live getStore resolver — a batch flushed against store A lands in A; after the resolver swaps to store B the next batch lands in B, NOT A (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 item 4; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const workspaceA = await openWorkspaceStore('audit-custody-swap-a-');
    const workspaceB = await openWorkspaceStore('audit-custody-swap-b-');
    await outboxMod!.bindOutboxBinding(workspaceA.store, 'audit-custody-swap'); await outboxMod!.bindOutboxBinding(workspaceB.store, 'audit-custody-swap');
    let current: { db: unknown } = workspaceA.store;
    const custody = outboxMod!.createProductionCustodySink(() => current);
    const batchA = custody.beginRequest();
    batchA.capture({ eventId: 'custody-swap-a', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await batchA.flush();
    current = workspaceB.store;
    const batchB = custody.beginRequest();
    batchB.capture({ eventId: 'custody-swap-b', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await batchB.flush();
    const readA = readOutboxOnFreshConnection(workspaceA.dbPath); const readB = readOutboxOnFreshConnection(workspaceB.dbPath);
    expect(readA.error, "store A's audit_outbox reads cleanly").toBeNull();
    expect(readB.error, "store B's audit_outbox reads cleanly").toBeNull();
    expect(readA.rows.filter((r) => r.event_id === 'custody-swap-a').length, 'the FIRST batch flush (resolver → A) landed its durable row in store A').toBe(1);
    expect(readA.rows.filter((r) => r.event_id === 'custody-swap-b').length, 'the SECOND batch flush NEVER landed in store A (the resolver was swapped)').toBe(0);
    expect(readB.rows.filter((r) => r.event_id === 'custody-swap-b').length, 'the SECOND batch flush (resolver → B) landed its durable row in store B — the CURRENT store at flush time').toBe(1);
    expect(readB.rows.filter((r) => r.event_id === 'custody-swap-a').length, 'store B never saw the first flush').toBe(0);
  });

  itReal('concurrent request batches (R9-3): two OVERLAPPING beginRequest() batches on ONE custody sink — A\'s flush lands ONLY A\'s envelope, B\'s discard never erases A\'s committed row, and A\'s discard never drops B\'s later-flushed envelope (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 item 4; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-custody-concurrent-');
    await outboxMod!.bindOutboxBinding(ws.store, 'audit-custody-concurrent');
    const custody = outboxMod!.createProductionCustodySink(() => ws.store);
    const a1 = custody.beginRequest();
    const b1 = custody.beginRequest();
    a1.capture({ eventId: 'custody-concurrent-a1', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    b1.capture({ eventId: 'custody-concurrent-b1', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await a1.flush();
    const read1 = readOutboxOnFreshConnection(ws.dbPath);
    expect(read1.rows.filter((r) => r.event_id === 'custody-concurrent-a1').length, 'A\'s flush landed A\'s OWN durable row').toBe(1);
    expect(read1.rows.filter((r) => r.event_id === 'custody-concurrent-b1').length, 'A\'s flush NEVER dragged B\'s not-yet-committed envelope along — request-scoped isolation, the exact R9-3 failure').toBe(0);
    b1.discard();
    const read2 = readOutboxOnFreshConnection(ws.dbPath);
    expect(read2.rows.filter((r) => r.event_id === 'custody-concurrent-a1').length, 'B\'s discard NEVER erased A\'s committed durable row').toBe(1);
    expect(read2.rows.filter((r) => r.event_id === 'custody-concurrent-b1').length, 'B\'s discarded envelope never landed').toBe(0);
    const a2 = custody.beginRequest();
    const b2 = custody.beginRequest();
    a2.capture({ eventId: 'custody-concurrent-a2', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    b2.capture({ eventId: 'custody-concurrent-b2', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    a2.discard();
    await b2.flush();
    const read3 = readOutboxOnFreshConnection(ws.dbPath);
    expect(read3.rows.filter((r) => r.event_id === 'custody-concurrent-b2').length, 'A\'s discard NEVER dropped B\'s envelope — B\'s later flush still landed its durable row').toBe(1);
    expect(read3.rows.filter((r) => r.event_id === 'custody-concurrent-a2').length, 'A\'s discarded envelope never landed').toBe(0);
    expect(read3.rows.length, 'exactly the two committed envelopes (a1 + b2) are durable — no leak into another request, no loss from another request\'s discard').toBe(2);
  });

  itReal('journal fallback (R8-6): a real fallback entry is stamped with the CAPTURE-TIME clear_gen; consume with current clear_gen > entry.gen DISCARDS it; consume with current clear_gen <= entry.gen INSERTS it with a FRESH seq above the seeded floor (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v11 items 1-3; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const discardWs = await openWorkspaceStore('audit-journal-discard-');
    await outboxMod!.bindOutboxBinding(discardWs.store, 'audit-journal-discard'); await outboxMod!.captureClear(discardWs.store);
    const discardJournal = path.join(discardWs.root, 'audit-journal.json');
    await outboxMod!.writeAuditJournalFallback(discardWs.store, discardJournal, { eventId: 'journal-fallback-discard', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    expect(fs.readdirSync(discardWs.root).filter((f) => f.startsWith('audit-journal')), 'the journal write left exactly the real journal file at journalPath (tmp+rename discipline: no leftover temp sibling)').toEqual(['audit-journal.json']);
    const stamped = (JSON.parse(fs.readFileSync(discardJournal, 'utf8')) as { fallback?: Array<{ envelope?: { eventId?: string }; gen?: number }> }).fallback?.find((e) => e.envelope?.eventId === 'journal-fallback-discard');
    expect(stamped, 'the journal file holds the fallback entry under its declared `fallback` array of { envelope, gen } (header item 3)').toBeDefined();
    expect(stamped!.gen, '(a) the fallback entry is stamped with the CAPTURE-TIME clear_gen (1 after one captureClear on a fresh store; plan item 3)').toBe(1);
    await outboxMod!.captureClear(discardWs.store);
    await outboxMod!.consumeAuditJournal(discardWs.store, discardJournal);
    const afterDiscard = readOutboxOnFreshConnection(discardWs.dbPath);
    expect(afterDiscard.error, "the discard-side store's audit_outbox reads cleanly after consume").toBeNull();
    expect(afterDiscard.rows.filter((r) => r.event_id === 'journal-fallback-discard').length, '(b) consume with current clear_gen (2) > entry.gen (1) DISCARDS the entry — the pre-clear custody event must NOT resurrect (the generation gate on a real store + real journal; no mock)').toBe(0);
    const insertWs = await openWorkspaceStore('audit-journal-insert-');
    await outboxMod!.bindOutboxBinding(insertWs.store, 'audit-journal-insert'); await outboxMod!.captureClear(insertWs.store);
    const seeder = outboxMod!.createProductionCustodySink(() => insertWs.store);
    const seedBatch = seeder.beginRequest();
    seedBatch.capture({ eventId: 'journal-fallback-floor-seed', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await seedBatch.flush();
    const floorRows = readOutboxOnFreshConnection(insertWs.dbPath).rows.filter((r) => r.event_id === 'journal-fallback-floor-seed');
    expect(floorRows.length, 'the floor-seed append landed a real durable row (the seeded floor is real, not assumed)').toBe(1);
    const floorSeq = floorRows[0]!.seq; const insertJournal = path.join(insertWs.root, 'audit-journal.json');
    await outboxMod!.writeAuditJournalFallback(insertWs.store, insertJournal, { eventId: 'journal-fallback-insert', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    await outboxMod!.consumeAuditJournal(insertWs.store, insertJournal);
    const inserted = readOutboxOnFreshConnection(insertWs.dbPath).rows.filter((r) => r.event_id === 'journal-fallback-insert');
    expect(inserted.length, '(c) consume with current clear_gen (1) <= entry.gen (1) INSERTS the fallback entry through the append path').toBe(1);
    expect(inserted[0]!.seq, `the inserted row took a FRESH allocation above the seeded floor (seq ${String(inserted[0]?.seq)} > floor ${String(floorSeq)} — item 1: fallbacks take fresh allocations above the max-merged floor)`).toBeGreaterThan(floorSeq);
  });

  itReal('gen_high RESTORE max-merge (R12-6 — 06 :1095-1101: the journal schema omitted gen_high and no leg restored it, so an implementation could drop/reset the counter during journal or backup restore and pass every other check): UNEQUAL active-store/journal/backup high-waters (different-prefix bind counts 5/9/7 — the plan Part 4 v13 item 5 shape) survive their restore/consume paths and a fresh bind after binding-row REMOVAL allocates STRICTLY ABOVE the observed MAX — for the active-store-plus-journal case, the journal-only case, and the backup-plus-journal case (a real db-file backup copy reopened as the restored store) (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v13 item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    // Arrange the UNEQUAL high-waters by bind COUNT (each different-prefix
    // bind runs one read-increment-write, header item 6): the journal source
    // store J (9 binds) > the backup store K (7) > the active store S (5).
    const storeS = await openWorkspaceStore('audit-gen-restore-active-');
    for (let i = 0; i < 5; i += 1) await outboxMod!.bindOutboxBinding(storeS.store, `gen-restore-s-${i}`, 200 + i);
    const storeJ = await openWorkspaceStore('audit-gen-restore-journal-');
    for (let i = 0; i < 9; i += 1) await outboxMod!.bindOutboxBinding(storeJ.store, `gen-restore-j-${i}`, 300 + i);
    const storeK = await openWorkspaceStore('audit-gen-restore-backup-');
    for (let i = 0; i < 7; i += 1) await outboxMod!.bindOutboxBinding(storeK.store, `gen-restore-k-${i}`, 400 + i);
    const s5 = readGenHigh(storeS.dbPath); const j9 = readGenHigh(storeJ.dbPath); const k7 = readGenHigh(storeK.dbPath);
    expect(s5.error, "the active store's gen_high carrier reads on a fresh connection").toBeNull();
    expect(j9.error, "the journal source store's gen_high carrier reads").toBeNull();
    expect(k7.error, "the backup store's gen_high carrier reads").toBeNull();
    expect(j9.value! > k7.value! && k7.value! > s5.value!, `the arrange produced UNEQUAL high-waters with journal (9 binds → ${String(j9.value)}) > backup (7 binds → ${String(k7.value)}) > active (5 binds → ${String(s5.value)}) — the plan Part 4 v13 item 5 unequal shape (bind-count orderings hold under any monotonic numbering base)`).toBe(true);
    // The journal file carries the SOURCE store's high-waters — gen_high
    // alongside the fallback entry (rev-7 header item 3).
    const journalPath = path.join(storeJ.root, 'audit-restore-journal.json');
    await outboxMod!.writeAuditJournalFallback(storeJ.store, journalPath, { eventId: 'gen-restore-fallback', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    const journalRead = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { gen_high?: unknown };
    expect(journalRead.gen_high, `the journal file carries the journal schema's gen_high (rev-7 header item 3; plan Part 4 v13 item 2) — the source store's ${String(j9.value)}`).toBe(j9.value);
    // (a) ACTIVE-STORE-PLUS-JOURNAL: consume merges the journal's 9 over
    // the active store's 5 → binding row removed → fresh bind STRICTLY
    // above the observed MAX.
    await outboxMod!.consumeAuditJournal(storeS.store, journalPath);
    const mergedA = readGenHigh(storeS.dbPath);
    expect(mergedA.error, 'the merged active store gen_high reads on a fresh connection').toBeNull();
    const maxA = Math.max(s5.value!, j9.value!);
    expect(mergedA.value!, `the consume installed the EXACT MAX over the active store's ${String(s5.value)} (journal gen_high ${String(j9.value)} max-merged → carrier EQUALS ${String(maxA)}, asserted BEFORE binding-row removal — rev 8 tightens the rev-7 >= to exact equality; the journal IS the max in THIS ordering, so the journal-overwrite mutant is indistinguishable here and is killed by the REVERSED legs below; plan Part 4 v14 item 5, R13-4)`).toBe(maxA);
    removeBindingCarrierRows(storeS.dbPath);
    const freshA = await outboxMod!.bindOutboxBinding(storeS.store, 'gen-restore-fresh-a', 501);
    expect(freshA.generation, `after the restore/consume AND binding-row removal the fresh bind allocated STRICTLY ABOVE the observed MAX (${String(freshA.generation)} > ${String(maxA)}) — the reset-gen_high mutant (restore zeroes the counter → fresh bind reuses a low generation like 1) fails exactly this assertion (R12-6; plan Part 4 v14 item 5)`).toBeGreaterThan(maxA);
    // (b) JOURNAL-ONLY: a store with NO gen_high row (no binds at all)
    // consumes the journal and must still allocate strictly above the
    // journal's value.
    const storeOnly = await openWorkspaceStore('audit-gen-restore-jonly-');
    const beforeOnly = readGenHigh(storeOnly.dbPath);
    expect(beforeOnly.value, 'the journal-only store starts with NO gen_high row (no binds — the "no active-store row" premise of the journal-only restore)').toBeNull();
    await outboxMod!.consumeAuditJournal(storeOnly.store, journalPath);
    const freshOnly = await outboxMod!.bindOutboxBinding(storeOnly.store, 'gen-restore-fresh-jonly', 511);
    expect(freshOnly.generation, `journal-only restore: the fresh bind allocated STRICTLY ABOVE the journal's gen_high (${String(freshOnly.generation)} > ${String(j9.value)}) — the counter came from the journal alone (R12-6; plan Part 4 v13 item 5)`).toBeGreaterThan(j9.value!);
    // (c) BACKUP-PLUS-JOURNAL: a real db-file backup copy of store K
    // (closed first so the WAL is checkpointed into the copied file),
    // reopened as the restored store, then the journal consumed on top —
    // the fresh bind must clear the MAX of BOTH sources.
    storeK.store.close();
    const restoredRoot = makeTempDir('audit-gen-restore-restored-');
    const restoredPath = path.join(restoredRoot, 'store.db');
    fs.copyFileSync(storeK.dbPath, restoredPath);
    const storeMod = await import('../../main/backend/store/sqlite-store.js');
    const restored = storeMod.openStore({ dbPath: restoredPath, dims: 8 });
    openStores.push(restored);
    const restoredGh = readGenHigh(restoredPath);
    expect(restoredGh.value, `the backup/restore file round-trip preserved the backup store's gen_high (${String(k7.value)}) — a restore path that resets the counter on reopen fails here (R12-6)`).toBe(k7.value);
    await outboxMod!.consumeAuditJournal(restored, journalPath);
    removeBindingCarrierRows(restoredPath);
    const freshRestored = await outboxMod!.bindOutboxBinding(restored, 'gen-restore-fresh-restored', 521);
    const maxC = Math.max(k7.value!, j9.value!);
    expect(freshRestored.generation, `backup-plus-journal restore: the fresh bind allocated STRICTLY ABOVE the MAX of both sources (${String(freshRestored.generation)} > max(backup ${String(k7.value)}, journal ${String(j9.value)})) — max(7,9)=9-shape; a restore that keeps only ONE source's counter fails when the journal is the higher one (R12-6; plan Part 4 v13 item 5)`).toBeGreaterThan(maxC);
  });

  itReal('gen_high RESTORE max-merge, REVERSED orderings (R13-4 — 06 :1152-1157: every rev-7 consume scenario made the JOURNAL the largest value, so a mutant assigning destination.gen_high = journal.gen_high instead of taking the maximum passed active(5)+journal(9), journal-only(9), backup(7)+journal(9), and the crash/reopen leg — then reused a low generation whenever the active or backup high-water exceeded the journal): REVERSED legs where ACTIVE=12 > journal=9 and BACKUP=11 > journal=9 assert the post-consume carrier EQUALS the EXACT MAX BEFORE binding-row removal, then a fresh bind STRICTLY above that MAX — the journal-overwrite mutant AND the reset-to-zero mutant are BOTH RED here (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v14 item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    // The JOURNAL source: 9 different-prefix binds → gen_high 9 (the LOWER
    // source in both reversed orderings — the exact position the journal
    // never held in rev 7).
    const storeJ = await openWorkspaceStore('audit-gen-reversed-journal-');
    for (let i = 0; i < 9; i += 1) await outboxMod!.bindOutboxBinding(storeJ.store, `gen-reversed-j-${i}`, 700 + i);
    const j9 = readGenHigh(storeJ.dbPath);
    expect(j9.error, "the journal source store's gen_high carrier reads on a fresh connection").toBeNull();
    expect(j9.value!, 'the journal source store carries a positive high-water (nine different-prefix binds)').toBeGreaterThan(0);
    const journalPath = path.join(storeJ.root, 'audit-reversed-journal.json');
    await outboxMod!.writeAuditJournalFallback(storeJ.store, journalPath, { eventId: 'gen-reversed-fallback', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    const journalRead = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { gen_high?: unknown };
    expect(journalRead.gen_high, `the journal file carries the journal schema's gen_high — the source store's ${String(j9.value)} (rev-7 header item 3; plan Part 4 v14 item 5)`).toBe(j9.value);
    // (b) REVERSED ACTIVE-LARGEST: the active store's 12 binds EXCEED the
    // journal's 9 — the post-consume carrier must EQUAL exactly 12 (an
    // overwrite-with-journal mutant installs 9 ≠ 12 and FAILS; a reset-to-zero
    // mutant installs nothing and FAILS), asserted BEFORE binding-row
    // removal, then the fresh bind must be STRICTLY above 12.
    const storeActive = await openWorkspaceStore('audit-gen-reversed-active-');
    for (let i = 0; i < 12; i += 1) await outboxMod!.bindOutboxBinding(storeActive.store, `gen-reversed-a-${i}`, 710 + i);
    const a12 = readGenHigh(storeActive.dbPath);
    expect(a12.error, "the reversed active store's gen_high carrier reads on a fresh connection").toBeNull();
    expect(a12.value! > j9.value!, `the arrange produced the REVERSED ordering — ACTIVE ${String(a12.value)} > journal ${String(j9.value)} (the journal is the LOWER source: the exact position it never held in rev 7; plan Part 4 v14 item 5, R13-4)`).toBe(true);
    await outboxMod!.consumeAuditJournal(storeActive.store, journalPath);
    const mergedB = readGenHigh(storeActive.dbPath);
    expect(mergedB.error, 'the merged reversed-active gen_high reads on a fresh connection').toBeNull();
    expect(mergedB.value!, `REVERSED active-largest: the post-consume carrier EQUALS the EXACT MAX ${String(a12.value)} — asserted BEFORE binding-row removal (the journal-overwrite mutant destination.gen_high = journal.gen_high installs ${String(j9.value)} ≠ ${String(a12.value)} and FAILS here; the reset-to-zero mutant likewise; plan Part 4 v14 item 5, R13-4)`).toBe(a12.value!);
    removeBindingCarrierRows(storeActive.dbPath);
    const freshB = await outboxMod!.bindOutboxBinding(storeActive.store, 'gen-reversed-fresh-active', 721);
    expect(freshB.generation, `after the REVERSED restore AND binding-row removal the fresh bind allocated STRICTLY ABOVE the MAX (${String(freshB.generation)} > ${String(a12.value)}) — the overwrite mutant reuses a journal-bound low generation (fresh would be ${String(j9.value) + '+1'}-shaped, not > ${String(a12.value)}), recreating the monotonic-adoption premise failure (plan Part 4 v14 item 5, R13-4)`).toBeGreaterThan(a12.value!);
    // (c) REVERSED BACKUP-LARGEST: a real db-file backup copy of an 11-bind
    // store (closed first so the WAL is checkpointed into the copied file),
    // reopened as the restored store — the journal (9) consumed on top must
    // NOT drag the carrier down from 11.
    const storeBackup = await openWorkspaceStore('audit-gen-reversed-backup-');
    for (let i = 0; i < 11; i += 1) await outboxMod!.bindOutboxBinding(storeBackup.store, `gen-reversed-k-${i}`, 730 + i);
    const k11 = readGenHigh(storeBackup.dbPath);
    expect(k11.error, "the reversed backup store's gen_high carrier reads on a fresh connection").toBeNull();
    expect(k11.value! > j9.value!, `the backup arrange produced the REVERSED ordering — BACKUP ${String(k11.value)} > journal ${String(j9.value)} (plan Part 4 v14 item 5, R13-4)`).toBe(true);
    storeBackup.store.close();
    const restoredRoot = makeTempDir('audit-gen-reversed-restored-');
    const restoredPath = path.join(restoredRoot, 'store.db');
    fs.copyFileSync(storeBackup.dbPath, restoredPath);
    const storeMod = await import('../../main/backend/store/sqlite-store.js');
    const restored = storeMod.openStore({ dbPath: restoredPath, dims: 8 });
    openStores.push(restored);
    const reopenedK = readGenHigh(restoredPath);
    expect(reopenedK.value, `the backup file round-trip preserved the backup's gen_high ${String(k11.value)} (the reopen never resets the counter)`).toBe(k11.value);
    await outboxMod!.consumeAuditJournal(restored, journalPath);
    const mergedC = readGenHigh(restoredPath);
    expect(mergedC.error, 'the merged reversed-backup gen_high reads on a fresh connection').toBeNull();
    expect(mergedC.value!, `REVERSED backup-largest: the post-consume carrier EQUALS the EXACT MAX ${String(k11.value)} — the journal's ${String(j9.value)} is the LOWER source, so the overwrite mutant installs ${String(j9.value)} ≠ ${String(k11.value)} and FAILS here (plan Part 4 v14 item 5, R13-4)`).toBe(k11.value!);
    removeBindingCarrierRows(restoredPath);
    const freshC = await outboxMod!.bindOutboxBinding(restored, 'gen-reversed-fresh-backup', 741);
    expect(freshC.generation, `reversed backup-largest restore: the fresh bind allocated STRICTLY ABOVE the MAX (${String(freshC.generation)} > ${String(k11.value)}) — plan Part 4 v14 item 5, R13-4`).toBeGreaterThan(k11.value!);
  });

  itReal('gen_high crash/reopen between journal write and consume (R12-6): the counter survives a close/reopen of the store that wrote the journal, and the DELAYED consume still max-merges — the crash window between the destructive-op journal write and the consume at open loses nothing (audit-outbox-production)', async () => {
    const outboxMod = (await import('../../main/backend/audit-outbox.js').catch(() => null)) as unknown as ProductionOutboxModule | null;
    expect(outboxMod, 'the production outbox module desktop/main/backend/audit-outbox.ts must exist (plan Part 4 v13 item 5; NEW-SURFACE import declared in the header, absent pre-fix)').not.toBeNull();
    const ws = await openWorkspaceStore('audit-gen-crash-');
    for (let i = 0; i < 3; i += 1) await outboxMod!.bindOutboxBinding(ws.store, `gen-crash-${i}`, 600 + i);
    const before = readGenHigh(ws.dbPath);
    expect(before.error, 'the pre-crash gen_high carrier reads on a fresh connection').toBeNull();
    expect(before.value!, `the arrange binds allocated a positive high-water (${String(before.value)} — three different-prefix binds)`).toBeGreaterThan(0);
    // The destructive-op arm: journal the ACTIVE store...
    const journalPath = path.join(ws.root, 'audit-crash-journal.json');
    await outboxMod!.writeAuditJournalFallback(ws.store, journalPath, { eventId: 'gen-crash-fallback', event: 'settings_change', subject: 'external.apiKey', occurredAt: Date.now() });
    // ...then CRASH before the consume: close the handle and REOPEN the
    // same database file (the crash/reopen window — no consume ran first).
    ws.store.close();
    const storeMod = await import('../../main/backend/store/sqlite-store.js');
    const reopened = storeMod.openStore({ dbPath: ws.dbPath, dims: 8 });
    openStores.push(reopened);
    const afterReopen = readGenHigh(ws.dbPath);
    expect(afterReopen.error, 'the reopened store\'s gen_high carrier reads').toBeNull();
    expect(afterReopen.value, `gen_high SURVIVED the crash/reopen unchanged (${String(afterReopen.value)} === ${String(before.value)}) — the counter is durable in its own row, never rebuilt from a binding that the crash window may have lost (R12-6; plan Part 4 v13 item 5)`).toBe(before.value);
    // The delayed consume at the (re)opened store still max-merges and the
    // fresh bind stays strictly above the survived high-water.
    await outboxMod!.consumeAuditJournal(reopened, journalPath);
    removeBindingCarrierRows(ws.dbPath);
    const fresh = await outboxMod!.bindOutboxBinding(reopened, 'gen-crash-fresh', 611);
    expect(fresh.generation, `after the delayed post-crash consume and binding-row removal the fresh bind allocated STRICTLY ABOVE the survived high-water (${String(fresh.generation)} > ${String(afterReopen.value)}) — the crash window between journal write and consume lost nothing (R12-6; plan Part 4 v13 item 5)`).toBeGreaterThan(afterReopen.value!);
  });
});
