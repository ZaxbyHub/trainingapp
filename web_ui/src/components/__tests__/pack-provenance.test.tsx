/**
 * pack-provenance.test.tsx — frozen acceptance checks for issue #34 item 3
 * (aggregate in-chat pack-provenance indicator), trace
 * .agents/issue-traces/34-item3-pack-version-indicator (Phase 2.5).
 * Drivers: repro/check-c1.sh .. repro/check-c4.sh filter this file per AC.
 *
 * Frozen contract: ChatMessageBubble renders, adjacent to the SourceCitation
 * block, an AGGREGATE provenance line naming each contributing knowledge pack
 * as `Grounded by knowledge pack(s): <packId> v<version>` (comma-joined,
 * first-appearance order from the citations array, deduped per distinct
 * (packId, version) pair — the SAME pack at DIFFERENT versions yields
 * DISTINCT entries) whenever the message's citations carry at least one
 * `packId`.
 *
 * IMPLEMENTATION REQUIREMENTS ENCODED HERE (the fix must satisfy all of them):
 *  - the aggregate element carries data-testid="pack-provenance";
 *  - the aggregate element carries an aria-label containing
 *    "Grounded by knowledge pack(s)" — AC1 resolves it with getByLabelText,
 *    which matches ONLY the accessible-name computation (aria-label), not
 *    visible text: the implementation MUST set that aria-label;
 *  - dedup is per (packId, version) pair, NOT per packId: AC1 pins the same
 *    pack at v1.0.1 AND v0.9.0 (each exactly once, in first-appearance
 *    order) — a packId-only dedup mutant is killed;
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
    const citations: CitationRef[] = [
      {
        docId: 'pack:opmed-cdp-mlc:doc.md',
        chunkIndex: 0,
        packId: 'opmed-cdp-mlc',
        packVersion: '1.0.1',
        source: 'doc.md',
      },
      // Same (packId, version) as the first citation: the aggregate names
      // each distinct pair EXACTLY ONCE (dedup).
      {
        docId: 'pack:opmed-cdp-mlc:doc2.md',
        chunkIndex: 1,
        packId: 'opmed-cdp-mlc',
        packVersion: '1.0.1',
        source: 'doc2.md',
      },
      // Same pack, DIFFERENT version: a DISTINCT (packId, version) pair — a
      // packId-only dedup mutant would drop it. Placed after the v1.0.1
      // citations but before 'second-pack'.
      {
        docId: 'pack:opmed-cdp-mlc:old.md',
        chunkIndex: 1,
        packId: 'opmed-cdp-mlc',
        packVersion: '0.9.0',
        source: 'old.md',
      },
      // A second contributing pack: must appear AFTER both opmed-cdp-mlc
      // versions (first-appearance order from the citations array).
      {
        docId: 'pack:second-pack:doc.md',
        chunkIndex: 0,
        packId: 'second-pack',
        packVersion: '2.0.0',
        source: 'doc.md',
      },
    ];

    render(<ChatMessageBubble message={assistantMessage(citations)} />);

    // The aggregate element exists and names the pack id + version.
    const el = screen.getByTestId('pack-provenance');
    const text = el.textContent ?? '';
    expect(text).toContain('opmed-cdp-mlc');
    expect(text).toContain('v1.0.1');

    // Derivation shape: `<packId> v<version>` per DISTINCT (packId, version)
    // pair — the same pack at two versions yields TWO entries ...
    expect(text).toContain('opmed-cdp-mlc v1.0.1');
    expect(text).toContain('opmed-cdp-mlc v0.9.0');
    expect(text).toContain('second-pack v2.0.0');
    // ... each pair EXACTLY once (dedup across the repeated v1.0.1 citation;
    // NO dedup collapse between v1.0.1 and v0.9.0 of the same pack) ...
    expect(text.split('opmed-cdp-mlc v1.0.1').length - 1).toBe(1);
    expect(text.split('opmed-cdp-mlc v0.9.0').length - 1).toBe(1);
    expect(text.split('second-pack v2.0.0').length - 1).toBe(1);
    // ... in first-appearance order: v1.0.1 < v0.9.0 < second-pack.
    const iV110 = text.indexOf('opmed-cdp-mlc v1.0.1');
    const iV090 = text.indexOf('opmed-cdp-mlc v0.9.0');
    const iSecond = text.indexOf('second-pack');
    expect(iV110).toBeGreaterThanOrEqual(0);
    expect(iV090).toBeGreaterThanOrEqual(0);
    expect(iSecond).toBeGreaterThanOrEqual(0);
    expect(iV110).toBeLessThan(iV090);
    expect(iV090).toBeLessThan(iSecond);

    // Accessible name: getByLabelText resolves via aria-label (the aggregate
    // element MUST set it) — visible text alone does not satisfy this.
    expect(screen.getByLabelText(/Grounded by knowledge pack\(s\)/)).toBeDefined();
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
