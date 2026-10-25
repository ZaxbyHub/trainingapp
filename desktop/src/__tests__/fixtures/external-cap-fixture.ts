// Shared fixture builder for the F-003 streamed-cap closeout legs
// (external-response-bounds.test.ts and external-response-bounds-turncount.test.ts).
// Living in a NON-test module means importing it never re-registers the
// sibling test file's suite.
//
// Issue #243: the F-003 legs' duration is dominated by per-event loop turns —
// the original pump issued one res.write per SSE frame (2,731 flushes for the
// 8.5 MB body), and on GitHub's windows-latest agent deploy 20261015.610+ each
// flush costs ~16 ms on the consumer (≈ the Windows timer tick), pacing the
// legs past every sentinel budget. The pump therefore BATCHES SSE frames into
// each socket write (SSE_FRAMES_PER_WRITE per flush), collapsing the event
// count by an order of magnitude while preserving:
//   - per-delta cap granularity (the parser still sees one delta per SSE
//     frame; the cap still trips mid-stream within one 3072-byte delta),
//   - the mid-stream trip (frame 2731 of 2800),
//   - the well-formed end when no cap exists.
// Stats returned by runStreamingCapLeg (consumed by the frozen turncount spec;
// the frozen spec asserts the count is below 600 and the cap semantics hold):
//   dataEvents — the number of socket flushes the pump issued (the
//     producer-side mirror of the consumer's socket data-event count on
//     loopback; the turncount spec's control row establishes that
//     correspondence empirically for the unbatched shape).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExternalProviderError } from '../../../main/backend/net/provider-error.js';
import { generateExternal, type ExternalProtocol } from '../../../main/backend/inference/external-generator.js';

export interface StreamingCapLegStats {
  dataEvents: number;
  emittedBytes: number;
  failureMessage: string;
  requestAborted: boolean;
}

// Same harness budget as external-response-bounds.test.ts's CAP_SENTINEL_MS.
const CAP_SENTINEL_MS = 45_000;

// 1024 x '€' = 3072 UTF-8 bytes per delta; 2800 frames = 8.6 MiB written, so
// the cap still trips mid-stream (at frame 2731) with frames in flight.
const DELTA = '€'.repeat(1024);
export const FRAMES = 2800;
// 30 frames per flush → ~92 socket writes for the full body (~94 to the trip
// point): an order-of-magnitude collapse from the 2,731 per-frame flushes,
// while each write stays well under the 1 MiB SSE-line cap.
export const SSE_FRAMES_PER_WRITE = 30;

export const frameFor = (protocol: ExternalProtocol): string =>
  protocol === 'openai'
    ? `data: ${JSON.stringify({ choices: [{ delta: { content: DELTA } }] })}\n\n`
    : `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: DELTA } })}\n\n`;
export const endFor = (protocol: ExternalProtocol): string =>
  protocol === 'openai' ? 'data: [DONE]\n\n' : `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

interface Upstream {
  base: string;
  closed: () => boolean;
}

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  let closed = false;
  const s = http.createServer((req, res) => {
    req.resume();
    req.socket.on('close', () => {
      closed = true;
    });
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, closed: () => closed };
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T | 'sentinel'> {
  return Promise.race([p, new Promise<'sentinel'>((resolve) => setTimeout(() => resolve('sentinel'), ms))]);
}

async function failureOf(p: Promise<unknown>): Promise<ExternalProviderError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExternalProviderError) return err as ExternalProviderError;
    throw err;
  }
  throw new Error('expected a failure');
}

/**
 * Drives one full F-003 streamed-cap leg against a real loopback upstream and
 * reports the cap outcome plus the pump's socket-flush count.
 */
export async function runStreamingCapLeg(protocol: ExternalProtocol): Promise<StreamingCapLegStats> {
  let dataEvents = 0;
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = frameFor(protocol);
    const batch = Array.from({ length: SSE_FRAMES_PER_WRITE }, () => frame).join('');
    let sent = 0;
    const pump = (): void => {
      while (sent < FRAMES) {
        // One flush per BATCH of frames, not per frame (issue #243).
        const remaining = FRAMES - sent;
        const writeFrames = Math.min(SSE_FRAMES_PER_WRITE, remaining);
        sent += writeFrames;
        const payload = writeFrames === SSE_FRAMES_PER_WRITE ? batch : frame.repeat(writeFrames);
        dataEvents += 1;
        if (!res.write(payload)) {
          res.once('drain', pump);
          return;
        }
      }
      // A well-formed end: without the cap the generation SUCCEEDS.
      res.end(endFor(protocol));
    };
    pump();
  });
  let emittedBytes = 0;
  let failureMessage = '';
  try {
    await bounded(
      generateExternal({
        config: { protocol, baseUrl: up.base, model: 'm1', apiKey: null },
        question: 'q',
        contextTexts: null,
        airgap: false,
        streamCallback: (text: string) => {
          emittedBytes += Buffer.byteLength(text);
        },
      }),
      CAP_SENTINEL_MS,
    ).then((result) => {
      if (result !== 'sentinel') throw result;
    });
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : '';
  }
  // The client-side abort lands asynchronously after the cap error; give the
  // socket close a bounded moment before sampling `closed` (the frozen spec
  // pins requestAborted, so the sample must be taken after the wait).
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 2_000;
    const poll = (): void => {
      if (up.closed() || Date.now() > deadline) resolve();
      else setTimeout(poll, 25);
    };
    poll();
  });
  const requestAborted = up.closed();
  return { dataEvents, emittedBytes, failureMessage, requestAborted };
}
