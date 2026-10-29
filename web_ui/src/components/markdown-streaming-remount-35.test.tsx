/**
 * Frozen acceptance checks (trace 35-residuals-chat-ux) for ZaxbyHub/
 * trainingapp#35 residual A6 — streaming markdown render stability.
 *
 * - C5 / AC5 (DISCRIMINATING), token c5-remount-free: while a message that
 *   contains a fenced code block receives streaming updates, the rendered
 *   code-block DOM node keeps its identity across >= 3 simulated throttled
 *   flushes under fake timers (each flush is spaced 120 ms, past the
 *   renderer's 100 ms PARSE_THROTTLE_MS window). At base the `components`
 *   object handed to react-markdown is re-created on every render, so React
 *   sees fresh component-type identities per throttled flush and REPLACES
 *   the subtree — node identity changes every flush and this check is RED.
 *
 * - C6 / AC6 (PRESERVING — round-2 narrowed contract), token
 *   c6-throttle-bound: the 100 ms parse throttle bounds NEW-source handoffs
 *   while streaming, measured PER WINDOW (each of the 10 flush cycles
 *   separated by 120 ms may introduce at most one never-before-seen source —
 *   counted against a Set of all previously handed sources, so consecutive
 *   duplicate parses cannot hide anywhere); a sub-window append reaches NO
 *   parser handoff until the window elapses; and the FINAL content is
 *   handed to the parser EXACTLY ONCE when streaming ends — pinned as the
 *   RAW occurrence count parseCalls.filter(c => c === FINAL_CONTENT).length
 *   (0 before settle, exactly 1 after), immune to adjacent-dedup blind
 *   spots, plus the last raw call equals the final content. No wall-clock
 *   asserts.
 *
 *   Disposition of unchanged-source re-renders (honest scope note): at base
 *   the instrument records 21 raw parser renders per run — each flush
 *   renders ReactMarkdown twice (the content-prop render still carrying the
 *   previous source, then the throttled state render with the new source).
 *   Those unchanged-source re-parses are React render-pipeline artifacts of
 *   the current implementation; the narrowed AC6 contract asserted here is
 *   NEW-source-per-window + exactly-one final parse, and raw render counts
 *   are deliberately asserted NOWHERE as a bound.
 *
 * Fake-timer note: vi.useFakeTimers() fakes Date.now() too, so the
 * renderer's Date.now()-based throttle window is deterministic under
 * vi.advanceTimersByTime(). Real timers are always restored in finally.
 *
 * c6 instrument (CHECK_WRONG amendment): react-markdown is mocked with a
 * counting wrapper that records EVERY source string handed to the real
 * ReactMarkdown component (parseCalls). The wrapper renders the real
 * component with all props forwarded, so rendering behavior — and the c5
 * node-identity probe in this same file — is unchanged; vi.mock is per-file,
 * so no other spec is affected. Counting actual parser handoffs (instead of
 * rendered-text mutations) makes the c6 bound real: a throttle-removal mutant
 * hands new source to the parser inside a single 100 ms window, which the
 * sub-window assertions catch directly.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MarkdownRenderer } from './MarkdownRenderer';

// Every source string ReactMarkdown is handed, in order (one entry per
// ReactMarkdown render). vi.hoisted so the vi.mock factory may close over it.
const parseCalls = vi.hoisted(() => [] as string[]);

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Actual = actual.default;
  return {
    default: function CountingReactMarkdown(props: Parameters<typeof Actual>[0]) {
      parseCalls.push(String(props.children));
      return <Actual {...props} />;
    },
  };
});

const STREAM_INITIAL = 'Streaming answer line one.\n\n```ts\nconst a = 1;\n```';

describe('#35 A6 streaming markdown (frozen acceptance)', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('c5-remount-free: the rendered code-block DOM node keeps its identity across throttled streaming flushes', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <MarkdownRenderer content={STREAM_INITIAL} isStreaming />
      );
      const firstNode = container.querySelector('.chat-md__codeblock');
      expect(firstNode, 'fixture must render a code block').not.toBeNull();

      let content = STREAM_INITIAL;
      for (let flush = 0; flush < 3; flush += 1) {
        // Move past the 100 ms throttle window, then deliver the next chunk:
        // the effect takes the immediate-parse branch and re-renders.
        act(() => {
          vi.advanceTimersByTime(120);
        });
        content += `\nTail sentence ${flush} of the streamed answer.`;
        rerender(<MarkdownRenderer content={content} isStreaming />);

        const node = container.querySelector('.chat-md__codeblock');
        expect(
          node,
          `the code-block DOM node was replaced (subtree remount) on throttled flush ${flush}`
        ).toBe(firstNode);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('c6-throttle-bound: parser handoffs stay throttled while streaming and the final content is parsed once on settle', () => {
    vi.useFakeTimers();
    try {
      parseCalls.length = 0;
      const { container, rerender } = render(
        <MarkdownRenderer content={STREAM_INITIAL} isStreaming />
      );

      // Instrument sanity (raw, no dedup — at initial render there are no
      // duplicates): the first render hands the parser the source once.
      expect(
        parseCalls.length,
        'instrument must observe exactly the initial parser handoff'
      ).toBe(1);
      expect(parseCalls[0]).toBe(STREAM_INITIAL);

      // Ten flush cycles, each opening a fresh 100 ms window (advance 120 ms
      // before delivering the next chunk). PER-WINDOW accounting: a source is
      // "new in this window" only if it differs from EVERY source handed so
      // far (Set membership, not adjacent comparison — duplicate parses of a
      // source, adjacent or not, can never count as new, and no cross-window
      // offset can smuggle a second new source into one window).
      const seenSources = new Set<string>([STREAM_INITIAL]);
      const perWindowNewSources: number[] = [];
      let content = STREAM_INITIAL;
      for (let flush = 0; flush < 10; flush += 1) {
        const windowStart = parseCalls.length;
        act(() => {
          vi.advanceTimersByTime(120);
        });
        content += `\nFlush ${flush} body text.`;
        rerender(<MarkdownRenderer content={content} isStreaming />);
        let newInWindow = 0;
        for (let i = windowStart; i < parseCalls.length; i += 1) {
          if (!seenSources.has(parseCalls[i])) {
            newInWindow += 1;
            seenSources.add(parseCalls[i]);
          }
        }
        perWindowNewSources.push(newInWindow);
        expect(
          newInWindow,
          `window ${flush} introduced ${newInWindow} never-before-seen sources to the parser (throttle bound: at most 1 new source per PARSE_THROTTLE_MS window)`
        ).toBeLessThanOrEqual(1);
      }
      const rawAfterFlushes = parseCalls.length;

      // Instrument-counts guard: the flushes reached the parser.
      expect(
        parseCalls.length,
        'instrument must have observed parser renders beyond the initial one (proves the counter counts)'
      ).toBeGreaterThanOrEqual(2);
      // Secondary aggregate: at most one new source per crossed window.
      expect(
        seenSources.size - 1,
        `streaming introduced ${seenSources.size - 1} new sources over 10 windows (bound: at most 10)`
      ).toBeLessThanOrEqual(10);

      // Sub-window append (only 40 ms since the last parse): the throttle
      // must hold the new source back — NO parser handoff carries it, and it
      // is not rendered, until the window elapses.
      act(() => {
        vi.advanceTimersByTime(40);
      });
      content += ' Held-back tail token.';
      rerender(<MarkdownRenderer content={content} isStreaming />);
      expect(
        parseCalls.some((c) => c === content),
        'a sub-window append reached the parser before the PARSE_THROTTLE_MS window elapsed'
      ).toBe(false);
      expect(container.textContent ?? '').not.toContain('Held-back tail token.');

      // Let the window elapse: the deferred parse flushes the LATEST source.
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(parseCalls[parseCalls.length - 1]).toBe(content);
      expect(container.textContent ?? '').toContain('Held-back tail token.');

      // Settle: append a never-flushed tail, then end streaming. The FINAL
      // content is pinned by RAW occurrence count — zero handoffs carried it
      // during streaming, exactly one after settling. Immune to dedup blind
      // spots: a duplicated final parse ([..., prev, FINAL, FINAL]) counts 2
      // and fails.
      content += ' Final-marker-35.';
      const FINAL_CONTENT = content;
      const finalOccurrencesBeforeSettle = parseCalls.filter(
        (c) => c === FINAL_CONTENT
      ).length;
      expect(
        finalOccurrencesBeforeSettle,
        'the final content reached the parser before streaming ended'
      ).toBe(0);

      rerender(<MarkdownRenderer content={FINAL_CONTENT} isStreaming={false} />);
      const finalOccurrencesAfterSettle = parseCalls.filter(
        (c) => c === FINAL_CONTENT
      ).length;
      expect(
        finalOccurrencesAfterSettle,
        'settling must hand the parser the FINAL content exactly once (raw occurrence count)'
      ).toBe(1);
      expect(parseCalls[parseCalls.length - 1]).toBe(FINAL_CONTENT);
      expect(container.textContent ?? '').toContain('Final-marker-35.');

      console.log(
        `c6-observed initial=1 rawParserRendersAfterFlushes=${rawAfterFlushes} perWindowNewSources=[${perWindowNewSources.join(
          ','
        )}] totalNewSources=${seenSources.size - 1} finalOccurrencesBeforeSettle=${finalOccurrencesBeforeSettle} finalOccurrencesAfterSettle=${finalOccurrencesAfterSettle}`
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
