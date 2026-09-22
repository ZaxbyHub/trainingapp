// Loopback HTTP backend for the node-backend spike: /health + /ask/stream.
// SSE framing follows contracts/api.openapi.yaml v2.6.0: CRLF separation,
// {"token": "..."} events, exactly one terminal event. Client disconnect
// cancels generation and the terminal done payload carries cancelled:true.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveModelPaths } from './models';
import { ensureLlm, streamGenerate, llmStatus, setLlmLogger } from './llm';
import { embed } from './embed';
import { openStore, ingestDocument, search, DOC_TEXT, DOC_ID, defaultDbPath, type Db } from './store';

export interface Backend {
  port: number;
  stop: () => void;
}

const SSE_SEP = '\r\n';

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}${SSE_SEP}${SSE_SEP}`;
}

let log: (line: string) => void = () => {};

export async function createBackend(opts: { modelsDir: string; log: (line: string) => void }): Promise<Backend> {
  log = opts.log;
  const paths = resolveModelPaths(opts.modelsDir);
  const threads = Number(process.env.TRAININGAPP_SPIKE_THREADS ?? '8');
  fs.mkdirSync(path.dirname(defaultDbPath()), { recursive: true });
  const db: Db = openStore(defaultDbPath());
  setLlmLogger(log);
  log(`[spike-node] store open db=${defaultDbPath()}`);

  // Single-document index built at startup (embedding model load happens here,
  // so cold-start-to-ready includes embedder init but NOT the LLM load, which
  // stays lazy/first-use — recorded in the ADR methodology notes).
  await ingestDocument(db, DOC_ID, DOC_TEXT, (t) => embed(t, paths.embeddingDir));
  log(`[spike-node] index ready llm_staged=${llmStatus(paths.qualityGguf).staged}`);

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slice: 'node-backend', llm: llmStatus(paths.qualityGguf) }));
      return;
    }
    if (req.method === 'POST' && url === '/ask/stream') {
      return void handleAskStream(req, res, paths, db, threads);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const requested = Number(process.env.TRAININGAPP_SPIKE_PORT ?? '0');
    server.listen(requested, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    stop: () => server.close(),
  };
}

function handleAskStream(req: http.IncomingMessage, res: http.ServerResponse, paths: ReturnType<typeof resolveModelPaths>, db: Db, threads: number): void {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  req.on('error', () => {
    /* client vanished mid-body; the close handler drives cancellation */
  });
  req.on('end', () => {
    let question = '';
    try {
      const parsed = JSON.parse(body) as { question?: unknown };
      question = typeof parsed.question === 'string' ? parsed.question : '';
    } catch {
      question = '';
    }
    if (!question) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'question is required' }));
      return;
    }
    void runStream(req, res, question, paths, db, threads);
  });
}

async function runStream(req: http.IncomingMessage, res: http.ServerResponse, question: string, paths: ReturnType<typeof resolveModelPaths>, db: Db, threads: number): Promise<void> {
  const started = Date.now();
  log(`[spike-node] ask begin chars=${question.length}`);
  let clientGone = false;
  const abort = new AbortController();
  // Watch the RESPONSE close, not the request: since Node 16 IncomingMessage
  // 'close' fires once the body is consumed, not when the socket drops.
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      abort.abort();
    }
  });
  req.on('error', () => {
    clientGone = true;
    abort.abort();
  });

  const qvec = await embed(question, paths.embeddingDir);
  let hits;
  try {
    hits = search(db, qvec, 4);
  } catch (err) {
    log(`[metrics] status=error phase=retrieval err=${String(err).slice(0, 200)}`);
    res.writeHead(500, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: String(err).slice(0, 300) })}${SSE_SEP}${SSE_SEP}`);
    res.end();
    return;
  }
  const context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n');
  const prompt = `Answer the question using ONLY the context below.\n\nContext:\n${context}\n\nQuestion: ${question}\n\nAnswer:`;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });

  let outcome;
  try {
    outcome = await streamGenerate(paths.qualityGguf, threads, prompt, (token) => {
      if (token && !clientGone) res.write(sseFrame({ token }));
    }, abort.signal);
  } catch (err) {
    // eslint-disable-next-line no-console
    log(`[metrics] status=error err=${String(err).slice(0, 200)} total_ms=${Date.now() - started}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/event-stream' });
    if (!clientGone) res.write(`data: ${JSON.stringify({ error: String(err).slice(0, 300) })}${SSE_SEP}${SSE_SEP}`);
    res.end();
    return;
  }

  const inferenceMs = Date.now() - started;
  // eslint-disable-next-line no-console
  log(
    `[metrics] status=${outcome.cancelled ? 'cancelled' : 'done'} tokens=${outcome.tokens} first_token_ms=${outcome.firstTokenMs ?? -1} inference_ms=${inferenceMs} total_ms=${inferenceMs}`
  );
  if (outcome.cancelled || clientGone) {
    // Contract: the cancelled stream still ends with a done payload carrying
    // cancelled:true (the client may already be gone; the frame is still the
    // single terminal event for the stream).
    res.write(sseFrame({ done: true, sources: [], context_length: context.length, cancelled: true, grounding: 'general' }));
  } else {
    res.write(
      sseFrame({
        done: true,
        sources: hits.map((h) => ({ chunk_id: h.chunkId, text: h.text.slice(0, 120) })),
        context_length: context.length,
        inference_time: inferenceMs / 1000,
        grounding: 'general',
      })
    );
  }
  res.end();
}
