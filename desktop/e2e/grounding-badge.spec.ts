// grounding-badge.spec.ts — C5 (issue #72) AC1/AC4 in-app visual evidence.
//
// Drives the REAL built renderer in server-API mode against the
// deterministic-stub Python backend (eval/ci_serve.py: hashing embedder +
// scripted LLM over eval/corpus, no model weights needed). The backend serves
// the built renderer bundle ITSELF (api_server mounts web_ui/dist), so the
// app runs same-origin (empty serverUrl -> relative /ask/stream) — the only
// server-mode topology the frozen API contract supports cross-process
// (allow_credentials=False rules out remote-origin browser clients). The
// config's vite-preview webServer is unused by this spec.
//
// Flow note: the FIRST question of a brand-new conversation loses the
// terminal done-payload fields on the client (pre-existing ChatPage
// first-turn state bug, tracked as issue #118 — it drops sources/citations/
// learn identically on master). The spec therefore bootstraps the
// conversation with a throwaway ask, then asserts badge delivery on the
// steady-state path, which is the path #72 owns.
//
// Fixture gating (mirrors the c4/d6 vitest convention): skipped when the
// python venv or the built renderer bundle is absent.
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

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

const REPO_ROOT = findRepoRoot(THIS_DIR);
const PYTHON = process.env.TRAININGAPP_PYTHON ?? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
const PYTHON_READY = fs.existsSync(PYTHON);
const RENDERER_BUILT = fs.existsSync(path.join(REPO_ROOT, 'web_ui', 'dist', 'index.html'));

const CORPUS_QUESTION = 'What is the monthly deadline for submitting expense reports?';
const OUT_OF_CORPUS_QUESTION = 'What is the capital of Meridia?';
const SCREENSHOT_DIR = path.join(THIS_DIR, '..', 'test-results', 'c5-grounding');

let backend: ChildProcess | null = null;
let backendPort = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // backend not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`ci_serve backend not healthy within ${timeoutMs}ms at ${url}`);
}

async function ask(page: import('@playwright/test').Page, question: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  await input.fill(question);
  await input.press('Enter');
  // Wait for the turn to finish: the streaming flag flips and the next
  // composer interaction becomes possible (input re-enabled + emptied).
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await expect(input).toHaveValue('', { timeout: 30_000 });
}

test.beforeAll(async () => {
  if (!PYTHON_READY || !RENDERER_BUILT) return;
  backendPort = await freePort();
  backend = spawn(
    PYTHON,
    [path.join(REPO_ROOT, 'eval', 'ci_serve.py'), '--port', String(backendPort), '--label', 'c5-e2e'],
    { cwd: REPO_ROOT, stdio: 'ignore' },
  );
  await waitForHealth(`http://127.0.0.1:${backendPort}/health`);
});

test.afterAll(async () => {
  if (backend !== null) {
    backend.kill();
  }
});

test.describe('C5 grounding badge in the real chat UI (issue #72)', () => {
  test.skip(!PYTHON_READY, 'python venv missing (TRAININGAPP_PYTHON or .venv) — fixture unavailable');
  test.skip(!RENDERER_BUILT, 'web_ui/dist not built (run: npm --prefix web_ui run build) — fixture unavailable');

  test('answers render the grounded / general provenance badges in-app', async ({ page }) => {
    // Seed server-API mode (same-origin, relative /ask/stream) BEFORE app load.
    await page.addInitScript(() => {
      localStorage.setItem(
        'inference-mode',
        JSON.stringify({ mode: 'api', serverUrl: '', browserEngine: 'wllama', ragPreset: 'balanced' }),
      );
    });
    await page.goto(`http://127.0.0.1:${backendPort}/`);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // Conversation bootstrap (issue #118 first-turn state bug): the first
    // ask creates the conversation; its terminal payload fields are dropped
    // client-side pre-#118-fix, so badge assertions start from the second ask.
    await ask(page, CORPUS_QUESTION);
    await ask(page, CORPUS_QUESTION);

    const groundedBadge = page.getByText('Grounded in your documents').first();
    await expect(groundedBadge).toBeVisible();
    await groundedBadge.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'grounded-badge-in-app.png'),
      fullPage: true,
    });

    await ask(page, OUT_OF_CORPUS_QUESTION);
    const generalBadge = page.getByText('General knowledge').first();
    await expect(generalBadge).toBeVisible();
    await generalBadge.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'general-badge-in-app.png'),
      fullPage: true,
    });
  });
});
