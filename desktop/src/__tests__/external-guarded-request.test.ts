// universal-provider-settings-overhaul (AC7/AC14): adversarial tests for the
// desktop outbound client and the safeStorage secret store.
//   - redirects are refused and the redirect target receives nothing (the key
//     is never replayed);
//   - connect-time validation: metadata / link-local / unspecified / mapped
//     answers and name-class-inconsistent answers are refused with ZERO
//     requests; the validated address is what the socket connects to, while
//     the Host header keeps the original name;
//   - first-byte and idle timeouts classify as 'timeout';
//   - cancellation aborts the request;
//   - upstream error bodies are scrubbed of the key;
//   - the secret store persists only ciphertext.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  guardedRequest,
  pinnedLookupFor,
  RequestCancelledError,
  resolveTarget,
  trustedCertificateAuthorities,
  type DnsLookup,
} from '../../main/backend/net/guarded-request';
import { ExternalProviderError, scrubSecrets } from '../../main/backend/net/provider-error';
import { createMemorySecretStore, createSafeStorageSecretStore } from '../../main/security/secret-store';

interface Hit {
  url: string;
  headers: http.IncomingHttpHeaders;
}

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop() as http.Server;
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push({ url: req.url ?? '', headers: req.headers });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return { port: (s.address() as AddressInfo).port, hits };
}

const KEY = 'sk-guarded-SENTINEL-7777';
const ctx = (origin: string) => ({ origin, model: 'm', apiKey: KEY });

async function failureOf(p: Promise<unknown>): Promise<ExternalProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ExternalProviderError);
    return err as ExternalProviderError;
  }
  throw new Error('expected a failure');
}

describe('guarded outbound client', () => {
  it('connects to the validated address while keeping the original Host header', async () => {
    const target = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const asked: string[] = [];
    const lookup: DnsLookup = async (host) => {
      asked.push(host);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const res = await guardedRequest({
      url: `http://gpu-box.lan:${target.port}/v1/models`,
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
      ctx: ctx(`http://gpu-box.lan:${target.port}`),
      airgap: false,
      lookup,
    });
    expect(await res.text()).toBe('ok');
    expect(asked).toEqual(['gpu-box.lan']);
    expect(target.hits[0]?.headers.host).toBe(`gpu-box.lan:${target.port}`);
  });

  it('refuses a 3xx and never contacts the redirect target', async () => {
    const stolen = await server((_req, res) => {
      res.writeHead(200);
      res.end('stolen');
    });
    const first = await server((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${stolen.port}/steal` });
      res.end();
    });
    const err = await failureOf(
      guardedRequest({
        url: `http://127.0.0.1:${first.port}/v1/chat/completions`,
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}` },
        body: '{}',
        ctx: ctx(`http://127.0.0.1:${first.port}`),
        airgap: false,
      }),
    );
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/redirect/);
    expect(first.hits).toHaveLength(1);
    expect(stolen.hits).toHaveLength(0);
    expect(err.message).not.toContain(KEY);
  });

  const BAD: Array<[string, Array<{ address: string; family: 4 | 6 }>]> = [
    ['metadata', [{ address: '169.254.169.254', family: 4 }]],
    ['loopback + metadata', [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }]],
    ['link-local v6', [{ address: 'fe80::1', family: 6 }]],
    ['AWS v6 metadata', [{ address: 'fd00:ec2::254', family: 6 }]],
    ['mapped metadata (dotted)', [{ address: '::ffff:169.254.169.254', family: 6 }]],
    ['mapped metadata (hex)', [{ address: '::ffff:a9fe:a9fe', family: 6 }]],
    ['NAT64 metadata', [{ address: '64:ff9b::a9fe:a9fe', family: 6 }]],
    ['6to4 metadata', [{ address: '2002:a9fe:a9fe::1', family: 6 }]],
    ['unspecified v4', [{ address: '0.0.0.0', family: 4 }]],
    ['unspecified v6', [{ address: '::', family: 6 }]],
    ['private name resolving to a public address', [{ address: '8.8.8.8', family: 4 }]],
  ];
  for (const [label, answer] of BAD) {
    it(`refuses before connecting: ${label}`, async () => {
      const target = await server((_req, res) => {
        res.writeHead(200);
        res.end('reached');
      });
      const err = await failureOf(
        guardedRequest({
          url: `http://gpu-box.lan:${target.port}/v1/models`,
          method: 'GET',
          headers: {},
          ctx: ctx('http://gpu-box.lan'),
          airgap: false,
          lookup: async () => answer,
        }),
      );
      expect(err.kind).toBe('network');
      expect(target.hits).toHaveLength(0);
    });
  }

  // Review round 1 (F1): every BAD row above uses a PRIVATE-class name, so the
  // name-class consistency rule refuses it before the per-answer address rule
  // is ever the deciding guard. For a PUBLIC name the class rule accepts any
  // allowed answer, so the per-answer refusal is the ONLY guard against a
  // cloud endpoint name resolving to metadata / link-local / unspecified /
  // multicast. These rows isolate that guard: each must be refused BY the
  // address rule (message names the answer and its rule), not by a later
  // connect failure.
  const PUBLIC_BAD: Array<[string, Array<{ address: string; family: 4 | 6 }>, RegExp]> = [
    ['metadata', [{ address: '169.254.169.254', family: 4 }], /\(metadata\)/],
    ['link-local v4', [{ address: '169.254.10.20', family: 4 }], /\(link-local\)/],
    ['link-local v6', [{ address: 'fe80::1', family: 6 }], /\(link-local\)/],
    ['AWS v6 metadata', [{ address: 'fd00:ec2::254', family: 6 }], /\(metadata\)/],
    ['IPv4-mapped metadata (dotted)', [{ address: '::ffff:169.254.169.254', family: 6 }], /\(metadata\)/],
    ['IPv4-mapped metadata (hex)', [{ address: '::ffff:a9fe:a9fe', family: 6 }], /\(metadata\)/],
    ['NAT64 metadata', [{ address: '64:ff9b::a9fe:a9fe', family: 6 }], /\(metadata\)/],
    ['6to4 metadata', [{ address: '2002:a9fe:a9fe::1', family: 6 }], /\(metadata\)/],
    ['unspecified v4', [{ address: '0.0.0.0', family: 4 }], /\(invalid-url\)/],
    ['unspecified v6', [{ address: '::', family: 6 }], /\(invalid-url\)/],
    ['multicast v4', [{ address: '224.0.0.1', family: 4 }], /\(invalid-url\)/],
    ['multicast v6', [{ address: 'ff02::1', family: 6 }], /\(invalid-url\)/],
    [
      'public answer followed by metadata (every answer is checked, not just the first)',
      [
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
      /\(metadata\)/,
    ],
  ];
  for (const [label, answer, rule] of PUBLIC_BAD) {
    it(`public name: resolveTarget refuses ${label}`, async () => {
      let calls = 0;
      const lookup: DnsLookup = async () => {
        calls += 1;
        return answer;
      };
      const err = await failureOf(resolveTarget('api.example.com', lookup, ctx('https://api.example.com'), false));
      expect(err.kind).toBe('network');
      expect(err.message).toMatch(/^Refused to contact https:\/\/api\.example\.com: api\.example\.com resolves to /);
      expect(err.message).toMatch(rule);
      expect(calls).toBe(1);
    });

    it(`public name: guardedRequest refuses ${label} before connecting`, async () => {
      const target = await server((_req, res) => {
        res.writeHead(200);
        res.end('reached');
      });
      const err = await failureOf(
        guardedRequest({
          url: `https://api.example.com:${target.port}/v1/models`,
          method: 'GET',
          headers: { authorization: `Bearer ${KEY}` },
          ctx: ctx('https://api.example.com'),
          airgap: false,
          lookup: async () => answer,
          // A mutated (unguarded) client would try to connect; fail fast then.
          firstByteTimeoutMs: 1_000,
        }),
      );
      expect(err.kind).toBe('network');
      expect(err.message).toMatch(/Refused to contact .* resolves to /);
      expect(err.message).toMatch(rule);
      expect(err.message).not.toContain(KEY);
      expect(target.hits).toHaveLength(0);
    });
  }

  it('a public name may resolve to a public answer (the per-answer rule is not over-broad)', async () => {
    await expect(
      resolveTarget('api.example.com', async () => [{ address: '8.8.8.8', family: 4 }], ctx('https://api.example.com'), false),
    ).resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });

  // Review round 1 (F5): the pinned lookup must hand back ONLY the validated
  // address in every callback shape net/tls use; Node normally calls the
  // {all:true} shape, so the single-address shapes are pinned directly here.
  describe('pinned lookup (every callback shape)', () => {
    const target4 = { address: '10.1.2.3', family: 4 as const };
    const target6 = { address: 'fd12::7', family: 6 as const };
    const call = (fn: ReturnType<typeof pinnedLookupFor>, ...args: unknown[]): unknown[] => {
      let got: unknown[] = [];
      (fn as unknown as (...a: unknown[]) => void)(...args, (...cbArgs: unknown[]) => {
        got = cbArgs;
      });
      return got;
    };
    it('(host, {all:true}, cb) yields exactly the validated address list', () => {
      expect(call(pinnedLookupFor(target4), 'gpu-box.lan', { all: true })).toEqual([null, [{ address: '10.1.2.3', family: 4 }]]);
    });
    it('(host, {family}, cb) yields the validated address and family (single-address shape)', () => {
      expect(call(pinnedLookupFor(target4), 'gpu-box.lan', { family: 0 })).toEqual([null, '10.1.2.3', 4]);
      expect(call(pinnedLookupFor(target6), 'gpu-box.lan', { all: false })).toEqual([null, 'fd12::7', 6]);
    });
    it('(host, cb) yields the validated address and family (no options)', () => {
      let got: unknown[] = [];
      (pinnedLookupFor(target6) as unknown as (h: string, cb: (...a: unknown[]) => void) => void)('gpu-box.lan', (...a) => {
        got = a;
      });
      expect(got).toEqual([null, 'fd12::7', 6]);
    });
  });

  it('a loopback name must resolve to loopback only', async () => {
    await expect(resolveTarget('localhost', async () => [{ address: '192.168.1.5', family: 4 }], ctx('x'), false)).rejects.toThrow(
      /loopback name/,
    );
    await expect(resolveTarget('localhost', async () => [{ address: '::1', family: 6 }], ctx('x'), false)).resolves.toEqual({
      address: '::1',
      family: 6,
    });
  });

  it('numeric host literals are classified without DNS (no lookup call)', async () => {
    let called = 0;
    const lookup: DnsLookup = async () => {
      called += 1;
      return [];
    };
    await expect(resolveTarget('127.0.0.1', lookup, ctx('x'), false)).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(resolveTarget('169.254.169.254', lookup, ctx('x'), false)).rejects.toThrow(/metadata/);
    expect(called).toBe(0);
  });

  it('the URL policy (and airgap) runs before any DNS query', async () => {
    let called = 0;
    const lookup: DnsLookup = async () => {
      called += 1;
      return [{ address: '1.2.3.4', family: 4 }];
    };
    const err = await failureOf(
      guardedRequest({ url: 'https://api.openai.com/v1/models', method: 'GET', headers: {}, ctx: ctx('https://api.openai.com'), airgap: true, lookup }),
    );
    expect(err.message).toMatch(/airgap-public/);
    expect(called).toBe(0);
  });

  it('a server that never answers fails with a first-byte timeout', async () => {
    const hang = await server(() => {
      /* never respond */
    });
    const started = Date.now();
    const err = await failureOf(
      guardedRequest({
        url: `http://127.0.0.1:${hang.port}/v1/models`,
        method: 'GET',
        headers: {},
        ctx: ctx('http://127.0.0.1'),
        airgap: false,
        firstByteTimeoutMs: 200,
      }),
    );
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a stream that goes silent mid-body fails with an idle timeout', async () => {
    const stall = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      // then silence
    });
    const res = await guardedRequest({
      url: `http://127.0.0.1:${stall.port}/v1/chat/completions`,
      method: 'POST',
      headers: {},
      body: '{}',
      ctx: ctx('http://127.0.0.1'),
      airgap: false,
      firstByteTimeoutMs: 2_000,
      idleTimeoutMs: 200,
    });
    const err = await failureOf((async () => {
      for await (const chunk of res.chunks()) void chunk;
    })());
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/silent/);
  });

  it('cancellation before headers rejects with RequestCancelledError and closes the socket', async () => {
    let closed = false;
    const hang = await server((req) => {
      req.socket.on('close', () => {
        closed = true;
      });
    });
    let cancel = false;
    setTimeout(() => {
      cancel = true;
    }, 100);
    await expect(
      guardedRequest({
        url: `http://127.0.0.1:${hang.port}/x`,
        method: 'GET',
        headers: {},
        ctx: ctx('http://127.0.0.1'),
        airgap: false,
        isCancelled: () => cancel,
      }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
  });

  it('upstream error bodies that echo the key are scrubbed', async () => {
    const echo = await server((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${String(req.headers.authorization)}` } }));
    });
    const err = await failureOf(
      guardedRequest({
        url: `http://127.0.0.1:${echo.port}/v1/models`,
        method: 'GET',
        headers: { authorization: `Bearer ${KEY}` },
        ctx: ctx('http://127.0.0.1'),
        airgap: false,
      }),
    );
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(KEY.slice(0, 8));
    expect(scrubSecrets(`x sk-abcdef123 ${KEY}`, KEY)).not.toMatch(/sk-abcdef123|SENTINEL/);
  });

  it('trusts Node defaults plus the OS certificate store', () => {
    const cas = trustedCertificateAuthorities();
    expect(Array.isArray(cas)).toBe(true);
    expect((cas as string[]).length).toBeGreaterThan(0);
  });
});

describe('safeStorage secret store', () => {
  const fakeSafe = (available = true) => ({
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.concat([Buffer.from('ENC:'), Buffer.from(plain, 'utf8').reverse()]),
    decryptString: (cipher: Buffer) => {
      if (cipher.subarray(0, 4).toString() !== 'ENC:') throw new Error('bad');
      return Buffer.from(cipher.subarray(4)).reverse().toString('utf8');
    },
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-secret-'));
    dirs.push(d);
    return d;
  };

  it('stores only ciphertext and reads it back from a fresh store', () => {
    const dir = tmp();
    const file = path.join(dir, 'secrets.bin');
    const a = createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: file });
    a.set('external-api-key', KEY);
    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from(KEY))).toBe(false);
    expect(raw.includes(Buffer.from(Buffer.from(KEY).toString('base64')))).toBe(false);
    expect(createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: file }).get('external-api-key')).toBe(KEY);
  });

  it('refuses (throws, writes nothing) when encryption is unavailable', () => {
    const dir = tmp();
    const file = path.join(dir, 'secrets.bin');
    const store = createSafeStorageSecretStore({ safeStorage: fakeSafe(false), filePath: file });
    expect(() => store.set('k', KEY)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('an undecryptable entry reads as null', () => {
    const dir = tmp();
    const file = path.join(dir, 'secrets.bin');
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: { k: Buffer.from('not-ciphertext').toString('base64') } }));
    expect(createSafeStorageSecretStore({ safeStorage: fakeSafe(), filePath: file }).get('k')).toBeNull();
  });

  it('the memory store never touches disk', () => {
    const store = createMemorySecretStore();
    store.set('a', 'b');
    expect(store.get('a')).toBe('b');
    store.delete('a');
    expect(store.get('a')).toBeNull();
  });
});
