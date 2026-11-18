/**
 * The canvas's tooltip on an icon button (header, document bar): the
 * button's name and, when it has one, its shortcut — the same look as the
 * floating toolbar's hints. The child must accept a ref (a button or a Radix
 * trigger); a disabled button shows no tooltip, as everywhere in the app.
 */
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

export function CanvasHint({
  label,
  keys,
  side = "bottom",
  children,
}: {
  label: string;
  keys?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2 text-xs">
        {label}
        {keys ? <kbd className="font-sans text-muted-foreground">{keys}</kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
