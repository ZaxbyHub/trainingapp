/**
 * Safeguard for the chat model gates' `inert` boundary (PR #151 review PRR-151-018).
 *
 * ChatPage makes everything a model gate covers inert by putting the `inert`
 * attribute on `.chat-page__content` (a `display: contents` wrapper). In an engine
 * that implements `inert` that attribute alone removes the covered content from
 * the Tab order, pointer hit-testing and the accessibility tree. In an engine that
 * does NOT implement it (pre-2023 Firefox/Safari, and jsdom) the attribute does
 * nothing, and the covered composer and buttons would stay reachable behind the
 * gate. When — and only when — `inert` is unsupported, this hook emulates its two
 * keyboard/AT effects:
 *   - every focusable descendant gets tabindex="-1" (its original tabindex, or its
 *     absence, is saved and restored exactly when the gate lifts; a value the app
 *     writes while the gate is up, even "-1", replaces the saved one);
 *   - every element CHILD of the wrapper gets aria-hidden="true" (not the wrapper
 *     itself: some engines drop `display: contents` boxes from the accessibility
 *     tree, taking their ARIA attributes with them).
 * A MutationObserver re-applies it to focusables mounted, or re-enabled by React,
 * while the gate is up, and records the app's own tabindex/aria-hidden writes so
 * release restores the app's LATEST values, not the pre-gate ones (LOW-2). Pointer blocking is not emulated: the gate's scrim already
 * covers the chat region.
 */
import { useLayoutEffect, type RefObject } from 'react';

const SAVED_TABINDEX = 'data-inert-fallback-tabindex';
const SAVED_HIDDEN = 'data-inert-fallback-aria-hidden';
/** Sentinel for "the attribute was absent" (restored by removing it). */
const ABSENT = 'inert-fallback:absent';
const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

/** Feature check, evaluated at call time (tests may define `inert` on the prototype). */
export function supportsNativeInert(): boolean {
  return typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
}

/**
 * The elements whose CURRENT tabindex / aria-hidden value is the fallback's own
 * (PR #151 final review LOW-2). An element leaves its set when the app writes that
 * attribute while the gate is up (noteAppWrites), and the next apply then saves the
 * app's value as the one to restore. Tracked explicitly, never inferred from the
 * value: an app that sets tabIndex={-1} or aria-hidden="true" mid-gate writes the
 * same value the fallback does, and that is still the app's intent on release.
 */
export interface InertFallbackWrites {
  tabindex: WeakSet<Element>;
  hidden: WeakSet<Element>;
}

export function createInertFallbackWrites(): InertFallbackWrites {
  return { tabindex: new WeakSet(), hidden: new WeakSet() };
}

/**
 * Record app writes: every `tabindex` / `aria-hidden` attribute record handed to the
 * observer is someone else's write, because the observer drops the records of the
 * fallback's own writes right after making them (takeRecords). A record is queued
 * even when the value is unchanged, which is what makes a same-value write visible.
 */
export function noteAppWrites(records: readonly MutationRecord[], writes: InertFallbackWrites): void {
  for (const record of records) {
    if (record.type !== 'attributes') continue;
    if (record.attributeName === 'tabindex') writes.tabindex.delete(record.target as Element);
    else if (record.attributeName === 'aria-hidden') writes.hidden.delete(record.target as Element);
  }
}

/**
 * Apply (or re-apply, idempotently) the emulation under `root`. An element whose
 * current value is not the fallback's own (first sight, or an app write since)
 * has that value saved for release, then gets the emulated value.
 */
export function applyInertFallback(root: HTMLElement, writes: InertFallbackWrites): void {
  for (const child of Array.from(root.children)) {
    if (writes.hidden.has(child)) continue;
    const current = child.getAttribute('aria-hidden');
    child.setAttribute(SAVED_HIDDEN, current ?? ABSENT);
    if (current !== 'true') child.setAttribute('aria-hidden', 'true');
    writes.hidden.add(child);
  }
  // Also elements saved earlier that the app has since made non-focusable (e.g.
  // removed their tabindex): their saved value must follow the app too.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`${FOCUSABLE},[${SAVED_TABINDEX}]`))) {
    if (writes.tabindex.has(el)) continue;
    const current = el.getAttribute('tabindex');
    el.setAttribute(SAVED_TABINDEX, current ?? ABSENT);
    if (current !== '-1') el.setAttribute('tabindex', '-1');
    writes.tabindex.add(el);
  }
}

/** Undo the emulation under `root`, restoring every saved attribute exactly. */
export function releaseInertFallback(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${SAVED_TABINDEX}]`))) {
    const saved = el.getAttribute(SAVED_TABINDEX);
    if (saved === ABSENT || saved === null) el.removeAttribute('tabindex');
    else el.setAttribute('tabindex', saved);
    el.removeAttribute(SAVED_TABINDEX);
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${SAVED_HIDDEN}]`))) {
    const saved = el.getAttribute(SAVED_HIDDEN);
    if (saved === ABSENT || saved === null) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', saved);
    el.removeAttribute(SAVED_HIDDEN);
  }
}

/**
 * Emulate `inert` on `ref.current` while `active`, in engines without native
 * support. A no-op where `inert` is implemented (the attribute does the work).
 */
export function useInertFallback(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!active || root === null || supportsNativeInert()) return undefined;
    const writes = createInertFallbackWrites();
    applyInertFallback(root, writes);
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records, self) => {
            noteAppWrites(records, writes);
            applyInertFallback(root, writes);
            // Drop the records of the writes just made: they are the fallback's own,
            // and nothing else can run between those writes and this call.
            self.takeRecords();
          });
    observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex', 'aria-hidden'] });
    return () => {
      if (observer !== null) {
        // App writes committed together with the release (the same render that lifts
        // the gate) are still queued: honour them before restoring.
        noteAppWrites(observer.takeRecords(), writes);
        applyInertFallback(root, writes);
        observer.disconnect();
      }
      releaseInertFallback(root);
    };
  }, [ref, active]);
}
