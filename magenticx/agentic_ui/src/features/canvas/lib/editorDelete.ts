/**
 * Backspace and Delete across blocks, for the canvas (plan 44, Phase 4.2).
 *
 * Plate's defaults leave a document with things the user cannot remove from
 * the keyboard: an empty table (Backspace in its cells does nothing), a
 * horizontal rule or an image (Backspace after it, Delete before it, do
 * nothing), and Backspace after a table pulls the next paragraph into the
 * last cell. This plugin decides those cases before Plate's own handlers
 * (lists, tables, code) see the key, and passes everything else through:
 *
 * | Caret | Backspace | Delete |
 * | --- | --- | --- |
 * | in a table whose cells are all empty | removes the table | removes the table |
 * | at the start of a block after a rule / image (end of a block before one) | removes the rule / image | removes the rule / image |
 * | at the start of a block after a table | an empty block goes, the caret moves into the last cell; text is never merged into a cell | — |
 * | at the end of a block before a table | — | an empty block goes; else the caret moves into the first cell |
 * | in an empty code block | turns it into a paragraph | turns it into a paragraph |
 *
 * And the document never ends up with no block at all (select all, Delete).
 * Written for the canvas: Plate's `SelectOnBackspacePlugin` only selects a
 * void, it does not remove it, and there is no registry plugin for the table
 * cases.
 */
import { KEYS, NodeApi, type SlateEditor, type TElement } from "platejs";
import { createPlatePlugin } from "platejs/react";

const VOID_TYPES: string[] = [KEYS.hr, KEYS.img];
const TEXT_TYPES: string[] = [KEYS.p, KEYS.h1, KEYS.h2, KEYS.h3, KEYS.h4];

/** The top-level block holding a collapsed caret, with its index. */
function caretBlock(editor: SlateEditor): { node: TElement; index: number } | null {
  const selection = editor.selection;
  if (!selection || !editor.api.isCollapsed()) return null;
  const index = selection.anchor.path[0];
  const node = editor.children[index] as TElement | undefined;
  return node ? { node, index } : null;
}

/** A plain text block (not a list item, which the list plugin owns). */
const isPlainText = (node: TElement) => TEXT_TYPES.includes(node.type) && !node[KEYS.listType];

const isEmpty = (node: TElement) => NodeApi.string(node) === "";

/** Remove the block at `index`, keeping at least one block, and put the caret near it. */
function removeAt(editor: SlateEditor, index: number, caret: "start" | "end-of-previous"): void {
  editor.tf.withoutNormalizing(() => {
    editor.tf.removeNodes({ at: [index] });
    if (editor.children.length === 0) {
      editor.tf.insertNodes({ type: KEYS.p, children: [{ text: "" }] }, { at: [0] });
    }
  });
  const last = editor.children.length - 1;
  if (caret === "end-of-previous" && index > 0) editor.tf.select(editor.api.end([index - 1])!);
  else editor.tf.select(editor.api.start([Math.min(index, last)])!);
}

/** The shared decisions; returns true when the key was handled. */
function handle(editor: SlateEditor, reverse: boolean): boolean {
  const at = caretBlock(editor);
  if (!at) return false;
  const { node, index } = at;
  const point = editor.selection!.anchor;

  // An empty table goes as a whole.
  if (node.type === KEYS.table) {
    if (isEmpty(node)) {
      removeAt(editor, index, "start");
      return true;
    }
    return false;
  }

  // An empty code block becomes a paragraph.
  if (node.type === KEYS.codeBlock && isEmpty(node)) {
    editor.tf.withoutNormalizing(() => {
      editor.tf.removeNodes({ at: [index] });
      editor.tf.insertNodes({ type: KEYS.p, children: [{ text: "" }] }, { at: [index] });
    });
    editor.tf.select(editor.api.start([index])!);
    return true;
  }

  if (!isPlainText(node)) return false;

  if (reverse) {
    if (index === 0 || !editor.api.isStart(point, [index])) return false;
    const previous = editor.children[index - 1] as TElement;
    if (VOID_TYPES.includes(previous.type)) {
      editor.tf.removeNodes({ at: [index - 1] });
      editor.tf.select(editor.api.start([index - 1])!);
      return true;
    }
    if (previous.type === KEYS.table) {
      if (isEmpty(node)) removeAt(editor, index, "end-of-previous");
      else editor.tf.select(editor.api.end([index - 1])!);
      return true;
    }
    return false;
  }

  if (index >= editor.children.length - 1 || !editor.api.isEnd(point, [index])) return false;
  const next = editor.children[index + 1] as TElement;
  if (VOID_TYPES.includes(next.type)) {
    editor.tf.removeNodes({ at: [index + 1] });
    return true;
  }
  if (next.type === KEYS.table) {
    if (isEmpty(node)) removeAt(editor, index, "start");
    else editor.tf.select(editor.api.start([index + 1])!);
    return true;
  }
  return false;
}

export const canvasDeletePlugin = createPlatePlugin({ key: "canvasDelete" }).overrideEditor(
  ({ editor, tf: { deleteBackward, deleteForward, normalizeNode } }) => ({
    transforms: {
      deleteBackward(unit) {
        if (handle(editor, true)) return;
        deleteBackward(unit);
      },
      deleteForward(unit) {
        if (handle(editor, false)) return;
        deleteForward(unit);
      },
      normalizeNode(entry, options) {
        // An emptied document gets its one block back.
        if (entry[1].length === 0 && editor.children.length === 0) {
          editor.tf.insertNodes({ type: KEYS.p, children: [{ text: "" }] }, { at: [0] });
          return;
        }
        normalizeNode(entry, options);
      },
    },
  }),
);
