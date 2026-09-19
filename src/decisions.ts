import {
  CacheEntry,
  CacheMetadata,
  staleWhileRevalidate,
} from './common';

/**
 * Side-effect-free decision layer.
 *
 * All freshness / staleness / invalidation / refresh decisions of cachified
 * are made here as pure functions. They receive everything they need as
 * input (a single clock reading `now`, the cache entry, the schema/check
 * result and the call options) and return an explicit action plan.
 *
 * The execution layer (cachified.ts, getCachedValue.ts, getFreshValue.ts,
 * softPurge.ts) only performs the side effects: adapter reads/writes,
 * loader calls and reporter events.
 */

export type Freshness = 'fresh' | 'stale' | 'expired';

/**
 * Input for "the current time". Either a timestamp that was already read
 * once for this decision point, or a lazy clock which the decision layer
 * reads at most once – and not at all when the metadata can never expire.
 */
export type TimeInput = number | (() => number);

function resolveNow(now: TimeInput): number {
  return typeof now === 'function' ? now() : now;
}

/**
 * Classify cache metadata against a single clock reading.
 *
 *  - `fresh`: still within ttl (or no ttl set at all)
 *  - `stale`: ttl exceeded but within the stale-while-revalidate period
 *  - `expired`: beyond ttl + swr
 */
export function getFreshness(
  metadata: CacheMetadata,
  now: TimeInput,
): Freshness {
  /* No TTL means the cache is permanent / never expires */
  if (metadata.ttl === null) {
    return 'fresh';
  }

  const at = resolveNow(now);
  const validUntil = metadata.createdTime + (metadata.ttl || 0);
  const staleUntil = validUntil + (staleWhileRevalidate(metadata) || 0);

  /* We're still within the ttl period */
  if (at <= validUntil) {
    return 'fresh';
  }
  /* We're within the stale period */
  if (at <= staleUntil) {
    return 'stale';
  }

  /* Expired */
  return 'expired';
}

export type CacheReadPlan =
  /* Nothing usable cached, a fresh value has to be loaded */
  | { action: 'miss' }
  /* Entry is outdated and must not be used, a fresh value has to be loaded */
  | { action: 'refresh'; entry: CacheEntry; outdated: true }
  /* Entry may be returned (after value check), optionally refreshing in background */
  | {
      action: 'use';
      entry: CacheEntry;
      outdated: boolean;
      backgroundRefresh: boolean;
    };

/**
 * Decide what to do with a cache entry read from the cache.
 */
export function planCacheRead({
  entry,
  now,
  staleWhileRevalidate: swr,
}: {
  entry: CacheEntry | null;
  now: number;
  staleWhileRevalidate: number;
}): CacheReadPlan {
  if (!entry) {
    return { action: 'miss' };
  }

  const freshness = getFreshness(entry.metadata, now);
  const backgroundRefresh =
    freshness === 'stale' || (freshness === 'expired' && swr === Infinity);

  if (freshness === 'fresh' || backgroundRefresh) {
    return {
      action: 'use',
      entry,
      outdated: freshness === 'expired',
      backgroundRefresh,
    };
  }

  return { action: 'refresh', entry, outdated: true };
}

export type CheckedCachePlan<Value> =
  /* Return the cached value; `notifyHandled` indicates the batch handle
     should be notified that this call was served from cache */
  | {
      action: 'return';
      value: Value;
      migrated: boolean;
      notifyHandled: boolean;
    }
  /* Cached value did not pass the check: delete it and load a fresh value */
  | { action: 'invalidate'; reason: unknown };

export type ValueCheckOutcome<Value> =
  | { success: true; value: Value; migrated: boolean }
  | { success: false; reason: unknown };

/**
 * Decide what to do with the result of checking a cached value.
 */
export function planCheckedCacheValue<Value>({
  check,
  backgroundRefresh,
}: {
  check: ValueCheckOutcome<Value>;
  backgroundRefresh: boolean;
}): CheckedCachePlan<Value> {
  if (!check.success) {
    return { action: 'invalidate', reason: check.reason };
  }
  return {
    action: 'return',
    value: check.value,
    migrated: check.migrated,
    notifyHandled: !backgroundRefresh,
  };
}

export type PendingValuePlan =
  /* A pending refresh is still valid for this call, wait for its value */
  | { action: 'use-pending' }
  /* The pending value is already outdated, load a fresh value instead */
  | { action: 'load' };

/**
 * Decide whether a pending (in-flight) fresh value may be used.
 */
export function planPendingValue(
  metadata: CacheMetadata,
  now: number,
): PendingValuePlan {
  return getFreshness(metadata, now) === 'expired'
    ? { action: 'load' }
    : { action: 'use-pending' };
}

export type CacheFallbackPlan =
  /* The cached entry is young enough to be used as fallback */
  | { action: 'fallback'; entry: CacheEntry }
  /* No usable fallback, the loader error has to be thrown */
  | { action: 'throw' };

/**
 * Decide whether a forced-fresh call that failed to load may fall back
 * to the cached entry.
 */
export function planCacheFallback({
  entry,
  fallbackToCache,
  now,
}: {
  entry: CacheEntry | null;
  fallbackToCache: number;
  now: number;
}): CacheFallbackPlan {
  if (!entry || entry.metadata.createdTime + fallbackToCache < now) {
    return { action: 'throw' };
  }
  return { action: 'fallback', entry };
}

/**
 * Decide whether a freshly loaded value should still be written to cache.
 * (It is not written when it already fully expired while being loaded.)
 *
 * Accepts a lazy clock so the time is only read when the metadata can
 * actually expire.
 */
export function planFreshValueWrite(
  metadata: CacheMetadata,
  now: TimeInput,
): { write: boolean } {
  return { write: getFreshness(metadata, now) !== 'expired' };
}

export type SoftPurgePlan =
  /* Nothing to do: no entry or entry already stale/expired */
  | { action: 'skip' }
  /* Rewrite the entry with ttl 0 so it becomes stale */
  | { action: 'write'; entry: CacheEntry; metadata: CacheMetadata };

/**
 * Decide how a soft purge rewrites the cache entry.
 */
export function planSoftPurge({
  entry,
  swrOverwrite,
  now,
}: {
  entry: CacheEntry | null;
  swrOverwrite: number | undefined;
  now: number;
}): SoftPurgePlan {
  if (!entry || getFreshness(entry.metadata, now) !== 'fresh') {
    return { action: 'skip' };
  }

  const ttl = entry.metadata.ttl || Infinity;
  const swr = staleWhileRevalidate(entry.metadata) || 0;
  const elapsed = now - entry.metadata.createdTime;

  return {
    action: 'write',
    entry,
    metadata: {
      ttl: 0,
      swr: swrOverwrite === undefined ? ttl + swr : swrOverwrite + elapsed,
      createdTime: entry.metadata.createdTime,
    },
  };
}
