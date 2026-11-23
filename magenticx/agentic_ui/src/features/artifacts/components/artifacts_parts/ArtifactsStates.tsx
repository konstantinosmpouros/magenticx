/**
 * The Artifacts page's states besides a list of files: the first page loading
 * (skeletons shaped like what will land, so nothing jumps in), nothing to show
 * (two different situations, two different messages) and a failed load.
 */
import { MessageSquarePlus, RotateCw, SearchX, TriangleAlert } from "lucide-react";

import { Skeleton } from "@/shared/ui/skeleton";
import { FileStackArt } from "@/features/artifacts/components/artifacts_parts/FileStackArt";
import type { ArtifactsView } from "@/features/artifacts/hooks/useArtifactsView";

const PANEL =
  "relative overflow-hidden rounded-[1.6rem] border border-border/50 bg-gradient-to-b from-muted/40 to-transparent px-6 py-14 text-center";
const PRIMARY_ACTION =
  "mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-primary/35 active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const SECONDARY_ACTION =
  "mt-6 inline-flex h-11 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-5 text-sm font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/** The first page loading: card- or row-shaped skeletons for the chosen layout. */
export function ArtifactsSkeleton({ view }: { view: ArtifactsView }) {
  if (view === "list") {
    return (
      <div aria-busy="true" aria-label="Loading files" className="space-y-2.5 pt-3">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex items-center gap-3.5 rounded-2xl border border-border/40 bg-card/60 px-4 py-3">
            <Skeleton className="h-11 w-11 flex-shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5 rounded-md" />
              <Skeleton className="h-3 w-3/5 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      aria-busy="true"
      aria-label="Loading files"
      className="grid grid-cols-1 gap-4 pt-3 min-[540px]:grid-cols-2 min-[880px]:grid-cols-3"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-[1.15rem] border border-border/40 bg-card/60">
          <Skeleton className="h-36 w-full rounded-none" />
          <div className="space-y-2.5 p-4">
            <Skeleton className="h-4 w-3/5 rounded-md" />
            <Skeleton className="h-3 w-full rounded-md" />
            <Skeleton className="h-3 w-4/5 rounded-md" />
            <div className="flex gap-2 pt-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Nothing to show: no files at all yet (say where files come from, and offer
 * the way to make one), or a filter or search that matches none (offer to
 * clear it).
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
      {filtered ? (
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <SearchX size={22} aria-hidden />
        </span>
      ) : (
        <FileStackArt className="mx-auto mb-6" />
      )}
      <p className="text-lg font-semibold tracking-tight text-foreground">
        {filtered ? "No files match" : "No files yet"}
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
        {filtered
          ? "Try a different name, or show every kind and type again."
          : "Files you attach to a message, and the documents, sheets and images agents make for you, all gather here."}
      </p>
      {filtered ? (
        <button type="button" onClick={onClearFilters} className={SECONDARY_ACTION}>
          Clear filters
        </button>
      ) : (
        <button type="button" onClick={onStartChat} className={PRIMARY_ACTION}>
          <MessageSquarePlus size={16} aria-hidden />
          Start a chat
        </button>
      )}
    </div>
  );
}

/** The list could not load. */
export function ArtifactsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={PANEL} role="alert">
      <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-destructive/10 text-destructive ring-1 ring-destructive/15">
        <TriangleAlert size={22} aria-hidden />
      </span>
      <p className="text-lg font-semibold tracking-tight text-foreground">Your files could not be loaded</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{message}</p>
      <button type="button" onClick={onRetry} className={SECONDARY_ACTION}>
        <RotateCw size={14} aria-hidden /> Try again
      </button>
    </div>
  );
}
