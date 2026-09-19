import { Context, CacheMetadata, createCacheEntry } from './common';
import { getCacheEntry, CACHE_EMPTY } from './getCachedValue';
import { Reporter } from './reporter';
import { checkValue } from './checkValue';
import { planCacheFallback, planFreshValueWrite } from './decisions';

export async function getFreshValue<Value>(
  context: Context<Value>,
  metadata: CacheMetadata,
  report: Reporter<Value>,
): Promise<Value> {
  const { fallbackToCache, key, getFreshValue, forceFresh, cache } = context;

  let value: unknown;
  try {
    report({ name: 'getFreshValueStart' });
    const freshValue = await getFreshValue({
      metadata: context.metadata,
      background: false,
    });
    value = freshValue;
    report({ name: 'getFreshValueSuccess', value: freshValue });
  } catch (error) {
    report({ name: 'getFreshValueError', error });

    // in case a fresh value was forced (and errored) we might be able to
    // still get one from cache
    if (forceFresh && fallbackToCache > 0) {
      const result = await getCacheEntry(context, report);
      /* The loader has settled by now, so this is a new decision point with
         its own single clock reading (the value may have expired while loading) */
      const now = Date.now();
      const fallbackPlan = planCacheFallback({
        entry: result === CACHE_EMPTY ? null : result,
        fallbackToCache,
        now,
      });
      if (fallbackPlan.action === 'throw') {
        throw error;
      }
      value = fallbackPlan.entry.value;
      report({ name: 'getFreshValueCacheFallback', value });
    } else {
      // we are either not allowed to check the cache or already checked it
      // nothing we can do anymore
      throw error;
    }
  }

  const valueCheck = await checkValue(context, value);
  if (!valueCheck.success) {
    report({ name: 'checkFreshValueErrorObj', reason: valueCheck.reason });
    report({
      name: 'checkFreshValueError',
      reason:
        valueCheck.reason instanceof Error
          ? valueCheck.reason.message
          : String(valueCheck.reason),
    });

    throw new Error(`check failed for fresh value of ${key}`, {
      cause: valueCheck.reason,
    });
  }

  try {
    /* Only write to cache when the value has not already fully expired while getting it.
       The lazy clock is only read when the metadata can actually expire. */
    const { write } = planFreshValueWrite(metadata, Date.now);
    if (write) {
      await cache.set(key, createCacheEntry(value, metadata));
    }
    report({
      name: 'writeFreshValueSuccess',
      metadata,
      migrated: valueCheck.migrated,
      written: write,
    });
  } catch (error: unknown) {
    report({ name: 'writeFreshValueError', error });
  }

  return valueCheck.value;
}
