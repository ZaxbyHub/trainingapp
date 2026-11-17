#!/usr/bin/env node
// scripts/quality-harness.mjs — issue #368 WI8.
//
// One command that runs the repo's health gates in dependency order and
// emits a JSON report with per-gate verdict + duration. This is the LOCAL
// twin of what CI already enforces — it adds no new gates.
//
// Usage:
//   npm run quality                          # all gates, human summary
//   npm run quality -- --report report.json  # + JSON report file
//   npm run quality -- --only packtool-build # a gate subset (tests/CI smoke)
//   npm run quality -- --fail-at contract-battery  # testability: simulate a
//                                            # failure at the named gate
//   npm run quality -- --list                # print the roster and exit
//
// Exit codes: 0 all gates green; 1 a gate failed (report names it); 2 usage.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Ordered roster — fast gates first, long suites last. Commands run from the
// repo root through the platform shell so npm/npx resolve per package.
const ROSTER = [
  { name: 'packtool-build', cmd: 'npm --prefix packtool run build' },
  { name: 'typecheck-web', cmd: 'npm --prefix web_ui run typecheck' },
  { name: 'typecheck-web-test', cmd: 'cd web_ui && npx tsc --noEmit -p tsconfig.test.json' },
  { name: 'contract-battery', cmd: 'python -m pytest tests/test_extractor_twins.py tests/test_runtime_pins.py tests/test_319_guards.py tests/test_vendored_xlsx.py tests/test_dependabot_config.py tests/test_dependency_audit_gate.py tests/test_doc_accuracy.py -q' },
  { name: 'interop-battery', cmd: 'python contracts/tests/store-interop/run_interop.py --direction "node->python" && python contracts/tests/store-interop/run_interop.py --direction "python->node"' },
  { name: 'desktop-suite', cmd: 'npm --prefix desktop test' },
  { name: 'web-suite', cmd: 'npm --prefix web_ui test' },
]

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const reportPath = flag('--report')
const only = flag('--only') // comma-separated gate-name subset
const failAt = flag('--fail-at')
if (argv.includes('--list')) {
  for (const g of ROSTER) console.log(`${g.name}\t${g.cmd}`)
  process.exit(0)
}
if (failAt && !ROSTER.some(g => g.name === failAt)) {
  console.error(`--fail-at: no rostered gate named ${failAt}`)
  console.error(`roster: ${ROSTER.map(g => g.name).join(', ')}`)
  process.exit(2)
}

const gates = only
  ? ROSTER.filter(g => only.split(',').map(s => s.trim()).includes(g.name))
  : ROSTER
if (only) {
  const known = new Set(gates.map(g => g.name))
  const asked = only.split(',').map(s => s.trim())
  const unknown = asked.filter(n => !known.has(n))
  if (unknown.length) {
    console.error(`--only: unknown gate(s) ${unknown.join(', ')}; roster: ${ROSTER.map(g => g.name).join(', ')}`)
    process.exit(2)
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = []
let failed = null

for (const gate of gates) {
  const entry = { name: gate.name, cmd: gate.cmd }
  const t0 = Date.now()
  if (failAt && gate.name === failAt) {
    entry.status = 'failed'
    entry.durationMs = 0
    entry.note = 'simulated failure (--fail-at)'
    failed = entry
    results.push(entry)
    console.log(`FAIL  ${gate.name} (simulated)`)
    break
  }
  console.log(`run   ${gate.name}: ${gate.cmd}`)
  const r = spawnSync(gate.cmd, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  entry.durationMs = Date.now() - t0
  entry.exitCode = r.status
  if (r.status === 0) {
    entry.status = 'pass'
    console.log(`pass  ${gate.name} (${(entry.durationMs / 1000).toFixed(1)}s)`)
  } else {
    entry.status = 'failed'
    const tail = (r.stdout?.toString() || '').split('\n').slice(-15).join('\n')
    entry.tail = tail
    console.log(`FAIL  ${gate.name} (exit ${r.status}, ${(entry.durationMs / 1000).toFixed(1)}s) — last output:`)
    console.log(tail)
    failed = entry
    results.push(entry)
    break // fail-fast: stop at the first red gate
  }
  results.push(entry)
}

const report = {
  ranAt: new Date().toISOString(),
  gates: results,
  stoppedAt: failed?.name ?? null,
  allGreen: !failed && results.length === gates.length && results.every(r => r.status === 'pass'),
}

if (reportPath) {
  fs.writeFileSync(path.resolve(root, reportPath), JSON.stringify(report, null, 2) + '\n', 'utf-8')
  console.log(`report: ${reportPath}`)
}

if (failed) {
  console.log(`quality: FAILED at ${failed.name}`)
  process.exit(1)
}
console.log('quality: all rostered gates green')
