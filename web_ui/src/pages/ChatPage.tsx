/**
 * Chat page component - primary user interface for document Q&A.
 * Displays messages, renders markdown, and supports streaming responses.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ChatMessage, TrainingTarget, CitationRef } from '../types/chat';
import type { SearchResult } from '../types/search';
import type { ModelStatus } from '../lib/api/types';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { StreamingIndicator } from '../components/StreamingIndicator';
import { ModelBlockedOverlay } from '../components/ModelBlockedOverlay';
import { IsolationBanner } from '../components/IsolationBanner';
import { PinnedSlideContext, pinnedSlideLabel, type PinnedSlide } from '../components/PinnedSlideContext';
import { useInferenceMode } from '../lib/inference';
import { InferenceModeToggle } from '../components/InferenceModeToggle';
import { TokenStreamManager } from '../lib/streaming';
import { DESKTOP_FIRST_BYTE_TIMEOUT_MS, DEFAULT_FIRST_BYTE_TIMEOUT_MS } from '../lib/api/streaming';
import { RAGOrchestrator } from '../lib/rag/rag-orchestrator';
import { buildDesktopHistorySnapshot, buildHistorySnapshot } from '../lib/chat/history-snapshot';
import { getLLMService } from '../lib/llm/llm-factory';
import { createExternalLLMService, isExternalActive, loadExternalConfig } from '../lib/llm/external-provider';
import {
  EXTERNAL_GROUNDED_INSTRUCTION,
  EXTERNAL_GROUNDED_QUESTION_LABEL,
  EXTERNAL_SYSTEM_PROMPT,
} from '../lib/llm/external-prompts';
import { ensureReadinessGateChecked, getReadinessResultSnapshot, resetReadinessCache } from '../lib/llm/readiness-gate';
import { READINESS_IN_FLIGHT_EVENT, type ReadinessInFlightDetail } from '../lib/llm/readiness-events';
import { WEBLLM_DEFAULT_MODEL_ID } from '../lib/llm/web-llm-service';
import { LLM_MODEL_DIR } from '../lib/models/model-manifest';
import { citationsToRefs } from '../lib/api/citations';
import type { Citation } from '../lib/api/types';
import type { AttachedImage } from '../lib/processing/image-input';
import { presetOptions } from '../lib/rag/rag-presets';
import { downloadConversation } from '../lib/export/conversation-export';
import { messagesForRegenerate } from '../lib/chat/message-ops';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { fetchModelStatus, isElectron, modelsAbsentForRealEngine, useDesktopSession } from '../lib/desktop-session';
import { notifyDesktopModelsChanged } from '../lib/desktop-models-events';
import { DesktopModelBlockedOverlay } from '../components/DesktopModelBlockedOverlay';
import { useInertFallback } from '../components/inertFallback';
import { Button, Icon, PageHeader, StatusPill } from '../ui';
import { ModelChip } from '../components/ModelChip';
import { describeChatModel, routesToDesktopBackend } from '../lib/chat/model-chip';
import { MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';
import { useExternalConfig } from '../lib/llm/use-external-config';
import './chat.css';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * D7 (issue #83): the injected pinned-slide text — a header line with the
 * "Section > Title" label (always contains the slide title) plus the resolved
 * on-screen text when the slide doc resolved in the store. Budgeted by the
 * orchestrator's computeReservedTokens like history is.
 */
export function composePinnedContext(pinned: PinnedSlide): string {
  const header = `Pinned training slide: ${pinnedSlideLabel(pinned)}`;
  const text = pinned.text?.trim();
  return text ? `${header}\n${text}` : header;
}

export interface ChatPageProps {
  messages: ChatMessage[];
  onMessagesChange: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Persist `messages` into the conversation identified by `conversationId`.
   *  The owning id is captured at send time (S1) so an in-flight stream can
   *  never write to a conversation other than the one that produced it. */
  onSaveConversation: (
    conversationId: string | undefined,
    messages: ChatMessage[],
    mode: 'server' | 'wllama',
    modelUsed: string,
    onCreate?: (newId: string) => void
  ) => void;
  /** The active conversation id (lifted state from useConversations). */
  currentConversationId: string | undefined;
  /** Set the active conversation id (also updates the ref mirror). Exposed so
   *  a send-time-created conversation becomes the owning + active id. */
  setCurrentConversationId: (id: string | undefined) => void;
  onNewChat: () => void;
  /** Navigate to the Settings page (wired from App). Used by the model-block
   *  overlay's "Open Settings" button and the Ctrl+, shortcut. The optional
   *  section id (settings-wiring-honesty) scrolls Settings to that section and
   *  focuses its heading, e.g. 'model-connection' for the overlay's
   *  local-server/cloud model action. */
  onOpenSettings: (section?: string) => void;
  /** U4: navigate to the Documents page (zero-doc empty-state CTA). */
  onNavigateToDocuments?: () => void;
  /** D6 (issue #82): navigate into the embedded training player, targeting a
   *  slide ("Open in training" deep link from the Learn panel). */
  onOpenTraining?: (target: TrainingTarget) => void;
  /** D7 (issue #83): the slide currently pinned from the training player, or
   *  null/undefined when no pin is active (never set, dismissed, or cleared). */
  pinnedSlide?: PinnedSlide | null;
  /** D7 (issue #83): clears the pin (App nulls its state). Same for live and
   *  stale pins. */
  onDismissPinnedSlide?: () => void;
}

export function ChatPage(props: ChatPageProps) {
  return <ChatPageInner {...props} />;
}

/**
 * C7 (issue #74): citations for a finished answer, from whichever surface
 * produced it. Electron/SSE answers carry the contract's pack-attributed
 * `citations` (mapped through the citationsToRefs choke point so pack
 * provenance cannot be silently dropped); browser-RAG answers carry retrieval
 * `chunks` (mapped explicitly so the retrieval-only `score` field is not
 * persisted into the message / Dexie, PRR-008). Browser-RAG chunks carry no
 * pack fields — packs are an Electron-surface concept (C9 owns the browser
 * adapter).
 */
function citationsFromDone(data: {
  citations?: Citation[];
  chunks?: SearchResult[];
}): CitationRef[] | undefined {
  if (data.citations !== undefined) {
    return data.citations.length > 0 ? citationsToRefs(data.citations) : [];
  }
  return data.chunks?.map((c) => ({
    docId: c.docId,
    chunkIndex: c.chunkIndex,
    source: c.source,
    page: c.page,
    text: c.text,
  }));
}

/**
 * Storage tag for a persisted conversation (PR #138 review hygiene): api turns
 * ride the server surface; browser-local turns the browser surface. Extracted
 * from six identical inline ternaries so the mode→surface mapping has exactly
 * one definition.
 */
function conversationStorageTag(mode: ReturnType<typeof useInferenceMode>['mode']): 'server' | 'wllama' {
  return mode === 'api' ? 'server' : 'wllama';
}

function ChatPageInner({ messages: messagesProp, onMessagesChange, onSaveConversation, currentConversationId, setCurrentConversationId, onNewChat, onOpenSettings, onNavigateToDocuments, onOpenTraining, pinnedSlide, onDismissPinnedSlide }: ChatPageProps) {
  const { mode, browserEngine, ragPreset, isModelReady, isServerConnected, modelLoadingProgress, setModelLoadingProgress } = useInferenceMode();
  // B9 (issue #67): desktop session drives the SSE endpoint/auth and the
  // first-run model gate. Both are inert outside Electron (session null,
  // predicate false).
  const { session: desktopSession, models: desktopModels } = useDesktopSession();
  // universal-provider-settings-overhaul: an enabled external endpoint
  // replaces the GENERATOR (retrieval stays local). Desktop app: the backend
  // generates through it and reports engine 'external' — chat then always
  // routes to the backend, the only place that holds the key and may reach
  // the endpoint (renderer CSP unchanged). Browser app: the renderer's own
  // generators (never inside Electron).
  const desktopExternal = desktopSession !== null && desktopModels?.engine === 'external';
  // Live view of the stored config (re-renders on save / other-tab change). Send-time
  // routing in runGeneration still reads loadExternalConfig() at the moment of sending.
  const externalConfigLive = useExternalConfig();
  const browserExternal = !isElectron() && mode === 'browser-local' && isExternalActive(externalConfigLive);
  // AC8: engine 'external' never gates on absent local GGUFs.
  const desktopModelBlocked = modelsAbsentForRealEngine(desktopModels);
  const messages = messagesProp;
  const setMessages = onMessagesChange;
  const [isLoading, setIsLoading] = useState(false);
  // PRE-2: true once the in-flight turn was cancelled (Stop / clear / switch); reset when
  // the next turn starts. Lets the message list announce "Response stopped", not "complete".
  const [turnStopped, setTurnStopped] = useState(false);
  // #133: the desktop backend's resident-model load state (polled while a
  // load is in flight) — drives the "chat disabled while the model loads"
  // banner. Null = unknown/not applicable (browser mode, or the backend
  // predates the field) and never blocks input.
  const [modelLoad, setModelLoad] = useState<ModelStatus['resident'] | null>(null);
  const [modelLoadNow, setModelLoadNow] = useState(() => Date.now());

  // #133 (round 4): chat is DISABLED while the desktop backend reports a
  // resident-model load in flight — the honest state, not a time heuristic.
  // Poll /status/models every 2s while eligible (a real engine with models
  // present) so the banner also catches mid-session reloads after a profile
  // switch; a missing `resident` field never gates.
  // F-002 (PR #138 review): BOTH gates ignore an external engine — it never
  // touches the staged local models, so a local load must not disable chat.
  const residentLoad = modelLoad;
  const isModelLoading =
    !desktopExternal && desktopSession !== null && residentLoad?.state === 'loading';
  // Poll only when a load is plausibly in flight: a real local engine with
  // models present. When the models are absent (blocked overlay already
  // explains it), with an external engine (no local load can gate the input),
  // or in browser mode, no poll ever fires — the gate stays inert.
  const modelsAbsent = desktopModels !== null && modelsAbsentForRealEngine(desktopModels);
  const pollEligible =
    !desktopExternal && desktopSession !== null && !modelsAbsent;
  // Read inside the poll effect without re-running it on every snapshot change.
  const desktopModelsRef = useRef(desktopModels);
  desktopModelsRef.current = desktopModels;
  useEffect(() => {
    if (!pollEligible) return;
    let cancelled = false;
    // The resident model swaps lazily (a profile change takes effect on the next query), so
    // App's /status/models snapshot (the sidebar footer chip) goes stale the moment the
    // resident state/profile moves. Announce each transition so App re-reads it and the
    // footer chip keeps naming the same model as this page's header chip.
    // Seeded from App's own snapshot so a swap that happened while Chat was not mounted
    // (or during startup warmup) is announced on the first poll instead of waiting for
    // the next transition.
    const residentKey = (r: ModelStatus['resident'] | undefined): string =>
      r ? `${r.state}|${r.profile ?? ''}` : '';
    // A missing snapshot (App's boot fetch failed) or one without a resident counts as '' so the
    // first successful poll that reports a resident notifies once.
    let lastResident: string = residentKey(desktopModelsRef.current?.resident);
    const poll = (): void => {
      void fetchModelStatus(desktopSession)
        .then((status) => {
          if (cancelled) return;
          setModelLoad(status.resident ?? null);
          const key = residentKey(status.resident);
          if (lastResident !== key) notifyDesktopModelsChanged();
          lastResident = key;
        })
        .catch(() => {
          // Transient poll failure (PRR-204): KEEP the last-known state — a
          // hiccup during a heavy load must not fail the gate open. The next
          // successful poll (2s) corrects; a failure on the very first poll
          // leaves null, which never gates (older backends stay inert).
        });
    };
    poll();
    const id = setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollEligible, desktopSession]);
  // Elapsed counter for the loading banner (1s tick only while loading).
  useEffect(() => {
    if (!isModelLoading) return undefined;
    const id = setInterval(() => setModelLoadNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [isModelLoading]);  const [clearConfirmState, setClearConfirmState] = useState<'idle' | 'confirming'>('idle');
  const tokenStreamManagerRef = useRef<TokenStreamManager | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last sent turn (text + raw image bytes) so Regenerate can re-run it.
  const lastTurnRef = useRef<{ text: string; images?: AttachedImage[] } | null>(null);
  // Current input draft, mirrored from ChatInput so the Ctrl+Enter shortcut can
  // send it without ChatPage owning the textarea state.
  const draftRef = useRef('');

  // Mirror of the current messages so async callbacks (onToken) can read the
  // latest array without placing side effects inside a state updater. NOTE
  // (S1): onDone/onError do NOT read this ref — they read the owningMessages
  // snapshot captured at send time, so switching conversations mid-stream
  // cannot overwrite the switched-FROM conversation with the switched-TO
  // conversation's messages.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // D7 (issue #83): the pin is read through a ref at SEND time (same pattern
  // as messagesRef) so runGeneration needs no pinnedSlide dependency and an
  // Explain click always attaches the pin as of the click, never a stale
  // closure from an earlier render.
  const pinnedSlideRef = useRef<PinnedSlide | null | undefined>(pinnedSlide);
  pinnedSlideRef.current = pinnedSlide;

  // S1: cancel any in-flight stream when the active conversation changes (a
  // non-empty→non-empty switch). This is ADDITIVE to the existing
  // non-empty→empty New-Chat guard below; both must be preserved.
  const prevConversationIdRef = useRef(currentConversationId);
  // F1 (reviewer): owning-conversation-id ref for the in-flight stream. Set
  // synchronously at send time and updated synchronously in the send-time
  // save's onCreate callback, so runGeneration's onDone/onError read the
  // CURRENT owning id (which may have just been created) rather than a stale
  // closure value. Without this, a first-turn send captures
  // owningConversationId===undefined and onDone later saves with undefined →
  // a DUPLICATE conversation is created.
  const owningConversationIdRef = useRef<string | undefined>(currentConversationId);
  // Issue #118: live mirror of the current conversation id for the terminal
  // stream callbacks. On a first turn the conversation id is adopted mid-send
  // (below) AFTER runGeneration's memoized closure captured undefined — a
  // closure compare in onDone/onError would then fail forever and the
  // done-payload fields (sources/citations/grounding/learn) would never reach
  // the live UI. Same pattern as pinnedSlideRef (D7): read through a ref so
  // the check reflects the CURRENT conversation, never a stale closure.
  const currentConversationIdRef = useRef<string | undefined>(currentConversationId);
  currentConversationIdRef.current = currentConversationId;
  // PRR-001: owning-messages ref for the in-flight stream. Mirrors runGeneration's
  // local `snapshot` (the owning conversation's messages, updated on each token)
  // so the switch / unmount / engine-switch effects can read the OWNING
  // conversation's partial turn — NOT the live `messagesRef`, which a mid-stream
  // conversation switch reassigns to the switched-TO conversation's messages
  // (and which the messagesRef-mirror passive effect clobbers before the switch
  // effect's create runs). Parallels owningConversationIdRef. nulled when the
  // stream finalizes so stale data can't be re-persisted after completion.
  const owningMessagesRef = useRef<ChatMessage[] | null>(null);
  const cancelActiveStream = useCallback(() => {
    if (tokenStreamManagerRef.current) {
      tokenStreamManagerRef.current.cancel();
      tokenStreamManagerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // S7: also interrupt the LLM engine directly. web-llm's `signal` field is
    // inert at runtime (web-llm-service wires an abort→interruptGenerate
    // listener as the real mechanism), so the AbortController above is not
    // sufficient for WebGPU generation. WllamaService.interrupt aborts its real
    // internal controller (harmless + desired). interrupt() is on the
    // LLMService interface (types/llm.ts) and both services implement it.
    try {
      getLLMService(browserEngine).interrupt();
    } catch (err) {
      console.warn('[ChatPage] LLM interrupt failed during stream cancel', err);
    }
    setTurnStopped(true);
    setIsLoading(false);
  }, [browserEngine]);

  useEffect(() => {
    if (prevConversationIdRef.current !== currentConversationId && tokenStreamManagerRef.current) {
      // A conversation switch happened while a stream is active. Finalize the
      // in-flight assistant message (S3: clear isStreaming so no blinking
      // cursor), PERSIST the partial turn to the OWNING conversation id
      // (PRR-001: previously this did not save, and cancel() never fires
      // onDone/onError, so the partial answer was irrecoverably lost), then
      // cancel the stream. The owning id is read from the ref (captured at
      // send time) so the save targets the conversation that produced the
      // turn, NOT the switched-to one. Mirrors handleCancel + the engine-
      // switch effect.
      const owningId = owningConversationIdRef.current;
      // PRR-001: read the OWNING conversation's messages from the owning
      // snapshot ref (captured at send time, updated per token) — NOT the live
      // messagesRef, which a mid-stream switch has already reassigned to the
      // switched-TO conversation's messages.
      const owningMessages = owningMessagesRef.current ?? messagesRef.current;
      const finalized = owningMessages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg
      );
      messagesRef.current = finalized;
      setMessages(finalized);
      onSaveConversation(owningId, finalized, conversationStorageTag(mode), browserEngine);
      // Clear the owning snapshot so a later switch can't re-persist it.
      owningMessagesRef.current = null;
      cancelActiveStream();
    }
    prevConversationIdRef.current = currentConversationId;
  }, [currentConversationId, cancelActiveStream, setMessages, onSaveConversation, mode, browserEngine]);

  const isBrowserMode = mode === 'browser-local';
  // The local browser model gates input only when it is the generator.
  const isModelBlocked = isBrowserMode && !isModelReady && !browserExternal && !desktopExternal;
  const isInputDisabled = isLoading || isModelBlocked || isModelLoading;
  // U8c: image upload requires the multimodal wllama engine AND the loaded
  // model's actual image-modality support. The previous check only verified
  // engine name + readiness, so a wllama build with a packaged GGUF but a
  // missing/broken mmproj would allow image attach then fail at generate().
  // supportsImages() consults wllama's supportInputModality('image'). Guarded
  // with try/catch because the service singleton may not be initialized yet.
  const engineSupportsImages = useMemo(() => {
    if (!isBrowserMode || browserExternal || desktopExternal || browserEngine !== 'wllama' || !isModelReady) return false;
    try {
      const svc = getLLMService(browserEngine);
      return typeof svc.supportsImages === 'function' ? svc.supportsImages() : false;
    }
    catch { return false; }
  }, [isBrowserMode, browserExternal, desktopExternal, browserEngine, isModelReady]);
  const canAttachImages = engineSupportsImages;

  // Abort any in-flight generation on a genuine engine switch — NOT on unmount.
  // Disposal of the OLD engine singleton itself now lives in
  // InferenceModeContext's setBrowserEngine, since that context is mounted for
  // the app's entire lifetime and survives ChatPage unmount/remount — whereas
  // this component only sees an engine change on the rare occasion it stays
  // mounted across one (in practice, engine changes happen from SettingsPage,
  // which unmounts ChatPage first). Kept here defensively, but note the actual
  // ordering: setBrowserEngine's disposeBrowserEngine() call runs synchronously
  // in the SettingsPage onClick/onChange handler, BEFORE React even schedules a
  // re-render — so it runs BEFORE this effect, not after. This abort only fires
  // once React commits the re-render and flushes effects, i.e. AFTER dispose
  // has already happened. That ordering doesn't currently cause a crash because
  // WllamaService's and WebLLMService's dispose paths are self-guarding against
  // being called while a generation or init is still in flight — but that's a
  // property of those services, not an ordering guarantee provided here. (PR #28
  // PRR-010, issue #21 F-LEAK; Stage B review corrected the prior inaccurate
  // "BEFORE the context's dispose call runs" claim)
  //
  // Declared BEFORE the readiness effect below so on an engine switch React
  // runs this effect's body (abort old) before re-checking readiness for the
  // new engine.
  const prevEngineRef = useRef(browserEngine);
  useEffect(() => {
    const prev = prevEngineRef.current;
    prevEngineRef.current = browserEngine;
    if (mode === 'browser-local' && prev !== browserEngine) {
      // S2/S3: finalize the in-flight assistant message and persist the
      // partial turn before aborting, so an engine switch doesn't discard
      // minutes of generation or leave a blinking cursor. PRR-001: read the
      // OWNING conversation's id + messages from the send-time refs so an
      // engine switch mid-stream persists the turn that was actually in flight
      // (the live currentConversationId / messagesRef are the engine-switch
      // view, which is correct here because an engine switch doesn't change the
      // active conversation, but using the owning refs is consistent with the
      // switch + unmount paths and resilient to ordering).
      const owningId = owningConversationIdRef.current ?? currentConversationId;
      const owningMessages = owningMessagesRef.current ?? messagesRef.current;
      const finalized = owningMessages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg
      );
      if (owningMessages.some((m) => m.isStreaming)) {
        messagesRef.current = finalized;
        setMessages(finalized);
        onSaveConversation(owningId, finalized, 'wllama', prev);
        owningMessagesRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (tokenStreamManagerRef.current) {
        tokenStreamManagerRef.current.cancel();
        tokenStreamManagerRef.current = null;
      }
      setTurnStopped(true);
      setIsLoading(false);
    }
  }, [browserEngine, mode, currentConversationId, onSaveConversation, setMessages]);

  // Evaluate model readiness for the selected engine when entering browser-local
  // mode or switching engines. This drives `isModelReady` (and the input gate)
  // engine-awarely — e.g. wllama unblocks on no-WebGPU hardware once its packaged
  // model is present, without waiting for a (blocked) first query.
  useEffect(() => {
    if (mode === 'browser-local') {
      void ensureReadinessGateChecked(browserEngine);
    }
  }, [mode, browserEngine]);

  // The gate's Retry (PRR-151-015): one re-check at a time. While it runs the
  // overlay's Retry is `loading` (aria-disabled: presses are ignored, focus stays;
  // a click is a discrete event, so the busy state renders before the next one),
  // and readiness-gate's latest-request guard keeps an older in-flight check from
  // overwriting this one's result.
  // Busy ends only when BOTH the Retry's own check has settled AND no newer check is
  // in flight (PR #151 final review LOW-3): a reset + re-check from elsewhere (the
  // WebGPU watchdog, Settings) supersedes the Retry's check, which then settles
  // early while the newest check still runs. readiness-gate announces its in-flight
  // state (READINESS_IN_FLIGHT_EVENT); either completion order releases busy.
  const [gateRetrying, setGateRetrying] = useState(false);
  const retryPendingRef = useRef(false);
  const readinessInFlightRef = useRef(false);
  useEffect(() => {
    const onInFlight = (event: Event): void => {
      readinessInFlightRef.current = (event as CustomEvent<ReadinessInFlightDetail>).detail?.inFlight === true;
      if (!readinessInFlightRef.current && !retryPendingRef.current) setGateRetrying(false);
    };
    window.addEventListener(READINESS_IN_FLIGHT_EVENT, onInFlight);
    return () => window.removeEventListener(READINESS_IN_FLIGHT_EVENT, onInFlight);
  }, []);
  const retryReadinessCheck = useCallback(() => {
    retryPendingRef.current = true;
    setGateRetrying(true);
    resetReadinessCache();
    void Promise.resolve(ensureReadinessGateChecked(browserEngine)).finally(() => {
      retryPendingRef.current = false;
      if (!readinessInFlightRef.current) setGateRetrying(false);
    });
  }, [browserEngine]);

  // Cleanup on unmount — finalize + persist the in-flight turn (S2/S3) before
  // releasing resources. Reads from refs (not closure state) so the latest
  // values are used even though the effect has an empty dep array.
  const persistOnUnmountRef = useRef<(messages: ChatMessage[], owningId: string | undefined) => void>(() => {});
  persistOnUnmountRef.current = (messages, owningId) => {
    onSaveConversation(owningId, messages, conversationStorageTag(mode), browserEngine);
  };
  // S2/S3 + PRR-001 unblock: dep array is `[]` so the cleanup fires ONLY on a
  // genuine unmount, NOT on every conversation switch. Previously the dep was
  // `[currentConversationId]`; because React runs pending effect DESTROYS
  // before CREATES on a dep change, that cleanup ran BEFORE the switch
  // effect's create on an A->B switch — nulling `tokenStreamManagerRef.current`
  // first and making the PRR-001 switch-effect persist line unreachable (dead
  // code). With `[]`, the switch effect owns mid-stream persistence on a
  // conversation switch; this cleanup owns only true unmount. Reads from refs
  // (owningConversationIdRef + owningMessagesRef, both kept fresh) so the `[]`
  // dep is safe — no stale closure values.
  useEffect(() => {
    return () => {
      // S2/S3: if a stream was in flight, finalize flags + persist so unmount
      // (e.g. navigating away mid-generation) doesn't discard the turn or leave
      // a blinking cursor persisted.
      if (tokenStreamManagerRef.current !== null) {
        const owningId = owningConversationIdRef.current;
        const owningMessages = owningMessagesRef.current ?? messagesRef.current;
        const finalized = owningMessages.map((msg) =>
          msg.isStreaming ? { ...msg, isStreaming: false } : msg
        );
        persistOnUnmountRef.current(finalized, owningId);
      }
      if (clearTimeoutRef.current !== null) {
        clearTimeout(clearTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (tokenStreamManagerRef.current !== null) {
        tokenStreamManagerRef.current.dispose();
        tokenStreamManagerRef.current = null;
      }
    };
  }, []);

  // Run a query for an existing assistant placeholder message. Shared by send +
  // regenerate. `images` carry the raw bytes (not stored on ChatMessage), so
  // regenerate captures them via lastTurnRef.
  //
  // S1 fix: `owningConversationId` + `owningMessages` are captured at send
  // time and threaded through so onDone/onError read from the SNAPSHOT, never
  // from the live messagesRef (which reassigns on a conversation switch). This
  // is what prevents a mid-stream switch from overwriting the switched-FROM
  // conversation with the switched-TO conversation's messages.
  const runGeneration = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    assistantMessageId: string,
    _owningConversationId: string | undefined,
    owningMessages: ChatMessage[]
  ) => {
    // Create TokenStreamManager for this request
    const streamManager = new TokenStreamManager(
      desktopSession !== null
        ? DESKTOP_FIRST_BYTE_TIMEOUT_MS
        : DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    );
    tokenStreamManagerRef.current = streamManager;

    // A local accumulator for the owning snapshot. onToken writes to BOTH the
    // live messagesRef (for live UI updates of the active conversation) AND
    // this snapshot (so onDone/onError persist the correct messages even if
    // the user switched conversations mid-stream). PRR-001: the snapshot is
    // ALSO mirrored onto owningMessagesRef so the switch / unmount / engine-
    // switch effects can read the OWNING conversation's partial turn (the live
    // messagesRef is clobbered by a mid-stream switch + the messagesRef-mirror
    // passive effect before those effects' create runs).
    let snapshot = owningMessages;
    owningMessagesRef.current = snapshot;

    // Wire token callback - append tokens to assistant message.
    // Compute the next array from messagesRef (the always-current mirror),
    // commit it to the ref synchronously, and set state with the value form
    // (no updater function) so React never double-invokes a side-effect.
    streamManager.onToken((token) => {
      const next = messagesRef.current.map((msg) =>
        msg.id === assistantMessageId
          ? { ...msg, content: msg.content + token, timestamp: Date.now() }
          : msg
      );
      messagesRef.current = next;
      setMessages(next);
      // Mirror into the snapshot so the final save reflects every token.
      snapshot = next;
      owningMessagesRef.current = snapshot;
    });

    // Wire done callback - finalize message with sources.
    // TokenStreamManager.complete() flushes the token buffer (firing onToken)
    // and then invokes onDone synchronously in the same call stack, so the
    // snapshot already reflects every streamed token here. Read from the
    // snapshot (NOT messagesRef) so a mid-stream switch cannot mis-target.
    streamManager.onDone((data) => {
      const updated = snapshot.map((msg) =>
        msg.id === assistantMessageId
          ? {
              ...msg,
              isStreaming: false,
              sources: data.sources,
              // Structured citations (F7). Two surfaces: the Electron/SSE
              // done event carries the contract's pack-attributed `citations`
              // (C7, issue #74 — mapped via the citationsToRefs choke point so
              // pack provenance cannot be dropped), while the browser-RAG
              // surface carries retrieval `chunks` (mapped explicitly so the
              // retrieval-only `score` field is not persisted into the
              // message / Dexie, PRR-008). Either way the array stays in
              // context order so pill [i+1] maps to entry i.
              citations: citationsFromDone(data),
              // C5 (issue #72): provenance from either surface (badge input).
              grounding: data.grounding,
              // D6 (issue #82): Learn-panel rows from either surface.
              learn: data.learn,
              abstain: data.abstain,
              abstainReason: data.abstainReason,
              retrievalDegraded: data.retrievalDegraded,
            }
          : msg
      );
      snapshot = updated;
      // PRR-001: keep the ref in sync, then null it once the turn is finalized
      // so a later switch/unmount/engine-switch can't re-persist a completed
      // turn (the stream manager ref is also nulled below).
      owningMessagesRef.current = snapshot;
      // F1: read the owning id from the REF (updated synchronously by the
      // send-time save's onCreate callback when a first-turn conversation is
      // created), NOT the captured `owningConversationId` param — which is
      // undefined on a first turn and would cause a duplicate conversation.
      const liveOwningId = owningConversationIdRef.current;
      // Only update live UI state if the user is still on the owning
      // conversation; otherwise leave the switched-to view untouched. The
      // comparison reads the live mirror ref (#118): the closure-captured
      // currentConversationId goes stale on a first turn, where the id is
      // adopted mid-send after this closure was created.
      if (currentConversationIdRef.current === liveOwningId) {
        messagesRef.current = updated;
        setMessages(updated);
      }
      // Save to Dexie — always to the OWNING id (S1).
      onSaveConversation(liveOwningId, updated, conversationStorageTag(mode), browserEngine);
      if (tokenStreamManagerRef.current === streamManager) {
        setIsLoading(false);
        tokenStreamManagerRef.current = null;
        owningMessagesRef.current = null;
      }
    });

    // Wire error callback. Like onDone, onError fires synchronously after
    // flushBuffer() inside TokenStreamManager.error(), so read from snapshot.
    // S6: set the structured `error` field instead of injecting into content.
    streamManager.onError((errorMessage) => {
      const updated = snapshot.map((msg) =>
        msg.id === assistantMessageId
          ? { ...msg, error: errorMessage, isStreaming: false }
          : msg
      );
      snapshot = updated;
      owningMessagesRef.current = snapshot;
      const liveOwningId = owningConversationIdRef.current;
      if (currentConversationIdRef.current === liveOwningId) {
        messagesRef.current = updated;
        setMessages(updated);
      }
      // S2: persist the errored turn to the OWNING id so the partial answer +
      // user question survive (the save layer strips isStreaming — S3).
      onSaveConversation(liveOwningId, updated, conversationStorageTag(mode), browserEngine);
      if (tokenStreamManagerRef.current === streamManager) {
        setIsLoading(false);
        tokenStreamManagerRef.current = null;
        owningMessagesRef.current = null;
      }
    });

    // universal-provider-settings-overhaul: with the desktop backend on an
    // external engine, every turn goes to the backend regardless of the
    // renderer's local mode (the "Use external model" switch is the single
    // control; only the backend can reach the endpoint).
    // Lumen phase 5: the same predicate drives the header model chip, so the chip
    // always names the generator this branch actually uses.
    const toDesktopBackend = routesToDesktopBackend(mode, desktopSession !== null, desktopModels?.engine);
    if (toDesktopBackend) {
      // Desktop backend mode — SSE streaming via /ask/stream endpoint. Wrap
      // setup so a synchronous throw (e.g. URL validation) routes to onError
      // and clears the stream ref instead of wedging the send pipeline
      // permanently. (issue #21 F5, F9)
      // B9 (issue #67): the URL + per-launch token come from the desktop
      // session and auth travels via X-Desktop-Token (the loopback guard
      // rejects Bearer). settings-wiring-honesty (AC4): 'api' is the desktop
      // app's built-in backend only — the browser app has no API-server mode,
      // so there is no user-entered server URL to fall back to.
      if (desktopSession === null) {
        streamManager.error('The desktop backend is not available yet. Wait for it to start, then try again.');
        return;
      }
      const session = desktopSession;
      void (async () => {
        // F-012 (PR #142 Stage B): with the backend on an external model in
        // Direct chat (external.grounded=false), retrieval-grounded answers
        // must not ride along to the external endpoint. The backend's own
        // settings are read fresh for every send; a failed read excludes
        // them (fail closed).
        const history = await buildDesktopHistorySnapshot(session.apiClient, owningMessages);
        // Stopped, or superseded by a newer send, while the settings loaded.
        if (tokenStreamManagerRef.current !== streamManager) return;
        try {
          // Issue #40 RC1: thread conversation history into the desktop backend
          // request so api mode benefits from multi-turn memory + retrieval
          // rewriting too. The desktop backend's /ask/stream accepts and validates
          // `history` (at most 20 turns; parseQuestionRequest in
          // desktop/main/backend/server.ts).
          streamManager.startSSEStream(
            session.sseUrl(),
            { question: text, history },
            session.token,
            'X-Desktop-Token'
          );
        } catch (err) {
          streamManager.error(err instanceof Error ? err.message : String(err));
        }
      })();
    } else {
      // Browser-local mode. The generator is the external endpoint when one
      // is enabled (universal-provider-settings-overhaul; browser app only —
      // inside Electron the backend owns external generation), else the local
      // engine singleton.
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const externalConfig = isElectron() ? null : loadExternalConfig();
      const externalService = externalConfig !== null ? createExternalLLMService(externalConfig) : null;

      if (externalService !== null && externalConfig !== null && !externalConfig.grounded) {
        // Opt-in Direct chat (AC13): ungrounded — no retrieval, labeled
        // "General knowledge". Conversation context (bounded by
        // buildHistorySnapshot, 4000 chars per history turn) IS threaded —
        // fail closed (F-012): only 'general' answers that showed no sources
        // or citations ride along, so an answer built from document passages
        // (or a Stopped, untagged one) never rides into an ungrounded turn.
        abortController.signal.addEventListener('abort', () => externalService.interrupt());
        (async () => {
          const wireMessages = [
            // F-004: the same system prompt the desktop backend sends.
            { role: 'system' as const, content: EXTERNAL_SYSTEM_PROMPT },
            ...buildHistorySnapshot(owningMessages, { excludeGrounded: true }).map((turn) => ({
              role: turn.role,
              content: turn.content.slice(0, 4000),
            })),
            { role: 'user' as const, content: text },
          ];
          const startTime = Date.now();
          let fullAnswer = '';
          try {
            for await (const delta of externalService.generate(wireMessages, {
              ...presetOptions(ragPreset),
              signal: abortController.signal,
            })) {
              if (abortController.signal.aborted) return;
              if (tokenStreamManagerRef.current !== streamManager) return;
              fullAnswer += delta;
              streamManager.pushToken(delta);
            }
            if (abortController.signal.aborted) return;
            if (tokenStreamManagerRef.current !== streamManager) return;
            streamManager.complete({
              sources: [],
              // Ungrounded by design: never emit 'grounded' provenance here.
              grounding: 'general',
              contextLength: fullAnswer.length,
              inferenceTime: Date.now() - startTime,
            });
          } catch (error) {
            if (abortController.signal.aborted) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            streamManager.error(error instanceof Error ? error.message : 'External model request failed');
          }
        })();
        return;
      }

      // RAG pipeline AsyncGenerator (grounded). The local LLM service
      // singleton is fetched uninitialized from the factory; we MUST
      // initialize it before the orchestrator calls generate(), otherwise
      // generate() throws "not initialized" and the assistant bubble shows the
      // raw error (issue #21 F1). initialize() is idempotent — fast no-op when
      // the model is already loaded — so calling it on every send is safe. An
      // external generator needs no local load at all.
      const llmService = externalService ?? getLLMService(browserEngine);
      const initModelId = browserEngine === 'wllama' ? LLM_MODEL_DIR : WEBLLM_DEFAULT_MODEL_ID;
      if (externalService !== null) {
        abortController.signal.addEventListener('abort', () => externalService.interrupt());
      }

      (async () => {
        try {
          if (externalService !== null) {
            await externalService.initialize();
          } else {
            // Ensure the model is loaded before the pipeline touches
            // generate(). Route real load progress into the overlay so a cold
            // first send shows progress instead of an apparent hang.
            setModelLoadingProgress(0);
            await llmService.initialize(initModelId, (p) => {
              if (tokenStreamManagerRef.current !== streamManager) return;
              setModelLoadingProgress(Math.min(100, Math.max(0, Math.round((p.progress ?? 0) * 100))));
            });
          }
          if (abortController.signal.aborted) return;
          if (tokenStreamManagerRef.current !== streamManager) return;

          const orchestrator = new RAGOrchestrator({ llmService });
          let fullAnswer = '';
          const startTime = Date.now();
          let sources: string[] = [];

          // D7 (issue #83): attach the pinned-slide context iff a LIVE pin is
          // active (stale pins never attach — AC5/C5). Read from the ref so
          // the value is the pin as of THIS send. The api-mode branch above
          // intentionally sends nothing pinned: the frozen QuestionRequest
          // contract has no such field (server-side parity is the issue's
          // named follow-up).
          const activePinnedSlide = pinnedSlideRef.current;
          const pinnedContext =
            activePinnedSlide && activePinnedSlide.stale !== true
              ? composePinnedContext(activePinnedSlide)
              : undefined;
          for await (const event of orchestrator.query(text, {
            ...presetOptions(ragPreset),
            signal: abortController.signal,
            images: images?.map((img) => ({ data: img.data, mimeType: img.mimeType })),
            // Issue #40 RC1: thread prior conversation turns for multi-turn
            // memory + retrieval contextualization (RC3).
            history: buildHistorySnapshot(owningMessages),
            pinnedContext,
            // F-004: an external generator gets the desktop's prompt text
            // (system prompt + grounded framing); local engines keep theirs.
            ...(externalService !== null
              ? {
                  systemPrompt: EXTERNAL_SYSTEM_PROMPT,
                  groundedFraming: {
                    instruction: EXTERNAL_GROUNDED_INSTRUCTION,
                    questionLabel: EXTERNAL_GROUNDED_QUESTION_LABEL,
                  },
                }
              : {}),
          })) {
            if (abortController.signal.aborted) return;
            if (tokenStreamManagerRef.current !== streamManager) return;

            switch (event.type) {
              case 'token':
                fullAnswer += event.data;
                streamManager.pushToken(event.data);
                break;
              case 'complete':
                sources = event.data.sources;
                streamManager.complete({
                  sources,
                  chunks: event.data.chunks,
                  grounding: event.data.grounding,
                  learn: event.data.learn,
                  abstain: event.data.abstain,
                  abstainReason: event.data.abstainReason,
                  retrievalDegraded: event.data.retrievalDegraded,
                  contextTrimmed: event.data.contextTrimmed,
                  contextLength: fullAnswer.length,
                  inferenceTime: Date.now() - startTime,
                });
                break;
              case 'error': {
                // Only embedding/generation failures are fatal. The orchestrator
                // treats vector/keyword/rerank/rrf errors as recoverable (it
                // yields the error and continues); mirror that here so a single
                // retrieval hiccup doesn't kill a response that could degrade
                // gracefully (issue #21 F11).
                const stage = (event.data as { stage?: string }).stage;
                if (stage === 'embedding' || stage === 'generation') {
                  streamManager.error((event.data as { message: string }).message);
                  return;
                }
                console.warn(
                  `[ChatPage] Recoverable RAG stage failed: ${stage}`,
                  (event.data as { message?: string }).message
                );
                break;
              }
            }
          }
        } catch (error) {
          // A failed or aborted load must not leave a stale 0 < progress < 100 behind
          // (InferenceModeToggle would keep saying "Loading…"). Skip the reset only when a
          // newer stream has taken over the shared progress value.
          if (tokenStreamManagerRef.current === streamManager || tokenStreamManagerRef.current === null) {
            setModelLoadingProgress(0);
          }
          if (error instanceof DOMException && error.name === 'AbortError') {
            return; // User cancelled — no error message needed
          }
          const message = error instanceof Error ? error.message : 'RAG pipeline failed';
          streamManager.error(message);
        }
      })();
    }
  }, [mode, desktopSession, desktopModels, browserEngine, ragPreset, onSaveConversation, setModelLoadingProgress, currentConversationId, setMessages]);

  const handleSend = useCallback(async (text: string, attachedImages?: AttachedImage[]) => {
    // Prevent overlapping streams
    if (tokenStreamManagerRef.current) return;

    // B9 first-run gate: with a real engine and no staged models the first
    // /ask would 503 — the informative overlay is shown instead.
    if (desktopModelBlocked) return;

    // Capture the turn so Regenerate can re-run it (images carry raw bytes).
    lastTurnRef.current = { text, images: attachedImages };

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      images: attachedImages?.map((img) => ({
        id: img.id,
        dataUrl: img.dataUrl,
        mimeType: img.mimeType,
        fileName: img.fileName,
      })),
    };

    const assistantMessageId = generateId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    // S5: keep the FULL history in state (windowing is render-only, handled in
    // ChatMessageList). Previously this pruned to MAX_MESSAGES at send time,
    // which then got persisted wholesale — deleting old messages from
    // IndexedDB. Persistence now always sees the full array.
    const appended = [...messagesRef.current, userMessage, assistantMessage];
    messagesRef.current = appended;
    setMessages(appended);
    setTurnStopped(false);
    setIsLoading(true);

    // S1+S2: capture the owning conversation id + snapshot at send time, and
    // persist the user message + placeholder immediately so the turn survives
    // any later interruption (Stop, error, close, switch). For a first turn
    // with no current conversation, create one and adopt its id as the owning
    // id (H4 + F1: prevents a duplicate conversation when onDone later saves).
    //
    // F1 (corrected): the send-time save is AWAITED so the owning id ref is
    // set BEFORE runGeneration starts. The prior approach set the ref
    // synchronously and relied on saveMessages' onCreate callback to update
    // it — but onCreate fires inside the async saveMessages after two awaits
    // (a microtask), so on a fast-complete first turn (warm model / zero-doc
    // abstain) onDone fired before onCreate resolved, read undefined, and
    // created a duplicate conversation. Awaiting the save guarantees ordering.
    owningConversationIdRef.current = currentConversationId;
    let resolvedOwningId = currentConversationId;
    try {
      await onSaveConversation(
        currentConversationId,
        appended,
        conversationStorageTag(mode),
        browserEngine,
        (newId) => {
          // First-turn creation: adopt the new id as both the owning id (for
          // this stream's saves, via the ref) and the active conversation.
          if (currentConversationId === undefined) {
            resolvedOwningId = newId;
          }
        }
      );
    } catch (err) {
      console.error('[ChatPage] Send-time persistence failed; streaming will proceed without a guaranteed owning id.', err);
    }
    if (resolvedOwningId !== currentConversationId) {
      owningConversationIdRef.current = resolvedOwningId;
      // Issue #118: mirror the adopted id into the live ref synchronously so
      // the terminal callbacks' guard is correct even if no re-render has
      // interleaved between the send-time save and done/error firing.
      currentConversationIdRef.current = resolvedOwningId;
      setCurrentConversationId(resolvedOwningId);
    }

    runGeneration(text, attachedImages, assistantMessageId, resolvedOwningId, appended);
  }, [runGeneration, onSaveConversation, mode, browserEngine, currentConversationId, setCurrentConversationId, desktopModelBlocked]);

  // Re-run the most recent user turn, replacing the last assistant response.
  const handleRegenerate = useCallback(() => {
    if (tokenStreamManagerRef.current) return; // a stream is in flight
    const last = lastTurnRef.current;
    if (!last) return;

    const assistantMessageId = generateId();
    const regenerated = messagesForRegenerate(messagesRef.current, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    });
    messagesRef.current = regenerated;
    setMessages(regenerated);
    setTurnStopped(false);
    setIsLoading(true);
    // F1: regenerate re-uses the current conversation; set the owning ref so
    // runGeneration's saves target it.
    owningConversationIdRef.current = currentConversationId;
    runGeneration(last.text, last.images, assistantMessageId, currentConversationId, regenerated);
  }, [runGeneration, currentConversationId]);

  const handleCancel = useCallback(() => {
    // Capture owning id BEFORE cancel (it's from state, survives cancel).
    const owningId = currentConversationId;

    cancelActiveStream();

    // PRR-005: read messagesRef.current AFTER cancelActiveStream so the
    // cancel-flushed tail tokens (S4: cancel() flushes the buffer via onToken
    // before clearing) are included. Previously the snapshot was captured
    // before cancel, so finalized was derived from a stale array and the
    // cancel-flushed tokens were lost from both UI and persistence.
    const finalized = messagesRef.current.map((msg) =>
      msg.isStreaming ? { ...msg, isStreaming: false } : msg
    );
    messagesRef.current = finalized;
    setMessages(finalized);
    onSaveConversation(owningId, finalized, conversationStorageTag(mode), browserEngine);
    // PRR-001: the in-flight turn is finalized; clear the owning snapshot so a
    // later switch/unmount/engine-switch can't re-persist it.
    owningMessagesRef.current = null;
  }, [cancelActiveStream, currentConversationId, onSaveConversation, mode, browserEngine]);

  // If messages are cleared while a stream is in flight (e.g. the sidebar
  // "New Chat" button calls newChat() in App, which empties currentMessages
  // without going through ChatPage), cancel the orphaned stream so its
  // callbacks don't fire against the cleared state and resources are released.
  // Only react to a non-empty → empty transition so this never cancels a
  // stream that was started while the view was already empty (e.g. the render
  // window between handleSend setting the stream ref and the messages prop
  // updating).
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    const prev = prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;
    if (prev > 0 && messages.length === 0 && tokenStreamManagerRef.current) {
      cancelActiveStream();
    }
  }, [messages.length, cancelActiveStream]);

  const handleClearClick = useCallback(() => {
    if (clearConfirmState === 'idle') {
      setClearConfirmState('confirming');
      clearTimeoutRef.current = setTimeout(() => {
        setClearConfirmState('idle');
        clearTimeoutRef.current = null;
      }, 3000);
    } else if (clearConfirmState === 'confirming') {
      // Second click - clear messages
      if (clearTimeoutRef.current !== null) {
        clearTimeout(clearTimeoutRef.current);
        clearTimeoutRef.current = null;
      }
      // Cancel any in-flight stream so its callbacks don't fire against the
      // cleared state and resources are released immediately.
      cancelActiveStream();
      setMessages([]);
      messagesRef.current = [];
      onNewChat();
      lastTurnRef.current = null; // no turn to regenerate after clearing
      setClearConfirmState('idle');
    }
  }, [clearConfirmState, cancelActiveStream, onNewChat]);

  // Keyboard shortcuts — ChatPage registers the chat-scoped set (send/clear-chat
  // plus its own Ctrl+, handling for the model-blocked overlay's Open Settings
  // affordance). App.tsx's AppContent ALSO registers useKeyboardShortcuts with
  // only `onOpenSettings`, at the root, so Ctrl+, works from every page — while
  // on the Chat page there are therefore two window keydown listeners, and both
  // fire on Ctrl+,, but `openSettings` is idempotent (`setCurrentPage('settings')`
  // called twice with the same value), so the double-firing is harmless.
  // Ctrl+Enter sends the current draft; Ctrl+L clears; Ctrl+, opens Settings.
  useKeyboardShortcuts({
    onSendMessage: () => {
      const draft = draftRef.current.trim();
      // Mirror the ChatInput Send button's guard so Ctrl+Enter can't bypass
      // the model-blocked overlay or send while a response is in flight.
      // (PR #28 F-CTRL-ENTER-BYPASS)
      if (draft && !tokenStreamManagerRef.current && !isInputDisabled) {
        handleSend(draft);
      }
    },
    onClearChat: handleClearClick,
    onOpenSettings,
  });

  // Lumen phase 5 model chip: which generator answers the next turn, from the same
  // inputs runGeneration routes on (lib/chat/model-chip.ts documents each mode).
  const modelDescription = describeChatModel({
    mode,
    hasDesktopSession: desktopSession !== null,
    desktopModels,
    residentProfile: residentLoad?.profile ?? null,
    // Inside Electron the renderer's stored external config is not authoritative
    // (runGeneration ignores it there too).
    externalConfig: isElectron() ? null : externalConfigLive,
    browserEngine,
    wllamaModelId: LLM_MODEL_DIR,
    webllmModelId: WEBLLM_DEFAULT_MODEL_ID,
    // The model gate's own flag (isModelBlocked above), not a new probe.
    modelReady: isModelReady,
  });

  // Lumen phase 7: while either model gate is up, everything it covers (header,
  // banners, pinned slide, message list, composer) is inert: unreachable by Tab,
  // pointer and assistive tech. Scoped to this wrapper, NOT <main>: the shell's
  // sidebar/top bar stay usable (PR #147 PRR-022) and AppShell owns <main>'s own
  // inert for the nav drawer, so the two never touch the same element. Attribute
  // (not the typed prop) because React 18 has no `inert`; the gate Dialogs are
  // siblings of this wrapper, never inside it.
  const modelGateUp = desktopModelBlocked || isModelBlocked;
  // PRR-151-018: in an engine without native `inert` the attribute does nothing;
  // emulate its keyboard/AT effects there (no-op where inert is implemented).
  const gatedContentRef = useRef<HTMLDivElement>(null);
  useInertFallback(gatedContentRef, modelGateUp);
  // PRR-151-017: exactly ONE gate at a time. The desktop gate wins: handleSend
  // returns early on desktopModelBlocked in every inference mode, so it is the
  // gate that actually binds; the browser gate (reachable in Electron when
  // "In this window" is selected) would only stack a second alertdialog on it.
  const browserGateUp = isModelBlocked && !desktopModelBlocked;

  return (
    <div className="chat-page">
      <div ref={gatedContentRef} className="chat-page__content" {...(modelGateUp ? { inert: '' } : {})}>
      {/* Header (Lumen phase 5): model chip, desktop mode toggle, connection
          warning, then the conversation actions. */}
      <PageHeader
        title="Chat"
        actions={
          <div className="chat-header-actions">
            <ModelChip
              description={modelDescription}
              onOpenSettings={() => onOpenSettings(MODEL_CONNECTION_SECTION_ID)}
            />
            <InferenceModeToggle />
            {/* API mode warning */}
            {mode === 'api' && !isServerConnected && (
              <span title="The desktop backend is not reachable. Restart the app if this persists.">
                <StatusPill status="warning">Server not connected</StatusPill>
              </span>
            )}
            {messages.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => downloadConversation(messages, 'markdown')}
                  title="Export conversation as Markdown"
                  aria-label="Export conversation as Markdown"
                >
                  <Icon name="download" size={16} />
                  Export
                </Button>
                <Button
                  variant={clearConfirmState === 'confirming' ? 'danger' : 'ghost'}
                  size="sm"
                  onClick={handleClearClick}
                  disabled={isLoading}
                  aria-disabled={isLoading || undefined}
                  title={isLoading ? 'Cancel the active response before clearing' : 'Clear chat'}
                  data-state={clearConfirmState}
                >
                  <Icon name="trash" size={16} />
                  {clearConfirmState === 'confirming' ? 'Confirm Clear?' : 'Clear Chat'}
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* Issue #37 P3: COOP/COEP misconfiguration banner.
          Persistent per-session, dismissible. Shows when !crossOriginIsolated,
          which causes wllama and ORT to fall back to single-threaded WASM
          (~3-4x slower decode, minutes of TTFT on the target i5). */}
      <IsolationBanner />

      {/* D7 (issue #83): pinned "Ask about this slide" banner — shown in BOTH
          inference modes (C10); only browser-local mode injects its context
          into the query. A stale pin renders visibly marked (data-stale) and
          never attaches to questions. */}
      {pinnedSlide && (
        <PinnedSlideContext
          pinnedSlide={pinnedSlide}
          onDismiss={() => onDismissPinnedSlide?.()}
          onExplainThisStep={() => { void handleSend('Explain what this step does'); }}
        />
      )}

      {/* Message List */}
      <ChatMessageList
        messages={messages}
        isStreaming={isLoading}
        stopped={turnStopped}
        onRegenerate={!isLoading && lastTurnRef.current ? handleRegenerate : undefined}
        onSuggestedPrompt={(prompt) => handleSend(prompt)}
        onNavigateToDocuments={onNavigateToDocuments}
        onOpenTraining={onOpenTraining}
      />

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        isLoading={isLoading}
        onCancel={handleCancel}
        disabled={isInputDisabled}
        disabledReasonId={isModelLoading ? 'chat-model-loading-note' : undefined}
        imageUploadEnabled={canAttachImages}
        onDraftChange={(text) => { draftRef.current = text; }}
        status={
          /* Lumen phase 5 (design-language.md section 5): every chat status lives
             in the composer card's status row: the desktop resident-model load
             notice (#133; still the textarea's aria-describedby target) and the
             streaming indicator. */
          <>
            {isModelLoading && (
              <div
                data-testid="chat-model-loading"
                id="chat-model-loading-note"
                className="chat-notice"
              >
                {/* Only the STABLE sentence is a live region. The 1s-ticking elapsed
                    span stays OUTSIDE it (review PRR-222): text mutations inside a
                    polite live region are announced by screen readers, so a ticking
                    counter in here would drip announcements every second for the
                    whole multi-minute cold load. */}
                <span role="status" className="chat-notice__title">
                  Loading the AI model ({residentLoad?.profile ?? 'auto'} profile) — chat is disabled until it is ready.
                </span>
                <span aria-live="off">
                  Elapsed:{' '}
                  {residentLoad?.loadStartedAt != null
                    ? `${Math.max(0, Math.floor((modelLoadNow - residentLoad.loadStartedAt) / 1000))}s`
                    : '…'}
                  . This happens once per launch and typically takes a few minutes for the Quality model
                  (under a minute for Fast). You can keep using Documents and Training — your chat will be
                  ready here.
                </span>
              </div>
            )}
            {/* Streaming Indicator — U1: during a cold model load (multi-minute on
                target CPU hardware), show a determinate progress bar instead of the
                indeterminate "Generating" cursor so the load is visible. */}
            <StreamingIndicator
              isVisible={isLoading}
              modelLoadProgress={isLoading && modelLoadingProgress > 0 && modelLoadingProgress < 100 ? modelLoadingProgress : undefined}
              modelLoadLabel="Loading the AI model — one-time, may take a few minutes…"
            />
          </>
        }
      />
      </div>

      {/* Model loading blocking overlay.
          Engine-aware: shows the actual readiness failures/recommendations
          instead of a generic "please wait for download" message (which is
          actively wrong for wllama, where there is no download step — the real
          cause is usually missing packaged weights). Offers Retry and Open
          Settings actions. Extracted into ModelBlockedOverlay (issue #25), now a
          contained, non-modal Dialog (Lumen phase 7; the chat content is inert
          while it is up). (originally issue #21 F10) */}
      {/* B9 (issue #67): desktop first-run gate — real engine, no staged
          models. Blocks send with an informative state instead of a doomed
          /ask (AC5). Extracted component per the shared-file convention. */}
      <DesktopModelBlockedOverlay open={desktopModelBlocked} onOpenSettings={onOpenSettings} />

      {browserGateUp && (
        <ModelBlockedOverlay
          readinessResult={getReadinessResultSnapshot()}
          browserEngine={browserEngine}
          modelLoadingProgress={modelLoadingProgress}
          retrying={gateRetrying}
          onRetry={retryReadinessCheck}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
