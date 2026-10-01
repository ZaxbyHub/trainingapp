// @vitest-environment node
/**
 * Player-origin hosting guardrail (trace browser-training-parity AC3/AC11,
 * Phase 4.2 predicate P4): EVERY server that hosts the web app must
 *   - serve /training-boot.html and /training-boot.js with
 *     Cross-Origin-Resource-Policy: cross-origin (the COEP require-corp app
 *     page embeds them cross-origin) and nosniff;
 *   - serve the course worker at /training/sw.js;
 *   - answer every other /training/* path 404 — never the SPA shell;
 *   - bind the IPv4 loopback explicitly (vite).
 * vite dev/preview are exercised through the real middleware; serve-offline.mjs
 * and start.ps1 (no test harness of their own) are pinned by source scan;
 * api_server.py is pinned behaviorally by tests/test_api_server_training_routes.py.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import viteConfig, { trainingRouteMiddleware } from '../../../../vite.config';

const WEB_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function run(url: string): { status: number; headers: Record<string, string>; nextCalled: boolean; body?: string } {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      this.body = body;
    },
    body: undefined as string | undefined,
  };
  let nextCalled = false;
  trainingRouteMiddleware({ url }, res, () => {
    nextCalled = true;
  });
  return { status: res.statusCode, headers, nextCalled, body: res.body };
}

describe('vite dev/preview player-origin routes', () => {
  it.each(['/training-boot.html', '/training-boot.js', '/training-boot.js?v=1'])('%s gets CORP cross-origin + COEP + nosniff', (url) => {
    const r = run(url);
    expect(r.nextCalled).toBe(true);
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves the course worker script', () => {
    const r = run('/training/sw.js');
    expect(r.nextCalled).toBe(true);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each(['/training', '/training/', '/training/pack/story.html', '/training/pack/assets/x.js', '/training/index.html'])('%s is 404, never the SPA shell', (url) => {
    const r = run(url);
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(404);
  });

  it.each(['/', '/index.html', '/assets/index.js', '/trainingfoo', '/models/x.onnx'])('%s is untouched', (url) => {
    const r = run(url);
    expect(r.nextCalled).toBe(true);
    expect(r.headers['cross-origin-resource-policy']).toBeUndefined();
  });

  it('binds dev and preview to the IPv4 loopback (both loopback names reach one listener; never 0.0.0.0)', () => {
    const config = (viteConfig as unknown as (env: { command: string; mode: string }) => { server: { host: string }; preview: { host: string } })({
      command: 'serve',
      mode: 'development',
    });
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.preview.host).toBe('127.0.0.1');
  });
});

describe('standalone servers (source scan)', () => {
  const offline = fs.readFileSync(path.join(WEB_ROOT, 'scripts', 'serve-offline.mjs'), 'utf8');
  const ps1 = fs.readFileSync(path.join(WEB_ROOT, 'scripts', 'start.ps1'), 'utf8');

  it('serve-offline.mjs: boot files cross-origin, worker served, other /training/* 404, loopback bind', () => {
    expect(offline).toContain("new Set(['/training-boot.html', '/training-boot.js'])");
    expect(offline).toContain("const TRAINING_SW_PATH = '/training/sw.js'");
    expect(offline).toMatch(/'Cross-Origin-Resource-Policy': 'cross-origin'/);
    expect(offline).toMatch(/rawPath\.startsWith\('\/training\/'\)\) && rawPath !== TRAINING_SW_PATH\)\s*\{\s*res\.writeHead\(404/);
    expect(offline).toMatch(/server\.listen\(PORT, '127\.0\.0\.1'/);
  });

  it('start.ps1: boot files cross-origin, worker served, other /training/* 404, loopback prefix', () => {
    expect(ps1).toContain("$IsTrainingBoot = ($RawPath -ceq '/training-boot.html' -or $RawPath -ceq '/training-boot.js')");
    expect(ps1).toContain("$IsTrainingWorker = ($RawPath -ceq '/training/sw.js')");
    expect(ps1).toMatch(/StartsWith\('\/training\/', \[StringComparison\]::Ordinal\)\) -and -not \$IsTrainingWorker\) \{\s*\$Response\.StatusCode = 404/);
    expect(ps1).toContain("$Response.Headers.Set('Cross-Origin-Resource-Policy', 'cross-origin')");
    expect(ps1).toContain('http://127.0.0.1:${Port}/');
  });

  it('the player-origin static files ship in public/ (copied into every build)', () => {
    for (const rel of ['training-boot.html', 'training-boot.js', path.join('training', 'sw.js')]) {
      expect(fs.existsSync(path.join(WEB_ROOT, 'public', rel)), rel).toBe(true);
    }
  });
});
