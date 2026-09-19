import { CacheEntry } from './common';
import {
  getFreshness,
  planCacheRead,
  planCheckedCacheValue,
  planPendingValue,
  planCacheFallback,
  planFreshValueWrite,
  planSoftPurge,
} from './decisions';

/**
 * Table-driven tests for the side-effect-free decision layer.
 * Every combination of missing / fresh / stale / expired / refreshing
 * states and check results is covered here; the execution layer only
 * performs the planned side effects.
 */

const entry = (metadata: object, value = 'VALUE'): CacheEntry => ({
  metadata: { createdTime: 100, ...metadata } as any,
  value,
});

describe('getFreshness', () => {
  const cases: Array<[string, object, number, string]> = [
    // [description, metadata, now, expected]
    ['no ttl is permanently fresh', { ttl: null }, 999999, 'fresh'],
    ['within ttl', { ttl: 50 }, 150, 'fresh'],
    ['exactly at ttl boundary', { ttl: 50 }, 150, 'fresh'],
    ['just past ttl is stale when swr allows', { ttl: 50, swr: 10 }, 151, 'stale'],
    ['exactly at swr boundary', { ttl: 50, swr: 10 }, 160, 'stale'],
    ['past ttl + swr is expired', { ttl: 50, swr: 10 }, 161, 'expired'],
    ['no swr expires right after ttl', { ttl: 50 }, 151, 'expired'],
    ['ttl 0 and swr 0 is fresh only at createdTime', { ttl: 0, swr: 0 }, 100, 'fresh'],
    ['ttl 0 and swr 0 expires immediately after', { ttl: 0, swr: 0 }, 101, 'expired'],
    /* infinite swr is stored as null and expires per metadata; the infinite
       stale window is applied via the staleWhileRevalidate call option
       (see planCacheRead) */
    ['swr stored as null expires per metadata', { ttl: 50, swr: null }, 999999, 'expired'],
    ['undefined ttl behaves as 0', { swr: 10 }, 101, 'stale'],
    ['legacy swv is honored', { ttl: 50, swv: 10 }, 155, 'stale'],
  ];

  it.each(cases)('%s', (_desc, metadata, now, expected) => {
    expect(getFreshness({ createdTime: 100, ...metadata } as any, now)).toBe(
      expected,
    );
  });

  it('reads a lazy clock at most once', () => {
    const now = jest.fn(() => 130);
    getFreshness({ createdTime: 100, ttl: 50 }, now);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('never reads the clock when metadata cannot expire', () => {
    const now = jest.fn(() => 130);
    expect(getFreshness({ createdTime: 100, ttl: null }, now)).toBe('fresh');
    expect(now).not.toHaveBeenCalled();
  });
});

describe('planCacheRead', () => {
  const cases: Array<[string, CacheEntry | null, number, number, object]> = [
    // [description, entry, now, staleWhileRevalidate option, expected plan]
    ['missing entry is a miss', null, 100, 0, { action: 'miss' }],
    [
      'fresh entry is used without background refresh',
      entry({ ttl: 50 }),
      120,
      0,
      { action: 'use', outdated: false, backgroundRefresh: false },
    ],
    [
      'stale entry is used with background refresh',
      entry({ ttl: 50, swr: 20 }),
      160,
      20,
      { action: 'use', outdated: false, backgroundRefresh: true },
    ],
    [
      'expired entry triggers refresh and is not used',
      entry({ ttl: 50, swr: 20 }),
      180,
      20,
      { action: 'refresh', outdated: true },
    ],
    [
      'expired entry with infinite swr is used with background refresh',
      entry({ ttl: 50, swr: null }),
      999999,
      Infinity,
      { action: 'use', outdated: true, backgroundRefresh: true },
    ],
    [
      'stale entry stays stale-refreshing even without swr option',
      entry({ ttl: 50, swr: 20 }),
      160,
      0,
      { action: 'use', outdated: false, backgroundRefresh: true },
    ],
  ];

  it.each(cases)('%s', (_desc, input, now, swr, expected) => {
    const plan = planCacheRead({
      entry: input,
      now,
      staleWhileRevalidate: swr,
    });
    expect(plan).toMatchObject(expected);
    if (plan.action !== 'miss') {
      expect(plan.entry).toBe(input);
    }
  });
});

describe('planCheckedCacheValue', () => {
  const cases: Array<[string, Parameters<typeof planCheckedCacheValue>[0], object]> = [
    [
      'valid cached value is returned',
      { check: { success: true, value: 'A', migrated: false }, backgroundRefresh: false },
      { action: 'return', value: 'A', migrated: false, notifyHandled: true },
    ],
    [
      'valid cached value during background refresh does not notify the batch handle',
      { check: { success: true, value: 'A', migrated: false }, backgroundRefresh: true },
      { action: 'return', value: 'A', migrated: false, notifyHandled: false },
    ],
    [
      'migrated value keeps its migration flag',
      { check: { success: true, value: 'B', migrated: true }, backgroundRefresh: false },
      { action: 'return', value: 'B', migrated: true, notifyHandled: true },
    ],
    [
      'invalid cached value invalidates the entry',
      { check: { success: false, reason: 'nope' }, backgroundRefresh: false },
      { action: 'invalidate', reason: 'nope' },
    ],
    [
      'invalid cached value invalidates even during background refresh',
      { check: { success: false, reason: new Error('💥') }, backgroundRefresh: true },
      { action: 'invalidate', reason: expect.any(Error) },
    ],
  ];

  it.each(cases)('%s', (_desc, input, expected) => {
    expect(planCheckedCacheValue(input)).toEqual(expected);
  });
});

describe('planPendingValue', () => {
  const cases: Array<[string, object, number, string]> = [
    ['fresh pending value is used', { ttl: 50 }, 120, 'use-pending'],
    ['stale pending value is still used', { ttl: 10, swr: 50 }, 120, 'use-pending'],
    ['expired pending value is discarded', { ttl: 10, swr: 10 }, 121, 'load'],
    ['pending value without ttl is always used', { ttl: null }, 99999, 'use-pending'],
  ];

  it.each(cases)('%s', (_desc, metadata, now, expected) => {
    expect(
      planPendingValue({ createdTime: 100, ...metadata } as any, now),
    ).toEqual({ action: expected });
  });
});

describe('planCacheFallback', () => {
  const cases: Array<[string, CacheEntry | null, number, number, object]> = [
    // [description, entry, fallbackToCache, now, expected]
    ['missing entry throws', null, 1000, 200, { action: 'throw' }],
    [
      'entry older than fallbackToCache throws',
      entry({}),
      50,
      151,
      { action: 'throw' },
    ],
    [
      'entry exactly at fallback age is used',
      entry({}),
      50,
      150,
      { action: 'fallback' },
    ],
    [
      'young entry is used',
      entry({}),
      1000,
      120,
      { action: 'fallback' },
    ],
    [
      'infinite fallback always uses an existing entry',
      entry({}),
      Infinity,
      999999,
      { action: 'fallback' },
    ],
  ];

  it.each(cases)('%s', (_desc, input, fallbackToCache, now, expected) => {
    const plan = planCacheFallback({ entry: input, fallbackToCache, now });
    expect(plan).toMatchObject(expected);
    if (plan.action === 'fallback') {
      expect(plan.entry).toBe(input);
    }
  });
});

describe('planFreshValueWrite', () => {
  const cases: Array<[string, object, number, boolean]> = [
    ['fresh value is written', { ttl: 50 }, 120, true],
    ['stale value is still written', { ttl: 10, swr: 50 }, 120, true],
    ['value expired while loading is not written', { ttl: 10, swr: 10 }, 121, false],
    ['value without ttl is always written', { ttl: null }, 99999, true],
  ];

  it.each(cases)('%s', (_desc, metadata, now, expected) => {
    expect(
      planFreshValueWrite({ createdTime: 100, ...metadata } as any, now),
    ).toEqual({ write: expected });
  });

  it('does not read the lazy clock for non-expiring metadata', () => {
    const now = jest.fn(() => 99999);
    expect(planFreshValueWrite({ createdTime: 100, ttl: null }, now)).toEqual({
      write: true,
    });
    expect(now).not.toHaveBeenCalled();
  });
});

describe('planSoftPurge', () => {
  const cases: Array<[string, CacheEntry | null, number | undefined, number, object]> = [
    // [description, entry, swrOverwrite, now, expected]
    ['missing entry is skipped', null, undefined, 100, { action: 'skip' }],
    [
      'stale entry is skipped',
      entry({ ttl: 10, swr: 50 }),
      undefined,
      120,
      { action: 'skip' },
    ],
    [
      'expired entry is skipped',
      entry({ ttl: 10, swr: 10 }),
      undefined,
      121,
      { action: 'skip' },
    ],
    [
      'fresh entry is rewritten with ttl 0 and previous ttl + swr as swr',
      entry({ ttl: 100, swr: 20 }),
      undefined,
      150,
      {
        action: 'write',
        metadata: { ttl: 0, swr: 120, createdTime: 100 },
      },
    ],
    [
      'fresh entry without swr is rewritten with previous ttl as swr',
      entry({ ttl: 100 }),
      undefined,
      150,
      {
        action: 'write',
        metadata: { ttl: 0, swr: 100, createdTime: 100 },
      },
    ],
    [
      'fresh entry with infinite ttl is rewritten with infinite swr',
      entry({ ttl: null }),
      undefined,
      150,
      {
        action: 'write',
        metadata: { ttl: 0, swr: Infinity, createdTime: 100 },
      },
    ],
    [
      'swr overwrite accounts for the elapsed time',
      entry({ ttl: 100, swr: 20 }),
      30,
      150,
      {
        action: 'write',
        metadata: { ttl: 0, swr: 80, createdTime: 100 },
      },
    ],
  ];

  it.each(cases)('%s', (_desc, input, swrOverwrite, now, expected) => {
    const plan = planSoftPurge({ entry: input, swrOverwrite, now });
    expect(plan).toMatchObject(expected);
    if (plan.action === 'write') {
      expect(plan.entry).toBe(input);
    }
  });

  it('uses the single provided clock reading for elapsed time', () => {
    const plan = planSoftPurge({
      entry: entry({ ttl: 100 }),
      swrOverwrite: 10,
      now: 142,
    });
    expect(plan).toMatchObject({
      action: 'write',
      metadata: { swr: 10 + 42 },
    });
  });
});
