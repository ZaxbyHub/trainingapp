// Model directory resolution for the node-backend spike slice.
// Precedence (mirrors the production pattern, no runtime link to desktop/):
//   1. TRAININGAPP_SPIKE_MODELS env var
//   2. <userData>/models
//   3. ~/.trainingapp/models
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ModelPaths {
  modelsDir: string;
  qualityGguf: string;
  embeddingDir: string;
}

export function resolveModelsDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.TRAININGAPP_SPIKE_MODELS,
    appUserDataModels(),
    path.join(os.homedir(), '.trainingapp', 'models'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'gemma-4-e2b-it', 'model.gguf'))) {
      return candidate;
    }
  }
  // Fall through: return the first candidate so the error message names it.
  return candidates[candidates.length - 1] ?? path.join(os.homedir(), '.trainingapp', 'models');
}

function appUserDataModels(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    const p = app?.getPath?.('userData');
    return p ? path.join(p, 'models') : undefined;
  } catch {
    return undefined;
  }
}

export function resolveModelPaths(modelsDir: string): ModelPaths {
  return {
    modelsDir,
    qualityGguf: path.join(modelsDir, 'gemma-4-e2b-it', 'model.gguf'),
    embeddingDir: path.join(modelsDir, 'bge-small-en-v1.5'),
  };
}
