// packtool CLI entry (issue #77): packtool storyline extract <publishDir> --out <dir>
// issue #78 adds the optional --asr-dir <dir> ASR transcript store.
// issue #79 adds: packtool build-storyline <publishDir> --out <pack.zip> and
// packtool verify <packPath>.

import { existsSync } from 'node:fs';
import { extractPublishDir } from './storyline/extract.js';
import { buildStorylinePack } from './build/compose.js';
import { verifyPack } from './build/verify.js';
import { SEMVER_PATTERN } from './build/pack-json.js';
import { computeAndWriteLinks } from './links/link-pack.js';

interface ExtractArgs {
  publishDir: string;
  outDir: string;
  asrDir?: string;
}

interface BuildStorylineArgs {
  publishDir: string;
  out: string;
  asrDir?: string;
  embedder: 'hash' | 'onnx';
  modelDir?: string;
  id?: string;
  version?: string;
  name?: string;
  publishedAt?: string;
}

function usage(): never {
  // The FIRST usage line is the frozen acceptance sentinel for the pre-#79
  // tree (trace 79-build-storyline-training-pack, C1/C9/C11); keep it stable.
  console.error('usage: packtool storyline extract <publishDir> --out <dir> [--asr-dir <dir>]');
  console.error('usage: packtool build-storyline <publishDir> --out <pack.zip> [--asr-dir <dir>] [--embedder hash|onnx] [--embedding-model <dir>] [--id <pack-id>] [--version <semver>] [--name <name>] [--published-at <iso>]');
  console.error('usage: packtool verify <packPath>');
  console.error('usage: packtool links --pack <docPackPath> --training <trainingPackPath> [--threshold <cosine>] [--top <k>]');
  process.exit(2);
}

function parseExtractArgs(argv: string[]): ExtractArgs {
  if (argv[0] !== 'storyline' || argv[1] !== 'extract') usage();
  let publishDir: string | undefined;
  let outDir: string | undefined;
  let asrDir: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      outDir = argv[i + 1];
      i++;
    } else if (arg === '--asr-dir') {
      // PR review F10: a missing value (trailing flag, or followed by another
      // -- token) must fail loudly, never silently disable the overlay.
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage();
      asrDir = value;
      i++;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      publishDir = arg;
    } else {
      usage();
    }
  }
  if (publishDir === undefined || outDir === undefined) usage();
  return { publishDir, outDir, asrDir };
}

function flagValue(argv: string[], index: number): { value: string; next: number } | undefined {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return { value, next: index + 1 };
}

function parseBuildStorylineArgs(argv: string[]): BuildStorylineArgs {
  // argv[0] is the verb.
  let publishDir: string | undefined;
  let out: string | undefined;
  let asrDir: string | undefined;
  let embedder: 'hash' | 'onnx' = 'onnx';
  let modelDir: string | undefined;
  let id: string | undefined;
  let version: string | undefined;
  let name: string | undefined;
  let publishedAt: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--out') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      out = flagged.value;
      i = flagged.next;
    } else if (arg === '--asr-dir') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      asrDir = flagged.value;
      i = flagged.next;
    } else if (arg === '--embedder') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      if (flagged.value !== 'hash' && flagged.value !== 'onnx') usage();
      embedder = flagged.value;
      i = flagged.next;
    } else if (arg === '--embedding-model') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      modelDir = flagged.value;
      i = flagged.next;
    } else if (arg === '--id') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      id = flagged.value;
      i = flagged.next;
    } else if (arg === '--version') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      version = flagged.value;
      i = flagged.next;
    } else if (arg === '--name') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      name = flagged.value;
      i = flagged.next;
    } else if (arg === '--published-at') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      publishedAt = flagged.value;
      i = flagged.next;
    } else if (!arg.startsWith('--')) {
      if (publishDir !== undefined) usage();
      publishDir = arg;
    } else {
      usage();
    }
  }
  if (publishDir === undefined || out === undefined) usage();
  // Fail at parse time (PR review RB-3/RB-6): a malformed --published-at
  // previously flowed an Invalid Date into the zip entries, and a non-semver
  // --version produced a pack that only failed later at verify.
  if (publishedAt !== undefined && Number.isNaN(Date.parse(publishedAt))) usage();
  if (version !== undefined && !SEMVER_PATTERN.test(version)) usage();
  return { publishDir, out, asrDir, embedder, modelDir, id, version, name, publishedAt };
}

function runExtract(argv: string[]): number {
  const { publishDir, outDir, asrDir } = parseExtractArgs(argv);
  // PR review F11: a non-existent ASR store directory must fail loudly —
  // silently degrading every transcript_source to 'missing' is the exact
  // failure the flag exists to prevent.
  if (asrDir !== undefined && !existsSync(asrDir)) {
    console.error(`packtool storyline extract: --asr-dir directory does not exist: ${asrDir}`);
    return 2;
  }
  try {
    extractPublishDir(publishDir, outDir, { asrDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`packtool storyline extract failed: ${message}`);
    return 1;
  }
  return 0;
}

async function runBuildStoryline(argv: string[]): Promise<number> {
  const args = parseBuildStorylineArgs(argv);
  if (args.asrDir !== undefined && !existsSync(args.asrDir)) {
    console.error(`packtool build-storyline: --asr-dir directory does not exist: ${args.asrDir}`);
    return 2;
  }
  try {
    const result = await buildStorylinePack(args);
    console.error(
      `build-storyline: ${result.docs} docs, ${result.chunks} chunks, ${result.bytes} bytes -> ${args.out}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`packtool build-storyline failed: ${message}`);
    return 1;
  }
}

async function runVerify(argv: string[]): Promise<number> {
  // argv[0] is the verb; exactly one positional pack path may follow.
  const positional = argv.slice(1).filter((arg) => arg !== undefined && !arg.startsWith('--'));
  if (argv.length !== 2 || positional.length !== 1) usage();
  try {
    const result = await verifyPack(positional[0] ?? '');
    for (const problem of result.problems) {
      console.error(`problem: ${problem}`);
    }
    if (!result.ok) {
      console.error(`verify: FAILED (${result.problems.length} problem(s))`);
      return 1;
    }
    console.error(`verify: OK (docs=${result.docs})`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`packtool verify failed: ${message}`);
    return 1;
  }
}

interface LinksArgs {
  pack: string;
  training: string;
  threshold?: number;
  top?: number;
}

function parseLinksArgs(argv: string[]): LinksArgs {
  // argv[0] is the verb.
  let pack: string | undefined;
  let training: string | undefined;
  let threshold: number | undefined;
  let top: number | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--pack') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      pack = flagged.value;
      i = flagged.next;
    } else if (arg === '--training') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      training = flagged.value;
      i = flagged.next;
    } else if (arg === '--threshold') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      const value = Number(flagged.value);
      // Parse-time range check so a bad --threshold fails as usage (exit 2)
      // instead of a mid-run kernel error.
      if (!Number.isFinite(value) || value < -1 || value > 1) usage();
      threshold = value;
      i = flagged.next;
    } else if (arg === '--top') {
      const flagged = flagValue(argv, i);
      if (flagged === undefined) usage();
      const value = Number(flagged.value);
      if (!Number.isInteger(value) || value < 1) usage();
      top = value;
      i = flagged.next;
    } else {
      usage();
    }
  }
  if (pack === undefined || training === undefined) usage();
  return { pack, training, threshold, top };
}

/**
 * D4/#80: compute doc->slide links for a doc pack against a training pack.
 * Exported for tests (the CLI entry is dist/cli.js; tests import modules).
 */
export async function runLinks(argv: string[]): Promise<number> {
  const args = parseLinksArgs(argv);
  try {
    const result = await computeAndWriteLinks(args.pack, args.training, {
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      ...(args.top !== undefined ? { topK: args.top } : {}),
    });
    console.error(
      `links: wrote ${result.links} row(s) for ${result.chunks} chunk(s) against ${result.slides} slide(s) (threshold ${result.threshold}, top ${result.topK}) -> ${result.outputPath}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`packtool links failed: ${message}`);
    return 1;
  }
}

export function main(argv: string[]): number | Promise<number> {
  const verb = argv[0];
  if (verb === 'storyline') return runExtract(argv);
  if (verb === 'build-storyline') return runBuildStoryline(argv);
  if (verb === 'verify') return runVerify(argv);
  if (verb === 'links') return runLinks(argv);
  usage();
}

// CLI entry point (dist/cli.js); tests import modules only.
if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.js')) {
  const result = main(process.argv.slice(2));
  if (result instanceof Promise) {
    void result.then((code) => {
      process.exit(code);
    });
  } else {
    process.exit(result);
  }
}
