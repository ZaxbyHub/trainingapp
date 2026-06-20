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
  | { kind: 'orderedList'; items: string[] };

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

    // Unordered list
    if (/^-\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      blocks.push({ kind: 'unorderedList', items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'orderedList', items });
      continue;
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect until empty line or block start
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !/^-\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
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
