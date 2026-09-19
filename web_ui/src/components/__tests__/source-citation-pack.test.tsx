/**
 * source-citation-pack.test.tsx — DISCRIMINATING acceptance check for issue
 * #74 AC6 (C7: pack provenance in chat citations).
 *
 * Frozen contract: a structured citation (the EXISTING CitationRef shape from
 * web_ui/src/types/chat.ts, extended with the pack identity fields `packId`
 * and `packVersion`) renders its pack provenance in the citation pill's
 * visible text as `<packId> v<packVersion>` — e.g. `bundled-min v1.0.0`.
 *
 * On the BASE tree this test RUNS and FAILS: SourceCitation renders only the
 * basename of `cite.source` (plus an optional page suffix) and ignores the
 * pack fields entirely, so the assertion
 *   expect(container.textContent).toContain('bundled-min v1.0.0')
 * fails with an expect-mismatch whose received text is the base pill text
 * (`[1]welcome.md`). That exact failure IS the expected base signature.
 *
 * The implementation must satisfy this WITHOUT regressing the existing pill:
 * the doc-path label (`welcome.md`) must still be rendered alongside the new
 * provenance.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SourceCitation } from '../SourceCitation';
import type { CitationRef } from '../../types/chat';

/** CitationRef extended (in-test) with the pack identity fields issue #74
 *  adds; the renderer must surface them as pack provenance. */
interface PackCitationRef extends CitationRef {
  packId?: string;
  packVersion?: string;
}

describe('AC6 — citation pills show pack provenance (pack vX.Y.Z)', () => {
  it('renders `bundled-min v1.0.0` for a pack-sourced structured citation', () => {
    const citations: PackCitationRef[] = [
      {
        docId: 'packs/bundled-min/1.0.0/docs/welcome.json#chunk-0',
        chunkIndex: 0,
        source: 'docs/welcome.md',
        text: 'Welcome to the bundled training pack.',
        packId: 'bundled-min',
        packVersion: '1.0.0',
      },
    ];

    const { container } = render(<SourceCitation citations={citations} />);

    // The pill's visible text carries the pack id + version provenance.
    expect(container.textContent).toContain('bundled-min v1.0.0');

    // Preserving half of the contract: the doc-path label still renders.
    expect(container.textContent).toContain('welcome.md');
  });
});
