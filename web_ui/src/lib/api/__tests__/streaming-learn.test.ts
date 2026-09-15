/**
 * SSEStreamConsumer learn forwarding tests (issue #82, review PRR-002).
 *
 * The consumer's done-event construction previously whitelisted only
 * {sources, context_length, inference_time}, silently discarding the
 * server's learn[] before TokenStreamManager could forward it. Pins the
 * forwarding (and its tolerance of older servers that omit the field).
 */
import { describe, test, expect, vi } from 'vitest';
import { SSEStreamConsumer } from '../streaming';

function consumerWithDone(): { consumer: SSEStreamConsumer; onDone: ReturnType<typeof vi.fn> } {
  const consumer = new SSEStreamConsumer('http://127.0.0.1:9/ask/stream', { question: 'q' });
  const onDone = vi.fn();
  consumer.onDone(onDone);
  return { consumer, onDone };
}

function processLine(consumer: SSEStreamConsumer, line: string): void {
  (consumer as unknown as { processLine(line: string): void }).processLine(line);
}

describe('SSEStreamConsumer learn forwarding (issue #82)', () => {
  test('done event with learn forwards learn to onDone', () => {
    const { consumer, onDone } = consumerWithDone();
    processLine(
      consumer,
      'data: {"done":true,"sources":["a.md"],"context_length":10,"inference_time":0.5,"learn":[{"slide_id":"5rN4PvXJM5d","title":"Welcome","section":"S","score":0.9,"reason":"direct"}]}',
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    const done = onDone.mock.calls[0][0] as { learn?: Array<{ slide_id: string }> };
    expect(done.learn).toHaveLength(1);
    expect(done.learn![0].slide_id).toBe('5rN4PvXJM5d');
  });

  test('done event without learn (older server) leaves learn undefined', () => {
    const { consumer, onDone } = consumerWithDone();
    processLine(consumer, 'data: {"done":true,"sources":["a.md"],"context_length":10,"inference_time":0.5}');
    expect(onDone).toHaveBeenCalledTimes(1);
    const done = onDone.mock.calls[0][0] as { learn?: unknown };
    expect(done.learn).toBeUndefined();
  });
});
