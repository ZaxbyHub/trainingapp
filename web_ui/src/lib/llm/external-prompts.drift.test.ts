/**
 * F-004 (PR #142 review): the browser sends the SAME prompt text to an
 * external model as the desktop backend (desktop is canonical). Both twins
 * are parsed with the TypeScript compiler API and every exported string
 * constant is compared by name and value — not a whole-file diff, so comments
 * and formatting may differ. Fails closed: a missing desktop file, a
 * non-literal initializer, an import in either twin, or an empty constant set
 * is a failure, never a skip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as webPrompts from './external-prompts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_FILE = path.join(HERE, 'external-prompts.ts');
const DESKTOP_FILE = path.resolve(HERE, '..', '..', '..', '..', 'desktop', 'main', 'backend', 'inference', 'external-prompts.ts');

/** name -> string value of every exported const; throws on anything not a plain string literal. */
function exportedStrings(file: string): Map<string, string> {
  const source = fs.readFileSync(file, 'utf8'); // a missing twin throws: fail closed
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      throw new Error(`${file}: must be self-contained (found an import)`);
    }
    if (ts.isExportDeclaration(stmt)) throw new Error(`${file}: re-exports are not allowed in a prompt twin`);
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      const name = decl.name.getText(sf);
      const init = decl.initializer;
      if (init === undefined || !(ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
        throw new Error(`${file}: ${name} must be a plain string literal`);
      }
      out.set(name, init.text);
    }
  }
  return out;
}

describe('external prompt twins (desktop canonical, web twin)', () => {
  it('the desktop file exists (never skipped)', () => {
    expect(fs.existsSync(DESKTOP_FILE)).toBe(true);
  });

  it('every exported constant has the identical name and string value in both twins', () => {
    const desktop = exportedStrings(DESKTOP_FILE);
    const web = exportedStrings(WEB_FILE);
    // Non-vacuity: the constants the request builders depend on are present.
    for (const required of ['EXTERNAL_SYSTEM_PROMPT', 'EXTERNAL_GROUNDED_INSTRUCTION', 'EXTERNAL_GROUNDED_QUESTION_LABEL']) {
      expect(desktop.has(required), `desktop ${required}`).toBe(true);
      expect(web.has(required), `web ${required}`).toBe(true);
    }
    expect([...web.keys()].sort()).toEqual([...desktop.keys()].sort());
    for (const [name, value] of desktop) {
      expect(web.get(name), name).toBe(value);
    }
  });

  it('the parsed values are what the module actually exports (the parser is not fooled)', () => {
    const web = exportedStrings(WEB_FILE);
    for (const [name, value] of web) {
      expect((webPrompts as Record<string, unknown>)[name], name).toBe(value);
    }
  });

  it('the parser fails closed on a non-literal initializer and on imports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-drift-'));
    try {
      const computed = path.join(dir, 'computed.ts');
      fs.writeFileSync(computed, "export const EXTERNAL_SYSTEM_PROMPT = 'a' + 'b';\n");
      expect(() => exportedStrings(computed)).toThrow(/plain string literal/);
      const imported = path.join(dir, 'imported.ts');
      fs.writeFileSync(imported, "import { X } from './x';\nexport const EXTERNAL_SYSTEM_PROMPT = X;\n");
      expect(() => exportedStrings(imported)).toThrow(/self-contained/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
