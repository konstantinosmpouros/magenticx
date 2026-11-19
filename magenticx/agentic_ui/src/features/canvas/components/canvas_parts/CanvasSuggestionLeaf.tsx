/**
 * Text the user suggested in Suggesting mode (plan 44, Phase 4.6): inserted
 * words underlined on a success tint, deleted words struck through in the
 * destructive tone, a formatting change with a dotted primary underline —
 * the same look as the compare view, so the two read alike. Underline and
 * strike-through carry the meaning too, and `<ins>` / `<del>` name it to
 * assistive tech, so colour is never the only sign. Each leaf carries its
 * suggestion's id, which the ✓ / ✕ controls find it by.
 *
 * Adapted from Plate's registry `suggestion-node` leaf, without its
 * discussion and user wiring (the canvas has one author of suggestions).
 */
import { PlateLeaf, type PlateLeafProps } from "platejs/react";

import { cn } from "@/shared/lib/utils";

import { leafSuggestion } from "../../lib/suggestions";

export function CanvasSuggestionLeaf(props: PlateLeafProps) {
  const mark = leafSuggestion(props.leaf);
  if (!mark) return <PlateLeaf {...props}>{props.children}</PlateLeaf>;
  return (
    <PlateLeaf
      {...props}
      as={mark.kind === "insert" ? "ins" : mark.kind === "remove" ? "del" : "span"}
      attributes={
        {
          ...props.attributes,
          "data-canvas-suggestion-id": mark.id,
          "data-canvas-suggestion": mark.kind,
        } as never
      }
      className={cn(
        "rounded-[3px] [text-decoration-skip-ink:none]",
        mark.kind === "insert" &&
          "bg-success/15 text-foreground underline decoration-success decoration-2 underline-offset-[3px]",
        mark.kind === "remove" &&
          "bg-destructive/10 text-foreground/70 line-through decoration-destructive/80 decoration-[1.5px]",
        mark.kind === "update" &&
          "underline decoration-primary/70 decoration-dotted decoration-2 underline-offset-[3px]",
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}
