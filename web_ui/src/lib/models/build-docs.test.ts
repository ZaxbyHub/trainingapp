/**
 * Build/run docs truth tests (issue #272 AC5 / frozen check C10).
 *
 * Reads the three doc surfaces from disk and asserts the issue's AC5
 * conditions verbatim: the "Running the Web UI" block contains build:offline
 * and no standalone `npm run build` line; the models README LLM layout line
 * no longer contains `optional`; the prepare-models LLM warning contains
 * REQUIRED and --no-llm.
 *
 * @vitest-environment node
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(HERE, '..', '..', '..');
const ROOT = resolve(WEB_UI, '..');

const README = readFileSync(join(ROOT, 'README.md'), 'utf-8');
const MODELS_README = readFileSync(join(WEB_UI, 'public', 'models', 'README.md'), 'utf-8');
const PREPARE = readFileSync(join(WEB_UI, 'scripts', 'prepare-models.mjs'), 'utf-8');

describe('web build/run docs tell the truth (issue #272 AC5)', () => {
  test('the Running the Web UI block contains build:offline and start:offline, and no standalone npm run build line', () => {
    const block = README.slice(README.indexOf('### Running the Web UI'), README.indexOf('### TypeScript API Client'));
    expect(block).toContain('build:offline');
    expect(block).toContain('start:offline');
    // A standalone build line = a line starting with `npm run build` that is
    // NOT followed by `:` (so `npm run build:offline` does not count).
    const standalone = block
      .split('\n')
      .filter((l) => l.trimStart().startsWith('npm run build'))
      .filter((l) => !/^npm run build:/.test(l.trimStart()) && !/npm run build:(?!offline)/.test(l.trimStart().replace(/^npm run build\b/, 'npm run build:')) );
    // The single robust predicate: every `npm run build` occurrence on a
    // command line is part of build:offline / build:desktop.
    const badLines = block
      .split('\n')
      .filter((l) => /(^|\s)npm run build(\s|$)/.test(l));
    expect(badLines, `no standalone 'npm run build' line; found: ${JSON.stringify(badLines)}`).toEqual([]);
    expect(standalone).toEqual([]);
  });

  test('the block states that plain npm run build stages no weights', () => {
    const block = README.slice(README.indexOf('### Running the Web UI'), README.indexOf('### TypeScript API Client'));
    expect(block).toMatch(/plain `npm run build` stages no model weights/);
  });

  test('the models README LLM layout line no longer calls the weight optional', () => {
    const line = MODELS_README.split('\n').find((l) => l.includes('llm/') && l.includes('GGUF'));
    expect(line, 'LLM layout line present').toBeDefined();
    expect(line).not.toContain('optional');
    expect(line).toContain('required for in-browser chat unless --no-llm is passed');
  });

  test('the prepare-models LLM warning says REQUIRED and names --no-llm', () => {
    const warning = PREPARE.split('\n').filter((l) => l.includes('browser LLM (LiquidAI')).join('\n');
    expect(warning).toContain('REQUIRED');
    expect(warning).toContain('--no-llm');
    expect(warning).not.toContain('(optional)');
  });
});
