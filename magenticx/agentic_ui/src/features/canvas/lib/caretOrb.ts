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
