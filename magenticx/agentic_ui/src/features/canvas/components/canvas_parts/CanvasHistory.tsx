/**
 * The document's version history (plan 44 §3 "Attribution and history"):
 * every version with its number, author (Agent or You), date and the
 * version it was based on. Picking one reads it (read-only); ticking two
 * compares them; an earlier one can be restored — saved again as a new
 * version on top of the latest, so history is never rewritten.
 *
 * A panel on the right of the document on wider screens, a bottom sheet on a
 * phone (where the document already covers the whole screen).
 */
import type { ReactNode } from "react";
import { GitCompareArrows, History, RotateCcw, Sparkles, UserRound, X } from "lucide-react";

import type { CanvasDocumentVersionMeta } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";

import { formatVersionMoment } from "../../lib/dates";

export interface CanvasHistoryProps {
  open: boolean;
  /** Phone layout: a bottom sheet instead of the side panel. */
  compact: boolean;
  versions: CanvasDocumentVersionMeta[] | null;
  loading: boolean;
  /** The version on screen. */
  shownVersion: number | null;
  /** Up to two versions ticked for Compare, in the order ticked. */
  compareSelection: number[];
  /** Restore is in progress (its button waits). */
  restoring: boolean;
  /** Restore is offered only when nothing blocks a save (no conflict). */
  canRestore: boolean;
  onView: (version: number) => void;
  onToggleCompare: (version: number) => void;
  onCompare: () => void;
  onRestore: (version: number) => void;
  onClose: () => void;
}

function Rows({
  versions,
  loading,
  shownVersion,
  compareSelection,
  restoring,
  canRestore,
  onView,
  onToggleCompare,
  onRestore,
}: Omit<CanvasHistoryProps, "open" | "compact" | "onClose" | "onCompare">) {
  if (versions === null || (loading && versions.length === 0)) {
    return (
      <div className="space-y-3 px-4 py-3" aria-busy="true" aria-label="Loading versions">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-5/6" />
      </div>
    );
  }
  const latest = versions[0]?.version;
  return (
    <ul className="space-y-1 px-2 py-2" aria-label="Versions">
      {versions.map((meta) => {
        const shown = meta.version === shownVersion;
        const ticked = compareSelection.includes(meta.version);
        const AuthorIcon = meta.author === "agent" ? Sparkles : UserRound;
        return (
          <li
            key={meta.version}
            className={cn(
              "rounded-lg border border-transparent transition-colors duration-150",
              shown ? "border-border bg-muted/70" : "hover:bg-muted/50",
            )}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onView(meta.version)}
                aria-current={shown ? "true" : undefined}
                className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:py-3"
              >
                <span className="mt-px w-9 shrink-0 text-sm font-semibold tabular-nums text-foreground">
                  v{meta.version}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm text-foreground">
                    <AuthorIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {meta.author === "agent" ? "Agent" : "You"}
                    {meta.version === latest ? (
                      <span className="rounded bg-primary/12 px-1.5 text-[11px] font-medium text-primary">
                        Latest
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {formatVersionMoment(meta.createdAt)}
                    {meta.baseVersion !== null ? ` · from v${meta.baseVersion}` : ""}
                  </span>
                </span>
              </button>
              <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-muted [@media(pointer:coarse)]:size-11">
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={() => onToggleCompare(meta.version)}
                  aria-label={`Select v${meta.version} to compare`}
                  className="size-4 cursor-pointer rounded border-border accent-primary"
                />
              </label>
            </div>
            {shown && meta.version !== latest ? (
              <div className="px-2.5 pb-2.5 pl-[3.6rem]">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 [@media(pointer:coarse)]:h-11"
                  disabled={restoring || !canRestore}
                  onClick={() => onRestore(meta.version)}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  {restoring ? "Restoring…" : "Restore this version"}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Footer({ selection, onCompare }: { selection: number[]; onCompare: () => void }) {
  const [a, b] = [...selection].sort((x, y) => x - y);
  return (
    <div className="border-t border-border/70 px-3 py-3">
      <Button
        className="w-full gap-1.5 [@media(pointer:coarse)]:h-11"
        variant={selection.length === 2 ? "default" : "outline"}
        disabled={selection.length !== 2}
        onClick={onCompare}
      >
        <GitCompareArrows className="size-4" aria-hidden="true" />
        {selection.length === 2 ? `Compare v${a} and v${b}` : "Tick two versions to compare"}
      </Button>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <History className="size-4 text-muted-foreground" aria-hidden="true" />
      {children}
    </span>
  );
}

export function CanvasHistory(props: CanvasHistoryProps) {
  const { open, compact, compareSelection, onCompare, onClose } = props;

  if (compact) {
    return (
      <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <SheetContent
          side="bottom"
          hideClose
          className="flex max-h-[80svh] flex-col gap-0 rounded-t-2xl p-0"
        >
          <div className="flex items-center justify-between px-4 pb-1 pt-4">
            <SheetTitle asChild>
              <span>
                <Heading>Version history</Heading>
              </span>
            </SheetTitle>
            <button
              type="button"
              aria-label="Close version history"
              onClick={onClose}
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-[18px]" />
            </button>
          </div>
          <SheetDescription className="sr-only">
            Read, compare or restore an earlier version of the document.
          </SheetDescription>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Rows {...props} />
          </div>
          <Footer selection={compareSelection} onCompare={onCompare} />
        </SheetContent>
      </Sheet>
    );
  }

  if (!open) return null;
  return (
    <aside
      aria-label="Version history"
      className="flex w-[min(20rem,45%)] shrink-0 flex-col border-l border-border/70 bg-background animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none"
    >
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
        <Heading>Version history</Heading>
        <button
          type="button"
          aria-label="Close version history"
          onClick={onClose}
          className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-[18px]" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Rows {...props} />
      </div>
      <Footer selection={compareSelection} onCompare={onCompare} />
    </aside>
  );
}
