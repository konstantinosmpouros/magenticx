/**
 * Drives Streamdown's on-demand rehype plugins (plan 45, `lazyRehypePlugin.ts`)
 * for one answer: loads KaTeX when the text has math and rehype-raw when it has
 * HTML (rehype-raw is otherwise prefetched while the browser is idle), and
 * returns a key for the answer's Streamdown.
 *
 * The key changes only for an answer that rendered math or HTML before its
 * plugin was ready: Streamdown's blocks are memoized on their text, so they
 * re-run their plugins only when remounted. Every other answer keeps one key
 * for its whole life and never remounts.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { isKatexReady, loadKatex, needsKatex, subscribeKatex } from "@/shared/lib/lazyRehypeKatex";
import {
  isRehypeRawReady,
  loadRehypeRaw,
  needsRehypeRaw,
  prefetchRehypeRaw,
  subscribeRehypeRaw,
} from "@/shared/lib/lazyRehypeRaw";

const ignoreLoadFailure = () => {
  // The source text stays; the next answer that needs the plugin retries.
};

export function useLazyRehypePlugins(text: string): string {
  const hasMath = needsKatex(text);
  const hasHtml = needsRehypeRaw(text);
  const katexReady = useSyncExternalStore(subscribeKatex, isKatexReady, isKatexReady);
  const rawReady = useSyncExternalStore(subscribeRehypeRaw, isRehypeRawReady, isRehypeRawReady);

  // Set during render (React's derived-state pattern): the text needed a
  // plugin that had not loaded yet, so it was drawn without it.
  const [renderedWithoutKatex, setRenderedWithoutKatex] = useState(false);
  const [renderedWithoutRaw, setRenderedWithoutRaw] = useState(false);
  if (hasMath && !katexReady && !renderedWithoutKatex) setRenderedWithoutKatex(true);
  if (hasHtml && !rawReady && !renderedWithoutRaw) setRenderedWithoutRaw(true);

  useEffect(() => {
    if (hasMath && !katexReady) loadKatex().catch(ignoreLoadFailure);
  }, [hasMath, katexReady]);

  useEffect(() => {
    if (rawReady) return;
    if (hasHtml) loadRehypeRaw().catch(ignoreLoadFailure);
    else prefetchRehypeRaw();
  }, [hasHtml, rawReady]);

  const katexKey = renderedWithoutKatex && katexReady ? "katex" : "";
  const rawKey = renderedWithoutRaw && rawReady ? "raw" : "";
  return `md${katexKey}${rawKey}`;
}
