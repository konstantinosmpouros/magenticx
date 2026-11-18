/**
 * The canvas's own view state, held as a Plate plugin so every block can read
 * it without prop drilling: which headings are folded, and so which blocks are
 * hidden.
 *
 * The plugin has no render here; `editorKit.ts` attaches the block frame that
 * reads these options. Keeping the plain plugin in its own module lets the
 * frame import it without an import cycle through the kit.
 */
import type { SlateEditor, Value } from "platejs";
import { createPlatePlugin } from "platejs/react";

import { getHiddenBlocks } from "./outline";

export const canvasViewPlugin = createPlatePlugin({
  key: "canvasView",
  options: {
    /** Top-level indices of the folded headings. */
    folded: [] as number[],
    /** Top-level indices hidden by those folds (derived; see `getHiddenBlocks`). */
    hidden: [] as number[],
  },
});

/** Fold exactly `folded` (heading indices) and hide the blocks under them. */
export function setFolds(editor: SlateEditor, folded: number[]) {
  editor.setOption(canvasViewPlugin, "folded", folded);
  editor.setOption(canvasViewPlugin, "hidden", getHiddenBlocks(editor.children as Value, folded));
}

/** Re-derive the hidden blocks after the value changed (a section grew or shrank). */
export function refreshFolds(editor: SlateEditor) {
  setFolds(editor, editor.getOption(canvasViewPlugin, "folded"));
}
