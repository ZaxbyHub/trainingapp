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
 * Line-based by design: the renderer pipeline (react-markdown) owns the rich
 * rendering; this util only needs the copy payload, so it must be
 * deterministic, dependency-free, and identical for identical input.
 */

/** Strip inline markdown shapes (emphasis/strong/inline code/links/images).
 *  Order matters: images and links first (their inner text may itself carry
 *  emphasis), then strong, then emphasis, then inline code. */
function stripInline(md: string): string {
  let out = md;
  // Images: ![alt](url) → alt (the alt text is the content a reader keeps).
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: [text](url) → text.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Strong: **text** / __text__ → text.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  // Emphasis: *text* / _text_ → text (single-character delimiters).
  out = out.replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1');
  // Inline code: `code` → code (after emphasis so backtected underscores
  // that survived the emphasis pass still unwrap their backticks).
  out = out.replace(/`([^`]+)`/g, '$1');
  return out;
}

/** True when a table row is a separator row (`| --- | :---: |` shapes). */
function isTableSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * Render the plain-text rendition of a markdown source string per the pinned
 * contract above. Identical input always yields identical output.
 */
export function markdownToPlainText(md: string): string {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  // Table rows are consecutive lines of ONE block (no blank lines between
  // rows), so a row only starts a new block when it does not immediately
  // follow another row.
  let lastWasTableRow = false;

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    // Fenced code: toggle on a fence delimiter; inside, lines are verbatim.
    if (/^\s*```/.test(line)) {
      if (inFence) {
        inFence = false;
        flush();
      } else {
        flush();
        inFence = true;
      }
      lastWasTableRow = false;
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    // Headings: drop the marker, keep the text.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      current.push(stripInline(heading[2]));
      lastWasTableRow = false;
      continue;
    }
    // Table rows: cells joined by a single space; separator rows dropped.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => stripInline(c.trim()));
      if (isTableSeparatorRow(cells)) {
        continue; // separator row contributes nothing
      }
      // A new table starts a fresh block; consecutive rows join the same one.
      if (!lastWasTableRow) {
        flush();
      }
      current.push(cells.join(' '));
      lastWasTableRow = true;
      continue;
    }
    lastWasTableRow = false;
    // Unordered list items: drop the `- ` marker.
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem) {
      current.push(stripInline(listItem[1]));
      continue;
    }
    // Blank line: block boundary.
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(stripInline(line));
  }
  flush();

  return blocks.join('\n\n');
}
