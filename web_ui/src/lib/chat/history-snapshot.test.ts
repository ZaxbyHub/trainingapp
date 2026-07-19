/**
 * Unit tests for buildHistorySnapshot (Issue #40 RC1).
 *
 * buildHistorySnapshot extracts the prior conversation turns from the send-time
 * message snapshot and returns them as {role, content} pairs for the RAG
 * orchestrator (browser mode) and the /ask/stream POST body (server mode). Pure
 * and deterministic — tested here in isolation.
 */

import { describe, test, expect } from 'vitest';
import { buildHistorySnapshot, MAX_HISTORY_TURNS } from './history-snapshot';
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

  test('skips error assistant turns', () => {
    const msgs = [user('q1'), errorAssistant(), user('q2'), emptyAssistant()];
    const snap = buildHistorySnapshot(msgs);
    // q1 → error (skipped) → q2 (current, dropped) → placeholder (dropped).
    // After dropping current user + placeholder, only q1 remains; the error
    // assistant is filtered out.
    expect(snap).toEqual([{ role: 'user', content: 'q1' }]);
  });

  test('skips abstain assistant turns', () => {
    const msgs = [user('q1'), abstainAssistant(), user('q2'), emptyAssistant()];
    const snap = buildHistorySnapshot(msgs);
    expect(snap).toEqual([{ role: 'user', content: 'q1' }]);
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
