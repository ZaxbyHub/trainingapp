/**
 * Chat model chip (Lumen phase 5, docs/design/design-language.md sections 2.3 and 5):
 * which generator answers the NEXT chat turn, described only from values the send
 * path itself uses. Principle "honest state": when a mode has no reliable source
 * for the model name, the chip names the mode and nothing more; it never guesses.
 *
 * Per mode (mirrors ChatPage.runGeneration's routing exactly):
 *  - Desktop backend (mode 'api', or the backend reports engine 'external'):
 *      engine 'external'  -> "External model" only. The model/endpoint lives in the
 *                            desktop backend's settings; the renderer's localStorage
 *                            copy is NOT authoritative inside Electron.
 *      engine 'llama.cpp' -> the profile the backend will use: the resident profile
 *                            when the poll reported one, else GET /status/models
 *                            `profile`. GGUF paths are not shown (a path is not a name).
 *      engine 'stub'      -> "test stub".
 *      no status / no session -> "Desktop backend" only.
 *  - Browser app with an active external endpoint -> protocol family plus the
 *      configured model and the base URL's host (plus the port when not the scheme default,
 *      so two localhost servers differ; never scheme, userinfo, path, query or key).
 *  Readiness: the built-in model ("Local", or the desktop llama.cpp profile) gets
 *  `notReady` from the model gate's own flags (isModelReady / no staged GGUF); no probe.
 *  - Otherwise the local engine and the model id its load path actually uses
 *      (wllama: LLM_MODEL_DIR, labelled from public/models/manifest.json when listed;
 *      WebLLM: WEBLLM_DEFAULT_MODEL_ID).
 */
import type { InferenceMode } from '../inference';
import type { ModelStatus } from '../api/types';
import type { BrowserEngine } from '../../types/llm';
import { isExternalActive, type ExternalConfig } from '../llm/external-provider';
import packagedManifest from '../../../public/models/manifest.json';

export type ChatGeneratorKind = 'local' | 'external' | 'desktop' | 'desktop-external';

export interface ChatModelDescription {
  kind: ChatGeneratorKind;
  /** Where the answer is generated, e.g. "Local", "OpenAI-compatible", "Desktop". */
  source: string;
  /** The model, or null when the mode has no reliable model name. */
  model: string | null;
  /** Endpoint host (external endpoints only). */
  host: string | null;
  /** One plain sentence for the tooltip / accessible description. */
  detail: string;
  /**
   * The built-in model is missing or not loaded yet, i.e. the same condition that
   * raises the model-gate overlay (ModelBlockedOverlay / DesktopModelBlockedOverlay).
   * Never set for external endpoints or modes with no local model claim.
   */
  notReady: boolean;
}

/**
 * The single routing predicate: does the next turn go to the desktop backend?
 * ChatPage.runGeneration branches on this, and the chip describes the same branch.
 */
export function routesToDesktopBackend(
  mode: InferenceMode,
  hasDesktopSession: boolean,
  desktopEngine: ModelStatus['engine'] | null | undefined,
): boolean {
  return mode === 'api' || (hasDesktopSession && desktopEngine === 'external');
}

export interface DescribeChatModelInput {
  mode: InferenceMode;
  hasDesktopSession: boolean;
  desktopModels: (Pick<ModelStatus, 'engine' | 'profile'> & Partial<Pick<ModelStatus, 'models'>>) | null;
  /** Profile the polled resident-load status reports (null when unknown). */
  residentProfile: string | null;
  /** Browser app only: the stored external-model config. Pass null inside Electron. */
  externalConfig: ExternalConfig | null;
  browserEngine: BrowserEngine;
  /** The model ids the local load path uses (ChatPage passes its own constants). */
  wllamaModelId: string;
  webllmModelId: string;
  /**
   * Browser app: InferenceModeContext.isModelReady, the flag ChatPage's model gate
   * (isModelBlocked) reads. Omitted = unknown, which is treated as ready (no claim).
   */
  modelReady?: boolean;
}

interface ManifestEntry {
  id: string;
  label: string;
}

/** Packaged-model display label, minus its parenthetical, or the raw id when unlisted. */
export function packagedModelLabel(id: string): string {
  const models = (packagedManifest as { models?: ManifestEntry[] }).models ?? [];
  const entry = models.find((m) => m.id === id);
  if (!entry) return id;
  const short = entry.label.replace(/\s*\(.*\)\s*$/, '').trim();
  return short || id;
}

/** Endpoint host, plus the port when it is not the scheme default (so two localhost servers differ). */
function hostOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    // `host` would carry userinfo-free host:port too, but build it explicitly so
    // scheme, userinfo, path and query can never leak. URL.port is '' for a
    // scheme-default port, so https://x:443 and https://x read the same.
    if (!url.hostname) return null;
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Same predicate as desktop-session.modelsAbsentForRealEngine (the desktop gate:
 * real engine and no staged GGUF for either profile), inlined because this module
 * stays free of the React session module. A drift test pins the two together.
 */
function desktopGateBlocks(models: DescribeChatModelInput['desktopModels']): boolean {
  if (models === null || models.engine === 'stub' || models.engine === 'external') return false;
  const staged = models.models;
  return staged !== undefined && !staged.quality.present && !staged.fast.present;
}

export function describeChatModel(input: DescribeChatModelInput): ChatModelDescription {
  const engine = input.desktopModels?.engine ?? null;
  if (routesToDesktopBackend(input.mode, input.hasDesktopSession, engine)) {
    if (!input.hasDesktopSession || input.desktopModels === null) {
      return {
        kind: 'desktop',
        source: 'Desktop backend',
        model: null,
        host: null,
        detail: 'Answers come from the desktop app’s built-in backend.',
        notReady: false,
      };
    }
    if (engine === 'external') {
      return {
        kind: 'desktop-external',
        source: 'External model',
        model: null,
        host: null,
        detail: 'The desktop app answers through the external endpoint set in Settings.',
        notReady: false,
      };
    }
    if (engine === 'stub') {
      return {
        kind: 'desktop',
        source: 'Desktop',
        model: 'test stub',
        host: null,
        detail: 'The desktop backend is running its test stub engine (no model).',
        notReady: false,
      };
    }
    const profile = input.residentProfile ?? input.desktopModels.profile;
    // The stub and external engines were handled above, so only a real engine reaches here.
    const notReady = desktopGateBlocks(input.desktopModels);
    return {
      kind: 'desktop',
      source: 'Desktop',
      model: profile ? `${capitalize(profile)} profile` : null,
      host: null,
      detail:
        (profile
          ? `The desktop app answers with its local ${profile} model profile.`
          : 'The desktop app answers with its local model.') + (notReady ? ' The model is not installed yet.' : ''),
      notReady,
    };
  }

  const cfg = input.externalConfig;
  if (cfg !== null && isExternalActive(cfg)) {
    const family = cfg.protocol === 'anthropic' ? 'Anthropic-compatible' : 'OpenAI-compatible';
    const host = hostOf(cfg.baseUrl);
    const model = cfg.model.trim();
    return {
      kind: 'external',
      source: host ?? family,
      model,
      host,
      detail: `${family} endpoint${host ? ` at ${host}` : ''}, model ${model}. ${
        cfg.grounded ? 'Answers use your documents.' : 'Direct chat: your documents are not searched.'
      }`,
      notReady: false,
    };
  }

  const model =
    input.browserEngine === 'wllama' ? packagedModelLabel(input.wllamaModelId) : input.webllmModelId;
  const engineName = input.browserEngine === 'wllama' ? 'wllama' : 'WebLLM';
  // Two gates can block here: the browser model gate (isModelReady) and, with a desktop
  // session, DesktopModelBlockedOverlay, which opens on the staged-absent real engine
  // whatever the inference mode is. Report not-ready when either one blocks.
  const notReady =
    input.modelReady === false || (input.hasDesktopSession && desktopGateBlocks(input.desktopModels));
  return {
    kind: 'local',
    source: 'Local',
    model,
    host: null,
    detail:
      `Runs on this computer in the app (${engineName} engine).` +
      (notReady ? ' The model is not loaded yet.' : ''),
    notReady,
  };
}

/** Suffix appended to the chip text while the built-in model is missing or not loaded. */
export const NOT_READY_SUFFIX = ' — not ready';

/** Visible chip text, e.g. "Local · Gemma 4 E2B-it" or "Local · Gemma 4 E2B-it — not ready". */
export function chatModelText(d: ChatModelDescription): string {
  const base = d.model ? `${d.source} · ${d.model}` : d.source;
  return d.notReady ? `${base}${NOT_READY_SUFFIX}` : base;
}
