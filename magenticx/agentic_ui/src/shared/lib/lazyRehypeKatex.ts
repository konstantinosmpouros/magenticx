/**
 * KaTeX on demand (plan 45): what Streamdown's `import rehypeKatex from
 * "rehype-katex"` resolves to in the build (see `vite.config.ts`). The real
 * plugin and KaTeX's stylesheet (Streamdown's own CSS import is emptied) load
 * in their own chunk the first time an answer contains math; until then math
 * shows as its source for the moment the chunk takes.
 */
import type rehypeKatexType from "rehype-katex";

import { createLazyRehypePlugin } from "./lazyRehypePlugin";

type KatexOptions = Parameters<typeof rehypeKatexType>[0];

// Module-level loaders, so the bundler splits both into the on-demand chunk.
const importRehypeKatex = () => import("rehype-katex");
const importKatexStyles = () => import("katex/dist/katex.min.css");

const katex = createLazyRehypePlugin<KatexOptions>(() =>
  Promise.all([importRehypeKatex(), importKatexStyles()]).then(([module]) => module.default),
);

/**
 * Whether a text needs KaTeX: `$$` is the only math delimiter Streamdown's
 * remark-math accepts (`singleDollarTextMath: false`).
 */
export const needsKatex = (text: string): boolean => text.includes("$$");

export const isKatexReady = katex.isReady;
export const subscribeKatex = katex.subscribe;
export const loadKatex = katex.load;

export default katex.plugin;
