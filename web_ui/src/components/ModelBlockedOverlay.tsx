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
 * (issue #21 F10 originally mounted the overlay as an inline IIFE; #25 lifts it
 * into its own component and adds the a11y guarantees.)
 */

import React from 'react';
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
  /** Open Settings; with a section id, Settings scrolls to and focuses it. */
  onOpenSettings: (section?: string) => void;
}

const HEADLINE_ID = 'model-blocked-headline';

export function ModelBlockedOverlay({
  readinessResult,
  browserEngine,
  modelLoadingProgress,
  onRetry,
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
          <Button onClick={onRetry}>Retry</Button>
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
        {/* live={false}: the alertdialog itself is the live announcement; a
            role="alert"/"status" Banner inside it would be read a second time. */}
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
    </Dialog>
  );
}

export default ModelBlockedOverlay;
