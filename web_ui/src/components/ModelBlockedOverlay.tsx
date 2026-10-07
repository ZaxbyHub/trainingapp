/**
 * ModelBlockedOverlay — the chat page's blocking "model not ready" state, built
 * from the design-system primitives (design-language.md section 5): ui/Dialog
 * (role="alertdialog", non-dismissible, non-modal, focus return), ui/Banner for the readiness failures and
 * recommendations, ui/ProgressBar for the load, ui/Button for the actions.
 *
 * Scope (Lumen phase 7): it blocks the CHAT PAGE only. ChatPage renders it as a
 * sibling of the (inert) chat content inside `.chat-page`, so the dialog is
 * `contained` (absolute backdrop over the chat region, not a body portal) and
 * the app shell's sidebar and top bar stay usable (PR #147 PRR-022: narrow
 * windows need the top bar for Documents/Training navigation). Because the rest
 * of the page remains operable it declares `aria-modal` false (`modal={false}`):
 * aria-modal="true" asserts everything outside the dialog is inert, which would
 * hide the navigation from assistive tech while it is still reachable (WAI-ARIA
 * 1.2 dialog pattern). The covered chat content is made inert by ChatPage
 * instead, which is the part that is actually true. Dialog does not trap Tab for a
 * non-modal dialog (the navigation is reachable by keyboard); initial focus and focus
 * return are Dialog's. Escape and backdrop presses do nothing.
 *
 * Status changes are announced (PR #151 review PRR-151-005, WCAG 4.1.3): an
 * alertdialog is announced when it appears, but it is not a live region, so a
 * later change of its content (the check resolving from "Preparing the model…"
 * into failures, or back while a Retry runs) would otherwise be silent. Two
 * visually hidden live regions are mounted with the dialog, EMPTY, and only
 * receive text when the state changes after mount: failures go to the assertive
 * region, every other change to the polite one. Nothing is written on mount,
 * because the dialog's own name and description are read when it appears.
 *
 * (issue #21 F10 originally mounted the overlay as an inline IIFE; #25 lifts it
 * into its own component and adds the a11y guarantees.)
 */

import React, { useEffect, useRef, useState } from 'react';
import type { ReadinessResult } from '../lib/llm/model-readiness';
import type { BrowserEngine } from '../types/llm';
import { MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';
import { Banner, Button, Dialog, ProgressBar } from '../ui';
import './blocking.css';

interface ModelBlockedOverlayProps {
  readinessResult: ReadinessResult | null;
  browserEngine: BrowserEngine;
  modelLoadingProgress: number;
  onRetry: () => void;
  /**
   * True while a Retry-triggered check is in flight (PRR-151-015): Retry shows
   * busy and ignores presses (Button `loading`: aria-disabled, so focus stays on
   * it instead of dropping to the page, as native `disabled` would).
   */
  retrying?: boolean;
  /** Open Settings; with a section id, Settings scrolls to and focuses it. */
  onOpenSettings: (section?: string) => void;
}

const HEADLINE_ID = 'model-blocked-headline';

export function ModelBlockedOverlay({
  readinessResult,
  browserEngine,
  modelLoadingProgress,
  onRetry,
  retrying = false,
  onOpenSettings,
}: ModelBlockedOverlayProps): React.ReactElement {
  const failures = readinessResult?.failures ?? [];
  const recommendations = readinessResult?.recommendations ?? [];
  const hasRealFailure = failures.length > 0;
  const headline = hasRealFailure
    ? (browserEngine === 'wllama'
        ? 'This build is missing the packaged model. See the Packaging guide or contact your administrator.'
        : 'The browser model is not available. Use Settings to download it, or switch engines.')
    : 'Preparing the model…';

  // What a screen reader should hear when the state changes after mount. The
  // dialog title is prefixed because focus may be elsewhere (e.g. in the shell
  // navigation) when the change lands.
  const statusText = ['Model not ready.', headline, ...failures].join(' ');
  const [announcement, setAnnouncement] = useState<{ text: string; urgent: boolean } | null>(null);
  const announcedRef = useRef(statusText);
  useEffect(() => {
    if (announcedRef.current === statusText) return;
    announcedRef.current = statusText;
    setAnnouncement({ text: statusText, urgent: hasRealFailure });
  }, [statusText, hasRealFailure]);

  return (
    <Dialog
      open
      alert
      dismissible={false}
      modal={false}
      contained
      describedBy={HEADLINE_ID}
      className="blocking-gate"
      title="Model not ready"
      footer={
        <>
          {/* First focusable control, so Dialog's default initial focus lands on Retry. */}
          <Button onClick={onRetry} loading={retrying}>Retry</Button>
          <Button onClick={() => onOpenSettings()}>Open Settings</Button>
          {/* settings-wiring-honesty (AC10): the missing-model state has a way
              forward that needs no packaged weights: an external
              OpenAI-compatible model (local server or cloud). First-class
              (primary) action; opens Settings at the section hosting those
              controls. */}
          <Button variant="primary" onClick={() => onOpenSettings(MODEL_CONNECTION_SECTION_ID)}>
            Use a local server or cloud model
          </Button>
        </>
      }
    >
      <div className="blocking-gate__stack">
        <p id={HEADLINE_ID} className="blocking-gate__lead">
          {headline}
        </p>
        {!hasRealFailure && modelLoadingProgress > 0 && (
          <>
            <ProgressBar label="Model loading progress" value={modelLoadingProgress} />
            <p className="blocking-gate__percent">{modelLoadingProgress}%</p>
          </>
        )}
        {/* live={false}: these Banners mount WITH their content, which live
            regions announce unreliably, and on mount the dialog's own
            appearance already conveys the state. Later changes are announced
            by the always-mounted regions below the stack instead. */}
        {hasRealFailure && (
          <Banner tone="danger" live={false}>
            <ul className="blocking-gate__list">
              {failures.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </Banner>
        )}
        {recommendations.length > 0 && (
          <Banner tone="info" live={false}>
            <ul className="blocking-gate__list">
              {recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </Banner>
        )}
      </div>
      {/* Mounted with the dialog and empty until the state changes (see the
          header): a live region must exist before its text changes. */}
      <div className="ui-visually-hidden" aria-live="polite" aria-atomic="true" data-testid="model-gate-status">
        {announcement !== null && !announcement.urgent ? announcement.text : ''}
      </div>
      <div className="ui-visually-hidden" aria-live="assertive" aria-atomic="true" data-testid="model-gate-alert">
        {announcement !== null && announcement.urgent ? announcement.text : ''}
      </div>
    </Dialog>
  );
}

export default ModelBlockedOverlay;
