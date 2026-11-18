/**
 * Keeping the user's text selection across a tap on the toolbar (plan 44,
 * Phase 4.2).
 *
 * On a desktop, `preventDefault` on the button's mousedown keeps the focus
 * and the selection in the editor. On a phone it does not: a tap runs
 * touchstart → touchend → (compat) mousedown → click, and on the way the
 * browser may blur the editor, close its selection handles and collapse the
 * selection to a caret, so Bold would apply to nothing. So every toolbar
 * control remembers the selection on `pointerdown` — the first event of a
 * tap, before any of that — and puts it back right before its command runs.
 *
 * Block selection is left alone: when blocks are selected the editor has no
 * text selection on purpose, and setting one would drop the blocks.
 */
import { RangeApi, TextApi, type Point, type SlateEditor, type TRange } from "platejs";
import { BlockSelectionPlugin } from "@platejs/selection/react";

const remembered = new WeakMap<SlateEditor, TRange>();

const selectingBlocks = (editor: SlateEditor) =>
  (editor.getOption(BlockSelectionPlugin, "selectedIds")?.size ?? 0) > 0;

/** Whether a point still lands inside a text of the document. */
function fits(editor: SlateEditor, point: Point): boolean {
  const entry = editor.api.node(point.path);
  return Boolean(entry && TextApi.isText(entry[0]) && point.offset <= entry[0].text.length);
}

/** Snapshot the editor's selection (a toolbar control was pressed). */
export function rememberSelection(editor: SlateEditor): void {
  if (editor.selection) remembered.set(editor, structuredClone(editor.selection));
}

/**
 * Put the snapshot back if the selection was lost or collapsed meanwhile,
 * then forget it. A snapshot that no longer fits the document (the text
 * changed under it) is dropped.
 */
export function restoreSelection(editor: SlateEditor): void {
  const range = remembered.get(editor);
  remembered.delete(editor);
  if (!range || selectingBlocks(editor)) return;
  const current = editor.selection;
  if (current && RangeApi.equals(current, range)) return;
  if (current && RangeApi.isExpanded(current)) return; // a newer selection wins
  if (!fits(editor, range.anchor) || !fits(editor, range.focus)) return;
  editor.tf.select(range);
}

/** Restore, then run a toolbar command. */
export function withRestoredSelection(editor: SlateEditor, command: () => void): void {
  restoreSelection(editor);
  command();
}
