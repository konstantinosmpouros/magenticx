import { RangeApi } from "platejs";
import { useEditorSelector, usePluginOption } from "platejs/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";

import type { CanvasAskPassage } from "@/shared/lib/types";

import { caretPassage, selectedPassage } from "../lib/askAgent";

const samePassage = (a: CanvasAskPassage | null, b: CanvasAskPassage | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.text === b.text &&
    RangeApi.equals(a.range, b.range) &&
    a.headingPath.join("\n") === b.headingPath.join("\n"));

/**
 * The passage Ask agent would act on (plan 44, Phase 4.3): the selected
 * blocks, or the text selection — re-read when either changes, and stable
 * while neither does (so the menus don't re-render on every keystroke
 * elsewhere). Block selection lives in a plugin option, not the editor's
 * value, hence the second subscription. With `caretBlock` (the pill's Ask
 * agent), a bare caret counts too: its whole block is the passage.
 */
export function useSelectedPassage({
  caretBlock = false,
}: { caretBlock?: boolean } = {}): CanvasAskPassage | null {
  const selectedIds = usePluginOption(BlockSelectionPlugin, "selectedIds");
  return useEditorSelector(
    (editor) => selectedPassage(editor) ?? (caretBlock ? caretPassage(editor) : null),
    [selectedIds, caretBlock],
    { equalityFn: samePassage },
  );
}
