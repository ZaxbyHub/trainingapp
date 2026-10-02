/**
 * F-006 (PR #142 review): the desktop boot gate re-reads /status/models on
 * every models-changed signal. Out-of-order answers must never let an older
 * request overwrite a newer one (App.tsx wires subscribeLatestModelStatus).
 */
import { afterEach, describe, expect, test } from 'vitest';

import { notifyDesktopModelsChanged, subscribeLatestModelStatus } from './desktop-models-events';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

let unsubscribe: (() => void) | null = null;
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

function setup(): { requests: Array<Deferred<string>>; applied: string[] } {
  const requests: Array<Deferred<string>> = [];
  const applied: string[] = [];
  unsubscribe = subscribeLatestModelStatus(
    () => {
      const d = deferred<string>();
      requests.push(d);
      return d.promise;
    },
    (status) => applied.push(status),
  );
  return { requests, applied };
}

describe('subscribeLatestModelStatus (F-006)', () => {
  test('an older answer arriving after the newer one is dropped', async () => {
    const { requests, applied } = setup();
    notifyDesktopModelsChanged();
    notifyDesktopModelsChanged();
    expect(requests).toHaveLength(2);
    requests[1].resolve('external');
    await flush();
    requests[0].resolve('llama.cpp'); // stale: arrives last
    await flush();
    expect(applied).toEqual(['external']);
  });

  test('a newer request that fails still retires the older in-flight one', async () => {
    const { requests, applied } = setup();
    notifyDesktopModelsChanged();
    notifyDesktopModelsChanged();
    requests[1].reject(new Error('backend restarting'));
    await flush();
    requests[0].resolve('llama.cpp');
    await flush();
    expect(applied).toEqual([]);
  });

  test('in-order answers each apply', async () => {
    const { requests, applied } = setup();
    notifyDesktopModelsChanged();
    requests[0].resolve('external');
    await flush();
    notifyDesktopModelsChanged();
    requests[1].resolve('llama.cpp');
    await flush();
    expect(applied).toEqual(['external', 'llama.cpp']);
  });

  test('nothing applies after unsubscribe (unmount), and no new request starts', async () => {
    const { requests, applied } = setup();
    notifyDesktopModelsChanged();
    unsubscribe?.();
    unsubscribe = null;
    requests[0].resolve('external');
    await flush();
    notifyDesktopModelsChanged();
    expect(requests).toHaveLength(1);
    expect(applied).toEqual([]);
  });
});
