/**
 * ChatPage.checkpoint.test.tsx — issue #269 AC5 (claim 6).
 *
 * WHEN an assistant answer has been streaming for longer than the checkpoint
 * interval, THE SYSTEM SHALL save the partial content to the owning
 * conversation before the stream completes.
 *
 * Base defect: a turn is persisted only at send (user message + EMPTY
 * assistant placeholder), done, error, cancel, switch and unmount. A browser
 * refresh mid-answer therefore leaves an empty assistant placeholder in the
 * store and every streamed token is lost. The fix adds a throttled checkpoint
 * inside onToken (at most once per exported CHECKPOINT_INTERVAL_MS, default
 * 2000) saving the owning snapshot with the assistant message marked
 * `interrupted: true`; the terminal (onDone) save clears the flag.
 *
 * AMENDED (critic required revision 4 / CHECK_WRONG round): the frozen spec
 * could be satisfied by a one-shot or wrong-edge throttle and could not
 * observe checkpoint-vs-terminal write ordering (a synchronous save spy).
 * The amended spec additionally pins:
 *   (1) EARLY rejection — after the first tokens are delivered to onToken,
 *       advancing fake time by less than CHECKPOINT_INTERVAL_MS must produce
 *       NO checkpoint save;
 *   (2) LATEST partial — after the interval elapses and later tokens
 *       (CK1..CK3) arrive, a checkpoint save must exist whose assistant
 *       content EQUALS the full streamed partial ('CK1-CK2-CK3-') exactly —
 *       not merely contains the latest token (a stale CK1-only checkpoint AND
 *       a token-dropping CK3-only checkpoint are both rejected), still
 *       interrupted:true while the stream is open;
 *   (3) DEFERRED inversion — onSaveConversation returns controllable
 *       promises; the checkpoint save's promise is held unresolved while the
 *       stream completes (onDone). ChatPage serializes its own saves per
 *       stream (it awaits the promise returned by onSaveConversation before
 *       issuing the next save for that stream), so onDone's terminal save is
 *       not issued before the held checkpoint resolves, and a fake store that
 *       applies writes in the order they complete always ends on the TERMINAL
 *       message (full content, interrupted falsy, not streaming). At base the
 *       first failing assertion is "no checkpoint save exists".
 *
 * AMENDED (critic round 2 / CHECK_WRONG second amendment): (3) above proves
 * ordering only WITHIN one stream. The production contract is per OWNING
 * CONVERSATION: every ChatPage message save to one conversation (send-time
 * save, Regenerate's save, checkpoints, and every terminal save — onDone /
 * onError / Stop / switch / engine-switch / unmount) is issued to
 * onSaveConversation only after every EARLIER save to that same conversation
 * has settled, so completion order equals issue order ACROSS streams. Two
 * additional cases pin it:
 *   (4) CROSS-STREAM STOP->SEND — stream 1 streams tokens, the user presses
 *       Stop (terminal save HELD), then sends a new question in the SAME
 *       conversation (stream 2). While stream 1's Stop save is held, the
 *       stream-2 send-time save must NOT be issued; once it settles, the
 *       send-time save is issued and a fake store applying writes in
 *       completion order ends with the conversation's record containing
 *       stream 2's question (the stale Stop save never overwrites the newer
 *       turn). At base the first failing assertion is "the stream-2 send-time
 *       save must not be issued while held" (base issues it immediately).
 *   (5) DONE->REGENERATE — stream 1 completes normally (onDone terminal save
 *       HELD) and the user clicks Regenerate immediately. No save for the
 *       conversation may be issued while the done save is held (at base the
 *       regenerated stream's own onDone save is issued immediately — the
 *       first failing assertion); after it settles, the regenerated thread's
 *       saves are issued and the fake store's final record is the REGENERATED
 *       thread, never the stale done thread.
 *
 * AMENDED (critic round 3 / CHECK_WRONG third amendment): (4) and (5) above
 * stay within ONE mounted ChatPage, so a per-conversation sequencer OWNED BY
 * THE COMPONENT (a fresh map per mount) would pass them and still lose a
 * turn across unmount/remount: App replaces ChatPage on navigation
 * (App.tsx renderPage, :467-498), so a held unmount terminal save belongs
 * to the destroyed component's map and a remounted ChatPage could issue a
 * same-conversation send-time save immediately — the stale unmount write
 * can then settle last and erase the new turn. The production contract is
 * therefore a MODULE-scope sequencer (web_ui/src/lib/chat/save-sequencer.ts
 * exporting sequenceConversationSave(key, fn) and a test-only
 * __resetSaveSequencerForTests()) whose per-conversation ordering survives
 * component destruction. One more case pins it:
 *   (6) UNMOUNT->REMOUNT — stream 1 parks mid-flight, the rendered tree is
 *       UNMOUNTED (as ChatPage.streaming-persistence PRR-006a does) and the
 *       unmount terminal save is HELD; a NEW ChatPage is rendered on the
 *       same conversation A (fresh render) and sends a new question Q2.
 *       While the unmount save is held, the Q2 send-time save must NOT be
 *       issued (at base it is issued immediately — the first failing
 *       assertion); once the unmount save settles, the send-time save is
 *       issued and the completion-ordered fake store's final record for A
 *       ends on Q2 (the stale unmount save never overwrites the newer turn).
 *
 * Timing: fake timers as in the PRR-005 describe of
 * ChatPage.streaming-persistence.test.tsx. Tokens stay buffered until the
 * timers advance; advancing delivers them (RAF flush) and crossing the
 * throttle window while the stream is still parked on a gate fires the
 * checkpoint inside onToken.
 *
 * Isolation: the sequencer is MODULE-scope, so the describe's afterEach
 * resets it via a GUARDED dynamic import whose specifier is widened to
 * `string` — TypeScript and Vite therefore do NOT resolve it statically
 * (at base the module does not exist and the import simply rejects; the
 * base failure stays the behavioural one) — and every test releases its
 * held promises in a finally so no save chain is left pending across tests.
 *
 * CHECKPOINT_INTERVAL_MS is read off the module namespace with a fallback so
 * that at base (no such export) the failure is "no partial save", not an
 * import/type crash. The `interrupted` field does not exist on ChatMessage at
 * base, so it is read through a local intersection type.
 *
 * The boundary vi.mock block is copied from ChatPage.streaming-persistence.
 * test.tsx (rag-orchestrator, llm-factory, inference, readiness-gate, auth).
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ChatMessage } from '../types/chat';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';

// --- Module mocks (copied from ChatPage.streaming-persistence.test.tsx) -----

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return { query: vi.fn() };
  }),
}));

vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
  })),
  DEFAULT_BROWSER_ENGINE: 'wllama',
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn().mockResolvedValue(null),
  getReadinessResultSnapshot: vi.fn().mockReturnValue(null),
  resetReadinessCache: vi.fn(),
}));

vi.mock('../lib/api/auth', () => ({
  getToken: vi.fn().mockReturnValue(null),
}));

import * as ChatPageModule from './ChatPage';
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as llmFactoryModule from '../lib/llm/llm-factory';

const ChatPage = ChatPageModule.ChatPage;
/** The exported checkpoint interval (#269 Design 5); 2000 ms when absent (base). */
const CHECKPOINT_INTERVAL_MS =
  (ChatPageModule as unknown as { CHECKPOINT_INTERVAL_MS?: number }).CHECKPOINT_INTERVAL_MS ?? 2000;

type CheckpointedMessage = ChatMessage & { interrupted?: boolean };

/**
 * Releases a held (deferred) save if one was captured; idempotent. Takes the
 * handle as a typed parameter so the tests' finally blocks are not subject to
 * TypeScript's narrowing of a `let held = null` that only a closure (the save
 * mock) reassigns.
 */
function releaseIfHeld(held: { release: () => void } | null): void {
  held?.release();
}

function makeMessage(role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id: `${role}-${content.replace(/\s+/g, '-').slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('ChatPage #269 AC5: partial-answer checkpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
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
  afterEach(async () => {
    // Isolation for the MODULE-scope save sequencer (production contract):
    // a pending per-conversation tail left behind by a failing test must not
    // order the next test's saves. The specifier is widened to `string` so
    // neither TypeScript nor Vite resolves it statically — at base the module
    // does not exist, the import rejects at runtime and is swallowed here, and
    // the base failures stay behavioural (no failed collection).
    const saveSequencerSpecifier: string = '../lib/chat/save-sequencer';
    const saveSequencer = (await import(saveSequencerSpecifier).catch(() => null)) as {
      __resetSaveSequencerForTests?: () => void;
    } | null;
    saveSequencer?.__resetSaveSequencerForTests?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('a partial answer streaming past the checkpoint interval is saved to the owning conversation with interrupted:true before completion, and the completion save clears it (#269 AC5)', async () => {
    vi.useFakeTimers();

    const TOKENS = ['CK1-', 'CK2-', 'CK3-'];
    const FULL = TOKENS.join('');

    let releaseMid!: () => void;
    const midGate = new Promise<void>((r) => {
      releaseMid = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      // Batch 1 arrives at the start of the stream...
      yield { type: 'token', data: TOKENS[0] };
      yield { type: 'token', data: TOKENS[1] };
      // ...batch 2 only after the test has crossed the interval, so the
      // checkpoint fires whether the throttle is leading-edge (first token) or
      // trailing (a token arriving >= CHECKPOINT_INTERVAL_MS later), while a
      // checkpoint fired at batch 1 would be an EARLY checkpoint (rejected
      // below before CK3 ever arrives).
      await midGate;
      yield { type: 'token', data: TOKENS[2] };
      // The stream stays OPEN until the test releases the gate.
      await gate;
      yield { type: 'complete', data: { answer: FULL, sources: ['doc-a'], chunks: [], grounding: 'grounded' } };
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

    try {
      render(<Harness />);

      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      });
      // Microtasks only: the orchestrator yields all batch-1 tokens into the
      // TokenStreamManager buffer (RAF gated by the fake timers) and parks.
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      // Isolate from the send-time save (user message + EMPTY placeholder).
      onSaveConversation.mockClear();

      // A checkpoint save is any save to A whose assistant message already
      // carries streamed content (the send-time placeholder is empty).
      const checkpointSavesSoFar = () =>
        onSaveConversation.mock.calls.filter(
          ([id, messages]) =>
            id === 'A' &&
            (messages as ChatMessage[]).some((m) => m.role === 'assistant' && m.content !== '')
        );

      // === AMENDMENT (1): EARLY checkpoints are rejected =======================
      // Deliver batch 1 to onToken with a small RAF-triggering advance (~16 ms
      // of fake time) — far short of CHECKPOINT_INTERVAL_MS since the first
      // token.
      await act(async () => {
        vi.advanceTimersByTime(60);
      });
      await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // Sanity: batch 1 reached the live turn, so a missing checkpoint below can
      // only mean "throttled/absent", not "no tokens".
      expect(
        view.messages.some((m) => m.role === 'assistant' && m.content === `${TOKENS[0]}${TOKENS[1]}` && m.isStreaming === true),
        'sanity: batch 1 must be live (and the stream still open) inside the throttle window'
      ).toBe(true);
      expect(
        checkpointSavesSoFar(),
        'no checkpoint save may be issued before CHECKPOINT_INTERVAL_MS has elapsed since the first token (early rejection)'
      ).toHaveLength(0);

      // Still inside the window: advancing more time (with no further tokens)
      // must not fire a checkpoint either — this also rejects a free-running
      // timer that saves without a token arriving.
      await act(async () => {
        vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS - 200);
      });
      await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(
        checkpointSavesSoFar(),
        'advancing time by less than the checkpoint interval must produce no checkpoint save'
      ).toHaveLength(0);

      // === AMENDMENT (2): the post-interval checkpoint carries the LATEST ====
      // Cross comfortably past first-token + CHECKPOINT_INTERVAL_MS, then let
      // CK3 arrive (the only onToken after the window opens).
      await act(async () => {
        vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS + 300);
      });
      await act(async () => {
        releaseMid();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(40);
      });
      await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });

      // Sanity: the advance delivered every buffered token to the live turn, so
      // a missing checkpoint below can only mean "no partial save", not "no
      // tokens" — and the stream is still parked (gate unreleased).
      expect(
        view.messages.some((m) => m.role === 'assistant' && m.content === FULL && m.isStreaming === true),
        'sanity: the streamed partial must be live (and the stream still open) after the advance'
      ).toBe(true);

      // === ASSERTION 1: a checkpoint save carries the partial while parked =====
      const checkpointSaves = checkpointSavesSoFar();
      expect(
        checkpointSaves.length,
        'a checkpoint save carrying the partial content must reach owning conversation A while the stream is still open'
      ).toBeGreaterThanOrEqual(1);
      const checkpointAssistant = (checkpointSaves[checkpointSaves.length - 1][1] as CheckpointedMessage[]).find(
        (m) => m.role === 'assistant' && m.content !== ''
      );
      expect(
        checkpointAssistant?.content,
        'the checkpointed assistant content must EQUAL the full streamed partial exactly (a stale CK1-only checkpoint AND a token-dropping CK3-only checkpoint are both rejected)'
      ).toBe(FULL);
      expect(
        checkpointAssistant?.interrupted,
        'the checkpointed assistant message must be marked interrupted:true'
      ).toBe(true);

      // --- Complete the stream: the onDone save must clear `interrupted` -------
      onSaveConversation.mockClear();
      await act(async () => {
        release();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      const completionSaves = onSaveConversation.mock.calls.filter(([, messages]) =>
        (messages as ChatMessage[]).some((m) => m.role === 'assistant' && Array.isArray(m.sources))
      );
      expect(completionSaves.length, 'the completion (onDone) save must fire').toBeGreaterThanOrEqual(1);
      const [completionId, completionMessages] = completionSaves[completionSaves.length - 1];
      expect(completionId).toBe('A');
      const completionAssistant = (completionMessages as CheckpointedMessage[]).find((m) => m.role === 'assistant');
      expect(completionAssistant?.content).toBe(FULL);
      expect(
        completionAssistant?.interrupted,
        'the completion (onDone) save must clear the interrupted flag'
      ).not.toBe(true);
    } finally {
      // Never leave a held gate or save (or its sequencer queue) pending
      // for the next test; every resolver call here is idempotent.
      releaseMid();
      release();
    }
  });

  test('a held (deferred) checkpoint save cannot be overtaken by the terminal onDone save: serialization keeps the final stored state terminal (#269 AC5 ordering)', async () => {
    vi.useFakeTimers();

    const TOKENS = ['CK1-', 'CK2-', 'CK3-'];
    const FULL = TOKENS.join('');

    let releaseMid!: () => void;
    const midGate = new Promise<void>((r) => {
      releaseMid = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: TOKENS[0] };
      yield { type: 'token', data: TOKENS[1] };
      await midGate;
      yield { type: 'token', data: TOKENS[2] };
      await gate;
      yield { type: 'complete', data: { answer: FULL, sources: ['doc-a'], chunks: [], grounding: 'grounded' } };
    });

    // === AMENDMENT (3): an asynchronously controllable save + a fake store ===
    // The store applies a write in the order saves COMPLETE (later completions
    // win), modelling the persisted record. The checkpoint save's promise is
    // HELD by the test; every other save completes immediately.
    const store = new Map<string, { messages: ChatMessage[] }>();
    let heldCheckpoint: { release: () => void } | null = null;
    const onSaveConversation = vi.fn(
      (conversationId: string | undefined, messages: ChatMessage[]): Promise<void> => {
        const apply = () => {
          store.set(conversationId ?? '(created)', { messages: [...messages] });
        };
        const isCheckpointSave = messages.some(
          (m) => m.role === 'assistant' && (m as CheckpointedMessage).interrupted === true
        );
        if (isCheckpointSave && heldCheckpoint === null) {
          let releaseSave!: () => void;
          const saveGate = new Promise<void>((r) => {
            releaseSave = r;
          });
          heldCheckpoint = { release: releaseSave };
          // The write lands when the held save completes, i.e. when the test
          // releases it; the caller learns of the completion only afterwards.
          return saveGate.then(() => {
            apply();
          });
        }
        apply();
        return Promise.resolve();
      }
    );

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

    try {
      render(<Harness />);

      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      });
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      // The send-time save (empty placeholder) completes immediately; the stream
      // is free to start. Deliver batch 1 inside the throttle window.
      await act(async () => {
        vi.advanceTimersByTime(60);
      });
      // Cross the interval, then let CK3 arrive — the checkpoint fires inside
      // onToken and its save promise is HELD unresolved by the mock.
      await act(async () => {
        vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS + 300);
      });
      await act(async () => {
        releaseMid();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(40);
      });
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });

      // FIRST failing assertion at base: no checkpoint exists at all (the base
      // reason stays crisp; the ordering legs below are only reachable once a
      // checkpoint does fire).
      expect(
        heldCheckpoint,
        'a checkpoint save must have been issued and still be pending (held) while the stream is open'
      ).not.toBeNull();

      // Complete the stream while the checkpoint save is still held. onDone
      // fires; ChatPage serializes its per-stream saves, so the terminal save is
      // NOT issued before the held checkpoint save resolves.
      await act(async () => {
        release();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      const terminalSavesIssued = () =>
        onSaveConversation.mock.calls.filter(([, messages]) =>
          (messages as CheckpointedMessage[]).some((m) => m.role === 'assistant' && Array.isArray(m.sources))
        );
      expect(
        terminalSavesIssued(),
        'the terminal (onDone) save must not be ISSUED before the held checkpoint save resolves (per-stream save serialization)'
      ).toHaveLength(0);

      // Release the held checkpoint: its write lands first, then the queued
      // terminal save is issued and lands after it.
      await act(async () => {
        heldCheckpoint?.release();
        for (let i = 0; i < 16; i++) await Promise.resolve();
      });

      const terminalSaves = terminalSavesIssued();
      expect(
        terminalSaves.length,
        'the terminal (onDone) save must be issued once the held checkpoint save resolves'
      ).toBeGreaterThanOrEqual(1);
      const terminalMessages = terminalSaves[terminalSaves.length - 1][1] as CheckpointedMessage[];
      const terminalAssistant = terminalMessages.find((m) => m.role === 'assistant');
      expect(terminalAssistant?.content).toBe(FULL);
      expect(terminalAssistant?.interrupted).not.toBe(true);
      expect(terminalAssistant?.isStreaming).toBeFalsy();

      // The fake store's FINAL state must be the terminal message — an
      // unserialized implementation lets the held checkpoint write land AFTER
      // the terminal write and resurrect the stale interrupted partial.
      const finalStored = store.get('A');
      expect(finalStored, 'the owning conversation must have a stored record').toBeDefined();
      const finalAssistant = (finalStored as { messages: CheckpointedMessage[] }).messages.find(
        (m) => m.role === 'assistant' && m.content !== ''
      );
      expect(
        finalAssistant?.content,
        'the final STORED assistant message must be the terminal one (full content)'
      ).toBe(FULL);
      expect(
        finalAssistant?.interrupted,
        'the final STORED assistant message must not carry interrupted:true (the checkpoint write may not land after the terminal write)'
      ).not.toBe(true);
      expect(
        finalAssistant?.isStreaming,
        'the final STORED assistant message must not be streaming'
      ).toBeFalsy();
    } finally {
      // Never leave a held gate or save (or its sequencer queue) pending
      // for the next test; every resolver call here is idempotent.
      releaseIfHeld(heldCheckpoint);
      releaseMid();
      release();
    }
  });

  test('a held (deferred) Stop terminal save cannot be overtaken by the next send in the same conversation: the newer turn is never overwritten by the stale stop save (#269 AC5 cross-stream ordering)', async () => {
    vi.useFakeTimers();

    // Stream 1: yields tokens (they stay buffered — the RAF never fires under
    // fake timers), then parks forever; only the user's Stop terminalizes it.
    const S1_TOKENS = ['S1-a-', 'S1-b-'];
    const S1_FULL = S1_TOKENS.join('');
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: S1_TOKENS[0] };
      yield { type: 'token', data: S1_TOKENS[1] };
      // Parked until Stop (this generator also serves stream 2, which parks
      // the same way — its content is irrelevant to the assertions below).
      await new Promise<void>(() => {});
    });

    // === Deferred store (as above), but the save held is stream 1's STOP ====
    // terminal save: a save to A whose assistant message carries the
    // cancel-flushed partial, is finalized (isStreaming falsy), and is neither
    // an onDone save (sources) nor a checkpoint (interrupted:true). Every
    // other save completes immediately; a write lands when its save completes.
    const store = new Map<string, { messages: ChatMessage[] }>();
    const issued: Array<{ id: string | undefined; messages: ChatMessage[] }> = [];
    let heldStop: { release: () => void } | null = null;
    const onSaveConversation = vi.fn(
      (conversationId: string | undefined, messages: ChatMessage[]): Promise<void> => {
        issued.push({ id: conversationId, messages });
        const apply = () => {
          store.set(conversationId ?? '(created)', { messages: [...messages] });
        };
        const isStopTerminalSave =
          conversationId === 'A' &&
          messages.some(
            (m) =>
              m.role === 'assistant' &&
              m.content !== '' &&
              !m.isStreaming &&
              !Array.isArray(m.sources) &&
              (m as CheckpointedMessage).interrupted !== true
          );
        if (isStopTerminalSave && heldStop === null) {
          let releaseSave!: () => void;
          const saveGate = new Promise<void>((r) => {
            releaseSave = r;
          });
          heldStop = { release: releaseSave };
          return saveGate.then(() => {
            apply();
          });
        }
        apply();
        return Promise.resolve();
      }
    );

    const setCurrentConversationId = vi.fn();

    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [] };

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

    try {
      render(<Harness />);

      // --- Stream 1: send Q1; tokens buffer; the stream parks ------------------
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q1' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      });
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      // --- Stop stream 1 (driven exactly like ChatPage.stop-announcement) ------
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /stop generation/i }));
      });
      await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });

      // The Stop terminal save was issued and is HELD unresolved by the mock.
      expect(
        heldStop,
        'sanity: the Stop terminal save must have been issued (and still be held) after Stop'
      ).not.toBeNull();

      // --- Stream 2: the user sends a NEW question in the SAME conversation ---
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q2' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      // FIRST failing assertion at base: base's handleSend issues (and awaits)
      // the send-time save immediately — nothing orders it behind the still-
      // pending Stop save of the OLD stream for the SAME conversation.
      const q2SendSaves = () =>
        issued.filter(
          (c) => c.id === 'A' && c.messages.some((m) => m.role === 'user' && m.content === 'Q2')
        );
      expect(
        q2SendSaves().length,
        'while stream 1\'s Stop terminal save is held, the stream-2 send-time save must NOT be issued to onSaveConversation (per-conversation save ordering across streams)'
      ).toBe(0);

      // --- Release: the stop write lands first, then the queued send-time save.
      await act(async () => {
        heldStop?.release();
        for (let i = 0; i < 24; i++) await Promise.resolve();
      });

      expect(
        q2SendSaves().length,
        'once the Stop terminal save settles, the stream-2 send-time save must be issued'
      ).toBeGreaterThanOrEqual(1);

      // The store applies writes in completion order; the final record must end
      // on the NEWER turn. An unserialized implementation lets the held (stale)
      // Stop write land AFTER the send-time write, erasing Q2 from the record.
      const finalStored = store.get('A');
      expect(finalStored, 'the owning conversation must have a stored record').toBeDefined();
      const finalMessages = (finalStored as { messages: ChatMessage[] }).messages;
      const storedUserContents = finalMessages.filter((m) => m.role === 'user').map((m) => m.content);
      expect(
        storedUserContents[storedUserContents.length - 1],
        'the final STORED record must end with stream 2\'s question — the stale Stop save may never overwrite the newer turn'
      ).toBe('Q2');
      expect(
        finalMessages.some((m) => m.role === 'assistant' && m.content === S1_FULL),
        'the stopped partial must still be present in the final record (the Stop write landed BEFORE the newer turn, it was not dropped)'
      ).toBe(true);
    } finally {
      // Never leave a held gate or save (or its sequencer queue) pending
      // for the next test; every resolver call here is idempotent.
      releaseIfHeld(heldStop);
    }
  });

  test('a held (deferred) onDone terminal save cannot be overtaken by an immediate Regenerate in the same conversation: the final record is the regenerated thread (#269 AC5 cross-stream ordering)', async () => {
    vi.useFakeTimers();

    let releaseDoneGate!: () => void;
    const doneGate = new Promise<void>((r) => {
      releaseDoneGate = r;
    });

    // Stream 1: one token, then parks until the test releases the gate and
    // the turn completes NORMALLY (onDone). Stream 2 (the regenerate) completes
    // immediately with a DIFFERENT answer so the two threads are
    // distinguishable in the store.
    let queryCalls = 0;
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      queryCalls += 1;
      if (queryCalls === 1) {
        yield { type: 'token', data: 'DONE-' };
        await doneGate;
        yield {
          type: 'complete',
          data: { answer: 'DONE-ANSWER', sources: ['doc-done'], chunks: [], grounding: 'grounded' },
        };
      } else {
        yield { type: 'token', data: 'REGEN-' };
        yield {
          type: 'complete',
          data: { answer: 'REGEN-ANSWER', sources: ['doc-regen'], chunks: [], grounding: 'grounded' },
        };
      }
    });

    // === Deferred store: the save held is stream 1's onDone terminal save ===
    // (the first save whose assistant message carries sources). Every later
    // save — including the regenerated stream's own onDone save — completes
    // immediately, so the store's final record exposes any inversion.
    const store = new Map<string, { messages: ChatMessage[] }>();
    const issued: Array<{ id: string | undefined; messages: ChatMessage[] }> = [];
    let heldDone: { release: () => void } | null = null;
    const onSaveConversation = vi.fn(
      (conversationId: string | undefined, messages: ChatMessage[]): Promise<void> => {
        issued.push({ id: conversationId, messages });
        const apply = () => {
          store.set(conversationId ?? '(created)', { messages: [...messages] });
        };
        const isDoneSave = messages.some((m) => m.role === 'assistant' && Array.isArray(m.sources));
        if (isDoneSave && heldDone === null) {
          let releaseSave!: () => void;
          const saveGate = new Promise<void>((r) => {
            releaseSave = r;
          });
          heldDone = { release: releaseSave };
          return saveGate.then(() => {
            apply();
          });
        }
        apply();
        return Promise.resolve();
      }
    );

    const setCurrentConversationId = vi.fn();

    // Stateful harness (as in ChatPage.stop-announcement.test.tsx): the done
    // thread must reach the DOM so the Regenerate button renders — a lifted
    // plain-variable view would never re-render ChatPage with the finalized
    // messages and the button would stay suppressed by the !isStreaming gate.
    function Harness() {
      const [messages, setMessages] = React.useState<ChatMessage[]>([]);
      return (
        <ChatPage
          messages={messages}
          onMessagesChange={setMessages}
          onSaveConversation={onSaveConversation}
          currentConversationId="A"
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    try {
      render(<Harness />);

      // --- Stream 1 completes normally; its onDone save is HELD ---------------
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q1' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      });
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      await act(async () => {
        releaseDoneGate();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      expect(
        heldDone,
        'sanity: the onDone terminal save must have been issued (and still be held) after the normal completion'
      ).not.toBeNull();

      // --- Regenerate immediately, while the done save is still held -----------
      // Bounded, timer-free poll: the button renders as soon as the done turn
      // settles in the view (isLoading false, last assistant not streaming).
      let regenerateButton: HTMLElement | null = null;
      for (let i = 0; i < 10 && regenerateButton === null; i++) {
        await act(async () => {
          for (let j = 0; j < 4; j++) await Promise.resolve();
        });
        regenerateButton = screen.queryByRole('button', { name: 'Regenerate response' });
      }
      if (regenerateButton === null) {
        throw new Error('sanity: the Regenerate button must be clickable immediately after the done turn while its terminal save is still in flight');
      }

      const issuedBeforeRegenerate = issued.length;
      await act(async () => {
        fireEvent.click(regenerateButton);
        for (let i = 0; i < 24; i++) await Promise.resolve();
      });

      // FIRST failing assertion at base: base's handleRegenerate calls
      // runGeneration immediately (nothing orders the regenerated stream behind
      // the still-pending done save of the OLD stream), so the regenerated
      // stream's own onDone save is issued while the done save is held.
      expect(
        issued.slice(issuedBeforeRegenerate).length,
        'while stream 1\'s onDone terminal save is held, Regenerate\'s save (and every save of the regenerated stream) must NOT be issued to onSaveConversation (per-conversation save ordering across streams)'
      ).toBe(0);

      // --- Release: the done write lands first, then the regenerated thread ----
      await act(async () => {
        heldDone?.release();
        for (let i = 0; i < 32; i++) await Promise.resolve();
      });

      expect(
        issued
          .slice(issuedBeforeRegenerate)
          .some((c) => c.messages.some((m) => m.role === 'assistant' && m.content === 'REGEN-')),
        'after the done save settles, a save carrying the regenerated thread (placeholder/assistant for the regenerate turn) must be issued'
      ).toBe(true);

      const finalStored = store.get('A');
      expect(finalStored, 'the owning conversation must have a stored record').toBeDefined();
      const finalMessages = (finalStored as { messages: ChatMessage[] }).messages;
      expect(
        finalMessages.some((m) => m.role === 'user' && m.content === 'Q1'),
        'the regenerated turn\'s user message must remain in the final record'
      ).toBe(true);
      const finalAssistant = finalMessages.find((m) => m.role === 'assistant' && m.content !== '');
      expect(
        finalAssistant?.content,
        'the final STORED record must be the REGENERATED thread, never the stale done thread'
      ).toBe('REGEN-');
      expect(
        finalAssistant?.content,
        'the stale done answer must never be the final stored content'
      ).not.toBe('DONE-');
    } finally {
      // Never leave a held gate or save (or its sequencer queue) pending
      // for the next test; every resolver call here is idempotent.
      releaseIfHeld(heldDone);
      releaseDoneGate();
    }
  });

  test('a held (deferred) unmount terminal save cannot be overtaken by a REMOUNTED ChatPage sending in the same conversation: ordering survives component destruction (#269 AC5 cross-component ordering)', async () => {
    vi.useFakeTimers();

    // Stream 1: yields tokens (they stay buffered — the RAF never fires under
    // fake timers), then parks forever; only the component's UNMOUNT
    // terminalizes it. The same generator also serves the remounted page's
    // stream (stream 2), which parks the same way — its content is irrelevant
    // to the assertions below.
    const S1_TOKENS = ['U1-a-', 'U1-b-'];
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: S1_TOKENS[0] };
      yield { type: 'token', data: S1_TOKENS[1] };
      await new Promise<void>(() => {});
    });

    // === Deferred store (as above), but the save held is the UNMOUNT ========
    // terminal save: the first save issued to A after the first tree unmounts
    // (the unmount cleanup issues it synchronously during unmount()). Every
    // other save completes immediately; a write lands when its save completes.
    const store = new Map<string, { messages: ChatMessage[] }>();
    const issued: Array<{ id: string | undefined; messages: ChatMessage[] }> = [];
    let firstTreeUnmounted = false;
    let heldUnmount: { release: () => void } | null = null;
    const onSaveConversation = vi.fn(
      (conversationId: string | undefined, messages: ChatMessage[]): Promise<void> => {
        issued.push({ id: conversationId, messages });
        const apply = () => {
          store.set(conversationId ?? '(created)', { messages: [...messages] });
        };
        const isUnmountSave = firstTreeUnmounted && conversationId === 'A' && heldUnmount === null;
        if (isUnmountSave) {
          let releaseSave!: () => void;
          const saveGate = new Promise<void>((r) => {
            releaseSave = r;
          });
          heldUnmount = { release: releaseSave };
          return saveGate.then(() => {
            apply();
          });
        }
        apply();
        return Promise.resolve();
      }
    );

    const setCurrentConversationId = vi.fn();

    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [] };

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
    try {
      // --- Stream 1: send Q1; tokens buffer; the stream parks ----------------
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q1' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      });
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      // --- Unmount the whole tree mid-stream (as PRR-006a) ------------------
      // The unmount cleanup finalizes + persists the in-flight turn; the mock
      // HOLDS that save unresolved.
      await act(async () => {
        firstTreeUnmounted = true;
        unmount();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });

      expect(
        heldUnmount,
        'sanity: the unmount terminal save must have been issued (and still be held) after the mid-stream unmount'
      ).not.toBeNull();

      // --- Remount: a FRESH ChatPage on the SAME conversation A -------------
      // App hands a remounted page the conversation's thread; seed the view
      // with the finalized first turn (isStreaming stripped), as persisted.
      view = {
        convId: 'A',
        messages: view.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
      };
      render(<Harness />);

      // --- The remounted page sends Q2 while the unmount save is still held -
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Q2' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });

      const q2SendSaves = () =>
        issued.filter(
          (c) => c.id === 'A' && c.messages.some((m) => m.role === 'user' && m.content === 'Q2')
        );

      // FIRST failing assertion at base: base's handleSend issues (and awaits)
      // the send-time save immediately — nothing orders it behind the still-
      // pending unmount save that the DESTROYED ChatPage issued for the SAME
      // conversation (a component-owned sequencer would die with the
      // component, so only a module-lifetime one can order it).
      expect(
        q2SendSaves().length,
        'while the previous mount\'s unmount terminal save is held, the remounted ChatPage\'s send-time save must NOT be issued to onSaveConversation (per-conversation save ordering across ChatPage unmount/remount)'
      ).toBe(0);

      // --- Release: the unmount write lands first, then the queued send-time save.
      await act(async () => {
        heldUnmount?.release();
        for (let i = 0; i < 32; i++) await Promise.resolve();
      });

      expect(
        q2SendSaves().length,
        'once the unmount terminal save settles, the remounted ChatPage\'s send-time save must be issued'
      ).toBeGreaterThanOrEqual(1);

      // The store applies writes in completion order; the final record must
      // end on the NEWER turn. An unsequenced (or component-lifetime-only)
      // implementation lets the held unmount write land AFTER the send-time
      // write, erasing Q2 from the record.
      const finalStored = store.get('A');
      expect(finalStored, 'the owning conversation must have a stored record').toBeDefined();
      const finalMessages = (finalStored as { messages: ChatMessage[] }).messages;
      const storedUserContents = finalMessages.filter((m) => m.role === 'user').map((m) => m.content);
      expect(
        storedUserContents[storedUserContents.length - 1],
        'the final STORED record must end with the remounted page\'s question Q2 — the stale unmount save may never overwrite the newer turn'
      ).toBe('Q2');
      expect(
        finalMessages.some((m) => m.role === 'user' && m.content === 'Q1'),
        'the pre-unmount turn must still be present in the final record (the unmount write landed BEFORE the newer turn, it was not dropped)'
      ).toBe(true);
    } finally {
      // Never leave the held unmount save (or its sequencer queue) pending
      // for the next test; the resolver call is idempotent.
      releaseIfHeld(heldUnmount);
    }
  });
});
