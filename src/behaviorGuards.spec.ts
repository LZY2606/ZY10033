/**
 * Behavior guards for the decision-layer refactor.
 *
 * These tests pin the externally observable behavior of cachified using only
 * the public API: reporter event order (verbatim), stale-while-revalidate
 * ordering, softPurge TTL rewriting, deletion after failed checks, batch key
 * isolation, concurrency merging, error object identity and rejection timing.
 *
 * They must pass unchanged before and after the refactor — no assertion may
 * be loosened to make them pass. Time is faked via jest.spyOn(Date, 'now');
 * no real sleeps are used.
 */
import {
  cachified,
  createBatch,
  createCacheEntry,
  softPurge,
  CacheEntry,
  CacheEvent,
  CreateReporter,
} from './index';
import { Deferred } from './createBatch';

jest.mock('./index', () => {
  if (process.version.startsWith('v20')) {
    return jest.requireActual('./index');
  } else {
    return require('../dist/index.cjs');
  }
});

let currentTime = 0;
beforeEach(() => {
  currentTime = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
});

function createEventLog() {
  const events: string[] = [];
  const reporter: CreateReporter<any> = () => (event: CacheEvent<any>) => {
    events.push(event.name);
  };
  return { events, reporter };
}

describe('behavior guards', () => {
  it('returns stale value first and refreshes in the background afterwards', async () => {
    const cache = new Map<string, CacheEntry>();
    const { events, reporter } = createEventLog();
    let i = 0;
    const waitUntil = jest.fn();
    const getValue = () =>
      cachified(
        {
          cache,
          key: 'test',
          ttl: 5,
          staleWhileRevalidate: 10,
          getFreshValue: () => `value-${i++}`,
          waitUntil,
        },
        reporter,
      );

    expect(await getValue()).toBe('value-0');
    currentTime = 6;
    // stale value is returned synchronously, refresh happens in background
    expect(await getValue()).toBe('value-0');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];

    expect(events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
      // second call: stale hit, then background refresh events
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
      'refreshValueStart',
      'refreshValueSuccess',
    ]);
    expect(cache.get('test')?.value).toBe('value-1');
  });

  it('reports outdated entries and refreshes synchronously when fully expired', async () => {
    const cache = new Map<string, CacheEntry>();
    const { events, reporter } = createEventLog();
    let i = 0;
    const getValue = () =>
      cachified(
        {
          cache,
          key: 'test',
          ttl: 5,
          staleWhileRevalidate: 10,
          getFreshValue: () => `value-${i++}`,
        },
        reporter,
      );

    expect(await getValue()).toBe('value-0');
    currentTime = 20; // beyond ttl + swr
    expect(await getValue()).toBe('value-1');

    expect(events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueOutdated',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
  });

  it('deletes the cache key before loading when the cached value fails the check', async () => {
    const cache = new Map<string, CacheEntry>();
    const { events, reporter } = createEventLog();
    cache.set('test', createCacheEntry('OLD', { ttl: 100 }));
    const deleteSpy = jest.spyOn(cache, 'delete');
    const loader = jest.fn(() => 'FRESH');

    const value = await cachified(
      {
        cache,
        key: 'test',
        checkValue: (value) => value === 'FRESH',
        getFreshValue: loader,
      },
      reporter,
    );

    expect(value).toBe('FRESH');
    expect(deleteSpy).toHaveBeenCalledWith('test');
    expect(loader).toHaveBeenCalledTimes(1);
    // cache.delete must happen before the loader runs
    expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(
      loader.mock.invocationCallOrder[0],
    );
    expect(events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'checkCachedValueErrorObj',
      'checkCachedValueError',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
    expect(cache.get('test')?.value).toBe('FRESH');
  });

  it('rejects with a stable error object when the fresh value fails the check', async () => {
    const cache = new Map<string, CacheEntry>();
    const setSpy = jest.spyOn(cache, 'set');
    const reason = new Error('does not compute');

    const error = await cachified({
      cache,
      key: 'test',
      checkValue: () => {
        throw reason;
      },
      getFreshValue: () => 'FRESH',
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'check failed for fresh value of test',
    );
    expect((error as Error).cause).toBe(reason);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('falls back to cache when a forced fresh value fails', async () => {
    const cache = new Map<string, CacheEntry>();
    const { events, reporter } = createEventLog();
    cache.set('test', createCacheEntry('CACHED', { ttl: 5 }));
    const loaderError = new Error('loader failed');

    const value = await cachified(
      {
        cache,
        key: 'test',
        ttl: 5,
        forceFresh: true,
        getFreshValue: () => {
          throw loaderError;
        },
      },
      reporter,
    );

    expect(value).toBe('CACHED');
    expect(events).toEqual([
      'getFreshValueStart',
      'getFreshValueError',
      'getCachedValueStart',
      'getCachedValueRead',
      'getFreshValueCacheFallback',
      'writeFreshValueSuccess',
      'done',
    ]);
  });

  it('rejects with the identical loader error when the fallback entry is too old', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('CACHED', { ttl: 5 }));
    const loaderError = new Error('loader failed');
    currentTime = 10;

    const promise = cachified({
      cache,
      key: 'test',
      forceFresh: true,
      fallbackToCache: 2,
      getFreshValue: () => {
        throw loaderError;
      },
    });

    await expect(promise).rejects.toBe(loaderError);
  });

  it('merges concurrent calls for the same cache and key into one loader call', async () => {
    const cache = new Map<string, CacheEntry>();
    const deferred = new Deferred<string>();
    let loaderCalls = 0;
    const events2: string[] = [];

    const promise1 = cachified({
      cache,
      key: 'test',
      getFreshValue: () => {
        loaderCalls++;
        return deferred.promise;
      },
    });
    const promise2 = cachified(
      {
        cache,
        key: 'test',
        getFreshValue: () => {
          loaderCalls++;
          return 'OTHER';
        },
      },
      () => (event: CacheEvent<any>) => {
        events2.push(event.name);
      },
    );

    deferred.resolve('ONE');
    expect(await promise1).toBe('ONE');
    expect(await promise2).toBe('ONE');
    expect(loaderCalls).toBe(1);
    expect(events2).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueHookPending',
      'done',
    ]);
  });

  it('keeps pending values isolated per key and per cache', async () => {
    const cache = new Map<string, CacheEntry>();
    const otherCache = new Map<string, CacheEntry>();
    let loaderCalls = 0;
    const getFreshValue = () => {
      loaderCalls++;
      return 'value';
    };

    await Promise.all([
      cachified({ cache, key: 'a', getFreshValue }),
      cachified({ cache, key: 'b', getFreshValue }),
      cachified({ cache: otherCache, key: 'a', getFreshValue }),
    ]);

    expect(loaderCalls).toBe(3);
  });

  it('rewrites ttl to 0 and carries ttl + swr into swr on softPurge', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('value', { ttl: 5, swr: 3 }));
    currentTime = 2;

    await softPurge({ cache, key: 'test' });

    expect(cache.get('test')).toEqual({
      value: 'value',
      metadata: { ttl: 0, swr: 8, createdTime: 0 },
    });
  });

  it('adds the elapsed lifetime to a custom softPurge swr', async () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('test', createCacheEntry('value', { ttl: 5 }));
    currentTime = 2;

    await softPurge({ cache, key: 'test', swr: 10 });

    expect(cache.get('test')).toEqual({
      value: 'value',
      metadata: { ttl: 0, swr: 12, createdTime: 0 },
    });
  });

  it('leaves stale or missing entries untouched on softPurge', async () => {
    const cache = new Map<string, CacheEntry>();
    const staleEntry = createCacheEntry('value', { ttl: 5 });
    cache.set('stale', staleEntry);
    currentTime = 6;

    await softPurge({ cache, key: 'stale' });
    await softPurge({ cache, key: 'missing' });

    expect(cache.get('stale')).toBe(staleEntry);
    expect(cache.has('missing')).toBe(false);
  });

  it('isolates batch values per key with a single loader call', async () => {
    const cache = new Map<string, CacheEntry>();
    const loader = jest.fn((ids: number[]) =>
      ids.map((id) => `value-${id}`),
    );
    const batch = createBatch(loader);

    const [a, b] = await Promise.all([
      cachified({ cache, key: 'a', getFreshValue: batch.add(1) }),
      cachified({ cache, key: 'b', getFreshValue: batch.add(2) }),
    ]);

    expect(a).toBe('value-1');
    expect(b).toBe('value-2');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0][0]).toEqual([1, 2]);
    expect(cache.get('a')?.value).toBe('value-1');
    expect(cache.get('b')?.value).toBe('value-2');
  });
});
