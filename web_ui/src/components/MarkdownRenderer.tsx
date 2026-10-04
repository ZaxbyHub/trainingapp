/**
 * Markdown renderer built on react-markdown + remark-gfm.
 *
 * Replaces the prior hand-rolled regex parser (which fragmented loose ordered
 * lists, discarded marker values, and could not represent tables/strike/task
 * lists/nested emphasis). react-markdown + remark-gfm are pure-JS, ESM, and
 * air-gap-safe (no runtime fetches), so the offline packaging guarantee is
 * preserved. No `rehype-raw` is used, so raw HTML in model output stays
 * escaped — the zero-HTML-injection property is preserved.
 *
 * Issue #36 Part 1: A1, N2, N3, A2, A3, A4, A5, A6, A8, N9, N10, N11, N12.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../ui';
import { cx } from '../ui/cx';
import '../pages/chat.css';

/** Schemes allowed in rendered links. Everything else (javascript:, data:,
 *  blob:, file:, …) is stripped. N10 additionally rejects scheme-less URLs
 *  (relative + scheme-relative like //evil.com/x and /settings). */
const ALLOWED_SCHEMES = /^(https?|mailto|tel):$/i;

/**
 * react-markdown v9 `urlTransform`. Return the URL to keep it, or '' to strip
 * it (rendering the link text without an href). N10: reject scheme-less URLs
 * (which previously resolved against a placeholder base and became live links)
 * and non-allowlisted schemes.
 */
function allowlistUrlTransform(url: string): string {
  // Reject protocol-relative (//host) and root-relative (/path) and relative
  // (path) URLs up front — they have no explicit allowlisted scheme.
  if (url.startsWith('//') || url.startsWith('/') || !url.includes(':')) {
    // Allow bare fragment links (#section) — they are same-document anchors.
    if (url.startsWith('#')) return url;
    return '';
  }
  try {
    const parsed = new URL(url);
    return ALLOWED_SCHEMES.test(parsed.protocol) ? url : '';
  } catch {
    // Not an absolute URL with a parseable scheme — reject.
    return '';
  }
}

interface CodeBlockProps {
  language: string;
  code: string;
}

/** A8: fenced code block with a language chip + per-block copy button.
 *  Reuses the copy pattern from ChatMessageBubble. */
const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1500);
    } catch {
      console.warn('[MarkdownRenderer] Clipboard write failed');
    }
  }, [code]);

  return (
    <div className="chat-md__codeblock">
      <div className="chat-md__codehead">
        <span>{language || 'code'}</span>
        <Button
          variant="ghost"
          size="sm"
          className="chat-md__copy"
          onClick={handleCopy}
          aria-label={copied ? 'Copied code to clipboard' : 'Copy code to clipboard'}
        >
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <pre className="chat-md__pre">
        <code>{code}</code>
      </pre>
    </div>
  );
};

interface MarkdownRendererProps {
  content: string;
  /** A6: when true, throttle re-parsing to at most once per ~100ms so a fast
   *  token stream does not re-parse on every flush. The final content is
   *  always parsed when streaming ends. */
  isStreaming?: boolean;
}

const PARSE_THROTTLE_MS = 100;

/**
 * MarkdownRenderer. Memoized on `content` + `isStreaming`. While streaming,
 * the internal parse is throttled (A6) so remark is not re-run on every token
 * flush; the last-throttled content is always parsed once streaming settles.
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({ content, isStreaming }) => {
  // A6: throttle the source we hand to ReactMarkdown while streaming. We track
  // the latest content in a ref and a "rendered content" state that we update
  // on a timer during streaming, or immediately when not streaming.
  const latestContentRef = useRef(content);
  latestContentRef.current = content;
  const [renderedContent, setRenderedContent] = useState(content);
  const lastParseTsRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      // Not streaming — always render the final content immediately, and clear
      // any pending throttled parse.
      if (throttleTimerRef.current !== null) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      setRenderedContent(content);
      return;
    }

    // Streaming: parse at most once per PARSE_THROTTLE_MS. Schedule a deferred
    // parse that always runs against the LATEST content (reads the ref), so we
    // never lose the tail.
    const now = Date.now();
    const elapsed = now - lastParseTsRef.current;
    if (elapsed >= PARSE_THROTTLE_MS) {
      lastParseTsRef.current = now;
      setRenderedContent(latestContentRef.current);
    } else if (throttleTimerRef.current === null) {
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        lastParseTsRef.current = Date.now();
        setRenderedContent(latestContentRef.current);
      }, PARSE_THROTTLE_MS - elapsed);
    }
  }, [content, isStreaming]);

  // Clean up the throttle timer on unmount.
  useEffect(() => () => {
    if (throttleTimerRef.current !== null) clearTimeout(throttleTimerRef.current);
  }, []);

  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={allowlistUrlTransform}
        components={{
          // react-markdown v9: no `inline` prop. Distinguish inline vs block
          // code by the presence of a `language-*` className (block fences
          // carry it; inline code does not). (Critic M1)
          code({ className, children, ...rest }) {
            const match = /language-(\w+)/.exec(className || '');
            const text = String(children).replace(/\n$/, '');
            if (match) {
              return <CodeBlock language={match[1]} code={text} />;
            }
            // Inline code (no language class) — but react-markdown v9 renders
            // indented/fenced code WITHOUT a language as a <code> inside <pre>
            // too. Detect block vs inline via the `node` position: a block code
            // has a `position` spanning a line. We fall back to inline styling
            // when there's no language and no newline (typical inline case).
            const isBlock = text.includes('\n');
            if (isBlock) {
              return <CodeBlock language="" code={text} />;
            }
            return (
              <code
                className="chat-md__code"
                {...rest}
              >
                {children}
              </code>
            );
          },
          a({ href, children, ...rest }) {
            // href is already sanitized by urlTransform (allowlist). Links
            // that were rejected have href === '' → render as plain text.
            if (!href) {
              return <>{children}</>;
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="chat-md__link"
                {...rest}
              >
                {children}
              </a>
            );
          },
          table({ children, ...rest }) {
            return (
              <div className="chat-md__tablewrap">
                <table
                  className="chat-md__table"
                  {...rest}
                >
                  {children}
                </table>
              </div>
            );
          },
          th({ children, ...rest }) {
            return (
              <th
                className="chat-md__th"
                {...rest}
              >
                {children}
              </th>
            );
          },
          td({ children, ...rest }) {
            return (
              <td
                className="chat-md__td"
                {...rest}
              >
                {children}
              </td>
            );
          },
          blockquote({ children, ...rest }) {
            return (
              <blockquote
                className="chat-md__quote"
                {...rest}
              >
                {children}
              </blockquote>
            );
          },
          hr({ ...rest }) {
            return (
              <hr
                className="chat-md__hr"
                {...rest}
              />
            );
          },
          ul({ children, ...rest }) {
            return (
              <ul {...rest} className={cx('chat-md__list', rest.className)}>
                {children}
              </ul>
            );
          },
          ol({ children, ...rest }) {
            return (
              <ol {...rest} className={cx('chat-md__list', rest.className)}>
                {children}
              </ol>
            );
          },
          li({ children, ...rest }) {
            return (
              <li {...rest} className={cx('chat-md__li', rest.className)}>
                {children}
              </li>
            );
          },
          p({ children, ...rest }) {
            return (
              <p className="chat-md__p" {...rest}>
                {children}
              </p>
            );
          },
          h1: (props) => <Heading level={1} {...props} />,
          h2: (props) => <Heading level={2} {...props} />,
          h3: (props) => <Heading level={3} {...props} />,
          h4: (props) => <Heading level={4} {...props} />,
          h5: (props) => <Heading level={5} {...props} />,
          h6: (props) => <Heading level={6} {...props} />,
        }}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
});

/** Heading levels map onto the Lumen type scale in pages/chat.css (.chat-md__h1..h6). */
const Heading: React.FC<{ level: 1 | 2 | 3 | 4 | 5 | 6; children?: React.ReactNode }> = ({ level, children }) => {
  const Tag = (`h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
  return <Tag className={`chat-md__h chat-md__h${level}`}>{children}</Tag>;
};

MarkdownRenderer.displayName = 'MarkdownRenderer';

export default MarkdownRenderer;
