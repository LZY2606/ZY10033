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
  const entry = await getCacheEntry({ cache, key }, () => {});

  /* The clock is handed to the decision layer as input and read at most
     once per call */
  const plan = planSoftPurge(
    entry === CACHE_EMPTY ? null : entry,
    Date.now,
    swrOverwrite,
  );

  if (plan.action === 'skip' || entry === CACHE_EMPTY) {
    return;
  }

  await cache.set(key, createCacheEntry(entry.value, plan.metadata));
}
