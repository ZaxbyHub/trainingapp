/**
 * Sidebar footer connection chip (design-language.md section 5, "App shell &
 * navigation": "a footer connection chip ... that deep-links to Settings -> Model &
 * connection"). Self-contained so the shell's Sidebar.tsx only needs one insertion.
 *
 * It describes the generator with the same honest rules as the Chat header chip
 * (lib/chat/model-chip.ts): host + model for an external endpoint (never URL path,
 * query, userinfo or key), the local model id/label for the built-in engine, and
 * only the mode when no reliable model name exists (desktop external engine, no
 * backend status). The sidebar has no resident-load poll, so the desktop profile
 * comes from the /status/models snapshot App keeps fresh on models-changed events.
 *
 * Expanded sidebar and drawer: the full chip. 64px rail: an icon-only button whose
 * tooltip (beside the rail, placement 'end') carries the chip text.
 */
import { useInferenceMode } from '../lib/inference';
import { isElectron, useDesktopSession } from '../lib/desktop-session';
import { loadExternalConfig } from '../lib/llm/external-provider';
import { LLM_MODEL_DIR } from '../lib/models/model-manifest';
import { WEBLLM_DEFAULT_MODEL_ID } from '../lib/llm/web-llm-service';
import { chatModelText, describeChatModel } from '../lib/chat/model-chip';
import { IconButton, useAppShell } from '../ui';
import { ModelChip, MODEL_CHIP_ICON } from './ModelChip';
import '../pages/chat.css';

export interface SidebarConnectionChipProps {
  /** Opens Settings at the model-connection section. */
  onOpenModelSettings: () => void;
}

export function SidebarConnectionChip({ onOpenModelSettings }: SidebarConnectionChipProps) {
  const { collapsed, drawer, closeDrawer } = useAppShell();
  const { mode, browserEngine } = useInferenceMode();
  const { session, models } = useDesktopSession();
  const description = describeChatModel({
    mode,
    hasDesktopSession: session !== null,
    desktopModels: models,
    residentProfile: null,
    // Inside Electron the renderer's stored external config is not authoritative.
    externalConfig: isElectron() ? null : loadExternalConfig(),
    browserEngine,
    wllamaModelId: LLM_MODEL_DIR,
    webllmModelId: WEBLLM_DEFAULT_MODEL_ID,
  });
  const open = () => {
    onOpenModelSettings();
    if (drawer) closeDrawer('navigate');
  };

  if (collapsed) {
    return (
      <div className="app-sidebar__connection app-sidebar__connection--rail" data-testid="sidebar-connection">
        <IconButton
          icon={MODEL_CHIP_ICON[description.kind]}
          tooltipPlacement="end"
          aria-label={`Model: ${chatModelText(description)}. Open model settings`}
          data-kind={description.kind}
          onClick={open}
        />
      </div>
    );
  }
  return (
    <div className="app-sidebar__connection" data-testid="sidebar-connection">
      <ModelChip description={description} onOpenSettings={open} testId="sidebar-model-chip" />
    </div>
  );
}
