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
 * comes from the /status/models snapshot App keeps fresh on models-changed events,
 * and the browser external config is read live (useExternalConfig) so a save in
 * Settings updates the chip without a remount.
 *
 * Expanded sidebar and drawer: the full chip. 64px rail: an icon-only button whose
 * tooltip (beside the rail, placement 'end') carries the chip text.
 */
import { useInferenceMode } from '../lib/inference';
import { isElectron, useDesktopSession } from '../lib/desktop-session';
import { useExternalConfig } from '../lib/llm/use-external-config';
import { LLM_MODEL_DIR } from '../lib/models/model-manifest';
import { WEBLLM_DEFAULT_MODEL_ID } from '../lib/llm/web-llm-service';
import { focusSettingsSection, MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';
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
  const { mode, browserEngine, isModelReady } = useInferenceMode();
  const { session, models } = useDesktopSession();
  // Live: the sidebar stays mounted while Settings saves a new endpoint.
  const externalConfig = useExternalConfig();
  const description = describeChatModel({
    mode,
    hasDesktopSession: session !== null,
    desktopModels: models,
    // The resident profile from the same /status/models snapshot, so the footer and
    // the Chat header (which polls it) name the same profile during a desktop load.
    residentProfile: models?.resident?.profile ?? null,
    // Inside Electron the renderer's stored external config is not authoritative.
    externalConfig: isElectron() ? null : externalConfig,
    browserEngine,
    wllamaModelId: LLM_MODEL_DIR,
    webllmModelId: WEBLLM_DEFAULT_MODEL_ID,
    // The model gate's flag (what ChatPage's overlay reads); the desktop side comes from
    // the same /status/models snapshot via desktopModels above.
    modelReady: isModelReady,
  });
  const open = () => {
    onOpenModelSettings();
    // Settings focuses its own heading, but <main> is still inert while the drawer
    // is open and AppShell would then focus <main> itself. Hand AppShell the focus
    // step to run once the drawer has closed instead of that default.
    if (drawer) closeDrawer('navigate', () => focusSettingsSection(MODEL_CONNECTION_SECTION_ID));
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
