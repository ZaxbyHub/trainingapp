/**
 * Chat header model chip (Lumen phase 5). Shows which generator answers the next
 * turn, as described by lib/chat/model-chip.ts from the same predicates the send
 * path routes on. Clicking it opens Settings at the model-connection section.
 */
import { Icon, type IconName } from '../ui';
import { chatModelText, NOT_READY_SUFFIX, type ChatModelDescription } from '../lib/chat/model-chip';
import '../pages/chat.css';

/** Glyph per generator kind (shared with the sidebar footer chip). */
export const MODEL_CHIP_ICON: Record<ChatModelDescription['kind'], IconName> = {
  local: 'cpu',
  external: 'globe',
  desktop: 'server',
  'desktop-external': 'globe',
};

export interface ModelChipProps {
  description: ChatModelDescription;
  /** Opens Settings at the model-connection section. Without it the chip is static text. */
  onOpenSettings?: () => void;
  /** data-testid (the Chat header and the sidebar footer render one each). */
  testId?: string;
}

export function ModelChip({ description, onOpenSettings, testId = 'chat-model-chip' }: ModelChipProps) {
  const text = chatModelText(description);
  const content = (
    <>
      <Icon name={MODEL_CHIP_ICON[description.kind]} size={16} />
      <span className="chat-model-chip__text">
        <span className="chat-model-chip__name" data-testid={`${testId}-name`}>
          <span className="chat-model-chip__source">{description.source}</span>
          {description.model ? ` · ${description.model}` : null}
        </span>
        {description.notReady ? (
          <>
            {' '}
            <span className="chat-model-chip__suffix" data-testid={`${testId}-suffix`}>
              {NOT_READY_SUFFIX.trim()}
            </span>
          </>
        ) : null}
      </span>
    </>
  );
  if (!onOpenSettings) {
    return (
      <span className="chat-model-chip" data-testid={testId} data-kind={description.kind} title={description.detail}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chat-model-chip ui-focusable"
      data-testid={testId}
      data-kind={description.kind}
      title={description.detail}
      aria-label={`Model: ${text}. Open model settings`}
      onClick={onOpenSettings}
    >
      {content}
    </button>
  );
}
