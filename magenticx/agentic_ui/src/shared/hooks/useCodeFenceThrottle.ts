import { useEffect, useReducer, useRef } from "react";

/** How often an open code block's text is handed on while it streams. */
export const CODE_FENCE_THROTTLE_MS = 150;

/**
 * The streaming text to render, refreshed at most every
 * `CODE_FENCE_THROTTLE_MS` while it ends inside an open code block (plan 45).
 *
 * Streamdown highlights a code block with Shiki — twice, for the light and the
 * dark theme — every time its text changes, so a long block streaming in token
 * by token was re-highlighted from the start on every token. Held back to a
 * few updates a second, the block still grows visibly and nothing is lost: the
 * newest text always lands on the next tick, and at once when the block
 * closes (`holdBack` turns false) or the answer stops streaming. Prose outside
 * a code block is never held back.
 */
export function useCodeFenceThrottle(text: string, holdBack: boolean): string {
  const shownRef = useRef(text);
  const latestRef = useRef(text);
  const lastShownAtRef = useRef(0);
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  latestRef.current = text;

  if (!holdBack) {
    shownRef.current = text;
  }

  useEffect(() => {
    if (!holdBack) {
      lastShownAtRef.current = Date.now();
      return;
    }
    if (shownRef.current === text) return;
    const wait = Math.max(0, CODE_FENCE_THROTTLE_MS - (Date.now() - lastShownAtRef.current));
    const timer = setTimeout(() => {
      lastShownAtRef.current = Date.now();
      shownRef.current = latestRef.current;
      refresh();
    }, wait);
    return () => clearTimeout(timer);
  }, [text, holdBack]);

  return shownRef.current;
}
