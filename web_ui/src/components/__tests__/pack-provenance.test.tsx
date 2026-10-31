/**
 * pack-provenance.test.tsx — frozen acceptance checks for issue #34 item 3
 * (aggregate in-chat pack-provenance indicator), trace
 * .agents/issue-traces/34-item3-pack-version-indicator (Phase 2.5).
 * Drivers: repro/check-c1.sh .. repro/check-c4.sh filter this file per AC.
 *
 * Frozen contract: ChatMessageBubble renders, adjacent to the SourceCitation
 * block, an AGGREGATE provenance line naming each contributing knowledge pack
 * as `Grounded by knowledge pack(s): <packId> v<version>` (entries joined
 * with ', ', first-appearance order from the citations array, deduped per
 * distinct (packId, version) pair — the SAME pack at DIFFERENT versions
 * yields DISTINCT entries) whenever the message's citations carry at least
 * one `packId`.
 *
 * IMPLEMENTATION REQUIREMENTS ENCODED HERE (the fix must satisfy all of them):
 *  - the aggregate element carries data-testid="pack-provenance";
 *  - the aggregate element carries an aria-label; AC1 resolves it with
 *    getByLabelText using the EXACT full expected string, so the accessible
 *    name must equal the visible list (a stale/incomplete aria-label mutant
 *    is killed — M9);
 *  - dedup is per (packId, version) pair, NOT per packId: AC1 pins the same
 *    pack at v1.0.1 AND v0.9.0 (each exactly once) — a packId-only dedup
 *    mutant is killed;
 *  - first-appearance order is DISCRIMINATED from a sort-by-packId mutant
 *    (M5): the AC1 fixture arrives NON-alphabetically by packId ('second-pack'
 *    first, then 'opmed-cdp-mlc'), so a .sort(packId) derivation fails both
 *    the order assertions and the exact-string assertion;
 *  - the exact rendered string is pinned (M8): AC1's trimmed textContent
 *    EQUALS 'Grounded by knowledge pack(s): second-pack v2.0.0,
 *    opmed-cdp-mlc v1.0.1, opmed-cdp-mlc v0.9.0' (', ' join — a
 *    semicolon-join mutant is killed);
 *  - a citation with packId but no packVersion contributes `<packId>` with NO
 *    fabricated version of ANY shape (numeric or not) — AC2 pins the
 *    element's visible text AND its aria-label to EXACTLY
 *    'Grounded by knowledge pack(s): orphan-pack';
 *  - messages whose citations lack packId render NO aggregate element (AC3);
 *  - the indicator derives purely from the persisted citations (AC4 renders a
 *    message round-tripped through JSON.parse(JSON.stringify(msg))).
 *
 * RED at base: on the base tree this spec does not exist (it ships with the
 * fix), so the drivers record `anchor present: absent-spec`. With this spec
 * present but the component unimplemented, every case fails at
 * getByTestId('pack-provenance') — the expected red checkpoint.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessageBubble } from '../ChatMessageBubble';
import type { ChatMessage, CitationRef } from '../../types/chat';

function assistantMessage(citations?: CitationRef[]): ChatMessage {
  return {
    id: 'm-pack-provenance',
    role: 'assistant',
    content: 'Answer.',
    citations,
    timestamp: 1761840000000,
  };
}

describe('issue #34 item 3 — aggregate pack provenance indicator', () => {
  it('AC1 — aggregate pack provenance renders for pack-attributed citations', () => {
    // Fixture arrives NON-alphabetically by packId ('second-pack' sorts
    // BEFORE 'opmed-cdp-mlc'): first-appearance order must win over any
    // .sort(packId) derivation (mutant M5).
    const citations: CitationRef[] = [
      {
        docId: 'pack:second-pack:doc.md',
        chunkIndex: 0,
        packId: 'second-pack',
        packVersion: '2.0.0',
        source: 'doc.md',
      },
      {
        docId: 'pack:opmed-cdp-mlc:doc.md',
        chunkIndex: 0,
        packId: 'opmed-cdp-mlc',
        packVersion: '1.0.1',
        source: 'doc.md',
      },
      // Same (packId, version) as the previous citation: the aggregate names
      // each distinct pair EXACTLY ONCE (dedup).
      {
        docId: 'pack:opmed-cdp-mlc:doc2.md',
        chunkIndex: 1,
        packId: 'opmed-cdp-mlc',
        packVersion: '1.0.1',
        source: 'doc2.md',
      },
      // Same pack, DIFFERENT version: a DISTINCT (packId, version) pair — a
      // packId-only dedup mutant would drop it.
      {
        docId: 'pack:opmed-cdp-mlc:old.md',
        chunkIndex: 1,
        packId: 'opmed-cdp-mlc',
        packVersion: '0.9.0',
        source: 'old.md',
      },
    ];

    render(<ChatMessageBubble message={assistantMessage(citations)} />);

    // The aggregate element exists.
    const el = screen.getByTestId('pack-provenance');
    const text = (el.textContent ?? '').trim();

    // M8 — exact rendered string: the `Grounded by knowledge pack(s): `
    // prefix followed by `<packId> v<version>` entries joined with ', ' in
    // first-appearance order. Kills join-separator mutants ('; ' etc.).
    const expected =
      'Grounded by knowledge pack(s): second-pack v2.0.0, opmed-cdp-mlc v1.0.1, opmed-cdp-mlc v0.9.0';
    expect(text).toBe(expected);

    // Dedup: each distinct (packId, version) pair appears EXACTLY once — the
    // repeated v1.0.1 citation collapses; v1.0.1 and v0.9.0 of the same pack
    // do NOT collapse (a packId-only dedup mutant is killed).
    expect(text.split('opmed-cdp-mlc v1.0.1').length - 1).toBe(1);
    expect(text.split('opmed-cdp-mlc v0.9.0').length - 1).toBe(1);
    expect(text.split('second-pack v2.0.0').length - 1).toBe(1);

    // M5 — first-appearance order, NOT sorted by packId: with this
    // non-alphabetical fixture, second-pack < opmed-cdp-mlc v1.0.1 <
    // opmed-cdp-mlc v0.9.0. A .sort(packId) mutant renders the opmed-cdp-mlc
    // entries first and fails here (and on the exact string above).
    const iSecond = text.indexOf('second-pack');
    const iV110 = text.indexOf('opmed-cdp-mlc v1.0.1');
    const iV090 = text.indexOf('opmed-cdp-mlc v0.9.0');
    expect(iSecond).toBeGreaterThanOrEqual(0);
    expect(iV110).toBeGreaterThanOrEqual(0);
    expect(iV090).toBeGreaterThanOrEqual(0);
    expect(iSecond).toBeLessThan(iV110);
    expect(iV110).toBeLessThan(iV090);

    // M9 — the accessible name carries the SAME full list: exact full-string
    // getByLabelText (a stale or incomplete aria-label mutant is killed).
    expect(screen.getByLabelText(expected)).toBeDefined();
  });

  it('AC2 — pack id without version renders without a fabricated version', () => {
    const citations: CitationRef[] = [
      {
        docId: 'pack:orphan-pack:doc.md',
        chunkIndex: 0,
        packId: 'orphan-pack',
        packVersion: undefined,
        source: 'doc.md',
      },
    ];

    render(<ChatMessageBubble message={assistantMessage(citations)} />);

    const el = screen.getByTestId('pack-provenance');
    // Tolerance, pinned EXACTLY: the pack id carries NO version token of ANY
    // shape (numeric or otherwise) — the visible text AND the accessible
    // name are exactly the bare-pack rendering. Exact equality (not a /v\d/
    // negative match) kills fabricated NONNUMERIC-version mutants too (e.g.
    // "orphan-pack vunknown").
    expect((el.textContent ?? '').trim()).toBe('Grounded by knowledge pack(s): orphan-pack');
    expect(el.getAttribute('aria-label')).toBe('Grounded by knowledge pack(s): orphan-pack');
  });

  it('AC3 — no aggregate indicator when citations lack pack attribution', () => {
    // (a) source-only citations (no packId): the pills still render, the
    // aggregate does not.
    const first = render(
      <ChatMessageBubble
        message={assistantMessage([{ docId: 'doc-x', chunkIndex: 0, source: 'doc-x.md', text: 'x' }])}
      />
    );
    expect(first.container.textContent).toContain('doc-x.md');
    expect(screen.queryByTestId('pack-provenance')).toBeNull();
    first.unmount();

    // (b) no citations at all: nothing new renders.
    const second = render(<ChatMessageBubble message={assistantMessage(undefined)} />);
    expect(second.container.textContent).toContain('Answer.');
    expect(screen.queryByTestId('pack-provenance')).toBeNull();
    second.unmount();
  });

  it('AC4 — indicator derives purely from persisted citations (JSON round-trip)', () => {
    const msg = assistantMessage([
      {
        docId: 'pack:opmed-cdp-mlc:doc.md',
        chunkIndex: 0,
        packId: 'opmed-cdp-mlc',
        packVersion: '1.0.1',
        source: 'doc.md',
      },
    ]);
    // The IndexedDB history reload path: only JSON-serializable fields survive.
    const persisted = JSON.parse(JSON.stringify(msg)) as ChatMessage;

    render(<ChatMessageBubble message={persisted} />);

    const el = screen.getByTestId('pack-provenance');
    expect(el.textContent ?? '').toContain('opmed-cdp-mlc v1.0.1');
  });
});
