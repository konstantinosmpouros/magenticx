import { Search, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import {
  KIND_FILTERS,
  TYPE_FILTERS,
  type KindFilter,
  type TypeFilter,
} from "@/features/artifacts/lib/fileFilters";

const CHIP =
  "inline-flex flex-shrink-0 items-center rounded-full px-3 py-1.5 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/**
 * The Artifacts page's search box and filter chips: the kind (All / Inputs /
 * Outputs) as a segmented group, and the file type as a row of chips that
 * scrolls sideways at phone width instead of wrapping into a wall.
 *
 * The same chip language as the Agents gallery's scope switch; written here
 * rather than shared because Artifacts is its second, differently shaped use
 * (two groups, a scrolling row).
 */
export function ArtifactsToolbar({
  query,
  onQueryChange,
  kind,
  onKindChange,
  type,
  onTypeChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  type: TypeFilter;
  onTypeChange: (type: TypeFilter) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <label htmlFor="artifacts-search" className="sr-only">
            Search files by name
          </label>
          <input
            id="artifacts-search"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search files…"
            maxLength={200}
            className="h-10 w-full rounded-xl border border-border/60 bg-background/60 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <X size={14} aria-hidden />
            </button>
          ) : null}
        </div>
        <div
          role="group"
          aria-label="Show"
          className="inline-flex items-center gap-0.5 rounded-xl bg-muted/40 p-0.5"
        >
          {KIND_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onKindChange(option.id)}
              aria-pressed={kind === option.id}
              className={cn(
                "inline-flex h-9 items-center rounded-[0.6rem] px-3 text-xs font-medium transition-all active:scale-[0.97]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                kind === option.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {/* Bleeds to the screen edge on a phone so the row reads as scrollable. */}
      <div
        role="group"
        aria-label="File type"
        className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {TYPE_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onTypeChange(option.id)}
            aria-pressed={type === option.id}
            className={cn(
              CHIP,
              type === option.id
                ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
