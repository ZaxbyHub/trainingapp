// @vitest-environment node
/**
 * Player-origin hosting guardrail (trace browser-training-parity AC3/AC11,
 * Phase 4.2 predicate P4; final-critic FC6): EVERY static server that hosts
 * the web app AND the course player must
 *   - deny framing by default: every response except /training-boot.html
 *     (app shell, assets, /training-boot.js, /training/sw.js, the /training/*
 *     404 and every error) carries frame-ancestors 'none' + X-Frame-Options
 *     DENY, so untrusted course JS can never frame a same-origin player
 *     document that runs under a weaker policy than its own;
 *   - serve /training-boot.html with the restrictive HEADER CSP bootPageCsp,
 *     whose frame-ancestors names only the app origin (the loopback alias of
 *     the request Host; any other Host fails closed to 'none');
 *   - serve /training-boot.html and /training-boot.js with
 *     Cross-Origin-Resource-Policy: cross-origin (the COEP require-corp app
 *     page embeds them cross-origin) and nosniff;
 *   - serve the course worker at /training/sw.js;
 *   - answer every other /training/* path 404 — never the SPA shell;
 *   - bind the IPv4 loopback explicitly (vite).
 * vite dev/preview are exercised through the real middleware; serve-offline.mjs
 * runs for real (a temp copy with its browser auto-open line removed, over a
 * temp dist); start.ps1 (Windows PowerShell only, no harness) is pinned by
 * source scan; the course worker's own refusals run sw.js in a vm.
 * api_server.py is deliberately NOT a player host (final-critic FC1: it
 * carries the unauthenticated API) — it answers the boot files, the worker and
 * every /training/* path 404, pinned behaviorally by
 * tests/test_api_server_training_routes.py.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import viteConfig, { bootPageCsp, bootPageFrameAncestor, bootPagePlayerOrigin, trainingRouteMiddleware } from '../../../../vite.config';

const WEB_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FRAME_DENY_CSP = "frame-ancestors 'none'";

function run(url: string, host = '127.0.0.1:4174'): { status: number; headers: Record<string, string>; nextCalled: boolean; body?: string } {
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
  trainingRouteMiddleware({ url, headers: { host } }, res, () => {
    nextCalled = true;
  });
  return { status: res.statusCode, headers, nextCalled, body: res.body };
}

describe('boot page CSP (final-critic FC6)', () => {
  it('confines the boot page: no fetch, no form, no subresource; scripts and workers pinned to its own script and the course worker', () => {
    const directives = new Map(
      bootPageCsp('127.0.0.1:4174')
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values.join(' ')]),
    );
    expect(Object.fromEntries(directives)).toEqual({
      'default-src': "'none'",
      // Exact URLs, not 'self': a worker course JS starts from the boot
      // window runs under its own script's policy, so 'self' would let it
      // run any same-origin script unconfined.
      'script-src': 'http://127.0.0.1:4174/training-boot.js',
      'worker-src': 'http://127.0.0.1:4174/training/sw.js',
      'connect-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'object-src': "'none'",
      'frame-ancestors': 'http://localhost:4174',
    });
  });

  it.each([
    ['127.0.0.1:4174', 'http://localhost:4174'],
    ['localhost:4174', 'http://127.0.0.1:4174'],
    ['LOCALHOST:8080', 'http://127.0.0.1:8080'],
    ['127.0.0.1', 'http://localhost'],
  ])('Host %s may only be framed by its app origin %s (never by the player origin itself)', (host, appOrigin) => {
    expect(bootPageFrameAncestor(host)).toBe(appOrigin);
    expect(bootPageCsp(host)).toContain(`frame-ancestors ${appOrigin}`);
    const player = `http://${host.toLowerCase()}`;
    expect(bootPagePlayerOrigin(host)).toBe(player);
    expect(bootPageCsp(host)).toContain(`script-src ${player}/training-boot.js;`);
    expect(bootPageCsp(host)).toContain(`worker-src ${player}/training/sw.js;`);
    expect(bootPageCsp(host)).not.toContain("'self'");
  });

  it.each([undefined, '', 'evil.example', 'evil.example:4174', 'localhost.evil.example:4174', '127.0.0.1:4174.evil', '127.0.0.1:4174 x', '[::1]:4174', '127.0.0.1:123456'])(
    'any other Host (%s) fails closed to frame-ancestors none; a Host is never reflected',
    (host) => {
      expect(bootPageFrameAncestor(host)).toBe("'none'");
      expect(bootPagePlayerOrigin(host)).toBeNull();
      expect(bootPageCsp(host)).toBe(
        "default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
      );
    },
  );
});

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

  it.each([
    '/',
    '/index.html',
    '/some/spa/route',
    '/assets/index.js',
    '/trainingfoo',
    '/training-boot.js',
    '/training-boot.js?v=1',
    '/training/sw.js',
    '/training',
    '/training/pack/story.html',
    '/Training-Boot.html',
    '/training-boot.html/',
    '/@fs/anything',
  ])('%s is never frameable (frame-ancestors none + X-Frame-Options DENY; FC6 deny by default)', (url) => {
    const r = run(url);
    expect(r.headers['content-security-policy']).toBe(FRAME_DENY_CSP);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it.each([
    ['/training-boot.html', '127.0.0.1:4174'],
    ['/training-boot.html?x=1', 'localhost:5173'],
    ['/training-boot.html', 'evil.example'],
  ])('%s (Host %s) carries the boot page header CSP and no X-Frame-Options (the app embeds it)', (url, host) => {
    const r = run(url, host);
    expect(r.nextCalled).toBe(true);
    expect(r.headers['content-security-policy']).toBe(bootPageCsp(host));
    expect(r.headers['x-frame-options']).toBeUndefined();
  });

  it('binds dev and preview to the IPv4 loopback (both loopback names reach one listener; never 0.0.0.0)', () => {
    const config = (viteConfig as unknown as (env: { command: string; mode: string }) => { server: { host: string }; preview: { host: string } })({
      command: 'serve',
      mode: 'development',
    });
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.preview.host).toBe('127.0.0.1');
  });

  it('vite preview proxies nothing: a player host serves only static files (final-critic FC1)', async () => {
    // preview.proxy inherits server.proxy (/api, /auth -> :8000) unless set;
    // the preview server also answers the player origin, where course JS can
    // reach every same-origin endpoint.
    const { resolveConfig } = await import('vite');
    const resolved = await resolveConfig(
      { configFile: path.join(WEB_ROOT, 'vite.config.ts'), logLevel: 'silent' },
      'serve',
      'production',
      'production',
      true,
    );
    expect(Object.keys(resolved.server.proxy ?? {})).toEqual(expect.arrayContaining(['/api', '/auth']));
    expect(resolved.preview.proxy ?? {}).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serve-offline.mjs, run for real (start.command / start.sh launch it).

const offlineSource = fs.readFileSync(path.join(WEB_ROOT, 'scripts', 'serve-offline.mjs'), 'utf8');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, urlPath: string, opts: { host?: string; method?: string; range?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.range !== undefined) headers.Range = opts.range;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: opts.method ?? 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serve-offline.mjs (real server over a temp dist)', () => {
  let child: ChildProcess | null = null;
  let tempDir = '';
  let port = 0;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-offline-fc6-'));
    const dist = path.join(tempDir, 'dist');
    fs.mkdirSync(path.join(dist, 'training'), { recursive: true });
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app shell</title>');
    fs.writeFileSync(path.join(dist, 'training-boot.html'), '<!doctype html><title>boot</title>');
    fs.writeFileSync(path.join(dist, 'training-boot.js'), '// boot');
    fs.writeFileSync(path.join(dist, 'training', 'sw.js'), '// worker');
    fs.writeFileSync(path.join(dist, 'assets', 'a.js'), '// asset');
    // The only edit: never launch a browser from a test.
    const opens = offlineSource.match(/exec\(openCmd\);/g) ?? [];
    expect(opens).toHaveLength(1);
    fs.writeFileSync(path.join(tempDir, 'serve-offline.mjs'), offlineSource.replace(/exec\(openCmd\);/, 'void openCmd;'));
    port = await freePort();
    child = spawn(process.execPath, [path.join(tempDir, 'serve-offline.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve-offline did not start')), 15_000);
      child?.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Press Ctrl+C')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child?.once('exit', (code) => reject(new Error(`serve-offline exited ${String(code)}`)));
    });
  }, 30_000);

  afterAll(() => {
    child?.kill();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  });

  it.each([
    ['127.0.0.1', 'localhost'],
    ['localhost', '127.0.0.1'],
  ])('the boot page requested on %s carries the header CSP framed only by http://%s:PORT (GET and HEAD)', async (playerHost, appHost) => {
    for (const method of ['GET', 'HEAD']) {
      const r = await request(port, '/training-boot.html', { host: `${playerHost}:${port}`, method });
      expect(r.status, method).toBe(200);
      expect(r.headers['content-type'], method).toMatch(/text\/html/);
      expect(r.headers['content-security-policy'], method).toBe(bootPageCsp(`${playerHost}:${port}`));
      expect(r.headers['content-security-policy'], method).toContain(`frame-ancestors http://${appHost}:${port}`);
      expect(r.headers['x-frame-options'], method).toBeUndefined();
      expect(r.headers['cross-origin-resource-policy'], method).toBe('cross-origin');
      expect(r.headers['cross-origin-embedder-policy'], method).toBe('require-corp');
    }
  });

  it('a foreign Host gets a boot page nobody can frame', async () => {
    const r = await request(port, '/training-boot.html', { host: 'evil.example' });
    expect(r.headers['content-security-policy']).toBe(bootPageCsp('evil.example'));
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it.each([
    ['/', 200],
    ['/index.html', 200],
    ['/some/spa/route', 200],
    ['/assets/a.js', 200],
    ['/training-boot.js', 200],
    ['/training/sw.js', 200],
    ['/training', 404],
    ['/training/', 404],
    ['/training/pack/story.html', 404],
    ['/..%2f..%2fsecret.txt', 403],
  ] as const)('%s (%i) is never frameable', async (urlPath, status) => {
    const r = await request(port, urlPath);
    expect(r.status).toBe(status);
    expect(r.headers['content-security-policy']).toBe(FRAME_DENY_CSP);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('an unsatisfiable Range (416) is never frameable either', async () => {
    const r = await request(port, '/assets/a.js', { range: 'bytes=999999-' });
    expect(r.status).toBe(416);
    expect(r.headers['content-security-policy']).toBe(FRAME_DENY_CSP);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the boot files cross-origin and binds the loopback (source)', () => {
    expect(offlineSource).toContain("const TRAINING_BOOT_PATHS = new Set([TRAINING_BOOT_PAGE_PATH, '/training-boot.js'])");
    expect(offlineSource).toContain("const TRAINING_SW_PATH = '/training/sw.js'");
    expect(offlineSource).toMatch(/rawPath\.startsWith\('\/training\/'\)\) && rawPath !== TRAINING_SW_PATH\)\s*\{\s*res\.writeHead\(404/);
    expect(offlineSource).toMatch(/server\.listen\(PORT, '127\.0\.0\.1'/);
    // Deny-by-default is the handler's first statement (before the try, so
    // even the catch-all 500 carries it).
    expect(offlineSource).toMatch(/createServer\(\(req, res\) => \{\s*for \(const \[name, value\] of Object\.entries\(FRAME_DENY_HEADERS\)\) res\.setHeader\(name, value\);\s*try \{/);
  });

  it('every named node: import exists (the script has no harness of its own)', async () => {
    const imports = [...offlineSource.matchAll(/^import \{([^}]+)\} from '(node:[a-z_]+)';\r?$/gm)];
    expect(imports.length).toBeGreaterThan(2);
    for (const [, names, specifier] of imports) {
      const mod = (await import(specifier)) as Record<string, unknown>;
      for (const name of names.split(',').map((n) => n.trim()).filter((n) => n.length > 0)) {
        expect(mod[name], `${specifier} exports ${name}`).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// start.ps1 (Windows PowerShell HttpListener; no harness): source scan only.

describe('start.ps1 (source scan)', () => {
  const ps1 = fs.readFileSync(path.join(WEB_ROOT, 'scripts', 'start.ps1'), 'utf8').replace(/\r\n/g, '\n');

  it('denies framing on every response, set right after the request is taken and before any branch', () => {
    expect(ps1).toMatch(
      /\$Response = \$Context\.Response\n\s*#[^\n]*\n\s*\$Response\.Headers\.Set\('Content-Security-Policy', "frame-ancestors 'none'"\)\n\s*\$Response\.Headers\.Set\('X-Frame-Options', 'DENY'\)\n\s*\n\s*try \{/,
    );
    // No later branch weakens it for anything but the boot page.
    expect(ps1.match(/Headers\.Remove\('X-Frame-Options'\)/g) ?? []).toHaveLength(1);
    expect(ps1).toMatch(/if \(\$RawPath -ceq '\/training-boot\.html'\) \{\s*\$Response\.Headers\.Remove\('X-Frame-Options'\)\s*\$Response\.Headers\.Set\('Content-Security-Policy', \(Get-BootPageCsp \$Request\.Headers\['Host'\]\)\)\s*\}/);
  });

  it('builds the same boot page CSP as vite (alias Host only, fail closed otherwise)', () => {
    const fn = /function Get-BootPageCsp\(\[string\]\$HostHeader\) \{([\s\S]*?)\n\}/.exec(ps1)?.[1] ?? '';
    for (const name of ['Script', 'Worker', 'Ancestor']) expect(fn).toContain(`$${name} = "'none'"`);
    expect(fn).toContain("if ($HostHeader -match '^(localhost|127\\.0\\.0\\.1)(:\\d{1,5})?$') {");
    expect(fn).toContain('$Name = $Matches[1].ToLowerInvariant()');
    expect(fn).toContain("$Alias = if ($Name -eq 'localhost') { '127.0.0.1' } else { 'localhost' }");
    expect(fn).toContain('$Script = "http://$Name$($Matches[2])/training-boot.js"');
    expect(fn).toContain('$Worker = "http://$Name$($Matches[2])/training/sw.js"');
    expect(fn).toContain('$Ancestor = "http://$Alias$($Matches[2])"');
    const literal = /return "([^"]+)"/.exec(fn)?.[1] ?? '';
    const fill = (values: Record<string, string>): string => Object.entries(values).reduce((acc, [k, v]) => acc.replace(k, v), literal);
    expect(
      fill({ $Script: 'http://127.0.0.1:4174/training-boot.js', $Worker: 'http://127.0.0.1:4174/training/sw.js', $Ancestor: 'http://localhost:4174' }),
    ).toBe(bootPageCsp('127.0.0.1:4174'));
    expect(fill({ $Script: "'none'", $Worker: "'none'", $Ancestor: "'none'" })).toBe(bootPageCsp('evil.example'));
  });

  it('boot files cross-origin, worker served, other /training/* 404, loopback prefix', () => {
    expect(ps1).toContain("$IsTrainingBoot = ($RawPath -ceq '/training-boot.html' -or $RawPath -ceq '/training-boot.js')");
    expect(ps1).toContain("$IsTrainingWorker = ($RawPath -ceq '/training/sw.js')");
    expect(ps1).toMatch(/StartsWith\('\/training\/', \[StringComparison\]::Ordinal\)\) -and -not \$IsTrainingWorker\) \{\s*\$Response\.StatusCode = 404/);
    // HEAD on a refused /training/* path stays a 404 (no body write, which
    // would throw and become a 500).
    expect(ps1).toMatch(/if \(\$Request\.HttpMethod -ne 'HEAD'\) \{\s*\$Response\.OutputStream\.Write\(\$Bytes, 0, \$Bytes\.Length\)\s*\}\s*\$Response\.Close\(\)\s*continue/);
    expect(ps1).toContain("$Response.Headers.Set('Cross-Origin-Resource-Policy', 'cross-origin')");
    expect(ps1).toContain('http://127.0.0.1:${Port}/');
  });
});

// ---------------------------------------------------------------------------
// The course worker's own answers (public/training/sw.js run in a vm).

describe('course worker refusals are never usable documents (FC6)', () => {
  const PLAYER = 'http://localhost:4174';
  type Listener = (event: unknown) => void;

  function loadWorker(): Record<string, Listener> {
    const listeners: Record<string, Listener> = {};
    const self = {
      location: new URL(`${PLAYER}/training/sw.js`),
      clients: { matchAll: () => Promise.resolve([]), claim: () => Promise.resolve() },
      skipWaiting: () => Promise.resolve(),
      addEventListener: (type: string, fn: Listener) => {
        listeners[type] = fn;
      },
    };
    const source = fs.readFileSync(path.join(WEB_ROOT, 'public', 'training', 'sw.js'), 'utf8');
    vm.runInNewContext(source, { self, URL, Response, Headers, ReadableStream, Map, Promise, setTimeout, clearTimeout, Uint8Array });
    return listeners;
  }

  function fetchEvent(listeners: Record<string, Listener>, url: string, method = 'GET'): Promise<Response> {
    return new Promise((resolve) => {
      listeners.fetch?.({ request: new Request(url, { method }), respondWith: (p: Promise<Response> | Response) => void Promise.resolve(p).then(resolve) });
    });
  }

  it.each([
    [`${PLAYER}/training/sw.js`, 'GET', 404],
    [`${PLAYER}/training/pack/story.html`, 'POST', 405],
  ])('%s (%s) answers %i under a deny-all CSP and refuses framing', async (url, method, status) => {
    const response = await fetchEvent(loadWorker(), url, method);
    expect(response.status).toBe(status);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('a relay answer that carries no CSP gets the deny-all policy; one that does keeps it', async () => {
    const listeners = loadWorker();
    const channel = new MessageChannel();
    const relayAnswers: Array<Record<string, string>> = [{ 'content-type': 'text/html' }, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" }];
    channel.port1.onmessage = (event: MessageEvent<{ type: string; id: number }>) => {
      if (event.data.type !== 'open') return;
      channel.port1.postMessage({ type: 'open-result', id: event.data.id, status: 200, headers: relayAnswers.shift(), body: 'x' });
    };
    listeners.message?.({ data: { type: 'trainingapp-relay-port' }, ports: [channel.port2] });
    const bare = await fetchEvent(listeners, `${PLAYER}/training/pack/a.html`);
    expect(bare.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(bare.headers.get('x-frame-options')).toBe('DENY');
    const kept = await fetchEvent(listeners, `${PLAYER}/training/pack/b.html`);
    expect(kept.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(kept.headers.get('x-frame-options')).toBeNull();
    channel.port1.close();
  });
});

describe('player-origin static files', () => {
  it('ship in public/ (copied into every build)', () => {
    for (const rel of ['training-boot.html', 'training-boot.js', path.join('training', 'sw.js')]) {
      expect(fs.existsSync(path.join(WEB_ROOT, 'public', rel)), rel).toBe(true);
    }
  });
});
