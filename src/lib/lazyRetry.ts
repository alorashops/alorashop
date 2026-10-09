/**
 * lazyRetry (S11b) — wrap a dynamic import so a FAILED chunk load triggers ONE
 * reload, instead of showing a false "offline" card.
 *
 * WHY: the Affiliate page ships as its own chunk that is deliberately EXCLUDED
 * from the service-worker precache (AFFILIATE.md A8), so it is ALWAYS fetched
 * from the network. Right after a deploy, a client still running the OLD shell
 * dynamic-imports the OLD chunk hash — which no longer exists on the CDN — and
 * the lazy import fails. With `registerType: 'autoUpdate'` a plain reload picks
 * up the fresh SW/shell, so one reload turns the hiccup into a no-op.
 *
 * SAFETY: the one-shot guard (sessionStorage) makes it loop-proof — at most one
 * reload per session. A genuinely broken deployment therefore degrades to the
 * error boundary's message rather than a reload loop.
 *
 * Dependency-free and injectable (storage + reload) so the exact logic is unit
 * tested in plain Node by scripts/verify_lazy_retry.mjs.
 */

export const LAZY_RETRY_FLAG = 'alorashop.lazy-retry';

export type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

export interface LazyRetryEnv {
  storage: RetryStorage;
  reload: () => void;
}

/** Read `sessionStorage` safely (it can throw in some private modes). */
function defaultStorage(): RetryStorage {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function defaultEnv(): LazyRetryEnv {
  return {
    storage: defaultStorage(),
    reload: () => {
      if (typeof location !== 'undefined') location.reload();
    }
  };
}

/** True only when a reload has NOT yet been attempted this session. */
export function shouldAttemptReload(storage: RetryStorage): boolean {
  try {
    return !!storage && storage.getItem(LAZY_RETRY_FLAG) !== '1';
  } catch {
    // Storage unavailable -> never reload (fail closed: no loop).
    return false;
  }
}

export function markRetryAttempted(storage: RetryStorage): void {
  try {
    storage?.setItem(LAZY_RETRY_FLAG, '1');
  } catch {
    /* ignore */
  }
}

export function clearRetryAttempted(storage: RetryStorage): void {
  try {
    storage?.removeItem(LAZY_RETRY_FLAG);
  } catch {
    /* ignore */
  }
}

/**
 * Return an importer for `React.lazy`. On success it CLEARS the retry flag (so a
 * later failure may retry again); on failure it reloads ONCE (when allowed) and
 * then rethrows, so the caller's error boundary still renders the message.
 */
export function lazyRetry<T>(factory: () => Promise<T>, env: LazyRetryEnv = defaultEnv()): () => Promise<T> {
  return () =>
    factory().then(
      (mod) => {
        clearRetryAttempted(env.storage);
        return mod;
      },
      (err) => {
        if (shouldAttemptReload(env.storage)) {
          markRetryAttempted(env.storage);
          env.reload();
        }
        throw err;
      }
    );
}
