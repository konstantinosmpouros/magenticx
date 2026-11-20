/**
 * The app's one syntax highlighter (plan 45): a single shiki instance shared by
 * the chat's code blocks (`ai-elements/code-block.tsx`) and the attachment code
 * preview, replacing highlight.js, which shipped a second highlighter (~305 KB)
 * in the first download.
 *
 * Shiki's core is already in the entry chunk through Streamdown, so it is
 * imported statically here; what loads lazily is the expensive part — each
 * language grammar is fetched (its own chunk) the first time a block in that
 * language is highlighted, through `loadLanguage` on the one instance. The
 * JavaScript regex engine is the one Streamdown uses, so the app never fetches
 * shiki's Oniguruma WASM.
 *
 * Results are kept in a bounded LRU keyed by a hash of the full code: the old
 * per-component cache grew without limit and keyed on length plus the first and
 * last 100 characters, so two blocks differing only in the middle collided.
 */
import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type ThemedToken,
} from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** The themes every code view uses: light, plus the dark one read through `--shiki-dark`. */
export const CODE_THEMES = { light: "github-light", dark: "github-dark" } as const;

/** A highlighted text: lines of tokens plus the theme's own foreground and background. */
export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

/** Entries kept in the token LRU; a chat rarely shows more distinct blocks than this. */
const TOKENS_CACHE_LIMIT = 200;

let highlighterPromise: Promise<Highlighter> | null = null;
const languageLoads = new Map<string, Promise<void>>();
const tokensCache = new Map<string, TokenizedCode>();
const inFlight = new Map<string, Promise<TokenizedCode>>();

/** The shared instance, created on first use with no grammar loaded yet. */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [CODE_THEMES.light, CODE_THEMES.dark],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }).catch((error: unknown) => {
      // Let a later block try again instead of caching the failure forever.
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

/** Whether shiki ships a grammar for `language` (its names and aliases). */
export function isSupportedLanguage(language: string | undefined): language is BundledLanguage {
  return (
    language !== undefined && Object.prototype.hasOwnProperty.call(bundledLanguages, language)
  );
}

/** Loads one grammar into the shared instance, once. Unknown names fall back to plain text. */
async function ensureLanguage(highlighter: Highlighter, language: string): Promise<string> {
  if (!isSupportedLanguage(language)) return "text";
  let load = languageLoads.get(language);
  if (!load) {
    load = highlighter.loadLanguage(language).catch((error: unknown) => {
      languageLoads.delete(language);
      throw error;
    });
    languageLoads.set(language, load);
  }
  await load;
  return language;
}

/**
 * A 64-bit key from two independent 32-bit string hashes (FNV-1a and djb2) over
 * the whole text, so blocks that share a beginning and an end do not collide.
 */
function hashCode(code: string): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code.charCodeAt(i);
    fnv = Math.imul(fnv ^ ch, 0x01000193);
    djb = (Math.imul(djb, 33) + ch) | 0;
  }
  return `${(fnv >>> 0).toString(36)}${(djb >>> 0).toString(36)}`;
}

const cacheKey = (code: string, language: string) =>
  `${language}:${code.length}:${hashCode(code)}`;

/** The cached highlight for `code`, or null. A hit becomes the most recently used entry. */
export function getCachedTokens(code: string, language: string): TokenizedCode | null {
  const key = cacheKey(code, language);
  const hit = tokensCache.get(key);
  if (!hit) return null;
  tokensCache.delete(key);
  tokensCache.set(key, hit);
  return hit;
}

function remember(key: string, value: TokenizedCode): void {
  tokensCache.set(key, value);
  if (tokensCache.size > TOKENS_CACHE_LIMIT) {
    // A Map iterates in insertion order, so the first key is the least recent.
    const oldest = tokensCache.keys().next().value;
    if (oldest !== undefined) tokensCache.delete(oldest);
  }
}

/**
 * Highlights `code` in both code themes. Concurrent calls for the same text
 * share one tokenization; the result is cached for `getCachedTokens`.
 */
export function tokenizeCode(code: string, language: string): Promise<TokenizedCode> {
  const key = cacheKey(code, language);
  const cached = tokensCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    const highlighter = await getHighlighter();
    const lang = await ensureLanguage(highlighter, language);
    const result = highlighter.codeToTokens(code, {
      lang: lang as BundledLanguage,
      themes: CODE_THEMES,
    });
    const tokenized: TokenizedCode = {
      bg: result.bg ?? "transparent",
      fg: result.fg ?? "inherit",
      tokens: result.tokens,
    };
    remember(key, tokenized);
    return tokenized;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, work);
  return work;
}
