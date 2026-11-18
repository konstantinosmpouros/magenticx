/**
 * The document's outline and heading folds, computed from the Plate value.
 *
 * Both work on top-level blocks by index: a heading folds every block after it
 * up to the next heading of the same or a higher level (the title, an h1,
 * folds the whole document up to the next h1).
 */
import { NodeApi, type Value } from "platejs";

import type { CanvasOutlineItem } from "@/shared/lib/types";

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4 };

/** The heading level of a block type, or null for a non-heading. */
export function headingLevel(type: string | undefined): number | null {
  return (type && HEADING_LEVELS[type]) || null;
}

/** Every heading of the document (h1–h3), in order. */
export function getOutline(value: Value): CanvasOutlineItem[] {
  const items: CanvasOutlineItem[] = [];
  value.forEach((node, index) => {
    const level = headingLevel(node.type as string);
    if (level !== null && level <= 3) {
      items.push({ index, level, text: NodeApi.string(node).trim() });
    }
  });
  return items;
}

/** The top-level block indices hidden by the folded headings. */
export function getHiddenBlocks(value: Value, folded: readonly number[]): number[] {
  const hidden = new Set<number>();
  for (const start of folded) {
    const level = headingLevel(value[start]?.type as string);
    if (level === null) continue;
    for (let index = start + 1; index < value.length; index += 1) {
      const next = headingLevel(value[index].type as string);
      if (next !== null && next <= level) break;
      hidden.add(index);
    }
  }
  return [...hidden].sort((a, b) => a - b);
}
