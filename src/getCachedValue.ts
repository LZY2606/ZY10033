import { Context, CacheEntry, CachifiedOptions } from './common';
import { assertCacheEntry } from './assertCacheEntry';
import { HANDLE } from './common';
import { cachified } from './cachified';
import { Reporter } from './reporter';
import { checkValue } from './checkValue';
import { planCachedEntry, planValidatedValue } from './decisions';

export const CACHE_EMPTY = Symbol();
export async function getCacheEntry<Value>(
  { key, cache }: Pick<Context<Value>, 'key' | 'cache'>,
  report: Reporter<Value>,
): Promise<CacheEntry<unknown> | typeof CACHE_EMPTY> {
  report({ name: 'getCachedValueStart' });
  const cached = await cache.get(key);
  report({ name: 'getCachedValueRead', entry: cached });
  if (cached) {
    assertCacheEntry(cached, key);
    return cached;
  }
  return CACHE_EMPTY;
}

export async function getCachedValue<Value>(
  context: Context<Value>,
  report: Reporter<Value>,
  hasPendingValue: () => boolean,
  now: number,
): Promise<Value | typeof CACHE_EMPTY> {
  const {
    key,
    cache,
    staleWhileRevalidate,
    staleRefreshTimeout,
    metadata,
    getFreshValue,
  } = context;

  try {
    const cached = await getCacheEntry(context, report);

    if (cached === CACHE_EMPTY) {
      report({ name: 'getCachedValueEmpty' });
      return CACHE_EMPTY;
    }

    const plan = planCachedEntry(cached.metadata, now, {
      staleWhileRevalidate,
    });

    if (plan.reportOutdated) {
      report({ name: 'getCachedValueOutdated', ...cached });
    }

    if (plan.backgroundRefresh) {
      const staleRefreshOptions: CachifiedOptions<Value> = {
        ...context,
        async getFreshValue({ metadata }) {
          /* TODO: When staleRefreshTimeout option is removed we should
           also remove this or set it to ~0-200ms depending on ttl values.
           The intention of the delay is to not take sync resources for
           background refreshing – still we need to queue the refresh
           directly so that the de-duplication works.
           See https://github.com/epicweb-dev/cachified/issues/132 */
          await sleep(staleRefreshTimeout);
          report({ name: 'refreshValueStart' });
          return getFreshValue({
            metadata,
            background: true,
          });
        },
        forceFresh: true,
        fallbackToCache: false,
      };

      // pass down batch handle when present
      // https://github.com/epicweb-dev/cachified/issues/144
      staleRefreshOptions.getFreshValue[HANDLE] = context.getFreshValue[HANDLE];

      // refresh cache in background so future requests are faster
      context.waitUntil(
        cachified(staleRefreshOptions)
          .then((value) => {
            report({ name: 'refreshValueSuccess', value });
          })
          .catch((error) => {
            report({ name: 'refreshValueError', error });
          }),
      );
    }

    if (plan.serve) {
      const checkPlan = planValidatedValue(
        await checkValue(context, cached.value),
      );
      if (checkPlan.action === 'accept') {
        report({
          name: 'getCachedValueSuccess',
          value: checkPlan.value,
          migrated: checkPlan.migrated,
        });
        if (!plan.backgroundRefresh) {
          // Notify batch that we handled this call using cached value
          getFreshValue[HANDLE]?.();
        }

        if (checkPlan.migrated) {
          context.waitUntil(
            Promise.resolve().then(async () => {
              try {
                await sleep(0); // align with original setTimeout behavior (allowing other microtasks/tasks to run)
                const cached = await context.cache.get(context.key);

                // Unless cached value was changed in the meantime or is about to
                // change
                if (
                  cached &&
                  cached.metadata.createdTime === metadata.createdTime &&
                  !hasPendingValue()
                ) {
                  // update with migrated value
                  await context.cache.set(context.key, {
                    ...cached,
                    value: checkPlan.value,
                  });
                }
              } catch (err) {
                /* ¯\_(ツ)_/¯ */
              }
            }),
          );
        }

        return checkPlan.value;
      } else {
        report({ name: 'checkCachedValueErrorObj', reason: checkPlan.reason });
        report({
          name: 'checkCachedValueError',
          reason:
            checkPlan.reason instanceof Error
              ? checkPlan.reason.message
              : String(checkPlan.reason),
        });

        await cache.delete(key);
      }
    }
  } catch (error: unknown) {
    report({ name: 'getCachedValueError', error });

    await cache.delete(key);
  }

  return CACHE_EMPTY;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
