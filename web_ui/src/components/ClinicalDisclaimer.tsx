// ClinicalDisclaimer — issue #365 (WI4): the always-on educational disclaimer
// rendered with EVERY assistant answer (normal, streamed, abstain, error) and
// on the chat welcome state. The wording is the PROPOSED constant exported
// from lib/rag/safety-notice.ts (single source of truth, quoted verbatim in
// CONFIGURATION.md and the PR body; gates on maintainer sign-off per issue
// #365 AC3). Tests pin the rendered text against that constant, so wording
// drift without the sign-off update cannot ship silently.
import { CLINICAL_DISCLAIMER_TEXT } from '../lib/rag/safety-notice';
import '../pages/chat.css';

export function ClinicalDisclaimer() {
  return (
    <div className="chat-msg__disclaimer" data-testid="clinical-disclaimer" role="note">
      {CLINICAL_DISCLAIMER_TEXT}
    </div>
  );
}

export default ClinicalDisclaimer;
