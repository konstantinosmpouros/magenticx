/**
 * The document's outline (≡): its headings, indented by level, as a panel
 * that floats over the left of the document. Picking one scrolls to it and
 * unfolds it if it was folded away.
 */
import { X } from "lucide-react";

import type { CanvasOutlineItem } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

export function CanvasOutline({
  items,
  onPick,
  onClose,
}: {
  items: CanvasOutlineItem[];
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <nav
      aria-label="Outline"
      className="absolute left-3 top-12 z-30 flex max-h-[min(70vh,520px)] w-[min(18rem,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-elegant animate-in fade-in-0 slide-in-from-left-2 duration-200 sm:left-4"
    >
      <div className="flex items-center justify-between px-3.5 pb-1 pt-3">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Outline
        </span>
        <button
          type="button"
          aria-label="Close outline"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      {items.length === 0 ? (
        <p className="px-3.5 pb-3 pt-1 text-[13px] text-muted-foreground">
          This document has no headings.
        </p>
      ) : null}
      <ol className="overflow-y-auto px-1.5 pb-2">
        {items.map((item) => (
          <li key={item.index}>
            <button
              type="button"
              onClick={() => onPick(item.index)}
              className={cn(
                "block w-full truncate rounded-lg py-1.5 pr-2 text-left text-[13.5px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                item.level === 1 && "pl-2 font-semibold text-foreground",
                item.level === 2 && "pl-4 text-foreground/85",
                item.level === 3 && "pl-7 text-muted-foreground",
              )}
            >
              {item.text || "Untitled"}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
