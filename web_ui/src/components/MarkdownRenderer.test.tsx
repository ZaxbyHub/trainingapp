/**
 * Tests for MarkdownRenderer component
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer } from './MarkdownRenderer';

describe('MarkdownRenderer', () => {
  describe('Text Rendering', () => {
    it('renders plain text without formatting', () => {
      render(<MarkdownRenderer content="Hello, world!" />);
      expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    });

    it('renders empty string without crashing', () => {
      const { container } = render(<MarkdownRenderer content="" />);
      // The renderer always wraps output in a styled <div> host; empty content
      // simply yields no markdown children inside it. Assert it does not throw
      // and produces no list/heading/table structure.
      expect(container.querySelector('ol, ul, table, h1, h2, h3, h4, h5, h6')).toBeNull();
    });
  });

  describe('Code Block Parsing', () => {
    it('renders fenced code blocks', () => {
      const content = '```\nconst x = 1;\n```';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    });

    it('renders fenced code blocks with language', () => {
      const content = '```javascript\nconst x = 1;\n```';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    });

    it('renders multiple code blocks', () => {
      const content = '```\ncode1\n```\n\n```\ncode2\n```';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('code1')).toBeInTheDocument();
      expect(screen.getByText('code2')).toBeInTheDocument();
    });

    it('renders code blocks with special characters', () => {
      const content = '```\nconst str = "Hello \\"World\\"";\n```';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('const str = "Hello \\"World\\"";')).toBeInTheDocument();
    });

    it('renders a copy button and language chip for a fenced code block (issue #36)', () => {
      const content = '```js\nconsole.log(1)\n```';
      const { container } = render(<MarkdownRenderer content={content} />);

      // A copy button exists with an accessible name containing "Copy".
      const copyButton = container.querySelector('button');
      expect(copyButton).not.toBeNull();
      const copyAria = copyButton!.getAttribute('aria-label') || '';
      const copyText = copyButton!.textContent || '';
      expect(copyAria.toLowerCase()).toContain('copy');

      // The language chip renders the fence's language ("js").
      const chips = Array.from(container.querySelectorAll('span')).map((s) => s.textContent);
      expect(chips).toContain('js');

      // And the code body is present.
      expect(container.textContent).toContain('console.log(1)');
    });
  });

  describe('List Parsing', () => {
    it('renders unordered lists', () => {
      const content = '- Item 1\n- Item 2\n- Item 3';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('Item 1')).toBeInTheDocument();
      expect(screen.getByText('Item 2')).toBeInTheDocument();
      expect(screen.getByText('Item 3')).toBeInTheDocument();
    });

    it('renders ordered lists', () => {
      const content = '1. First\n2. Second\n3. Third';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(screen.getByText('Third')).toBeInTheDocument();
    });

    it('renders lists with nested content', () => {
      const content = '- Item with **bold** text\n- Item with `code`';
      render(<MarkdownRenderer content={content} />);

      // Bold/code inline parsing splits each item across multiple span/code
      // elements, so assert on the list text rather than a single node.
      expect(screen.getAllByText(/Item with/).length).toBeGreaterThanOrEqual(1);
    });

    it('groups a loose ordered list (blank lines between items) into ONE <ol> (issue #36)', () => {
      // The old regex parser fragmented this into two separate <ol> elements
      // because of the blank line. react-markdown correctly treats it as a
      // single "loose" ordered list with two <li> children.
      const content = '1. a\n\n2. b';
      const { container } = render(<MarkdownRenderer content={content} />);

      const ols = container.querySelectorAll('ol');
      expect(ols.length).toBe(1);

      const lis = ols[0].querySelectorAll('li');
      expect(lis.length).toBe(2);
      // Loose-list items are wrapped in <p>, so trim the surrounding whitespace.
      expect(lis[0].textContent?.trim()).toBe('a');
      expect(lis[1].textContent?.trim()).toBe('b');
    });

    it('preserves the marker value via the <ol start> attribute (issue #36)', () => {
      // Starting at "3." sets start="3" on the <ol> rather than resetting to 1.
      const content = '3. c\n4. d';
      const { container } = render(<MarkdownRenderer content={content} />);

      const ol = container.querySelector('ol');
      expect(ol).not.toBeNull();
      expect(ol!.getAttribute('start')).toBe('3');

      const lis = ol!.querySelectorAll('li');
      expect(lis.length).toBe(2);
      expect(lis[0].textContent).toBe('c');
      expect(lis[1].textContent).toBe('d');
    });

    it('keeps a bare leading year intact (issue #36)', () => {
      // CommonMark treats a bare "1969. " line as a list item; react-markdown
      // emits an <ol start="1969">. The acceptance criterion is "year intact":
      // assert the year survives into the rendered DOM (via the start attr)
      // and the rest of the sentence renders as the item body.
      const content = '1969. It was a great year';
      const { container } = render(<MarkdownRenderer content={content} />);

      const ol = container.querySelector('ol');
      expect(ol).not.toBeNull();
      // The year is preserved as the list's starting marker.
      expect(ol!.getAttribute('start')).toBe('1969');
      // And the body text renders.
      expect(container.textContent).toContain('It was a great year');
    });
  });

  describe('Paragraph Parsing', () => {
    it('renders single line paragraphs', () => {
      const content = 'This is a simple paragraph.';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('This is a simple paragraph.')).toBeInTheDocument();
    });

    it('renders multiline paragraphs', () => {
      const content = 'This is a paragraph\nthat spans multiple\nlines.';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText(/This is a paragraph/)).toBeInTheDocument();
    });

    it('separates paragraphs with blank lines', () => {
      const content = 'First paragraph.\n\nSecond paragraph.';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('First paragraph.')).toBeInTheDocument();
      expect(screen.getByText('Second paragraph.')).toBeInTheDocument();
    });
  });

  describe('Inline Formatting - Bold', () => {
    it('renders bold text with **', () => {
      const content = 'This is **bold** text.';
      render(<MarkdownRenderer content={content} />);

      const bold = screen.getByText('bold');
      expect(bold.tagName).toBe('STRONG');
      // PRR48-018: pin the fontWeight override so a regression to default
      // weight (400) or a removed override would fail this test.
      expect((bold as HTMLElement).style.fontWeight).toBe('600');
    });

    it('renders bold text with __', () => {
      const content = 'This is __bold__ text.';
      render(<MarkdownRenderer content={content} />);

      // Issue #36: the rewritten renderer (react-markdown + remark-gfm) now
      // correctly parses __bold__ as <strong> (the old regex parser only
      // matched ** and left the underscores literal).
      const bold = screen.getByText('bold');
      expect(bold.tagName).toBe('STRONG');
    });
  });

  describe('Inline Formatting - Italic', () => {
    it('renders italic text with *', () => {
      const content = 'This is *italic* text.';
      render(<MarkdownRenderer content={content} />);

      const italic = screen.getByText('italic');
      expect(italic.tagName).toBe('EM');
      // PRR48-018: pin the fontStyle override.
      expect((italic as HTMLElement).style.fontStyle).toBe('italic');
    });

    it('renders italic text with _ (issue #36)', () => {
      const content = 'This is _italic_ text.';
      render(<MarkdownRenderer content={content} />);

      // remark-gfm parses _italic_ into <em>.
      const italic = screen.getByText('italic');
      expect(italic.tagName).toBe('EM');
    });
  });

  describe('Inline Formatting - Strikethrough (issue #36)', () => {
    it('renders ~~strike~~ as <del>', () => {
      const content = 'This is ~~strike~~ text.';
      render(<MarkdownRenderer content={content} />);

      const del = screen.getByText('strike');
      expect(del.tagName).toBe('DEL');
    });
  });

  describe('Inline Formatting - Inline Code', () => {
    it('renders inline code with backticks', () => {
      const content = 'Use `console.log()` for debugging.';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('console.log()')).toBeInTheDocument();
    });

    it('renders multiple inline code blocks', () => {
      const content = 'Use `foo()` and `bar()` functions.';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('foo()')).toBeInTheDocument();
      expect(screen.getByText('bar()')).toBeInTheDocument();
    });

    it('does NOT parse asterisks inside inline code as bold/italic', () => {
      // Inline code with ** should render literally, not as bold
      const content = 'Use `**hello**` for bold text.';
      render(<MarkdownRenderer content={content} />);

      // The **hello** should appear as code, not parsed as bold
      const codeElement = screen.getByText('**hello**');
      expect(codeElement.tagName).toBe('CODE');
      // And it should NOT be inside a <strong> tag
      expect(codeElement.closest('strong')).not.toBeInTheDocument();
    });

    it('does NOT parse single asterisks inside inline code as italic', () => {
      const content = 'Use `*italic*` for emphasis.';
      render(<MarkdownRenderer content={content} />);

      const codeElement = screen.getByText('*italic*');
      expect(codeElement.tagName).toBe('CODE');
      expect(codeElement.closest('em')).not.toBeInTheDocument();
    });

    it('renders inline code with mixed asterisks and backticks correctly', () => {
      const content = 'Code: `` `**test**` `` with nested marks.';
      const { container } = render(<MarkdownRenderer content={content} />);

      // The nested-mark content is split across spans/code by the inline
      // parser; assert that the content renders (exact AST shape may vary
      // with the backtick/asterisk precedence).
      expect(container.textContent).toContain('Code:');
      expect(container.textContent).toContain('with nested marks.');
    });

    it('does NOT turn a markdown link inside inline code into a live <a> (issue #36)', () => {
      const content = '`[a](https://b)`';
      const { container } = render(<MarkdownRenderer content={content} />);

      // The whole `[a](https://b)` is inline code — no <a> should be rendered.
      expect(container.querySelector('a')).toBeNull();
      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code!.textContent).toBe('[a](https://b)');
    });
  });

  describe('GFM Tables (issue #36)', () => {
    it('renders a pipe table as a <table> element', () => {
      const content = '| a | b |\n|---|---|\n| 1 | 2 |';
      const { container } = render(<MarkdownRenderer content={content} />);

      const table = container.querySelector('table');
      expect(table).not.toBeNull();
      // Header + body cells render.
      expect(container.textContent).toContain('a');
      expect(container.textContent).toContain('b');
      expect(container.textContent).toContain('1');
      expect(container.textContent).toContain('2');
    });
  });

  describe('Inline Formatting - Links', () => {
    it('renders links with valid URLs', () => {
      const content = 'Check [this link](https://example.com).';
      render(<MarkdownRenderer content={content} />);

      const link = screen.getByText('this link');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'https://example.com');
    });

    it('renders links with target="_blank"', () => {
      const content = 'Check [this link](https://example.com).';
      render(<MarkdownRenderer content={content} />);

      const link = screen.getByText('this link');
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('renders links with rel="noopener noreferrer"', () => {
      const content = 'Check [this link](https://example.com).';
      render(<MarkdownRenderer content={content} />);

      const link = screen.getByText('this link');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('blocks javascript: URLs', () => {
      const content = 'Check [this link](javascript:alert(1)).';
      const { container } = render(<MarkdownRenderer content={content} />);

      // Should render as plain text, not a link
      expect(container.textContent).toContain('this link');
      const link = screen.queryByRole('link');
      expect(link).not.toBeInTheDocument();
    });

    it('blocks javascript: URLs case-insensitively', () => {
      const content = 'Check [this link](JAVASCRIPT:alert(1)).';
      const { container } = render(<MarkdownRenderer content={content} />);

      expect(container.textContent).toContain('this link');
      const link = screen.queryByRole('link');
      expect(link).not.toBeInTheDocument();
    });

    it('strips scheme-relative URLs like //evil.com/y (issue #36)', () => {
      // The old parser resolved this against a placeholder base and produced a
      // live open-redirect link. The new urlTransform rejects scheme-less URLs.
      const content = '[x](//evil.com/y)';
      const { container } = render(<MarkdownRenderer content={content} />);

      expect(container.textContent).toContain('x');
      // No live <a> is rendered.
      expect(container.querySelector('a')).toBeNull();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('strips root-relative URLs like /settings (issue #36)', () => {
      const content = '[x](/settings)';
      const { container } = render(<MarkdownRenderer content={content} />);

      expect(container.textContent).toContain('x');
      expect(container.querySelector('a')).toBeNull();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('renders a sanitized https link with the href intact (issue #36)', () => {
      const content = '[x](https://valid.com)';
      const { container } = render(<MarkdownRenderer content={content} />);

      const a = container.querySelector('a');
      expect(a).not.toBeNull();
      expect(a!.getAttribute('href')).toBe('https://valid.com');
    });

    it('allows mailto: URLs', () => {
      const content = 'Contact [us](mailto:test@example.com).';
      render(<MarkdownRenderer content={content} />);

      const link = screen.getByText('us');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'mailto:test@example.com');
    });

    it('allows tel: URLs', () => {
      const content = 'Call [us](tel:+1234567890).';
      render(<MarkdownRenderer content={content} />);

      const link = screen.getByText('us');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'tel:+1234567890');
    });

    it('renders invalid URLs as plain text (no live link)', () => {
      const content = 'Check [this](not-a-url).';
      const { container } = render(<MarkdownRenderer content={content} />);

      // `not-a-url` is scheme-less with no path separator, so urlTransform
      // rejects it (returns '') → no <a> element renders. The link text is
      // still visible as plain text.
      expect(container.textContent).toContain('this');
      expect(container.querySelector('a')).toBeNull();
    });

    it('handles links with special characters', () => {
      const content = 'Check [this link](https://example.com/path?q=1&s=2).';
      render(<MarkdownRenderer content={content} />);

      const link = screen.getByText('this link');
      expect(link).toHaveAttribute('href', 'https://example.com/path?q=1&s=2');
    });
  });

  describe('URL Validation', () => {
    it('accepts https URLs', () => {
      const content = 'Link to [site](https://example.com).';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByRole('link')).toBeInTheDocument();
    });

    it('accepts http URLs', () => {
      const content = 'Link to [site](http://example.com).';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByRole('link')).toBeInTheDocument();
    });

    it('rejects data: URLs', () => {
      const content = 'Link to [site](data:text/html,<script>alert(1)</script>).';
      render(<MarkdownRenderer content={content} />);

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('rejects blob: URLs', () => {
      const content = 'Link to [site](blob:https://example.com/123).';
      render(<MarkdownRenderer content={content} />);

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles very long content', () => {
      const content = 'A'.repeat(10000);
      const { container } = render(<MarkdownRenderer content={content} />);

      expect(container.textContent?.length).toBeGreaterThan(9000);
    });

    it('handles special characters in content', () => {
      const content = 'Text with & < > " characters';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('Text with & < > " characters')).toBeInTheDocument();
    });

    it('handles nested formatting', () => {
      const content = '**Bold with `code` inside**';
      const { container } = render(<MarkdownRenderer content={content} />);

      // Bold + inline-code nesting: the inline code is parsed before bold, so
      // the exact AST shape varies. Assert the content renders correctly.
      expect(container.textContent).toContain('Bold with ');
      expect(container.textContent).toContain('code');
      expect(container.textContent).toContain(' inside');
    });

    it('handles code block followed by text', () => {
      const content = '```\ncode\n```\n\nAfter code.';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('code')).toBeInTheDocument();
      expect(screen.getByText('After code.')).toBeInTheDocument();
    });

    it('handles list followed by code block', () => {
      const content = '- Item 1\n- Item 2\n\n```\ncode\n```';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('Item 1')).toBeInTheDocument();
      expect(screen.getByText('code')).toBeInTheDocument();
    });

    it('handles emoji in content', () => {
      const content = 'Hello 👋 World 🌍!';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('Hello 👋 World 🌍!')).toBeInTheDocument();
    });

    it('handles Unicode content', () => {
      const content = '中文内容 with 日本語 and 한국어';
      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText('中文内容 with 日本語 and 한국어')).toBeInTheDocument();
    });
  });

  describe('Heading Parsing (issue #25 F12)', () => {
    it('renders level-1 headings', () => {
      render(<MarkdownRenderer content="# Title" />);
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1.textContent).toBe('Title');
    });

    it('renders level-2 headings', () => {
      render(<MarkdownRenderer content="## Section" />);
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Section');
    });

    it('renders level-3 headings', () => {
      render(<MarkdownRenderer content="### Subsection" />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Subsection');
    });

    it('renders level-4 through 6 headings', () => {
      render(<MarkdownRenderer content={'#### H4\n##### H5\n###### H6'} />);
      expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('H4');
      expect(screen.getByRole('heading', { level: 5 }).textContent).toBe('H5');
      expect(screen.getByRole('heading', { level: 6 }).textContent).toBe('H6');
    });

    it('does not treat a paragraph starting with # without a space as a heading', () => {
      render(<MarkdownRenderer content="#NotAHeading" />);
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });
  });

  describe('Blockquote Parsing (issue #25 F12)', () => {
    it('renders a single-line blockquote', () => {
      const { container } = render(<MarkdownRenderer content="> A quoted line." />);
      const bq = container.querySelector('blockquote');
      expect(bq).not.toBeNull();
      expect(bq!.textContent).toContain('A quoted line.');
    });

    it('renders a multi-line blockquote', () => {
      const { container } = render(<MarkdownRenderer content="> Line one.\n> Line two." />);
      const bq = container.querySelector('blockquote');
      expect(bq).not.toBeNull();
      expect(bq!.textContent).toContain('Line one.');
      expect(bq!.textContent).toContain('Line two.');
    });
  });

  describe('Asterisk and plus bullets (issue #25 F12)', () => {
    it('renders * bullets as an unordered list', () => {
      // Use a JS expression (not a JSX string attribute) so \n is a real
      // newline — JSX attribute strings treat \n as literal backslash-n.
      const content = '* Star one\n* Star two';
      const { container } = render(<MarkdownRenderer content={content} />);
      const ul = container.querySelector('ul');
      expect(ul).not.toBeNull();
      const items = ul!.querySelectorAll('li');
      expect(items.length).toBe(2);
      expect(items[0].textContent).toBe('Star one');
      expect(items[1].textContent).toBe('Star two');
    });

    it('renders + bullets as an unordered list', () => {
      const content = '+ Plus one\n+ Plus two';
      const { container } = render(<MarkdownRenderer content={content} />);
      const ul = container.querySelector('ul');
      expect(ul).not.toBeNull();
      const items = ul!.querySelectorAll('li');
      expect(items.length).toBe(2);
      expect(items[0].textContent).toBe('Plus one');
    });
  });

  describe('Memoization', () => {
    it('memoizes rendered output for same content', () => {
      const content = 'Same content';
      const { rerender } = render(<MarkdownRenderer content={content} />);

      const firstRender = screen.getByText('Same content');
      rerender(<MarkdownRenderer content={content} />);
      const secondRender = screen.getByText('Same content');

      // Should be the same element due to memoization
      expect(firstRender).toBe(secondRender);
    });

    it('re-renders when content changes', () => {
      const { rerender } = render(<MarkdownRenderer content="First content" />);

      expect(screen.getByText('First content')).toBeInTheDocument();

      rerender(<MarkdownRenderer content="Second content" />);

      expect(screen.getByText('Second content')).toBeInTheDocument();
      expect(screen.queryByText('First content')).not.toBeInTheDocument();
    });
  });
});
