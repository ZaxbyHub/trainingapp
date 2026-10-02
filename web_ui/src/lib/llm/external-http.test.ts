/**
 * F-003 (PR #142 review): every upstream-controlled buffer in the browser
 * transport is byte-capped. Bodies come from counting ReadableStreams so each
 * test can prove the reader STOPPED pulling (bounded memory), not merely that
 * an error was raised after the whole body had been buffered.
 *
 * Caps (twins of the desktop lane): SSE line 1 MiB, SSE frame 1 MiB,
 * non-stream completion body 8 MiB, model listing 4 MiB (all pages
 * together), error body read 64 KiB (truncated, classification kept), and the
 * whole streamed answer 8 MiB (PR #142 closeout).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AnthropicCompatChatService, listAnthropicModels } from './anthropic-provider';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_ERROR_BODY_BYTES,
  MAX_MODEL_LIST_BYTES,
  MAX_SSE_FRAME_BYTES,
  MAX_SSE_LINE_BYTES,
  MAX_STREAMED_ANSWER_BYTES,
  readLines,
  readSseFrames,
  upstreamMessage,
} from './external-http';
import { OpenAICompatChatService, listOpenAIModels } from './openai-provider';
import { ProviderError, errorForStatus, type FailureContext } from './provider-error';

const KiB = 1024;
const MiB = 1024 * KiB;
const CHUNK = 64 * KiB;
const ctx: FailureContext = { origin: 'http://127.0.0.1:9', model: 'm' };

interface StreamStats {
  pulls: number;
  bytesSent: number;
  cancelled: boolean;
}

/**
 * A Response whose body is produced on demand: `prefix` first, then CHUNK
 * bytes of `fill` per pull until `total` bytes, then `suffix`.
 */
function countingResponse(
  opts: { total: number; prefix?: string; fill?: string; suffix?: string },
  init: ResponseInit,
): { response: Response; stats: StreamStats } {
  const enc = new TextEncoder();
  const stats: StreamStats = { pulls: 0, bytesSent: 0, cancelled: false };
  const prefix = enc.encode(opts.prefix ?? '');
  const suffix = enc.encode(opts.suffix ?? '');
  const unit = enc.encode(opts.fill ?? 'a');
  const block = new Uint8Array(CHUNK - (CHUNK % unit.byteLength));
  for (let i = 0; i < block.byteLength; i += unit.byteLength) block.set(unit, i);
  if (opts.total % unit.byteLength !== 0) throw new Error('total must be a multiple of the fill unit');
  let prefixSent = prefix.byteLength === 0;
  let suffixSent = suffix.byteLength === 0;
  let filled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pulls += 1;
        let out: Uint8Array;
        if (!prefixSent) {
          out = prefix;
          prefixSent = true;
        } else if (filled < opts.total) {
          out = block.slice(0, Math.min(block.byteLength, opts.total - filled));
          filled += out.byteLength;
        } else if (!suffixSent) {
          out = suffix;
          suffixSent = true;
        } else {
          controller.close();
          return;
        }
        stats.bytesSent += out.byteLength;
        controller.enqueue(out);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream, init), stats };
}

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

async function drainLines(response: Response): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(response, { ctx, firstByteTimeoutMs: 5_000, isCancelled: () => false })) out.push(line);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the caps match the desktop lane', () => {
  expect(MAX_SSE_LINE_BYTES).toBe(1 * MiB);
  expect(MAX_SSE_FRAME_BYTES).toBe(1 * MiB);
  expect(MAX_COMPLETION_BODY_BYTES).toBe(8 * MiB);
  expect(MAX_MODEL_LIST_BYTES).toBe(4 * MiB);
  expect(MAX_ERROR_BODY_BYTES).toBe(64 * KiB);
  expect(MAX_STREAMED_ANSWER_BYTES).toBe(8 * MiB);
});

describe('streamed answer cap (8 MiB of UTF-8 bytes, PR #142 closeout F-003)', () => {
  // 1024 x '€' = 1024 characters but 3072 UTF-8 bytes per delta. 4096 frames
  // = 12 MiB of answer bytes yet only 4 Mi characters, so a cap that counted
  // characters against 8 Mi would never trip and the stream would finish OK.
  const DELTA = '€'.repeat(1024);
  const DELTA_BYTES = new TextEncoder().encode(DELTA).byteLength;
  const FRAMES = 4096;
  const cases = [
    {
      name: 'openai',
      frame: `data: ${JSON.stringify({ choices: [{ delta: { content: DELTA } }] })}\n\n`,
      end: 'data: [DONE]\n\n',
      service: () => new OpenAICompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm' }),
    },
    {
      name: 'anthropic',
      frame: `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: DELTA } })}\n\n`,
      end: `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      service: () => new AnthropicCompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm' }),
    },
  ] as const;

  for (const c of cases) {
    test(`${c.name}: a stream of more than 8 MiB is cut at the cap, errors, and stops reading`, async () => {
      const unitBytes = new TextEncoder().encode(c.frame).byteLength;
      const { response, stats } = countingResponse(
        { total: FRAMES * unitBytes, fill: c.frame, suffix: c.end },
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
      vi.stubGlobal('fetch', vi.fn(async () => response));
      let emittedBytes = 0;
      const consume = async () => {
        for await (const delta of c.service().generate([{ role: 'user', content: 'hi' }])) {
          emittedBytes += new TextEncoder().encode(delta).byteLength;
        }
      };
      const err = await rejection(consume());
      expect(err.kind).toBe('server');
      expect(err.message).toMatch(/an answer larger than the 8 MiB limit/);
      // What the user saw stays: at most the cap, and within one delta of it.
      expect(emittedBytes).toBeLessThanOrEqual(MAX_STREAMED_ANSWER_BYTES);
      expect(emittedBytes).toBeGreaterThan(MAX_STREAMED_ANSWER_BYTES - DELTA_BYTES);
      // The reader stopped near the cap (not all 12 MiB) and the body was cancelled.
      expect(stats.bytesSent).toBeLessThan(MAX_STREAMED_ANSWER_BYTES + 1 * MiB);
      expect(stats.cancelled).toBe(true);
    }, 30_000);
  }
});

describe('SSE line cap (1 MiB)', () => {
  test('a line with no newline past 1 MiB aborts with a classified error and stops reading', async () => {
    const { response, stats } = countingResponse({ total: 8 * MiB, prefix: 'data: ' }, { status: 200 });
    const err = await rejection(drainLines(response));
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/stream line larger than the 1 MiB limit/);
    expect(stats.bytesSent).toBeLessThan(MAX_SSE_LINE_BYTES + 2 * CHUNK);
    expect(stats.cancelled).toBe(true);
  });

  test('the cap counts BYTES: a 600K-character line of 2-byte characters (1.2 MB) is refused', async () => {
    const { response } = countingResponse({ total: 1_200_000, fill: 'é', suffix: '\n' }, { status: 200 });
    const err = await rejection(drainLines(response));
    expect(err.message).toMatch(/1 MiB/);
  });

  test('a long but legal line and normal framing still parse (CRLF tolerant, multi-byte intact)', async () => {
    const big = 'x'.repeat(MAX_SSE_LINE_BYTES - 10);
    const body = `data: ${big}\r\nevent: é—ok\n\nlast`;
    const lines = await drainLines(new Response(body));
    expect(lines).toEqual([`data: ${big}`, 'event: é—ok', '', 'last']);
  });
});

describe('SSE frame cap (1 MiB)', () => {
  async function* manyDataLines(count: number, size: number): AsyncGenerator<string> {
    for (let i = 0; i < count; i += 1) yield `data: ${'d'.repeat(size)}`;
    yield '';
  }

  test('data lines that never end the frame are refused once the frame passes 1 MiB', async () => {
    let produced = 0;
    async function* counted(): AsyncGenerator<string> {
      for await (const l of manyDataLines(4096, KiB)) {
        produced += 1;
        yield l;
      }
    }
    const consume = async () => {
      for await (const frame of readSseFrames(counted(), { ctx })) void frame;
    };
    const err = await rejection(consume());
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/stream event larger than the 1 MiB limit/);
    expect(produced).toBeLessThan(1100); // ~1 MiB of 1 KiB lines, not all 4096
  });

  test('frames under the cap are assembled as before', async () => {
    const frames: Array<{ event: string; data: string }> = [];
    for await (const f of readSseFrames(manyDataLines(3, 4), { ctx })) frames.push({ event: f.event, data: f.data });
    expect(frames).toEqual([{ event: 'message', data: 'dddd\ndddd\ndddd' }]);
  });
});

describe('non-stream completion body cap (8 MiB)', () => {
  test('a JSON completion past 8 MiB aborts with a classified error and stops reading', async () => {
    const { response, stats } = countingResponse(
      { total: 64 * MiB, prefix: '{"choices":[{"message":{"content":"' },
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const svc = new OpenAICompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm' });
    const err = await rejection(svc.chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/completion body larger than the 8 MiB limit/);
    expect(stats.bytesSent).toBeLessThan(MAX_COMPLETION_BODY_BYTES + 2 * CHUNK);
  });

  test('a JSON completion under the cap still answers', async () => {
    const content = 'y'.repeat(2 * MiB);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const svc = new OpenAICompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm' });
    await expect(svc.chat([{ role: 'user', content: 'hi' }])).resolves.toHaveLength(content.length);
  });
});

describe('model listing cap (4 MiB)', () => {
  test('an OpenAI /models body past 4 MiB is refused and reading stops', async () => {
    const { response, stats } = countingResponse({ total: 32 * MiB, prefix: '{"data":[{"id":"' }, { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const err = await rejection(listOpenAIModels({ baseUrl: 'http://127.0.0.1:9' }));
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/model list larger than the 4 MiB limit/);
    expect(stats.bytesSent).toBeLessThan(MAX_MODEL_LIST_BYTES + 2 * CHUNK);
  });

  test('Anthropic pages share ONE 4 MiB budget (two 3 MiB pages are refused on the second)', async () => {
    const page = (n: number) =>
      new Response(
        JSON.stringify({ data: [{ id: `m${n}`, pad: 'p'.repeat(3 * MiB) }], has_more: true, last_id: `m${n}` }),
        { status: 200 },
      );
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return page(calls);
      }),
    );
    const err = await rejection(listAnthropicModels({ baseUrl: 'http://127.0.0.1:9' }));
    expect(err.kind).toBe('server');
    expect(err.message).toMatch(/model list larger than the 4 MiB limit/);
    expect(calls).toBe(2);
  });

  test('a normal listing under the cap resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })),
    );
    await expect(listOpenAIModels({ baseUrl: 'http://127.0.0.1:9' })).resolves.toEqual(['a', 'b']);
  });
});

describe('error body read cap (64 KiB)', () => {
  test('a huge 401 body is read only up to 64 KiB and still classifies as auth', async () => {
    const { response, stats } = countingResponse({ total: 16 * MiB, prefix: 'unauthorized: ' }, { status: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const svc = new OpenAICompatChatService({ baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'Zkey-0123456789abcdef' });
    const err = await rejection(svc.chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.message).toContain('unauthorized: ');
    expect(stats.bytesSent).toBeLessThan(MAX_ERROR_BODY_BYTES + 2 * CHUNK);
    expect(stats.cancelled).toBe(true);
  });
});

describe('PR #142 Stage B: upstream error text is scrubbed BEFORE it is cut', () => {
  // An endpoint that echoes the key in a plain-text error body, with the key
  // straddling character 300 (the display cut). Cutting first left a key
  // prefix SHORTER than the scrub's 8-character prefix / 12-character echo
  // rules in the text, which the scrub then could not recognise.
  const KEY = 'Zq7StraddleKey0123456789ABCDEFxyz';
  const keyCtx: FailureContext = { origin: 'http://127.0.0.1:9', model: 'm', apiKey: KEY };

  // 293 leaves a 7-character prefix before the old cut, 297 a 3-character one.
  for (const offset of [290, 293, 295, 297]) {
    test(`a key echoed at offset ${offset} never leaks (not even a prefix)`, () => {
      const body = `${'x'.repeat(offset)}${KEY} trailing upstream text`;
      for (const status of [401, 404, 500]) {
        const message = errorForStatus(keyCtx, status, upstreamMessage(body)).message;
        for (let n = 3; n <= KEY.length; n += 1) {
          expect(message, `status ${status}, prefix ${n}`).not.toContain(KEY.slice(0, n));
        }
      }
    });
  }

  test('the scrub input is bounded (4096 characters) and the shown detail is still cut to 300', () => {
    const body = 'y'.repeat(10_000);
    expect(upstreamMessage(body)).toHaveLength(4096);
    const message = errorForStatus(keyCtx, 500, upstreamMessage(body)).message;
    expect(message.match(/y+/)?.[0].length).toBe(300);
  });
});
