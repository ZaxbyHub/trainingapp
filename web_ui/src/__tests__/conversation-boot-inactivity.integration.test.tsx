/**
 * Boot replay must settle before the shipped inactivity watcher holds the
 * session-active shared lock. Otherwise the booting tab blocks its own
 * exclusive pending-clear replay until idle. The lock manager below mirrors
 * Web Locks: shared holders coexist, exclusive requires zero holders, and
 * ifAvailable requests never queue.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index')>();
  const fake = await import('../test/fake-dexie');
  const { fakeDbIndexModule } = await import('../test/fake-db-gates');
  return fakeDbIndexModule(actual, new fake.FakeDocQADatabase());
});

import { createConversation, type Conversation } from '../db/conversations';
import * as conversationsModule from '../db/conversations';
import * as convProtocol from '../db/conv-protocol';
import { AppLayout } from '../layouts/AppLayout';
import { useConversations } from '../hooks/useConversations';
import { useInactivityAutoClear } from '../hooks/useInactivityAutoClear';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../lib/storage/persisted-keys';
import { conversationsOf, resetFakeDexie } from '../test/fake-dexie';

vi.stubGlobal('indexedDB', {});

const PREFIX = 'bootlock';
const DB_NAME = `${PREFIX}-doc-qa-conversations`;
const SESSION_LOCK = 'docqa-session-active';

type Mode = 'shared' | 'exclusive';

class FakeLockManager {
  private readonly holders: Array<{ name: string; mode: Mode }> = [];
  private readonly waiters: Array<() => void> = [];

  private canGrant(name: string, mode: Mode): boolean {
    if (mode === 'exclusive') return !this.holders.some((holder) => holder.name === name);
    return !this.holders.some((holder) => holder.name === name && holder.mode === 'exclusive');
  }

  private releaseOne(name: string, mode: Mode): void {
    const index = this.holders.findIndex((holder) => holder.name === name && holder.mode === mode);
    if (index >= 0) this.holders.splice(index, 1);
    for (const waiter of this.waiters.splice(0)) queueMicrotask(waiter);
  }

  request<T>(
    name: string,
    options: { mode?: Mode; ifAvailable?: boolean },
    callback: (lock: { name: string; mode: Mode } | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive';
    return new Promise<T>((resolve, reject) => {
      const attempt = (): void => {
        if (!this.canGrant(name, mode)) {
          if (options.ifAvailable === true) {
            void Promise.resolve(callback(null)).then(resolve, reject);
            return;
          }
          this.waiters.push(attempt);
          return;
        }
        this.holders.push({ name, mode });
        void Promise.resolve(callback({ name, mode })).then(
          (value) => {
            this.releaseOne(name, mode);
            resolve(value as T);
          },
          (error) => {
            this.releaseOne(name, mode);
            reject(error);
          },
        );
      };
      attempt();
    });
  }

  heldModes(name: string): Mode[] {
    return this.holders.filter((holder) => holder.name === name).map((holder) => holder.mode);
  }
}

let locks: FakeLockManager;

function conversation(index: number): Conversation {
  return {
    id: `conv-${index}`,
    title: `Conversation ${index}`,
    messages: [],
    createdAt: index,
    updatedAt: index,
    mode: 'wllama',
    modelUsed: 'test',
  };
}

function BootHarness() {
  const state = useConversations();
  useInactivityAutoClear(state.historyReady, () => {});
  return (
    <AppLayout
      currentPage="chat"
      onNavigate={() => {}}
      conversations={state.conversations}
      currentConversationId={state.currentConversationId}
      onNewChat={state.newChat}
      onSelectConversation={state.selectConversation}
      onRenameConversation={state.renameConversation}
      onDeleteConversation={state.removeConversation}
      hasMore={state.hasMore}
      onLoadMore={state.loadMore}
      searchQuery={state.searchQuery}
      onSearchChange={state.setSearchQuery}
      searchResults={state.searchResults}
      searchTruncated={state.searchTruncated}
      isSearching={state.isSearching}
    >
      <output data-testid="boot-state">{`${state.isInitialized}:${state.conversations.length}`}</output>
      <output data-testid="search-state">{`${state.searchResults?.length ?? -1}`}</output>
      <output data-testid="persistence-state">{state.persistenceError ?? ''}</output>
      <button type="button" onClick={() => void state.refreshConversations()}>Refresh history</button>
    </AppLayout>
  );
}

async function seedPendingClear(): Promise<void> {
  await createConversation(conversation(0));
  await createConversation(conversation(1));
  localStorage.setItem(
    CONVERSATIONS_CLEARED_KEY,
    JSON.stringify({ pending: { epochGoal: 1, profile: PREFIX }, completed: null }),
  );
}

async function holdPeerShared(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  void locks.request(SESSION_LOCK, { mode: 'shared' }, () => held);
  await Promise.resolve();
  return release;
}

beforeEach(() => {
  window.innerWidth = 1280;
  resetFakeDexie();
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, PREFIX);
  locks = new FakeLockManager();
  vi.stubGlobal('navigator', { ...navigator, locks });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation boot versus the shipped inactivity watcher', () => {
  it('replays an owed clear before the watcher can hold this tab shared lock', async () => {
    await seedPendingClear();
    render(<BootHarness />);

    await waitFor(() => expect(screen.getByTestId('boot-state').textContent).toBe('true:0'), { timeout: 1_000 });
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    // Once boot settles, the shipped watcher resumes the normal active-tab guard.
    await waitFor(() => expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared']));
  });

  it('continued activity cannot block boot behind its own watcher, while a peer shared lock still defers replay', async () => {
    await seedPendingClear();
    const releasePeer = await holdPeerShared();
    try {
      render(<BootHarness />);
      fireEvent.keyDown(window, { key: 'a' });
      await new Promise((resolve) => setTimeout(resolve, 250));
      fireEvent.keyDown(window, { key: 'b' });

      expect(screen.getByTestId('boot-state').textContent).toBe('false:0');
      expect(conversationsOf(DB_NAME)).toHaveLength(2);
      expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared']);

      releasePeer();
      await waitFor(() => expect(screen.getByTestId('boot-state').textContent).toBe('true:0'), { timeout: 1_000 });
      expect(conversationsOf(DB_NAME)).toHaveLength(0);
      await waitFor(() => expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared']));
    } finally {
      releasePeer();
    }
  });

  it('the shipped sidebar search cannot publish owed-clear history while boot replay is deferred', async () => {
    await seedPendingClear();
    const searchSpy = vi.spyOn(conversationsModule, 'searchConversations').mockResolvedValue({
      matches: [conversation(0)],
      truncated: false,
    });

    const releasePeer = await holdPeerShared();
    try {
      render(<BootHarness />);
      const search = screen.getByPlaceholderText('Search conversations');
      fireEvent.change(search, { target: { value: 'Conversation 0' } });
      // Wait beyond the production search debounce while the peer still holds
      // the session-active lock and boot replay remains deferred.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });

      expect(screen.getByTestId('boot-state').textContent).toBe('false:0');
      expect(screen.getByTestId('search-state').textContent).toBe('-1');
      expect(screen.queryByText('Conversation 0')).toBeNull();
      expect(conversationsOf(DB_NAME)).toHaveLength(2);

      searchSpy.mockResolvedValue({ matches: [], truncated: false });
      releasePeer();
      await waitFor(() => expect(screen.getByTestId('boot-state').textContent).toBe('true:0'), { timeout: 1_000 });
      await waitFor(() => expect(screen.getByTestId('search-state').textContent).toBe('0'));
      expect(screen.queryByText('Conversation 0')).toBeNull();
      expect(conversationsOf(DB_NAME)).toHaveLength(0);
    } finally {
      releasePeer();
    }
  });

  it('a rejecting retry after a real deferral surfaces the error without releasing the history fence', async () => {
    await seedPendingClear();
    const searchSpy = vi.spyOn(conversationsModule, 'searchConversations').mockResolvedValue({
      matches: [conversation(0)],
      truncated: false,
    });
    const realReplay = convProtocol.replayPendingConversationClear;
    const replaySpy = vi.spyOn(convProtocol, 'replayPendingConversationClear').mockImplementation(async () => {
      if (replaySpy.mock.calls.length === 1) return realReplay();
      throw new Error('retry read failed');
    });

    const releasePeer = await holdPeerShared();
    try {
      render(<BootHarness />);
      await waitFor(() => expect(replaySpy).toHaveBeenCalledTimes(1));
      releasePeer();
      await waitFor(() => expect(screen.getByTestId('boot-state').textContent).toBe('true:0'), { timeout: 1_000 });
      expect(screen.getByTestId('persistence-state').textContent).toContain('Failed to load conversations');
      expect(locks.heldModes(SESSION_LOCK), 'an unsettled replay must not start the watcher shared lock').toEqual([]);
      const peerExclusive = await locks.request(SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => lock);
      expect(peerExclusive, 'a peer can still arbitrate an exclusive replay after the local error').not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId('boot-state').textContent).toBe('true:0');
      expect(screen.queryByText('Conversation 0')).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('Search conversations'), { target: { value: 'Conversation 0' } });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      expect(screen.getByTestId('search-state').textContent).toBe('-1');
      expect(screen.queryByText('Conversation 0')).toBeNull();
      expect(conversationsOf(DB_NAME)).toHaveLength(2);
    } finally {
      releasePeer();
    }
  });
});
