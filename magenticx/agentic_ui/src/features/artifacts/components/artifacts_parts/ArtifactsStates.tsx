import { FolderOpen, RotateCw, SearchX, TriangleAlert } from "lucide-react";

import { Skeleton } from "@/shared/ui/skeleton";

const PANEL = "rounded-[1.4rem] bg-muted/30 px-6 py-12 text-center";
const ACTION =
  "mt-5 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3.5 py-2 text-sm font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/** The first page loading: row-shaped skeletons, so the list does not jump in. */
export function ArtifactsSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading files" className="space-y-2">
      {Array.from({ length: 6 }, (_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-2xl border border-border/40 bg-card/60 px-3 py-2.5 sm:px-4"
        >
          <Skeleton className="h-10 w-10 flex-shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5 rounded-md" />
            <Skeleton className="h-3 w-3/5 rounded-md" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Nothing to show. Two different situations, two different messages: no files
 * at all yet (say where files come from, and offer the way to make one), or a
 * filter/search that matches none (offer to clear it).
 */
export function ArtifactsEmpty({
  filtered,
  onClearFilters,
  onStartChat,
}: {
  filtered: boolean;
  onClearFilters: () => void;
  onStartChat: () => void;
}) {
  return (
    <div className={PANEL} data-testid="artifacts-empty">
      <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        {filtered ? <SearchX size={19} aria-hidden /> : <FolderOpen size={19} aria-hidden />}
      </span>
      <p className="text-sm font-semibold text-foreground">
        {filtered ? "No files match" : "No files yet"}
      </p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        {filtered
          ? "Try a different name, or show every kind and type again."
          : "Files you attach to a message, and the documents, sheets and images agents make for you, all gather here."}
      </p>
      <button type="button" onClick={filtered ? onClearFilters : onStartChat} className={ACTION}>
        {filtered ? "Clear filters" : "Start a chat"}
      </button>
    </div>
  );
}

/** The list could not load. */
export function ArtifactsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={PANEL} role="alert">
      <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <TriangleAlert size={19} aria-hidden />
      </span>
      <p className="text-sm font-semibold text-foreground">Your files could not be loaded</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
      <button type="button" onClick={onRetry} className={ACTION}>
        <RotateCw size={14} aria-hidden /> Try again
      </button>
    </div>
  );
}
