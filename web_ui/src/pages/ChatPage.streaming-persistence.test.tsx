/**
 * ChatPage.streaming-persistence.test.tsx
 *
 * BLOCKING acceptance test for issue #36 / S1 fix: switch-mid-stream MUST NOT
 * corrupt conversation history.
 *
 * Scenario under test:
 *   1. Conversation A is selected. User sends a message; a browser-local
 *      (wllama) RAG stream begins and parks (the orchestrator awaits a gate).
 *   2. The parent re-renders ChatPage with currentConversationId="B" and B's
 *      messages (a conversation switch mid-stream).
 *   3. The in-flight stream then completes: the orchestrator yields `complete`
 *      and TokenStreamManager.complete() fires onDone synchronously.
 *
 * The S1 bug (now fixed) was that onDone/onError read the LIVE messagesRef
 * (which the switch had reassigned to B's messages) and a stale owning-id
 * closure (undefined on a first turn) — so A's persisted history was
 * overwritten with B's messages, AND a duplicate conversation was created.
 *
 * The fix threads an owning conversation id (owningConversationIdRef, captured
 * at send time) and an owning messages snapshot (local to runGeneration)
 * through to onDone/onError, so they NEVER read the live messagesRef.
 *
 * This test exercises the REAL ChatPage component and the REAL
 * TokenStreamManager (so the complete()→flushBuffer()→onDone path is real).
 * Only the LLM/RAG pipeline is mocked, with a deferred the test resolves to
 * control stream timing.
 *
 * Assertions (the S1 contract):
 *   - The completion (onDone) save targets conversation id "A" (the OWNING
 *     id), NOT "B" and NOT undefined.
 *   - The messages passed to that save contain A's user message (NOT B's).
 *   - No save call ever passes undefined as the conversation id (which would
 *     create a duplicate conversation).
 *   - setCurrentConversationId is NOT called to re-point back to A (the
 *     no-re-point-on-switch guard).
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ChatMessage } from '../types/chat';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';

// --- Module mocks (hoisted before the ChatPage import below) ----------------

// Mock the RAG orchestrator. The instance's `query` is configured per-test.
// We use a deferred-controlled AsyncGenerator so the test can park the stream
// across a conversation switch and then release completion.
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return { query: vi.fn() };
  }),
}));

// Mock the LLM factory so initialize() resolves immediately and interrupt()
// is a harmless no-op (the cancel-on-switch effect calls interrupt()).
vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
    supportsImages: vi.fn().mockReturnValue(false),
  })),
  DEFAULT_BROWSER_ENGINE: 'wllama',
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));

// Mock useInferenceMode so ChatPage renders in browser-local / wllama mode
// with the model already ready (no blocking overlay, no real context needed).
vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

// Mock the readiness gate so its module-level side effects don't run.
vi.mock('../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn().mockResolvedValue(null),
  getReadinessResultSnapshot: vi.fn().mockReturnValue(null),
  resetReadinessCache: vi.fn(),
}));

// Mock auth token getter (server-mode only; harmless in browser-local mode).
vi.mock('../lib/api/auth', () => ({
  getToken: vi.fn().mockReturnValue(null),
}));

// IMPORTANT: `../lib/streaming` is intentionally NOT mocked. We exercise the
// REAL TokenStreamManager so complete()→flushBuffer()→onDone is the real path.
import { ChatPage } from './ChatPage';
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as llmFactoryModule from '../lib/llm/llm-factory';

// --- Test helpers -----------------------------------------------------------

/** Build a deterministic chat message. */
function makeMessage(role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${role}-${content.replace(/\s+/g, '-').slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Build a deferred-controlled AsyncGenerator that:
 *   - yields one token immediately,
 *   - PARKS on `gate` until the test resolves it,
 *   - then yields a `complete` event.
 *
 * The orchestrator's real abort-signal check happens at the top of each
 * for-await iteration. By releasing the gate inside the same act() batch as
 * the conversation switch — and flushing microtasks before React flushes the
 * cancel-on-switch effect — we let the loop resume, yield `complete`, and
 * trigger TokenStreamManager.complete()→onDone BEFORE cancel() runs. onDone
 * then observes currentConversationId="B" (already flipped) but must save to
 * the OWNING id "A" with A's messages — the precise S1 regression scenario.
 */
function makeDeferredStream(gate: { promise: Promise<void>; resolve: () => void }): () => AsyncGenerator<RAGEvent> {
  return async function* (): AsyncGenerator<RAGEvent> {
    yield { type: 'token', data: 'A-token-' };
    await gate.promise;
    yield {
      type: 'complete',
      data: { answer: 'A-answer', sources: ['doc-a'], chunks: [] },
    };
  };
}

// --- Test suite -------------------------------------------------------------

describe('ChatPage S1: switch-mid-stream does not corrupt conversation history', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('onDone save targets owning conversation A with A messages (not B), no undefined id, no re-point', async () => {
    const gate = makeDeferred();

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeDeferredStream(gate));

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    // Conversation A starts with one existing user message; B is a different
    // conversation with its own user message.
    const aUserMsg = makeMessage('user', 'A-QUESTION');
    const bUserMsg = makeMessage('user', 'B-QUESTION');

    // Lifted-view harness so the test can flip currentConversationId + messages
    // to simulate the parent (App) switching conversations mid-stream.
    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [aUserMsg] };
    let forceRerender: () => void = () => {};

    function Harness() {
      const [, force] = React.useReducer((c: number) => c + 1, 0);
      React.useEffect(() => {
        forceRerender = () => force();
      });
      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    render(<Harness />);

    // --- Step 1: send a message in conversation A ---------------------------
    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'A-QUESTION' } });
      fireEvent.click(sendButton);
    });

    // Flush microtasks so initialize() resolves and the orchestrator loop
    // starts, emits the token, and parks on the gate.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Sanity: the send-time save fired synchronously in handleSend, targeting A.
    expect(onSaveConversation).toHaveBeenCalled();
    const sendTimeCall = onSaveConversation.mock.calls[0];
    expect(sendTimeCall[0]).toBe('A');

    // Sanity: the orchestrator query was issued with A's question.
    expect(orchestrator.query).toHaveBeenCalledWith(
      'A-QUESTION',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    // The stream is now parked on `gate`. Clear the mock so we can cleanly
    // isolate the COMPLETION save from the send-time save below.
    onSaveConversation.mockClear();
    setCurrentConversationId.mockClear();

    // --- Step 2 + 3: switch to B AND release the gate in the same act -------
    // Within this act():
    //   (a) flip the lifted view to B (schedules the cancel-on-switch effect),
    //   (b) release the gate so the orchestrator resumes,
    //   (c) flush microtasks so the async loop yields `complete`, which calls
    //       TokenStreamManager.complete() → flushBuffer() → onDone()
    //       SYNCHRONOUSLY. Because microtasks run before React's effect flush,
    //       onDone fires BEFORE cancelActiveStream() — so onDone observes
    //       currentConversationId="B" (flipped) but must save to owning "A".
    await act(async () => {
      view = { convId: 'B', messages: [bUserMsg] };
      forceRerender();
      gate.resolve();
      // Flush the orchestrator's async loop to completion.
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
      }
    });

    // Final flush of any remaining microtasks / React commits.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // === S1 ASSERTIONS =====================================================

    // The completion (onDone) save MUST have fired. onDone is the only path
    // that saves with the finalized assistant message carrying `sources`.
    const completionCalls = onSaveConversation.mock.calls.filter(([, messages]) => {
      // The completion save carries an assistant message with sources set.
      return (messages as ChatMessage[]).some(
        (m) => m.role === 'assistant' && Array.isArray(m.sources)
      );
    });
    expect(
      completionCalls.length,
      'completion (onDone) save must fire after the stream completes'
    ).toBeGreaterThanOrEqual(1);

    const lastCompletion = completionCalls[completionCalls.length - 1];
    const [completionId, completionMessages] = lastCompletion;

    // (1) The completion save targets the OWNING conversation A — NOT B and
    //     NOT undefined. This is the precise S1 regression: before the fix,
    //     onDone read owningConversationId===undefined (first turn) or the
    //     live-flipped id, and saved to B / created a duplicate.
    expect(completionId, 'completion save must target owning A, not B').toBe('A');
    expect(completionId, 'completion save must never use undefined id').toBeDefined();

    // (2) The saved messages must contain A's user message, NOT B's. This is
    //     the heart of S1: A's history is not overwritten with B's messages.
    const savedUserContents = (completionMessages as ChatMessage[])
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(savedUserContents, 'saved messages must contain A user question').toContain('A-QUESTION');
    expect(
      savedUserContents,
      'saved messages must NOT contain B user question (would mean B overwrote A)'
    ).not.toContain('B-QUESTION');

    // (3) NO save call across the whole interaction passed undefined as the
    //     conversation id (would create a duplicate conversation — the second
    //     half of the S1 bug).
    for (const [id] of onSaveConversation.mock.calls) {
      expect(id, 'no save may pass undefined conversation id').toBeDefined();
      expect(id, 'no save may target B (the switched-to conversation)').not.toBe('B');
    }

    // (4) No re-point-on-switch: setCurrentConversationId must NOT have been
    //     called to flip the active conversation back to A as a side effect of
    //     the in-flight stream completing.
    const rePointToA = setCurrentConversationId.mock.calls.filter(([id]) => id === 'A');
    expect(
      rePointToA.length,
      'setCurrentConversationId must not re-point back to owning A'
    ).toBe(0);
  });
});

/**
 * F1 regression: first-turn send (currentConversationId=undefined) with a
 * FAST-COMPLETE stream must NOT create a duplicate conversation.
 *
 * The F1 bug (now fixed) was that `handleSend` set
 * `owningConversationIdRef.current = currentConversationId` synchronously and
 * relied on `saveMessages`'s `onCreate` callback to update the ref when the
 * first-turn conversation was created. But `onCreate` fires inside the ASYNC
 * `saveMessages` after two awaits (a microtask), so on a fast-complete first
 * turn (warm model / zero-doc abstain that completes synchronously), `onDone`
 * fired before `onCreate` resolved, read
 * `owningConversationIdRef.current === undefined`, and created a SECOND
 * conversation.
 *
 * The fix makes `handleSend` `async` and AWAITS the send-time
 * `onSaveConversation(...)` call, capturing the resolved owning id
 * (`resolvedOwningId`) via the `onCreate` callback, THEN sets
 * `owningConversationIdRef.current = resolvedOwningId` and calls
 * `runGeneration`. This guarantees the ref is set to the created conversation's
 * id before any stream completion can fire.
 *
 * This test simulates the real `saveMessages` create behavior by invoking the
 * `onCreate` callback (5th arg) synchronously with a fresh id when
 * `conversationId === undefined`, and uses a fast-completing orchestrator
 * (yield a token, then immediately `complete` — no gate). The fast completion
 * would race the `onCreate` callback under the old synchronous-ref code path
 * and produce a duplicate conversation; under the fix the awaited send ensures
 * the ref is set first.
 */
describe('ChatPage F1: first-turn fast-complete does not create a duplicate conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // The S1 describe's afterEach calls vi.restoreAllMocks(), which strips the
    // mockImplementation set on getLLMService by the hoisted vi.mock() factory.
    // When this (second) describe runs, getLLMService() would otherwise return
    // undefined → the orchestrator IIFE throws on llmService.initialize() and
    // the stream never runs. Re-establish the factory mock here so the F1 test
    // is self-contained regardless of test ordering.
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      supportsImages: vi.fn().mockReturnValue(false),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);

    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('completion save targets the just-created conversation id (not undefined) on a fast-complete first turn', async () => {
    // --- Orchestrator: a FAST-completing stream (token then complete) ----------
    // No gate / no delay — the stream completes as soon as the orchestrator loop
    // runs. This is the warm-model / zero-doc-abstain first-turn scenario. Under
    // the F1 bug, the completion raced saveMessages' onCreate (which fires after
    // two awaits inside saveMessages) and read owningConversationId===undefined,
    // creating a duplicate. Under the fix, handleSend AWAITS the send-time save
    // (with its synchronous onCreate), so the ref is set before runGeneration.
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: 'FAST-' };
      yield {
        type: 'complete',
        data: { answer: 'FAST-ANSWER', sources: [], chunks: [] },
      };
    });

    // --- onSaveConversation: simulate the REAL saveMessages create behavior ---
    // The real saveMessages is ASYNC and only fires onCreate INSIDE its async
    // body after a couple of awaits (microtasks) — this is what produced the F1
    // race: a fast-complete stream's onDone fired before onCreate resolved, read
    // the still-undefined owningConversationIdRef, and created a duplicate. We
    // mirror that timing here by returning a Promise that fires onCreate after a
    // handful of microtasks. To GUARANTEE the F1 race is observable when the fix
    // is absent, onCreate is deferred by enough microtasks that a fast-completing
    // orchestrator (warm model — initialize resolves immediately, then a token
    // and complete) fires onDone FIRST. Under the fix, handleSend AWAITS this
    // save, so runGeneration cannot start until onCreate has resolved the ref —
    // the race is eliminated regardless of relative timing.
    let createCounter = 0;
    const calls: Array<{ id: string | undefined; messages: ChatMessage[] }> = [];
    const onSaveConversation = vi.fn(
      (id: string | undefined, messages: ChatMessage[], _mode: string, _model: string, onCreate?: (newId: string) => void) => {
        calls.push({ id, messages });
        // Return a Promise (the real saveMessages is async) and fire onCreate
        // from within several microtasks — slower than a fast-complete stream,
        // reproducing the F1 race when the fix's `await` is removed.
        return (async () => {
          for (let i = 0; i < 8; i++) {
            await Promise.resolve();
          }
          if (id === undefined && onCreate) {
            createCounter += 1;
            onCreate('NEW_CONV_' + createCounter);
          }
        })();
      }
    );
    const setCurrentConversationId = vi.fn();

    // --- Harness: first turn (no current conversation, empty messages) --------
    type View = { convId: string | undefined; messages: ChatMessage[] };
    let view: View = { convId: undefined, messages: [] };

    function Harness() {
      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={(id: string | undefined) => {
            setCurrentConversationId(id);
            // Mirror the parent (App) lifting the new id into state so the
            // re-render observes it (keeps the test realistic w.r.t. App).
            view = { ...view, convId: id };
          }}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    render(<Harness />);

    // --- Trigger a send on the first turn (no current conversation) ----------
    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'FIRST-TURN-QUESTION' } });
      fireEvent.click(sendButton);
    });

    // Flush microtasks so initialize() resolves, the orchestrator loop runs to
    // completion (token + complete), onDone fires, AND (under the fix) the
    // send-time save's deferred onCreate resolves before runGeneration starts.
    // We flush enough microtasks to cover both the fast-complete stream and the
    // 8-microtask deferral the onSaveConversation mock uses to simulate the
    // real saveMessages' async onCreate timing.
    await act(async () => {
      for (let i = 0; i < 24; i++) {
        await Promise.resolve();
      }
    });

    // === F1 ASSERTIONS =====================================================

    // (1) Exactly ONE create call: exactly one onSaveConversation call had
    //     conversationId === undefined. Under the F1 bug, onDone would also
    //     save with undefined (because owningConversationIdRef.current was
    //     still undefined when onDone fired), producing a SECOND create →
    //     duplicate conversation. The fix awaits the send-time save so the
    //     ref is set before onDone, and only ONE create ever happens.
    const createCalls = calls.filter((c) => c.id === undefined);
    expect(
      createCalls.length,
      'exactly one create (undefined-id) save must happen — a second would be a duplicate conversation'
    ).toBe(1);

    // (2) The COMPLETION (onDone) save must have a DEFINED conversation id —
    //     specifically the just-created 'NEW_CONV_1'. This is the CRITICAL F1
    //     assertion: before the fix it would be undefined (stale owning id
    //     closure), creating a duplicate conversation. Identify the completion
    //     save as the one carrying an assistant message with `sources` set.
    const completionCalls = calls.filter((c) =>
      c.messages.some((m) => m.role === 'assistant' && Array.isArray(m.sources))
    );
    expect(
      completionCalls.length,
      'completion (onDone) save must fire after the fast-complete stream'
    ).toBeGreaterThanOrEqual(1);

    const lastCompletion = completionCalls[completionCalls.length - 1];
    expect(
      lastCompletion.id,
      'completion save must use a DEFINED conversation id (the just-created one), NOT undefined — undefined would create a duplicate conversation (F1 bug)'
    ).toBeDefined();
    expect(
      lastCompletion.id,
      'completion save must target the just-created NEW_CONV_1, not a later/different id'
    ).toBe('NEW_CONV_1');

    // (3) Across the WHOLE interaction, exactly ONE create happened (already
    //     asserted above) and the total number of undefined-id saves is 1.
    //     Belt-and-braces: re-iterate the duplicate-conversation contract by
    //     confirming every save AFTER the first create uses a defined id.
    let sawCreate = false;
    for (const c of calls) {
      if (c.id === undefined) {
        expect(
          sawCreate,
          'only one undefined-id (create) save is allowed across the whole interaction'
        ).toBe(false);
        sawCreate = true;
      } else {
        // Any defined-id save must be the just-created id (no spurious others).
        expect(c.id).toBe('NEW_CONV_1');
      }
    }

    // (4) setCurrentConversationId must have been called with 'NEW_CONV_1' so
    //     the freshly created conversation becomes the active one (H4 + F1).
    expect(setCurrentConversationId).toHaveBeenCalledWith('NEW_CONV_1');
  });
});

// ============================================================================
// PR #38 — persistence-of-partial-turn regression suite (PRR-001 / 005 / 006a/b)
//
// These tests guard the fix that an in-flight assistant turn is NEVER silently
// dropped when it is interrupted by: a conversation switch (PRR-001), a user
// Stop (PRR-005), an unmount (PRR-006a), or an engine switch (PRR-006b). In all
// four cases the finalized (isStreaming stripped) partial content must be
// persisted to the OWNING conversation id via onSaveConversation.
//
// Each test is a TRUE regression test: if the corresponding persist call were
// removed from ChatPage.tsx, the test would fail.
//
// The tests reuse the same hoisted module mocks as the S1/F1 tests above
// (RAGOrchestrator, llm-factory, inference, readiness-gate, auth). They only
// re-establish per-describe mock implementations because vi.restoreAllMocks()
// in the prior describe's afterEach strips the factory implementations.
// ============================================================================

/**
 * Shared helpers for the PR #38 persistence-of-partial-turn tests.
 *
 * The lifted-view <Harness> pattern (inline in each test) mounts the REAL
 * ChatPage so the test can flip currentConversationId / messages / browserEngine
 * to simulate the parent (App) switching conversations or engines mid-stream.
 *
 * `flushRafFrames` advances real timers enough for jsdom's requestAnimationFrame
 * polyfill to fire, so tokens buffered in TokenStreamManager reach the onToken
 * callback (and thus messagesRef). We use REAL timers (not fake) here because
 * the persistence assertions must observe messagesRef populated by a real RAF
 * flush — the production code relies on the RAF flush contract.
 *
 * `waitForPartialContent` POLLs the lifted view's messages for a token,
 * interleaving microtask flushes (advances the async orchestrator loop) with
 * RAF flushes (delivers buffered tokens to messagesRef). This eliminates the
 * brittle microtask-count + RAF race: it returns as soon as the partial
 * assistant content is observable, regardless of how loaded the event loop is.
 * Bounded iteration count keeps it deterministic (fails fast if the token never
 * arrives rather than hanging).
 */
function flushRafFrames(frames = 3): Promise<void> {
  // jsdom polyfills requestAnimationFrame via setTimeout(~16ms). Advancing the
  // event loop with a handful of zero-delay macrotasks lets the queued RAF
  // callbacks fire. Wrapped so callers can `await flushRafFrames()` inside act.
  return new Promise<void>((resolve) => {
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}

/**
 * Poll `getMessages()` (the lifted view's current messages) until an assistant
 * message contains `partialToken`, flushing microtasks + RAF each iteration.
 * Throws after `maxIters` if the token never appears (deterministic failure
 * rather than a hang). Use this instead of a fixed microtask count so the test
 * is robust to event-loop load (the orchestrator's async loop + RAF scheduling
 * race under the default vitest pool).
 */
async function waitForPartialContent(
  getMessages: () => ChatMessage[],
  partialToken: string,
  maxIters = 40
): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    await Promise.resolve();
    await Promise.resolve();
    await flushRafFrames(2);
    const msgs = getMessages();
    const has = msgs.some(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(partialToken)
    );
    if (has) return;
  }
  throw new Error(
    `waitForPartialContent: token "${partialToken}" never appeared in messages after ${maxIters} iterations`
  );
}

/**
 * A deferred-gate AsyncGenerator that:
 *   - yields a token immediately (so partial content is non-empty),
 *   - PARKS on `gate` (the stream stays open, NOT completed),
 *   - (the test never resolves the gate — we test the INTERRUPTED case).
 *
 * This parks the stream so tokenStreamManagerRef.current stays non-null and
 * `cancel()` is never invoked by the orchestrator completing — the only way
 * the partial turn gets persisted is the explicit persist path under test.
 */
function makeParkingStream(
  gate: { promise: Promise<void>; resolve: () => void },
  token: string
): () => AsyncGenerator<RAGEvent> {
  return async function* (): AsyncGenerator<RAGEvent> {
    yield { type: 'token', data: token };
    await gate.promise;
    // Unreachable in the interrupted tests — the gate is never resolved.
    yield { type: 'complete', data: { answer: token, sources: [], chunks: [] } };
  };
}

describe('ChatPage PRR-001: switch mid-stream PERSISTS the partial turn to the owning conversation A', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the factory mocks (see F1 describe for rationale).
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      supportsImages: vi.fn().mockReturnValue(false),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a mid-stream switch to B triggers a save targeting OWNING A with the partial assistant content (isStreaming stripped)', async () => {
    const gate = makeDeferred();
    const PARTIAL_TOKEN = 'PARTIAL-A-';

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeParkingStream(gate, PARTIAL_TOKEN));

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    const aUserMsg = makeMessage('user', 'A-QUESTION');
    const bUserMsg = makeMessage('user', 'B-QUESTION');

    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [aUserMsg] };

    function Harness() {
      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    const { rerender } = render(<Harness />);

    // --- Step 1: send a message in A; the stream parks after one token ------
    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'A-QUESTION' } });
      fireEvent.click(sendButton);
    });

    // Let initialize() resolve and the orchestrator yield the token + park.
    // POLL for the partial token to reach the lifted view's messages (via the
    // real RAF flush path) instead of a fixed microtask count — robust to
    // event-loop load under the vitest pool.
    await act(async () => {
      await waitForPartialContent(() => view.messages, PARTIAL_TOKEN);
    });

    // Clear send-time noise so the SWITCH save is cleanly isolated below.
    onSaveConversation.mockClear();
    setCurrentConversationId.mockClear();

    // --- Step 2: switch to B WITHOUT completing the stream ------------------
    // The PRR-001 switch effect (ChatPage.tsx ~146-174) finalizes the OWNING
    // conversation's partial turn (read from owningMessagesRef, the send-time
    // snapshot) and calls onSaveConversation(owningId=A, finalized, ...) before
    // canceling the stream. This is the PRR-001 fix: previously the switch only
    // canceled, dropping the partial turn (cancel() never fires onDone/onError).
    //
    // Regression proof: if the switch effect's `onSaveConversation(owningId, ...)`
    // line is removed, this test FAILS (no save targets A) — verified by
    // temporarily deleting that line. (The unmount-cleanup effect is now
    // unmount-only via its `[]` dep, so it no longer masks the switch path on a
    // conversation switch.)
    await act(async () => {
      view = { convId: 'B', messages: [bUserMsg] };
      rerender(<Harness />);
    });
    // Flush the switch effect + any tail microtasks/frames.
    await act(async () => {
      await flushRafFrames(2);
      await Promise.resolve();
    });

    // === PRR-001 ASSERTIONS =================================================

    // (1) A save targeting the OWNING conversation A must have fired. If the
    //     switch effect's `onSaveConversation(owningId, finalized, ...)` line
    //     were removed, NO save would target A here (cancel alone never saves).
    const saveToA = onSaveConversation.mock.calls.filter(([id]) => id === 'A');
    expect(
      saveToA.length,
      'switch mid-stream MUST persist the partial turn to owning conversation A (PRR-001)'
    ).toBeGreaterThanOrEqual(1);

    // (2) The persisted messages must contain the PARTIAL assistant content
    //     (the token that streamed before the switch), with isStreaming
    //     stripped. This proves the partial answer was not lost.
    const lastSaveToA = saveToA[saveToA.length - 1];
    const savedMessages = lastSaveToA[1] as ChatMessage[];
    const assistantMsgs = savedMessages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length, 'an assistant message must be present in the persisted turn').toBeGreaterThanOrEqual(1);
    const partialAssistant = assistantMsgs.find((m) => m.content.includes(PARTIAL_TOKEN));
    expect(
      partialAssistant,
      `persisted assistant content must include the streamed partial token "${PARTIAL_TOKEN}"`
    ).toBeDefined();
    expect(
      partialAssistant!.isStreaming,
      'persisted partial assistant message must have isStreaming stripped (no blinking cursor persisted)'
    ).toBeFalsy();

    // (3) No save may target B (the switched-TO conversation) for the partial
    //     turn — the partial belongs to A, the conversation that produced it.
    const saveToB = onSaveConversation.mock.calls.filter(([id]) => id === 'B');
    expect(
      saveToB.length,
      'partial turn from A must NOT be persisted to B (the switched-TO conversation)'
    ).toBe(0);
  });
});

/**
 * PRR-005 regression: handleCancel must persist the cancel-flushed tail tokens.
 *
 * The bug was that handleCancel snapshotted messagesRef BEFORE calling
 * cancelActiveStream(). TokenStreamManager.cancel() flushes the token buffer
 * synchronously (S4) via onToken → which appends to messagesRef — so a
 * pre-cancel snapshot missed every token still buffered at cancel time (up to
 * a RAF frame, far more in a background tab). The fix reads messagesRef AFTER
 * cancelActiveStream().
 *
 * Timing approach (deterministic, no brittle microtask counts):
 *   - We use FAKE TIMERS so the RAF that TokenStreamManager.pushToken schedules
 *     does NOT auto-fire. Tokens therefore stay buffered in tokenBuffer and
 *     never reach onToken/messagesRef during streaming.
 *   - We push several tokens (they buffer).
 *   - We click Stop. handleCancel → cancelActiveStream() →
 *     TokenStreamManager.cancel() → flushBuffer() → onToken(joined) fires
 *     SYNCHRONOUSLY, appending ALL buffered tokens to messagesRef. THEN
 *     handleCancel reads messagesRef.current (post-fix) and persists.
 *   - If handleCancel still snapshotted before cancel (the bug), the persisted
 *     content would contain ZERO streamed tokens (the buffer was never flushed
 *     into messagesRef before cancel ran).
 *
 * Fake timers do NOT block Promise microtasks, so the async orchestrator loop
 * still advances and calls pushToken; only the macrotask-driven RAF is gated.
 */
describe('ChatPage PRR-005: handleCancel preserves cancel-flushed tail tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      supportsImages: vi.fn().mockReturnValue(false),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('Stop persists the FULL streamed content including tokens that were buffered (unflushed) at cancel time', async () => {
    vi.useFakeTimers();

    // Three tokens pushed in sequence; all stay buffered (RAF never fires under
    // fake timers), so messagesRef's assistant content is EMPTY until cancel()
    // flushes the buffer.
    const TOKENS = ['T1-', 'T2-', 'T3-TAIL'];
    const FULL = TOKENS.join('');

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      for (const t of TOKENS) {
        yield { type: 'token', data: t };
      }
      // Park forever — the user cancels before completion. The stream is
      // intentionally never completed so the ONLY persist path is handleCancel.
      await new Promise<void>(() => {});
    });

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    const userMsg = makeMessage('user', 'Q');
    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [userMsg] };

    function Harness() {
      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Q' } });
      fireEvent.click(sendButton);
    });

    // Advance microtasks (NOT macrotimers) so initialize() resolves and the
    // orchestrator yields all three tokens into the TokenStreamManager buffer.
    // Fake timers do not block Promise microtask resolution, so the for-await
    // loop advances. We do NOT advance fake timers, so the scheduled RAF never
    // fires — tokens remain buffered and messagesRef's assistant content is
    // still empty.
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    // Isolate the CANCEL save from the send-time save.
    onSaveConversation.mockClear();

    // --- Click Stop ----------------------------------------------------------
    // handleCancel: captures owningId, calls cancelActiveStream() (which calls
    // TokenStreamManager.cancel() → flushBuffer() → onToken(FULL) synchronously,
    // appending ALL buffered tokens to messagesRef), THEN reads
    // messagesRef.current (post-fix) to build `finalized` and persists.
    const stopButton = screen.getByRole('button', { name: /stop generation/i });
    await act(async () => {
      fireEvent.click(stopButton);
    });
    // Flush React commit + any trailing microtasks.
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });

    vi.useRealTimers();

    // === PRR-005 ASSERTIONS =================================================

    // (1) handleCancel persisted exactly one save targeting the owning A.
    const cancelSaves = onSaveConversation.mock.calls.filter(([id]) => id === 'A');
    expect(
      cancelSaves.length,
      'handleCancel must persist the finalized turn to owning A'
    ).toBeGreaterThanOrEqual(1);
    const lastCancel = cancelSaves[cancelSaves.length - 1];
    const persistedMessages = lastCancel[1] as ChatMessage[];

    // (2) The persisted assistant content MUST contain the FULL streamed
    //     content, INCLUDING the tail token "T3-TAIL" that was buffered
    //     (unflushed) at cancel time. Under the PRR-005 bug, messagesRef was
    //     snapshotted BEFORE cancel flushed the buffer, so NONE of the buffered
    //     tokens (the entire content, since the RAF never fired under fake
    //     timers) would appear — the assertion would fail.
    const assistantMsgs = persistedMessages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length, 'an assistant message must be persisted').toBeGreaterThanOrEqual(1);
    const persistedContent = assistantMsgs.map((m) => m.content).join('');
    expect(
      persistedContent,
      'persisted assistant content must include the cancel-flushed tail token "T3-TAIL" (PRR-005)'
    ).toContain('T3-TAIL');
    expect(
      persistedContent,
      'persisted assistant content must equal the FULL streamed content (all buffered tokens flushed during cancel)'
    ).toBe(FULL);

    // (3) The persisted assistant message has isStreaming stripped.
    expect(
      assistantMsgs.every((m) => !m.isStreaming),
      'persisted partial assistant message must have isStreaming stripped'
    ).toBe(true);
  });
});

/**
 * PRR-006a regression: unmounting ChatPage mid-stream must persist the finalized
 * partial turn. The unmount-cleanup effect (ChatPage.tsx ~247-271) checks
 * tokenStreamManagerRef.current !== null, finalizes messagesRef (strips
 * isStreaming), and persists via persistOnUnmountRef. If that persist branch
 * were removed, the partial turn would be silently dropped on unmount (e.g.
 * navigating away mid-generation).
 */
describe('ChatPage PRR-006a: unmount mid-stream PERSISTS the finalized partial turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      supportsImages: vi.fn().mockReturnValue(false),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('unmount triggers an onSaveConversation call with the finalized partial content (isStreaming stripped)', async () => {
    const gate = makeDeferred();
    const PARTIAL_TOKEN = 'UNMOUNT-PARTIAL-';

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeParkingStream(gate, PARTIAL_TOKEN));

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    const userMsg = makeMessage('user', 'Q');
    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [userMsg] };

    function Harness() {
      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    const { unmount } = render(<Harness />);

    // Send + let the token flush into messagesRef, then park.
    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Q' } });
      fireEvent.click(sendButton);
    });
    await act(async () => {
      await waitForPartialContent(() => view.messages, PARTIAL_TOKEN);
    });

    // Clear the send-time save so the UNMOUNT save is isolated.
    onSaveConversation.mockClear();

    // --- Unmount mid-stream -------------------------------------------------
    await act(async () => {
      unmount();
    });

    // === PRR-006a ASSERTIONS ================================================

    // (1) onSaveConversation fired on unmount with finalized content. If the
    //     unmount-cleanup's persist branch were removed, this would be empty.
    expect(
      onSaveConversation.mock.calls.length,
      'unmount mid-stream MUST persist the finalized partial turn (PRR-006a)'
    ).toBeGreaterThanOrEqual(1);

    const lastCall = onSaveConversation.mock.calls[onSaveConversation.mock.calls.length - 1];
    const [unmountId, unmountMessages] = lastCall;

    // (2) The persisted messages contain the partial assistant content (the
    //     token that streamed before unmount), with isStreaming stripped.
    const assistantMsgs = (unmountMessages as ChatMessage[]).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length, 'an assistant message must be persisted on unmount').toBeGreaterThanOrEqual(1);
    const partial = assistantMsgs.find((m) => m.content.includes(PARTIAL_TOKEN));
    expect(
      partial,
      `persisted assistant content must include the streamed partial token "${PARTIAL_TOKEN}"`
    ).toBeDefined();
    expect(
      partial!.isStreaming,
      'persisted partial assistant message must have isStreaming stripped on unmount'
    ).toBeFalsy();

    // (3) The unmount save targets the owning conversation A.
    expect(unmountId, 'unmount persist must target the owning conversation A').toBe('A');
  });
});

/**
 * PRR-006b regression: switching the browser engine mid-stream must persist the
 * finalized partial turn. The engine-switch effect (ChatPage.tsx ~201-228)
 * detects prev !== browserEngine while a stream is active, finalizes
 * messagesRef (strips isStreaming), and persists via onSaveConversation. If that
 * persist branch were removed, the partial turn would be lost on engine switch.
 */
describe('ChatPage PRR-006b: engine switch mid-stream PERSISTS the finalized partial turn to the owning conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      supportsImages: vi.fn().mockReturnValue(false),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('switching browserEngine to web-llm mid-stream triggers a save with the finalized partial content targeting owning A', async () => {
    const gate = makeDeferred();
    const PARTIAL_TOKEN = 'ENGINE-SWITCH-PARTIAL-';

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeParkingStream(gate, PARTIAL_TOKEN));

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    const userMsg = makeMessage('user', 'Q');
    // The lifted view starts in wllama mode; we flip browserEngine to web-llm
    // below to simulate an engine switch while streaming.
    type View = { convId: string; messages: ChatMessage[]; engine: 'wllama' | 'web-llm' };
    let view: View = { convId: 'A', messages: [userMsg], engine: 'wllama' };

    function Harness() {
      // useInferenceMode is module-mocked, so we override its return value per
      // render to reflect the lifted engine. This mirrors how the real
      // InferenceModeContext would surface an engine change to ChatPage.
      vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
        mode: 'browser-local',
        browserEngine: view.engine,
        ragPreset: 'balanced',
        isModelReady: true,
        isServerConnected: true,
        modelLoadingProgress: 0,
        modeError: null,
        serverUrl: '',
        setMode: vi.fn(),
        setBrowserEngine: vi.fn(),
        setRagPreset: vi.fn(),
        setServerUrl: vi.fn(),
        checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
        setModelReady: vi.fn(),
        setModelLoadingProgress: vi.fn(),
      } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);

      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    const { rerender } = render(<Harness />);

    // Send + flush token + park.
    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Q' } });
      fireEvent.click(sendButton);
    });
    await act(async () => {
      await waitForPartialContent(() => view.messages, PARTIAL_TOKEN);
    });

    // Clear send-time save so the ENGINE-SWITCH save is isolated.
    onSaveConversation.mockClear();

    // --- Switch the engine to web-llm mid-stream ----------------------------
    // The engine-switch effect (ChatPage.tsx ~201-228) sees prev='wllama' !==
    // 'web-llm', finalizes messagesRef, and persists via onSaveConversation.
    await act(async () => {
      view = { ...view, engine: 'web-llm' };
      rerender(<Harness />);
    });
    await act(async () => {
      await flushRafFrames(2);
      await Promise.resolve();
    });

    // === PRR-006b ASSERTIONS ================================================

    // (1) A save targeting the owning conversation A fired after the engine
    //     switch. If the engine-switch effect's persist branch were removed,
    //     this would be empty (the abort alone never fires onDone).
    const switchSaves = onSaveConversation.mock.calls.filter(([id]) => id === 'A');
    expect(
      switchSaves.length,
      'engine switch mid-stream MUST persist the finalized partial turn to owning A (PRR-006b)'
    ).toBeGreaterThanOrEqual(1);

    // (2) The persisted messages contain the partial assistant content with
    //     isStreaming stripped.
    const lastSwitch = switchSaves[switchSaves.length - 1];
    const switchMessages = lastSwitch[1] as ChatMessage[];
    const assistantMsgs = switchMessages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length, 'an assistant message must be persisted on engine switch').toBeGreaterThanOrEqual(1);
    const partial = assistantMsgs.find((m) => m.content.includes(PARTIAL_TOKEN));
    expect(
      partial,
      `persisted assistant content must include the streamed partial token "${PARTIAL_TOKEN}"`
    ).toBeDefined();
    expect(
      partial!.isStreaming,
      'persisted partial assistant message must have isStreaming stripped on engine switch'
    ).toBeFalsy();
  });
});
