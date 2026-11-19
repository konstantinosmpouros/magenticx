/**
 * Where the orb at the caret sits (plan 44 §3): level with the line the caret
 * is on, measured from the reading column's top so the orb, placed inside
 * that column's box, scrolls with the text.
 *
 * Kept out of the component so the measuring (DOM selection first, the
 * block's first line when the caret has no box, as in an empty line) is in
 * one place.
 */
import { KEYS, type TElement } from "platejs";

import { headingLevel } from "./outline";

/**
 * The vertical centre of the caret's line in block `index`, in px from the
 * top of `column`; null when the block is not rendered (folded away).
 */
export function caretLineCenter(column: HTMLElement, index: number): number | null {
  const box = column.getBoundingClientRect();
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    if (column.contains(range.startContainer)) {
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
      if (rect.height > 0) return rect.top - box.top + rect.height / 2;
    }
  }
  // No caret box (an empty line, a caret next to an inline element): the
  // block's first line.
  const block = column.querySelector<HTMLElement>(`[data-canvas-block="${index}"]`);
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  if (rect.height === 0) return null;
  const first = block.firstElementChild instanceof HTMLElement ? block.firstElementChild : block;
  const style = window.getComputedStyle(first);
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 24;
  const padding = Number.parseFloat(style.paddingTop) || 0;
  const margin = first === block ? 0 : first.getBoundingClientRect().top - rect.top;
  return rect.top - box.top + margin + padding + line / 2;
}

/** What the Ask panel's caption calls a block ("Ask about this heading"). */
export function blockNoun(node: TElement | undefined): string {
  if (!node) return "paragraph";
  if (node.listStyleType) return "list item";
  if (headingLevel(node.type) !== null) return "heading";
  if (node.type === KEYS.blockquote) return "quote";
  if (node.type === KEYS.codeBlock) return "code block";
  if (node.type === KEYS.table) return "table";
  return "paragraph";
}

/** The orb's box (px): `size-7`. */
const ORB_SIZE = 28;
/** The gap kept between the orb and a comment mark. */
const ORB_GAP = 4;

/**
 * Where the orb goes so it never covers a comment's margin mark (plan 44
 * v2): its spot unchanged when no mark is on its line; else just right of
 * the mark when the scroller shows that much margin; else under the mark
 * (and under any mark below that one). `left` is px from the column's left,
 * null to keep the default (just outside the column's right edge).
 */
export function orbClearOfMarks(
  column: HTMLElement,
  top: number,
): { top: number; left: number | null } {
  const box = column.getBoundingClientRect();
  const marks = Array.from(column.querySelectorAll<HTMLElement>("[data-canvas-comment-mark]"))
    .map((mark) => {
      const rect = mark.getBoundingClientRect();
      return {
        top: rect.top - box.top,
        bottom: rect.bottom - box.top,
        right: rect.right - box.left,
      };
    })
    .filter((mark) => mark.bottom > mark.top)
    .sort((a, b) => a.top - b.top);
  const hits = (center: number) =>
    marks.find(
      (mark) =>
        center + ORB_SIZE / 2 > mark.top - ORB_GAP && center - ORB_SIZE / 2 < mark.bottom + ORB_GAP,
    );
  const onLine = hits(top);
  if (!onLine) return { top, left: null };

  const scroller = column.closest<HTMLElement>("[data-canvas-scroller]");
  const visibleRight = scroller
    ? scroller.getBoundingClientRect().left + scroller.clientWidth - box.left
    : Number.POSITIVE_INFINITY;
  const besideLeft = onLine.right + ORB_GAP;
  if (besideLeft + ORB_SIZE <= visibleRight - ORB_GAP) return { top, left: besideLeft };

  // No room beside it: under the mark, and under whatever mark is there next.
  let below = onLine.bottom + ORB_GAP + ORB_SIZE / 2;
  for (let next = hits(below); next; next = hits(below)) {
    below = next.bottom + ORB_GAP + ORB_SIZE / 2;
  }
  return { top: below, left: null };
}
