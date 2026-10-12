// t157 acceptance check (issue #157): AC3 — rag_context_truncation must stop
// being a dead setting. MECHANISM-AGNOSTIC: whichever way the fix lands (the
// desktop query path reading the key as an extra ceiling on grounded-context
// size, or the key being removed from the keyspace), the key must no longer
// be reported in the `not_applied` bin of GET /settings.
//
// Asserted through the SAME surface settings-wiring-honesty.test.ts uses:
// LlamaEngine.responseSettings() (the GET /settings body derived from
// SETTING_BOUNDS minus the read-key sets). No assertion is made about WHICH
// mechanism un-deadens the key.
//
// Import discipline: nothing imports node-llama-cpp; the engine runs on an
// injected llamaFactory RecordingBackend (CI-safe, no weights).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine';

const GB = 1024 ** 3;

class RecordingBackend implements LlamaEngineBackend {
  async generate(): Promise<{ answer: string; cancelled: boolean }> {
    return { answer: 't157 answer', cancelled: false };
  }

  async dispose(): Promise<void> {}
}

/** Quality-profile engine on the recording backend (fresh settings state). */
function makeEngine(): LlamaEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't157-settings-'));
  const quality = path.join(dir, 'q.gguf');
  const fast = path.join(dir, 'f.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return new LlamaEngine({
    profile: 'quality',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality, fast },
    llamaFactory: async () => new RecordingBackend(),
  });
}

describe('C3 rag_context_truncation is no longer reported not_applied', () => {
  it('the not_applied bin of GET /settings excludes rag_context_truncation', () => {
    const engine = makeEngine();
    const settings = engine.responseSettings();
    const notApplied = settings.not_applied;
    expect(Array.isArray(notApplied)).toBe(true);
    expect(
      notApplied as string[],
      'rag_context_truncation is still dead: reported in the not_applied bin of GET /settings',
    ).not.toContain('rag_context_truncation');
  });
});
