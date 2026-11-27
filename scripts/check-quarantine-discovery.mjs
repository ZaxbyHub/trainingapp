#!/usr/bin/env node
// scripts/check-quarantine-discovery.mjs — issue #348 guardrail.
//
// The vitest-quarantine honesty spec pins the CONFIG's exclusion surface
// (resolved include/exclude/dir/root/plugins/workspace). This script closes the
// last gap by asking Vitest's own default entrypoint what it DISCOVERS, in a
// subprocess with a scrubbed worker environment (so a `VITEST_WORKER_ID`
// branch cannot behave differently here than in a plain CLI run).
//
// It performs discovery only (`vitest list --filesOnly --json`) — no test runs.
// Fails if any of the seven specs discharged by issue #348 is not discovered.
//
// Usage: node scripts/check-quarantine-discovery.mjs [--web-ui <dir>]

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED = [
  'src/components/InferenceModeToggle.test.tsx',
  'src/pages/ChatPage.test.tsx',
  'src/pages/ChatPage.verification-3.3.test.tsx',
  'src/pages/DocumentsPage.test.tsx',
  'src/pages/ChatPage.rag.test.tsx',
  'src/lib/inference/InferenceModeContext.test.tsx',
  'src/test/verification/text-chunker.task44.test.ts',
]

const argv = process.argv.slice(2)
const i = argv.indexOf('--web-ui')
const webUi = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(root, 'web_ui')

// Scrub the worker environment: discovery must match a plain CLI invocation.
const env = { ...process.env }
for (const k of Object.keys(env)) {
  if (k.startsWith('VITEST_') || k === 'TEST') delete env[k]
}

const vitest = path.join(webUi, 'node_modules', 'vitest', 'vitest.mjs')
const res = spawnSync(process.execPath, [vitest, 'list', '--filesOnly', '--json'], {
  cwd: webUi,
  env,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})

if (res.error) {
  console.error(`quarantine-discovery: FAIL — could not run vitest list: ${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error(`quarantine-discovery: FAIL — vitest list exited ${res.status}`)
  console.error((res.stderr || '').slice(0, 2000))
  process.exit(1)
}

let discovered
try {
  discovered = JSON.parse(res.stdout)
} catch (err) {
  console.error(`quarantine-discovery: FAIL — unparseable vitest list output: ${err.message}`)
  process.exit(1)
}
if (!Array.isArray(discovered)) {
  console.error('quarantine-discovery: FAIL — expected an array of discovered files')
  process.exit(1)
}

const found = new Set(
  discovered
    .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
    .filter(Boolean)
    .map((f) => path.relative(webUi, f).replace(/\\/g, '/'))
)

const missing = REQUIRED.filter((p) => !found.has(p))
if (missing.length > 0) {
  console.error(
    `quarantine-discovery: FAIL — ${missing.length} discharged spec(s) not discovered by the default config:`
  )
  for (const p of missing) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(
  `quarantine-discovery: PASS — all ${REQUIRED.length} discharged specs discovered (${found.size} files total)`
)
