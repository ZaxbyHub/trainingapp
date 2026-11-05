// settings-openapi-parity.test.ts — issue #280 (C5 / check C19): every
// inference.* key the desktop engine reports and accepts must be DECLARED in
// contracts/api.openapi.yaml (SettingsResponse AND SettingsUpdateRequest)
// with value domains that mirror the engine's accept/commit switch.
//
// RED at base, GREEN after the fix: at the base revision the engine's GET
// /settings emitted inference.profile / inference.profileThresholdGb /
// inference.threads / inference.vulkan (and PUT accepted them) while BOTH
// OpenAPI schemas carried no inference.* declaration — accepted-but-
// undeclared settings keys, the exact defect class the collated issue
// records. After the fix both schemas declare the four optional
// desktop-only properties; this spec proves the parity structurally and
// validates the engine's DEFAULT snapshot and one explicit patch result
// against the declared domains with ajv (draft 2020, the same options the
// browser-pack-schema-drift guard uses).
//
// YAML reading: no YAML parser ships in desktop deps; like
// b9-contract-route-parity.test.ts this reads the contract text and extracts
// the two schema blocks with a small structural parse (block boundaries by
// indentation, property entries by the properties: section grammar), then
// parses the flow-mapping property bodies the file uses for one-line
// declarations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { LlamaEngine } from '../../main/backend/inference/llama-engine';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GB = 1024 ** 3;

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const SPEC_TEXT = fs.readFileSync(path.join(findRepoRoot(THIS_DIR), 'contracts', 'api.openapi.yaml'), 'utf8');

// ---- structural extraction (indentation grammar only) ----------------------

/** The `    <Name>:` component-schema block (4-space keys under schemas:). */
function schemaBlock(yaml: string, name: string): string {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `    ${name}:`);
  if (start === -1) throw new Error(`schema ${name} not found in the contract`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^ {4}\S/.test(line)) break; // the next 4-space schema key ends the block
    body.push(line);
  }
  return body.join('\n');
}

/** The `      properties:` section of a schema block (6-space keys). */
function propertiesSection(block: string): string {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '      properties:');
  if (start === -1) throw new Error('properties: section not found');
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^ {6}\S/.test(line)) break; // the next 6-space section (required:, ...) ends it
    body.push(line);
  }
  return body.join('\n');
}

/** Property keys -> raw definition text (flow one-liner or gathered block body). */
function propertyEntries(section: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = section.split(/\r?\n/);
  const entryRe = /^ {8}("([^"]+)"|[^:\s][^:]*?):(?:[ \t]+(.+))?$/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^ {8}#/.test(line)) continue; // comment lines are not properties
    const match = entryRe.exec(line);
    if (match === null) continue;
    const key = match[2] ?? match[1]!;
    if (match[3] !== undefined && match[3]!.length > 0) {
      entries.set(key, match[3]!.trim());
    } else {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (/^ {10,}\S/.test(lines[j]!)) body.push(lines[j]!.trim());
        else break;
      }
      entries.set(key, body.join(' '));
      i = j - 1;
    }
  }
  return entries;
}

// ---- flow-mapping parsing (the subset the one-line declarations use) -------

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseFlow(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    const out: Record<string, unknown> = {};
    for (const pair of splitTopLevel(t.slice(1, -1), ',')) {
      const colon = pair.indexOf(':');
      if (colon === -1) continue;
      const key = String(parseFlow(pair.slice(0, colon)));
      out[key] = parseFlow(pair.slice(colon + 1));
    }
    return out;
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return splitTopLevel(t.slice(1, -1), ',').map(parseFlow);
  }
  if ((t.startsWith("'") && t.endsWith("'") && t.length >= 2) || (t.startsWith('"') && t.endsWith('"') && t.length >= 2)) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t; // bare scalar: enum words and descriptions
}

/** A property definition parsed to a JSON-schema node (description kept). */
function parseProperty(raw: string): Record<string, unknown> {
  const parsed = parseFlow(raw) as Record<string, unknown>;
  expect(typeof parsed).toBe('object');
  return parsed;
}

const INFERENCE_KEYS = [
  'inference.profile',
  'inference.profileThresholdGb',
  'inference.threads',
  'inference.vulkan',
] as const;

const RESPONSE_ENTRIES = propertyEntries(propertiesSection(schemaBlock(SPEC_TEXT, 'SettingsResponse')));
const REQUEST_ENTRIES = propertyEntries(propertiesSection(schemaBlock(SPEC_TEXT, 'SettingsUpdateRequest')));

/** The engine's inference.* report, on the CI-safe stub-factory engine. */
function engineSnapshot(engine: LlamaEngine): Record<string, unknown> {
  const settings = engine.responseSettings();
  const inference: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith('inference.')) inference[key] = value;
  }
  return inference;
}

function makeEngine(): LlamaEngine {
  // No models staged and no query is ever issued: responseSettings() and
  // applySettingsPatch() never touch the model dir, so the settings surface
  // is exercisable without a single temp file.
  return new LlamaEngine({
    // Defaults only: profile 'auto', threshold 6 GiB, threads min(cores, 8),
    // vulkan 'auto' — the constructor's documented fallbacks.
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    llamaFactory: async () => ({
      generate: async () => ({ answer: 'unused', cancelled: false }),
      dispose: async () => {},
    }),
  });
}

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_('ajv/dist/2020') as new (opts: object) => { compile(schema: object): (data: unknown) => boolean };

function compileProperties(props: Record<string, unknown>): (data: unknown) => boolean {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile({ type: 'object', additionalProperties: true, properties: props });
}

describe("C19: both schemas declare the engine's inference.* keys with the switch's domains", () => {
  it('the structural parse found both properties sections (harness sanity)', () => {
    expect(RESPONSE_ENTRIES.size, 'the SettingsResponse properties section parsed').toBeGreaterThanOrEqual(20);
    expect(REQUEST_ENTRIES.size, 'the SettingsUpdateRequest properties section parsed').toBeGreaterThanOrEqual(18);
    expect(RESPONSE_ENTRIES.has('external.enabled')).toBe(true);
    expect(REQUEST_ENTRIES.has('reset')).toBe(true);
  });

  it('every inference.* key the engine reports is declared in BOTH schemas — and neither declares one the engine lacks', () => {
    const snapshot = engineSnapshot(makeEngine());
    expect(Object.keys(snapshot).sort()).toEqual([...INFERENCE_KEYS].sort());
    for (const key of INFERENCE_KEYS) {
      expect(RESPONSE_ENTRIES.has(key), `SettingsResponse must declare ${key}`).toBe(true);
      expect(REQUEST_ENTRIES.has(key), `SettingsUpdateRequest must declare ${key}`).toBe(true);
    }
    for (const entries of [RESPONSE_ENTRIES, REQUEST_ENTRIES]) {
      const declared = [...entries.keys()].filter((key) => key.startsWith('inference.'));
      expect(declared.sort()).toEqual([...INFERENCE_KEYS].sort());
    }
    // Optional declarations: the response schema's required list is unchanged.
    const block = schemaBlock(SPEC_TEXT, 'SettingsResponse');
    const lines = block.split(/\r?\n/);
    const reqStart = lines.indexOf('      required:');
    expect(reqStart, 'the required section still exists').toBeGreaterThanOrEqual(0);
    const requiredKeys: string[] = [];
    for (let i = reqStart + 1; i < lines.length; i += 1) {
      const match = /^ {8}- (\S+)$/.exec(lines[i]!);
      if (match === null) break;
      requiredKeys.push(match[1]!);
    }
    expect(requiredKeys.length).toBeGreaterThan(0);
    expect(requiredKeys.some((key) => key.startsWith('inference.')), 'inference.* stays OPTIONAL').toBe(false);
  });

  it("the declared domains mirror the engine's validation switch exactly (both schemas identical)", () => {
    const expected: Record<string, unknown> = {
      'inference.profile': { type: 'string', enum: ['auto', 'fast', 'quality'] },
      'inference.profileThresholdGb': { type: 'number', exclusiveMinimum: 0 },
      'inference.threads': { type: 'integer', minimum: 1, maximum: 64 },
      'inference.vulkan': { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }] },
    };
    for (const key of INFERENCE_KEYS) {
      const response = parseProperty(RESPONSE_ENTRIES.get(key)!);
      const request = parseProperty(REQUEST_ENTRIES.get(key)!);
      expect(typeof response.description, `${key} carries a description`).toBe('string');
      const strip = (node: Record<string, unknown>): Record<string, unknown> => {
        const { description: _ignored, ...rest } = node;
        return rest;
      };
      expect(strip(response)).toEqual(expected[key]);
      expect(strip(request)).toEqual(expected[key]);
    }
  });
});

describe("C19: the engine's values satisfy the declared domains (ajv, draft 2020)", () => {
  const responseSchema = compileProperties(
    Object.fromEntries(INFERENCE_KEYS.map((key) => [key, parseProperty(RESPONSE_ENTRIES.get(key)!)])),
  );
  const requestSchema = compileProperties(
    Object.fromEntries(INFERENCE_KEYS.map((key) => [key, parseProperty(REQUEST_ENTRIES.get(key)!)])),
  );

  it('the DEFAULT snapshot validates: profile auto, threshold 6, threads 8, vulkan auto', () => {
    const snapshot = engineSnapshot(makeEngine());
    expect(snapshot).toEqual({
      'inference.profile': 'auto',
      'inference.profileThresholdGb': 6,
      'inference.threads': 8,
      'inference.vulkan': 'auto',
    });
    const valid = responseSchema(snapshot);
    expect(valid, `ajv accepted the default snapshot: ${JSON.stringify(responseSchema.errors ?? [])}`).toBe(true);
  });

  it('one explicit patch result validates against BOTH schemas', () => {
    const engine = makeEngine();
    const patch = {
      'inference.profile': 'fast',
      'inference.profileThresholdGb': 8,
      'inference.threads': 4,
      'inference.vulkan': true,
    };
    expect(requestSchema(patch), 'the patch itself satisfies the request domains').toBe(true);
    expect(engine.applySettingsPatch(patch)).toEqual({ ok: true });
    const snapshot = engineSnapshot(engine);
    expect(snapshot).toEqual(patch);
    expect(responseSchema(snapshot), "the engine's report satisfies the response domains").toBe(true);
    // The string half of the vulkan union round-trips too.
    expect(engine.applySettingsPatch({ 'inference.vulkan': 'auto' })).toEqual({ ok: true });
    expect(engineSnapshot(engine)['inference.vulkan']).toBe('auto');
  });

  it('values OUTSIDE the declared domains are rejected by the engine (the domains are the switch)', () => {
    const engine = makeEngine();
    const rejects: Array<[string, unknown]> = [
      ['inference.profile', 'turbo'],
      ['inference.profileThresholdGb', 0],
      ['inference.profileThresholdGb', -1],
      ['inference.threads', 0],
      ['inference.threads', 65],
      ['inference.threads', 1.5],
      ['inference.vulkan', 'yes'],
    ];
    for (const [key, value] of rejects) {
      expect(engine.applySettingsPatch({ [key]: value }), `${key}=${String(value)} must be rejected`).toMatchObject({
        ok: false,
      });
    }
  });
});
