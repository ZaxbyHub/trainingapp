/**
 * Chat header model chip (Lumen phase 5). Shows which generator answers the next
 * turn, as described by lib/chat/model-chip.ts from the same predicates the send
 * path routes on. Clicking it opens Settings at the model-connection section.
 */
import { Icon, type IconName } from '../ui';
import { chatModelText, type ChatModelDescription } from '../lib/chat/model-chip';
import '../pages/chat.css';

const ICON: Record<ChatModelDescription['kind'], IconName> = {
  local: 'cpu',
  external: 'globe',
  desktop: 'server',
  'desktop-external': 'globe',
};

export interface ModelChipProps {
  description: ChatModelDescription;
  /** Opens Settings at the model-connection section. Without it the chip is static text. */
  onOpenSettings?: () => void;
}

export function ModelChip({ description, onOpenSettings }: ModelChipProps) {
  const text = chatModelText(description);
  const content = (
    <>
      <Icon name={ICON[description.kind]} size={16} />
      <span className="chat-model-chip__text">
        <span className="chat-model-chip__source">{description.source}</span>
        {description.model ? ` · ${description.model}` : null}
      </span>
    </>
  );
  if (!onOpenSettings) {
    return (
      <span className="chat-model-chip" data-testid="chat-model-chip" data-kind={description.kind} title={description.detail}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chat-model-chip ui-focusable"
      data-testid="chat-model-chip"
      data-kind={description.kind}
      title={description.detail}
      aria-label={`Model: ${text}. Open model settings`}
      onClick={onOpenSettings}
    >
      {content}
    </button>
  );
}
