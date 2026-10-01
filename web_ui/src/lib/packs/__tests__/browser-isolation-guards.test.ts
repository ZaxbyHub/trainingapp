/**
 * Browser training isolation and egress guards (trace browser-training-parity
 * AC3/AC5/AC8/AC11). Each `it` isolates ONE guard so a mutation of that guard
 * turns exactly that row red (mutation proofs in 08-test-results.md):
 *
 *   PO*  validatePlayerOrigin: the player origin is a bare origin, https unless
 *        loopback, and never the app origin (no same-origin fallback).
 *   BR*  renderer bridge: exact target origin, replies accepted only on the
 *        one-shot port, nothing posted when the frame origin is unknown.
 *   UP*  update channel: zero network before opt-in, air-gapped builds refuse
 *        the opt-in, https-only request and final URL, byte caps.
 *   WC*  source guardrail: no first-party postMessage uses the '*' target, and
 *        every first-party window 'message' listener checks event.origin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrainingPlayerBridge } from '../../../components/training-player-bridge';
import { browserTrainingUrl, loopbackAliasOrigin, validatePlayerOrigin } from '../player-origin';
import { AIRGAP_UPDATES_DETAIL, BrowserUpdatesController, type BrowserUpdatesDeps } from '../pack-update-controller';
import { downloadArtifactBytes, fetchFeedText } from '../pack-update-browser';
import { PACK_UPDATES_STATE_KEY } from '../../storage/persisted-keys';

const APP = 'http://localhost:4183';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('player origin validation (AC11)', () => {
  it('PO1 accepts a bare https origin and normalizes it', () => {
    expect(validatePlayerOrigin('https://player.example.com', APP)).toBe('https://player.example.com');
    expect(validatePlayerOrigin('https://player.example.com/', APP)).toBe('https://player.example.com');
  });

  it('PO2 refuses the app origin itself (no same-origin fallback)', () => {
    expect(validatePlayerOrigin(APP, APP)).toBeNull();
    expect(validatePlayerOrigin(`${APP}/`, APP)).toBeNull();
  });

  it('PO3 refuses plain http for a non-loopback host', () => {
    expect(validatePlayerOrigin('http://player.example.com', APP)).toBeNull();
    expect(validatePlayerOrigin('http://127.0.0.1:4183', APP)).toBe('http://127.0.0.1:4183');
  });

  it('PO4 refuses paths, queries, fragments and credentials', () => {
    for (const bad of [
      'https://player.example.com/sub',
      'https://player.example.com/?x=1',
      'https://player.example.com/#a',
      'https://user:pw@player.example.com',
    ]) {
      expect(validatePlayerOrigin(bad, APP), bad).toBeNull();
    }
  });

  it('PO5 refuses non-http(s) schemes and junk', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///c:/x', 'app://training', '', '   ', 42, null, undefined]) {
      expect(validatePlayerOrigin(bad, APP), String(bad)).toBeNull();
    }
  });

  it('PO6 the loopback alias swaps localhost and 127.0.0.1 and keeps scheme and port; other hosts have none', () => {
    expect(loopbackAliasOrigin('http://localhost:4183')).toBe('http://127.0.0.1:4183');
    expect(loopbackAliasOrigin('http://127.0.0.1:4183')).toBe('http://localhost:4183');
    expect(loopbackAliasOrigin('https://app.example.com')).toBeNull();
  });

  it('PO7 the course URL encodes the pack id into a single path segment', () => {
    expect(browserTrainingUrl('http://127.0.0.1:4183', '../x')).toBe('http://127.0.0.1:4183/training/..%2Fx/story.html');
  });
});

describe('renderer bridge origin discipline (AC5)', () => {
  function frameAt(src: string): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    // Set the attribute only after attaching: jsdom does not navigate to it
    // for a cross-origin URL, which is all the bridge reads.
    frame.setAttribute('src', src);
    return frame;
  }

  it('BR1 posts to the exact player origin with a transferred port, never the wildcard', async () => {
    const frame = frameAt('http://127.0.0.1:4183/training/p/story.html');
    const spy = vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const bridge = createTrainingPlayerBridge(frame);
    void bridge.readState();
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0] as unknown as [unknown, string, MessagePort[]];
    expect(call[1]).toBe('http://127.0.0.1:4183');
    expect(call[2]).toHaveLength(1);
    bridge.destroy?.();
  });

  it('BR2 a forged window message (any origin) never resolves a pending request', async () => {
    const frame = frameAt('http://127.0.0.1:4183/training/p/story.html');
    vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const bridge = createTrainingPlayerBridge(frame);
    let settled = false;
    const pending = bridge.readState().then((v) => {
      settled = true;
      return v;
    });
    for (const origin of ['http://127.0.0.1:4183', 'http://evil.example', APP]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          data: { __trainingapp: true, kind: 'state-result', reqId: 1, state: { slideId: 'forged', slideTitle: 'x' } },
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    bridge.destroy?.();
    await expect(pending).resolves.toBeNull();
  });

  it('BR3 the reply on the transferred port resolves the request', async () => {
    const frame = frameAt('http://127.0.0.1:4183/training/p/story.html');
    vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation(((message: { reqId: number }, _o: string, transfer: MessagePort[]) => {
      transfer[0]!.postMessage({ __trainingapp: true, kind: 'state-result', reqId: message.reqId, state: { slideId: 's1', slideTitle: 'T' } });
    }) as unknown as Window['postMessage']);
    const bridge = createTrainingPlayerBridge(frame);
    await expect(bridge.readState()).resolves.toEqual({ slideId: 's1', slideTitle: 'T' });
  });

  it('BR4 posts nothing when the frame origin is unknown', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const spy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const bridge = createTrainingPlayerBridge(frame);
    await expect(bridge.readState()).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('update channel egress (AC8)', () => {
  function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
    const map = new Map(Object.entries(initial));
    return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  }

  function controller(overrides: Partial<BrowserUpdatesDeps> = {}): { c: BrowserUpdatesController; fetchFeed: ReturnType<typeof vi.fn> } {
    const fetchFeed = vi.fn(async (_url: string) => JSON.stringify({ schema_version: 1, packs: [] }));
    const storage = memoryStorage();
    const c = new BrowserUpdatesController({
      manager: () => ({ listPacks: async () => [], installPack: async () => { throw new Error('unused'); } }) as never,
      fetchFeed,
      downloadArtifact: async () => new Uint8Array(),
      trustedKeys: () => [],
      storage: () => storage,
      airgap: false,
      now: () => new Date('2026-10-01T00:00:00Z'),
      ...overrides,
    });
    return { c, fetchFeed };
  }

  it('UP1 nothing is fetched until the user opts in', async () => {
    const { c, fetchFeed } = controller();
    const result = await c.checkForUpdates();
    expect(result.ok).toBe(false);
    expect(fetchFeed).not.toHaveBeenCalled();
  });

  it('UP2 opting in runs one check against the feed', async () => {
    const { c, fetchFeed } = controller();
    await c.setUpdateOptIn(true);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it('UP3 the air-gapped build refuses the opt-in and never fetches, even with a stored opt-in', async () => {
    const storage = memoryStorage({ [PACK_UPDATES_STATE_KEY]: JSON.stringify({ optIn: true }) });
    const { c, fetchFeed } = controller({ airgap: true, storage: () => storage });
    expect((await c.getUpdateStatus()).optIn).toBe(false);
    const result = await c.setUpdateOptIn(true);
    expect(result).toMatchObject({ ok: false, detail: AIRGAP_UPDATES_DETAIL });
    await c.checkForUpdates();
    expect(fetchFeed).not.toHaveBeenCalled();
  });

  it('UP4 a non-https feed URL is refused before any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchFeedText('http://feed.example/pack-feed.json')).rejects.toThrow(/non-https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('UP5 a response whose FINAL URL is not https is refused', async () => {
    const response = new Response('{}', { status: 200 });
    Object.defineProperty(response, 'url', { value: 'http://downgraded.example/pack-feed.json' });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(fetchFeedText('https://feed.example/pack-feed.json')).rejects.toThrow(/non-https URL/);
  });

  it('UP6 requests omit credentials and the referrer and never cache', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchFeedText('https://feed.example/pack-feed.json');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  });

  it('UP7 a declared content-length over the cap is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) } })));
    await expect(fetchFeedText('https://feed.example/pack-feed.json')).rejects.toThrow(/cap/);
  });

  it('UP8 a streamed body over the artifact cap is refused (no content-length)', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(downloadArtifactBytes('https://feed.example/p.zip', 100)).rejects.toThrow(/cap/);
  });

  it('UP9 an artifact shorter than the feed-declared size is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10), { status: 200 })));
    await expect(downloadArtifactBytes('https://feed.example/p.zip', 11)).rejects.toThrow(/size mismatch/);
  });
});

describe('first-party postMessage source guardrail (AC5)', () => {
  const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const ROOTS = ['web_ui/src', 'web_ui/public', 'desktop/main', 'desktop/e2e/fixtures/storyline-nav/story_content', 'packtool/src'];
  const SKIP_DIR = new Set(['node_modules', '__tests__', 'dist', 'html5']);

  function sources(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIR.has(entry.name)) walk(full);
        } else if (/\.(ts|tsx|js|mjs|html)$/.test(entry.name) && !/\.(test|spec)\.|\.min\.js$/.test(entry.name)) {
          out.push(full);
        }
      }
    };
    for (const root of ROOTS) walk(path.join(REPO, root));
    return out;
  }

  /** Top-level arguments of every `postMessage(` call in `text` (comments stripped). */
  function postMessageArgs(text: string): string[][] {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
    const calls: string[][] = [];
    const re = /postMessage\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      let current = '';
      const args: string[] = [];
      let quote: string | null = null;
      for (; i < code.length && depth > 0; i += 1) {
        const ch = code[i]!;
        if (quote !== null) {
          current += ch;
          if (ch === '\\') {
            current += code[i + 1] ?? '';
            i += 1;
          } else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          current += ch;
        } else if ('([{'.includes(ch)) {
          depth += 1;
          current += ch;
        } else if (')]}'.includes(ch)) {
          depth -= 1;
          if (depth > 0) current += ch;
        } else if (ch === ',' && depth === 1) {
          args.push(current.trim());
          current = '';
        } else current += ch;
      }
      if (current.trim() !== '') args.push(current.trim());
      calls.push(args);
    }
    return calls;
  }

  it('WC0 the scanner sees the known first-party senders (non-vacuous)', () => {
    const files = sources().map((f) => path.relative(REPO, f).replace(/\\/g, '/'));
    for (const expected of [
      'web_ui/src/components/training-player-bridge.ts',
      'web_ui/src/lib/packs/training-player-host.ts',
      'web_ui/public/training-boot.js',
      'web_ui/public/training/sw.js',
      'desktop/e2e/fixtures/storyline-nav/story_content/trainingapp-bridge.js',
    ]) {
      expect(files, expected).toContain(expected);
    }
    expect(postMessageArgs("w.postMessage({a: 1}, '*', [p])")[0]).toEqual(['{a: 1}', "'*'", '[p]']);
  });

  it("WC1 no first-party postMessage targets the '*' wildcard origin", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      for (const args of postMessageArgs(fs.readFileSync(file, 'utf8'))) {
        if (args.some((a) => /^(['"`])\*\1$/.test(a))) offenders.push(`${path.relative(REPO, file)}: postMessage(${args.join(', ')})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('WC2 every first-party window message listener checks event.origin', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/window\.addEventListener\(\s*['"]message['"]/.test(text)) continue;
      if (!/\.origin\s*!==|\.origin\s*===/.test(text)) offenders.push(path.relative(REPO, file));
    }
    expect(offenders).toEqual([]);
  });
});
