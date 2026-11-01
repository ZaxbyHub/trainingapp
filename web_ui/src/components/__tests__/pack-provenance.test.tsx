/**
 * pack-provenance.test.tsx — frozen acceptance checks for issue #34 item 3
 * (aggregate in-chat pack-provenance indicator), trace
 * .agents/issue-traces/34-item3-pack-version-indicator (Phase 2.5).
 * Drivers: repro/check-c1.sh .. repro/check-c5.sh filter this file per AC
 * (C5 runs the preserving suites; C1-C4 filter the AC cases here).
 *
 * Frozen contract (amended 2026-10-31 in the PR #263 feedback round; see the
 * amendment history in the trace's repro/manifest-rows.md): ChatMessageBubble
 * renders, ABOVE the SourceCitation pills it summarizes, an AGGREGATE
 * provenance line naming each contributing knowledge pack version as
 * `Grounded by knowledge pack(s): <packId> v<version>` (entries joined with
 * ', ', first-appearance order from the citations array, deduped per distinct
 * (packId, version) pair — the SAME pack at DIFFERENT versions yields
 * DISTINCT entries) whenever the message's citations carry at least one
 * `packId` and the message is not labeled grounding:'general' (the degraded-
 * floor path emits pack-attributed citations beside a "General knowledge"
 * badge; the repo treats general as no-provenance-surfaces — learn is
 * suppressed for general in three places — so the chip is suppressed there
 * too, PRR-006).
 *
 * IMPLEMENTATION REQUIREMENTS ENCODED HERE (the fix must satisfy all of them):
 *  - the aggregate element carries data-testid="pack-provenance";
 *  - the aggregate element carries NO aria-label: the visible text IS the
 *    accessible name (name-from-content; aria-label on a role-less div is
 *    naming-prohibited per ARIA 1.2 generic role — PRR-002 fix,
 *    GroundingBadge precedent). AC1/AC2 therefore pin the VISIBLE text
 *    exactly; getByText proves the name-from-content path resolves;
 *  - dedup is per (packId, version) pair, NOT per packId: AC1 pins the same
 *    pack at v1.0.1 AND v0.9.0 (each exactly once) — a packId-only dedup
 *    mutant is killed;
 *  - first-appearance order is DISCRIMINATED from a sort-by-packId mutant
 *    (M5) AND from a last-occurrence-wins mutant (PRR-005b): the AC1 fixture
 *    arrives NON-alphabetically by packId AND its repeated pair is
 *    NON-adjacent (separated by second-pack's duplicate), so both mutants
 *    fail the order assertions and the exact-string assertion;
 *  - the exact rendered string is pinned (M8): AC1's trimmed textContent
 *    EQUALS 'Grounded by knowledge pack(s): second-pack v2.0.0,
 *    opmed-cdp-mlc v1.0.1, opmed-cdp-mlc v0.9.0' (', ' join — a
 *    semicolon-join mutant is killed);
 *  - DOM placement is pinned (PRR-005a): the chip node PRECEDES the
 *    .chat-cite pills it summarizes (a mutant moving the mount after/elsewhere
 *    in the bubble fails the compareDocumentPosition assertion);
 *  - a citation with packId but no packVersion contributes `<packId>` with NO
 *    fabricated version of ANY shape — AC2 pins the visible text EXACTLY;
 *    an EMPTY-STRING version and an EMPTY-STRING packId are treated exactly
 *    like absent ones (PRR-003 fix — no dangling "v" token, no empty entry);
 *  - messages whose citations lack packId render NO aggregate element (AC3);
 *  - the indicator derives purely from the persisted citations (AC4 renders a
 *    message round-tripped through JSON.parse(JSON.stringify(msg)), pinned
 *    with EXACT equality — PRR-005c);
 *  - the exported packProvenance helper's contract is unit-tested directly
 *    (PRR-005f), not only through render.
 *
 * RED at base: on the base tree this spec does not exist (it ships with the
 * fix), so the drivers record `anchor present: absent-spec`. With this spec
 * present but the component unimplemented, every case except AC3's
 * negative-path assertions fails (AC3 pins ABSENCE, so it cannot fail against
 * an unimplemented component — it is the guardrail that stays green).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessageBubble } from '../ChatMessageBubble';
import { packProvenance } from '../PackProvenance';
import type { ChatMessage, CitationRef } from '../../types/chat';

function assistantMessage(citations?: CitationRef[], grounding?: ChatMessage['grounding']): ChatMessage {
  return {
    id: 'm-pack-provenance',
    role: 'assistant',
    content: 'Answer.',
    citations,
    grounding,
    timestamp: 1761840000000,
  };
}

describe('issue #34 item 3 — aggregate pack provenance indicator', () => {
  it('AC1 — aggregate pack provenance renders for pack-attributed citations', () => {
    // Fixture arrives NON-alphabetically by packId ('second-pack' sorts
    // BEFORE 'opmed-cdp-mlc') and its repeated pair is NON-adjacent
    // (separated by the second second-pack citation): first-appearance order
    // must win over a .sort(packId) mutant (M5) AND over a
    // delete-then-push last-occurrence mutant (PRR-005b — that mutant moves
    // the v1.0.1 entry AFTER the repeated pair, breaking the order assertions).
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
      // Same (packId, version) pair AGAIN, separated from its first
      // occurrence: the aggregate names each distinct pair EXACTLY ONCE, and
      // a last-occurrence-wins mutant that re-inserts the pair here would
      // reorder the output and fail the assertions below.
      {
        docId: 'pack:second-pack:doc2.md',
        chunkIndex: 1,
        packId: 'second-pack',
        packVersion: '2.0.0',
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
    // repeated v2.0.0 citation collapses; v1.0.1 and v0.9.0 of the same pack
    // do NOT collapse (a packId-only dedup mutant is killed).
    expect(text.split('opmed-cdp-mlc v1.0.1').length - 1).toBe(1);
    expect(text.split('opmed-cdp-mlc v0.9.0').length - 1).toBe(1);
    expect(text.split('second-pack v2.0.0').length - 1).toBe(1);

    // M5 + PRR-005b — first-appearance order, NOT sorted by packId and NOT
    // last-occurrence-wins: second-pack < opmed-cdp-mlc v1.0.1 <
    // opmed-cdp-mlc v0.9.0.
    const iSecond = text.indexOf('second-pack');
    const iV110 = text.indexOf('opmed-cdp-mlc v1.0.1');
    const iV090 = text.indexOf('opmed-cdp-mlc v0.9.0');
    expect(iSecond).toBeGreaterThanOrEqual(0);
    expect(iV110).toBeGreaterThanOrEqual(0);
    expect(iV090).toBeGreaterThanOrEqual(0);
    expect(iSecond).toBeLessThan(iV110);
    expect(iV110).toBeLessThan(iV090);

    // PRR-005a — DOM placement pinned: the chip precedes the citation pills
    // it summarizes (a mutant moving the mount after the pills fails here).
    const pills = document.querySelector('.chat-cite');
    expect(pills).not.toBeNull();
    expect(
      el.compareDocumentPosition(pills as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Name-from-content: with NO aria-label (PRR-002 fix), the visible text
    // IS the accessible name — getByText proves the text node resolves, and
    // the aria-label ABSENCE is pinned so a re-introduced attribute (naming-
    // prohibited on a role-less div, PRR-002's defect class) fails here.
    expect(screen.getByText(expected)).toBeTruthy();
    expect(el.getAttribute('aria-label')).toBeNull();
  });

  it('AC2 — pack id without version renders without a fabricated version', () => {
    // Two citations of the same pack: one version-LESS (undefined), one with
    // an EMPTY-STRING version (PRR-003) — both must render as the bare pack
    // id, and the pair dedup must treat '' and undefined as the SAME absent
    // state (one entry, no dangling "v" token of any shape).
    const citations: CitationRef[] = [
      {
        docId: 'pack:orphan-pack:doc.md',
        chunkIndex: 0,
        packId: 'orphan-pack',
        packVersion: undefined,
        source: 'doc.md',
      },
      {
        docId: 'pack:orphan-pack:doc2.md',
        chunkIndex: 1,
        packId: 'orphan-pack',
        packVersion: '',
        source: 'doc2.md',
      },
    ];

    render(<ChatMessageBubble message={assistantMessage(citations)} />);

    const el = screen.getByTestId('pack-provenance');
    // Tolerance, pinned EXACTLY: the pack id carries NO version token of ANY
    // shape (numeric or otherwise), and exactly ONE entry despite the two
    // citations (undefined and '' normalize to the same absent state).
    expect((el.textContent ?? '').trim()).toBe('Grounded by knowledge pack(s): orphan-pack');
    expect((el.textContent ?? '').trim()).not.toMatch(/v/);
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

    // (c) EMPTY-STRING packId is treated exactly like absent (PRR-003): no
    // empty entry, no degenerate chip.
    const third = render(
      <ChatMessageBubble
        message={assistantMessage([
          { docId: 'pack::doc.md', chunkIndex: 0, packId: '', packVersion: '1.0.0', source: 'doc.md' },
        ])}
      />
    );
    expect(screen.queryByTestId('pack-provenance')).toBeNull();
    third.unmount();
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
    // PRR-005c — exact equality, not a loose substring.
    expect((el.textContent ?? '').trim()).toBe('Grounded by knowledge pack(s): opmed-cdp-mlc v1.0.1');
  });

  it('SUP1 — chip suppressed when the answer is labeled grounding general', () => {
    // PRR-006: the degraded-floor path emits grounding:'general' WITH
    // pack-attributed citations; the repo treats general as
    // no-provenance-surfaces (learn suppressed in three places), so the chip
    // is suppressed rather than contradicting the "General knowledge" badge.
    const general = render(
      <ChatMessageBubble
        message={assistantMessage(
          [
            {
              docId: 'pack:opmed-cdp-mlc:doc.md',
              chunkIndex: 0,
              packId: 'opmed-cdp-mlc',
              packVersion: '1.0.1',
              source: 'doc.md',
            },
          ],
          'general'
        )}
      />
    );
    expect(general.container.textContent).toContain('General knowledge');
    expect(screen.queryByTestId('pack-provenance')).toBeNull();
    general.unmount();

    // grounding:'grounded' (or absent) renders the chip as usual.
    const grounded = render(
      <ChatMessageBubble
        message={assistantMessage(
          [
            {
              docId: 'pack:opmed-cdp-mlc:doc.md',
              chunkIndex: 0,
              packId: 'opmed-cdp-mlc',
              packVersion: '1.0.1',
              source: 'doc.md',
            },
          ],
          'grounded'
        )}
      />
    );
    expect(screen.getByTestId('pack-provenance')).toBeTruthy();
    grounded.unmount();
  });

  it('UNIT — no aria-label is rendered on the aggregate element', () => {
    // PRR-002 contract, enforced (fix-critic round 1): aria-label on a
    // role-less div is a naming-prohibited attribute (ARIA 1.2 generic role)
    // and duplicates the visible text in the AX tree. The component must
    // carry NO aria-label — the visible text IS the accessible name.
    const citations: CitationRef[] = [
      { docId: 'pack:opmed-cdp-mlc:doc.md', chunkIndex: 0, packId: 'opmed-cdp-mlc', packVersion: '1.0.1', source: 'doc.md' },
    ];
    render(<ChatMessageBubble message={assistantMessage(citations)} />);
    expect(screen.getByTestId('pack-provenance').getAttribute('aria-label')).toBeNull();
  });

  it('UNIT — packProvenance helper contract (direct unit)', () => {
    // PRR-005f: the exported helper owns the dedup/order/tolerance contract;
    // pin it directly, not only through render.
    expect(packProvenance(undefined)).toEqual([]);
    expect(packProvenance([])).toEqual([]);
    expect(
      packProvenance([{ docId: 'd', chunkIndex: 0, source: 's' }])
    ).toEqual([]);
    // First-appearance pair order + pair dedup + empty-string normalization.
    const out = packProvenance([
      { docId: 'd1', chunkIndex: 0, packId: 'b-pack', packVersion: '2.0.0' },
      { docId: 'd2', chunkIndex: 0, packId: 'a-pack', packVersion: '1.0.1' },
      { docId: 'd3', chunkIndex: 0, packId: 'b-pack', packVersion: '2.0.0' },
      { docId: 'd4', chunkIndex: 0, packId: 'a-pack', packVersion: '0.9.0' },
      { docId: 'd5', chunkIndex: 0, packId: 'c-pack', packVersion: '' },
      { docId: 'd6', chunkIndex: 0, packId: 'a-pack' },
    ]);
    expect(out).toEqual([
      { packId: 'b-pack', version: '2.0.0' },
      { packId: 'a-pack', version: '1.0.1' },
      { packId: 'a-pack', version: '0.9.0' },
      { packId: 'c-pack', version: null },
      { packId: 'a-pack', version: null },
    ]);
  });
});
