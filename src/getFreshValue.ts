import { Context, CacheMetadata, createCacheEntry } from './common';
import { getCacheEntry, CACHE_EMPTY } from './getCachedValue';
import { Reporter } from './reporter';
import { checkValue } from './checkValue';
import {
  planCacheFallback,
  planCacheFallbackRead,
  planValidatedValue,
  planWriteFreshValue,
} from './decisions';

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
    if (planCacheFallbackRead({ forceFresh, fallbackToCache })) {
      const entry = await getCacheEntry(context, report);
      const fallbackPlan = planCacheFallback(
        entry === CACHE_EMPTY ? null : entry,
        fallbackToCache,
        Date.now,
      );
      if (fallbackPlan === 'throw' || entry === CACHE_EMPTY) {
        throw error;
      }
      value = entry.value;
      report({ name: 'getFreshValueCacheFallback', value });
    } else {
      // we are either not allowed to check the cache or already checked it
      // nothing we can do anymore
      throw error;
    }
  }

  const checkPlan = planValidatedValue(await checkValue(context, value));
  if (checkPlan.action === 'reject') {
    report({ name: 'checkFreshValueErrorObj', reason: checkPlan.reason });
    report({
      name: 'checkFreshValueError',
      reason:
        checkPlan.reason instanceof Error
          ? checkPlan.reason.message
          : String(checkPlan.reason),
    });

    throw new Error(`check failed for fresh value of ${key}`, {
      cause: checkPlan.reason,
    });
  }

  try {
    /* The clock is handed to the decision layer as input and read at most
       once, after the loader finished */
    const { write } = planWriteFreshValue(metadata, Date.now);
    if (write) {
      await cache.set(key, createCacheEntry(value, metadata));
    }
    report({
      name: 'writeFreshValueSuccess',
      metadata,
      migrated: checkPlan.migrated,
      written: write,
    });
  } catch (error: unknown) {
    report({ name: 'writeFreshValueError', error });
  }

  return checkPlan.value;
}
