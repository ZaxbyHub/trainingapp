/**
 * Chat header model chip (Lumen phase 5). Shows which generator answers the next
 * turn, as described by lib/chat/model-chip.ts from the same predicates the send
 * path routes on. Clicking it opens Settings at the model-connection section.
 */
import { useId } from 'react';
import { Icon, Tooltip, type IconName, type TooltipProps } from '../ui';
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
  /** Where the detail tooltip opens (header: 'bottom', sidebar footer: 'top'). */
  tooltipPlacement?: TooltipProps['placement'];
}

export function ModelChip({ description, onOpenSettings, testId = 'chat-model-chip', tooltipPlacement = 'bottom' }: ModelChipProps) {
  const text = chatModelText(description);
  // The grounded-vs-direct / profile sentence (description.detail) is essential. Sighted
  // users get it from the repo Tooltip (hover AND keyboard focus); assistive tech gets it
  // from a hidden node referenced by aria-describedby. The tooltip's own copy is
  // aria-hidden so the description is read exactly once while the tooltip is open.
  const detailId = useId();
  const detail = (
    <span id={detailId} hidden data-testid={`${testId}-detail`}>
      {description.detail}
    </span>
  );
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
      <>
        <span
          className="chat-model-chip"
          data-testid={testId}
          data-kind={description.kind}
          title={description.detail}
          aria-describedby={detailId}
        >
          {content}
        </span>
        {detail}
      </>
    );
  }
  return (
    <>
      <Tooltip content={<span aria-hidden="true">{description.detail}</span>} placement={tooltipPlacement}>
        <button
          type="button"
          className="chat-model-chip ui-focusable"
          data-testid={testId}
          data-kind={description.kind}
          aria-label={`Model: ${text}. Open model settings`}
          aria-describedby={detailId}
          onClick={onOpenSettings}
        >
          {content}
        </button>
      </Tooltip>
      {detail}
    </>
  );
}
