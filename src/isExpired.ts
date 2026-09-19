import { CacheMetadata } from './common';
import { Freshness, getFreshness } from './decisions';

const expiredByFreshness: Record<Freshness, boolean | 'stale'> = {
  fresh: false,
  stale: 'stale',
  expired: true,
};

/**
 * Check wether a cache entry is expired.
 *
 * @returns
 *   - `true` when the cache entry is expired
 *   - `false` when it's still valid
 *   - `"stale"` when it's within the stale period
 */
export function isExpired(metadata: CacheMetadata): boolean | 'stale' {
  return expiredByFreshness[getFreshness(metadata, Date.now())];
}

const refreshByFreshness: Record<Freshness, 'now' | 'stale' | false> = {
  fresh: false,
  stale: 'stale',
  expired: 'now',
};

/**
 * @deprecated prefer using `isExpired` instead
 */
export function shouldRefresh(
  metadata: CacheMetadata,
): 'now' | 'stale' | false {
  return refreshByFreshness[getFreshness(metadata, Date.now())];
}
