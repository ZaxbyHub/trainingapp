/**
 * Unit tests for ChatPage's composePinnedContext (issue #83 review follow-up,
 * PRR-013): the injected string's FULL format is pinned — header line
 * "Pinned training slide: <label>" plus the resolved on-screen text on a
 * second line — so a regression dropping the header or the text line fails.
 * The frozen suites only assert `.includes(...)` substrings.
 *
 * Module-boundary mocks mirror the other ChatPage suites (the page module
 * pulls the whole render tree; the function under test is pure).
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../lib/rag/rag-orchestrator', () => ({ RAGOrchestrator: vi.fn() }));
vi.mock('../lib/inference', () => ({ useInferenceMode: vi.fn() }));
vi.mock('../lib/streaming', () => ({ TokenStreamManager: vi.fn() }));
vi.mock('../lib/llm/llm-factory', () => ({ getLLMService: vi.fn() }));
vi.mock('../lib/api/auth', () => ({ getToken: vi.fn() }));
vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: vi.fn(() => ({ session: null, models: null })),
  modelsAbsentForRealEngine: vi.fn(() => false),
  isElectron: vi.fn(() => false),
}));

import { composePinnedContext } from './ChatPage';

describe('composePinnedContext (issue #83 review follow-up)', () => {
  test('section + text → header line with "Section > Title" and the text on line 2', () => {
    const out = composePinnedContext({
      slideId: '5rN4PvXJM5d',
      slideTitle: 'Welcome',
      section: 'Intro Module',
      text: 'The welcome screen introduces the dashboard.',
    });
    expect(out).toBe(
      'Pinned training slide: Intro Module > Welcome\nThe welcome screen introduces the dashboard.'
    );
  });

  test('no section → header with title only; no text → single line', () => {
    const out = composePinnedContext({ slideId: '6RdggQhakWc', slideTitle: 'Roles Menu' });
    expect(out).toBe('Pinned training slide: Roles Menu');
  });

  test('blank slideTitle → label falls back to the slideId (never empty)', () => {
    const out = composePinnedContext({ slideId: '6RdggQhakWc', slideTitle: '   ' });
    expect(out).toBe('Pinned training slide: 6RdggQhakWc');
  });
});
