/**
 * The comment threads' passages, painted in the text (plan 44, Phase 4.4):
 * every open thread's passage quietly (`::highlight(canvas-comment)`), the
 * one the user is looking at stronger (`::highlight(canvas-comment-active)`),
 * both in `styles/misc.css`.
 *
 * Drawn with the CSS Custom Highlight API, like Ask agent's tint
 * (`askHighlight.ts`): a comment is not part of the document, so it must not
 * touch the editor's value — no unsaved edit, no markdown change, no fight
 * with the find highlight. Where the API is missing the passages just aren't
 * painted; the threads still list their quotes.
 */
const ALL = "canvas-comment";
const ACTIVE = "canvas-comment-active";

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
    ? CSS.highlights
    : null;

/** Paint the passages (`active` stronger); returns the function that removes them. */
export function paintCommentHighlights(ranges: Range[], active: Range | null): () => void {
  const highlights = registry();
  if (!highlights) return () => {};
  const all = new Highlight(...ranges);
  const strong = active ? new Highlight(active) : null;
  highlights.set(ALL, all);
  if (strong) highlights.set(ACTIVE, strong);
  return () => {
    if (highlights.get(ALL) === all) highlights.delete(ALL);
    if (strong && highlights.get(ACTIVE) === strong) highlights.delete(ACTIVE);
  };
}

/**
 * The DOM position under a point of the screen (a click), for finding which
 * passage was clicked; null where the browser has neither API.
 */
export function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** Smooth scrolling, unless the user asked for reduced motion. */
export const scrollBehavior = (): ScrollBehavior =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
