/**
 * Escape routing for open overlays (PRR-151-038).
 *
 * Every open Dialog registers here. One document-level keydown listener in the CAPTURE
 * phase sees Escape before any bubble-phase listener and before every capture listener
 * registered after it on document or below (html, body, React's root and portal
 * containers). It routes Escape to the TOPMOST registered overlay only:
 *
 * - Target outside that overlay's panel (focus on <body>, on a toast, in the page behind,
 *   in a lower dialog): the overlay owns the key. The event is stopped right here
 *   (stopImmediatePropagation, so nothing behind sees it), and the overlay closes, or, if
 *   it is not dismissible, the key is swallowed (preventDefault). This is what the old
 *   panel-scoped handler could not do: it died as soon as focus left the panel.
 * - Target inside that overlay's panel: widgets inside get first say (a Combobox closes
 *   its list, a Tooltip hides, an IME cancels a composition). React dispatches to them
 *   from its root / portal container, which sits BELOW document, so a capture listener
 *   cannot know yet whether they will consume the key. The event is only marked as routed
 *   here, and the decision is taken by `settleEscape`, called from the panel's own
 *   onKeyDown (React bubble phase, after the widgets inside). If a widget stops
 *   propagation, the panel never sees the event and the overlay stays open.
 *
 * Topmost: the boot layer first, otherwise the last panel in document order (portals
 * append on open; a contained dialog renders in place, so one nested in an open dialog's
 * panel comes after it and one in page content comes before every portal).
 *
 * Who claims Escape from outside its panel: modal overlays, and dismissible non-modal
 * ones. A non-modal, non-dismissible overlay (the chat-page model gates) leaves the rest
 * of the page operable, so Escape there (the shell nav drawer, sidebar search) is not its
 * business: it only swallows Escape from inside its own panel, as before. The walk then
 * continues to the overlay below it.
 *
 * Not covered: capture listeners on window, or on document registered before the first
 * overlay opened, run before this one (none handle Escape in this app). For a target
 * inside the panel, native listeners between the panel and React's container (and capture
 * listeners on its ancestors) see the event before the panel settles it; the app has none.
 */

/** Backdrop modifier of the boot gate (ui/Overlays.tsx): it outranks document order. */
const BOOT_BACKDROP = 'ui-dialog__backdrop--boot';

/**
 * An expanded combobox owns Escape: by the WAI-ARIA combobox pattern focus stays in it
 * and Escape closes its popup, so a dialog around it must not close on the same key.
 * A popup BUTTON (`aria-haspopup` + `aria-expanded="true"`) is deliberately not an owner:
 * the menu-button pattern moves focus into the open menu, so focus still on the button
 * means the menu may well ignore Escape, and deferring to it made Escape a dead key. A
 * popup that does handle Escape says so by calling preventDefault (or by stopping
 * propagation, so the dialog never sees the key).
 */
const ESCAPE_OWNER = '[role="combobox"][aria-expanded="true"]';

export interface OverlayEntry {
  /** The overlay's panel (role="dialog"). */
  readonly panel: HTMLElement;
  /** Read at event time (props can change while the overlay is open). */
  isModal(): boolean;
  isDismissible(): boolean;
  /** Dismiss the overlay (Dialog: its onClose). */
  close(): void;
}

const entries = new Set<OverlayEntry>();
/** Escape events whose target was inside the topmost claiming panel, awaiting `settleEscape`. */
const routed = new WeakMap<Event, OverlayEntry>();

function rank(panel: HTMLElement): number {
  return panel.parentElement?.classList.contains(BOOT_BACKDROP) ? 1 : 0;
}

/** Panels ordered topmost first: the boot layer, then later in document order. */
export function stackOrder(panels: readonly HTMLElement[]): HTMLElement[] {
  return [...panels].sort((a, b) => {
    const byRank = rank(b) - rank(a);
    if (byRank !== 0) return byRank;
    // b before a in the document: a is above (comes first).
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? -1 : 1;
  });
}

function onEscapeCapture(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const target = e.target instanceof Node ? e.target : null;
  // A panel already removed from the DOM (its cleanup has not run yet) is skipped.
  const live = Array.from(entries).filter((entry) => entry.panel.isConnected);
  const byPanel = new Map(live.map((entry) => [entry.panel, entry]));
  for (const panel of stackOrder(live.map((entry) => entry.panel))) {
    const entry = byPanel.get(panel) as OverlayEntry;
    if (target !== null && panel.contains(target)) {
      routed.set(e, entry);
      return;
    }
    if (!entry.isModal() && !entry.isDismissible()) continue;
    e.stopImmediatePropagation();
    if (!entry.isDismissible()) {
      e.preventDefault();
      return;
    }
    if (!e.isComposing) entry.close();
    return;
  }
}

/**
 * Register an open overlay. Returns its unregister function (call it on close and on
 * unmount; a fresh entry per open, so StrictMode's mount / unmount / mount stays balanced).
 * The capture listener exists only while at least one overlay is registered.
 */
export function registerOverlay(entry: OverlayEntry): () => void {
  entries.add(entry);
  if (entries.size === 1) document.addEventListener('keydown', onEscapeCapture, true);
  return () => {
    if (!entries.delete(entry)) return;
    if (entries.size === 0) document.removeEventListener('keydown', onEscapeCapture, true);
  };
}

/**
 * Decide an Escape that reached `panel`'s own keydown handler (React bubble phase, after
 * the widgets inside). Acts only on an event the capture listener routed to this panel.
 * The caller stops propagation itself, so the key never reaches content behind.
 */
export function settleEscape(panel: HTMLElement | null, e: KeyboardEvent): void {
  const entry = routed.get(e);
  if (entry === undefined || entry.panel !== panel) return;
  routed.delete(e);
  if (!entry.isDismissible()) {
    e.preventDefault();
    return;
  }
  const target = e.target instanceof Element ? e.target : null;
  if (e.defaultPrevented || e.isComposing || target?.closest(ESCAPE_OWNER)) return;
  entry.close();
}

/** Test seam: number of registered overlays. */
export function overlayCount(): number {
  return entries.size;
}
