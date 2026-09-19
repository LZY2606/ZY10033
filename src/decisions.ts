import { CacheEntry, CacheMetadata, staleWhileRevalidate } from './common';

/**
 * Internal, side-effect-free decision layer.
 *
 * Every function in this module is pure: it receives the current time, a
 * cache entry (or its metadata), schema/validation results and call options
 * as inputs and returns an explicit action plan. Reading and writing the
 * cache adapter, calling the loader and emitting reporter events all stay in
 * the execution layer (cachified.ts, getCachedValue.ts, getFreshValue.ts,
 * softPurge.ts) which simply carries out the plan it was given.
 *
 * The clock is never read in here – `now` is always passed in by the caller
 * so that a single call can not reach two different conclusions when it
 * crosses a time boundary.
 */

export type Freshness = 'fresh' | 'stale' | 'expired';

/**
 * Input for the clock: either an already-read timestamp or a lazy clock.
 * A lazy clock is read at most once per decision and only when the
 * decision actually needs it, so a single call can not cross a time
 * boundary between two reads and reach two different conclusions.
 */
export type TimeInput = number | (() => number);

function resolveNow(now: TimeInput): number {
  return typeof now === 'function' ? now() : now;
}

/**
 * Classify the freshness of cache metadata at a given point in time.
 *
 * - fresh: within the ttl (or no ttl at all)
 * - stale: ttl exceeded, still within the stale-while-revalidate period
 * - expired: beyond the stale period
 */
export function getFreshness(
  metadata: CacheMetadata,
  now: TimeInput,
): Freshness {
  /* No TTL means the cache is permanent / never expires */
  if (metadata.ttl === null) {
    return 'fresh';
  }

  const currentTime = resolveNow(now);
  const validUntil = metadata.createdTime + (metadata.ttl || 0);
  const staleUntil = validUntil + (staleWhileRevalidate(metadata) || 0);

  if (currentTime > staleUntil) {
    return 'expired';
  }
  return currentTime > validUntil ? 'stale' : 'fresh';
}

/* Lookup tables keep every freshness branch in exactly one place. */
const withinLifetime: Record<Freshness, boolean> = {
  fresh: true,
  stale: true,
  expired: false,
};
const backgroundRefreshByFreshness: Record<Freshness, boolean> = {
  fresh: false,
  stale: true,
  expired: false,
};
const outdatedByFreshness: Record<Freshness, boolean> = {
  fresh: false,
  stale: false,
  expired: true,
};
const onlyWhenFresh: Record<Freshness, boolean> = {
  fresh: true,
  stale: false,
  expired: false,
};

/**
 * Plan for a cache entry that was read from the cache.
 */
export interface CachedEntryPlan {
  /** serve the cached value to the caller (after it passes validation) */
  serve: boolean;
  /** refresh the value in the background for future calls */
  backgroundRefresh: boolean;
  /** emit the outdated event for this entry */
  reportOutdated: boolean;
}

export function planCachedEntry(
  metadata: CacheMetadata,
  now: TimeInput,
  options: { staleWhileRevalidate: number },
): CachedEntryPlan {
  const freshness = getFreshness(metadata, now);
  /* A fully expired entry is still served and refreshed in the background
     when the caller accepts stale values forever */
  const backgroundRefresh =
    backgroundRefreshByFreshness[freshness] ||
    (outdatedByFreshness[freshness] &&
      options.staleWhileRevalidate === Infinity);
  return {
    serve: withinLifetime[freshness] || backgroundRefresh,
    backgroundRefresh,
    reportOutdated: outdatedByFreshness[freshness],
  };
}

/**
 * Plan for a call that arrived while another call is already loading.
 */
export type PendingValuePlan = 'join' | 'load';

export function planPendingValue(
  metadata: CacheMetadata,
  now: TimeInput,
): PendingValuePlan {
  return withinLifetime[getFreshness(metadata, now)] ? 'join' : 'load';
}

/**
 * Plan for writing a freshly loaded value to the cache.
 */
export interface WriteFreshValuePlan {
  /* Only write when the value has not already fully expired while loading */
  write: boolean;
}

export function planWriteFreshValue(
  metadata: CacheMetadata,
  now: TimeInput,
): WriteFreshValuePlan {
  return { write: withinLifetime[getFreshness(metadata, now)] };
}

/**
 * Whether a failed forced refresh may consult the cache at all.
 */
export function planCacheFallbackRead(options: {
  forceFresh: boolean;
  fallbackToCache: number;
}): boolean {
  return options.forceFresh && options.fallbackToCache > 0;
}

/**
 * Plan for using a cache entry as fallback after a failed forced refresh.
 */
export type CacheFallbackPlan = 'use' | 'throw';

export function planCacheFallback(
  entry: CacheEntry<unknown> | null,
  fallbackToCache: number,
  now: TimeInput,
): CacheFallbackPlan {
  if (entry === null) {
    return 'throw';
  }
  /* fallbackToCache is the maximum age a fallback value may have, which is
     exactly a ttl over the entry creation time */
  const freshness = getFreshness(
    { createdTime: entry.metadata.createdTime, ttl: fallbackToCache, swr: 0 },
    now,
  );
  return onlyWhenFresh[freshness] ? 'use' : 'throw';
}

/**
 * Plan for a soft purge: missing or non-fresh entries are left untouched,
 * fresh entries are rewritten with ttl 0 and an adjusted swr.
 */
export type SoftPurgePlan =
  | { action: 'skip' }
  | { action: 'purge'; metadata: CacheMetadata };

export function planSoftPurge(
  entry: CacheEntry<unknown> | null,
  now: TimeInput,
  swrOverwrite: number | undefined,
): SoftPurgePlan {
  if (entry === null) {
    return { action: 'skip' };
  }

  /* The clock is read at most once and the same reading is used for the
     freshness classification and the lifetime computation */
  const currentTime = resolveNow(now);
  if (!onlyWhenFresh[getFreshness(entry.metadata, currentTime)]) {
    return { action: 'skip' };
  }

  const ttl = entry.metadata.ttl || Infinity;
  const swr = staleWhileRevalidate(entry.metadata) || 0;
  const lifetime = currentTime - entry.metadata.createdTime;

  return {
    action: 'purge',
    metadata: {
      ttl: 0,
      swr: swrOverwrite === undefined ? ttl + swr : swrOverwrite + lifetime,
      createdTime: entry.metadata.createdTime,
    },
  };
}

/**
 * Plan for a value that went through the schema/validator.
 * The execution layer maps `reject` to its own follow-up action (deleting
 * the cached entry or throwing for a fresh value).
 */
export type ValidatedValuePlan<Value> =
  | { action: 'accept'; value: Value; migrated: boolean }
  | { action: 'reject'; reason: unknown };

export function planValidatedValue<Value>(
  check:
    | { success: true; value: Value; migrated: boolean }
    | { success: false; reason: unknown },
): ValidatedValuePlan<Value> {
  return check.success
    ? { action: 'accept', value: check.value, migrated: check.migrated }
    : { action: 'reject', reason: check.reason };
}
