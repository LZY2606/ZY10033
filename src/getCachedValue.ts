import { Context, CacheEntry, CachifiedOptions } from './common';
import { assertCacheEntry } from './assertCacheEntry';
import { HANDLE } from './common';
import { cachified } from './cachified';
import { Reporter } from './reporter';
import { checkValue } from './checkValue';
import { planCacheRead, planCheckedCacheValue } from './decisions';

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
    const readResult = await getCacheEntry(context, report);

    const plan = planCacheRead({
      entry: readResult === CACHE_EMPTY ? null : readResult,
      now: context.now,
      staleWhileRevalidate,
    });

    if (plan.action === 'miss') {
      report({ name: 'getCachedValueEmpty' });
      return CACHE_EMPTY;
    }

    const cached = plan.entry;

    if (plan.outdated) {
      report({ name: 'getCachedValueOutdated', ...cached });
    }

    if (plan.action === 'use' && plan.backgroundRefresh) {
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

    if (plan.action === 'use') {
      const { backgroundRefresh } = plan;
      const valueCheck = await checkValue(context, cached.value);
      const checkedPlan = planCheckedCacheValue({
        check: valueCheck,
        backgroundRefresh,
      });
      if (checkedPlan.action === 'return') {
        report({
          name: 'getCachedValueSuccess',
          value: checkedPlan.value,
          migrated: checkedPlan.migrated,
        });
        if (checkedPlan.notifyHandled) {
          // Notify batch that we handled this call using cached value
          getFreshValue[HANDLE]?.();
        }

        if (checkedPlan.migrated) {
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
                    value: checkedPlan.value,
                  });
                }
              } catch (err) {
                /* ¯\_(ツ)_/¯ */
              }
            }),
          );
        }

        return checkedPlan.value;
      } else {
        report({ name: 'checkCachedValueErrorObj', reason: checkedPlan.reason });
        report({
          name: 'checkCachedValueError',
          reason:
            checkedPlan.reason instanceof Error
              ? checkedPlan.reason.message
              : String(checkedPlan.reason),
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
