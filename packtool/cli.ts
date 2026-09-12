// packtool CLI entry (issue #77): packtool storyline extract <publishDir> --out <dir>
// issue #78 adds the optional --asr-dir <dir> ASR transcript store.

import { extractPublishDir } from './storyline/extract.js';

interface ExtractArgs {
  publishDir: string;
  outDir: string;
  asrDir?: string;
}

function usage(): never {
  console.error('usage: packtool storyline extract <publishDir> --out <dir> [--asr-dir <dir>]');
  process.exit(2);
}

function parseArgs(argv: string[]): ExtractArgs {
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
      asrDir = argv[i + 1];
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

export function main(argv: string[]): number {
  const { publishDir, outDir, asrDir } = parseArgs(argv);
  try {
    extractPublishDir(publishDir, outDir, { asrDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`packtool storyline extract failed: ${message}`);
    return 1;
  }
  return 0;
}

// CLI entry point (dist/cli.js); tests import modules only.
if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.js')) {
  process.exit(main(process.argv.slice(2)));
}
