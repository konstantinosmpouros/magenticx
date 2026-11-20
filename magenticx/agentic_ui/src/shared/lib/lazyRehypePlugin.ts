/**
 * A rehype plugin that loads on demand (plan 45), for the two heavy plugins
 * Streamdown imports at its module top: `rehype-katex` (KaTeX, ~260 KB) and
 * `rehype-raw` (parse5, ~125 KB). `vite.config.ts` resolves Streamdown's
 * imports of those packages to the modules built here (`lazyRehypeKatex.ts`,
 * `lazyRehypeRaw.ts`), so they leave the entry chunk and arrive in their own
 * chunk when an answer first needs them.
 *
 * Until it has loaded, the plugin is a transform that leaves the tree alone.
 * `Response` starts the load when its text needs the plugin and remounts its
 * Streamdown once the plugin is ready, because Streamdown's memoized blocks
 * would not re-run their plugins on their own.
 */

/** A unified attacher: options in, transform (or nothing) out. */
type Attacher<Options> = (options?: Options) => unknown;

export interface LazyRehypePlugin<Options> {
  /** The attacher Streamdown calls: the real one once loaded, else a no-op transform. */
  plugin: (options?: Options) => unknown;
  /** Whether the real plugin has loaded. */
  isReady: () => boolean;
  /** Subscribes to the plugin becoming ready (for `useSyncExternalStore`). */
  subscribe: (listener: () => void) => () => void;
  /** Loads the real plugin once; later calls share the first load, a failure may be retried. */
  load: () => Promise<void>;
}

const noopTransform = () => undefined;

export function createLazyRehypePlugin<Options>(
  importPlugin: () => Promise<Attacher<Options>>,
): LazyRehypePlugin<Options> {
  let real: Attacher<Options> | null = null;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  return {
    plugin: (options) => (real ? real(options) : noopTransform),
    isReady: () => real !== null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: () => {
      if (real) return Promise.resolve();
      if (!loading) {
        loading = importPlugin()
          .then((attacher) => {
            real = attacher;
            listeners.forEach((listener) => listener());
          })
          .catch((error: unknown) => {
            // A failed chunk (e.g. offline) may be retried by the next answer.
            loading = null;
            throw error;
          });
      }
      return loading;
    },
  };
}
