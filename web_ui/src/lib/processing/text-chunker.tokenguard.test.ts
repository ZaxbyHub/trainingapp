// @vitest-environment node
/**
 * Acceptance spec for #35-B3 — embedder-window token guard in TextChunker
 * (batch-153-35-rag-quality, AC2). AMENDMENT ROUND: the estimator was
 * REDESIGNED (class-weighted, replacing chars/4 which badly under-counts
 * WordPiece on digits — 2040 digits measured 1227 real tokens), so this spec
 * does NOT pin estimator internals; it pins the REAL property with an
 * offline WordPiece oracle, plus a byte-identical normal-prose pin,
 * constructor validation, and the pack-ingest slide-chunk scope completion.
 *
 * NEW-SURFACE: `estimateChunkTokens`, the `maxChunkTokens` guard (default
 * 512, third constructor parameter), and the pack-ingest splitter do not
 * exist at the trace base commit (7f397fb6) — the discriminating tests fail
 * there, which is the expected base signature.
 *
 * WordPiece oracle: a minimal BertTokenizer reader implemented in this file
 * (vocab from web_ui/public/models/embeddings/snowflake-arctic-embed-m-v1.5/
 * tokenizer.json `model.vocab`; greedy longest-match-first with ##
 * continuations; uncased behavior = lowercase + NFD accent-strip;
 * max_input_chars_per_word = 100 with [UNK] fallback; BasicTokenizer
 * whitespace/punctuation splitting with CJK per-char isolation). Counts
 * include the +2 encode specials ([CLS]/[SEP]). Validated against the REAL
 * transformers.js tokenizer loaded offline from the same model dir — see the
 * self-check test (9/9 adversarial samples matched exactly when calibrated).
 * Fidelity limits vs transformers.js, honestly: no never_split handling, no
 * AddedTokens lstrip/rstrip semantics, simplified control-char cleanup —
 * none of these affect the fixtures below (the self-check would catch drift
 * on this vocabulary).
 *
 * Base calibration (measured at 7f397fb6 with the oracle):
 *   dense  wp/chunk: 751, 799, 63, 2092, 93        (5 chunks, max 2092)
 *   money  max 534 | tech max 790 | acc max 555 | table max 873  (RED at base)
 *   caps   max 277 | cjk max 267 | normal prose max 262          (in budget)
 *   long technical words (84 x 'deoxyribonucleic', round-2 fixture):
 *   1428 chars / 675 real wp (677 incl. specials) in ONE chunk    (RED at base)
 *   short non-vocabulary words (400 x 'acgt', review-round fixture):
 *   base emits a 404-word chunk = 808 real wp ('acgt' = 'ac'+'##gt',
 *   2 real pieces/word; chars/4 scores the run ~320)              (RED at base)
 *   short non-vocab + digits mix (200 x 'acgt'+5-digit, review-round):
 *   base emits a 402-word chunk = 885 real wp                      (RED at base)
 *   exact boundary (64 x 'deoxyribonucleic', round-3 fixture): content
 *   estimate exactly 512, real encoding 514 incl. specials — must SPLIT (RED at base)
 *   normal-prose fixture: 37 chunks, chunk-texts sha256
 *   ad75c9cc5c99e456086b05e5090f8cb8206bbf7fe61c41c70ed4d5a21f9be713
 *
 * All test names embed the 'token budget guard' token — the check driver
 * filters on it (vitest -t 'token budget guard').
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// pack-ingest imports these at module scope; buildPackChunks itself never
// calls them (only defaultTargets does). Mirror pack-ingest.test.ts: the
// vector index (EdgeVec WASM) and embedding model are not under test.
vi.mock('../search/vector-index', () => ({
  getVectorIndex: () => ({
    initialize: async () => undefined,
    isReady: () => false,
    addBatch: async () => undefined,
    removeByDocId: async () => undefined,
    save: async () => undefined,
  }),
}));
vi.mock('../embeddings/embedding-service', () => ({
  getEmbeddingService: () => ({ isReady: () => false, encodeBatch: async () => [] }),
}));

import { TextChunker, estimateChunkTokens } from './text-chunker';
import { buildPackChunks } from '../packs/pack-ingest';
import type { PackManifest } from '../packs/pack-manifest';

// ---------------------------------------------------------------------------
// Offline WordPiece oracle (minimal BertTokenizer, uncased)
// ---------------------------------------------------------------------------

const MODEL_DIR = path.resolve(
  __dirname, '..', '..', '..',
  'public', 'models', 'embeddings', 'snowflake-arctic-embed-m-v1.5'
);

interface WordPieceModel {
  vocab: Record<string, number>;
  unk_token: string;
  continuing_subword_prefix: string;
  max_input_chars_per_word: number;
}

function loadTokenizerModel(): WordPieceModel {
  const file = path.join(MODEL_DIR, 'tokenizer.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `WordPiece oracle requires the embedding tokenizer at ${file}. ` +
      'The model files are git-ignored; run the app once to materialize them, ' +
      'or run this check from the main checkout (check-c2.sh junctions public/models).'
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { model: WordPieceModel };
  return parsed.model;
}

const TOKENIZER_MODEL = loadTokenizerModel();
const VOCAB = new Set(Object.keys(TOKENIZER_MODEL.vocab));
const MAX_INPUT_CHARS_PER_WORD = TOKENIZER_MODEL.max_input_chars_per_word ?? 100;
const CONTINUATION_PREFIX = TOKENIZER_MODEL.continuing_subword_prefix ?? '##';
const UNK = TOKENIZER_MODEL.unk_token ?? '[UNK]';

/** Longest vocab token bounds the greedy longest-match-first lookahead. */
let LONGEST_VOCAB_TOKEN = 0;
for (const t of VOCAB) if (t.length > LONGEST_VOCAB_TOKEN) LONGEST_VOCAB_TOKEN = t.length;

const CJK_RE =
  /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\uf900-\ufaff\u{2f800}-\u{2fa1f}]/u;
const PUNCT_RE = /(?:[!-/:-@[-`{-~]|\p{P})/u;

/** BasicTokenizer (uncased): cleanup, CJK isolation, lowercase+accent strip, punctuation splitting. */
function basicTokenize(text: string): string[] {
  let s = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || /\p{C}/u.test(ch)) continue;
    if (cp === 9 || cp === 10 || cp === 13 || cp === 32 || cp === 0x3000) { s += ' '; continue; }
    if (CJK_RE.test(ch)) { s += ` ${ch} `; continue; }
    s += ch;
  }
  s = s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const out: string[] = [];
  for (const tok of s.split(/\s+/)) {
    if (!tok) continue;
    let cur = '';
    for (const ch of tok) {
      if (PUNCT_RE.test(ch)) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(ch);
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Greedy longest-match-first WordPiece with ## continuations and [UNK] fallback. */
function wordpiece(word: string): string[] {
  if (word.length > MAX_INPUT_CHARS_PER_WORD) return [UNK];
  const tokens: string[] = [];
  let start = 0;
  while (start < word.length) {
    let end = Math.min(word.length, start + LONGEST_VOCAB_TOKEN);
    let match = '';
    while (start < end) {
      const candidate = start > 0
        ? CONTINUATION_PREFIX + word.slice(start, end)
        : word.slice(start, end);
      if (VOCAB.has(candidate)) { match = candidate; break; }
      end--;
    }
    if (!match) return [UNK];
    tokens.push(match);
    start = end;
  }
  return tokens;
}

/** Actual WordPiece token count of `text` INCLUDING the +2 encode specials. */
function wordpieceCount(text: string): number {
  let n = 0;
  for (const w of basicTokenize(text)) n += wordpiece(w).length;
  return n + 2; // [CLS] ... [SEP] — the arctic-embed encode format
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const denseWord = (i: number): string => `metric${String(i).padStart(3, '0')}`;
const denseSentence = (start: number, count: number): string =>
  `${Array.from({ length: count }, (_, k) => denseWord(start + k)).join(' ')}.`;

interface Fixture {
  text: string;
  /** Unique markers embedded in the text; each must survive chunking, in order. */
  markers: string[];
}

/** Marker factory: one namespace per fixture family, globally unique words. */
function makeMarkerFactory() {
  let n = 0;
  return (tag: string) => `zqmark${tag}${n++}`;
}

/**
 * Dense long-sentence fixture (all over-budget emission paths: 240-word
 * sentences -> accumulate/finalize; 600-word sentence -> split path; 30-word
 * tail -> final flush), with anchor markers between the groups.
 */
function makeDenseFixture(): Fixture {
  const mk = makeMarkerFactory();
  const markers: string[] = [];
  const parts: string[] = [];
  const markerSentence = () => {
    const m = mk('D');
    markers.push(m);
    parts.push(`${m} anchor point.`);
  };
  parts.push(denseSentence(0, 240), denseSentence(1000, 240), denseSentence(2000, 20));
  markerSentence();
  parts.push(denseSentence(3000, 600));
  markerSentence();
  parts.push(denseSentence(4000, 30));
  return { text: parts.join('\n\n'), markers };
}

/**
 * The byte-identical normal-prose fixture: 300 sentences of plain English.
 * Measured at base: 37 chunks, chunk-texts sha256 pinned below. The token
 * guard must leave this fixture byte-identical (every chunk already fits the
 * window: max 262 actual WordPiece tokens at base).
 */
function makeNormalProseFixture(): string {
  return Array.from(
    { length: 300 },
    (_, i) =>
      `The training system processes record ${i} and writes the audit result to local storage before the next batch begins.`
  ).join(' ');
}

const NORMAL_FIXTURE_CHUNK_COUNT = 37;
const NORMAL_FIXTURE_CHUNK_TEXTS_SHA256 =
  'ad75c9cc5c99e456086b05e5090f8cb8206bbf7fe61c41c70ed4d5a21f9be713';

/** Adversarial-but-realistic battery (all measured at base; see header). */
function makeBatteryFixtures(): Record<string, Fixture> {
  const dense = makeDenseFixture();

  const mkMoney = makeMarkerFactory();
  const moneyParts: string[] = []; const moneyMarkers: string[] = [];
  for (let i = 0; i < 200; i++) {
    if (i % 25 === 0) { const m = mkMoney('B'); moneyMarkers.push(m); moneyParts.push(`${m} anchor.`); }
    moneyParts.push(
      `Invoice ${1000 + i} totaled $${(i * 137.55).toFixed(2)} for ${i % 7 + 2} units in Q${i % 4 + 1} 2024, a ${(i % 13 + 1.5).toFixed(1)}% change.`
    );
  }

  const mkTech = makeMarkerFactory();
  const techParts: string[] = []; const techMarkers: string[] = [];
  for (let i = 0; i < 200; i++) {
    if (i % 25 === 0) { const m = mkTech('T'); techMarkers.push(m); techParts.push(`${m} anchor.`); }
    techParts.push(
      `The OAuth2AuthorizationServer rejected CVE-2026-${1000 + i} at hex 0x${(0xbeef + i).toString(16)} because kernel_panic_handler port 8080 flagged bcrypt $2b$12$KIX and retransmitted UDP ${i} times.`
    );
  }

  const mkCaps = makeMarkerFactory();
  const capsParts: string[] = []; const capsMarkers: string[] = [];
  for (let i = 0; i < 120; i++) {
    if (i % 15 === 0) { const m = mkCaps('C'); capsMarkers.push(m); capsParts.push(`${m} anchor.`); }
    capsParts.push(
      `THE TRAINING PROTOCOL ${i} REQUIRES QUARTERLY REVIEW OF ALL COMPLIANCE RECORDS BEFORE THE AUDIT COMMITTEE PUBLISHES FINAL FINDINGS.`
    );
  }

  const mkCjk = makeMarkerFactory();
  const cjkParts: string[] = []; const cjkMarkers: string[] = [];
  for (let i = 0; i < 120; i++) {
    if (i % 15 === 0) { const m = mkCjk('K'); cjkMarkers.push(m); cjkParts.push(`${m} anchor.`); }
    cjkParts.push(`第${i}条：培训系统要求每季度对档案记录进行合规审查并签署整改报告。`);
  }

  const mkAcc = makeMarkerFactory();
  const accParts: string[] = []; const accMarkers: string[] = [];
  for (let i = 0; i < 160; i++) {
    if (i % 20 === 0) { const m = mkAcc('A'); accMarkers.push(m); accParts.push(`${m} anchor.`); }
    accParts.push(
      `Le système de formation vérifie l'enregistrement ${i} à Münchhausen, Grüße naïves créées por señor Álvarez.`
    );
  }

  const mkTable = makeMarkerFactory();
  const tableParts: string[] = []; const tableMarkers: string[] = [];
  for (let i = 0; i < 200; i++) {
    if (i % 25 === 0) { const m = mkTable('N'); tableMarkers.push(m); tableParts.push(`${m} anchor.`); }
    tableParts.push(`FY2024-Q${i % 4 + 1} 1,2${i}3.45 98${i}.10 +${i}.75% 0.0${i} 45,6${i}7.89`);
  }

  // Critic round-2 fixture class: long alphabetic technical words. 84 x
  // 'deoxyribonucleic' = 1428 chars measuring 675 real WordPiece tokens
  // (677 incl. specials; each 16-char word = 8 real pieces) — one giant
  // 84-word sentence (under the 256-word unit bound) that chars/4 sizes at
  // ~357 and that a uniform letter weight cannot bound. Must be split so
  // every emitted chunk fits 512 ACTUAL tokens.
  const mkDeoxy = makeMarkerFactory();
  const deoxyParts: string[] = []; const deoxyMarkers: string[] = [];
  {
    const m = mkDeoxy('L'); deoxyMarkers.push(m); deoxyParts.push(`${m} anchor.`);
    deoxyParts.push(`${Array.from({ length: 84 }, () => 'deoxyribonucleic').join(' ')}.`);
    const m2 = mkDeoxy('L'); deoxyMarkers.push(m2); deoxyParts.push(`${m2} anchor.`);
  }

  // Review-round fixture class: SHORT non-vocabulary letter words. 'acgt'
  // is not in the model vocabulary ('ac' + '##gt' = 2 real pieces per word),
  // so a 256-word run of it encodes to 512 content + 2 specials = 514 real
  // tokens — while the chars/4 estimator scores the run at ~320 and the
  // short-letter class needs ceil(len/3) (2 per 'acgt') to bound it. 400
  // repetitions guarantee an over-window emission at base (the split path
  // emits a 256-word piece = 514; the accumulate path emits a 404-word
  // piece = 802). Must be split so every emitted chunk fits 512 ACTUAL.
  const mkShort = makeMarkerFactory();
  const shortParts: string[] = []; const shortMarkers: string[] = [];
  {
    const m1 = mkShort('S'); shortMarkers.push(m1); shortParts.push(`${m1} anchor.`);
    shortParts.push(Array.from({ length: 400 }, () => 'acgt').join(' '));
    const m2 = mkShort('S'); shortMarkers.push(m2); shortParts.push(`${m2} anchor.`);
  }

  // Review-round companion: short non-vocab words MIXED with digit runs
  // (both classes under-counted by chars/4; digits at 1.0 real/char, 'acgt'
  // at 2 real/word -> 7 real tokens per pair).
  const mkMixd = makeMarkerFactory();
  const mixParts: string[] = []; const mixMarkers: string[] = [];
  {
    const m1 = mkMixd('X'); mixMarkers.push(m1); mixParts.push(`${m1} anchor.`);
    const mixWords: string[] = [];
    for (let i = 0; i < 200; i++) { mixWords.push('acgt'); mixWords.push(String(i).padStart(5, '0')); }
    mixParts.push(mixWords.join(' '));
    const m2 = mkMixd('X'); mixMarkers.push(m2); mixParts.push(`${m2} anchor.`);
  }

  return {
    'dense long-sentence': dense,
    'prose with numbers/currency': { text: moneyParts.join(' '), markers: moneyMarkers },
    'technical term soup': { text: techParts.join(' '), markers: techMarkers },
    'all-caps': { text: capsParts.join(' '), markers: capsMarkers },
    'cjk passage': { text: cjkParts.join(''), markers: cjkMarkers },
    'accented unicode': { text: accParts.join(' '), markers: accMarkers },
    'numeric table': { text: tableParts.join('\n'), markers: tableMarkers },
    'long technical words': { text: deoxyParts.join('\n\n'), markers: deoxyMarkers },
    'short non-vocabulary words': { text: shortParts.join('\n\n'), markers: shortMarkers },
    'short non-vocab + digits mix': { text: mixParts.join('\n\n'), markers: mixMarkers },
  };
}

/**
 * Content preservation: every marker appears in the emitted chunks and the
 * markers appear in source order (overlap duplicates allowed — a marker may
 * appear twice, never out of order).
 */
function assertMarkersPreserved(chunks: Array<{ text: string }>, markers: string[]): void {
  expect(markers.length).toBeGreaterThan(0);
  const joined = chunks.map((c) => c.text).join('\n');
  let prev = -1;
  for (const m of markers) {
    const idx = joined.indexOf(m);
    expect(idx, `marker ${m} must survive chunking`).toBeGreaterThan(-1);
    expect(idx, `marker ${m} must appear in source order`).toBeGreaterThan(prev);
    prev = idx;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TextChunker token budget guard (#35-B3 / AC2)', () => {
  it('token budget guard: surface exists — estimateChunkTokens is an exported function returning a non-negative integer', () => {
    // Base signature anchor: at the base commit this fails with
    // "expected 'undefined' to be 'function'". Internals (class weights) are
    // deliberately NOT pinned — only the contract shape.
    expect(typeof estimateChunkTokens).toBe('function');
    expect(estimateChunkTokens('')).toBe(0);
    const n = estimateChunkTokens('some realistic prose sentence');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('token budget guard: oracle self-check — the offline WordPiece reader matches the real transformers.js tokenizer', async () => {
    // Fidelity evidence for the oracle used by the battery below: loads the
    // REAL tokenizer offline from the same model dir and compares counts on
    // the adversarial shapes (this passes at base — it validates the oracle,
    // not the fix).
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const real = await AutoTokenizer.from_pretrained(MODEL_DIR);

    const samples = [
      'The training system processes record 42 and writes the audit result.',
      'Total cost was $1,234.56 for Q3 2024 across 12,890 SKUs.',
      'café naïve ÄÖÜ Grüße von München',
      '培训系统要求每季度审查记录并签署合规报告',
      'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG.',
      '0xdeadbeef a1b2c3d4e5f6 2026-10-28T00:00:00Z',
      'metric000 metric001 metric999 nonhydrodynamique',
      'word-supercalifragilisticexpialidocious-processing',
      '',
    ];
    for (const s of samples) {
      const realCount = real.encode(s).length;
      expect(
        wordpieceCount(s),
        `oracle must match transformers.js on: ${s.slice(0, 40)}`
      ).toBe(realCount);
    }
  });

  it('token budget guard: adversarial battery — every emitted chunk fits 512 ACTUAL WordPiece tokens, markers preserved in order', () => {
    const battery = makeBatteryFixtures();
    // Also run the byte-identical normal fixture through the same oracle
    // (its markers are pinned by byte-identity instead — see that test).
    const normal = makeNormalProseFixture();

    for (const [name, fixture] of Object.entries(battery)) {
      const chunker = new TextChunker(); // production defaults (256/100/512)
      const chunks = chunker.chunkText(fixture.text, `${name}.txt`);

      expect(chunks.length, `${name}: forward progress (non-empty output)`).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.text.length, `${name}: non-empty chunk text`).toBeGreaterThan(0);
        const actual = wordpieceCount(chunk.text);
        expect(
          actual,
          `${name}: chunk of ${actual} actual WordPiece tokens exceeds the 512-token embedder window`
        ).toBeLessThanOrEqual(512);
      }
      assertMarkersPreserved(chunks, fixture.markers);
    }

    // Normal prose through the same actual-token oracle (expected to fit
    // even at base — max 262 — the byte-identity test pins its exact shape).
    const normalChunks = new TextChunker().chunkText(normal, 'normal.txt');
    for (const chunk of normalChunks) {
      expect(wordpieceCount(chunk.text)).toBeLessThanOrEqual(512);
    }
  });

  it('token budget guard: exact-boundary — 64 deoxyribonucleic words (content estimate 512, real 514 incl specials) are split so every emitted piece fits 512 real tokens', () => {
    // Critic round-3 shape: the fixture's word-shape-aware content estimate
    // is exactly the default maxChunkTokens (64 x ceil(16/2) = 512) while
    // its REAL encoding incl. [CLS]/[SEP] is 514 — the guard must reserve
    // the two encoder specials (content budget = maxChunkTokens - 2) and
    // SPLIT this input. Asserting only the input's estimate would pass
    // vacuously. Marker-free by design (the critic's exact-boundary probe);
    // no trailing period so the real encoding is exactly 512 + 2 specials.
    const words = Array.from({ length: 64 }, () => 'deoxyribonucleic');
    const text = words.join(' ');

    // Fixture self-check via the oracle (= real tokenizer): exactly 64
    // words, real encoding exactly 514 incl. specials — one [CLS]/[SEP]
    // pair above the window.
    expect(words).toHaveLength(64);
    expect(wordpieceCount(text)).toBe(514);

    const chunks = new TextChunker().chunkText(text, 'exact-boundary.txt');

    // The guard must SPLIT it: a single emitted piece would carry the whole
    // 514-token encoding (content budget is maxChunkTokens - 2 = 510).
    expect(
      chunks.length,
      'exact-boundary fixture must be split into >= 2 pieces'
    ).toBeGreaterThanOrEqual(2);

    // Oracle on EVERY emitted piece, incl. specials — not just the input.
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(
        wordpieceCount(chunk.text),
        'every emitted piece must fit the 512-token window incl. [CLS]/[SEP]'
      ).toBeLessThanOrEqual(512);
    }
  });

  it('token budget guard: normal prose is byte-identical to the pre-guard baseline (measured at base)', () => {
    // Baseline measured at 7f397fb6 BEFORE the fix: 37 chunks whose texts
    // hash to the pinned sha256. The guard must not change normal-prose
    // output: every chunk already fits the window (max 262 actual WordPiece
    // tokens). If the fix changes this output the check goes RED at head and
    // the estimator calibration must be re-discussed, not silently accepted.
    const chunks = new TextChunker().chunkText(makeNormalProseFixture(), 'normal.txt');
    expect(chunks).toHaveLength(NORMAL_FIXTURE_CHUNK_COUNT);
    const texts = chunks.map((c) => c.text);
    const hash = createHash('sha256').update(JSON.stringify(texts), 'utf8').digest('hex');
    expect(hash).toBe(NORMAL_FIXTURE_CHUNK_TEXTS_SHA256);
  });

  it('token budget guard: constructor rejects invalid maxChunkTokens (0, negative, NaN, Infinity)', () => {
    // Mirrors the existing chunkSize/chunkOverlap constructor validation
    // style: invalid bounds throw at construction time. NaN and Infinity
    // must throw too (both would silently disable the guard). Plan
    // Revision 3: maxChunkTokens must be >= 3 (content budget =
    // maxChunkTokens - 2 must be positive), so 1 and 2 are rejected as well.
    for (const bad of [0, -5, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new TextChunker(256, 100, bad),
        `maxChunkTokens=${bad} must throw`
      ).toThrow();
    }
    // The production default bound itself is valid.
    expect(() => new TextChunker(256, 100, 512)).not.toThrow();
  });

  it('token budget guard: pack slide chunks (bypassing TextChunker) are split to fit 512 actual tokens with the leading marker preserved', () => {
    // Critic finding 4 (scope completion): pack slide docs are emitted as a
    // single chunk directly from pack-ingest (buildPackChunks ->
    // chunks.push({text, ...}) for docs/slide-*.json), bypassing TextChunker
    // entirely — so a long transcript blows the embedder window on the pack
    // path even with the chunker guarded. The fix exports the token-budget
    // splitter and applies it here. This leg drives buildPackChunks with a
    // long-transcript slide payload.
    const transcript = [
      'Quarterly audit review transcript follows.',
      denseSentence(0, 240),
      denseSentence(1000, 240),
      denseSentence(2000, 240),
    ].join('\n\n');
    const slidePayload = {
      slide_id: 'ab12',
      section_title: 'Compliance',
      slide_title: 'Quarterly Audit',
      on_screen_text: 'Review the quarterly audit results and sign the report.',
      transcript_text: transcript,
    };
    const manifest = {
      id: 'tok-guard-pack',
      name: 'Token Guard Pack',
      version: '1.0.0',
      published_at: '2026-10-28T00:00:00Z',
      source_class: 'training' as const,
      embedding: { model_id: 'snowflake-arctic-embed-m-v1.5', dims: 768, normalize: true },
      chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
      docs: [
        {
          path: 'docs/slide-3-ab12.json',
          sha256: '0'.repeat(64),
          title: 'Quarterly Audit',
          mime: 'application/json',
        },
      ],
    } satisfies PackManifest;

    const docs = new Map<string, Uint8Array>([
      ['docs/slide-3-ab12.json', new TextEncoder().encode(JSON.stringify(slidePayload))],
    ]);

    const chunks = buildPackChunks(manifest, docs);
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Every emitted slide chunk fits the window in ACTUAL tokens...
    for (const chunk of chunks) {
      expect(wordpieceCount(chunk.text)).toBeLessThanOrEqual(512);
    }
    // ...and the leading [training-slide] marker line stays first (the Learn
    // kernel and pinned-slide resolver depend on it).
    expect(chunks[0]!.text.startsWith('[training-slide]')).toBe(true);
    expect(chunks[0]!.text).toContain('section=Compliance');
    // Content preservation: the transcript's opening sentence survives.
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain('Quarterly audit review transcript follows.');
  });
});
