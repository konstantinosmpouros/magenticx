/**
 * The row at the top of the document: the outline toggle (≡) on the left and
 * the mode on the right — "Viewing" in Phase 4.1, where every document is
 * read-only (the Editing / Suggesting menu arrives with editing). It stays at
 * the top as the document scrolls (sticky), on the panel's own background so
 * the text slides under it cleanly.
 */
import { Eye, List } from "lucide-react";

import { cn } from "@/shared/lib/utils";

const pill =
  "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground [@media(pointer:coarse)]:h-10";

export function CanvasDocBar({
  showOutlineButton,
  outlineOpen,
  onToggleOutline,
}: {
  showOutlineButton: boolean;
  outlineOpen: boolean;
  onToggleOutline: () => void;
}) {
  return (
    <div className="sticky top-0 z-20 flex h-12 items-center gap-1 bg-background px-3 sm:px-4">
      {showOutlineButton ? (
        <button
          type="button"
          aria-label="Outline"
          aria-pressed={outlineOpen}
          onClick={onToggleOutline}
          className={cn(
            pill,
            "w-8 justify-center px-0 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:w-10",
            outlineOpen && "bg-muted text-foreground",
          )}
        >
          <List className="size-[18px]" />
        </button>
      ) : null}

      <span className={cn(pill, "ml-auto")} title="This document is read-only">
        <Eye className="size-4" aria-hidden="true" />
        Viewing
      </span>
    </div>
  );
}
