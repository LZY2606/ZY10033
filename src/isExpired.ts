import { CacheMetadata } from './common';
import { getFreshness } from './decisions';

/**
 * Check wether a cache entry is expired.
 *
 * @returns
 *   - `true` when the cache entry is expired
 *   - `false` when it's still valid
 *   - `"stale"` when it's within the stale period
 */
export function isExpired(metadata: CacheMetadata): boolean | 'stale' {
  const freshness = getFreshness(metadata, Date.now());
  return freshness === 'fresh'
    ? false
    : freshness === 'stale'
    ? 'stale'
    : true;
}

/**
 * @deprecated prefer using `isExpired` instead
 */
export function shouldRefresh(
  metadata: CacheMetadata,
): 'now' | 'stale' | false {
  const expired = isExpired(metadata);

  if (expired === true) {
    return 'now';
  }

  return expired;
}
