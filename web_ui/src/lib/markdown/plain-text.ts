/**
 * Deterministic markdown → plain-text rendition for the chat Copy affordance
 * (#35 residual C4, trace 35-residuals-chat-ux).
 *
 * The transformation contract is pinned by the frozen check
 * `web_ui/src/components/copy-affordances-35.test.tsx` (c1-plaintext-copy):
 *   - a heading contributes its text without the `#` marker;
 *   - emphasis/strong/inline code contribute their inner text;
 *   - a link contributes its anchor text only;
 *   - a fenced code block contributes its code lines verbatim, without the
 *     fences and without the language tag;
 *   - a table contributes one line per row with the cell texts joined by a
 *     single space (no pipes, no separator row);
 *   - list items contribute their text, one per line, without the `- `
 *     marker;
 *   - blocks are separated by a single blank line.
 *
 * Implementation (PR #259 review round): the transform parses the source with
 * the SAME remark pipeline the renderer uses (unified + remark-parse +
 * remark-gfm — the identical parser behind react-markdown), then walks the
 * resulting mdast. Walking the shared parse tree means the copy payload is
 * faithful to what the renderer shows by construction: CommonMark flanking
 * rules decide what is emphasis (intraword underscores and space-delimited
 * asterisks survive verbatim), all GFM shapes the renderer supports (ordered
 * lists, blockquotes, strikethrough, task lists, autolinks, tilde fences,
 * pipe-less tables) are modeled, and cost is a single linear parse — no
 * regex backtracking over untrusted model output.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Content, List, PhrasingContent, Table } from 'mdast';

const processor = unified().use(remarkParse).use(remarkGfm);

/** Inline/phrasing content → text per the pinned contract: emphasis, strong,
 *  strikethrough and links contribute their inner text; inline code its
 *  literal value; images their alt text; hard breaks a newline. */
function phrasingText(nodes: PhrasingContent[] | undefined): string {
  if (!nodes || nodes.length === 0) return '';
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
        out += node.value;
        break;
      case 'break':
        out += '\n';
        break;
      case 'emphasis':
      case 'strong':
      case 'delete':
      case 'link':
        out += phrasingText(node.children);
        break;
      case 'image':
        out += node.alt ?? '';
        break;
      default: {
        // Other phrasing nodes (footnote references, html, etc.): contribute
        // any literal value they carry, mirroring what the renderer escapes
        // and shows as text.
        const value = (node as { value?: unknown }).value;
        if (typeof value === 'string') {
          out += value;
        } else if ('children' in node) {
          out += phrasingText((node as { children: PhrasingContent[] }).children);
        }
      }
    }
  }
  return out;
}

/** A list's items flattened to lines; nested lists recurse into the same
 *  block, one line per leaf paragraph. */
function listLines(list: List): string[] {
  const lines: string[] = [];
  for (const item of list.children) {
    for (const child of item.children) {
      if (child.type === 'list') {
        lines.push(...listLines(child));
      } else {
        const text = blockText(child as Content);
        if (text !== null && text !== '') {
          lines.push(...text.split('\n'));
        }
      }
    }
  }
  return lines;
}

/** One block-level node → its text block (multiple lines allowed), or null
 *  when the node contributes nothing to the payload. */
function blockText(node: Content): string | null {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
      return phrasingText(node.children);
    case 'code':
      // Code contributes its lines verbatim (no fences, no language tag).
      return node.value.replace(/\n+$/, '');
    case 'table': {
      const table: Table = node;
      return table.children
        .map((row) => row.children.map((cell) => phrasingText(cell.children)).join(' '))
        .join('\n');
    }
    case 'list': {
      const lines = listLines(node as List);
      return lines.length > 0 ? lines.join('\n') : null;
    }
    case 'blockquote':
      // The quoted blocks render as a visually distinct group; contribute
      // them as their own block(s).
      return node.children
        .map((child) => blockText(child))
        .filter((text: string | null): text is string => text !== null)
        .join('\n\n');
    case 'html':
      // The renderer escapes raw HTML and shows it as text; contribute it.
      return node.value.replace(/\n+$/, '');
    default:
      // Definitions, YAML front matter, footnotes' definitions, thematic
      // breaks: nothing user-visible to copy.
      return null;
  }
}

/**
 * Render the plain-text rendition of a markdown source string per the pinned
 * contract above. Identical input always yields identical output.
 */
export function markdownToPlainText(md: string): string {
  const root = processor.parse(md) as import('mdast').Root;
  const blocks = root.children
    .map((child) => blockText(child))
    .filter((text): text is string => text !== null && text !== '');
  return blocks.join('\n\n');
}
