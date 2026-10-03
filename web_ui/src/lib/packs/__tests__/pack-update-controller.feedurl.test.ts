// @vitest-environment node
/**
 * The pack-updates localStorage record is user-writable, so its feedUrl is
 * scheme-checked when the record is LOADED (PR 144 review F13): a non-https
 * value is dropped and the controller falls back to the default feed.
 */
import { describe, expect, it } from 'vitest';
import { BrowserUpdatesController, type BrowserUpdatesDeps } from '../pack-update-controller';
import { DEFAULT_UPDATE_FEED_URL } from '../pack-update-browser';
import { PACK_UPDATES_STATE_KEY } from '../../storage/persisted-keys';

function controllerWith(record: unknown): BrowserUpdatesController {
  const store = new Map<string, string>([[PACK_UPDATES_STATE_KEY, JSON.stringify(record)]]);
  const deps: BrowserUpdatesDeps = {
    manager: () => ({ listPacks: async () => [], installPack: async () => { throw new Error('unused'); } }),
    fetchFeed: async () => { throw new Error('unused'); },
    downloadArtifact: async () => { throw new Error('unused'); },
    trustedKeys: () => [],
    storage: () => ({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }),
    airgap: false,
    now: () => new Date(0),
  };
  return new BrowserUpdatesController(deps);
}

describe('pack-updates feedUrl scheme check on load', () => {
  it('keeps an https feedUrl', async () => {
    const status = await controllerWith({ optIn: true, feedUrl: 'https://mirror.example/feed.json' }).getUpdateStatus();
    expect(status.optIn).toBe(true);
    expect(status.feedUrl).toBe('https://mirror.example/feed.json');
  });

  it.each([
    'http://mirror.example/feed.json',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://mirror.example/feed.json',
    'not a url',
  ])('drops %s and falls back to the default feed (opt-in preserved)', async (feedUrl) => {
    const status = await controllerWith({ optIn: true, feedUrl }).getUpdateStatus();
    expect(status.optIn).toBe(true);
    expect(status.feedUrl).toBe(DEFAULT_UPDATE_FEED_URL);
  });
});
