/**
 * Document row layout constants shared by DocumentList (virtualization),
 * pages/documents.css (the matching `@container` rule) and the reflow specs.
 * Pure module (no CSS or React import) so a Playwright spec can import it.
 *
 * The table / stacked switch follows the width of the document TABLE (its
 * container), not the viewport: the sidebar takes 64px (rail) or 260px
 * (expanded) of the viewport, so the viewport width says little about the room
 * a row really has.
 */

/**
 * Options of the uploaded-at date shown in every row (DocumentList's `formatDate`).
 * Shared so the reflow spec renders the real format in several locales: the date's
 * length is locale dependent (a German or Finnish date is far longer than the
 * en-US one), and the fixed row heights below must hold for the longest.
 */
export const DOC_DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** Wide (table) row height; the `.app-doc` height in pages/documents.css. */
export const ITEM_HEIGHT = 60;

/** Stacked (wrapped) row height; the `.app-doc` height inside the `@container`
 *  rule in pages/documents.css. */
export const STACKED_ITEM_HEIGHT = 112;

/**
 * Stacked layout applies when the table's content width is AT OR BELOW this
 * many CSS px (`@container (max-width: 800px)`). The wide row needs 632px of
 * fixed tracks, gaps and padding (36 + 88 + 96 + 288 + 32 + 5 x 12 + 2 x 16)
 * plus room for a readable name column; 800px leaves the name ~165px.
 */
export const STACKED_MAX_WIDTH = 800;
