/**
 * Raw HTML on demand (plan 45): what Streamdown's `import rehypeRaw from
 * "rehype-raw"` resolves to in the build (see `vite.config.ts`). rehype-raw
 * re-parses HTML inside Markdown through parse5 (~125 KB); it now loads in its
 * own chunk — early, while the browser is idle after the first answer mounts
 * (`prefetchRehypeRaw`), and at once when an answer contains HTML first.
 *
 * Until it has loaded, react-markdown shows an HTML tag as its literal text, so
 * the idle prefetch keeps that window to the first moments of a session.
 */
import type rehypeRawType from "rehype-raw";

import { createLazyRehypePlugin } from "./lazyRehypePlugin";

type RawOptions = Parameters<typeof rehypeRawType>[0];

// Module-level loader, so the bundler splits it into the on-demand chunk.
const importRehypeRaw = () => import("rehype-raw");

const raw = createLazyRehypePlugin<RawOptions>(() =>
  importRehypeRaw().then((module) => module.default),
);

/** A tag, comment or doctype opener: Markdown that may hold raw HTML. */
const HTML_START = /<[a-zA-Z!/]/;

/** Whether a text may contain raw HTML for rehype-raw to parse. */
export const needsRehypeRaw = (text: string): boolean => HTML_START.test(text);

export const isRehypeRawReady = raw.isReady;
export const subscribeRehypeRaw = raw.subscribe;
export const loadRehypeRaw = raw.load;

let prefetchScheduled = false;

/** Loads rehype-raw once the browser is idle (once per session). */
export function prefetchRehypeRaw(): void {
  if (prefetchScheduled || raw.isReady() || typeof window === "undefined") return;
  prefetchScheduled = true;
  const start = () => {
    raw.load().catch(() => {
      // The next answer with HTML retries on demand.
    });
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start, { timeout: 4000 });
  } else {
    window.setTimeout(start, 1500);
  }
}

export default raw.plugin;
