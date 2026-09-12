// Decode layer for Articulate Storyline 360 HTML5 publishes (issue #77, G1).
//
// Two and only two payload wrappers exist in a publish (verified corpus-wide;
// see .agents/issue-traces/77-storyline-extractor/03-localization-log.md H1/H5):
//   1. window.globalProvideData('<name>', '<JS-escaped JSON>')  — slide/data/frame
//   2. const data = {...}; window.globalLoadJsAsset(..., JSON.stringify(data))
//      — story_content/*_transcripts.js sidecars
// Payloads are read utf-8-sig (BOM stripped). The JS payload's only escape
// forms are \\ and \' (corpus census); they are unescaped in one regex pass so
// a backslash immediately before a quote is never double-processed. Everything
// else (\", \n, \uXXXX) is JSON-native and left for JSON.parse. NEVER decode
// these payloads with a unicode_escape-style codec: it round-trips through
// latin-1 and mojibakes non-ASCII (the U+2019 regression AC3 bites).

import { readFileSync } from 'node:fs';

/** utf-8-sig semantics: strip one leading BOM from a utf-8 read. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read a publish file as utf-8-sig. */
export function readTextFile(path: string): string {
  return stripBom(readFileSync(path, 'utf8'));
}

/**
 * Decode the payload of window.globalProvideData('<payloadName>', '...').
 * Throws (message mentions globalProvideData AND the caller-supplied source
 * path, if any) when the wrapper is absent or unterminated.
 */
export function decodeGlobalProvideData(payloadName: string, text: string, sourcePath?: string): unknown {
  const marker = `window.globalProvideData('${payloadName}', '`;
  const at = text.indexOf(marker);
  if (at === -1) {
    throw new Error(
      `no window.globalProvideData('${payloadName}', ...) wrapper found in ${sourcePath ?? '<input>'}`,
    );
  }
  const start = at + marker.length;
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2; // skip escaped char; the terminating quote is unescaped only
      continue;
    }
    if (text[i] === "'") break;
    i += 1;
  }
  if (i >= text.length) {
    throw new Error(`unterminated window.globalProvideData('${payloadName}', ...) payload in ${sourcePath ?? '<input>'}`);
  }
  const raw = text.slice(start, i);
  const unescaped = raw.replace(/\\\\|\\'/g, (m) => (m === '\\\\' ? '\\' : "'"));
  return JSON.parse(unescaped) as unknown;
}

/** Decode a story_content/<id>_transcripts.js sidecar asset. */
export function decodeSidecarAsset(text: string, sourcePath?: string): unknown {
  const m = /const data = (\{[\s\S]*\});\s*window\.globalLoadJsAsset/.exec(text);
  if (m === null || m[1] === undefined) {
    throw new Error(
      `no \`const data = {...}\` + globalLoadJsAsset wrapper found in ${sourcePath ?? '<input>'} — file is not a Storyline sidecar asset`,
    );
  }
  return JSON.parse(m[1]) as unknown;
}
