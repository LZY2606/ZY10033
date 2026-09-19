import {
  cachified,
  createBatch,
  softPurge,
  CacheEntry,
  createCacheEntry,
} from './index';
import { Deferred } from './createBatch';

/**
 * Behavior guards for the decision-layer refactoring.
 *
 * These tests pin the externally observable behavior that must not change
 * when freshness decisions are moved into src/decisions.ts:
 *  - concurrent calls are merged (no loader storm)
 *  - stale responses and background refresh ordering
 *  - softPurge ttl/swr rewriting
 *  - cache entry deletion after failed value checks
 *  - batch key isolation
 *  - reporter event order (verbatim)
 *  - error object identity and rejection timing
 *  - the clock is read exactly once per call
 *
 * They use a fake clock (mocked Date.now) and never sleep.
 */

let currentTime = 0;
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  currentTime = 0;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
});

function eventLog() {
  const events: string[] = [];
  return {
    events,
    reporter: () => {
      events.push('init');
      return (event: { name: string }) => {
      events.push(event.name);
      };
    },
  };
}

describe('behavior guards', () => {
  it('reads the clock exactly once per call (cache hit)', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('ONE', { ttl: 1000 }));
    const readsBeforeCall = nowSpy.mock.calls.length;

    const value = await cachified({
      cache,
      key: 'test',
      ttl: 1000,
      getFreshValue: () => 'TWO',
    });

    expect(value).toBe('ONE');
    /* The only clock reading of the whole call is the one in createContext;
       every freshness decision receives it as input */
    expect(nowSpy.mock.calls.length - readsBeforeCall).toBe(1);
  });

  it('merges concurrent calls into a single loader run', async () => {
    const cache = new Map<string, CacheEntry>();
    const loader = jest.fn(() => 'ONE');

    const [a, b] = await Promise.all([
      cachified({ cache, key: 'test', getFreshValue: loader }),
      cachified({ cache, key: 'test', getFreshValue: loader }),
    ]);

    expect(a).toBe('ONE');
    expect(b).toBe('ONE');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('merges concurrent calls even when the loader is slow', async () => {
    const cache = new Map<string, CacheEntry>();
    const gate = new Deferred<string>();
    const loader = jest.fn(() => gate.promise);

    const a = cachified({ cache, key: 'test', getFreshValue: loader });
    const b = cachified({ cache, key: 'test', getFreshValue: loader });
    gate.resolve('ONE');

    expect(await a).toBe('ONE');
    expect(await b).toBe('ONE');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('returns stale value first and refreshes in background afterwards', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('STALE', { ttl: 10, swr: 100 }));
    currentTime = 50; // past ttl, within swr

    const { events, reporter } = eventLog();
    const backgroundTasks: Promise<unknown>[] = [];
    const loader = jest.fn(() => 'FRESH');

    const value = await cachified(
      {
        cache,
        key: 'test',
        ttl: 10,
        swr: 100,
        getFreshValue: loader,
        waitUntil: (p) => backgroundTasks.push(p),
      },
      reporter,
    );

    // stale value is returned before the background loader even started
    expect(value).toBe('STALE');
    expect(loader).toHaveBeenCalledTimes(0);
    expect(events).toEqual([
      'init',
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);

    await Promise.all(backgroundTasks);

    expect(loader).toHaveBeenCalledTimes(1);
    // background refresh events are appended after `done`
    expect(events).toEqual([
      'init',
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
      'refreshValueStart',
      'refreshValueSuccess',
    ]);
    expect(cache.get('test')?.value).toBe('FRESH');
  });

  it('softPurge rewrites ttl to 0 and keeps previous ttl + swr as swr', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('ONE', { ttl: 100, swr: 20 }));
    currentTime = 50;

    await softPurge({ cache, key: 'test' });

    expect(cache.get('test')).toEqual({
      value: 'ONE',
      metadata: { ttl: 0, swr: 120, createdTime: 0 },
    });
  });

  it('softPurge with swr overwrite accounts for elapsed time', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('ONE', { ttl: 100, swr: 20 }));
    currentTime = 50;

    await softPurge({ cache, key: 'test', swr: 30 });

    expect(cache.get('test')?.metadata).toEqual({
      ttl: 0,
      swr: 80,
      createdTime: 0,
    });
  });

  it('softPurge leaves stale or expired entries untouched', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('stale', createCacheEntry('A', { ttl: 10, swr: 100 }));
    cache.set('expired', createCacheEntry('B', { ttl: 10, swr: 10 }));
    currentTime = 50;
    const before = [cache.get('stale'), cache.get('expired')];

    await softPurge({ cache, key: 'stale' });
    await softPurge({ cache, key: 'expired' });

    expect(cache.get('stale')).toBe(before[0]);
    expect(cache.get('expired')).toBe(before[1]);
  });

  it('deletes the cache entry when the cached value fails the check', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('BAD', { ttl: 1000 }));
    const deleteMock = jest.spyOn(cache, 'delete');
    const { events, reporter } = eventLog();
    const loader = jest.fn(() => 'FRESH');

    const value = await cachified(
      {
        cache,
        key: 'test',
        checkValue: (value) => value === 'FRESH' || 'not fresh',
        getFreshValue: loader,
      },
      reporter,
    );

    expect(value).toBe('FRESH');
    expect(deleteMock).toHaveBeenCalledWith('test');
    expect(loader).toHaveBeenCalledTimes(1);
    // deletion is reported before the fresh value is loaded
    expect(events).toEqual([
      'init',
      'getCachedValueStart',
      'getCachedValueRead',
      'checkCachedValueErrorObj',
      'checkCachedValueError',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
  });

  it('keeps batch values isolated per key', async () => {
    const cache = new Map<string, CacheEntry>();
    const loader = jest.fn((params: string[]) =>
      params.map((param) => `value:${param}`),
    );
    const batch = createBatch(loader);

    const [a, b] = await Promise.all([
      cachified({ cache, key: 'a', getFreshValue: batch.add('a') }),
      cachified({ cache, key: 'b', getFreshValue: batch.add('b') }),
    ]);

    expect(a).toBe('value:a');
    expect(b).toBe('value:b');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(
      ['a', 'b'],
      [expect.any(Object), expect.any(Object)],
    );
    // each key cached its own value
    expect(cache.get('a')?.value).toBe('value:a');
    expect(cache.get('b')?.value).toBe('value:b');
  });

  it('rejects with the exact error object thrown by the loader', async () => {
    const cache = new Map<string, CacheEntry>();
    const error = new Error('💥');

    await expect(
      cachified({
        cache,
        key: 'test',
        getFreshValue: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it('rejects with check failure cause when fresh value fails the check', async () => {
    const cache = new Map<string, CacheEntry>();

    const promise = cachified({
      cache,
      key: 'test',
      checkValue: () => 'nope',
      getFreshValue: () => 'ONE',
    });

    await expect(promise).rejects.toThrow('check failed for fresh value of test');
    await expect(promise).rejects.toHaveProperty('cause', 'nope');
  });

  it('falls back to cache when a forced fresh value fails', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('CACHED', { ttl: 5 }));
    currentTime = 100; // entry expired, but fallbackToCache defaults to Infinity

    const { events, reporter } = eventLog();
    const value = await cachified(
      {
        cache,
        key: 'test',
        forceFresh: true,
        getFreshValue: () => {
          throw new Error('💥');
        },
      },
      reporter,
    );

    expect(value).toBe('CACHED');
    expect(events).toEqual([
      'init',
      'getFreshValueStart',
      'getFreshValueError',
      'getCachedValueStart',
      'getCachedValueRead',
      'getFreshValueCacheFallback',
      'writeFreshValueSuccess',
      'done',
    ]);
  });
});
