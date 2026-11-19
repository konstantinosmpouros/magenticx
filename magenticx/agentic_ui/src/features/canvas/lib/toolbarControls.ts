/**
 * What every formatting control in the canvas shares (plan 44 §3), whether it
 * sits in the pill at the bottom or in the floating bar over a selection: the
 * button's look, and the press handlers that keep the editor's selection.
 *
 * Kept out of the components so the pill (`CanvasToolbar`) and the selection
 * bar (`CanvasSelectionMenu`) build from the same pieces
 * (`CanvasFormatControls`) instead of two copies drifting apart.
 */
import type { SlateEditor } from "platejs";
import { BlockSelectionPlugin } from "@platejs/selection/react";

import { isSelectingBlocks } from "./blockCommands";
import { rememberSelection } from "./selectionMemory";

/** What every control of the pill and the selection bar looks like (hover, focus, pressed, open). */
const TOOL_BASE =
  "flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 [touch-action:manipulation] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-primary/12 aria-pressed:text-primary data-[state=open]:bg-muted [&_svg]:size-[18px] [@media(pointer:fine)]:[&_svg]:size-4";

/** An icon button of the pill or the selection bar: 32px with a mouse, 44px on touch. */
export const CANVAS_TOOL_BUTTON = `${TOOL_BASE} size-9 [@media(pointer:coarse)]:size-11 [@media(pointer:fine)]:size-8`;

/** A menu button with an icon and a ▾ (the list menu): the same height, as wide as it needs. */
export const CANVAS_TOOL_MENU_BUTTON = `${TOOL_BASE} h-9 gap-0.5 px-1.5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:fine)]:h-8`;

/**
 * Marks the menus and popovers the formatting controls open (portalled to the
 * body): a press inside one is not "a press elsewhere" for the selection bar,
 * which would otherwise close under its own menu.
 */
export const FORMAT_LAYER_ATTR = "data-canvas-format-layer";

/** Keep the editor's focus when a control is pressed with a mouse. */
export const keepSelection = (event: React.MouseEvent) => event.preventDefault();

/**
 * A plain button's pointerdown: remember the selection and keep the focus
 * where it is (on touch too: a prevented pointerdown sends no compat
 * mousedown, so no blur and the keyboard stays open). The click still fires.
 */
export const holdSelection = (editor: SlateEditor) => (event: React.PointerEvent) => {
  rememberSelection(editor);
  event.preventDefault();
};

/** Back to the text, or to the selected blocks, after a menu closes. */
export function refocus(editor: SlateEditor): void {
  if (isSelectingBlocks(editor)) editor.getApi(BlockSelectionPlugin).blockSelection.focus();
  else editor.tf.focus();
}
