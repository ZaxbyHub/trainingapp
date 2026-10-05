/**
 * B9 (issue #67): blocking, informative state for the Electron first-run
 * model check. Shown when the desktop backend reports `engine !== 'stub'`
 * AND neither the Quality nor the Fast GGUF is staged on disk — the state
 * where the first /ask would 503. Extracted into its own component per the
 * shared-file convention (ModelBlockedOverlay extraction, PR #32): ChatPage
 * renders it as a one-liner and never grows overlay logic of its own.
 *
 * Built from the design-system primitives (Lumen phase 7, design-language.md
 * section 5): ui/Dialog (role="alertdialog", non-dismissible), ui/Banner and
 * ui/Button. Scope is unchanged and now enforced: it blocks the CHAT PAGE only
 * ("Documents and Settings remain available"). ChatPage renders it inside
 * `.chat-page` and makes the covered chat content inert, so the Dialog is
 * `contained` (not a window-wide z-9000 layer) and `modal={false}`: the shell
 * navigation stays usable, so claiming aria-modal would be untruthful (see
 * ModelBlockedOverlay for the rationale).
 *
 * A11y parity with ModelBlockedOverlay (PR-review F8): Dialog remembers and
 * restores the previously focused element (unless focus has moved on) and, being
 * non-modal, does not trap Tab. It
 * does NOT close on Escape: it is a blocking state with no dismiss path (no
 * onClose), so Escape is swallowed (Dialog `dismissible={false}`) and the
 * overlay stays until the backend reports staged models or an external engine.
 * On open, focus lands on the dialog itself (initialFocus="panel") so assistive
 * tech reads the title and description before offering the actions.
 */
import { MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';
import { Banner, Button, Dialog } from '../ui';
import './blocking.css';

export interface DesktopModelBlockedOverlayProps {
  open: boolean;
  /**
   * Open Settings; with a section id, Settings scrolls to and focuses it
   * (the same section-aware seam ModelBlockedOverlay uses). Backs "Open
   * Settings" and "Use a local server or cloud model"
   * (universal-provider-settings-overhaul: parity with the browser overlay — an
   * external model needs no staged GGUF). Required (PR #151 review PRR-151-049):
   * without it this non-dismissible gate would render with no action at all.
   */
  onOpenSettings: (section?: string) => void;
}

const BODY_ID = 'desktop-model-gate-body';

export function DesktopModelBlockedOverlay({ open, onOpenSettings }: DesktopModelBlockedOverlayProps) {
  return (
    <Dialog
      open={open}
      alert
      dismissible={false}
      modal={false}
      contained
      initialFocus="panel"
      describedBy={BODY_ID}
      className="blocking-gate"
      title="AI models are not installed yet"
      footer={
        <>
          <Button onClick={() => onOpenSettings()}>Open Settings</Button>
          <Button variant="primary" onClick={() => onOpenSettings(MODEL_CONNECTION_SECTION_ID)}>
            Use a local server or cloud model
          </Button>
        </>
      }
    >
      <div className="blocking-gate__stack">
        <Banner tone="warning" live={false}>
          <span id={BODY_ID}>
            Neither the Quality nor the Fast language model was found in this app&apos;s
            model directory, so asking questions is unavailable right now. Documents and
            Settings remain available. Re-run the app installer or add the model files to
            the models directory, then restart the app. Or connect an external model (a local
            server or a cloud provider) in Settings.
          </span>
        </Banner>
      </div>
    </Dialog>
  );
}
