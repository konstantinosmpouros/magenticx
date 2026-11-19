/**
 * Where the comment marks go in the reading column's right margin (plan 44,
 * Phase 4.4, `CanvasCommentMarkers`): measured from the painted passages'
 * DOM ranges, so a mark follows the text however it wraps.
 */
import type { CanvasCommentMarker } from "@/shared/lib/types";

/** Lines closer than this (px) count as one line for the margin marks. */
const SAME_LINE_PX = 6;

/**
 * The margin marks from the painted passages: each passage's first line,
 * measured against the column, with passages that start on the same line
 * sharing one mark (in reading order).
 */
export function measureCommentMarkers(
  painted: { id: string; range: Range }[],
  column: HTMLElement | null,
): CanvasCommentMarker[] {
  if (!column) return [];
  const origin = column.getBoundingClientRect().top;
  const lines: CanvasCommentMarker[] = [];
  for (const { id, range } of painted) {
    const first = Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0);
    if (!first) continue;
    const top = Math.round(first.top - origin);
    const height = Math.round(first.height);
    const line = lines.find((item) => Math.abs(item.top - top) < SAME_LINE_PX);
    if (line) line.ids.push(id);
    else lines.push({ top, height, ids: [id] });
  }
  return lines.sort((a, b) => a.top - b.top);
}
