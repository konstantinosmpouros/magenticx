/**
 * The quiet highlight on the passage Ask agent is about (plan 44, Phase
 * 4.3): while its input is open (the focus has left the editor, so the
 * browser stops painting the selection) and while the agent works on it.
 *
 * Drawn with the CSS Custom Highlight API (`::highlight(canvas-ask)` in
 * `styles/misc.css`) rather than an editor decoration: it changes nothing
 * in the document's value or its rendering, so it can't mark the document
 * unsaved or fight the find highlight. Where the API is missing the passage
 * just isn't tinted — nothing else depends on it.
 *
 * The same tint, under its own name (`canvas-writing`), marks the block the
 * agent is writing right now (plan 44 v2), so the two never clear each other.
 */
import type { SlateEditor, TRange } from "platejs";

type HighlightName = "canvas-ask" | "canvas-writing";

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
    ? CSS.highlights
    : null;

/** Tint `range` of the document; returns the function that removes it. */
export function showAskHighlight(
  editor: SlateEditor,
  range: TRange,
  name: HighlightName = "canvas-ask",
): () => void {
  const highlights = registry();
  if (!highlights) return () => {};
  let dom: Range | null = null;
  try {
    dom = editor.api.toDOMRange(range) ?? null;
  } catch {
    // The range no longer maps onto the rendered text (it changed under it).
    dom = null;
  }
  if (!dom) return () => {};
  const highlight = new Highlight(dom);
  highlights.set(name, highlight);
  return () => {
    if (highlights.get(name) === highlight) highlights.delete(name);
  };
}
