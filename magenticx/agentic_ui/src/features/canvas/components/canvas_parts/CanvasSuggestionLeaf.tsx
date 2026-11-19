/**
 * Words the agent inserted or deleted, inside a block it edited (Suggesting
 * mode, plan 44 Phase 4.6): inserted words underlined on a success tint,
 * deleted words struck through in the destructive tone — the same look as
 * the compare view, so the two read alike. Underline and strike-through
 * carry the meaning too, and `<ins>` / `<del>` name it to assistive tech, so
 * colour is never the only sign.
 *
 * Adapted from Plate's registry `suggestion-node` leaf, without its
 * discussion and user wiring (see `lib/suggestions.ts` for why the canvas
 * builds its own suggestions).
 */
import { PlateLeaf, type PlateLeafProps } from "platejs/react";

import { cn } from "@/shared/lib/utils";

import { suggestionMark } from "../../lib/suggestions";

export function CanvasSuggestionLeaf(props: PlateLeafProps) {
  const mark = suggestionMark(props.leaf);
  if (!mark) return <PlateLeaf {...props}>{props.children}</PlateLeaf>;
  const inserted = mark.kind === "insert";
  return (
    <PlateLeaf
      {...props}
      as={inserted ? "ins" : "del"}
      attributes={{ ...props.attributes, "data-canvas-suggestion-id": mark.id } as never}
      className={cn(
        "rounded-[3px] [text-decoration-skip-ink:none]",
        inserted
          ? "bg-success/15 text-foreground underline decoration-success decoration-2 underline-offset-[3px]"
          : "bg-destructive/10 text-foreground/70 line-through decoration-destructive/80 decoration-[1.5px]",
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}
