import { useEffect, useState, type RefObject } from "react";
import { useEditorRef, useEditorSelector, usePluginOption } from "platejs/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";

import { caretBlockIndex } from "../lib/askAgent";
import { caretLineCenter } from "../lib/caretOrb";

/** How long the caret rests before the orb fades in (Claude's spark waits too). */
export const CARET_ORB_IDLE_MS = 400;

/** Where the orb shows: the caret's block, and its line's centre from the column's top. */
export interface CaretOrbSpot {
  index: number;
  top: number;
}

/** Whether the focus is in the editable inside `column` (read from the DOM's focus events). */
function inEditable(column: HTMLElement | null, node: EventTarget | null): boolean {
  return (
    column !== null &&
    node instanceof Element &&
    column.contains(node) &&
    node.closest("[data-slate-editor]") !== null
  );
}

/**
 * Whether the document's editable has the focus. Tracked from `focusin` /
 * `focusout` rather than Slate's `useFocused`, so a focus that moves into
 * the orb's own panel and back is seen the moment it happens.
 */
function useEditableFocus(columnRef: RefObject<HTMLElement | null>): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const column = () => columnRef.current;
    setFocused(inEditable(column(), document.activeElement));
    const enter = (event: FocusEvent) => setFocused(inEditable(column(), event.target));
    const leave = (event: FocusEvent) => setFocused(inEditable(column(), event.relatedTarget));
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    return () => {
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
    };
  }, [columnRef]);
  return focused;
}

/**
 * The orb at the caret (plan 44 §3): where it shows, or null while it should
 * not. It shows once the caret has rested `CARET_ORB_IDLE_MS` in a block with
 * text, with the editor focused and nothing selected; any keystroke, caret
 * move or selection hides it at once and starts the wait again, so it is
 * never there while typing. `enabled` is false where it never shows (reading,
 * the agent editing, touch, a reply streaming).
 */
export function useCaretOrb(
  enabled: boolean,
  columnRef: RefObject<HTMLElement | null>,
): CaretOrbSpot | null {
  const editor = useEditorRef();
  const focused = useEditableFocus(columnRef);
  // Subscriptions only: each change restarts the wait.
  const selection = useEditorSelector((ed) => ed.selection, []);
  const value = useEditorSelector((ed) => ed.children, []);
  const selectedIds = usePluginOption(BlockSelectionPlugin, "selectedIds");
  const [spot, setSpot] = useState<CaretOrbSpot | null>(null);

  useEffect(() => {
    setSpot(null);
    if (!enabled || !focused || caretBlockIndex(editor) === null) return;
    const timer = window.setTimeout(() => {
      const index = caretBlockIndex(editor);
      const column = columnRef.current;
      if (index === null || !column) return;
      const top = caretLineCenter(column, index);
      if (top !== null) setSpot({ index, top });
    }, CARET_ORB_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [editor, enabled, focused, selection, value, selectedIds, columnRef]);

  return spot;
}
