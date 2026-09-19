/**
 * Table tests for the side-effect-free decision layer.
 *
 * Every state combination of freshness (fresh / stale / expired / missing)
 * and the relevant call options is covered exactly once per decision
 * function. The functions are pure: time, cache entry, schema result and
 * options go in, an action plan comes out.
 */
import {
  getFreshness,
  planCachedEntry,
  planCacheFallback,
  planCacheFallbackRead,
  planPendingValue,
  planSoftPurge,
  planValidatedValue,
  planWriteFreshValue,
  Freshness,
} from './decisions';
import { CacheMetadata } from './common';

describe('decision layer', () => {
  describe('getFreshness', () => {
    it.each<[string, CacheMetadata, number, Freshness]>([
      ['no ttl is permanently fresh', { createdTime: 0, ttl: null }, 1000, 'fresh'],
      ['no ttl is fresh at time 0', { createdTime: 0, ttl: null }, 0, 'fresh'],
      ['within ttl', { createdTime: 0, ttl: 5, swr: 10 }, 4, 'fresh'],
      ['exactly at ttl boundary', { createdTime: 0, ttl: 5, swr: 10 }, 5, 'fresh'],
      ['just past ttl is stale', { createdTime: 0, ttl: 5, swr: 10 }, 6, 'stale'],
      ['exactly at stale boundary', { createdTime: 0, ttl: 5, swr: 10 }, 15, 'stale'],
      ['past stale period is expired', { createdTime: 0, ttl: 5, swr: 10 }, 16, 'expired'],
      ['ttl 0 expires right after creation', { createdTime: 0, ttl: 0, swr: 0 }, 1, 'expired'],
      ['ttl 0 is fresh at creation time', { createdTime: 0, ttl: 0, swr: 0 }, 0, 'fresh'],
      ['undefined ttl behaves like 0', { createdTime: 0, swr: 0 }, 1, 'expired'],
      ['undefined swr behaves like 0', { createdTime: 0, ttl: 5 }, 6, 'expired'],
      ['swr null does not extend the stale period', { createdTime: 0, ttl: 5, swr: null }, 6, 'expired'],
      ['created in the past', { createdTime: 100, ttl: 5, swr: 5 }, 106, 'stale'],
      ['negative ttl expires immediately', { createdTime: 0, ttl: -1, swr: 0 }, 0, 'expired'],
    ])('%s', (_label, metadata, now, expected) => {
      expect(getFreshness(metadata, now)).toBe(expected);
    });
  });

  describe('planCachedEntry', () => {
    const fresh = { createdTime: 0, ttl: 5, swr: 10 };
    const stale = { createdTime: 0, ttl: 5, swr: 10 };
    const expired = { createdTime: 0, ttl: 5, swr: 10 };

    it.each([
      ['fresh entry, finite swr option', fresh, 4, 10, { serve: true, backgroundRefresh: false, reportOutdated: false }],
      ['fresh entry, infinite swr option', fresh, 4, Infinity, { serve: true, backgroundRefresh: false, reportOutdated: false }],
      ['stale entry, finite swr option', stale, 6, 10, { serve: true, backgroundRefresh: true, reportOutdated: false }],
      ['stale entry, infinite swr option', stale, 6, Infinity, { serve: true, backgroundRefresh: true, reportOutdated: false }],
      ['expired entry, finite swr option', expired, 16, 10, { serve: false, backgroundRefresh: false, reportOutdated: true }],
      ['expired entry, infinite swr option', expired, 16, Infinity, { serve: true, backgroundRefresh: true, reportOutdated: true }],
      ['expired entry, zero swr option', expired, 16, 0, { serve: false, backgroundRefresh: false, reportOutdated: true }],
    ])('%s', (_label, metadata, now, staleWhileRevalidate, expected) => {
      expect(planCachedEntry(metadata, now, { staleWhileRevalidate })).toEqual(
        expected,
      );
    });
  });

  describe('planPendingValue', () => {
    it.each([
      ['fresh pending value is joined', { createdTime: 0, ttl: 5, swr: 0 }, 4, 'join'],
      ['stale pending value is joined', { createdTime: 0, ttl: 5, swr: 10 }, 6, 'join'],
      ['expired pending value is dropped', { createdTime: 0, ttl: 5, swr: 0 }, 6, 'load'],
      ['pending value without ttl is joined', { createdTime: 0, ttl: null }, 1000, 'join'],
    ] as const)('%s', (_label, metadata, now, expected) => {
      expect(planPendingValue(metadata, now)).toBe(expected);
    });
  });

  describe('planWriteFreshValue', () => {
    it.each([
      ['fresh metadata is written', { createdTime: 0, ttl: 5, swr: 0 }, 4, true],
      ['stale metadata is written', { createdTime: 0, ttl: 5, swr: 10 }, 6, true],
      ['expired metadata is not written', { createdTime: 0, ttl: 5, swr: 0 }, 6, false],
      ['no ttl is always written', { createdTime: 0, ttl: null }, 1000, true],
    ] as const)('%s', (_label, metadata, now, expected) => {
      expect(planWriteFreshValue(metadata, now)).toEqual({ write: expected });
    });
  });

  describe('planCacheFallbackRead', () => {
    it.each([
      ['forced with positive fallback reads cache', { forceFresh: true, fallbackToCache: 1 }, true],
      ['forced with infinite fallback reads cache', { forceFresh: true, fallbackToCache: Infinity }, true],
      ['forced with zero fallback does not read', { forceFresh: true, fallbackToCache: 0 }, false],
      ['unforced call does not read again', { forceFresh: false, fallbackToCache: Infinity }, false],
      ['unforced without fallback does not read', { forceFresh: false, fallbackToCache: 0 }, false],
    ] as const)('%s', (_label, options, expected) => {
      expect(planCacheFallbackRead(options)).toBe(expected);
    });
  });

  describe('planCacheFallback', () => {
    const entry = { metadata: { createdTime: 10, ttl: 5 }, value: 'cached' };

    it.each([
      ['missing entry throws', null, 100, 0, 'throw'],
      ['entry within fallback age is used', entry, 100, 50, 'use'],
      ['entry exactly at fallback age is used', entry, 100, 110, 'use'],
      ['entry past fallback age throws', entry, 100, 111, 'throw'],
      ['infinite fallback age always uses', entry, Infinity, 100000, 'use'],
      ['zero fallback age throws once time passed', entry, 0, 11, 'throw'],
    ] as const)('%s', (_label, entry, fallbackToCache, now, expected) => {
      expect(planCacheFallback(entry, fallbackToCache, now)).toBe(expected);
    });
  });

  describe('planSoftPurge', () => {
    it.each([
      ['missing entry is skipped', null, 0, undefined, { action: 'skip' }],
      [
        'stale entry is skipped',
        { metadata: { createdTime: 0, ttl: 5, swr: 10 }, value: 'v' },
        6,
        undefined,
        { action: 'skip' },
      ],
      [
        'expired entry is skipped',
        { metadata: { createdTime: 0, ttl: 5, swr: 10 }, value: 'v' },
        16,
        undefined,
        { action: 'skip' },
      ],
      [
        'fresh entry carries ttl + swr into swr',
        { metadata: { createdTime: 0, ttl: 5, swr: 3 }, value: 'v' },
        2,
        undefined,
        { action: 'purge', metadata: { ttl: 0, swr: 8, createdTime: 0 } },
      ],
      [
        'fresh entry without swr carries ttl into swr',
        { metadata: { createdTime: 0, ttl: 5 }, value: 'v' },
        2,
        undefined,
        { action: 'purge', metadata: { ttl: 0, swr: 5, createdTime: 0 } },
      ],
      [
        'fresh entry with infinite ttl gets infinite swr',
        { metadata: { createdTime: 0, ttl: null }, value: 'v' },
        2,
        undefined,
        { action: 'purge', metadata: { ttl: 0, swr: Infinity, createdTime: 0 } },
      ],
      [
        'custom swr overwrite adds the elapsed lifetime',
        { metadata: { createdTime: 0, ttl: 5, swr: 3 }, value: 'v' },
        2,
        10,
        { action: 'purge', metadata: { ttl: 0, swr: 12, createdTime: 0 } },
      ],
      [
        'zero swr overwrite results in the elapsed lifetime',
        { metadata: { createdTime: 0, ttl: 5 }, value: 'v' },
        2,
        0,
        { action: 'purge', metadata: { ttl: 0, swr: 2, createdTime: 0 } },
      ],
    ] as const)('%s', (_label, entry, now, swrOverwrite, expected) => {
      expect(planSoftPurge(entry, now, swrOverwrite)).toEqual(expected);
    });
  });

  describe('lazy clock input', () => {
    it('does not read the clock when no ttl is set', () => {
      const clock = jest.fn(() => 1000);
      expect(getFreshness({ createdTime: 0, ttl: null }, clock)).toBe('fresh');
      expect(
        planWriteFreshValue({ createdTime: 0, ttl: null }, clock),
      ).toEqual({ write: true });
      expect(clock).not.toHaveBeenCalled();
    });

    it('reads the clock exactly once per decision', () => {
      const clock = jest.fn(() => 6);
      expect(getFreshness({ createdTime: 0, ttl: 5, swr: 10 }, clock)).toBe(
        'stale',
      );
      expect(clock).toHaveBeenCalledTimes(1);
    });

    it('reads the clock at most once for a soft purge plan', () => {
      const clock = jest.fn(() => 2);
      expect(
        planSoftPurge(
          { metadata: { createdTime: 0, ttl: 5, swr: 3 }, value: 'v' },
          clock,
          undefined,
        ),
      ).toEqual({
        action: 'purge',
        metadata: { ttl: 0, swr: 8, createdTime: 0 },
      });
      expect(clock).toHaveBeenCalledTimes(1);
    });

    it('does not read the clock for a missing soft purge entry', () => {
      const clock = jest.fn(() => 0);
      expect(planSoftPurge(null, clock, undefined)).toEqual({
        action: 'skip',
      });
      expect(clock).not.toHaveBeenCalled();
    });
  });

  describe('planValidatedValue', () => {
    it.each([
      [
        'successful check is accepted',
        { success: true as const, value: 'v', migrated: false },
        { action: 'accept', value: 'v', migrated: false },
      ],
      [
        'migrated check is accepted with migration flag',
        { success: true as const, value: 'v2', migrated: true },
        { action: 'accept', value: 'v2', migrated: true },
      ],
      [
        'failed check is rejected with reason',
        { success: false as const, reason: 'nope' },
        { action: 'reject', reason: 'nope' },
      ],
    ])('%s', (_label, check, expected) => {
      expect(planValidatedValue(check)).toEqual(expected);
    });
  });
});
