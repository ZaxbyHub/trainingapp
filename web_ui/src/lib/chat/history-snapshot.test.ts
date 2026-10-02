/**
 * Unit tests for buildHistorySnapshot (Issue #40 RC1).
 *
 * buildHistorySnapshot extracts the prior conversation turns from the send-time
 * message snapshot and returns them as {role, content} pairs for the RAG
 * orchestrator (browser mode) and the desktop backend's /ask/stream POST body
 * (desktop api mode). Pure
 * and deterministic — tested here in isolation.
 */

import { describe, test, expect } from 'vitest';
import {
  buildDesktopHistorySnapshot,
  buildHistorySnapshot,
  desktopSettingsExcludeGrounded,
  MAX_HISTORY_TURNS,
} from './history-snapshot';
import type { ChatMessage } from '../../types/chat';

const user = (content: string, id = content): ChatMessage => ({
  id,
  role: 'user',
  content,
  timestamp: 0,
});
const assistant = (content: string, id = 'a-' + content): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: 0,
});
const emptyAssistant = (): ChatMessage => ({
  id: 'placeholder',
  role: 'assistant',
  content: '',
  timestamp: 0,
});
const errorAssistant = (): ChatMessage => ({
  id: 'err',
  role: 'assistant',
  content: '',
  error: 'boom',
  timestamp: 0,
});
const abstainAssistant = (): ChatMessage => ({
  id: 'abs',
  role: 'assistant',
  content: '',
  abstain: true,
  abstainReason: 'insufficient_evidence',
  timestamp: 0,
});

describe('buildHistorySnapshot (Issue #40 RC1)', () => {
  test('empty input → empty snapshot', () => {
    expect(buildHistorySnapshot([])).toEqual([]);
  });

  test('drops the trailing empty assistant placeholder and the current user message', () => {
    // owningMessages at send time: [priorUser, priorAssistant, currentUser, emptyAssistant]
    const msgs = [
      user('What is X?'),
      assistant('X is a thing.'),
      user('how do I fix it?'),
      emptyAssistant(),
    ];
    const snap = buildHistorySnapshot(msgs);
    // The current user turn + placeholder are dropped; the prior pair remains.
    expect(snap).toEqual([
      { role: 'user', content: 'What is X?' },
      { role: 'assistant', content: 'X is a thing.' },
    ]);
  });

  test('caps at MAX_HISTORY_TURNS (oldest truncated first)', () => {
    // Build 8 prior user/assistant pairs (16 turns) + current user + placeholder.
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      msgs.push(user(`q${i}`));
      msgs.push(assistant(`a${i}`));
    }
    msgs.push(user('current'));
    msgs.push(emptyAssistant());
    const snap = buildHistorySnapshot(msgs);
    expect(snap.length).toBe(MAX_HISTORY_TURNS);
    // Oldest truncated: the surviving turns are the LAST MAX_HISTORY_TURNS,
    // i.e. the most recent 3 pairs.
    expect(snap[0].content).toBe('q5'); // 6th pair's user turn (0-indexed)
    expect(snap[snap.length - 1].content).toBe('a7');
  });

  test('PRR-001: re-anchors an assistant-first window to user-first', () => {
    // When the MAX_HISTORY_TURNS cap splits mid-conversation on an odd-length
    // alternating history, slice(-N) lands on an assistant-first window
    // (e.g. [u,a,u,a,u,a,u].slice(-6) = [a,u,a,u,a,u]). A leading assistant
    // turn is orphaned context (no preceding user turn in the window) and,
    // under the Gemma 4 chat-template override, mis-targets loop.first so a
    // system_prefix kwarg would be silently dropped. The fix drops the
    // leading assistant turn so the window always opens user-first.
    //
    // 7 prior alternating turns (odd length) + current user + placeholder:
    //   [u0, a0, u1, a1, u2, a2, u3] + [current, placeholder]
    // After dropping current + placeholder: [u0,a0,u1,a1,u2,a2,u3] (length 7)
    // slice(-6) = [a0,u1,a1,u2,a2,u3] → ASSISTANT-FIRST (bug)
    // After re-anchor: [u1,a1,u2,a2,u3] (length 5, user-first)
    const msgs: ChatMessage[] = [
      user('u0'), assistant('a0'),
      user('u1'), assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'),
      user('current'), emptyAssistant(),
    ];
    const snap = buildHistorySnapshot(msgs);
    // The leading a0 must be dropped; window starts at u1. The trailing u3 is
    // ALSO dropped (F-004): its assistant reply never happened, and sending it
    // would put u3 + the current turn on the wire as consecutive user messages.
    expect(snap[0]).toEqual({ role: 'user', content: 'u1' });
    expect(snap[0].role).toBe('user'); // always user-first
    expect(snap[snap.length - 1].role).toBe('assistant'); // never ends on a user turn
    expect(snap.map((t) => t.content)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  test('skips error assistant turns', () => {
    const msgs = [user('q1'), errorAssistant(), user('q2'), emptyAssistant()];
    const snap = buildHistorySnapshot(msgs);
    // q1 → error (skipped) → q2 (current, dropped) → placeholder (dropped).
    // After the current turn is dropped, the errored exchange leaves only
    // q1 — a trailing user turn, which F-004 drops (its answer never
    // happened; sending it would make two consecutive user messages once the
    // caller appends the current turn).
    expect(snap).toEqual([]);
  });

  test('skips abstain assistant turns', () => {
    const msgs = [user('q1'), abstainAssistant(), user('q2'), emptyAssistant()];
    const snap = buildHistorySnapshot(msgs);
    expect(snap).toEqual([]);
  });

  test('F-004: an answered exchange before an errored turn survives intact', () => {
    // [q1, a1(ok), q2, a2(error)] + current q3: the snapshot must be
    // [q1, a1] — the errored exchange is dropped AND the trailing q2 goes
    // with it, so the wire is [user, assistant, user:q3] (alternating).
    const msgs = [
      user('q1'),
      assistant('a1'),
      user('q2'),
      errorAssistant(),
      user('q3'),
      emptyAssistant(),
    ];
    const snap = buildHistorySnapshot(msgs);
    expect(snap).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  test('F-004: a normal conversation never gains a trailing user turn', () => {
    const msgs = [user('q1'), assistant('a1'), user('current'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  test('enforces role alternation (collapses consecutive same-role turns)', () => {
    // A user who fired two messages in a row (e.g. the first errored) produces
    // [user1, user2, assistant]. After alternation enforcement, only the LAST
    // user turn before the assistant survives.
    const msgs = [user('first'), user('second'), assistant('reply'), user('current'), emptyAssistant()];
    const snap = buildHistorySnapshot(msgs);
    expect(snap).toEqual([
      { role: 'user', content: 'second' }, // 'first' collapsed away
      { role: 'assistant', content: 'reply' },
    ]);
  });

  test('produces a clean alternating sequence from a normal conversation', () => {
    const msgs = [
      user('turn1'),
      assistant('answer1'),
      user('turn2'),
      assistant('answer2'),
      user('turn3'),
      emptyAssistant(),
    ];
    const snap = buildHistorySnapshot(msgs);
    expect(snap.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(snap.map((t) => t.content)).toEqual(['turn1', 'answer1', 'turn2', 'answer2']);
  });

  test('all roles map to user|assistant (never system)', () => {
    const systemMsg: ChatMessage = { id: 'sys', role: 'system', content: 'sysprompt', timestamp: 0 };
    const msgs = [systemMsg, user('q'), assistant('a'), user('current'), emptyAssistant()];
    const snap = buildHistorySnapshot(msgs);
    // system messages are not 'user' or 'assistant' in the substantive filter,
    // but the role-mapping clamps any non-assistant to 'user'. System messages
    // are not expected in the chat snapshot (they live in the orchestrator's
    // system prompt), but we verify the mapping never leaks 'system' through.
    for (const turn of snap) {
      expect(turn.role === 'user' || turn.role === 'assistant').toBe(true);
    }
  });
});

describe('F-012: Direct chat never threads retrieval-grounded answers', () => {
  const grounded = (content: string): ChatMessage => ({ ...assistant(content), grounding: 'grounded' });
  const general = (content: string): ChatMessage => ({ ...assistant(content), grounding: 'general' });

  test('excludeGrounded drops a grounded exchange (answer AND its question)', () => {
    const msgs = [user('u1'), grounded('from docs [1]'), user('u2'), general('a2'), user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  test('a conversation of only grounded turns threads nothing into Direct chat', () => {
    const msgs = [user('u1'), grounded('g1'), user('u2'), grounded('g2'), user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([]);
  });

  test('untagged legacy turns are dropped from Direct chat (fail closed), with their question', () => {
    const msgs = [user('u1'), assistant('legacy'), user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([]);
  });

  test('a turn Stopped mid-stream (untagged partial answer) is dropped, with its question', () => {
    // The shape handleCancel leaves: partial content, isStreaming cleared, no
    // grounding/sources/citations (those only arrive with the done event).
    const stopped: ChatMessage = { ...assistant('Per the SOP [1], restart the'), isStreaming: false };
    const msgs = [user('u1'), general('a1'), user('what does the SOP say?'), stopped, user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  test("a 'general' answer that showed sources is dropped (rerank-off answers are tagged general)", () => {
    const withSources: ChatMessage = { ...general('From the handbook: 20 days.'), sources: ['handbook.pdf'] };
    const msgs = [user('leave?'), withSources, user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([]);
  });

  test("a 'general' answer that showed only citations is dropped", () => {
    const withCitations: ChatMessage = {
      ...general('From the handbook [1].'),
      sources: [],
      citations: [{ docId: 'd1', chunkIndex: 0, source: 'handbook.pdf' }],
    };
    const msgs = [user('leave?'), withCitations, user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([]);
  });

  test("a sourceless 'general' answer is kept (Direct-to-Direct continuity; desktop sends [] arrays)", () => {
    const desktopDirect: ChatMessage = { ...general('A device that moves fluid.'), sources: [], citations: [] };
    const browserDirect: ChatMessage = { ...general('A valve controls flow.'), sources: [] };
    const msgs = [user('pump?'), desktopDirect, user('valve?'), browserDirect, user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs, { excludeGrounded: true })).toEqual([
      { role: 'user', content: 'pump?' },
      { role: 'assistant', content: 'A device that moves fluid.' },
      { role: 'user', content: 'valve?' },
      { role: 'assistant', content: 'A valve controls flow.' },
    ]);
  });

  test('without the option (grounded RAG / desktop callers) grounded answers still thread', () => {
    const msgs = [user('u1'), grounded('from docs [1]'), user('now'), emptyAssistant()];
    expect(buildHistorySnapshot(msgs)).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'from docs [1]' },
    ]);
  });
});

describe('F-012 (Stage B): desktop backend settings decide the grounded-answer filter', () => {
  const grounded = (content: string): ChatMessage => ({ ...assistant(content), grounding: 'grounded' });
  const ext = { 'external.enabled': true, 'external.baseUrl': 'http://127.0.0.1:1/v1', 'external.model': 'm' };

  test('desktopSettingsExcludeGrounded: only an active, ungrounded external model (or unknown settings) excludes', () => {
    expect(desktopSettingsExcludeGrounded({ ...ext, 'external.grounded': false })).toBe(true);
    expect(desktopSettingsExcludeGrounded({ ...ext, 'external.grounded': true })).toBe(false);
    expect(desktopSettingsExcludeGrounded({ ...ext, 'external.enabled': false, 'external.grounded': false })).toBe(false);
    expect(desktopSettingsExcludeGrounded({ ...ext, 'external.model': '', 'external.grounded': false })).toBe(false);
    expect(desktopSettingsExcludeGrounded({ ...ext, 'external.baseUrl': '', 'external.grounded': false })).toBe(false);
    // Unknown / malformed: fail closed.
    expect(desktopSettingsExcludeGrounded(null)).toBe(true);
    expect(desktopSettingsExcludeGrounded('nope')).toBe(true);
    expect(desktopSettingsExcludeGrounded({})).toBe(true);
    // external.grounded missing on an active external model: not "true", so exclude.
    expect(desktopSettingsExcludeGrounded({ ...ext })).toBe(true);
  });

  test('buildDesktopHistorySnapshot drops grounded answers unless the backend says grounded', async () => {
    // 'plain' has the exact shape a desktop Direct answer is finalized with
    // (done event: grounding 'general', sources [], citations []).
    const plain: ChatMessage = { ...assistant('plain'), grounding: 'general', sources: [], citations: [] };
    const msgs = [user('q1'), grounded('G-ANSWER'), user('q2'), plain, user('now'), emptyAssistant()];
    const contents = (turns: Array<{ content: string }>) => turns.map((t) => t.content);
    const ungrounded = await buildDesktopHistorySnapshot(
      { getSettings: async () => ({ ...ext, 'external.grounded': false }) },
      msgs,
    );
    expect(contents(ungrounded)).toEqual(['q2', 'plain']);
    const groundedMode = await buildDesktopHistorySnapshot(
      { getSettings: async () => ({ ...ext, 'external.grounded': true }) },
      msgs,
    );
    expect(contents(groundedMode)).toEqual(['q1', 'G-ANSWER', 'q2', 'plain']);
    const failing = await buildDesktopHistorySnapshot({ getSettings: () => Promise.reject(new Error('down')) }, msgs);
    expect(contents(failing)).toEqual(['q2', 'plain']);
    expect(contents(await buildDesktopHistorySnapshot({}, msgs))).toEqual(['q2', 'plain']);
    expect(contents(await buildDesktopHistorySnapshot(null, msgs))).toEqual(['q2', 'plain']);
  });

  test('buildDesktopHistorySnapshot (external Direct) drops a Stopped turn and a sourced general answer', async () => {
    const plain: ChatMessage = { ...assistant('plain'), grounding: 'general', sources: [], citations: [] };
    const stopped: ChatMessage = { ...assistant('STOPPED-PARTIAL from the handbook'), isStreaming: false };
    const rerankOff: ChatMessage = {
      ...assistant('RERANK-OFF from the handbook'),
      grounding: 'general',
      sources: ['handbook.pdf'],
      citations: [],
    };
    const msgs = [
      user('q1'),
      plain,
      user('q2'),
      stopped,
      user('q3'),
      rerankOff,
      user('now'),
      emptyAssistant(),
    ];
    const contents = (turns: Array<{ content: string }>) => turns.map((t) => t.content);
    const ungrounded = await buildDesktopHistorySnapshot(
      { getSettings: async () => ({ ...ext, 'external.grounded': false }) },
      msgs,
    );
    expect(contents(ungrounded)).toEqual(['q1', 'plain']);
    // A failed settings read is fail-closed too.
    const failing = await buildDesktopHistorySnapshot({ getSettings: () => Promise.reject(new Error('down')) }, msgs);
    expect(contents(failing)).toEqual(['q1', 'plain']);
  });
});
