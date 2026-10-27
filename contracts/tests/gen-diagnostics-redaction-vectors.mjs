#!/usr/bin/env node
// gen-diagnostics-redaction-vectors.mjs — regenerates contracts/diagnostics-redaction-vectors.json,
// the shared diagnostics-redaction corpus (issue #248, AC5) consumed by
//   desktop/src/__tests__/diagnostics-redact-parity.test.ts  (both twins + desktop console outcomes)
//   web_ui/src/lib/logging/__tests__/web-logging.test.ts      (renderer console outcomes + persisted parity)
// The persisted bytes are computed FROM THE REAL TWINS (desktop/main/logging-redact.ts and
// web_ui/src/lib/logging/redact.ts are both imported and must agree), so the corpus and the gates
// cannot drift; the console expectations are declared policy (clean raw / AC7-pinned raw on
// desktop / other sensitive sanitized). Fully deterministic — no keys, no timestamps.
//
// Secret-shaped literals in the corpus are deliberately synthetic (PRR-066/067): provider keys
// use the sk-test- prefix with alternating characters, emails use example.com, and home paths
// use the neutral username op01 — shapes that still exercise every redaction class without
// resembling real credentials in a public repo.
//
// usage: node contracts/tests/gen-diagnostics-redaction-vectors.mjs [outFile]
// (outFile defaults to the committed corpus; desktop/src/__tests__/diagnostics-redact-parity.test.ts
// passes a temp path to prove the committed corpus still matches this generator.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'diagnostics-redaction-vectors.json');

// Node >= 23.6 loads the type-stripped TS twins natively (the repo pins Node 24);
// both twins deliberately import nothing, so plain node resolves them.
const desktopRedact = await import(pathToFileURL(path.join(here, '..', '..', 'desktop', 'main', 'logging-redact.ts')).href);
const webRedact = await import(pathToFileURL(path.join(here, '..', '..', 'web_ui', 'src', 'lib', 'logging', 'redact.ts')).href);

/** Persisted form for one vector, computed by the twins (they must agree). */
function persist(input) {
  const line = typeof input === 'string' ? input : webRedact.renderLine(input.args);
  const fromDesktop = desktopRedact.persistedForm(line);
  const fromWeb = webRedact.persistedForm(line);
  if (fromDesktop !== fromWeb) {
    throw new Error(`the redaction twins disagree on ${JSON.stringify(input)}: desktop=${JSON.stringify(fromDesktop)} web=${JSON.stringify(fromWeb)}`);
  }
  return fromDesktop;
}

const vectors = [];
/** raw = clean passthrough on both platforms. */
const clean = { desktop: 'raw', renderer: 'raw' };
/** sanitized = gated on both platforms (no AC7 exception). */
const sanitized = { desktop: 'sanitized', renderer: 'sanitized' };
/** AC7 exception: the desktop pins this exact shape raw; the renderer's exception set is empty. */
const pinnedDesktopRaw = { desktop: 'raw', renderer: 'sanitized' };
const add = (name, input, consoleOutcome) => vectors.push({ name, input, persisted: persist(input), console: consoleOutcome });

add('clean-backend-status-line', '[trainingapp-backend] sidecar exited; restarting (attempt 2 after 4321ms backoff)', clean);
add('long-hex-run', 'doc hash deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef computed', sanitized);
add('bearer-scheme-token', 'request rejected: bearer abcdef1234567890abcdef', sanitized);
add('jwt-token', 'handoff failed for eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', sanitized);
// Quoted values redact exactly the quoted span, so several kv shapes fit on one line.
add(
  'kv-secret-shapes',
  'connect host=db.internal password="hunter2" token: "8f3a9c1d" api_key="sk-live-abcdef123456"',
  sanitized,
);
// PRR-011: a BARE value is the rest of the line — a password phrase, not its first token.
add('kv-bare-value-is-rest-of-line', 'auth ok password=correct horse battery staple', sanitized);
// PRR-012: compound/plural key names reach the key union.
add(
  'kv-compound-keys',
  'oauth client_secret=synth-secret-value-one\nrefresh_token=synth-refresh-value-two\nopenai_api_key=synth-openai-value-three\nsecrets: rotate monthly',
  sanitized,
);
// The prose guard: "the secret of" and "tokenizer" must stay clean (no separator, no bare key).
add('kv-prose-not-mangled', 'the secret of the universe remains unknown; tokenizer loaded vocab 51206', clean);
add('sk-provider-key', 'provider rejected key sk-test-AbCdAbCdAbCdAbCdAbCd for model x', sanitized);
add('user-home-path', 'model load failed at C:\\Users\\op01/models/quality/model.gguf after 3 tries', sanitized);
// PRR-025: the POSIX branch of the user-home class.
add('posix-home-path', 'model load failed at /home/op01/models/quality/model.gguf after 3 tries', sanitized);
add('macos-home-path', 'cache miss for /Users/op01/Library/Application Support/trainingapp/x.bin', sanitized);
add('email-address', 'profile owner op01@example.com re-ran setup', sanitized);
// PRR-029: a zero-width character inside a key must not dodge the union.
add('zero-width-split-key', 'auth scheme token\u200b=hunter2 rejected', sanitized);
add('multiline-with-secret', 'ingest failed\nrow 2: session_id=9182736465abc\nrow 3 skipped', sanitized);
add('secret-straddling-truncation-boundary', `${'x'.repeat(1995)}${'deadbeef'.repeat(8)}`, sanitized);
add(
  'pinned-corpus-shape-no-live-chunks (AC7 exception)',
  '[pack-manager] demo-pack@1.2.3: no live chunks for doc deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef; row deactivated',
  pinnedDesktopRaw,
);
add(
  'pinned-corpus-shape-manifest-unreadable (AC7 exception)',
  '[pack-manager] demo-pack@1.2.3: managed manifest unreadable at C:\\Users\\op01\\AppData\\Roaming\\trainingapp\\packs\\demo-pack\\1.2.3\\pack.json; treating as no docs',
  pinnedDesktopRaw,
);
add(
  'pinned-corpus-shape-manifest-unparseable (AC7 exception)',
  '[pack-manager] demo-pack@1.2.3: managed manifest unparseable at C:\\Users\\op01\\AppData\\Roaming\\trainingapp\\packs\\demo-pack\\1.2.3\\pack.json; treating as no docs',
  pinnedDesktopRaw,
);
add(
  'classification-failure-guard-json-nested-secrets',
  '{"session_id":"a1b2c3d4e5f6a7b8c9d0","nested":{"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig"}}',
  sanitized,
);
// PRR-031: a multi-arg console call; the persisted form is the joined redaction.
add('split-across-console-args', { args: ['handoff failed', 'session_id=a1b2c3d4e5f6a7b8c9d0', 'retry 1'] }, sanitized);
add('content-bearing-object-denylist', {
  args: ['[RAG] content-gap', { query: 'what is the onboarding password policy?', droppedByFloor: 2, floor: 0.12 }],
}, clean);
// PRR-086: prefix-tolerant denylist names (userText/answer/response/context/message).
add('denylist-prefixed-keys', {
  args: ['[RAG] gap', { userText: 'what is the onboarding password policy?', answer: 'rotate monthly', response: 'ok', context: 'web', message: 'docx style named List Paragraph' }],
}, clean);

const doc = {
  _comment:
    'Shared diagnostics-redaction corpus (issue #248, AC5). Regenerate with node contracts/tests/gen-diagnostics-redaction-vectors.mjs — persisted is computed from the real twins (desktop/main/logging-redact.ts and web_ui/src/lib/logging/redact.ts), which must agree. Consumers: desktop diagnostics-redact-parity.test.ts, web_ui web-logging.test.ts. input is a line or {args}; persisted is the twin-computed gated form; console is the per-platform console outcome (raw | sanitized). Secret-shaped literals are deliberately synthetic (sk-test- prefix, example.com, username op01).',
  version: 1,
  vectors,
};
// Escape the zero-width probe char for reviewability: a raw U+200B in a
// committed file is invisible; the \u200b escape reads back identically.
const text = JSON.stringify(doc, null, 2).replace(/\u200B/g, '\\u200b');
fs.writeFileSync(out, `${text}\n`, 'utf8');
console.log(`wrote ${vectors.length} vectors to ${out}`);
