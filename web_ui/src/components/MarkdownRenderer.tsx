/**
 * Lightweight inline markdown renderer.
 * Supports common patterns found in LLM output.
 * NO external dependencies.
 */

import React, { useMemo } from 'react';

interface ParsedSegment {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link';
  content: string;
  url?: string;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    return /^(https?|mailto|tel):$/i.test(parsed.protocol);
  } catch {
    return false;
  }
}

function parseInlineCodes(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const regex = /`([^`]+)`/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', content: match[1] });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

function parseInlinePatterns(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const regex = /(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const boldMatch = match[1];
    const italicMatch = match[2];

    if (boldMatch) {
      segments.push({ type: 'bold', content: boldMatch.slice(2, -2) });
    } else if (italicMatch) {
      segments.push({ type: 'italic', content: italicMatch.slice(1, -1) });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

function parseLinks(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    const url = match[2];
    if (isValidUrl(url)) {
      segments.push({ type: 'link', content: match[1], url });
    } else {
      segments.push({ type: 'text', content: `[${match[1]}](${url})` });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

function renderInlineContent(text: string): React.ReactNode[] {
  const linkSegments = parseLinks(text);

  return linkSegments.flatMap((segment, idx) => {
    if (segment.type === 'link') {
      return (
        <a
          key={`link-${idx}`}
          href={segment.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}
        >
          {segment.content}
        </a>
      );
    }

    // Parse inline code BEFORE bold/italic so backtick-delimited spans are protected
    const codeSegments = parseInlineCodes(segment.content);

    return codeSegments.map((cSegment, cIdx) => {
      if (cSegment.type === 'code') {
        return (
          <code
            key={`code-${idx}-${cIdx}`}
            style={{
              backgroundColor: 'var(--color-bubble-system)',
              padding: '1px 4px',
              borderRadius: '3px',
              fontFamily: 'monospace',
              fontSize: '0.95em',
            }}
          >
            {cSegment.content}
          </code>
        );
      }

      // Parse bold/italic on remaining text segments
      const patternSegments = parseInlinePatterns(cSegment.content);

      return patternSegments.map((pSegment, pIdx) => {
        if (pSegment.type === 'bold') {
          return <strong key={`bold-${idx}-${cIdx}-${pIdx}`}>{pSegment.content}</strong>;
        }
        if (pSegment.type === 'italic') {
          return <em key={`italic-${idx}-${cIdx}-${pIdx}`}>{pSegment.content}</em>;
        }
        return <span key={`text-${idx}-${cIdx}-${pIdx}`}>{pSegment.content}</span>;
      });
    });
  });
}

type BlockType =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'codeBlock'; language: string; content: string }
  | { kind: 'unorderedList'; items: string[] }
  | { kind: 'orderedList'; items: string[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'blockquote'; lines: string[] };

// Detects ATX headings (# .. ######), unordered lists (-, *, +), ordered
// lists (digit + .), and blockquotes (>), plus fenced code. Anything else
// falls through to a paragraph.
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UNORDERED_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+\.\s+/;
const BLOCKQUOTE_RE = /^>\s?/;

function isListMarker(line: string): boolean {
  return UNORDERED_RE.test(line.trim()) || ORDERED_RE.test(line.trim());
}

function parseBlocks(text: string): BlockType[] {
  const lines = text.split('\n');
  const blocks: BlockType[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing ```
      if (i < lines.length) i++;
      blocks.push({ kind: 'codeBlock', language, content: codeLines.join('\n') });
      continue;
    }

    // Heading (ATX): # .. ######
    const headingMatch = HEADING_RE.exec(line.trim());
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, text: headingMatch[2].trim() });
      i++;
      continue;
    }

    // Unordered list (accepts -, *, and + bullets)
    if (UNORDERED_RE.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && UNORDERED_RE.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(UNORDERED_RE, ''));
        i++;
      }
      blocks.push({ kind: 'unorderedList', items });
      continue;
    }

    // Ordered list
    if (ORDERED_RE.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && ORDERED_RE.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(ORDERED_RE, ''));
        i++;
      }
      blocks.push({ kind: 'orderedList', items });
      continue;
    }

    // Blockquote
    if (BLOCKQUOTE_RE.test(line.trim())) {
      const quoteLines: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(BLOCKQUOTE_RE, ''));
        i++;
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines });
      continue;
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect until empty line or another block start
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !HEADING_RE.test(lines[i].trim()) &&
      !isListMarker(lines[i].trim()) &&
      !BLOCKQUOTE_RE.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paraLines });
    }
  }

  return blocks;
}

function parseMarkdown(text: string): React.ReactNode[] {
  const blocks = parseBlocks(text);
  const result: React.ReactNode[] = [];

  blocks.forEach((block, i) => {
    switch (block.kind) {
      case 'heading': {
        // Map heading levels to the existing font-size tokens (display/h1/h2/h3)
        // and fall back to body size for levels 4-6.
        const headingStyles: Record<number, React.CSSProperties> = {
          1: { fontSize: 'var(--font-size-display)', marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)' },
          2: { fontSize: 'var(--font-size-h1)', marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)' },
          3: { fontSize: 'var(--font-size-h2)', marginTop: 'var(--spacing-md)', marginBottom: 'var(--spacing-xs)' },
          4: { fontSize: 'var(--font-size-h3)', marginTop: 'var(--spacing-md)', marginBottom: 'var(--spacing-xs)' },
          5: { fontSize: 'var(--font-size-body)', marginTop: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' },
          6: { fontSize: 'var(--font-size-caption)', marginTop: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' },
        };
        const sharedHeadingStyle: React.CSSProperties = {
          fontWeight: 600,
          fontFamily: 'var(--font-family)',
          color: 'var(--color-text-primary)',
          lineHeight: 'var(--line-height-tight)',
        };
        const Tag = (`h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
        result.push(
          <Tag key={`h-${i}`} style={{ ...sharedHeadingStyle, ...headingStyles[block.level] }}>
            {renderInlineContent(block.text)}
          </Tag>
        );
        break;
      }

      case 'blockquote': {
        result.push(
          <blockquote
            key={`bq-${i}`}
            style={{
              margin: 'var(--spacing-sm) 0',
              paddingLeft: 'var(--spacing-md)',
              borderLeft: `3px solid var(--color-secondary)`,
              color: 'var(--color-text-muted)',
              fontStyle: 'italic',
            }}
          >
            {block.lines.flatMap((line, j) => [
              ...renderInlineContent(line),
              j < block.lines.length - 1 ? <br key={`bqbr-${i}-${j}`} /> : null,
            ]).filter(Boolean)}
          </blockquote>
        );
        break;
      }

      case 'codeBlock':
        result.push(
          <pre
            key={`code-${i}`}
            style={{
              backgroundColor: 'var(--color-bubble-system)',
              padding: 'var(--spacing-md)',
              borderRadius: '6px',
              overflowX: 'auto',
              fontFamily: 'monospace',
              fontSize: 'var(--font-size-body)',
              margin: 'var(--spacing-sm) 0',
            }}
          >
            <code>{block.content}</code>
          </pre>
        );
        break;

      case 'unorderedList':
        result.push(
          <ul
            key={`ul-${i}`}
            style={{ margin: 'var(--spacing-sm) 0', paddingLeft: 'var(--spacing-xl)' }}
          >
            {block.items.map((item, j) => (
              <li key={`uli-${i}-${j}`} style={{ marginBottom: 'var(--spacing-xs)' }}>
                {renderInlineContent(item)}
              </li>
            ))}
          </ul>
        );
        break;

      case 'orderedList':
        result.push(
          <ol
            key={`ol-${i}`}
            style={{ margin: 'var(--spacing-sm) 0', paddingLeft: 'var(--spacing-xl)' }}
          >
            {block.items.map((item, j) => (
              <li key={`oli-${i}-${j}`} style={{ marginBottom: 'var(--spacing-xs)' }}>
                {renderInlineContent(item)}
              </li>
            ))}
          </ol>
        );
        break;

      case 'paragraph':
        if (block.lines.length === 1) {
          result.push(
            <p key={`p-${i}`} style={{ margin: 'var(--spacing-sm) 0' }}>
              {renderInlineContent(block.lines[0])}
            </p>
          );
        } else {
          result.push(
            <p key={`p-${i}`} style={{ margin: 'var(--spacing-sm) 0' }}>
              {block.lines.flatMap((line, j) => [
                ...renderInlineContent(line),
                j < block.lines.length - 1 ? <br key={`br-${i}-${j}`} /> : null,
              ]).filter(Boolean)}
            </p>
          );
        }
        break;
    }
  });

  return result;
}

export const MarkdownRenderer: React.FC<{ content: string }> = React.memo(({ content }) => {
  const rendered = useMemo(() => parseMarkdown(content), [content]);

  return <>{rendered}</>;
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
