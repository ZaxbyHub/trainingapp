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
 *     absence, is saved and restored exactly when the gate lifts);
 *   - every element CHILD of the wrapper gets aria-hidden="true" (not the wrapper
 *     itself: some engines drop `display: contents` boxes from the accessibility
 *     tree, taking their ARIA attributes with them).
 * A MutationObserver re-applies it to focusables mounted, or re-enabled by React,
 * while the gate is up. Pointer blocking is not emulated: the gate's scrim already
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

/** Apply (or re-apply, idempotently) the emulation under `root`. */
export function applyInertFallback(root: HTMLElement): void {
  for (const child of Array.from(root.children)) {
    if (!child.hasAttribute(SAVED_HIDDEN)) {
      child.setAttribute(SAVED_HIDDEN, child.getAttribute('aria-hidden') ?? ABSENT);
    }
    if (child.getAttribute('aria-hidden') !== 'true') child.setAttribute('aria-hidden', 'true');
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    const current = el.getAttribute('tabindex');
    if (!el.hasAttribute(SAVED_TABINDEX)) {
      el.setAttribute(SAVED_TABINDEX, current ?? ABSENT);
    } else if (current !== '-1') {
      // React (or anything else) changed it while the gate was up: that is the
      // value to restore later.
      el.setAttribute(SAVED_TABINDEX, current ?? ABSENT);
    }
    if (current !== '-1') el.setAttribute('tabindex', '-1');
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
    applyInertFallback(root);
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => applyInertFallback(root));
    // Our own writes only ever set tabindex to "-1" / aria-hidden to "true", which
    // re-apply as no-ops, so the observer settles after one extra pass.
    observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex', 'aria-hidden'] });
    return () => {
      observer?.disconnect();
      releaseInertFallback(root);
    };
  }, [ref, active]);
}
