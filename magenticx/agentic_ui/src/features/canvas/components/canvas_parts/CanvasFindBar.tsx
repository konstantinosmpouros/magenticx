/**
 * Find in document: a slim bar under the header. Matches are highlighted in
 * the text by Plate's find-replace decoration; the bar shows how many there are.
 */
import { Search, X } from "lucide-react";

export function CanvasFindBar({
  query,
  matches,
  onQueryChange,
  onClose,
}: {
  query: string;
  matches: number;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-background px-3 animate-in fade-in-0 slide-in-from-top-1 duration-150 sm:px-4">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <label htmlFor="canvas-find" className="sr-only">
        Find in document
      </label>
      <input
        id="canvas-find"
        // Opened by the user's click on Find: typing straight away is the point.
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        placeholder="Find in document"
        className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {query ? `${matches} ${matches === 1 ? "match" : "matches"}` : ""}
      </span>
      <button
        type="button"
        aria-label="Close find"
        onClick={onClose}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
