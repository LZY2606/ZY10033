import { Cache, createCacheEntry } from './common';
import { CACHE_EMPTY, getCacheEntry } from './getCachedValue';
import { planSoftPurge } from './decisions';

interface SoftPurgeOpts {
  cache: Cache;
  key: string;
  /**
   * Force the entry to outdate after ms
   */
  staleWhileRevalidate?: number;
  /**
   * Force the entry to outdate after ms
   */
  swr?: number;
}

export async function softPurge({
  cache,
  key,
  ...swrOverwrites
}: SoftPurgeOpts) {
  const swrOverwrite = swrOverwrites.swr ?? swrOverwrites.staleWhileRevalidate;
  const result = await getCacheEntry({ cache, key }, () => {});

  /* The clock is read exactly once and passed into the decision */
  const now = Date.now();
  const plan = planSoftPurge({
    entry: result === CACHE_EMPTY ? null : result,
    swrOverwrite,
    now,
  });

  if (plan.action === 'skip') {
    return;
  }

  await cache.set(key, createCacheEntry(plan.entry.value, plan.metadata));
}
